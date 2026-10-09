// ==========================================
// 📁 yjs-collab.js — Real-time collaboration layer (Yjs CRDT)
// ==========================================
//
// Architecture
// ------------
// For every (project_id, doc_id) that the editor opens, we create one Yjs
// collaboration "room":
//
//   Y.Doc
//     └─ ydoc.getMap('annotations')           // Y.Map<pageId, Y.Map<annoId, data>>
//         └─ page_1 → Y.Map<annoId, {type, tool, color, points, ...}>
//         └─ page_2 → Y.Map<annoId, {...}>
//
// Plus the Yjs Awareness protocol for presence (who's online, which page
// they're viewing) and a separate Y.Map 'locks' for edit-locks.
//
// Bridge to existing render path
// ------------------------------
// The existing app keeps annotations in `state.annotations[docId][pageId]`
// as `{ strokes: [...], images: [...], textBoxes: [...] }`. We DON'T
// replace that — instead we keep Yjs as the source of truth and rebuild
// the pageData array from the Yjs map whenever it changes:
//
//   Yjs update → observeDeep handler → rebuild state.annotations[doc][page]
//             → renderAnnotations(side)
//
// And the existing mutation code (startAnnotationStroke, addImageToSide,
// etc.) is wrapped so it ALSO writes to Yjs.
//
// IMPORTANT: when Yjs is connected, the REST save path
// (saveAnnotationsToDB) is BYPASSED — Yjs is the source of truth, and the
// server's `anno_yjs_state` SQLite table is what persists the data. The
// old REST `annotations` table is only used as a fallback for non-
// collaborative clients (legacy path).
//
// Re-entrancy guard
// -----------------
// When we apply a Yjs update locally (e.g. user draws a stroke), Yjs fires
// the observe handler synchronously. We use `_yjsSuppressLocalApply` to
// skip the rebuild during our OWN write, so we don't clobber the in-
// progress stroke the user is actively drawing. Remote updates still
// trigger the rebuild (and a re-render).
//
// ==========================================

// The active Yjs provider for the current (project, doc). null when not
// connected (e.g. on the dashboard, or before any doc is opened).
let _yjsProvider = null;
let _yjsDoc = null;
let _yjsWs = null;
let _yjsAwareness = null;
let _yjsCurrentRoomKey = null;
let _yjsObserverAttached = false;
let _yjsSelfName = 'User-' + Math.floor(Math.random() * 1000);
let _yjsSelfColor = _pickRandomColor();
let _yjsPresenceBuiltinCleanupRegistered = false;
// Re-entrancy guard: when true, _yjsOnUpdate is a no-op. Used to prevent
// our own writes from triggering a rebuild that wipes the in-progress
// local state (e.g. during continueAnnotationStroke).
let _yjsSuppressLocalApply = false;
// Set of annotation IDs that are currently being drawn LOCALLY (in-flight).
// These must be preserved across remote updates so the user's stroke
// doesn't disappear mid-draw.
let _yjsLocalInFlightIds = new Set();
// Set of annotation IDs we've recently pushed to Yjs. Used to recognize
// our own echoes coming back so we don't trigger a wasteful rebuild.
let _yjsLocalEchoIds = new Map(); // annoId → lastPushedTs

// DOM element id for the presence indicator (top-right of the editor).
const _PRESENCE_BANNER_ID = 'yjs-presence-banner';
const _PRESENCE_BANNER_INNER_ID = 'yjs-presence-banner-inner';

/**
 * Connect to the Yjs room for (projectId, docId). If already connected to
 * the same room, this is a no-op. If connected to a different room, the
 * old connection is torn down first.
 *
 * @returns {Promise<boolean>} true if connected (or was already), false on error.
 */
async function yjsConnect(projectId, docId) {
    if (!projectId || !docId) return false;
    const roomKey = `${projectId}/${docId}`;
    if (_yjsCurrentRoomKey === roomKey && _yjsProvider) {
        return true; // already connected
    }
    // Tear down any previous connection.
    yjsDisconnect();

    try {
        // Load Yjs + y-websocket + y-protocols/awareness from CDN if not present.
        await _ensureYjsLoaded();
    } catch (err) {
        console.warn('[yjs] failed to load Yjs libs — collaboration disabled:', err);
        return false;
    }

    const wsUrl = _buildYjsWsUrl(projectId, docId);
    _yjsDoc = new Y.Doc();
    _yjsCurrentRoomKey = roomKey;

    try {
        _yjsProvider = new WebsocketProvider(wsUrl, '', _yjsDoc, {
            // y-websocket sends periodic pings to keep the connection alive.
            resyncInterval: 30000,
            maxBackoffTime: 5000,
        });
        _yjsAwareness = _yjsProvider.awareness;
        // Set our own presence state.
        yjsSetPresence({ pageId: null, annoId: null });
        _yjsProvider.awareness.setLocalStateField('user', {
            name: _yjsSelfName,
            color: _yjsSelfColor,
        });
    } catch (err) {
        console.warn('[yjs] WebSocket connection failed — collaboration disabled:', err);
        yjsDisconnect();
        return false;
    }

    // Attach the observe handler so Yjs updates → state.annotations → render.
    _attachYjsObserver();
    // Wire up awareness → presence banner.
    _attachAwarenessHandler();
    // Wire up connection status indicator.
    _attachStatusHandler();
    // After the WS sync completes, do an initial state merge from Yjs →
    // state.annotations. This is what makes annotations appear after a
    // browser refresh: the server replays persisted Yjs updates → our Y.Doc
    // gets the merged state → we rebuild state.annotations → render.
    _attachSyncHandler();

    // Ensure the presence banner exists in the DOM.
    _ensurePresenceBanner();
    // Cleanup on pagehide.
    if (!_yjsPresenceBuiltinCleanupRegistered) {
        window.addEventListener('pagehide', () => yjsDisconnect());
        _yjsPresenceBuiltinCleanupRegistered = true;
    }
    return true;
}

/**
 * Disconnect from the current Yjs room. Safe to call when not connected.
 */
function yjsDisconnect() {
    if (_yjsProvider) {
        try { _yjsProvider.destroy(); } catch (e) { /* ignore */ }
        _yjsProvider = null;
    }
    if (_yjsWs) {
        try { _yjsWs.close(); } catch (e) { /* ignore */ }
        _yjsWs = null;
    }
    if (_yjsDoc) {
        try { _yjsDoc.destroy(); } catch (e) { /* ignore */ }
        _yjsDoc = null;
    }
    _yjsAwareness = null;
    _yjsCurrentRoomKey = null;
    _yjsObserverAttached = false;
    _yjsSuppressLocalApply = false;
    _yjsLocalInFlightIds.clear();
    _yjsLocalEchoIds.clear();
    // Hide the presence banner.
    const banner = document.getElementById(_PRESENCE_BANNER_ID);
    if (banner) banner.classList.remove('visible');
}

/**
 * Returns true if Yjs is currently connected for the given (project, doc).
 */
function yjsIsConnected(projectId, docId) {
    return _yjsCurrentRoomKey === `${projectId}/${docId}` && _yjsProvider !== null;
}

/**
 * Set our own presence info — what page we're viewing + what annotation
 * we're actively editing. Other devices see this in real time.
 *
 * @param {object} info — { pageId, annoId, side }
 */
function yjsSetPresence(info) {
    if (!_yjsAwareness) return;
    _yjsAwareness.setLocalState({
        ...(_yjsAwareness.getLocalState() || {}),
        ...info,
        ts: Date.now(),
    });
}

/**
 * Claim an edit lock on an annotation. Other users see a colored outline.
 *
 * @param {string} annoId — the annotation being edited.
 * @param {string} kind — 'move' | 'resize' | 'edit'
 */
function yjsClaimLock(annoId, kind) {
    if (!_yjsDoc || !annoId) return;
    const locks = _yjsDoc.getMap('locks');
    _yjsDoc.transact(() => {
        locks.set(annoId, {
            clientId: _yjsDoc.clientID,
            userName: _yjsSelfName,
            color: _yjsSelfColor,
            kind: kind || 'edit',
            ts: Date.now(),
        });
    }, 'lock-claim');
}

/**
 * Release an edit lock.
 *
 * @param {string} annoId — the annotation that was being edited.
 */
function yjsReleaseLock(annoId) {
    if (!_yjsDoc || !annoId) return;
    const locks = _yjsDoc.getMap('locks');
    _yjsDoc.transact(() => {
        const existing = locks.get(annoId);
        if (existing && existing.clientId === _yjsDoc.clientID) {
            locks.delete(annoId);
        }
    }, 'lock-release');
}

/**
 * Get the lock state for an annotation, or null if no one is editing it.
 *
 * @param {string} annoId
 * @returns {object|null} { clientId, userName, color, kind, ts }
 */
function yjsGetLock(annoId) {
    if (!_yjsDoc || !annoId) return null;
    const locks = _yjsDoc.getMap('locks');
    const lock = locks.get(annoId);
    if (!lock) return null;
    // Expire stale locks after 60s of inactivity.
    if (Date.now() - (lock.ts || 0) > 60000) {
        return null;
    }
    if (lock.clientId === _yjsDoc.clientID) return null; // own lock, no indicator
    return lock;
}

// ---- Yjs ↔ state.annotations bridge --------------------------------------

/**
 * Set (or update) an annotation in the Yjs room. This is the ONLY function
 * the rest of the editor should call when mutating annotations — it both
 * updates the Yjs CRDT (which broadcasts to other devices) AND triggers
 * the observe handler that rebuilds state.annotations[docId][pageId].
 *
 * IMPORTANT: pass a FRESH copy of the data — Yjs deep-clones the value
 * into its CRDT, so any subsequent mutations to the object you passed in
 * will NOT propagate. Always build a new object before calling this.
 *
 * @param {string} docId
 * @param {string} pageId
 * @param {string} annoId — must be unique across the whole doc.
 * @param {object|null} data — the annotation data, or null to DELETE.
 */
function yjsSetAnnotation(docId, pageId, annoId, data) {
    if (!_yjsDoc) return false;
    if (_yjsCurrentRoomKey !== `${getProjectId()}/${docId}`) {
        // Wrong room — caller should yjsConnect first. Fail silently rather
        // than corrupting another room.
        return false;
    }
    const root = _yjsDoc.getMap('annotations');
    // Suppress the local apply so the observe handler doesn't immediately
    // rebuild state.annotations and wipe the in-progress stroke the user
    // is drawing. (Remote updates still trigger a rebuild.)
    _yjsSuppressLocalApply = true;
    try {
        _yjsDoc.transact(() => {
            let pageMap = root.get(pageId);
            if (!pageMap) {
                pageMap = new Y.Map();
                root.set(pageId, pageMap);
            }
            if (data === null) {
                pageMap.delete(annoId);
            } else {
                // Deep-clone the data so Yjs stores a fresh snapshot. This
                // prevents subsequent local mutations from being seen by
                // other clients (Yjs only syncs the snapshot at set() time).
                pageMap.set(annoId, JSON.parse(JSON.stringify(data)));
            }
        }, 'anno-edit');
        // Remember that we pushed this annoId recently, so when the echo
        // comes back from the server, we can skip the rebuild.
        _yjsLocalEchoIds.set(annoId, Date.now());
    } finally {
        _yjsSuppressLocalApply = false;
    }
    return true;
}

/**
 * Mark an annotation as "in flight" — i.e. the local user is currently
 * drawing or dragging it. While in flight, remote Yjs updates will NOT
 * clobber this annotation's local state. Call yjsEndInFlight(annoId)
 * when the drag/draw is finished.
 *
 * @param {string} annoId
 */
function yjsBeginInFlight(annoId) {
    if (annoId) _yjsLocalInFlightIds.add(annoId);
}

/**
 * Mark an annotation as no longer in flight. After this, remote updates
 * can clobber the local state (which is fine — the user is done editing).
 *
 * @param {string} annoId
 */
function yjsEndInFlight(annoId) {
    if (annoId) _yjsLocalInFlightIds.delete(annoId);
}

/**
 * Replace ALL annotations for a page in one transaction. Used by the
 * bulk-save path (clearCurrentPageAnnotations, etc.).
 *
 * @param {string} docId
 * @param {string} pageId
 * @param {object} pageData — { strokes: [], images: [], textBoxes: [] }
 */
function yjsReplacePage(docId, pageId, pageData) {
    if (!_yjsDoc) return false;
    const root = _yjsDoc.getMap('annotations');
    _yjsSuppressLocalApply = true;
    try {
        _yjsDoc.transact(() => {
            const newPageMap = new Y.Map();
            (pageData.strokes || []).forEach(s => {
                if (s.id) newPageMap.set(s.id, JSON.parse(JSON.stringify(s)));
            });
            (pageData.images || []).forEach(im => {
                if (im.id) newPageMap.set(im.id, JSON.parse(JSON.stringify(im)));
            });
            (pageData.textBoxes || []).forEach(tb => {
                if (tb.id) newPageMap.set(tb.id, JSON.parse(JSON.stringify(tb)));
            });
            root.set(pageId, newPageMap);
        }, 'page-replace');
    } finally {
        _yjsSuppressLocalApply = false;
    }
    return true;
}

/**
 * Clear all annotations for a page (used by clearCurrentPageAnnotations).
 */
function yjsClearPage(docId, pageId) {
    if (!_yjsDoc) return false;
    const root = _yjsDoc.getMap('annotations');
    _yjsSuppressLocalApply = true;
    try {
        _yjsDoc.transact(() => {
            root.delete(pageId);
        }, 'page-clear');
    } finally {
        _yjsSuppressLocalApply = false;
    }
    return true;
}

/**
 * Attach the Yjs observe handler that rebuilds state.annotations[docId]
 * from the Yjs room state, then triggers re-render of any visible side.
 */
function _attachYjsObserver() {
    if (_yjsObserverAttached || !_yjsDoc) return;
    const root = _yjsDoc.getMap('annotations');
    root.observeDeep(_yjsOnUpdate);
    _yjsObserverAttached = true;
}

/**
 * Yjs update handler. Rebuilds state.annotations[docId][pageId] from the
 * Yjs room state and triggers re-render. Called whenever ANY Yjs data
 * changes (local or remote).
 *
 * The rebuild is INCREMENTAL — only the changed pages are touched, and
 * annotations that are currently in-flight locally are preserved (not
 * clobbered by the remote state). This is critical so the user's
 * in-progress stroke doesn't disappear when another device sends an
 * update mid-draw.
 */
function _yjsOnUpdate(events) {
    if (!_yjsDoc) return;
    if (_yjsSuppressLocalApply) return;
    const projectId = getProjectId();
    if (!projectId || !_yjsCurrentRoomKey) return;
    const docId = _yjsCurrentRoomKey.split('/')[1];
    if (!docId) return;

    if (!state.annotations[docId]) state.annotations[docId] = {};

    const root = _yjsDoc.getMap('annotations');

    // Build the set of pages that changed, plus the full set of pages
    // currently in Yjs (for the "remove vanished pages" pass below).
    const changedPages = new Set();
    try {
        for (const ev of (events || [])) {
            // ev.target may be the root Y.Map or a nested Y.Map (page).
            if (ev.target === root) {
                // Top-level change — could be a new page added or a page deleted.
                // Walk every key in the changeset.
                if (ev.changes && ev.changes.keys) {
                    for (const [pageId, change] of ev.changes.keys) {
                        changedPages.add(pageId);
                    }
                }
            } else if (ev.target && ev.target.parent === root) {
                // It's a page-level Y.Map. Find which page it is.
                for (const [pageId, pageMap] of root.entries()) {
                    if (pageMap === ev.target) {
                        changedPages.add(pageId);
                        break;
                    }
                }
            } else {
                // Could be a deeply nested change (e.g. a stroke's points
                // mutated). Walk every page to be safe.
                for (const pageId of root.keys()) {
                    changedPages.add(pageId);
                }
            }
        }
    } catch (e) {
        // Fall back to "rebuild every page" if the event walk fails.
        for (const pageId of root.keys()) changedPages.add(pageId);
    }
    // If we couldn't determine which pages changed (e.g. events is empty),
    // rebuild every page (e.g. on initial sync).
    if (changedPages.size === 0) {
        for (const pageId of root.keys()) changedPages.add(pageId);
    }

    // Incrementally rebuild each changed page.
    for (const pageId of changedPages) {
        const pageMap = root.get(pageId);
        if (!pageMap) {
            // Page was deleted from Yjs.
            delete state.annotations[docId][pageId];
            continue;
        }
        const strokes = [];
        const images = [];
        const textBoxes = [];
        for (const [annoId, annoData] of pageMap.entries()) {
            if (!annoData || typeof annoData !== 'object') continue;
            // Preserve in-flight local annotations — they're being drawn
            // right now and shouldn't be clobbered by remote state.
            if (_yjsLocalInFlightIds.has(annoId)) continue;
            // Skip our own echoes — we just pushed this data, no need to
            // rebuild the local state from the server's echo (it's the same
            // data, and rebuilding would force a wasteful re-render).
            const echoTs = _yjsLocalEchoIds.get(annoId);
            if (echoTs && Date.now() - echoTs < 5000) continue;

            // Classify by the `type` field (strokes have tool/points, images
            // have src/w/h, textboxes have content).
            if (annoData.type === 'image' || (annoData.src && annoData.w !== undefined)) {
                images.push({ ...annoData, id: annoId });
            } else if (annoData.type === 'textBox' ||
                       (annoData.content !== undefined && annoData.w !== undefined)) {
                textBoxes.push({ ...annoData, id: annoId });
            } else {
                strokes.push({ ...annoData, id: annoId });
            }
        }
        // If we skipped in-flight annotations, merge them back in from the
        // existing state so the local user still sees their own work.
        const existing = state.annotations[docId][pageId];
        if (existing && _yjsLocalInFlightIds.size > 0) {
            (existing.strokes || []).forEach(s => {
                if (_yjsLocalInFlightIds.has(s.id)) strokes.push(s);
            });
            (existing.images || []).forEach(im => {
                if (_yjsLocalInFlightIds.has(im.id)) images.push(im);
            });
            (existing.textBoxes || []).forEach(tb => {
                if (_yjsLocalInFlightIds.has(tb.id)) textBoxes.push(tb);
            });
        }
        state.annotations[docId][pageId] = { strokes, images, textBoxes };
        // Hydrate any embedded images into the in-memory cache.
        images.forEach(img => {
            if (img.src && !state.imageCache[img.id]) {
                const imageObj = new Image();
                imageObj.src = img.src;
                state.imageCache[img.id] = imageObj;
            }
        });
    }

    // Remove pages that no longer exist in Yjs (e.g. cleared).
    const yjsPageIds = new Set(root.keys());
    Object.keys(state.annotations[docId]).forEach(pageId => {
        if (!yjsPageIds.has(pageId)) {
            delete state.annotations[docId][pageId];
        }
    });

    // ---- BUG FIX (Annotation/Image movement rendering) ----
    // After rebuilding state.annotations from Yjs, the live object
    // references in `state.selection.selectedImages/selectedTextBoxes/
    // selectedStrokes` may now point to STALE objects that are no longer
    // in state.annotations[docId][pageId]. (Rebuild clones the Yjs data
    // into fresh objects via `{ ...annoData, id: annoId }` — except for
    // in-flight annotations, which keep their old reference.)
    //
    // If we don't re-link, the next pointermove during a drag mutates
    // the STALE object: img.x += dx changes the orphan, not the image
    // that's actually in state.annotations. The blue selection bounding
    // box (which lives on state.selection.boundingBox) moves, but the
    // underlying image stays at its old position — exactly the bug the
    // user reported.
    //
    // Re-link by ID so the selection's object references always point
    // to the canonical objects in state.annotations. This is a no-op
    // when the references are already correct (which is the common
    // case — local drags with no remote updates).
    _relinkSelectionAfterYjsUpdate(docId);

    // Re-render whichever side is currently showing this doc.
    if (typeof renderAnnotations === 'function') {
        ['left', 'right'].forEach(side => {
            if (state.view[side].docId === docId) {
                renderAnnotations(side);
                if (typeof renderTextLayer === 'function') renderTextLayer(side);
            }
        });
    }
}

/**
 * After a Yjs remote update rebuilds state.annotations, re-link the
 * selection's image / textbox / stroke references to the canonical
 * objects now in state.annotations. Without this, dragging an object
 * when a remote update arrives mid-drag would mutate orphan objects
 * while the visible (rendered) image stays put.
 *
 * This is a defensive measure — the primary fix is marking the
 * selected annotations as in-flight at drag-start (see events.js),
 * which prevents the rebuild from replacing them in the first place.
 * But re-linking here protects against any edge case where a remote
 * update still slips through (e.g. a different annotation on the
 * same page is edited remotely, triggering a page-level rebuild).
 */
function _relinkSelectionAfterYjsUpdate(docId) {
    if (!state.selection || !state.selection.active) return;
    if (!state.annotations[docId]) return;

    // Only relink if the selection's side is showing this doc.
    const selSide = state.selection.side;
    if (!selSide) return;
    if (state.view[selSide].docId !== docId) return;

    const pageId = state.view[selSide].pageId;
    const pageData = state.annotations[docId][pageId];
    if (!pageData) return;

    // Build ID → object maps for fast lookup.
    const imgById = new Map();
    (pageData.images || []).forEach(im => { if (im && im.id) imgById.set(im.id, im); });
    const tbById = new Map();
    (pageData.textBoxes || []).forEach(tb => { if (tb && tb.id) tbById.set(tb.id, tb); });
    const stkById = new Map();
    (pageData.strokes || []).forEach(stk => { if (stk && stk.id) stkById.set(stk.id, stk); });

    // Re-link selected images.
    if (state.selection.selectedImages && state.selection.selectedImages.length) {
        state.selection.selectedImages = state.selection.selectedImages.map(im => {
            if (!im || !im.id) return im;
            const live = imgById.get(im.id);
            // Preserve the user's in-progress drag position: if the live
            // object's x/y differs from the selected object's x/y (because
            // the user is actively dragging), keep the selected object's
            // x/y so the drag continues smoothly. We do this by mutating
            // the live object to match the dragged position.
            if (live && live !== im) {
                live.x = im.x;
                live.y = im.y;
                live.w = im.w;
                live.h = im.h;
            }
            return live || im;
        });
    }
    // Re-link selected textboxes.
    if (state.selection.selectedTextBoxes && state.selection.selectedTextBoxes.length) {
        state.selection.selectedTextBoxes = state.selection.selectedTextBoxes.map(tb => {
            if (!tb || !tb.id) return tb;
            const live = tbById.get(tb.id);
            if (live && live !== tb) {
                live.x = tb.x;
                live.y = tb.y;
                live.w = tb.w;
                live.h = tb.h;
            }
            return live || tb;
        });
    }
    // Re-link selected strokes.
    if (state.selection.selectedStrokes && state.selection.selectedStrokes.length) {
        state.selection.selectedStrokes = state.selection.selectedStrokes.map(stk => {
            if (!stk || !stk.id) return stk;
            const live = stkById.get(stk.id);
            if (live && live !== stk) {
                // For strokes, copy the dragged points back to the live object.
                live.points = stk.points;
            }
            return live || stk;
        });
    }
}
// Expose for tests.
window._relinkSelectionAfterYjsUpdate = _relinkSelectionAfterYjsUpdate;

/**
 * After the WS sync handshake completes, do an initial state merge from Yjs
 * → state.annotations. This is what makes annotations appear after a
 * browser refresh: the server replays persisted Yjs updates → our Y.Doc
 * gets the merged state → we rebuild state.annotations → render.
 */
function _attachSyncHandler() {
    if (!_yjsProvider) return;
    // y-websocket fires 'synced' when the initial sync completes.
    _yjsProvider.on('synced', (event) => {
        console.debug('[yjs] synced — applying remote state to local state');
        // Force a full rebuild of state.annotations from the Yjs room.
        _yjsSuppressLocalApply = false;
        _yjsOnUpdate([]); // empty events → rebuild every page
    });
}

/**
 * Awareness update handler. Updates the presence banner showing who's online.
 */
function _attachAwarenessHandler() {
    if (!_yjsAwareness) return;
    _yjsAwareness.on('change', () => _updatePresenceBanner());
}

/**
 * Connection status handler. Shows "Connecting..." then "Connected" briefly.
 */
function _attachStatusHandler() {
    if (!_yjsProvider) return;
    _yjsProvider.on('status', (e) => {
        if (e.status === 'disconnected') {
            console.debug('[yjs] disconnected — will auto-reconnect');
        }
    });
}

/**
 * Build the WebSocket URL for a (project, doc) room. Uses the same host:port
 * as the page (so it works over LAN without configuration).
 */
function _buildYjsWsUrl(projectId, docId) {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws/yjs/${encodeURIComponent(projectId)}/${encodeURIComponent(docId)}`;
}

/**
 * Update the presence banner with the list of currently-connected users.
 */
function _updatePresenceBanner() {
    if (!_yjsAwareness) return;
    const states = _yjsAwareness.getStates();
    const users = [];
    for (const [clientId, state] of states.entries()) {
        if (!state) continue;
        const user = state.user;
        if (!user) continue;
        users.push({
            name: user.name || ('User-' + clientId),
            color: user.color || '#888',
            pageId: state.pageId,
            annoId: state.annoId,
            isSelf: clientId === _yjsDoc.clientID,
        });
    }
    const banner = document.getElementById(_PRESENCE_BANNER_ID);
    const inner = document.getElementById(_PRESENCE_BANNER_INNER_ID);
    if (!banner || !inner) return;
    if (users.length === 0) {
        banner.classList.remove('visible');
        return;
    }
    const avatars = users.map(u => {
        const initial = (u.name || '?').charAt(0).toUpperCase();
        const self = u.isSelf ? ' (you)' : '';
        const pageLabel = u.pageId ? ` · ${u.pageId}` : '';
        return `<div class="yjs-avatar" style="background:${u.color}" title="${escapeHtml(u.name)}${self}${pageLabel}">${escapeHtml(initial)}</div>`;
    }).join('');
    const count = users.length;
    const label = count === 1 ? '1 user online' : `${count} users online`;
    inner.innerHTML = `<span class="yjs-presence-label">${label}</span><div class="yjs-avatars">${avatars}</div>`;
    banner.classList.add('visible');
}

/**
 * Ensure the presence banner exists in the DOM.
 */
function _ensurePresenceBanner() {
    if (document.getElementById(_PRESENCE_BANNER_ID)) return;
    const banner = document.createElement('div');
    banner.id = _PRESENCE_BANNER_ID;
    banner.className = 'yjs-presence-banner';
    banner.innerHTML = `<div id="${_PRESENCE_BANNER_INNER_ID}"></div>`;
    document.body.appendChild(banner);
}

function _pickRandomColor() {
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];
    return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Dynamically load Yjs + y-websocket from CDN if they're not already on
 * the page. Resolves when both `Y` and `WebsocketProvider` are available
 * globally.
 */
async function _ensureYjsLoaded() {
    if (window.Y && window.WebsocketProvider) return;
    const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = () => reject(new Error('failed to load ' + src));
        document.head.appendChild(s);
    });
    // Yjs core + y-protocols (for awareness).
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/yjs/13.6.18/yjs.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/y-protocols/1.0.6/y-protocols.min.js');
    // y-websocket client.
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/y-websocket/2.0.4/y-websocket.min.js');
    if (!window.Y) throw new Error('Yjs failed to load');
    if (!window.WebsocketProvider) throw new Error('y-websocket failed to load');
}

/**
 * Set the local user's display name + color (so other users see them).
 */
function yjsSetSelf(name, color) {
    if (name) _yjsSelfName = name;
    if (color) _yjsSelfColor = color;
    if (_yjsAwareness) {
        _yjsAwareness.setLocalStateField('user', {
            name: _yjsSelfName,
            color: _yjsSelfColor,
        });
    }
}

// Expose globally.
window.yjsConnect = yjsConnect;
window.yjsDisconnect = yjsDisconnect;
window.yjsIsConnected = yjsIsConnected;
window.yjsSetPresence = yjsSetPresence;
window.yjsClaimLock = yjsClaimLock;
window.yjsReleaseLock = yjsReleaseLock;
window.yjsGetLock = yjsGetLock;
window.yjsSetAnnotation = yjsSetAnnotation;
window.yjsReplacePage = yjsReplacePage;
window.yjsClearPage = yjsClearPage;
window.yjsSetSelf = yjsSetSelf;
window.yjsBeginInFlight = yjsBeginInFlight;
window.yjsEndInFlight = yjsEndInFlight;

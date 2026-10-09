// ==========================================
// 📁 conflict.js — Real-time sync via WebSocket
// ==========================================
// STRATEGY:
//   Each browser tab opens a WebSocket to /ws/sync/{project_id}. Whenever
//   ANY write happens on the server (annotation save, link add, chat add,
//   document upload, etc.), the server:
//     1. Calls bump_project_revision() (increments the revision counter)
//     2. Broadcasts a JSON message to all connected WS clients:
//        {"type": "revision_changed", "revision": N}
//   The client receives this and calls smartRefreshFromServer() to pull
//   the latest data — instantly, automatically, no user action needed.
//
//   This replaces the old 30-second polling + conflict-detection + pause +
//   queue + merge system. There is:
//     - No sync toggle button
//     - No pending save queue
//     - No conflict modal
//     - No polling timer
//     - No way to pause sync
//   Changes propagate to all devices within ~100ms.
//
// PER-PAGE CONFLICT DETECTION (still in place):
//   When saving a single annotation page, the editor sends X-Expected-Revision.
//   If another device saved the same page in between, the server returns 409
//   and we show a modal: Reload / Overwrite / Cancel. This is the only
//   conflict path that remains — it's rare and only for same-page concurrent
//   edits.
// ==========================================

/**
 * Connect to the real-time sync WebSocket for the current project.
 * Called once after the editor loads.
 *
 * The WebSocket stays open for the lifetime of the page. If it drops
 * (network blip, server restart), we automatically reconnect after 3s.
 */
function connectRealtimeSync() {
    const pid = getProjectId();
    if (!pid) return;
    // Don't double-connect.
    if (conflictState.syncWebSocket &&
        conflictState.syncWebSocket.readyState !== WebSocket.CLOSED) {
        return;
    }

    // Build the WebSocket URL from the current page's protocol + host.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/sync/${pid}`;
    console.log('[realtime-sync] connecting to', wsUrl);

    try {
        const ws = new WebSocket(wsUrl);
        conflictState.syncWebSocket = ws;

        ws.onopen = () => {
            conflictState.syncWebSocketConnected = true;
            console.log('[realtime-sync] connected ✓');
            _updateSyncStatusIndicator(true);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'connected') {
                    console.log('[realtime-sync] server confirmed connection for project', msg.project_id);
                } else if (msg.type === 'revision_changed') {
                    console.log(`[realtime-sync] revision changed → ${msg.revision} — refreshing`);
                    // Update our stored revision immediately so the next save's
                    // X-Expected-Revision header is correct.
                    conflictState.projectRevision = msg.revision;
                    conflictState.projectRevisionLoadedAt = Date.now();
                    // Debounce: if many revision-changed messages arrive in
                    // quick succession (e.g., another device bulk-saving), we
                    // only refresh once per 500ms window.
                    _scheduleDebouncedRefresh();
                }
            } catch (err) {
                console.warn('[realtime-sync] failed to parse message:', err);
            }
        };

        ws.onerror = (err) => {
            console.warn('[realtime-sync] WebSocket error — will retry');
            _updateSyncStatusIndicator(false);
        };

        ws.onclose = () => {
            conflictState.syncWebSocketConnected = false;
            conflictState.syncWebSocket = null;
            console.log('[realtime-sync] disconnected — reconnecting in 3s');
            _updateSyncStatusIndicator(false);
            // Auto-reconnect after 3 seconds. This handles network blips and
            // server restarts gracefully.
            setTimeout(() => {
                if (typeof startRealtimeSync === 'function') {
                    startRealtimeSync();
                }
            }, 3000);
        };
    } catch (err) {
        console.error('[realtime-sync] failed to connect:', err);
        // Retry after 5s if the initial connection fails.
        setTimeout(() => connectRealtimeSync(), 5000);
    }
}
// Also expose as startRealtimeSync (used by app.js init).
const startRealtimeSync = connectRealtimeSync;
window.startRealtimeSync = startRealtimeSync;

/**
 * Stop the real-time sync WebSocket. Called when leaving the editor.
 */
function stopRealtimeSync() {
    if (conflictState.syncWebSocket) {
        conflictState.syncWebSocket.onclose = null;  // prevent auto-reconnect
        try { conflictState.syncWebSocket.close(); } catch(e) {}
        conflictState.syncWebSocket = null;
        conflictState.syncWebSocketConnected = false;
    }
    if (conflictState.refreshDebounceTimer) {
        clearTimeout(conflictState.refreshDebounceTimer);
        conflictState.refreshDebounceTimer = null;
    }
}
window.stopRealtimeSync = stopRealtimeSync;

// ---- Backward-compat shims ----
// app.js init calls startProjectRevisionPolling / stopProjectRevisionPolling.
// We keep these as no-op aliases so app.js doesn't need to change.
function startProjectRevisionPolling() {
    // Real-time sync replaces polling. Just connect the WebSocket.
    connectRealtimeSync();
    // Also do one initial revision fetch so conflictState.projectRevision
    // is set correctly (for X-Expected-Revision headers on per-page saves).
    refreshProjectRevision(true);
}
function stopProjectRevisionPolling() {
    stopRealtimeSync();
}
window.startProjectRevisionPolling = startProjectRevisionPolling;
window.stopProjectRevisionPolling = stopProjectRevisionPolling;

/**
 * Fetch the latest revision from the server. Used once on init to seed
 * conflictState.projectRevision. The WebSocket handles all subsequent
 * updates — this function is NOT called on a timer.
 *
 * @param {boolean} isInitial — if true, just store the value.
 */
async function refreshProjectRevision(isInitial) {
    const pid = getProjectId();
    if (!pid) return;
    try {
        const resp = await fetch(`/api/projects/${pid}/revision`);
        if (!resp.ok) return;
        const data = await resp.json();
        const newRev = intOr(data.revision, 0);
        conflictState.projectRevision = newRev;
        conflictState.projectRevisionLoadedAt = Date.now();
        if (!isInitial && newRev !== conflictState.projectRevision) {
            // This branch is only reached if refreshProjectRevision is called
            // manually (rare). Normally the WebSocket handles this.
            _scheduleDebouncedRefresh();
        }
    } catch (err) {
        console.debug('[realtime-sync] initial revision fetch failed:', err);
    }
}
window.refreshProjectRevision = refreshProjectRevision;

/**
 * Schedule a debounced smartRefreshFromServer call.
 * If multiple revision_changed messages arrive in quick succession (e.g.,
 * another device is bulk-saving annotations), we only refresh once per
 * 500ms window. This prevents rapid-fire refreshes that would hammer
 * the server.
 */
function _scheduleDebouncedRefresh() {
    if (conflictState.refreshDebounceTimer) return;  // already scheduled
    conflictState.refreshDebounceTimer = setTimeout(() => {
        conflictState.refreshDebounceTimer = null;
        // Silent mode = true: no banner, just a small toast.
        if (typeof smartRefreshFromServer === 'function') {
            smartRefreshFromServer(true).catch(err => {
                console.warn('[realtime-sync] refresh failed:', err);
            });
        }
    }, 500);
}

/**
 * SMART REFRESH — pull the latest data from the server and update the
 * editor in-place, WITHOUT reloading the page.
 *
 * This is called automatically by the real-time sync WebSocket whenever
 * a revision_changed message arrives (i.e., another device saved something).
 *
 * What gets refreshed:
 *   • Documents list (metadata only — already-open PDFs keep their loaded
 *     pdfDoc + scroll position)
 *   • Folders tree
 *   • Links (re-rendered markers on both viewports)
 *   • Chats list
 *   • Annotations for the docs currently open in left/right viewports
 *
 * What is PRESERVED (NOT reset):
 *   • Currently open docs in left/right viewports
 *   • Current page number + scroll position + zoom level
 *   • Active tool and color/thickness
 *   • AI settings, sidebar collapse states, folder expansion
 *   • Active comment overlay (if open)
 */
async function smartRefreshFromServer(silent = false) {
    // Prevent concurrent refreshes.
    if (conflictState.isRefreshing) {
        console.log('[smartRefresh] already in progress, skipping');
        return;
    }
    conflictState.isRefreshing = true;
    _updateSyncStatusIndicator(conflictState.syncWebSocketConnected);

    const pid = getProjectId();
    if (!pid) {
        conflictState.isRefreshing = false;
        return;
    }

    try {
        // ---- 1. Fetch everything in parallel ----
        const [docs, folders, links, chats, projectInfo] = await Promise.all([
            Api.listDocuments(),
            Api.listFolders(),
            Api.listLinks(),
            Api.listChats(),
            Api.getProject(pid).catch(() => null),
        ]);

        // ---- 2. Update documents (metadata only — preserve loaded PDFs) ----
        const newDocMap = {};
        for (const d of docs) {
            const existing = state.documents[d.id];
            newDocMap[d.id] = existing ? {
                ...existing,
                name: d.name,
                pageCount: d.pageCount,
                thumbnail: d.thumbnail,
                pageIds: d.pageIds || existing.pageIds || [],
                folderId: d.folderId && state.folders[d.folderId] ? d.folderId : (d.folderId || ROOT_FOLDER_ID),
                fileSize: d.fileSize || 0,
                createdAt: d.createdAt,
                modifiedAt: d.modifiedAt,
                favorite: !!d.favorite,
                fileHash: d.fileHash || null,
            } : {
                id: d.id,
                name: d.name,
                file: null,
                pdfDoc: null,
                pageCount: d.pageCount,
                thumbnail: d.thumbnail,
                pageIds: d.pageIds || [],
                folderId: d.folderId || ROOT_FOLDER_ID,
                fileSize: d.fileSize || 0,
                createdAt: d.createdAt,
                modifiedAt: d.modifiedAt,
                favorite: !!d.favorite,
                fileHash: d.fileHash || null,
            };
        }
        state.documents = newDocMap;

        // ---- 3. Update folders tree (preserve expansion state) ----
        const oldFolders = state.folders || {};
        state.folders = {};
        state.folders[ROOT_FOLDER_ID] = {
            id: ROOT_FOLDER_ID, name: 'Root', parentId: null,
            createdAt: Date.now(),
            expanded: oldFolders[ROOT_FOLDER_ID]?.expanded !== false,
        };
        for (const f of folders) {
            if (f.id === ROOT_FOLDER_ID) {
                state.folders[ROOT_FOLDER_ID] = {
                    ...state.folders[ROOT_FOLDER_ID],
                    name: f.name || 'Root',
                    createdAt: f.createdAt,
                    expanded: oldFolders[ROOT_FOLDER_ID]?.expanded !== false,
                };
            } else {
                state.folders[f.id] = {
                    id: f.id,
                    name: f.name,
                    parentId: f.parentId || ROOT_FOLDER_ID,
                    createdAt: f.createdAt,
                    expanded: oldFolders[f.id]?.expanded !== false ? (f.expanded !== false) : false,
                };
            }
        }

        // ---- 4. Update links ----
        state.links = links;

        // ---- 5. Update chats (preserve current chat selection) ----
        state.chats = chats;
        if (state.chats.length > 0 && !state.chats.find(c => c.id === state.currentChatId)) {
            state.currentChatId = state.chats[0].id;
        } else if (state.chats.length === 0) {
            if (typeof createNewChat === 'function') {
                try { await createNewChat(); } catch(e) {}
            }
        }

        // ---- 6. Refresh annotations for docs currently open in viewports ----
        const docsToRefresh = new Set();
        if (state.view.left.docId) docsToRefresh.add(state.view.left.docId);
        if (state.view.right.docId) docsToRefresh.add(state.view.right.docId);
        // Don't refresh the doc being edited in the comment overlay —
        // the user's unsaved comment would be lost.
        if (state.activeComment?.id && state.activeComment.docId) {
            docsToRefresh.delete(state.activeComment.docId);
        }
        for (const docId of docsToRefresh) {
            // ---- BUG FIX (Stroke continuity / Yjs source of truth) ----
            // When the Yjs collaboration room is connected for this doc, Yjs
            // is the source of truth for annotations (see YJS_COLLAB.md) and
            // the REST annotations table is intentionally stale (per-stroke
            // REST saves are bypassed while Yjs is connected). Replacing the
            // in-memory state with the stale REST snapshot used to:
            //   (a) delete every stroke drawn since the Yjs session started
            //       (they only exist in the CRDT), and
            //   (b) orphan the stroke being drawn RIGHT NOW — the next
            //       pointermove then appended its points into the previous
            //       stroke: the "new stroke connects to the previous stroke"
            //       bug (worst on touch devices, where pan/zoom between
            //       strokes fires saveSettings → revision_changed
            //       self-echoes → this refresh lands mid-stroke).
            // Yjs keeps syncing through its own WebSocket; we simply stop
            // clobbering it with legacy REST data. Non-Yjs (fallback) docs
            // still refresh normally below.
            if (typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                continue;
            }
            try {
                await loadAnnotationsFromServer(docId);
            } catch (err) {
                console.warn(`[smartRefresh] Failed to refresh annotations for ${docId}:`, err);
            }
        }

        // ---- 7. Update project revision baseline ----
        if (projectInfo && projectInfo.revision !== undefined) {
            conflictState.projectRevision = parseInt(projectInfo.revision, 10) || 0;
            conflictState.projectRevisionLoadedAt = Date.now();
        }

        // ---- 8. Re-render the affected UI parts ----
        if (typeof renderDocList === 'function') renderDocList();
        if (typeof renderChatList === 'function') renderChatList();
        if (typeof renderChatMessages === 'function') renderChatMessages();
        ['left', 'right'].forEach(side => {
            if (state.view[side].docId) {
                if (typeof renderMarkersForView === 'function') renderMarkersForView(side);
                if (typeof renderAnnotations === 'function') renderAnnotations(side);
                if (typeof renderTextLayer === 'function') renderTextLayer(side);
            }
        });

        // ---- 9. Show a small toast (only in non-silent mode, to avoid spam) ----
        if (!silent && typeof _showRefreshToast === 'function') {
            _showRefreshToast('Project refreshed — latest changes applied');
        }

    } catch (err) {
        console.error('[smartRefresh] Failed:', err);
        if (typeof _showRefreshToast === 'function') {
            _showRefreshToast('Refresh failed: ' + (err.message || err), true);
        }
    } finally {
        conflictState.isRefreshing = false;
        _updateSyncStatusIndicator(conflictState.syncWebSocketConnected);
    }
}
window.smartRefreshFromServer = smartRefreshFromServer;

/**
 * Tiny toast notification — appears at the bottom-center of the screen,
 * auto-dismisses after 3 seconds (or 5s for errors).
 */
function _showRefreshToast(message, isError = false) {
    let toast = document.getElementById('refresh-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'refresh-toast';
        toast.className = 'refresh-toast';
        document.body.appendChild(toast);
    }
    toast.innerHTML = `
        <i class="fa-solid ${isError ? 'fa-circle-exclamation text-red-500' : 'fa-circle-check text-emerald-500'}"></i>
        <span>${escapeHtml(message)}</span>
    `;
    toast.classList.toggle('refresh-toast-error', isError);
    toast.classList.remove('visible');
    void toast.offsetWidth;
    requestAnimationFrame(() => {
        toast.classList.add('visible');
    });
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove('visible');
    }, isError ? 5000 : 3000);
}

function intOr(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
}

/**
 * Record the server-side revision for a particular annotation page, so we
 * can send it as X-Expected-Revision on the next per-page save.
 */
function rememberAnnotationRevision(docId, pageId, revision) {
    if (!conflictState.annotationRevisions[docId]) {
        conflictState.annotationRevisions[docId] = {};
    }
    conflictState.annotationRevisions[docId][pageId] = intOr(revision, 0);
}

/**
 * Forget all per-page revisions for a doc (used after a bulk save that
 * replaces all of a doc's annotation rows).
 */
function forgetAnnotationRevisionsForDoc(docId) {
    delete conflictState.annotationRevisions[docId];
}

/**
 * Get the last-known revision for a page, or 0 if unknown.
 */
function getAnnotationRevision(docId, pageId) {
    return (conflictState.annotationRevisions[docId] || {})[pageId] || 0;
}
window.rememberAnnotationRevision = rememberAnnotationRevision;
window.forgetAnnotationRevisionsForDoc = forgetAnnotationRevisionsForDoc;
window.getAnnotationRevision = getAnnotationRevision;

/**
 * Show the per-page conflict modal. Returns a Promise that resolves to one of:
 *   'reload'  — user wants to reload server data (discard local changes to this page)
 *   'overwrite' — user wants to force their local changes
 *   'cancel'  — user wants to do nothing
 *
 * @param {object} detail — the `detail` field from the server's HTTP 409 response
 */
function showPageConflictModal(detail) {
    return new Promise((resolve) => {
        const modal = document.getElementById('conflict-modal');
        if (!modal) {
            const choice = confirm(
                'Another device has modified this page.\n\n' +
                'Click OK to overwrite their changes, or Cancel to keep your local copy without saving.'
            );
            resolve(choice ? 'overwrite' : 'cancel');
            return;
        }
        const titleEl = modal.querySelector('.conflict-title');
        const bodyEl = modal.querySelector('.conflict-body');
        const reloadBtn = modal.querySelector('.conflict-reload');
        const overwriteBtn = modal.querySelector('.conflict-overwrite');
        const cancelBtn = modal.querySelector('.conflict-cancel');

        if (titleEl) titleEl.innerText = 'Conflict — another device modified this page';
        if (bodyEl) {
            bodyEl.innerHTML = `
                <p>Another device saved changes to <b>${escapeHtml(detail.docId || '')}</b> /
                page <code>${escapeHtml(detail.pageId || '')}</code> after you loaded it.</p>
                <p>Your local revision: <code>${escapeHtml(String(detail.expectedRevision ?? '?'))}</code>
                &nbsp;&middot;&nbsp;
                Server revision: <code>${escapeHtml(String(detail.currentRevision ?? '?'))}</code></p>
                <ul style="margin:8px 0 8px 18px;">
                  <li><b>Reload from server</b> — discard your local changes, load the server's version</li>
                  <li><b>Overwrite</b> — save your local changes, discarding the other device's edits</li>
                  <li><b>Cancel</b> — keep your local changes for now (don't save)</li>
                </ul>
            `;
        }

        const handler = (val) => () => {
            modal.classList.add('hidden');
            reloadBtn.onclick = null;
            overwriteBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(val);
        };
        reloadBtn.onclick = handler('reload');
        overwriteBtn.onclick = handler('overwrite');
        cancelBtn.onclick = handler('cancel');
        modal.classList.remove('hidden');
    });
}
window.showPageConflictModal = showPageConflictModal;

/**
 * Update the sync status indicator in the header.
 *   connected=true  → green dot + "Live" label
 *   connected=false → amber pulsing dot + "Reconnecting…" label
 */
function _updateSyncStatusIndicator(connected) {
    const el = document.getElementById('sync-status-indicator');
    if (!el) return;
    if (connected) {
        el.classList.remove('disconnected');
        el.title = 'Real-time sync active — changes from other devices appear instantly';
        const label = el.querySelector('.sync-label');
        if (label) label.textContent = 'Live';
    } else {
        el.classList.add('disconnected');
        el.title = 'Real-time sync disconnected — reconnecting…';
        const label = el.querySelector('.sync-label');
        if (label) label.textContent = 'Reconnecting…';
    }
}

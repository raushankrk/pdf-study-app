// ==========================================
// 📁 4. database.js
// ==========================================
// This file was originally the IndexedDB wrapper. It has been rewritten to
// route all persistence through the FastAPI backend via `js/api.js`.
//
// IMPORTANT: The function signatures are kept identical to the original
// (saveDocumentToDB, saveLinkToDB, saveAnnotationsToDB, etc.) so that
// the rest of the frontend code does not need to change.
// ==========================================

async function initDB() {
    // No-op: the server is the source of truth. We just ping the health endpoint
    // to make sure it's reachable.
    try {
        await Api.health();
    } catch (err) {
        console.warn('Server health check failed:', err);
    }
    return true;
}

// ---- Documents ----
// The frontend's `doc` object includes `file` (Blob) and `pdfDoc` (PDF.js proxy),
// which the server doesn't store as-is. We only persist the metadata fields.
async function saveDocumentToDB(docData) {
    // The function is called in two shapes:
    //   1. Internal "save metadata" calls:  { id, name, pageCount, thumbnail, fileBlob, pageIds, folderId, fileSize, ... }
    //   2. The full state.documents[docId] object: includes file (Blob), pdfDoc, etc.
    // Normalize to the API shape.
    const id = docData.id;
    if (!id) return;
    const fileBlob = docData.fileBlob || docData.file;  // Accept either name
    const update = {
        name: docData.name,
        folder_id: docData.folderId || 'root',
        favorite: !!docData.favorite,
        modified_at: docData.modifiedAt || Date.now(),
        page_count: docData.pageCount,
        page_ids: docData.pageIds,
        // file_size + file_hash are set when the file is uploaded/replaced on the server.
    };
    await Api.updateDocument(id, update);

    // If a new file Blob was provided, upload it (replace the existing PDF).
    if (fileBlob instanceof Blob) {
        try {
            await Api.replaceDocumentFile(id, fileBlob);
        } catch (err) {
            console.error('Failed to upload PDF file:', err);
        }
    }
}

async function deleteDocumentFromDB(docId) {
    if (!docId) return;
    await Api.deleteDocument(docId);
}

// ---- Links ----
async function saveLinkToDB(linkData) {
    // Real-time sync: always push directly to the server. The WebSocket
    // broadcast (triggered by bump_project_revision on the server) will
    // notify other connected devices instantly — no queueing needed.
    await Api.createLink(linkData);
}

async function deleteLinkFromDB(linkId) {
    // Real-time sync: always push directly to the server.
    await Api.deleteLink(linkId);
}

// ---- Annotations ----
// The bulk-save path: replace ALL annotations for a doc.
// Used by the editor's debounced save (called after strokes / drags / etc.).
//
// We try the per-page PUT endpoint first when the caller passes a single
// page; see saveAnnotationPage below. The bulk path uses last-write-wins
// (server-side conflict check is skipped because the bulk replace doesn't
// carry a single revision number).
async function saveAnnotationsToDB(docId, allPagesData) {
    // Real-time sync: always push directly to the server.
    await Api.saveAllAnnotations(docId, allPagesData);
    forgetAnnotationRevisionsForDoc(docId);
}

/**
 * Save a single annotation page WITH conflict detection.
 * Sends `X-Expected-Revision` with the last-seen revision; if the server
 * returns 409, shows the conflict modal and either reloads or overwrites
 * based on the user's choice.
 *
 * @param {string} docId
 * @param {string} pageId
 * @param {object} pageData — { strokes, images, textBoxes }
 * @returns {Promise<boolean>} true if the save succeeded (or was overwritten),
 *   false if the user cancelled.
 */
async function saveAnnotationPageWithConflictCheck(docId, pageId, pageData) {
    const expectedRev = getAnnotationRevision(docId, pageId);
    try {
        const resp = await Api.saveAnnotation(docId, pageId, pageData, expectedRev, false);
        // Server returned { status: 'ok', revision: N } — remember the new rev.
        rememberAnnotationRevision(docId, pageId, resp.revision || expectedRev + 1);
        return true;
    } catch (err) {
        if (err && err.conflict && err.detail) {
            // Show the modal — resolves to 'reload' | 'overwrite' | 'cancel'.
            const choice = await showPageConflictModal(err.detail);
            if (choice === 'cancel') {
                return false;
            }
            if (choice === 'reload') {
                // Reload this page's data from the server.
                const data = await Api.getAnnotation(docId, pageId);
                if (state.annotations[docId] && data && data.data) {
                    state.annotations[docId][pageId] = data.data;
                    // Hydrate any embedded images.
                    if (data.data.images) {
                        data.data.images.forEach(img => {
                            if (!state.imageCache[img.id]) {
                                const imageObj = new Image();
                                imageObj.src = img.src;
                                state.imageCache[img.id] = imageObj;
                            }
                        });
                    }
                    rememberAnnotationRevision(docId, pageId, data.revision || 0);
                    // Re-render the visible side if it's showing this page.
                    ['left', 'right'].forEach(side => {
                        if (state.view[side].docId === docId &&
                            state.view[side].pageId === pageId) {
                            renderAnnotations(side);
                            renderTextLayer(side);
                        }
                    });
                }
                return true;
            }
            if (choice === 'overwrite') {
                // Force-write our local copy.
                try {
                    const resp = await Api.saveAnnotation(docId, pageId, pageData, null, true);
                    rememberAnnotationRevision(docId, pageId, resp.revision || expectedRev + 1);
                    return true;
                } catch (e2) {
                    console.error('[saveAnnotation] force-write failed:', e2);
                    showModal('Save failed', escapeHtml(String(e2)));
                    return false;
                }
            }
            return false;
        }
        // Some other error — re-throw so the caller can show it.
        throw err;
    }
}

// Save just one page's annotations (legacy single-page API; delegates to
// the conflict-aware version above).
async function saveAnnotationToDB(docId, pageId, data) {
    await saveAnnotationPageWithConflictCheck(docId, pageId, data);
}

// ---- Chats ----
async function saveChatToDB(chatData) {
    await Api.updateChat(chatData.id, {
        title: chatData.title,
        messages: chatData.messages || [],
    });
}

async function deleteChatFromDB(chatId) {
    await Api.deleteChat(chatId);
}

// ---- Folders ----
async function saveFolderToDB(folder) {
    // The server creates folders via POST and updates via PUT. We don't have a
    // single "save" endpoint; figure out which to call.
    // (For new folders, the caller uses createFolder() directly via the API.
    //  This function is mostly used to persist expanded-state changes.)
    if (folder.id === ROOT_FOLDER_ID) return;
    // Only persist the expanded flag here — name/parent changes go through
    // dedicated create/move API calls.
    await Api.setFolderExpanded(folder.id, folder.expanded !== false);
}

async function deleteFolderFromDB(folderId) {
    if (!folderId || folderId === ROOT_FOLDER_ID) return;
    await Api.deleteFolder(folderId, false);
}

// ---- Settings ----
async function saveSettings() {
    if (typeof state === "undefined") return;
    const settings = {
        view: state.view,
        splitRatio: state.splitRatio,
        appMode: state.appMode,
        lineMode: state.lineMode,
        annoTool: state.annoTool,
        annoColor: state.annoColor,
        annoThickness: state.annoThickness,
        // Which PDF (left = A / right = B) is currently active — restored on
        // boot so the single header toolbar targets the same PDF again.
        activeSide: state.lastActiveSide === 'right' ? 'right' : 'left',
        // Minimized panel (single-toolbar era): at most one of the two
        // canvases can be collapsed. minimizedAutoLock records whether the
        // lock on that canvas was applied automatically by minimizePanel
        // (so restoring after a reload can undo it again; manual locks stay).
        minimizedSide: state.minimizedSide === 'left' || state.minimizedSide === 'right'
            ? state.minimizedSide : null,
        minimizedAutoLock: !!(state.minimizedSide && state.minimizeAutoLock &&
                              state.minimizeAutoLock[state.minimizedSide]),
        // Per-document reading positions (resume on reopen). One small entry
        // per doc; only docs that still exist are restored on boot.
        lastPositions: state.lastPositions || {},
        // Tagged PDFs (quick-switch rail): keep only docs that still exist.
        taggedDocIds: (Array.isArray(state.taggedDocIds) ? state.taggedDocIds : [])
            .filter(id => state.documents[id]),
        leftSidebarCollapsed: document.body.classList.contains('left-sidebar-collapsed'),
        // Floating tool sidebar (AI Chat + Comments): open state + which pane
        // is shown. Restored on boot; exactly one mode class is always set.
        floatSidebarOpen: document.body.classList.contains('float-sidebar-open'),
        floatSidebarMode: document.body.classList.contains('fs-mode-comments') ? 'comments' : 'chat',
        // Where the user dragged the floating sidebar ({x,y} in workspace CSS
        // px). null = never dragged → the card docks top-right and follows
        // the workspace edge on resize.
        floatSidebarPos: state.floatSidebarPos || null,
        // Where the user dragged the floating annotation toolbar ({x,y} in
        // workspace CSS px). null = never dragged → the bar sits top-center
        // and re-centers on resize until the first drag.
        floatToolbarPos: state.floatToolbarPos || null,
        // Toolbar layout: 'horizontal' ribbon or 'vertical' rail (#ft-orient-
        // toggle flips it). Normalized so only the two exact strings persist.
        floatToolbarOrientation: state.floatToolbarOrientation === 'vertical' ? 'vertical' : 'horizontal',
        aiSettings: state.aiSettings,
        // File-explorer persistence
        currentFolderId: state.currentFolderId || ROOT_FOLDER_ID,
        fileSort: state.fileSort || { by: 'name', order: 'asc' },
        recentDocIds: state.recentDocIds || [],
        collapsedFolderIds: Object.values(state.folders || {})
            .filter(f => f.id !== ROOT_FOLDER_ID && f.expanded === false)
            .map(f => f.id),
        searchMode: state.searchMode || 'files',
    };
    await Api.saveSettings(settings);
}

// ---- Bulk load on startup ----
async function loadStateFromDB() {
    // Returns { documents, links, settings, annotations, chats, folders }
    // in the same shape the original IndexedDB version returned.
    const result = {
        documents: [],
        links: [],
        settings: null,
        annotations: {},
        chats: [],
        folders: [],
    };

    try {
        // Parallel fetch all the data we need at startup.
        const [docs, folders, links, chats, settings] = await Promise.all([
            Api.listDocuments(),
            Api.listFolders(),
            Api.listLinks(),
            Api.listChats(),
            Api.getSettings(),
        ]);

        // Documents: the API returns metadata only (no file/pdfDoc blob).
        // The frontend lazy-loads the actual PDF bytes via Api.fetchDocumentBlob()
        // when a doc is first opened in a viewport (see pdf.js -> ensureDocLoaded).
        result.documents = docs.map(d => ({
            id: d.id,
            name: d.name,
            file: null,          // Lazy-loaded later via Api.fetchDocumentBlob()
            pdfDoc: null,        // Lazy-loaded later via pdfjsLib.getDocument()
            pageCount: d.pageCount,
            thumbnail: d.thumbnail,
            pageIds: d.pageIds || [],
            folderId: d.folderId || 'root',
            fileSize: d.fileSize || 0,
            createdAt: d.createdAt,
            modifiedAt: d.modifiedAt,
            favorite: !!d.favorite,
            fileHash: d.fileHash || null,
        }));

        result.folders = folders.map(f => ({
            id: f.id,
            name: f.name,
            // Root's parent is null on the wire; everyone else's defaults to 'root'.
            parentId: f.id === ROOT_FOLDER_ID ? null : (f.parentId || 'root'),
            createdAt: f.createdAt,
            expanded: f.expanded !== false,
        }));

        result.links = links;
        result.chats = chats;

        // Annotations are NOT loaded eagerly for every doc — too much data for 100+ PDFs.
        // Instead, the frontend fetches annotations per-doc when the doc is opened.
        // (See pdf.js -> ensureDocLoaded which also loads annotations.)

        result.settings = settings || null;
    } catch (err) {
        console.error('loadStateFromDB failed:', err);
        showModal("Connection Error",
            "Could not load data from the server. Make sure the FastAPI backend is running.<br><br>Error: " + escapeHtml(String(err)));
    }

    return result;
}

// ---- Fetch per-doc annotations (called by ensureDocLoaded in pdf.js) ----
// ---- BUG FIX (Stroke continuity) ------------------------------------------
// Helper: after ANY wholesale replacement of state.annotations[docId], make
// sure the stroke the user is drawing RIGHT NOW survives. The fetched
// snapshot can never contain the in-progress stroke (it was never saved —
// with Yjs connected it lives only in the CRDT until pointerup), so without
// this the active stroke was orphaned and strokes[len-1] became the PREVIOUS
// stroke — the next pointermove then appended the new stroke's points into
// it (the "new stroke connects to the previous stroke" bug).
function _preserveInFlightStrokeInLoadedState(docId) {
    if (!state.drawing || !state.drawing.active || !state.drawing.activeStrokeRef) return;
    const ref = state.drawing.activeStrokeRef;
    const side = state.drawing.startSide;
    if (!side || !state.view[side] || state.view[side].docId !== docId) return;
    const pageId = state.view[side].pageId;
    if (!pageId) return;

    if (!state.annotations[docId]) state.annotations[docId] = {};
    if (!state.annotations[docId][pageId]) {
        state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] };
    }
    const pageData = state.annotations[docId][pageId];
    if (!pageData.strokes) pageData.strokes = [];

    if (pageData.strokes.indexOf(ref) !== -1) return; // already canonical
    if (ref.id) {
        const idx = pageData.strokes.findIndex(s => s && s.id === ref.id);
        if (idx !== -1) {
            // The snapshot carried a stale clone — canonicalize to the live
            // object (it holds the newest points).
            pageData.strokes[idx] = ref;
            return;
        }
    }
    // Snapshot predates the stroke — re-append the live object (keeps the
    // "active stroke is last" invariant).
    pageData.strokes.push(ref);
}

async function loadAnnotationsFromServer(docId) {
    try {
        const data = await Api.getAnnotations(docId);
        // The server now returns { pages, revisions, docRevision }.
        // Legacy servers returned just { pageId: pageData }. Handle both.
        let pages = data;
        let revisions = {};
        if (data && typeof data === 'object' && data.pages !== undefined) {
            pages = data.pages || {};
            revisions = data.revisions || {};
        }
        state.annotations[docId] = pages;
        // ---- BUG FIX (Stroke continuity) ----
        // Re-attach the stroke being drawn right now (see helper above).
        _preserveInFlightStrokeInLoadedState(docId);
        // Record the per-page revisions so the editor can send
        // X-Expected-Revision on save.
        conflictState.annotationRevisions[docId] = {};
        Object.keys(pages).forEach(pageId => {
            conflictState.annotationRevisions[docId][pageId] = intOr(revisions[pageId], 0);
            // Hydrate any embedded images into the in-memory image cache.
            const pageData = pages[pageId];
            if (pageData && pageData.images) {
                pageData.images.forEach(img => {
                    if (!state.imageCache[img.id]) {
                        const imageObj = new Image();
                        imageObj.src = img.src;
                        state.imageCache[img.id] = imageObj;
                    }
                });
            }
            if (pageData && !pageData.textBoxes) pageData.textBoxes = [];
        });
        return state.annotations[docId];
    } catch (err) {
        console.error(`Failed to load annotations for ${docId}:`, err);
        state.annotations[docId] = {};
        // ---- BUG FIX (Stroke continuity) ----
        // Same preservation on the error path — never orphan an in-progress
        // stroke, even when the fetch fails.
        _preserveInFlightStrokeInLoadedState(docId);
        return state.annotations[docId];
    }
}

function intOr(v, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
}

// ---- Clear all data ----
async function clearDB() {
    // The original clearDB() wiped all IndexedDB stores. Server-side, we delete
    // everything via the existing per-resource DELETE endpoints.
    const docs = await Api.listDocuments();
    for (const doc of docs) {
        try { await Api.deleteDocument(doc.id); } catch (e) { /* ignore */ }
    }
    const folders = await Api.listFolders();
    for (const f of folders) {
        if (f.id !== ROOT_FOLDER_ID) {
            try { await Api.deleteFolder(f.id, false); } catch (e) { /* ignore */ }
        }
    }
    const chats = await Api.listChats();
    for (const c of chats) {
        try { await Api.deleteChat(c.id); } catch (e) { /* ignore */ }
    }
    try { await Api.saveSettings({}); } catch (e) { /* ignore */ }
}

// ---- Project export (in-editor shortcut; full multi-project management is on the dashboard) ----
// Export the CURRENT project as a .plsx backup file. Server-side handles all the packing.
window.exportProject = async function() {
    const projectId = getProjectId();
    if (!projectId) { showModal("Export", "No project is currently open."); return; }

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Building project backup (.plsx)...";

    try {
        const result = await Api.exportProject(projectId);
        showModal("Exported", `Project backup saved as <b>${escapeHtml(result.filename)}</b>.<br><br>` +
            `Check your browser's Downloads folder.`);
    } catch (err) {
        console.error('Export failed:', err);
        showModal("Error", "Failed to export project: " + escapeHtml(String(err)));
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
};

// The legacy single-project import flow is replaced by the multi-project dashboard.
// If the editor's "Open Project" button is clicked, redirect to the dashboard.
window.handleProjectImport = async function(e) {
    // The dashboard handles imports now. Redirect there.
    showModal("Import moved",
        "Project import is now handled on the Dashboard. " +
        "You will be redirected there now.");
    setTimeout(() => { window.location.href = '/'; }, 1500);
};

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
    await Api.createLink(linkData);
}

async function deleteLinkFromDB(linkId) {
    await Api.deleteLink(linkId);
}

// ---- Annotations ----
// Original signature: saveAnnotationsToDB(docId, allPagesData) where allPagesData
// is { pageId: pageData }. We replace ALL annotations for the doc.
async function saveAnnotationsToDB(docId, allPagesData) {
    await Api.saveAllAnnotations(docId, allPagesData);
}

// Save just one page's annotations.
async function saveAnnotationToDB(docId, pageId, data) {
    await Api.saveAnnotation(docId, pageId, data);
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
    if (!window.state) return;
    const settings = {
        view: state.view,
        splitRatio: state.splitRatio,
        appMode: state.appMode,
        lineMode: state.lineMode,
        annoTool: state.annoTool,
        annoColor: state.annoColor,
        annoThickness: state.annoThickness,
        leftSidebarCollapsed: document.body.classList.contains('left-sidebar-collapsed'),
        aiSidebarCollapsed: document.body.classList.contains('ai-sidebar-collapsed'),
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
async function loadAnnotationsFromServer(docId) {
    try {
        const data = await Api.getAnnotations(docId);
        state.annotations[docId] = data || {};
        // Hydrate any embedded images into the in-memory image cache.
        Object.values(state.annotations[docId]).forEach(pageData => {
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
        return state.annotations[docId];
    }
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

// ---- Project export/import (server-side now, but the entry points stay) ----
window.exportProject = async function() {
    const docKeys = Object.keys(state.documents);
    if (docKeys.length === 0) { showModal("Export", "No documents loaded."); return; }

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Building SQLite export...";

    try {
        // Trigger a download by navigating to the export URL.
        const url = Api.exportProjectUrl();
        const a = document.createElement('a');
        a.href = url;
        a.download = `pdf_linker_project_${Date.now()}.sqlite`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showModal("Saved", "Project exported. Check your Downloads folder.");
    } catch (err) {
        console.error('Export failed:', err);
        showModal("Error", "Failed to export project.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
};

window.handleProjectImport = async function(e) {
    const file = e.target.files[0];
    if (!file) return;

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Importing SQLite Project...";

    try {
        await Api.importProject(file);

        // Reload state from server (mirrors the original behavior after import).
        const savedData = await loadStateFromDB();

        state.links = savedData.links;
        state.annotations = savedData.annotations || {};
        state.chats = savedData.chats || [];

        if (state.chats.length === 0) {
            await createNewChat();
        } else {
            state.currentChatId = state.chats[0].id;
        }

        // Rebuild folders + documents from the server's view.
        state.folders = {};
        state.folders[ROOT_FOLDER_ID] = {
            id: ROOT_FOLDER_ID, name: 'Root', parentId: null,
            createdAt: Date.now(), expanded: true
        };
        savedData.folders.forEach(f => {
            if (f.id !== ROOT_FOLDER_ID) state.folders[f.id] = f;
        });

        state.documents = {};
        for (const dbDoc of savedData.documents) {
            state.documents[dbDoc.id] = dbDoc;
        }

        if (savedData.settings) {
            const s = savedData.settings;
            // Restore only the UI-critical settings — full restoration is below.
            if (s.splitRatio) state.splitRatio = s.splitRatio;
            if (s.aiSettings) state.aiSettings = { ...state.aiSettings, ...s.aiSettings };
            if (s.currentFolderId && state.folders[s.currentFolderId]) state.currentFolderId = s.currentFolderId;
            if (s.fileSort) state.fileSort = s.fileSort;
            if (Array.isArray(s.recentDocIds)) state.recentDocIds = s.recentDocIds.filter(id => state.documents[id]);
        }

        showModal("Import Success", "Project loaded.");

        renderDocList();
        renderChatList();
        renderChatMessages();
        updateZoomIndicator('left');
        updateZoomIndicator('right');
        if (state.view.left.docId) renderPage('left');
        if (state.view.right.docId) renderPage('right');

        // Trigger re-indexing for the newly-imported docs.
        if (typeof indexDocuments === 'function') indexDocuments(false);
    } catch (err) {
        console.error('Import failed:', err);
        showModal("Import Error", "Failed to load project. " + escapeHtml(String(err)));
    } finally {
        els.loadingSpinner.classList.add('hidden');
        e.target.value = '';
    }
};

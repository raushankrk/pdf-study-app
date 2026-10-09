// ==========================================
// 📁 folders.js — Nested folder hierarchy management
// All folder IDs are stable. Renaming/moving/deleting folders never breaks
// PDF/annotation/link/embedding references because those reference by stable
// docId + pageId, not by folder path.
// ==========================================

// ---- Initialization ----
// Called once on app boot (after initDB) to ensure the root folder exists.
async function ensureRootFolder() {
    if (!state.folders) state.folders = {};
    if (!state.folders[ROOT_FOLDER_ID]) {
        state.folders[ROOT_FOLDER_ID] = {
            id: ROOT_FOLDER_ID,
            name: 'Root',
            parentId: null,        // root has no parent
            createdAt: Date.now(),
            expanded: true
        };
        await saveFolderToDB(state.folders[ROOT_FOLDER_ID]);
    }
}

// ---- Tree queries ----
function getFolder(folderId) {
    return state.folders[folderId] || null;
}

function getChildFolders(parentId) {
    return Object.values(state.folders).filter(f => f.id !== ROOT_FOLDER_ID && f.parentId === parentId);
}

function getDescendantFolderIds(folderId) {
    // Returns array of all descendant folder IDs (not including folderId itself).
    const out = [];
    const stack = [folderId];
    while (stack.length) {
        const id = stack.pop();
        const children = getChildFolders(id);
        for (const c of children) {
            out.push(c.id);
            stack.push(c.id);
        }
    }
    return out;
}

function isDescendantOrSelf(candidateId, ancestorId) {
    // Returns true if candidateId is ancestorId or any descendant of ancestorId.
    if (candidateId === ancestorId) return true;
    const descendants = getDescendantFolderIds(ancestorId);
    return descendants.includes(candidateId);
}

function getFolderPath(folderId) {
    // Returns array of folder objects from root to this folder (inclusive).
    // If folderId is unknown, returns just root.
    const path = [];
    let current = getFolder(folderId);
    if (!current) {
        return [state.folders[ROOT_FOLDER_ID]];
    }
    const visited = new Set();
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        path.unshift(current);
        if (current.id === ROOT_FOLDER_ID) break;
        current = getFolder(current.parentId);
    }
    return path;
}

// ---- Folder CRUD ----
async function createFolder(name, parentId = ROOT_FOLDER_ID) {
    const trimmed = (name || '').trim();
    if (!trimmed) {
        showModal("Error", "Folder name cannot be empty.");
        return null;
    }
    if (parentId !== ROOT_FOLDER_ID && !state.folders[parentId]) {
        showModal("Error", "Parent folder does not exist.");
        return null;
    }
    // Avoid duplicate names inside the same parent (case-insensitive).
    const siblings = getChildFolders(parentId);
    if (siblings.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
        showModal("Duplicate Name", `A folder named "${trimmed}" already exists in this location.`);
        return null;
    }

    try {
        // Call the server to create the folder (returns the new ID).
        const result = await Api.createFolder(trimmed, parentId);
        const folder = {
            id: result.id,
            name: trimmed,
            parentId,
            createdAt: Date.now(),
            expanded: true
        };
        state.folders[folder.id] = folder;
        saveSettings();
        renderDocList();
        return folder;
    } catch (err) {
        showModal("Error", `Could not create folder: ${escapeHtml(String(err))}`);
        return null;
    }
}

async function renameFolder(folderId, newName) {
    const folder = getFolder(folderId);
    if (!folder || folderId === ROOT_FOLDER_ID) return;
    const trimmed = (newName || '').trim();
    if (!trimmed) return;

    // Check duplicate among siblings (case-insensitive), excluding self.
    const siblings = getChildFolders(folder.parentId).filter(s => s.id !== folderId);
    if (siblings.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
        showModal("Duplicate Name", `A folder named "${trimmed}" already exists in this location.`);
        return;
    }
    try {
        await Api.renameFolder(folderId, trimmed);
        folder.name = trimmed;
        saveSettings();
        renderDocList();
    } catch (err) {
        showModal("Error", `Could not rename folder: ${escapeHtml(String(err))}`);
    }
}

async function moveFolder(folderId, newParentId) {
    if (folderId === ROOT_FOLDER_ID) {
        showModal("Error", "The root folder cannot be moved.");
        return false;
    }
    const folder = getFolder(folderId);
    if (!folder) return false;

    if (folderId === newParentId) return false;
    if (newParentId !== ROOT_FOLDER_ID && !state.folders[newParentId]) {
        showModal("Error", "Target folder does not exist.");
        return false;
    }
    // Prevent moving a folder into itself or any of its descendants (client-side cycle check).
    if (isDescendantOrSelf(newParentId, folderId)) {
        showModal("Invalid Move", "Cannot move a folder into itself or one of its descendants.");
        return false;
    }
    // Duplicate name check at destination.
    const targetSiblings = getChildFolders(newParentId);
    if (targetSiblings.some(s => s.name.toLowerCase() === folder.name.toLowerCase())) {
        showModal("Duplicate Name", `A folder named "${folder.name}" already exists in the destination.`);
        return false;
    }

    try {
        // Server also validates cycles; if it returns an error, surface it.
        await Api.moveFolder(folderId, newParentId);
        folder.parentId = newParentId;
        saveSettings();
        renderDocList();
        return true;
    } catch (err) {
        showModal("Move Failed", escapeHtml(String(err)));
        return false;
    }
}

async function deleteFolder(folderId, opts = {}) {
    if (folderId === ROOT_FOLDER_ID) {
        showModal("Error", "The root folder cannot be deleted.");
        return false;
    }
    const folder = getFolder(folderId);
    if (!folder) return false;

    const descendants = getDescendantFolderIds(folderId);
    const allFolderIdsToDelete = [folderId, ...descendants];

    let affectedDocs = [];
    for (const docId of Object.keys(state.documents)) {
        if (allFolderIdsToDelete.includes(state.documents[docId].folderId)) {
            affectedDocs.push(docId);
        }
    }

    let proceed = true;
    if (!opts.silent) {
        const message = opts.moveContentsToRoot
            ? `Move ${affectedDocs.length} file(s) from "${folder.name}" (and ${descendants.length} subfolder(s)) to Root, then delete the folder(s)?`
            : `Delete folder "${folder.name}" and all ${descendants.length} subfolder(s)? ${affectedDocs.length} PDF(s) inside will be deleted along with their annotations, links, and embeddings. This cannot be undone.`;
        proceed = confirm(message);
    }
    if (!proceed) return false;

    try {
        // Server handles the cascade delete (or move-to-root).
        await Api.deleteFolder(folderId, !!opts.moveContentsToRoot);

        // Update client state to match.
        if (opts.moveContentsToRoot) {
            // Reparent child folders + docs to root in our local state.
            for (const child of getChildFolders(folderId)) {
                child.parentId = ROOT_FOLDER_ID;
            }
            for (const docId of affectedDocs) {
                state.documents[docId].folderId = ROOT_FOLDER_ID;
            }
            delete state.folders[folderId];
        } else {
            // Cascade-delete docs from local state.
            for (const docId of affectedDocs) {
                delete state.documents[docId];
                delete state.annotations[docId];
            }
            state.recentDocIds = state.recentDocIds.filter(rid => !affectedDocs.includes(rid));
            for (const fid of allFolderIdsToDelete) {
                delete state.folders[fid];
            }
        }

        // If current folder was deleted/moved, reset to root.
        if (!state.folders[state.currentFolderId]) {
            state.currentFolderId = ROOT_FOLDER_ID;
        }
        state.fileSelection.folderIds.clear();
        state.fileSelection.docIds.clear();

        saveSettings();
        renderDocList();
        renderMarkersForView('left');
        renderMarkersForView('right');
        return true;
    } catch (err) {
        showModal("Delete Failed", escapeHtml(String(err)));
        return false;
    }
}

function toggleFolderExpanded(folderId) {
    const folder = getFolder(folderId);
    if (!folder || folderId === ROOT_FOLDER_ID) return;
    folder.expanded = folder.expanded === false;
    // Persist expanded state to server (fire-and-forget).
    Api.setFolderExpanded(folderId, folder.expanded !== false).catch(err =>
        console.error('Failed to persist expanded state:', err)
    );
    saveSettings();
    renderDocList();
}

// Expose to global scope for inline onclick handlers.
window.createFolder = createFolder;
window.renameFolder = renameFolder;
window.moveFolder = moveFolder;
window.deleteFolder = deleteFolder;
window.toggleFolderExpanded = toggleFolderExpanded;

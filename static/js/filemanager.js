// ==========================================
// 📁 filemanager.js — File management UI & operations
// Renders the folder tree, breadcrumb bar, and file list inside the left sidebar.
// Implements: rename, move, duplicate, delete, multi-select, drag-drop,
// sort, search filter, recent files, favorites, file properties, keyboard shortcuts.
// ==========================================

// ---- Lazy rendering state ----
// Reuse state.fileExplorerRender for batching.

// ---- Helpers ----
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes;
    let unitIdx = 0;
    while (val >= 1024 && unitIdx < units.length - 1) {
        val /= 1024;
        unitIdx++;
    }
    return `${val.toFixed(unitIdx === 0 ? 0 : 1)} ${units[unitIdx]}`;
}

// Build a clean persistence object for saveDocumentToDB.
// Critically: never include pdfDoc (PDFDocumentProxy is not structured-cloneable
// and would silently break the IndexedDB write).
function _persistDoc(docId) {
    const doc = state.documents[docId];
    if (!doc) return null;
    return {
        id: doc.id,
        name: doc.name,
        pageCount: doc.pageCount,
        thumbnail: doc.thumbnail,
        fileBlob: doc.file,
        pageIds: doc.pageIds,
        folderId: doc.folderId || ROOT_FOLDER_ID,
        fileSize: doc.fileSize || (doc.file ? doc.file.size : 0),
        createdAt: doc.createdAt || Date.now(),
        modifiedAt: doc.modifiedAt || Date.now(),
        favorite: !!doc.favorite,
        fileHash: doc.fileHash || null
    };
}

// Convenience: persist a doc by ID with proper object shape.
function _saveDocById(docId) {
    const persistObj = _persistDoc(docId);
    if (persistObj) {
        saveDocumentToDB(persistObj).catch(err => console.error('Failed to persist doc:', docId, err));
    }
}

function formatDate(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (e) { return ''; }
}

async function computeFileHash(file) {
    // Use SHA-256 via SubtleCrypto if available; fall back to size+mtime+name otherwise.
    try {
        if (window.crypto && window.crypto.subtle) {
            const buf = await file.arrayBuffer();
            const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
            const arr = Array.from(new Uint8Array(hashBuf));
            return arr.map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { /* fall through */ }
    return `size_${file.size}_name_${file.name}_mtime_${file.lastModified}`;
}

function findDuplicateDocument(file) {
    // Returns existing docId that matches by hash AND by size, or null if none.
    const targetSize = file.size;
    const targetName = file.name;
    for (const docId of Object.keys(state.documents)) {
        const doc = state.documents[docId];
        // Cheap check first: size + name match (avoids computing hash unless necessary).
        if (doc.fileSize === targetSize && doc.name === targetName) {
            return { docId, type: 'exact_name_size' };
        }
    }
    return null;
}

// ---- Tree rendering (unified Explorer-style: folders + files in one tree) ----
// The tree is built recursively, starting from Root. Each folder's children
// (subfolders + files) appear indented beneath it, with classic Windows-style
// vertical/horizontal connector lines drawn via CSS ::before/::after pseudo-elements.
//
// When state.fileExplorerQuery is non-empty, the tree collapses to a flat
// list of matching files/folders across all folders (search-results mode).

function _renderFolderTree() {
    // No-op: tree is rendered together with the file list in _renderFileList().
    // Kept for backward compatibility (renderDocList calls this).
}

function _renderBreadcrumbs() {
    // No-op: with the unified tree, the hierarchy is always visible.
    // The file-count label is updated instead.
    const items = _collectAllTreeItems();
    const folderCount = items.filter(i => i.kind === 'folder').length;
    const docCount = items.filter(i => i.kind === 'doc').length;
    const countEl = document.getElementById('file-count-label');
    if (countEl) {
        countEl.innerText = `${folderCount + docCount} item${(folderCount + docCount) === 1 ? '' : 's'}`;
    }
}

// Collect every folder and document in the entire tree (depth-first).
// Used for the count label and for search-results mode.
function _collectAllTreeItems() {
    const out = [];
    const walk = (folderId) => {
        getChildFolders(folderId).forEach(f => {
            out.push({ kind: 'folder', id: f.id, name: f.name, _ts: f.createdAt || 0, _size: 0, _type: 'folder', _ref: f });
            walk(f.id);
        });
        Object.values(state.documents)
            .filter(d => d.folderId === folderId)
            .forEach(d => out.push({ kind: 'doc', id: d.id, name: d.name, _ts: d.modifiedAt || d.createdAt || 0, _size: d.fileSize || 0, _type: 'pdf', _ref: d }));
    };
    walk(ROOT_FOLDER_ID);
    return out;
}

// Items visible inside a specific folder (one level deep).
function _collectVisibleItems(folderId) {
    folderId = folderId || state.currentFolderId || ROOT_FOLDER_ID;
    const folders = getChildFolders(folderId);
    const docs = Object.values(state.documents).filter(d => d.folderId === folderId);
    const { by, order } = state.fileSort;
    const dir = order === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
        let r = 0;
        if (by === 'date') r = (a._ts || 0) - (b._ts || 0);
        else if (by === 'size') r = (a._size || 0) - (b._size || 0);
        else if (by === 'type') r = (a._type || '').localeCompare(b._type || '');
        else r = (a.name || '').localeCompare(b.name || '');
        if (r === 0) r = (a.name || '').localeCompare(b.name || '');
        return dir * r;
    };
    let items = [];
    folders.forEach(f => items.push({ kind: 'folder', id: f.id, name: f.name, _ts: f.createdAt || 0, _size: 0, _type: 'folder', _ref: f }));
    docs.forEach(d => items.push({ kind: 'doc', id: d.id, name: d.name, _ts: d.modifiedAt || d.createdAt || 0, _size: d.fileSize || 0, _type: 'pdf', _ref: d }));
    if (by === 'name') {
        items.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
            return dir * (a.name || '').localeCompare(b.name || '');
        });
    } else {
        items.sort(cmp);
    }
    return items;
}

// In search mode, we keep the existing _collectVisibleItems signature used by other modules.
// (Rename param-free version that uses currentFolderId.)
function _collectVisibleItemsLegacy() {
    return _collectVisibleItems(state.currentFolderId || ROOT_FOLDER_ID);
}

function _renderFileList() {
    const treeEl = document.getElementById('explorer-tree');
    if (!treeEl) return;
    treeEl.innerHTML = '';

    const query = (state.fileExplorerQuery || '').trim().toLowerCase();

    // Empty state.
    const emptyMsg = document.getElementById('empty-state-msg');
    const allItems = _collectAllTreeItems();
    if (allItems.length === 0) {
        if (emptyMsg) {
            emptyMsg.style.display = 'block';
            emptyMsg.innerHTML = '<i class="fa-regular fa-folder-open mb-2 text-base text-gray-300"></i><br>No PDFs imported yet.<br><span class="text-[10px]">Click the upload icon above to import PDFs.</span>';
        }
        _updateBulkActionBar();
        _updateSortArrows();
        _renderBreadcrumbs();
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    if (query && state.searchMode === 'files') {
        // Search-results mode: flat list of all matching files + folders across the tree.
        const matches = allItems.filter(i => i.name.toLowerCase().includes(query));
        if (matches.length === 0) {
            if (emptyMsg) {
                emptyMsg.style.display = 'block';
                emptyMsg.innerHTML = `<i class="fa-solid fa-magnifying-glass mb-2 text-base text-gray-300"></i><br>No files or folders match "${escapeHtml(query)}".`;
            }
            _updateBulkActionBar();
            _updateSortArrows();
            _renderBreadcrumbs();
            return;
        }
        // Render as a flat list (no parent connector lines — these are search results,
        // not children of a single folder).
        matches.forEach(item => {
            if (item.kind === 'folder') {
                treeEl.appendChild(_renderFolderNode(item._ref, 0, true, [true]));
            } else {
                treeEl.appendChild(_renderDocLeaf(item._ref, 0, true, [true]));
            }
        });
    } else {
        // Normal tree mode: recursively render the tree starting at Root.
        _renderTreeLevel(treeEl, ROOT_FOLDER_ID, 0);
    }

    // Re-apply selection highlights
    _updateBulkActionBar();
    _updateSortArrows();
    _renderBreadcrumbs();
}

// Render one level of the tree (children of `folderId`) into `container`.
// `depth` controls indentation; `isLast` and `parentIsLast` arrays track
// connector-line state for the classic Windows Explorer look.
function _renderTreeLevel(container, folderId, depth, parentLines = []) {
    const items = _collectVisibleItems(folderId);
    // If this is the root level, render an explicit "Root" pseudo-folder at the top.
    if (folderId === ROOT_FOLDER_ID && depth === 0) {
        const rootRow = _renderRootNode(parentLines);
        container.appendChild(rootRow);
        // Render root's children indented under it (always expanded).
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        items.forEach((item, idx) => {
            const isLast = idx === items.length - 1;
            const childLines = [...parentLines, isLast];
            if (item.kind === 'folder') {
                childContainer.appendChild(_renderFolderNode(item._ref, depth + 1, isLast, childLines));
            } else {
                childContainer.appendChild(_renderDocLeaf(item._ref, depth + 1, isLast, childLines));
            }
        });
        container.appendChild(childContainer);
        return;
    }
    // Non-root levels: just render the items.
    items.forEach((item, idx) => {
        const isLast = idx === items.length - 1;
        const childLines = [...parentLines, isLast];
        if (item.kind === 'folder') {
            container.appendChild(_renderFolderNode(item._ref, depth, isLast, childLines));
        } else {
            container.appendChild(_renderDocLeaf(item._ref, depth, isLast, childLines));
        }
    });
}

function _renderRootNode(parentLines) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node tree-folder-root';
    const row = document.createElement('div');
    row.className = 'tree-row folder-row';
    if (state.currentFolderId === ROOT_FOLDER_ID) row.classList.add('folder-active');
    row.innerHTML = `
        <span class="tree-expand no-children"><i class="fa-solid fa-folder-open text-yellow-500"></i></span>
        <span class="folder-name">Root</span>
    `;
    row.onclick = (e) => {
        state.currentFolderId = ROOT_FOLDER_ID;
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        saveSettings();
        renderDocList();
    };
    wrapper.appendChild(row);
    return wrapper;
}

// Render a folder node with classic Windows Explorer tree styling.
// `depth` is the nesting level (0 = top-level child of root).
// `isLast` is whether this folder is the last child of its parent.
// `parentLines` is an array of booleans tracking whether each ancestor level
// has more siblings after the parent (true = vertical line continues,
// false = vertical line stops here).
function _renderFolderNode(folder, depth, isLast, parentLines) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node tree-folder';
    wrapper.dataset.folderId = folder.id;

    const row = document.createElement('div');
    row.className = 'tree-row folder-row';
    row.draggable = true;
    row.dataset.folderId = folder.id;
    if (state.currentFolderId === folder.id) row.classList.add('folder-active');
    if (state.fileSelection.folderIds.has(folder.id)) row.classList.add('selected');

    // Connector lines (the L-shaped elbows + vertical continuations from ancestors)
    const connectors = document.createElement('span');
    connectors.className = 'tree-connectors';
    // For each ancestor level, render either a vertical line (if ancestor had more siblings)
    // or empty space (if it was the last child).
    parentLines.slice(0, -1).forEach(ancestorHasMore => {
        const seg = document.createElement('span');
        seg.className = 'tree-conn' + (ancestorHasMore ? ' vert' : ' empty');
        connectors.appendChild(seg);
    });
    // For this level itself, render the elbow (either └ for last child or ├ for middle child)
    const elbow = document.createElement('span');
    elbow.className = 'tree-conn ' + (isLast ? 'elbow-last' : 'elbow-mid');
    connectors.appendChild(elbow);
    row.appendChild(connectors);

    // Expand/collapse arrow (or spacer if no children)
    const childFolders = getChildFolders(folder.id);
    const childDocs = Object.values(state.documents).filter(d => d.folderId === folder.id);
    const hasChildren = childFolders.length > 0 || childDocs.length > 0;
    const expandBtn = document.createElement('span');
    expandBtn.className = 'tree-expand';
    if (!hasChildren) {
        expandBtn.classList.add('no-children');
        expandBtn.innerHTML = '<i class="fa-regular fa-folder text-gray-400"></i>';
    } else {
        // Toggle arrow
        const expanded = folder.expanded !== false;
        expandBtn.innerHTML = expanded
            ? '<i class="fa-solid fa-chevron-down text-gray-500"></i>'
            : '<i class="fa-solid fa-chevron-right text-gray-500"></i>';
        expandBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFolderExpanded(folder.id);
        };
    }
    row.appendChild(expandBtn);

    // Folder icon (manila yellow). Switch to "open" variant when expanded.
    const iconSpan = document.createElement('span');
    iconSpan.className = 'tree-icon folder-icon';
    const expanded = folder.expanded !== false && hasChildren;
    iconSpan.innerHTML = expanded
        ? '<i class="fa-solid fa-folder-open" style="color:#eab308"></i>'
        : '<i class="fa-solid fa-folder" style="color:#eab308"></i>';
    row.appendChild(iconSpan);

    // Folder name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'folder-name';
    nameSpan.innerText = folder.name;
    row.appendChild(nameSpan);

    // Hover actions
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'folder-actions';
    const addSubBtn = document.createElement('button');
    addSubBtn.className = 'action-btn action-add';
    addSubBtn.title = 'New subfolder';
    addSubBtn.innerHTML = '<i class="fa-solid fa-folder-plus"></i>';
    addSubBtn.onclick = (e) => { e.stopPropagation(); promptForNewFolder(folder.id); };
    const renameBtn = document.createElement('button');
    renameBtn.className = 'action-btn action-rename';
    renameBtn.title = 'Rename folder';
    renameBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    renameBtn.onclick = (e) => { e.stopPropagation(); promptForFolderRename(folder.id); };
    // NEW: Move-to button (same icon as PDFs use). Not shown for Root — Root has no actions at all
    // because it's rendered via _renderRootNode (which has no action buttons).
    const moveBtn = document.createElement('button');
    moveBtn.className = 'action-btn action-move';
    moveBtn.title = 'Move folder to...';
    moveBtn.innerHTML = '<i class="fa-solid fa-folder-tree"></i>';
    moveBtn.onclick = (e) => {
        e.stopPropagation();
        // Single-folder move: select it first so the move dialog knows what to move.
        state.fileSelection.folderIds.clear();
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.add(folder.id);
        showMoveDialog([], [folder.id]);
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn action-delete';
    delBtn.title = 'Delete folder';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.onclick = (e) => { e.stopPropagation(); showDeleteFolderDialog(folder.id); };
    actionsWrap.appendChild(addSubBtn);
    actionsWrap.appendChild(renameBtn);
    actionsWrap.appendChild(moveBtn);
    actionsWrap.appendChild(delBtn);
    row.appendChild(actionsWrap);

    // Row interactions
    row.onclick = (e) => {
        if (e.target.closest('.folder-actions')) return;
        if (e.ctrlKey || e.metaKey) {
            if (state.fileSelection.folderIds.has(folder.id)) {
                state.fileSelection.folderIds.delete(folder.id);
            } else {
                state.fileSelection.folderIds.add(folder.id);
            }
            renderDocList();
            return;
        }
        // Single-click on a folder: select it AND toggle expand/collapse (Explorer-like).
        state.currentFolderId = folder.id;
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        if (hasChildren) toggleFolderExpanded(folder.id);
        else { saveSettings(); renderDocList(); }
    };
    row.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.fileSelection.folderIds.has(folder.id)) {
            state.fileSelection.folderIds.clear();
            state.fileSelection.docIds.clear();
            state.fileSelection.folderIds.add(folder.id);
            renderDocList();
        }
        showFolderContextMenu(e.clientX, e.clientY, folder.id);
    };
    // Drag-drop: drop docs/folders onto this folder to move them in.
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        handleFolderDrop(e, folder.id);
    });
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-folder-id', folder.id);
        e.dataTransfer.effectAllowed = 'move';
    });

    wrapper.appendChild(row);

    // Render children (recursively) if expanded.
    if (expanded) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        const childItems = _collectVisibleItems(folder.id);
        childItems.forEach((item, idx) => {
            const childIsLast = idx === childItems.length - 1;
            const childLines = [...parentLines, isLast];
            if (item.kind === 'folder') {
                childContainer.appendChild(_renderFolderNode(item._ref, depth + 1, childIsLast, childLines));
            } else {
                childContainer.appendChild(_renderDocLeaf(item._ref, depth + 1, childIsLast, childLines));
            }
        });
        wrapper.appendChild(childContainer);
    }
    return wrapper;
}

// Render a document as a leaf in the tree.
function _renderDocLeaf(doc, depth, isLast, parentLines) {
    const row = document.createElement('div');
    row.className = 'tree-row doc-row';
    row.dataset.docId = doc.id;
    row.draggable = true;
    const isActiveLeft = state.view.left.docId === doc.id;
    const isActiveRight = state.view.right.docId === doc.id;
    if (isActiveLeft || isActiveRight) row.classList.add('doc-active');
    if (state.fileSelection.docIds.has(doc.id)) row.classList.add('selected');

    // Connector lines (same pattern as folder)
    const connectors = document.createElement('span');
    connectors.className = 'tree-connectors';
    parentLines.slice(0, -1).forEach(ancestorHasMore => {
        const seg = document.createElement('span');
        seg.className = 'tree-conn' + (ancestorHasMore ? ' vert' : ' empty');
        connectors.appendChild(seg);
    });
    const elbow = document.createElement('span');
    elbow.className = 'tree-conn ' + (isLast ? 'elbow-last' : 'elbow-mid');
    connectors.appendChild(elbow);
    row.appendChild(connectors);

    // Spacer (keeps the doc leaf aligned with folder rows that have an expand arrow)
    const spacer = document.createElement('span');
    spacer.className = 'tree-expand no-children';
    spacer.innerHTML = '<i class="fa-solid fa-file-pdf text-red-500"></i>';
    row.appendChild(spacer);

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name tree-file-name';
    nameSpan.title = `${doc.name} (${doc.pageCount}p, ${formatFileSize(doc.fileSize)})`;
    nameSpan.innerHTML = `<span id="doc-name-${doc.id}" class="doc-name-text">${escapeHtml(doc.name)}</span>`;
    row.appendChild(nameSpan);

    // Badges (L/R viewport indicators)
    if (isActiveLeft || isActiveRight) {
        const badgesWrap = document.createElement('span');
        badgesWrap.className = 'file-badges';
        if (isActiveLeft) badgesWrap.innerHTML += '<span class="vp-badge vp-badge-left" title="Open in left viewport">L</span>';
        if (isActiveRight) badgesWrap.innerHTML += '<span class="vp-badge vp-badge-right" title="Open in right viewport">R</span>';
        row.appendChild(badgesWrap);
    }

    // Favorite star (only if favorited — keeps the row clean otherwise)
    if (doc.favorite) {
        const fav = document.createElement('span');
        fav.className = 'tree-fav';
        fav.innerHTML = '<i class="fa-solid fa-star text-yellow-400 text-[9px]"></i>';
        fav.title = 'Favorite';
        fav.onclick = (e) => { e.stopPropagation(); toggleFavorite(doc.id); };
        row.appendChild(fav);
    }

    // Hover actions
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'file-actions';
    actionsWrap.innerHTML = `
        <button class="action-btn action-fav" title="Toggle favorite">
            <i class="${doc.favorite ? 'fa-solid' : 'fa-regular'} fa-star ${doc.favorite ? 'text-yellow-400' : 'text-gray-400'}"></i>
        </button>
        <button class="action-btn action-rename" title="Rename"><i class="fa-solid fa-pen"></i></button>
        <button class="action-btn action-duplicate" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
        <button class="action-btn action-move" title="Move to..."><i class="fa-solid fa-folder-tree"></i></button>
        <button class="action-btn action-info" title="Properties"><i class="fa-solid fa-circle-info"></i></button>
        <button class="action-btn action-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
    `;
    actionsWrap.querySelector('.action-fav').onclick = (e) => { e.stopPropagation(); toggleFavorite(doc.id); };
    actionsWrap.querySelector('.action-rename').onclick = (e) => { e.stopPropagation(); enableRename(doc.id); };
    actionsWrap.querySelector('.action-duplicate').onclick = (e) => { e.stopPropagation(); duplicateDocument(doc.id); };
    actionsWrap.querySelector('.action-move').onclick = (e) => { e.stopPropagation(); showMoveDialog([doc.id], []); };
    actionsWrap.querySelector('.action-info').onclick = (e) => { e.stopPropagation(); showFileProperties(doc.id); };
    actionsWrap.querySelector('.action-delete').onclick = (e) => {
        e.stopPropagation();
        if (state.fileSelection.docIds.has(doc.id) && state.fileSelection.docIds.size > 1) {
            showBulkDeleteDialog();
        } else {
            deleteDocument(doc.id);
        }
    };
    row.appendChild(actionsWrap);

    // Row interactions
    row.onclick = (e) => {
        if (e.target.closest('.file-actions')) return;
        if (e.ctrlKey || e.metaKey) {
            if (state.fileSelection.docIds.has(doc.id)) {
                state.fileSelection.docIds.delete(doc.id);
            } else {
                state.fileSelection.docIds.add(doc.id);
            }
            renderDocList();
            return;
        }
        if (e.shiftKey) {
            // Range-select within the current folder's flat doc list.
            _rangeSelectTo(doc.id);
            renderDocList();
            return;
        }
        openDocumentSmart(doc.id);
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        renderDocList();
    };
    row.ondblclick = (e) => {
        if (e.target.closest('.file-actions')) return;
        openDocumentSmart(doc.id, true);
    };
    row.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.fileSelection.docIds.has(doc.id)) {
            state.fileSelection.docIds.clear();
            state.fileSelection.docIds.add(doc.id);
            state.fileSelection.folderIds.clear();
            renderDocList();
        }
        showDocContextMenu(e.clientX, e.clientY, doc.id);
    };
    row.addEventListener('dragstart', (e) => {
        const dragIds = state.fileSelection.docIds.has(doc.id) && state.fileSelection.docIds.size > 0
            ? Array.from(state.fileSelection.docIds)
            : [doc.id];
        e.dataTransfer.setData('application/x-doc-ids', JSON.stringify(dragIds));
        e.dataTransfer.effectAllowed = 'move';
    });
    return row;
}

function _rangeSelectTo(docId) {
    // Range-select across the current folder's docs.
    const folderId = state.documents[docId]?.folderId || ROOT_FOLDER_ID;
    const items = _collectVisibleItems(folderId);
    const docItems = items.filter(i => i.kind === 'doc');
    if (docItems.length === 0) return;
    let startIdx = docItems.findIndex(i => i.id === docId);
    if (startIdx === -1) return;
    let anchorIdx = 0;
    if (state.fileSelection.docIds.size > 0) {
        const firstSelId = Array.from(state.fileSelection.docIds)[0];
        const aIdx = docItems.findIndex(i => i.id === firstSelId);
        if (aIdx !== -1) anchorIdx = aIdx;
    }
    const from = Math.min(anchorIdx, startIdx);
    const to = Math.max(anchorIdx, startIdx);
    state.fileSelection.docIds.clear();
    for (let i = from; i <= to; i++) {
        state.fileSelection.docIds.add(docItems[i].id);
    }
}

// ---- Bulk action bar / sort arrows / search-mode helpers ----
function _updateBulkActionBar() {
    const bar = document.getElementById('bulk-action-bar');
    const countLabel = document.getElementById('bulk-selection-count');
    if (!bar || !countLabel) return;
    const docCount = state.fileSelection.docIds.size;
    const folderCount = state.fileSelection.folderIds.size;
    const total = docCount + folderCount;
    if (total === 0) {
        bar.classList.add('hidden');
    } else {
        bar.classList.remove('hidden');
        countLabel.innerText = `${total} selected (${docCount} file${docCount === 1 ? '' : 's'}, ${folderCount} folder${folderCount === 1 ? '' : 's'})`;
    }
}

function _updateSortArrows() {
    ['name', 'date', 'size', 'type'].forEach(by => {
        const arrow = document.getElementById(`sort-${by}-arrow`);
        if (!arrow) return;
        if (state.fileSort.by === by) {
            arrow.innerText = state.fileSort.order === 'asc' ? '▲' : '▼';
        } else {
            arrow.innerText = '';
        }
    });
}

function toggleSortMenu() {
    const dd = document.getElementById('sort-dropdown');
    if (dd) dd.classList.toggle('hidden');
}

// Close sort dropdown when clicking elsewhere.
window.addEventListener('click', (e) => {
    const dd = document.getElementById('sort-dropdown');
    if (dd && !dd.classList.contains('hidden') && !e.target.closest('#sort-dropdown') && !e.target.closest('[onclick*="toggleSortMenu"]')) {
        dd.classList.add('hidden');
    }
});

// ---- Unified search mode toggle ----
function toggleSearchMode() {
    state.searchMode = state.searchMode === 'files' ? 'content' : 'files';
    const input = document.getElementById('unified-search-input');
    const icon = document.getElementById('unified-search-icon');
    const label = document.getElementById('search-mode-label');
    const results = document.getElementById('global-search-results');
    if (state.searchMode === 'files') {
        if (input) input.placeholder = 'Search files...';
        if (icon) icon.className = 'fa-solid fa-filter absolute left-2.5 top-2 text-gray-400 text-[10px]';
        if (label) label.innerText = 'FILES';
        if (results) results.classList.add('hidden');
        // Re-run the file filter.
        setExplorerQuery(input ? input.value : '');
    } else {
        if (input) input.placeholder = 'Search PDF content...';
        if (icon) icon.className = 'fa-solid fa-magnifying-glass absolute left-2.5 top-2 text-gray-400 text-[10px]';
        if (label) label.innerText = 'CONTENT';
        // Clear the file filter and run a content search.
        state.fileExplorerQuery = '';
        if (input && input.value) performGlobalSearch();
        else if (results) results.classList.add('hidden');
    }
}

// Keep references for external callers.
window.toggleSortMenu = toggleSortMenu;
window.toggleSearchMode = toggleSearchMode;

// ---- Smart open (uses active side, respects locks) ----
function openDocumentSmart(docId, forceDouble = false) {
    let side = state.lastActiveSide || 'left';
    if (state.view[side].locked) {
        const other = side === 'left' ? 'right' : 'left';
        if (!state.view[other].locked) side = other;
        else {
            showModal("Viewport Locked", "Cannot open document: Both viewports are locked.");
            return;
        }
    }
    // If both viewports already have this doc, switch to opposite side.
    if (!forceDouble && (state.view.left.docId === docId || state.view.right.docId === docId)) {
        side = state.view.left.docId === docId ? 'right' : 'left';
        if (state.view[side].locked) {
            side = state.view.left.docId === docId ? 'left' : 'right';
        }
    }
    setActiveDocument(side, docId);
    pushRecentDoc(docId);
}

function pushRecentDoc(docId) {
    if (!docId) return;
    state.recentDocIds = state.recentDocIds.filter(id => id !== docId);
    state.recentDocIds.unshift(docId);
    if (state.recentDocIds.length > MAX_RECENT_DOCS) {
        state.recentDocIds.length = MAX_RECENT_DOCS;
    }
    saveSettings();
    renderRecentFiles();
}

function renderRecentFiles() {
    const container = document.getElementById('recent-files');
    if (!container) return;
    container.innerHTML = '';
    if (state.recentDocIds.length === 0) {
        container.parentElement.style.display = 'none';
        return;
    }
    container.parentElement.style.display = '';
    state.recentDocIds.forEach(docId => {
        const doc = state.documents[docId];
        if (!doc) return;
        const item = document.createElement('div');
        item.className = 'recent-file-item';
        item.title = doc.name;
        item.innerHTML = `
            <i class="fa-solid fa-file-pdf text-red-500 text-[10px]"></i>
            <span class="truncate">${escapeHtml(doc.name)}</span>
        `;
        item.onclick = () => openDocumentSmart(docId);
        container.appendChild(item);
    });
}

// ---- Favorites ----
function toggleFavorite(docId) {
    const doc = state.documents[docId];
    if (!doc) return;
    doc.favorite = !doc.favorite;
    _saveDocById(docId);
    renderDocList();
}

// ---- Move dialog ----
function showMoveDialog(docIds, folderIds) {
    if ((docIds.length === 0) && (folderIds.length === 0)) return;
    const modal = document.getElementById('move-dialog');
    const tree = document.getElementById('move-dialog-tree');
    if (!modal || !tree) return;

    // Build a flat-indented list of all folders (excluding any folder being moved or its descendants).
    const forbidden = new Set();
    folderIds.forEach(fid => {
        forbidden.add(fid);
        getDescendantFolderIds(fid).forEach(d => forbidden.add(d));
    });

    tree.innerHTML = '';
    const renderItem = (folder, depth) => {
        const row = document.createElement('div');
        row.className = 'move-tree-row';
        row.style.paddingLeft = `${8 + depth * 16}px`;
        if (folder.id === ROOT_FOLDER_ID) {
            row.innerHTML = `<i class="fa-solid fa-folder text-blue-500"></i> <span>${escapeHtml(folder.name)}</span>`;
        } else {
            row.innerHTML = `<i class="fa-regular fa-folder text-gray-500"></i> <span>${escapeHtml(folder.name)}</span>`;
        }
        row.dataset.folderId = folder.id;
        row.onclick = () => {
            tree.querySelectorAll('.move-tree-row').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
        };
        if (forbidden.has(folder.id)) {
            row.classList.add('disabled');
            row.title = 'Cannot move into this folder (would create a cycle)';
        }
        tree.appendChild(row);
        getChildFolders(folder.id).forEach(c => renderItem(c, depth + 1));
    };
    renderItem(state.folders[ROOT_FOLDER_ID], 0);

    modal.classList.remove('hidden');

    const cancelBtn = document.getElementById('move-dialog-cancel');
    const confirmBtn = document.getElementById('move-dialog-confirm');
    const newCancel = cancelBtn.cloneNode(true);
    const newConfirm = confirmBtn.cloneNode(true);
    cancelBtn.replaceWith(newCancel);
    confirmBtn.replaceWith(newConfirm);
    newCancel.onclick = () => modal.classList.add('hidden');
    newConfirm.onclick = () => {
        const selectedRow = tree.querySelector('.move-tree-row.selected');
        if (!selectedRow) {
            showModal("No Selection", "Please select a destination folder.");
            return;
        }
        const targetId = selectedRow.dataset.folderId;
        if (!targetId || !state.folders[targetId]) {
            showModal("Error", "Invalid destination folder.");
            return;
        }
        // Hide the modal synchronously so the UI feels responsive; persist async.
        modal.classList.add('hidden');

        let moved = 0;
        for (const docId of docIds) {
            const doc = state.documents[docId];
            if (doc && state.folders[targetId]) {
                doc.folderId = targetId;
                doc.modifiedAt = Date.now();
                moved++;
                _saveDocById(docId);
            }
        }
        for (const fid of folderIds) {
            // moveFolder already handles its own DB persistence.
            moveFolder(fid, targetId).then(ok => { if (ok) moved++; }).catch(err => console.error(err));
        }
        // Clear selection after a move.
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        saveSettings();
        renderDocList();
    };
}

// ---- Context menus ----
function _ensureContextMenu() {
    let menu = document.getElementById('context-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'context-menu';
        menu.className = 'context-menu hidden';
        document.body.appendChild(menu);
    }
    return menu;
}

function _showMenuAt(menu, x, y) {
    menu.classList.remove('hidden');
    // Position so it doesn't go off-screen.
    const rect = menu.getBoundingClientRect();
    let left = x, top = y;
    if (x + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function _closeAllMenus() {
    document.querySelectorAll('.context-menu').forEach(m => m.classList.add('hidden'));
}

function showDocContextMenu(x, y, docId) {
    const menu = _ensureContextMenu();
    const doc = state.documents[docId];
    if (!doc) return;
    const selectedDocIds = Array.from(state.fileSelection.docIds);
    const selectedFolderIds = Array.from(state.fileSelection.folderIds);
    const isMulti = selectedDocIds.length + selectedFolderIds.length > 1;
    menu.innerHTML = `
        <div class="cm-item" data-action="open"><i class="fa-solid fa-folder-open"></i> Open</div>
        <div class="cm-item" data-action="open-other"><i class="fa-solid fa-window-restore"></i> Open in other viewport</div>
        <div class="cm-sep"></div>
        <div class="cm-item" data-action="rename"><i class="fa-solid fa-pen"></i> Rename <span class="cm-key">F2</span></div>
        <div class="cm-item" data-action="duplicate"><i class="fa-solid fa-clone"></i> Duplicate</div>
        <div class="cm-item" data-action="move"><i class="fa-solid fa-folder-tree"></i> Move to...</div>
        <div class="cm-item" data-action="fav"><i class="fa-${doc.favorite ? 'solid' : 'regular'} fa-star"></i> ${doc.favorite ? 'Unstar' : 'Star'}</div>
        <div class="cm-item" data-action="info"><i class="fa-solid fa-circle-info"></i> Properties</div>
        <div class="cm-sep"></div>
        <div class="cm-item cm-danger" data-action="delete"><i class="fa-solid fa-trash"></i> Delete <span class="cm-key">Del</span></div>
    `;
    _showMenuAt(menu, x, y);
    menu.querySelectorAll('.cm-item').forEach(item => {
        item.onclick = () => {
            const action = item.dataset.action;
            _closeAllMenus();
            if (action === 'open') openDocumentSmart(docId);
            else if (action === 'open-other') {
                const otherSide = state.lastActiveSide === 'left' ? 'right' : 'left';
                setActiveDocument(otherSide, docId);
                pushRecentDoc(docId);
            }
            else if (action === 'rename') enableRename(docId);
            else if (action === 'duplicate') duplicateDocument(docId);
            else if (action === 'move') showMoveDialog(selectedDocIds, selectedFolderIds);
            else if (action === 'fav') toggleFavorite(docId);
            else if (action === 'info') showFileProperties(docId);
            else if (action === 'delete') {
                if (isMulti) showBulkDeleteDialog();
                else deleteDocument(docId);
            }
        };
    });
}

function showFolderContextMenu(x, y, folderId) {
    const menu = _ensureContextMenu();
    const folder = getFolder(folderId);
    if (!folder) return;
    const selectedFolderIds = Array.from(state.fileSelection.folderIds);
    const selectedDocIds = Array.from(state.fileSelection.docIds);
    menu.innerHTML = `
        <div class="cm-item" data-action="open"><i class="fa-solid fa-folder-open"></i> Open</div>
        <div class="cm-item" data-action="new-sub"><i class="fa-solid fa-folder-plus"></i> New subfolder</div>
        <div class="cm-sep"></div>
        <div class="cm-item" data-action="rename"><i class="fa-solid fa-pen"></i> Rename</div>
        <div class="cm-item" data-action="move"><i class="fa-solid fa-folder-tree"></i> Move to...</div>
        <div class="cm-sep"></div>
        <div class="cm-item cm-danger" data-action="delete"><i class="fa-solid fa-trash"></i> Delete</div>
    `;
    _showMenuAt(menu, x, y);
    menu.querySelectorAll('.cm-item').forEach(item => {
        item.onclick = () => {
            const action = item.dataset.action;
            _closeAllMenus();
            if (action === 'open') {
                state.currentFolderId = folderId;
                state.fileSelection.docIds.clear();
                state.fileSelection.folderIds.clear();
                saveSettings();
                renderDocList();
            } else if (action === 'new-sub') {
                promptForNewFolder(folderId);
            } else if (action === 'rename') {
                promptForFolderRename(folderId);
            } else if (action === 'move') {
                showMoveDialog(selectedDocIds, selectedFolderIds);
            } else if (action === 'delete') {
                showDeleteFolderDialog(folderId);
            }
        };
    });
}

function showEmptyAreaContextMenu(x, y) {
    const menu = _ensureContextMenu();
    menu.innerHTML = `
        <div class="cm-item" data-action="new-folder"><i class="fa-solid fa-folder-plus"></i> New folder here</div>
        <div class="cm-item" data-action="import"><i class="fa-solid fa-file-arrow-up"></i> Import PDFs here</div>
        <div class="cm-sep"></div>
        <div class="cm-item" data-action="select-all"><i class="fa-solid fa-check-double"></i> Select all</div>
        <div class="cm-item" data-action="paste"><i class="fa-solid fa-paste"></i> Paste</div>
    `;
    _showMenuAt(menu, x, y);
    menu.querySelectorAll('.cm-item').forEach(item => {
        item.onclick = () => {
            const action = item.dataset.action;
            _closeAllMenus();
            if (action === 'new-folder') promptForNewFolder(state.currentFolderId);
            else if (action === 'import') document.getElementById('pdf-upload-input').click();
            else if (action === 'select-all') selectAllFiles();
            else if (action === 'paste') pasteClipboardFiles();
        };
    });
}

// ---- Drag & drop ----
async function handleFolderDrop(e, targetFolderId) {
    const folderIdRaw = e.dataTransfer.getData('application/x-folder-id');
    const docIdsRaw = e.dataTransfer.getData('application/x-doc-ids');
    let movedAny = false;
    if (folderIdRaw) {
        if (await moveFolder(folderIdRaw, targetFolderId)) movedAny = true;
    }
    if (docIdsRaw) {
        try {
            const ids = JSON.parse(docIdsRaw);
            for (const docId of ids) {
                const doc = state.documents[docId];
                if (doc && state.folders[targetFolderId]) {
                    doc.folderId = targetFolderId;
                    doc.modifiedAt = Date.now();
                    _saveDocById(docId);
                    movedAny = true;
                }
            }
        } catch (err) { console.warn('Bad drag data', err); }
    }
    if (movedAny) {
        saveSettings();
        renderDocList();
    }
}

// ---- Folder prompts ----
async function promptForNewFolder(parentId) {
    const name = await showPromptModal("New Folder", "");
    if (name && name.trim()) {
        await createFolder(name, parentId || ROOT_FOLDER_ID);
    }
}

async function promptForFolderRename(folderId) {
    const folder = getFolder(folderId);
    if (!folder) return;
    const name = await showPromptModal("Rename Folder", folder.name);
    if (name && name.trim()) {
        await renameFolder(folderId, name);
    }
}

function showDeleteFolderDialog(folderId) {
    const folder = getFolder(folderId);
    if (!folder) return;
    // Use a simple choice modal: choose between cascade-delete and move-to-root.
    const choice = confirm(
        `Delete folder "${folder.name}"?\n\nClick OK to DELETE all files inside (and subfolders).\nClick Cancel to instead move the contents to Root and just remove the empty folder(s).`
    );
    if (choice) {
        deleteFolder(folderId, { moveContentsToRoot: false });
    } else {
        deleteFolder(folderId, { moveContentsToRoot: true });
    }
}

// ---- File operations ----
async function duplicateDocument(docId) {
    const src = state.documents[docId];
    if (!src) return;
    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = `Duplicating ${src.name}...`;
    try {
        // Server-side duplicate: copies the PDF file + annotations.
        const result = await Api.duplicateDocument(docId);
        const newId = result.id;
        const newName = result.name;

        // Fetch the new doc's full metadata and add to state (lazy-loaded).
        const fullDoc = await Api.getDocument(newId);
        state.documents[newId] = {
            id: fullDoc.id,
            name: fullDoc.name,
            file: null,
            pdfDoc: null,
            pageCount: fullDoc.pageCount,
            thumbnail: fullDoc.thumbnail,
            pageIds: fullDoc.pageIds || [],
            folderId: fullDoc.folderId || 'root',
            fileSize: fullDoc.fileSize || 0,
            createdAt: fullDoc.createdAt,
            modifiedAt: fullDoc.modifiedAt,
            favorite: !!fullDoc.favorite,
            fileHash: fullDoc.fileHash,
        };
        // Don't pre-load annotations — they'll be lazy-loaded with the doc.

        showModal("Duplicated", `Created copy: ${newName}`);
    } catch (err) {
        console.error('Duplicate failed:', err);
        showModal("Error", "Failed to duplicate document.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
        renderDocList();
    }
}

function _uniqueNameInFolder(desiredName, folderId, excludeDocId = null) {
    let candidate = desiredName;
    let counter = 1;
    const baseName = desiredName.replace(/\.pdf$/i, '');
    const hasPdfExt = /\.pdf$/i.test(desiredName);
    while (Object.values(state.documents).some(d =>
        d.id !== excludeDocId &&
        d.folderId === folderId &&
        d.name.toLowerCase() === candidate.toLowerCase()
    )) {
        candidate = `${baseName} (${counter})${hasPdfExt ? '.pdf' : ''}`;
        counter++;
    }
    return candidate;
}

// ---- Bulk operations ----
function selectAllFiles() {
    // Select all docs in the current folder (the visible level of the tree).
    const items = _collectVisibleItems(state.currentFolderId || ROOT_FOLDER_ID);
    state.fileSelection.docIds.clear();
    state.fileSelection.folderIds.clear();
    items.forEach(i => {
        if (i.kind === 'doc') state.fileSelection.docIds.add(i.id);
        else state.fileSelection.folderIds.add(i.id);
    });
    renderDocList();
}

function clearFileSelection() {
    state.fileSelection.docIds.clear();
    state.fileSelection.folderIds.clear();
    renderDocList();
}

function showBulkDeleteDialog() {
    const docCount = state.fileSelection.docIds.size;
    const folderCount = state.fileSelection.folderIds.size;
    if (docCount === 0 && folderCount === 0) return;
    if (!confirm(`Delete ${docCount} file(s) and ${folderCount} folder(s)?\n\nFolders will be deleted along with all files inside.`)) return;
    _bulkDelete();
}

async function _bulkDelete() {
    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Deleting...";
    try {
        for (const docId of Array.from(state.fileSelection.docIds)) {
            await _deleteDocumentRecord(docId);
        }
        for (const folderId of Array.from(state.fileSelection.folderIds)) {
            await deleteFolder(folderId, { silent: true, moveContentsToRoot: false });
        }
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        showModal("Deleted", "Selected items removed.");
    } catch (err) {
        console.error('Bulk delete failed:', err);
        showModal("Error", "Some items could not be deleted.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
        renderDocList();
        renderMarkersForView('left');
        renderMarkersForView('right');
    }
}

// Internal: removes a document and its annotations/links/embeddings without prompting.
async function _deleteDocumentRecord(id) {
    if (!state.documents[id]) return;
    delete state.documents[id];
    delete state.annotations[id];
    // Embeddings live server-side now; nothing to filter here.

    // Remove from links list (client-side cache) and on the server.
    const updatedLinks = state.links.filter(l =>
        (l.source.docId || l.source.doc_id) !== id &&
        (l.target.docId || l.target.doc_id) !== id
    );
    // Delete the dead links from the server.
    const deadLinks = state.links.filter(l =>
        (l.source.docId || l.source.doc_id) === id ||
        (l.target.docId || l.target.doc_id) === id
    );
    state.links = updatedLinks;

    // Remove from recent list.
    state.recentDocIds = state.recentDocIds.filter(rid => rid !== id);

    // Server-side cascade delete (file + annotations + embeddings + links).
    try {
        await Api.deleteDocument(id);
    } catch (err) {
        console.error('Failed to delete document from server:', err);
    }
}

// ---- File properties ----
function showFileProperties(docId) {
    const doc = state.documents[docId];
    if (!doc) return;
    const annoCount = state.annotations[docId]
        ? Object.keys(state.annotations[docId]).length
        : 0;
    const linkCount = state.links.filter(l => l.source.docId === docId || l.target.docId === docId).length;
    const embCount = state.embeddings.filter(e => e.docId === docId).length;
    const folderName = doc.folderId && state.folders[doc.folderId] ? state.folders[doc.folderId].name : 'Root';
    const pathArr = getFolderPath(doc.folderId || ROOT_FOLDER_ID).map(f => f.name).join(' / ');

    const html = `
        <div class="properties-grid">
            <div class="prop-label">Name</div><div class="prop-value">${escapeHtml(doc.name)}</div>
            <div class="prop-label">ID</div><div class="prop-value mono">${doc.id}</div>
            <div class="prop-label">Folder</div><div class="prop-value">${escapeHtml(pathArr)}</div>
            <div class="prop-label">Pages</div><div class="prop-value">${doc.pageCount}</div>
            <div class="prop-label">File Size</div><div class="prop-value">${formatFileSize(doc.fileSize)}</div>
            <div class="prop-label">Imported</div><div class="prop-value">${formatDate(doc.createdAt)}</div>
            <div class="prop-label">Modified</div><div class="prop-value">${formatDate(doc.modifiedAt)}</div>
            <div class="prop-label">Favorite</div><div class="prop-value">${doc.favorite ? 'Yes' : 'No'}</div>
            <div class="prop-label">Annotations</div><div class="prop-value">${annoCount} page(s) with annotations</div>
            <div class="prop-label">Links</div><div class="prop-value">${linkCount}</div>
            <div class="prop-label">Embeddings</div><div class="prop-value">${embCount}</div>
        </div>
    `;
    showModal("File Properties", html);
}

// ---- Paste / clipboard ----
let _clipboardDocIds = [];
async function copySelectedFiles() {
    _clipboardDocIds = Array.from(state.fileSelection.docIds);
    if (_clipboardDocIds.length > 0) {
        // Visual feedback via the AI status text would be weird; use a transient toast via the modal.
        // Keep it lightweight — no modal popup.
    }
}

async function pasteClipboardFiles() {
    if (_clipboardDocIds.length === 0) {
        showModal("Paste", "Clipboard is empty. Select files and press Ctrl+C first.");
        return;
    }
    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Pasting files...";
    try {
        const targetFolder = state.currentFolderId || ROOT_FOLDER_ID;
        for (const srcId of _clipboardDocIds) {
            const src = state.documents[srcId];
            if (!src) continue;
            await duplicateDocument(srcId); // duplicate keeps the same folder; we then move it.
            // Find the new doc — it's the most recently added.
            const newId = Object.keys(state.documents).sort((a, b) =>
                (state.documents[b].createdAt || 0) - (state.documents[a].createdAt || 0)
            )[0];
            if (newId && newId !== srcId) {
                state.documents[newId].folderId = targetFolder;
                state.documents[newId].name = _uniqueNameInFolder(src.name, targetFolder, srcId);
                _saveDocById(newId);
            }
        }
        showModal("Pasted", `Duplicated ${_clipboardDocIds.length} file(s) into ${state.folders[targetFolder].name}.`);
    } catch (err) {
        console.error('Paste failed:', err);
        showModal("Error", "Failed to paste files.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
        renderDocList();
    }
}

// ---- Sort / search UI bindings ----
function setSortBy(by) {
    if (state.fileSort.by === by) {
        state.fileSort.order = state.fileSort.order === 'asc' ? 'desc' : 'asc';
    } else {
        state.fileSort.by = by;
        state.fileSort.order = 'asc';
    }
    // Close the sort dropdown after a selection is made.
    const dd = document.getElementById('sort-dropdown');
    if (dd) dd.classList.add('hidden');
    saveSettings();
    renderDocList();
}

function setExplorerQuery(q) {
    state.fileExplorerQuery = q || '';
    renderDocList();
}

// ---- Global click handler to close context menus ----
window.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu') && !e.target.closest('[data-no-close-menu]')) {
        _closeAllMenus();
    }
});
window.addEventListener('blur', _closeAllMenus);

// Expose to global scope for inline onclick handlers.
window.openDocumentSmart = openDocumentSmart;
window.toggleFavorite = toggleFavorite;
window.duplicateDocument = duplicateDocument;
window.showMoveDialog = showMoveDialog;
window.showFileProperties = showFileProperties;
window.selectAllFiles = selectAllFiles;
window.clearFileSelection = clearFileSelection;
window.showBulkDeleteDialog = showBulkDeleteDialog;
window.promptForNewFolder = promptForNewFolder;
window.setSortBy = setSortBy;
window.setExplorerQuery = setExplorerQuery;
window.copySelectedFiles = copySelectedFiles;
window.pasteClipboardFiles = pasteClipboardFiles;

// ==========================================
// 📁 12. app.js
// ==========================================

// ---- Dashboard navigation ----
// Tracks in-flight API requests so we can warn the user before navigating away
// (browser "beforeunload" doesn't see pending fetches, so we track them manually).
let _pendingSaveCount = 0;

function _incPendingSave() { _pendingSaveCount++; }
function _decPendingSave() { _pendingSaveCount = Math.max(0, _pendingSaveCount - 1); }
function hasPendingSaves() { return _pendingSaveCount > 0; }

// Warn the user before navigating away / closing the tab if there are pending saves.
window.addEventListener('beforeunload', (e) => {
    if (hasPendingSaves()) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Navigate back to the dashboard. Warns the user if there are pending saves.
async function goToDashboard() {
    if (hasPendingSaves()) {
        if (!confirm('There are pending saves still in flight. Leaving now may lose unsaved changes. Continue?')) {
            return;
        }
    }
    // Best-effort flush of settings (view state, scroll position, etc.) before leaving.
    try {
        if (typeof saveSettings === 'function') await saveSettings();
    } catch (e) { /* ignore */ }
    window.location.href = '/';
}
window.goToDashboard = goToDashboard;

async function init() {
    configureMarked();

    // ---- Determine which project we're editing ----
    // The URL is /editor/<project_id>. Extract the project_id and tell the API
    // client to send it as the X-Project-Id header on every request.
    const pathMatch = window.location.pathname.match(/\/editor\/([^/]+)/);
    if (pathMatch) {
        const projectId = decodeURIComponent(pathMatch[1]);
        setProjectId(projectId);
        // Update the editor header to show the project name.
        try {
            const proj = await Api.getProject(projectId);
            const titleEl = document.querySelector('h1.text-base.font-bold');
            if (titleEl) titleEl.innerText = `PDF Linker Studio — ${proj.name}`;
            document.title = `PDF Linker Studio — ${proj.name}`;
        } catch (err) {
            console.warn('Could not load project info:', err);
        }
    } else {
        // No project in URL — redirect to the dashboard.
        window.location.href = '/';
        return;
    }

    try {
        // sql.js is no longer needed for IndexedDB-style persistence — the server
        // is the source of truth. We still load it for project export/import, which
        // builds/downloads a SQLite file on the server side.
        // (Kept the include in index.html for any legacy code paths.)

        await initDB();  // Health-checks the server
        await ensureRootFolder();  // Ensures root folder exists in state (server already has it)
        const savedData = await loadStateFromDB();

        // ---- Restore folders ----
        if (Array.isArray(savedData.folders)) {
            state.folders = {};
            state.folders[ROOT_FOLDER_ID] = {
                id: ROOT_FOLDER_ID, name: 'Root', parentId: null,
                createdAt: Date.now(), expanded: true
            };
            savedData.folders.forEach(f => {
                if (f.id !== ROOT_FOLDER_ID) state.folders[f.id] = f;
                else state.folders[ROOT_FOLDER_ID] = { ...f, parentId: null };
            });
        }

        if (savedData.documents.length > 0 || savedData.links.length > 0 || savedData.chats.length > 0) {
            els.loadingSpinner.classList.remove('hidden');
            els.emptyMsg.style.display = 'none';

            state.links = savedData.links;
            state.annotations = savedData.annotations || {};
            state.chats = savedData.chats || [];

            if (state.chats.length === 0) {
                await createNewChat();
            } else {
                state.currentChatId = state.chats[0].id;
            }

            // Restore documents — LAZY LOADED now. We only store metadata;
            // the actual PDF bytes + pdfDoc proxy are fetched on demand when
            // the doc is opened in a viewport (see pdf.js -> ensureDocLoaded).
            for (const dbDoc of savedData.documents) {
                state.documents[dbDoc.id] = {
                    id: dbDoc.id,
                    file: null,                  // Lazy-loaded
                    pdfDoc: null,                // Lazy-loaded
                    name: dbDoc.name,
                    pageCount: dbDoc.pageCount,
                    thumbnail: dbDoc.thumbnail,
                    pageIds: dbDoc.pageIds || [],
                    folderId: dbDoc.folderId && state.folders[dbDoc.folderId] ? dbDoc.folderId : ROOT_FOLDER_ID,
                    fileSize: dbDoc.fileSize || 0,
                    createdAt: dbDoc.createdAt || Date.now(),
                    modifiedAt: dbDoc.modifiedAt || Date.now(),
                    favorite: !!dbDoc.favorite,
                    fileHash: dbDoc.fileHash || null,
                };
            }

            if (savedData.settings && savedData.settings.view) {
                const sView = savedData.settings.view;

                if (sView.left && sView.left.locked === undefined) sView.left.locked = false;
                if (sView.right && sView.right.locked === undefined) sView.right.locked = false;

                if (sView.left.docId && state.documents[sView.left.docId]) {
                    state.view.left = { ...sView.left, scrollTop: sView.left.scrollTop || 0 };
                    // Re-resolve pageId/pageNum against the current pageIds array: if pages were
                    // inserted/deleted in a prior session (or this is data from before stable IDs
                    // existed), this keeps the view valid instead of pointing at a stale page.
                    const leftDoc = state.documents[state.view.left.docId];
                    if (state.view.left.pageId && leftDoc.pageIds.includes(state.view.left.pageId)) {
                        state.view.left.pageNum = pageNumFromId(leftDoc, state.view.left.pageId);
                    } else {
                        const fallbackNum = Math.min(state.view.left.pageNum || 1, leftDoc.pageCount);
                        state.view.left.pageNum = fallbackNum;
                        state.view.left.pageId = pageIdFromNum(leftDoc, fallbackNum);
                    }
                    if (state.view.left.docId) state.lastActiveSide = 'left';
                }
                
                const leftBtn = document.getElementById('lock-left-btn');
                const leftIcon = leftBtn ? leftBtn.querySelector('i') : null;
                if (state.view.left.locked) {
                    if(leftBtn) leftBtn.classList.add('locked');
                    if(leftIcon) {
                        leftIcon.classList.remove('fa-lock-open');
                        leftIcon.classList.add('fa-lock');
                    }
                }

                if (sView.right.docId && state.documents[sView.right.docId]) {
                    state.view.right = { ...sView.right, scrollTop: sView.right.scrollTop || 0 };
                    const rightDoc = state.documents[state.view.right.docId];
                    if (state.view.right.pageId && rightDoc.pageIds.includes(state.view.right.pageId)) {
                        state.view.right.pageNum = pageNumFromId(rightDoc, state.view.right.pageId);
                    } else {
                        const fallbackNum = Math.min(state.view.right.pageNum || 1, rightDoc.pageCount);
                        state.view.right.pageNum = fallbackNum;
                        state.view.right.pageId = pageIdFromNum(rightDoc, fallbackNum);
                    }
                }

                const rightBtn = document.getElementById('lock-right-btn');
                const rightIcon = rightBtn ? rightBtn.querySelector('i') : null;
                if (state.view.right.locked) {
                    if(rightBtn) rightBtn.classList.add('locked');
                    if(rightIcon) {
                        rightIcon.classList.remove('fa-lock-open');
                        rightIcon.classList.add('fa-lock');
                    }
                }

                if (savedData.settings.splitRatio) {
                    state.splitRatio = savedData.settings.splitRatio;
                    els.leftPanel.style.width = (state.splitRatio * 100) + '%';
                    els.rightPanel.style.width = ((1 - state.splitRatio) * 100) + '%';
                }
                if (savedData.settings.appMode) setAppMode(savedData.settings.appMode, false);
                if (savedData.settings.annoTool) setAnnoTool(savedData.settings.annoTool, false);
                const lineModeBtn = document.getElementById('tool-line-mode');
                if (lineModeBtn && state.lineMode === 'straight') {
                    lineModeBtn.classList.add('bg-blue-50', 'text-blue-600');
                    lineModeBtn.classList.remove('text-gray-500');
                }
                if (savedData.settings.annoColor) {
                    state.annoColor = savedData.settings.annoColor;
                    els.colorPicker.value = savedData.settings.annoColor;
                }
                if (savedData.settings.annoThickness) {
                    state.annoThickness = savedData.settings.annoThickness;
                    els.thicknessPicker.value = savedData.settings.annoThickness;
                }
                if (savedData.settings.leftSidebarCollapsed) {
                    document.body.classList.add('left-sidebar-collapsed');
                }
                if (savedData.settings.aiSidebarCollapsed) {
                    document.body.classList.add('ai-sidebar-collapsed');
                }
                // Restore AI settings
                if (savedData.settings.aiSettings) {
                    state.aiSettings = { ...state.aiSettings, ...savedData.settings.aiSettings };
                }
                if (savedData.settings.lineMode) {
                    state.lineMode = savedData.settings.lineMode;
                }

                // ---- Restore file-explorer state ----
                if (savedData.settings.currentFolderId && state.folders[savedData.settings.currentFolderId]) {
                    state.currentFolderId = savedData.settings.currentFolderId;
                } else {
                    state.currentFolderId = ROOT_FOLDER_ID;
                }
                if (savedData.settings.fileSort) {
                    state.fileSort = savedData.settings.fileSort;
                }
                if (Array.isArray(savedData.settings.recentDocIds)) {
                    // Filter out any IDs that no longer exist.
                    state.recentDocIds = savedData.settings.recentDocIds.filter(id => state.documents[id]);
                }
                if (Array.isArray(savedData.settings.collapsedFolderIds)) {
                    const collapsedSet = new Set(savedData.settings.collapsedFolderIds);
                    Object.values(state.folders).forEach(f => {
                        if (f.id !== ROOT_FOLDER_ID) f.expanded = !collapsedSet.has(f.id);
                    });
                }
            }
            renderDocList();
            renderChatList();
            renderChatMessages();
            updateZoomIndicator('left');
            updateZoomIndicator('right');
            if (state.view.left.docId) renderPage('left');
            if (state.view.right.docId) renderPage('right');
            updateLockVisuals(); 
        } else {
            await createNewChat();
        }

        els.loadingSpinner.classList.add('hidden');

    } catch (err) {
        console.error("Init failed:", err);
    }

    // Register Event Listeners
    els.uploadInput.addEventListener('change', handleFileUpload);
    els.imageInput.addEventListener('change', handleImageUpload);
    els.importInput.addEventListener('change', handleProjectImport);

    // Note: the unified search input listener is registered further below
    // (it switches behavior based on state.searchMode: 'files' or 'content').
    ['left', 'right'].forEach(side => {
        document.getElementById(`${side}-search-input`).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') performViewportSearch(side);
            if (e.key === 'Escape') closeViewportSearch(side);
        });
        document.getElementById(`${side}-search-input`).addEventListener('input', debounce(() => performViewportSearch(side), 500));
    });

    window.addEventListener('paste', handlePaste);
    window.addEventListener('pointerdown', handlePointerDown, { passive: false });
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp, { passive: false });
    window.addEventListener('keydown', handleKeyDown);

    // ---- CRITICAL for iPad / touch devices ----
    // On iOS Safari/Chrome, the browser starts its default touch action (text
    // selection, long-press callout menu, double-tap zoom) BEFORE the
    // pointerdown event fires. We need to intercept touchstart directly and
    // call preventDefault() in drawing/editing modes to stop the OS-level
    // behavior. The CSS rules (touch-action: none, user-select: none,
    // -webkit-touch-callout: none) handle most of this, but on some iOS
    // versions the touchstart event still needs to be explicitly cancelled.
    //
    // We register this as a capture-phase listener on the document so it runs
    // before any other handler. We only prevent default when we're in a
    // drawing/editing mode AND the touch lands inside a viewport.
    document.addEventListener('touchstart', (e) => {
        // Only intercept in non-navigation modes
        if (state.appMode === 'navigation') return;
        // Check if the touch is inside a viewport
        const target = e.target;
        if (target.closest('#left-viewport') || target.closest('#right-viewport')) {
            e.preventDefault();
        }
    }, { passive: false, capture: true });

    // Also prevent touchmove defaults in drawing modes so the page doesn't
    // scroll/pan while the user is drawing.
    document.addEventListener('touchmove', (e) => {
        if (state.appMode === 'navigation') return;
        if (state.drawing && state.drawing.active) {
            e.preventDefault();
        }
    }, { passive: false, capture: true });

    els.leftViewport.addEventListener('scroll', () => handleScroll('left'));
    els.rightViewport.addEventListener('scroll', () => handleScroll('right'));

    els.leftViewport.addEventListener('wheel', (e) => handleViewportZoom(e, 'left'), { passive: false });
    els.rightViewport.addEventListener('wheel', (e) => handleViewportZoom(e, 'right'), { passive: false });

    els.colorPicker.addEventListener('input', (e) => {
        state.annoColor = e.target.value;
        if (state.toolSettings && state.toolSettings[state.annoTool]) {
            state.toolSettings[state.annoTool].color = state.annoColor;
        }
        if (state.annoTool === 'pen') setAnnoTool('pen', false); 
        saveSettings();
        updateThicknessPreview();
    });

    els.thicknessPicker.addEventListener('input', (e) => {
        state.annoThickness = parseInt(e.target.value);
        const display = document.getElementById('thickness-val');
        if (display) display.innerText = state.annoThickness;
        if (state.toolSettings && state.toolSettings[state.annoTool]) {
            state.toolSettings[state.annoTool].thickness = state.annoThickness;
        }
        saveSettings();
        updateThicknessPreview();
    });

    // AI Settings Range Sliders (live text update)
    if (els.aiSettingTemp) {
        els.aiSettingTemp.addEventListener('input', (e) => els.aiSettingTempVal.innerText = parseFloat(e.target.value).toFixed(1));
    }
    if (els.aiSettingSim) {
        els.aiSettingSim.addEventListener('input', (e) => els.aiSettingSimVal.innerText = parseFloat(e.target.value).toFixed(2));
    }

    els.sendChatBtn.addEventListener('click', handleChat);
    els.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleChat();
        }
    });

    initResizer();
    updateViewportActiveVisuals();

    // ---- File-explorer event listeners ----
    // Unified search input: behavior depends on state.searchMode ('files' or 'content').
    const unifiedSearchInput = document.getElementById('unified-search-input');
    if (unifiedSearchInput) {
        unifiedSearchInput.addEventListener('input', debounce((e) => {
            if (state.searchMode === 'files') {
                setExplorerQuery(e.target.value);
            } else {
                // Content search mode: re-use performGlobalSearch from search.js.
                if (e.target.value.trim()) {
                    performGlobalSearch();
                } else {
                    const results = document.getElementById('global-search-results');
                    if (results) results.classList.add('hidden');
                }
            }
        }, 300));
        // Enter key in content mode opens the first result.
        unifiedSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && state.searchMode === 'content') {
                const firstResult = document.querySelector('#global-search-results .search-result-item');
                if (firstResult) firstResult.click();
            }
            if (e.key === 'Escape') {
                e.target.value = '';
                if (state.searchMode === 'files') setExplorerQuery('');
                else {
                    const results = document.getElementById('global-search-results');
                    if (results) results.classList.add('hidden');
                }
            }
        });
    }

    // Empty-area right-click: show "New folder here" / "Import" / "Paste" menu.
    const explorerTree = document.getElementById('explorer-tree');
    const docListEl = document.getElementById('doc-list');
    const targetForMenu = explorerTree || docListEl;
    if (targetForMenu) {
        targetForMenu.addEventListener('contextmenu', (e) => {
            // Only trigger empty-area menu when right-clicking on blank space (not on a row).
            if (e.target === targetForMenu || e.target.id === 'empty-state-msg' || e.target.id === 'explorer-tree' || e.target.id === 'doc-list') {
                e.preventDefault();
                if (typeof showEmptyAreaContextMenu === 'function') showEmptyAreaContextMenu(e.clientX, e.clientY);
            }
        });
        // Empty-area click: clear selection.
        targetForMenu.addEventListener('click', (e) => {
            if (e.target === targetForMenu || e.target.id === 'empty-state-msg' || e.target.id === 'explorer-tree' || e.target.id === 'doc-list') {
                clearFileSelection();
            }
        });
        // Allow drag-and-drop directly onto the tree area = move to current folder (no-op if already there).
        targetForMenu.addEventListener('dragover', (e) => {
            e.preventDefault();
            targetForMenu.classList.add('drag-over');
        });
        targetForMenu.addEventListener('dragleave', () => targetForMenu.classList.remove('drag-over'));
        targetForMenu.addEventListener('drop', (e) => {
            e.preventDefault();
            targetForMenu.classList.remove('drag-over');
            handleFolderDrop(e, state.currentFolderId || ROOT_FOLDER_ID);
        });
    }

    // Click-outside handler to close the sort dropdown.
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('sort-dropdown');
        if (dd && !dd.classList.contains('hidden') &&
            !e.target.closest('#sort-dropdown') &&
            !e.target.closest('[onclick*="toggleSortMenu"]')) {
            dd.classList.add('hidden');
        }
    });
}

// Initialize Application
init();
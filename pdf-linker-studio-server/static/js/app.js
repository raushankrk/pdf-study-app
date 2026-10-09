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
        // Update the document title (browser tab) with the project name so
        // users can identify the tab — but DON'T overwrite the visible H1
        // in the header (which would push the annotation tools off-screen
        // on narrow / touch devices).
        try {
            const proj = await Api.getProject(projectId);
            document.title = `${proj.name} — PDF Linker Studio`;
            // Seed the conflict-detection baseline. This is the revision we
            // consider "ours" — any future change to it means another device
            // saved something to the project.
            if (typeof conflictState !== 'undefined' && proj.revision !== undefined) {
                conflictState.projectRevision = parseInt(proj.revision, 10) || 0;
                conflictState.projectRevisionLoadedAt = Date.now();
            }
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

                // ---- Restore Active PDF (single header toolbar) ----
                // The saved activeSide wins if that viewport still has a doc;
                // otherwise fall back sensibly: the side that has a doc, or left.
                const savedActiveSide = savedData.settings.activeSide;
                if ((savedActiveSide === 'left' || savedActiveSide === 'right') &&
                    state.view[savedActiveSide] && state.view[savedActiveSide].docId) {
                    state.lastActiveSide = savedActiveSide;
                } else if (!state.view.left.docId && state.view.right.docId) {
                    state.lastActiveSide = 'right';
                }

                // ---- Restore per-document reading positions (resume on reopen) ----
                // Keep only entries whose doc still exists and whose shape is
                // valid. The two viewports are the freshest source for the
                // docs they currently show — seed/refresh those entries from
                // the restored view state so a reload never loses the spot
                // even if the settings blob was saved by an older version.
                state.lastPositions = {};
                const savedPositions = savedData.settings.lastPositions;
                if (savedPositions && typeof savedPositions === 'object') {
                    Object.keys(savedPositions).forEach(docId => {
                        const p = savedPositions[docId];
                        if (state.documents[docId] && p && typeof p === 'object') {
                            state.lastPositions[docId] = {
                                pageId: p.pageId || null,
                                pageNum: parseInt(p.pageNum, 10) || 1,
                                scrollTop: Math.max(0, parseInt(p.scrollTop, 10) || 0),
                            };
                        }
                    });
                }
                ['left', 'right'].forEach(side => {
                    const v = state.view[side];
                    if (v && v.docId && state.documents[v.docId]) {
                        state.lastPositions[v.docId] = {
                            pageId: v.pageId || null,
                            pageNum: v.pageNum || 1,
                            scrollTop: Math.max(0, v.scrollTop || 0),
                        };
                    }
                });

                if (savedData.settings.splitRatio) {
                    state.splitRatio = savedData.settings.splitRatio;
                    els.leftPanel.style.width = (state.splitRatio * 100) + '%';
                    els.rightPanel.style.width = ((1 - state.splitRatio) * 100) + '%';
                }

                // ---- Restore minimized panel (single-toolbar era) ----
                // If a canvas was minimized when the session ended, collapse
                // it again. Its lock is already persisted via settings.view
                // (minimizePanel auto-locks); minimizedAutoLock tells us the
                // lock was OURS, so a later restore will undo it again.
                // Never restore on a fresh workspace (no docs at all).
                const savedMinSide = savedData.settings.minimizedSide;
                if ((savedMinSide === 'left' || savedMinSide === 'right') &&
                    (state.view.left.docId || state.view.right.docId)) {
                    minimizePanel(savedMinSide, false);
                    // minimizePanel recomputes the auto-lock flag from the view
                    // state — but the lock itself was PERSISTED, so at boot the
                    // viewport already looks locked and the recomputed flag
                    // would wrongly read false. Re-assert the persisted flag:
                    // a later restore must unlock a lock that was originally
                    // automatic, and keep a manual lock.
                    state.minimizeAutoLock[savedMinSide] = savedData.settings.minimizedAutoLock === true;
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
    // ---- BUG FIX (touch devices: pause/hold while drawing) ----
    // iPadOS / Android fire pointercancel when the OS takes the pointer over
    // (long-press after a pause, gesture detection, palm rejection, ...).
    // Without this handler a cancelled stroke left state.drawing.active true,
    // the active stroke in-flight and the next touch inherited stale state.
    window.addEventListener('pointercancel', handlePointerCancel, { passive: false });
    window.addEventListener('keydown', handleKeyDown);

    // ---- CRITICAL for iPad / touch devices ----
    // On iOS Safari/Chrome, the browser starts its default touch action (text
    // selection, long-press callout menu, double-tap zoom) BEFORE the
    // pointerdown event fires. We need to intercept touchstart directly and
    // call preventDefault() in drawing/editing modes to stop the OS-level
    // behavior.
    //
    // The CSS rules (touch-action: none, user-select: none, etc.) handle most
    // of this, but iOS Safari has a known bug where transparent <span> elements
    // in the textLayer can still be selected even when pointer-events:none is set
    // on their parent. The only reliable fix is to intercept touchstart in the
    // capture phase and cancel it.
    //
    // We register this as a capture-phase listener on the document so it runs
    // before any other handler.
    document.addEventListener('touchstart', (e) => {
        // Only intercept in non-navigation modes
        if (state.appMode === 'navigation') return;
        // Don't intercept touches inside the comment overlay — the textarea
        // and buttons need normal touch behavior to work.
        if (e.target.closest('#comment-editor-panel') || e.target.closest('#comment-backdrop')) return;
        // Check if any of the touches are inside a viewport
        const target = e.target;
        if (target.closest('#left-viewport') || target.closest('#right-viewport')) {
            e.preventDefault();
        }
        // Also catch touches on textLayer spans specifically — these are the
        // transparent <span> elements that cause the "whole page selected" issue.
        if (target.closest('.textLayer') || target.closest('.textLayer span')) {
            e.preventDefault();
        }
    }, { passive: false, capture: true });

    // Also prevent touchmove defaults in drawing modes so the page doesn't
    // scroll/pan while the user is drawing. BUT allow 2-finger touchmove for
    // pan/zoom (the two-finger gesture handler in initTwoFingerGestures handles it).
    document.addEventListener('touchmove', (e) => {
        if (state.appMode === 'navigation') return;
        // Don't intercept touchmove inside the comment overlay — the textarea
        // needs normal scroll/text-selection behavior.
        if (e.target.closest('#comment-editor-panel')) return;
        // 2-finger touches are pan/zoom — let the gesture handler deal with them
        if (e.touches.length >= 2) return;
        if (state.drawing && state.drawing.active) {
            e.preventDefault();
        }
    }, { passive: false, capture: true });

    // Prevent the contextmenu event (long-press callout) in drawing modes.
    // On iPad, long-pressing fires a 'contextmenu' event that shows the iOS
    // selection callout (Copy, Look Up, Share, etc.). We suppress it entirely
    // in non-navigation modes.
    document.addEventListener('contextmenu', (e) => {
        if (state.appMode === 'navigation') return;
        const target = e.target;
        if (target.closest('#left-viewport') || target.closest('#right-viewport')) {
            e.preventDefault();
        }
    }, { passive: false, capture: true });

    els.leftViewport.addEventListener('scroll', () => handleScroll('left'));
    els.rightViewport.addEventListener('scroll', () => handleScroll('right'));

    els.leftViewport.addEventListener('wheel', (e) => handleViewportZoom(e, 'left'), { passive: false });
    els.rightViewport.addEventListener('wheel', (e) => handleViewportZoom(e, 'right'), { passive: false });

    // ---- Two-finger gestures on touch devices (iPad / phone) ----
    // Two-finger touch pans (scrolls) and/or pinch-zooms the PDF.
    // Works in ALL modes (navigation + annotation + linking + ...).
    // One-finger touch in annotation mode draws; two fingers always =
    // pan/zoom, never draw. The mode (pen/highlighter/etc.) is preserved.
    initPinchZoom();

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

    // ---- Comment sidebar: live preview + keyboard shortcuts ----
    if (els.commentMarkdownInput) {
        // Live preview updates as the user types in split mode.
        els.commentMarkdownInput.addEventListener('input', () => {
            if (typeof _onCommentInput === 'function') _onCommentInput();
        });
        // Ctrl+Enter to save, Escape to cancel (matches the old text-box editor).
        els.commentMarkdownInput.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                // Tab inserts 4 spaces instead of changing focus.
                e.preventDefault();
                const ta = e.target;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
                ta.selectionStart = ta.selectionEnd = start + 4;
                if (typeof _onCommentInput === 'function') _onCommentInput();
            } else if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                if (typeof saveCommentFromSidebar === 'function') saveCommentFromSidebar();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (typeof cancelCommentEdit === 'function') cancelCommentEdit();
            }
        });
    }

    // ---- Comment overlay backdrop: click outside the panel to close ----
    // The backdrop sits behind the floating comment panel. Clicking/tapping
    // it (i.e. clicking outside the panel) closes the comment — UNLESS
    // we're in split mode with unsaved changes, in which case we treat
    // it as a cancel (which removes empty comments or keeps non-empty ones).
    //
    // We use pointerdown (not click) for faster response on touch devices.
    // This is safe because handlePointerDown in events.js already bails out
    // when the target is inside #comment-backdrop, so there's no conflict.
    const commentBackdrop = document.getElementById('comment-backdrop');
    if (commentBackdrop) {
        commentBackdrop.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof cancelCommentEdit === 'function') cancelCommentEdit();
        });
    }

    // ---- Global Escape key: also closes the comment overlay ----
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' &&
            state.activeComment && state.activeComment.id &&
            document.activeElement !== els.commentMarkdownInput) {
            // Only fire if focus is NOT inside the textarea (the textarea's
            // own Escape handler already calls cancelCommentEdit).
            if (typeof cancelCommentEdit === 'function') cancelCommentEdit();
        }
    });

    initResizer();
    updateViewportActiveVisuals();

    // ---- Header horizontal scroll for mouse-wheel users ----
    // The single Active-PDF toolbar makes the header wider than the window
    // on smaller screens (it now also hosts the lock / find / zoom / page
    // controls of the active PDF). Vertical wheel over the header scrolls
    // it horizontally — but ONLY when the header actually overflows, so
    // wide screens behave exactly as before.
    const headerEl = document.querySelector('body > header');
    if (headerEl) {
        headerEl.addEventListener('wheel', (e) => {
            if (headerEl.scrollWidth <= headerEl.clientWidth) return;
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                e.preventDefault();
                headerEl.scrollLeft += e.deltaY;
            }
        }, { passive: false });
    }

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

    // ---- Multi-device conflict detection ----
    // Poll the server's project revision every 30s; if it changes, show a banner
    // telling the user another device has modified the project. Stopped in
    // beforeunload / pagehide so we don't keep firing requests after navigation.
    if (typeof startProjectRevisionPolling === 'function') {
        startProjectRevisionPolling();
    }
    window.addEventListener('pagehide', () => {
        if (typeof stopProjectRevisionPolling === 'function') stopProjectRevisionPolling();
    });
}

// Initialize Application
init();
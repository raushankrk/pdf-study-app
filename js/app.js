// ==========================================
// 📁 12. app.js
// ==========================================
async function init() {
    try {
        if (!window.SQL) {
            const SQL = await initSqlJs({
                locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
            });
            window.SQL = SQL;
        }

        await initDB();
        const savedData = await loadStateFromDB();
        
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

            Object.values(state.annotations).forEach(pages => {
                Object.values(pages).forEach(pageData => {
                    if(pageData.images) {
                        pageData.images.forEach(img => {
                            const imageObj = new Image();
                            imageObj.src = img.src;
                            state.imageCache[img.id] = imageObj;
                        });
                    }
                    if(!pageData.textBoxes) pageData.textBoxes = [];
                });
            });

            for (const dbDoc of savedData.documents) {
                try {
                    const arrayBuffer = await dbDoc.fileBlob.arrayBuffer();
                    const pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;
                    state.documents[dbDoc.id] = {
                        id: dbDoc.id,
                        file: dbDoc.fileBlob, 
                        pdfDoc: pdfDoc,
                        name: dbDoc.name,
                        pageCount: pdfDoc.numPages,
                        thumbnail: dbDoc.thumbnail
                    };
                } catch (err) { console.error("Failed to restore doc:", dbDoc.name, err); }
            }

            if (savedData.settings) {
                const sView = savedData.settings.view;
                
                if (sView.left && sView.left.locked === undefined) sView.left.locked = false;
                if (sView.right && sView.right.locked === undefined) sView.right.locked = false;

                if (sView.left.docId && state.documents[sView.left.docId]) {
                    state.view.left = { ...sView.left, scrollTop: sView.left.scrollTop || 0 };
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
    
    els.globalSearchInput.addEventListener('input', debounce(performGlobalSearch, 300));
    ['left', 'right'].forEach(side => {
        document.getElementById(`${side}-search-input`).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') performViewportSearch(side);
            if (e.key === 'Escape') closeViewportSearch(side);
        });
        document.getElementById(`${side}-search-input`).addEventListener('input', debounce(() => performViewportSearch(side), 500));
    });

    window.addEventListener('paste', handlePaste);
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown);
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
    });

    els.thicknessPicker.addEventListener('input', (e) => {
        state.annoThickness = parseInt(e.target.value);
        const display = document.getElementById('thickness-val');
        if (display) display.innerText = state.annoThickness;
        if (state.toolSettings && state.toolSettings[state.annoTool]) {
            state.toolSettings[state.annoTool].thickness = state.annoThickness;
        }
        saveSettings();
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
}

// Initialize Application
init();
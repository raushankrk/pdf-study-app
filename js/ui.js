// ==========================================
// 📁 5. ui.js
// ==========================================
function toggleLock(side) {
    state.view[side].locked = !state.view[side].locked;
    const btn = document.getElementById(`lock-${side}-btn`);
    const icon = btn.querySelector('i');
    
    if (state.view[side].locked) {
        btn.classList.add('locked');
        icon.classList.remove('fa-lock-open');
        icon.classList.add('fa-lock');
    } else {
        btn.classList.remove('locked');
        icon.classList.remove('fa-lock');
        icon.classList.add('fa-lock-open');
    }
    saveSettings();
}

function updateLockVisuals() {
    ['left', 'right'].forEach(side => {
        const btn = document.getElementById(`lock-${side}-btn`);
        const icon = btn.querySelector('i');
        const isLocked = state.view[side].locked;

        if (isLocked) {
            btn.classList.add('locked');
            icon.classList.remove('fa-lock-open');
            icon.classList.add('fa-lock');
        } else {
            btn.classList.remove('locked');
            icon.classList.remove('fa-lock');
            icon.classList.add('fa-lock-open');
        }
    });
}

function updateViewportActiveVisuals() {
    const leftViewport = document.getElementById('left-viewport');
    const rightViewport = document.getElementById('right-viewport');

    if (state.lastActiveSide === 'left') {
        leftViewport.classList.add('viewport-wrapper-active');
        rightViewport.classList.remove('viewport-wrapper-active');
    } else {
        leftViewport.classList.remove('viewport-wrapper-active');
        rightViewport.classList.add('viewport-wrapper-active');
    }
}

function toggleLeftSidebar() {
    document.body.classList.toggle('left-sidebar-collapsed');
    saveSettings();
}

function toggleAiSidebar() {
    document.body.classList.toggle('ai-sidebar-collapsed');
    saveSettings();
}

function setAppMode(mode, save = true) {
    state.appMode = mode;
    if (save) saveSettings();

    document.body.classList.remove('linking-mode', 'annotation-mode', 'anno-pen', 'anno-pixel-eraser', 'anno-stroke-eraser', 'anno-select', 'anno-text', 'anno-image', 'delete-link-mode', 'snip-link-mode');

    [els.modeNavBtn, els.modeLinkBtn, els.modeDelLinkBtn, els.modeAnnoBtn, els.modeSnipLinkBtn].forEach(btn => {
        if(btn) {
            btn.classList.remove('bg-white', 'shadow-sm', 'text-gray-800');
            btn.classList.add('text-gray-500');
        }
    });
    els.annoTools.classList.add('hidden');

    if (mode !== 'snip-link' && typeof cancelSnip === 'function') {
        cancelSnip();
    }

    if (mode === 'navigation') {
        els.modeNavBtn.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
        els.modeNavBtn.classList.remove('text-gray-500');
    } else if (mode === 'linking') {
        document.body.classList.add('linking-mode');
        els.modeLinkBtn.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
        els.modeLinkBtn.classList.remove('text-gray-500');
    } else if (mode === 'snip-link') {
        document.body.classList.add('snip-link-mode');
        if(els.modeSnipLinkBtn) {
            els.modeSnipLinkBtn.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
            els.modeSnipLinkBtn.classList.remove('text-gray-500');
        }
        showModal("Snip & Link Mode", "1. Drag a box over the source document to extract an image.\n2. Click on the destination document to place the image and automatically create a two-way link.");
    } else if (mode === 'delete-link') {
        document.body.classList.add('delete-link-mode');
        els.modeDelLinkBtn.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
        els.modeDelLinkBtn.classList.remove('text-gray-500');
        showModal("Delete Link Mode", "Click on any red link marker to delete it.");
    } else if (mode === 'annotation') {
        document.body.classList.add('annotation-mode');
        els.modeAnnoBtn.classList.add('bg-white', 'shadow-sm', 'text-gray-800');
        els.modeAnnoBtn.classList.remove('text-gray-500');
        els.annoTools.classList.remove('hidden');
        setAnnoTool(state.annoTool, false); 
    }
}

function setAnnoTool(tool, save = true) {
    state.annoTool = tool;
    if (save) saveSettings();

    const allTools = [els.toolSelect, els.toolPen, els.toolText, els.toolEraserPixel, els.toolEraserStroke, els.toolHighlighter, els.toolImage];
    allTools.forEach(btn => {
        if (!btn) return;
        btn.classList.remove('bg-blue-50', 'text-blue-600', 'bg-purple-50', 'text-purple-600', 'bg-yellow-100', 'text-yellow-700');
        btn.classList.add('text-gray-500');
    });

    document.body.classList.remove('anno-pen', 'anno-pixel-eraser', 'anno-stroke-eraser', 'anno-select', 'anno-text', 'anno-highlighter', 'anno-image');

    if (!state.toolSettings) {
        state.toolSettings = {
            pen: { color: '#ef4444', thickness: 5 },
            highlighter: { color: '#facc15', thickness: 20 }
        };
    }

    if (state.toolSettings[tool]) {
        const settings = state.toolSettings[tool];
        
        if (settings.color !== undefined) {
            state.annoColor = settings.color;
            els.colorPicker.value = settings.color;
        }
        if (settings.thickness !== undefined) {
            state.annoThickness = settings.thickness;
            els.thicknessPicker.value = settings.thickness;
            
            const thicknessDisplay = document.getElementById('thickness-val');
            if(thicknessDisplay) thicknessDisplay.innerText = settings.thickness;
        }
    }

    if (tool === 'select') {
        els.toolSelect.classList.add('bg-purple-50', 'text-purple-600');
        els.toolSelect.classList.remove('text-gray-500');
        document.body.classList.add('anno-select');
    } 
    else if (tool === 'pen') {
        els.toolPen.classList.add('bg-blue-50', 'text-blue-600');
        els.toolPen.classList.remove('text-gray-500');
        document.body.classList.add('anno-pen');
    } 
    else if (tool === 'text') {
        els.toolText.classList.add('bg-blue-50', 'text-blue-600');
        els.toolText.classList.remove('text-gray-500');
        document.body.classList.add('anno-text');
    } 
    else if (tool === 'eraser-pixel') {
        els.toolEraserPixel.classList.add('bg-blue-50', 'text-blue-600');
        els.toolEraserPixel.classList.remove('text-gray-500');
        document.body.classList.add('anno-pixel-eraser');
    } 
    else if (tool === 'eraser-stroke') {
        els.toolEraserStroke.classList.add('bg-blue-50', 'text-blue-600');
        els.toolEraserStroke.classList.remove('text-gray-500');
        document.body.classList.add('anno-stroke-eraser');
    }
    else if (tool === 'highlighter') {
        els.toolHighlighter.classList.add('bg-yellow-100', 'text-yellow-700');
        els.toolHighlighter.classList.remove('text-gray-500');
        document.body.classList.add('anno-highlighter');
    }
    else if (tool === 'image') {
        els.toolImage.classList.add('bg-blue-50', 'text-blue-600');
        els.toolImage.classList.remove('text-gray-500');
        document.body.classList.add('anno-image');
    }
}

function showModal(title, body, isPrompt = false) {
    els.modalTitle.innerText = title;
    els.modalBody.innerHTML = body.replace(/\n/g, '<br>');
    
    if (isPrompt) {
        els.modalBody.classList.add('hidden');
        els.modalInput.classList.remove('hidden');
        els.modalInput.value = '';
        els.modalInput.focus();
        els.modalConfirmBtn.classList.remove('hidden');
    } else {
        els.modalBody.classList.remove('hidden');
        els.modalInput.classList.add('hidden');
        els.modalConfirmBtn.classList.add('hidden');
    }
    
    els.modal.classList.remove('hidden');
}

function showPromptModal(title, defaultValue = '') {
    return new Promise((resolve) => {
        modalResolve = resolve;
        showModal(title, '', true);
        if(defaultValue) els.modalInput.value = defaultValue;
    });
}

function closeModal(result = false) {
    if (modalResolve) {
        const val = result ? els.modalInput.value : null;
        modalResolve(val);
        modalResolve = null;
    }
    els.modal.classList.add('hidden');
}

function initResizer() {
    const resizer = els.resizer;
    const leftSide = els.leftPanel;
    const rightSide = els.rightPanel;
    const container = els.workspaceMain;
    
    let x = 0;
    let leftWidth = 0;

    const mouseDownHandler = function(e) {
        x = e.clientX;
        const rect = leftSide.getBoundingClientRect();
        leftWidth = rect.width;

        document.body.classList.add('resizing-active');
        resizer.classList.add('resizing');

        document.addEventListener('pointermove', mouseMoveHandler);
        document.addEventListener('pointerup', mouseUpHandler);
    };

    const mouseMoveHandler = function(e) {
        const dx = e.clientX - x;
        const newLeftWidth = ((leftWidth + dx) * 100) / container.getBoundingClientRect().width;
        if (newLeftWidth > 10 && newLeftWidth < 90) {
            leftSide.style.width = `${newLeftWidth}%`;
            rightSide.style.width = `${100 - newLeftWidth}%`;
            state.splitRatio = newLeftWidth / 100;
        }
    };

    const mouseUpHandler = function() {
        document.body.classList.remove('resizing-active');
        resizer.classList.remove('resizing');
        document.removeEventListener('pointermove', mouseMoveHandler);
        document.removeEventListener('pointerup', mouseUpHandler);
        saveSettings();
        renderMarkersForView('left');
        renderMarkersForView('right');
        ['left', 'right'].forEach(s => renderTextLayer(s));
    };

    resizer.addEventListener('pointerdown', mouseDownHandler);
}

function updateZoomIndicator(side) {
    const percentage = Math.round(state.view[side].scale * 100);
    els[side + 'ZoomLevel'].innerText = percentage + '%';
    renderTextLayer(side);
}

async function clearAllData() {
    if (confirm("Are you sure? This will delete all uploaded PDFs, links, annotations, and chat history permanently.")) {
        await clearDB();
        state.documents = {};
        state.links = [];
        state.annotations = {};
        state.imageCache = {};
        state.embeddings = [];
        state.chats = [];
        state.view.left = { docId: null, pageNum: 1, scale: 1.5, scrollTop: 0 };
        state.view.right = { docId: null, pageNum: 1, scale: 1.5, scrollTop: 0 };
        state.lastActiveSide = 'left';
        
        await createNewChat();
        
        renderDocList();
        renderPage('left');
        renderPage('right');
        els.emptyMsg.style.display = 'block';
        showModal("Success", "All data cleared.");
    }
}
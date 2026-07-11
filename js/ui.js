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

function toggleChatHistory() {
    const drawer = document.getElementById('chat-history-drawer');
    if (drawer) {
        if(drawer.classList.contains('-translate-x-full')) {
            drawer.classList.remove('-translate-x-full');
            drawer.classList.add('translate-x-0');
        } else {
            drawer.classList.add('-translate-x-full');
            drawer.classList.remove('translate-x-0');
        }
    }
}

function closeChatHistory() {
    const drawer = document.getElementById('chat-history-drawer');
    if (drawer) {
        drawer.classList.add('-translate-x-full');
        drawer.classList.remove('translate-x-0');
    }
}

function setAppMode(mode, save = true) {
    state.appMode = mode;
    if (save) saveSettings();

    document.body.classList.remove('linking-mode', 'annotation-mode', 'anno-pen', 'anno-pixel-eraser', 'anno-stroke-eraser', 'anno-select', 'anno-text', 'anno-image', 'delete-link-mode', 'snip-link-mode');

    // Reset all mode buttons
    ['mode-nav-btn','mode-link-btn','mode-snip-link-btn','mode-del-link-btn'].forEach(id => {
        document.getElementById(id)?.classList.remove('active-mode');
    });

    if (mode !== 'snip-link' && typeof cancelSnip === 'function') cancelSnip();

    if (state.linkCreation && state.linkCreation.active) {
        state.linkCreation.active = false;
        state.linkCreation.sourceData = null;
        if (els.currentPath) {
            els.currentPath.style.display = 'none';
            els.currentPath.setAttribute('d', '');
        }
        if (typeof renderMarkersForView === 'function') {
            renderMarkersForView('left');
            renderMarkersForView('right');
        }
    }

    const modeMap = {
        'navigation': 'mode-nav-btn',
        'linking': 'mode-link-btn',
        'snip-link': 'mode-snip-link-btn',
        'delete-link': 'mode-del-link-btn'
    };
    document.getElementById(modeMap[mode])?.classList.add('active-mode');

    if (mode === 'linking') {
        document.body.classList.add('linking-mode');
    } else if (mode === 'snip-link') {
        document.body.classList.add('snip-link-mode');
    } else if (mode === 'delete-link') {
        document.body.classList.add('delete-link-mode');
    } else if (mode === 'annotation') {
        document.body.classList.add('annotation-mode');
        setAnnoTool(state.annoTool, false);
    }
}

function setAnnoTool(tool, save = true) {
    state.annoTool = tool;
    if (save) saveSettings();

    // Switch to annotation mode if not already
    if (state.appMode !== 'annotation') {
        state.appMode = 'annotation';
        document.body.classList.add('annotation-mode');
        document.getElementById('mode-nav-btn')?.classList.remove('active-mode');
    }

    // Reset all tool buttons
    ['tool-select','tool-pen','tool-highlighter','tool-text',
     'tool-eraser-pixel','tool-eraser-stroke','tool-image'].forEach(id => {
        document.getElementById(id)?.classList.remove('active-tool', 'active-highlight');
    });

    // Remove all anno body classes
    document.body.classList.remove('anno-pen','anno-pixel-eraser','anno-stroke-eraser','anno-select','anno-text','anno-highlighter','anno-image');

    // Apply tool settings (color/thickness)
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
            if (thicknessDisplay) thicknessDisplay.innerText = settings.thickness;
        }
    }

    // Activate correct button and body class
    if (tool === 'highlighter') {
        document.getElementById('tool-highlighter')?.classList.add('active-highlight');
        document.body.classList.add('anno-highlighter');
    } else {
        const toolMap = {
            'select':        { btn: 'tool-select',        cls: 'anno-select' },
            'pen':           { btn: 'tool-pen',           cls: 'anno-pen' },
            'text':          { btn: 'tool-text',          cls: 'anno-text' },
            'eraser-pixel':  { btn: 'tool-eraser-pixel',  cls: 'anno-pixel-eraser' },
            'eraser-stroke': { btn: 'tool-eraser-stroke', cls: 'anno-stroke-eraser' },
            'image':         { btn: 'tool-image',         cls: 'anno-image' },
        };
        if (toolMap[tool]) {
            document.getElementById(toolMap[tool].btn)?.classList.add('active-tool');
            document.body.classList.add(toolMap[tool].cls);
        }
    }

    // Show/hide pen customization panel
    const isLineTool = (tool === 'pen' || tool === 'highlighter');
    const penCustomization = document.getElementById('pen-customization');
    const penSep = document.getElementById('pen-customization-sep');
    if (penCustomization) {
        penCustomization.classList.toggle('hidden', !isLineTool);
        penCustomization.classList.toggle('flex', isLineTool);
    }
    if (penSep) {
        penSep.classList.toggle('hidden', !isLineTool);
    }

    // Show/hide line mode button
    const lineModeBtn = document.getElementById('tool-line-mode');
    if (lineModeBtn) lineModeBtn.style.display = isLineTool ? '' : 'none';

    updateThicknessPreview();
}

// ---- Modals ----
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

// ---- AI Settings Panel ----
function openAiSettings() {
    const s = state.aiSettings;
    els.aiSettingModel.value = s.model;
    els.aiSettingPrompt.value = s.systemPrompt;
    els.aiSettingStyle.value = s.responseStyle;
    els.aiSettingTemp.value = s.temperature;
    els.aiSettingTempVal.innerText = s.temperature;
    els.aiSettingStrict.checked = s.strictRag;
    els.aiSettingHistory.checked = s.includeChatHistory !== false; // Default to true if undefined
    els.aiSettingSkipLlm.checked = s.skipLlm || false;
    els.aiSettingSim.value = s.similarityThreshold;
    els.aiSettingSimVal.innerText = s.similarityThreshold;
    els.aiSettingBudget.value = s.contextBudget;
    els.aiSettingMaxChunks.value = s.maxChunks;
    els.aiSettingChunkSize.value = s.chunkSize;
    
    els.aiSettingsModal.classList.remove('hidden');
}

function closeAiSettings() {
    els.aiSettingsModal.classList.add('hidden');
}

async function saveAiSettings() {
    const oldChunkSize = state.aiSettings.chunkSize;
    
    state.aiSettings = {
        model: els.aiSettingModel.value.trim() || "gemma3:1b",
        systemPrompt: els.aiSettingPrompt.value.trim() || "You are a helpful assistant answering questions based on the provided PDF context.",
        responseStyle: els.aiSettingStyle.value,
        temperature: parseFloat(els.aiSettingTemp.value),
        strictRag: els.aiSettingStrict.checked,
        includeChatHistory: els.aiSettingHistory.checked,
        skipLlm: els.aiSettingSkipLlm.checked,
        similarityThreshold: parseFloat(els.aiSettingSim.value),
        contextBudget: parseInt(els.aiSettingBudget.value),
        maxChunks: parseInt(els.aiSettingMaxChunks.value),
        chunkSize: parseInt(els.aiSettingChunkSize.value)
    };

    await saveSettings();
    closeAiSettings();

    // Re-index logic if chunk size changes
    if (oldChunkSize !== state.aiSettings.chunkSize) {
        showModal("Re-indexing Required", "Chunk size changed. Clearing and rebuilding document index...");
        state.embeddings = []; // Clear current embeddings
        indexDocuments(true); // Force re-index with new size
    }
}

function resetAiSettings() {
    if(confirm("Reset all AI settings to default?")) {
        state.aiSettings = {
            model: "gemma3:1b",
            systemPrompt: "You are a helpful assistant answering questions based on the provided PDF context.",
            responseStyle: "Detailed",
            temperature: 0.7,
            strictRag: true,
            includeChatHistory: true,
            skipLlm: false,
            similarityThreshold: 0.65,
            contextBudget: 4000,
            maxChunks: 8,
            chunkSize: 500
        };
        openAiSettings(); // Refresh form values
    }
}

// ---- Layout Resizer ----
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

function toggleLineMode() {
    state.lineMode = state.lineMode === 'freehand' ? 'straight' : 'freehand';
    const btn = document.getElementById('tool-line-mode');
    if (state.lineMode === 'straight') {
        btn.classList.add('bg-blue-50', 'text-blue-600');
        btn.classList.remove('text-gray-500');
        btn.title = 'Straight Line (click to switch to Freehand)';
    } else {
        btn.classList.remove('bg-blue-50', 'text-blue-600');
        btn.classList.add('text-gray-500');
        btn.title = 'Freehand (click to switch to Straight Line)';
    }
    saveSettings();
}

function updateThicknessPreview() {
    const canvas = document.getElementById('thickness-preview-canvas');
    if (!canvas) return;
    canvas.style.cursor = 'pointer';
    canvas.title = 'Click to change color';
    canvas.onclick = () => document.getElementById('color-picker').click();

    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    const isHighlighter = state.annoTool === 'highlighter';
    const thickness = state.annoThickness;

    // Scale dot radius: thickness 1→2px radius, thickness 20→16px radius
    const radius = 2 + (thickness / 20) * 14;

    const color = state.annoColor || '#ef4444';

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);

    if (isHighlighter) {
        // Highlighter: flat semi-transparent rectangle feel
        ctx.clearRect(0, 0, size, size);
        const hw = radius * 2.5;
        const hh = radius * 0.9;
        ctx.fillStyle = hexToRgba(color, 0.45);
        ctx.fillRect(size / 2 - hw / 2, size / 2 - hh / 2, hw, hh);
    } else {
        ctx.fillStyle = color;
        ctx.fill();
    }
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
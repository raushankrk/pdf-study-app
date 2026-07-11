// ==========================================
// 📁 9. annotations.js
// ==========================================

function configureMarked() {
    // Custom renderer for code blocks with highlight.js
    const renderer = new marked.Renderer();

    renderer.code = function(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
        let highlighted;
        try {
            highlighted = hljs.highlight(code, { language }).value;
        } catch (e) {
            highlighted = hljs.highlightAuto(code).value;
        }
        const label = lang
            ? `<span class="code-lang-label">${lang}</span>`
            : '';
        return `<pre>${label}<code class="hljs language-${language}">${highlighted}</code></pre>`;
    };

    marked.setOptions({
        renderer,
        breaks: true,    // single newline = <br>
        gfm: true,       // github flavoured markdown
    });
}

function renderMath(el) {
    if (typeof renderMathInElement === 'undefined') return;
    renderMathInElement(el, {
        delimiters: [
            { left: '$$', right: '$$', display: true  },  // block math
            { left: '$',  right: '$',  display: false },  // inline math
            { left: '\\[', right: '\\]', display: true  },
            { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        errorColor: '#ef4444',
        output: 'html',
    });
}

async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    let side = state.lastActiveSide;
    let startX = 0.35;
    let startY = 0.35;

    if (state.pendingImagePos) {
        side = state.pendingImagePos.side;
        startX = state.pendingImagePos.x;
        startY = state.pendingImagePos.y;
        state.pendingImagePos = null;
    }

    addImageToSide(file, side, startX, startY);
    e.target.value = '';
    
    // Switch to select tool so the user can manipulate the new image instantly
    setAnnoTool('select');
}

async function addImageToSide(fileOrBlob, side, startX = 0.35, startY = 0.35) {
    if (!side || !state.view[side].docId) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const base64 = event.target.result;
        const id = 'img_' + Date.now();
        
        const imgObj = new Image();
        imgObj.src = base64;
        imgObj.onload = () => {
            const canvasWidth = els[side + 'Canvas'].width;
            const newW = 0.3;
            const aspect = imgObj.height / imgObj.width;
            const newH = newW * aspect;

            let x = startX - (newW / 2);
            let y = startY - (newH / 2);
            
            x = Math.max(0, Math.min(1 - newW, x));
            y = Math.max(0, Math.min(1 - newH, y));

            const newImage = {
                id,
                src: base64,
                x: x, 
                y: y,
                w: newW,
                h: newH
            };

            const docId = state.view[side].docId;
            const pageNum = state.view[side].pageNum;
            if (!state.annotations[docId]) state.annotations[docId] = {};
            if (!state.annotations[docId][pageNum]) state.annotations[docId][pageNum] = { strokes: [], images: [], textBoxes: [] };
            
            state.annotations[docId][pageNum].images.push(newImage);
            state.imageCache[id] = imgObj;
            
            clearSelection();
            state.selection = {
                active: true,
                side: side,
                mode: 'idle',
                selectedImages: [newImage],
                selectedTextBoxes: [],
                selectedStrokes: [],
                boundingBox: { x: newImage.x, y: newImage.y, w: newImage.w, h: newImage.h }
            };

            saveAnnotationsToDB(docId, state.annotations[docId]);
            renderAnnotations(side);
        }
    };
    reader.readAsDataURL(fileOrBlob);
}

function handlePaste(e) {
    if (state.appMode !== 'annotation') return;
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            let targetSide = state.lastActiveSide;
            let pasteX = 0.35;
            let pasteY = 0.35;

            const mX = state.globalMouse.x;
            const mY = state.globalMouse.y;
            let mouseSide = null;

            const leftRect = els.leftPanel.getBoundingClientRect();
            const rightRect = els.rightPanel.getBoundingClientRect();

            if (mX >= leftRect.left && mX <= leftRect.right && mY >= leftRect.top && mY <= leftRect.bottom) mouseSide = 'left';
            else if (mX >= rightRect.left && mX <= rightRect.right && mY >= rightRect.top && mY <= rightRect.bottom) mouseSide = 'right';

            if (mouseSide && state.view[mouseSide].docId) {
                targetSide = mouseSide;
                const wrapperRect = els[mouseSide + 'Wrapper'].getBoundingClientRect();
                pasteX = (mX - wrapperRect.left) / wrapperRect.width;
                pasteY = (mY - wrapperRect.top) / wrapperRect.height;
            } else if (!state.view[targetSide] || !state.view[targetSide].docId) {
                const otherSide = targetSide === 'left' ? 'right' : 'left';
                if (state.view[otherSide] && state.view[otherSide].docId) {
                    targetSide = otherSide;
                } else {
                    return; 
                }
            }

            addImageToSide(blob, targetSide, pasteX, pasteY);
            e.preventDefault();
            setAnnoTool('select');
            return;
        }
    }
}

// ------------------------------------------
// SNIP & LINK LOGIC
// ------------------------------------------

function captureSnip(side, x, y, w, h) {
    const canvas = els[side + 'Canvas'];
    
    // Map viewport coordinates to raw canvas pixels
    const pixelX = x * canvas.width;
    const pixelY = y * canvas.height;
    const pixelW = w * canvas.width;
    const pixelH = h * canvas.height;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = pixelW;
    tmpCanvas.height = pixelH;
    const tmpCtx = tmpCanvas.getContext('2d');
    
    // Draw both the PDF canvas and any annotations on top of it into our temporary canvas
    const annoCanvas = els[side + 'AnnoCanvas'];
    
    tmpCtx.drawImage(canvas, pixelX, pixelY, pixelW, pixelH, 0, 0, pixelW, pixelH);
    tmpCtx.drawImage(annoCanvas, pixelX, pixelY, pixelW, pixelH, 0, 0, pixelW, pixelH);

    const base64 = tmpCanvas.toDataURL('image/png');

    state.snip.phase = 'dragging';
    state.snip.base64 = base64;
    state.snip.width = w; 
    state.snip.height = h;
    state.snip.sourceData = {
        docId: state.view[side].docId,
        page: state.view[side].pageNum,
        x: x,
        y: y + (h / 2)
    };

    els.snipPreview.src = base64;
    
    const wrapper = els[side + 'Wrapper'];
    const visualWidth = w * wrapper.offsetWidth;
    const visualHeight = h * wrapper.offsetHeight;

    els.snipPreview.style.width = visualWidth + 'px';
    els.snipPreview.style.height = visualHeight + 'px';
    els.snipPreview.classList.remove('hidden');

    // Attach to mouse immediately
    els.snipPreview.style.left = (state.globalMouse.x - (visualWidth / 2)) + 'px';
    els.snipPreview.style.top = (state.globalMouse.y - (visualHeight / 2)) + 'px';
}

async function dropSnip(side, x, y) {
    const snip = state.snip;
    if (!snip.base64) return cancelSnip();

    const targetDoc = state.view[side].docId;
    const targetPage = state.view[side].pageNum;

    const id = 'img_' + Date.now();
    const linkId = 'link_' + Date.now();

    const imgObj = new Image();
    imgObj.src = snip.base64;

    await new Promise((resolve) => {
        imgObj.onload = () => resolve();
    });

    const aspect = imgObj.height / imgObj.width;
    
    // Use the source width roughly matching to target proportion.
    let newW = snip.width; 
    let newH = newW * aspect;

    const newImage = {
        id,
        src: snip.base64,
        x: x - (newW / 2),
        y: y - (newH / 2),
        w: newW,
        h: newH,
        linkId: linkId
    };

    if (!state.annotations[targetDoc]) state.annotations[targetDoc] = {};
    if (!state.annotations[targetDoc][targetPage]) state.annotations[targetDoc][targetPage] = { strokes: [], images: [], textBoxes: [] };

    state.annotations[targetDoc][targetPage].images.push(newImage);
    state.imageCache[id] = imgObj;
    await saveAnnotationsToDB(targetDoc, state.annotations[targetDoc]);
    
    // Create link directly to dropped image's left-middle edge
    const targetData = {
        docId: targetDoc,
        page: targetPage,
        x: newImage.x,
        y: newImage.y + (newImage.h / 2)
    };

    const newLink = {
        id: linkId,
        source: snip.sourceData,
        target: targetData,
        path: ''
    };

    state.links.push(newLink);
    await saveLinkToDB(newLink);

    renderAnnotations(side);
    renderMarkersForView(state.snip.startSide);
    renderMarkersForView(side);

    // Swap tool state so user can immediately adjust/move the dropped image
    setAppMode('annotation');
    setAnnoTool('select');
    
    clearSelection();
    state.selection = {
        active: true,
        side: side,
        mode: 'idle',
        selectedImages: [newImage],
        selectedTextBoxes: [],
        selectedStrokes: [],
        boundingBox: { x: newImage.x, y: newImage.y, w: newImage.w, h: newImage.h }
    };
    renderAnnotations(side);

    cancelSnip();
}

function cancelSnip() {
    const side = state.snip.startSide;
    state.snip.phase = 'idle';
    state.snip.base64 = null;
    state.snip.startPos = null;
    state.snip.currentPos = null;
    state.snip.startSide = null;
    if (els.snipPreview) {
        els.snipPreview.classList.add('hidden');
        els.snipPreview.src = '';
    }
    if (side) {
        renderAnnotations(side);
    }
}
// ------------------------------------------

function renderTextLayer(side) {
    const wrapper = els[side + 'Wrapper'];

    Array.from(wrapper.querySelectorAll('.text-box-wrapper')).forEach(el => {
        try {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } catch(err) {}
    });

    const viewState = state.view[side];
    const docId = viewState.docId;
    const pageNum = viewState.pageNum;
    const scale = viewState.scale;

    if (!state.annotations[docId] || !state.annotations[docId][pageNum]) return;
    const boxes = state.annotations[docId][pageNum].textBoxes || [];

    boxes.forEach(box => {
        if (box._editing) {
            renderTextBoxEditor(box, side, wrapper, scale);
        } else {
            renderTextBoxMarkdown(box, side, wrapper, scale);
        }
    });
}

function createWrapperEl(box) {
    const wrapper = document.createElement('div');
    wrapper.className = 'text-box-wrapper';
    wrapper.dataset.id = box.id;
    wrapper.style.left     = (box.x * 100) + '%';
    wrapper.style.top      = (box.y * 100) + '%';
    wrapper.style.width    = (box.w * 100) + '%';
    wrapper.style.height   = (box.h * 100) + '%';
    return wrapper;
}

function attachResizeHandles(wrapperEl, box, side) {
    const pageWrapper = els[side + 'Wrapper'];

    const handleE  = document.createElement('div');
    const handleS  = document.createElement('div');
    const handleSE = document.createElement('div');
    handleE.className  = 'resize-handle-e';
    handleS.className  = 'resize-handle-s';
    handleSE.className = 'resize-handle-se';
    wrapperEl.appendChild(handleE);
    wrapperEl.appendChild(handleS);
    wrapperEl.appendChild(handleSE);

    function startResize(e, mode) {
        e.preventDefault();
        e.stopPropagation();
        const startX   = e.clientX;
        const startY   = e.clientY;
        const startW   = box.w;
        const startH   = box.h;
        const pwRect   = pageWrapper.getBoundingClientRect();

        function onMove(e) {
            const dx = (e.clientX - startX) / pwRect.width;
            const dy = (e.clientY - startY) / pwRect.height;
            if (mode === 'e' || mode === 'se') {
                box.w = Math.max(0.08, startW + dx);
                if (box.x + box.w > 1) box.w = 1 - box.x;
                wrapperEl.style.width = (box.w * 100) + '%';
            }
            if (mode === 's' || mode === 'se') {
                box.h = Math.max(0.04, startH + dy);
                if (box.y + box.h > 1) box.h = 1 - box.y;
                wrapperEl.style.height = (box.h * 100) + '%';
            }
        }
        function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            debouncedSaveToDB(side);
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }

    handleE.addEventListener('pointerdown',  e => startResize(e, 'e'));
    handleS.addEventListener('pointerdown',  e => startResize(e, 's'));
    handleSE.addEventListener('pointerdown', e => startResize(e, 'se'));
}

function renderTextBoxEditor(box, side, pageWrapper, scale) {
    const wrapperEl = createWrapperEl(box);

    const textarea = document.createElement('textarea');
    textarea.className = 'text-box-textarea';
    textarea.value = box.content;
    textarea.placeholder = 'Type markdown here...\n**bold**, *italic*, # heading\n$math$, ```code```';
    textarea.style.fontSize = (box.fontSize * scale) + 'px';
    textarea.style.color    = box.color;

    textarea.addEventListener('input', () => {
        box.content = textarea.value;
        debouncedSaveToDB(side);
    });

    textarea.addEventListener('keydown', (e) => {
        // Tab inserts spaces instead of changing focus
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end   = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            box.content = textarea.value;
        }
        // Escape or Ctrl+Enter to finish editing
        if (e.key === 'Escape' || (e.ctrlKey && e.key === 'Enter')) {
            e.preventDefault();
            finishEditing(box, side);
        }
    });

    textarea.addEventListener('blur', (e) => {
        // Only finish if focus went outside the wrapper
        setTimeout(() => {
            if (!wrapperEl.contains(document.activeElement)) {
                finishEditing(box, side);
            }
        }, 100);
    });

    // Prevent global pointer handlers from intercepting clicks inside editor
    wrapperEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
    });
    wrapperEl.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    wrapperEl.appendChild(textarea);
    attachResizeHandles(wrapperEl, box, side);
    pageWrapper.appendChild(wrapperEl);

    // Focus and place cursor at end
    requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
}

function finishEditing(box, side) {
    if (!box._editing) return;
    box._editing = false;
    box.content = box.content || '';

    const docId  = state.view[side].docId;
    const pageNum = state.view[side].pageNum;

    if (!box.content.trim()) {
        const pageData = state.annotations[docId]?.[pageNum];
        if (pageData) {
            const idx = pageData.textBoxes.indexOf(box);
            if (idx > -1) pageData.textBoxes.splice(idx, 1);
            saveAnnotationsToDB(docId, state.annotations[docId]);
        }
    } else {
        debouncedSaveToDB(side);
    }
    setTimeout(() => renderTextLayer(side), 0);
}

function renderMathInElement_safe(el) {
    if (typeof renderMathInElement !== 'undefined') {
        try {
            renderMathInElement(el, {
                delimiters: [
                    { left: '$$', right: '$$', display: true  },
                    { left: '$',  right: '$',  display: false },
                    { left: '\\[', right: '\\]', display: true  },
                    { left: '\\(', right: '\\)', display: false },
                ],
                throwOnError: false,
            });
        } catch(e) {}
    }
}

function renderTextBoxMarkdown(box, side, pageWrapper, scale) {
    const wrapperEl = createWrapperEl(box);

    const inner = document.createElement('div');
    inner.className = 'text-box-rendered-inner';
    inner.style.fontSize = (box.fontSize * scale) + 'px';
    inner.style.color    = box.color;

    if (box.content && box.content.trim()) {
        // Protect math from marked
        let raw = box.content;
        const mathSegments = [];
        let mi = 0;

        raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
            const key = `MATHBLOCK${mi++}END`;
            mathSegments.push({ key, expr, display: true });
            return key;
        });
        raw = raw.replace(/\$([^\n$]+?)\$/g, (_, expr) => {
            const key = `MATHINLINE${mi++}END`;
            mathSegments.push({ key, expr, display: false });
            return key;
        });

        let html = marked.parse(raw);

        mathSegments.forEach(({ key, expr, display }) => {
            let rendered;
            try {
                rendered = katex.renderToString(expr.trim(), {
                    displayMode: display,
                    throwOnError: false,
                    output: 'html',
                });
            } catch(err) {
                rendered = `<span class="math-error">${expr}</span>`;
            }
            html = html.replaceAll(key, rendered);
        });

        inner.innerHTML = html;
    } else {
        inner.innerHTML = '<span style="color:#9ca3af;font-style:italic;font-size:0.85em;">Empty — double-click to edit</span>';
    }

    // Edit hint
    const hint = document.createElement('div');
    hint.className = 'edit-hint';
    hint.textContent = 'Double-click to edit';

    // Single click opens edit mode
    inner.addEventListener('click', (e) => {
        e.stopPropagation();
        box._editing = true;
        setTimeout(() => renderTextLayer(side), 0);
    });

    wrapperEl.appendChild(inner);
    wrapperEl.appendChild(hint);
    attachResizeHandles(wrapperEl, box, side);
    pageWrapper.appendChild(wrapperEl);
}

function debouncedSaveToDB(side) {
    if (dbSaveDebounceMap[side]) clearTimeout(dbSaveDebounceMap[side]);
    dbSaveDebounceMap[side] = setTimeout(() => {
        const docId = state.view[side].docId;
        if (!docId) return;
        const docAnno = state.annotations[docId];
        const clean = {};
        for (const page in docAnno) {
            clean[page] = {
                ...docAnno[page],
                textBoxes: (docAnno[page].textBoxes || []).map(tb => {
                    const { _editing, ...rest } = tb;
                    return rest;
                })
            };
        }
        saveAnnotationsToDB(docId, clean);
    }, 500);
}

function renderAnnotations(side) {
    const viewState = state.view[side];
    const canvas = els[side + 'AnnoCanvas'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const pageData = (state.annotations[viewState.docId] && state.annotations[viewState.docId][viewState.pageNum]) || { strokes: [], images: [], textBoxes: [] };
    
    pageData.images.forEach(img => {
        const imgObj = state.imageCache[img.id];
        if (imgObj) {
            ctx.drawImage(imgObj, img.x * width, img.y * height, img.w * width, img.h * height);
        }
    });

    pageData.strokes.forEach(stroke => {
        drawSmoothPath(ctx, stroke, width, height); 
    });

    if (state.selection.active && state.selection.side === side && state.selection.mode === 'marquee') {
        const start = state.selection.marqueeStart;
        const curr = state.selection.marqueeCurrent;
        const x = Math.min(start.x, curr.x) * width;
        const y = Math.min(start.y, curr.y) * height;
        const w = Math.abs(curr.x - start.x) * width;
        const h = Math.abs(curr.y - start.y) * height;

        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.fillRect(x, y, w, h);
        ctx.setLineDash([]);
    }

    // DRAW RED DOTTED BOX DURING SNIP
    if (state.appMode === 'snip-link' && state.snip.phase === 'drawing' && state.snip.startSide === side && state.snip.startPos && state.snip.currentPos) {
        const start = state.snip.startPos;
        const curr = state.snip.currentPos;
        const x = Math.min(start.x, curr.x) * width;
        const y = Math.min(start.y, curr.y) * height;
        const w = Math.abs(curr.x - start.x) * width;
        const h = Math.abs(curr.y - start.y) * height;

        ctx.strokeStyle = '#ef4444'; // Red
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]); // Dotted/Dashed visual
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(x, y, w, h);
        ctx.setLineDash([]);
    }

    if (state.selection.active && state.selection.side === side && (state.selection.mode === 'idle' || state.selection.mode === 'dragging' || state.selection.mode === 'resizing')) {
        const bbox = state.selection.boundingBox;
        if (bbox) {
            const sx = bbox.x * width;
            const sy = bbox.y * height;
            const sw = bbox.w * width;
            const sh = bbox.h * height;

            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.strokeRect(sx, sy, sw, sh);

            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(sx + sw - 8, sy + sh - 8, 16, 16);
        }
    }
}

function drawSmoothPath(ctx, stroke, width, height) {
    const points = stroke.points;
    if (points.length < 2) return;

    ctx.beginPath();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const isEraser = (stroke.tool === 'eraser-pixel');
    const isHighlighter = (stroke.tool === 'highlighter');

    if (isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = stroke.size * width; 
    } 
    else if (isHighlighter) {
        ctx.globalCompositeOperation = 'multiply'; 
        ctx.globalAlpha = 0.4; 
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.size * width * 3; 
    } 
    else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.size * width; 
    }

    let p0 = points[0];
    ctx.moveTo(p0.x * width, p0.y * height);

    if (points.length === 2) {
        ctx.lineTo(points[1].x * width, points[1].y * height);
    } else {
        for (let i = 1; i < points.length - 1; i++) {
            let p_curr = points[i];
            let p_next = points[i + 1];
            let midX = (p_curr.x + p_next.x) / 2 * width;
            let midY = (p_curr.y + p_next.y) / 2 * height;
            ctx.quadraticCurveTo(p_curr.x * width, p_curr.y * height, midX, midY);
        }
        let last = points[points.length - 1];
        ctx.lineTo(last.x * width, last.y * height);
    }

    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
}

function startAnnotationStroke(side, x, y) {
    const docId = state.view[side].docId;
    const pageNum = state.view[side].pageNum;
    
    if (!state.annotations[docId]) state.annotations[docId] = {};
    if (!state.annotations[docId][pageNum]) state.annotations[docId][pageNum] = { strokes: [], images: [], textBoxes: [] };

    const normalizedSize = state.annoThickness / 1000; 
    
    let sizeMultiplier = 1;
    let compositeOp = 'source-over';
    let alpha = 1.0;

    if (state.annoTool === 'eraser-pixel') {
        compositeOp = 'destination-out';
    } else if (state.annoTool === 'highlighter') {
        compositeOp = 'multiply';
        alpha = 0.4;
        sizeMultiplier = 3; 
    }

    const newStroke = {
        tool: state.annoTool,
        color: state.annoColor,
        size: normalizedSize,
        points: [{ x, y }]
    };

    state.annotations[docId][pageNum].strokes.push(newStroke);
    
    const canvas = els[side + 'AnnoCanvas'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.beginPath();
    ctx.lineCap = 'round';
    
    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = normalizedSize * width * sizeMultiplier; 

    if (state.annoTool !== 'eraser-pixel') {
        ctx.strokeStyle = state.annoColor;
    }
    
    ctx.moveTo(x * width, y * height);
    ctx.lineTo(x * width, y * height);
    ctx.stroke();
    
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
}

function continueAnnotationStroke(side, x, y) {
    const docId = state.view[side].docId;
    const pageNum = state.view[side].pageNum;
    const strokes = state.annotations[docId][pageNum].strokes;
    const currentStroke = strokes[strokes.length - 1];
    
    currentStroke.points.push({ x, y });

    const canvas = els[side + 'AnnoCanvas'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const pts = currentStroke.points;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    let sizeMultiplier = 1;
    let compositeOp = 'source-over';
    let alpha = 1.0;

    if (state.annoTool === 'eraser-pixel') {
        compositeOp = 'destination-out';
    } else if (state.annoTool === 'highlighter') {
        compositeOp = 'multiply';
        alpha = 0.4;
        sizeMultiplier = 3; 
    }

    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = currentStroke.size * width * sizeMultiplier; 

    if (state.annoTool !== 'eraser-pixel') {
        ctx.strokeStyle = currentStroke.color;
    }

    if (pts.length >= 3) {
        const p1 = pts[pts.length - 3];
        const p2 = pts[pts.length - 2];
        const p3 = pts[pts.length - 1];

        const mid1x = (p1.x + p2.x) / 2 * width;
        const mid1y = (p1.y + p2.y) / 2 * height;
        const mid2x = (p2.x + p3.x) / 2 * width;
        const mid2y = (p2.y + p3.y) / 2 * height;

        ctx.beginPath();
        ctx.moveTo(mid1x, mid1y);
        ctx.quadraticCurveTo(p2.x * width, p2.y * height, mid2x, mid2y);
        ctx.stroke();
    } else if (pts.length === 2) {
        const p1 = pts[0];
        const p2 = pts[1];
        ctx.beginPath();
        ctx.moveTo(p1.x * width, p1.y * height);
        ctx.lineTo(p2.x * width, p2.y * height);
        ctx.stroke();
    }
    
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
}

function finishAnnotationStroke(side) {
    const docId = state.view[side].docId;
    saveAnnotationsToDB(docId, state.annotations[docId]);
}

function deleteStrokeAt(side, x, y) {
    const docId = state.view[side].docId;
    const pageNum = state.view[side].pageNum;
    
    if (!state.annotations[docId] || !state.annotations[docId][pageNum]) return;

    const strokes = state.annotations[docId][pageNum].strokes;
    const threshold = 0.0002; 

    let foundIndex = -1;

    for (let i = strokes.length - 1; i >= 0; i--) {
        const stroke = strokes[i];
        if (stroke.tool === 'eraser-pixel') continue;

        for (let j = 0; j < stroke.points.length - 1; j++) {
            const p1 = stroke.points[j];
            const p2 = stroke.points[j+1];
            if (distToSegmentSquared({x, y}, p1, p2) < threshold) {
                foundIndex = i;
                break;
            }
        }
        if (foundIndex !== -1) break;
    }

    if (foundIndex !== -1) {
        strokes.splice(foundIndex, 1);
        renderAnnotations(side);
        return true; 
    }
    return false;
}

function deleteSelection() {
    if (!state.selection.active) return;
    const side = state.selection.side;
    const docId = state.view[side].docId;
    const pageNum = state.view[side].pageNum;
    
    if (!state.annotations[docId] || !state.annotations[docId][pageNum]) return;
    const pageData = state.annotations[docId][pageNum];

    state.selection.selectedImages.forEach(imgObj => {
        const idx = pageData.images.indexOf(imgObj);
        if(idx > -1) {
            pageData.images.splice(idx, 1);
            delete state.imageCache[imgObj.id];
            
            // Auto delete associated link if there is one attached
            if (imgObj.linkId) {
                deleteLink(imgObj.linkId);
            }
        }
    });

    state.selection.selectedTextBoxes.forEach(textBoxObj => {
        const idx = pageData.textBoxes.indexOf(textBoxObj);
        if(idx > -1) {
            pageData.textBoxes.splice(idx, 1);
        }
    });
    saveAnnotationsToDB(state.view[side].docId, state.annotations[state.view[side].docId]);
    setTimeout(() => renderTextLayer(side), 0);


    state.selection.selectedStrokes.forEach(strokeObj => {
        const idx = pageData.strokes.indexOf(strokeObj);
        if(idx > -1) pageData.strokes.splice(idx, 1);
    });

    clearSelection();
    saveAnnotationsToDB(docId, state.annotations[docId]);
    renderAnnotations(side);
    renderTextLayer(side);
}

function clearSelection() {
    state.selection = {
        active: false,
        side: null,
        mode: 'idle',
        marqueeStart: null,
        marqueeCurrent: null,
        selectedImages: [],
        selectedTextBoxes: [],
        selectedStrokes: [],
        boundingBox: null
    };
    ['left', 'right'].forEach(side => {
        const wrapper = els[side + 'Wrapper'];
        wrapper.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    });
}

function undoLastStroke() {
    const docId = state.view.left.docId || state.view.right.docId;
    if (!docId) return;

    const leftPage = state.view.left.pageNum;
    const rightPage = state.view.right.pageNum;
    
    let changed = false;

    const undoOnView = (side, dId, pNum) => {
        const pageData = state.annotations[dId] && state.annotations[dId][pNum];
        if (pageData && pageData.strokes && pageData.strokes.length > 0) {
            pageData.strokes.pop();
            saveAnnotationsToDB(dId, state.annotations[dId]);
            renderAnnotations(side);
            changed = true;
        }
    };

    if (state.view.left.docId === docId) undoOnView('left', docId, leftPage);
    if (state.view.right.docId === docId) undoOnView('right', docId, rightPage);

    if (!changed) {
            if(state.view.left.docId) undoOnView('left', state.view.left.docId, state.view.left.pageNum);
            if(state.view.right.docId) undoOnView('right', state.view.right.docId, state.view.right.pageNum);
    }
}

function clearCurrentPageAnnotations() {
    if(!confirm("Clear all annotations and images on current page(s)?")) return;

    const clearView = (side, dId, pNum) => {
        if (dId && state.annotations[dId]) {
            state.annotations[dId][pNum] = { strokes: [], images: [], textBoxes: [] };
            saveAnnotationsToDB(dId, state.annotations[dId]);
            renderAnnotations(side);
            renderTextLayer(side);
        }
    };
    clearView('left', state.view.left.docId, state.view.left.pageNum);
    clearView('right', state.view.right.docId, state.view.right.pageNum);
}

function attachResizeHandles(el, box, side) {
    const wrapper = els[side + 'Wrapper'];

    const handleE  = document.createElement('div');
    const handleS  = document.createElement('div');
    const handleSE = document.createElement('div');
    handleE.className  = 'resize-handle-e';
    handleS.className  = 'resize-handle-s';
    handleSE.className = 'resize-handle-se';
    el.appendChild(handleE);
    el.appendChild(handleS);
    el.appendChild(handleSE);

    function startResize(e, mode) {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const startW = box.w;
        const startH = box.h;
        const wrapperRect = wrapper.getBoundingClientRect();

        function onMove(e) {
            const dx = (e.clientX - startX) / wrapperRect.width;
            const dy = (e.clientY - startY) / wrapperRect.height;

            if (mode === 'e' || mode === 'se') {
                box.w = Math.max(0.05, startW + dx);
                if (box.x + box.w > 1) box.w = 1 - box.x;
                el.style.width = (box.w * 100) + '%';
            }
            if (mode === 's' || mode === 'se') {
                box.h = Math.max(0.02, startH + dy);
                if (box.y + box.h > 1) box.h = 1 - box.y;
                el.style.minHeight = (box.h * 100) + '%';
                el.style.height    = (box.h * 100) + '%';
            }
        }

        function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            debouncedSaveToDB(side);
            // Use setTimeout to avoid conflict with any blur/focus events
            // that may have already triggered a renderTextLayer call
            setTimeout(() => renderTextLayer(side), 0);
        }

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }

    handleE.addEventListener('pointerdown',  (e) => startResize(e, 'e'));
    handleS.addEventListener('pointerdown',  (e) => startResize(e, 's'));
    handleSE.addEventListener('pointerdown', (e) => startResize(e, 'se'));
}
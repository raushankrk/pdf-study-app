// ==========================================
// 📁 9. annotations.js
// ==========================================

// Diagnostic banner — proves this is the NEW comment-feature code.
// If you don't see this in the browser console, your browser is running
// a cached OLD version. Do a hard refresh (Ctrl+Shift+R) to fix it.
console.log('%c[annotations.js] Comment Feature v9 loaded ✓', 'color:#10b981;font-weight:bold;font-size:13px;');

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
                type: 'image',
                src: base64,
                x: x,
                y: y,
                w: newW,
                h: newH
            };

            const docId = state.view[side].docId;
            const pageId = state.view[side].pageId;
            if (!state.annotations[docId]) state.annotations[docId] = {};
            if (!state.annotations[docId][pageId]) state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] };

            state.annotations[docId][pageId].images.push(newImage);
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

            // Skip REST save when Yjs is connected — Yjs is the source of truth
            // and the server persists Yjs updates to anno_yjs_state automatically.
            if (!(typeof yjsIsConnected === 'function' &&
                  yjsIsConnected(getProjectId(), docId))) {
                saveAnnotationsToDB(docId, state.annotations[docId]);
            }
            renderAnnotations(side);

            // ---- Push unified history entry ----
            // Captures the just-added image so Undo can remove it.
            pushHistoryAction(`image add (${side})`,
                // undo
                () => {
                    const arr = (state.annotations[docId] && state.annotations[docId][pageId] &&
                                  state.annotations[docId][pageId].images) || [];
                    const idx = arr.indexOf(newImage);
                    if (idx !== -1) arr.splice(idx, 1);
                    // Push to Yjs.
                    if (typeof yjsSetAnnotation === 'function' &&
                        typeof yjsIsConnected === 'function' &&
                        yjsIsConnected(getProjectId(), docId)) {
                        yjsSetAnnotation(docId, pageId, id, null);
                    }
                },
                // redo
                () => {
                    const pd = (state.annotations[docId] && state.annotations[docId][pageId]) ||
                        (state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] });
                    if (!pd.images) pd.images = [];
                    if (pd.images.indexOf(newImage) === -1) pd.images.push(newImage);
                    if (!state.imageCache[id]) state.imageCache[id] = imgObj;
                    // Push to Yjs.
                    if (typeof yjsSetAnnotation === 'function' &&
                        typeof yjsIsConnected === 'function' &&
                        yjsIsConnected(getProjectId(), docId)) {
                        yjsSetAnnotation(docId, pageId, id, newImage);
                    }
                }
            );

            // ---- Push to Yjs (so other devices see the new image in real time).
            if (typeof yjsSetAnnotation === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                yjsSetAnnotation(docId, pageId, id, newImage);
            }
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
        pageId: state.view[side].pageId,
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
    const targetPageId = state.view[side].pageId;

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
    if (!state.annotations[targetDoc][targetPageId]) state.annotations[targetDoc][targetPageId] = { strokes: [], images: [], textBoxes: [] };

    state.annotations[targetDoc][targetPageId].images.push(newImage);
    state.imageCache[id] = imgObj;
    // Skip REST save when Yjs is connected.
    if (!(typeof yjsIsConnected === 'function' &&
          yjsIsConnected(getProjectId(), targetDoc))) {
        await saveAnnotationsToDB(targetDoc, state.annotations[targetDoc]);
    }

    // Create link directly to dropped image's left-middle edge
    const targetData = {
        docId: targetDoc,
        pageId: targetPageId,
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

    // ---- Push unified history entry ----
    // The snip creates BOTH an image and a link. Undo removes both; redo
    // restores both. We snapshot the link too so we can restore it exactly.
    const sSide = side;
    const sDocId = targetDoc;
    const sPageId = targetPageId;
    const sImage = newImage;
    const sLink = newLink;
    pushHistoryAction(`snip & link drop (${sSide})`,
        // undo
        () => {
            const pd = state.annotations[sDocId] && state.annotations[sDocId][sPageId];
            if (pd && pd.images) {
                const idx = pd.images.indexOf(sImage);
                if (idx !== -1) pd.images.splice(idx, 1);
            }
            if (sImage.id && state.imageCache[sImage.id]) delete state.imageCache[sImage.id];
            const lIdx = state.links.findIndex(l => l.id === sLink.id);
            if (lIdx !== -1) state.links.splice(lIdx, 1);
            deleteLinkFromDB(sLink.id).catch(() => {});
        },
        // redo
        () => {
            const pd = (state.annotations[sDocId] && state.annotations[sDocId][sPageId]) ||
                (state.annotations[sDocId][sPageId] = { strokes: [], images: [], textBoxes: [] });
            if (!pd.images) pd.images = [];
            if (pd.images.indexOf(sImage) === -1) pd.images.push(sImage);
            if (!state.imageCache[sImage.id]) state.imageCache[sImage.id] = imgObj;
            if (state.links.findIndex(l => l.id === sLink.id) === -1) state.links.push(sLink);
            saveLinkToDB(sLink).catch(() => {});
        }
    );

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

    // Remove any previously rendered text-box wrappers AND comment icons.
    Array.from(wrapper.querySelectorAll('.text-box-wrapper')).forEach(el => {
        try {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } catch(err) {}
    });
    Array.from(wrapper.querySelectorAll('.comment-icon-wrapper')).forEach(el => {
        try {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } catch(err) {}
    });

    const viewState = state.view[side];
    const docId = viewState.docId;
    const pageId = viewState.pageId;
    const scale = viewState.scale;

    if (!state.annotations[docId] || !state.annotations[docId][pageId]) return;
    const boxes = state.annotations[docId][pageId].textBoxes || [];

    // Comments: render only an icon at (x, y). The full markdown is NOT
    // rendered on the PDF — it is shown in the comment sidebar when the
    // user clicks the icon.
    boxes.forEach(box => {
        renderCommentIcon(box, side, wrapper);
    });
}

// ======================================================================
// Comment feature
// ======================================================================
// A "comment" is a `textBox` annotation in the data model (so Yjs sync,
// save/load, undo/redo, project isolation all keep working unchanged), but
// the user-facing behaviour is different from the old in-place markdown box:
//
//   * On the PDF we render only a small comment-icon at (x, y). The full
//     markdown is NEVER rendered on the PDF.
//   * Clicking the icon opens the AI sidebar in one of two modes:
//       - 'split'   : top = rendered preview, bottom = raw markdown editor.
//                     Used when the comment has no content yet (just placed)
//                     or after the user clicks Edit in preview mode.
//       - 'preview' : full-width rendered markdown preview + Edit button.
//                     Used when an existing (non-empty) comment is clicked.
//   * The sidebar reuses the existing #ai-sidebar — when a comment is open,
//     the chat history / input are hidden and the comment editor panel is
//     shown in their place. Closing the comment restores the chat view.
// ======================================================================

// Render the small clickable comment icon at (box.x, box.y) on the PDF.
function renderCommentIcon(box, side, pageWrapper) {
    const icon = document.createElement('div');
    icon.className = 'comment-icon-wrapper';
    icon.dataset.id = box.id;
    icon.dataset.side = side;
    icon.style.left = (box.x * 100) + '%';
    icon.style.top  = (box.y * 100) + '%';

    // Visual state: active = currently shown in the sidebar.
    if (state.activeComment && state.activeComment.id === box.id) {
        icon.classList.add('comment-active');
    }
    // "New" pop animation: only for newly-placed comments, briefly.
    if (box._isNew) {
        icon.classList.add('comment-new');
        // Clear the flag after the animation so re-renders don't keep replaying it.
        setTimeout(() => { box._isNew = false; }, 300);
    }

    // Use a chat-bubble glyph. Empty comments get a hollow variant so the
    // user can tell at a glance which ones still need content.
    const isEmpty = !(box.content && box.content.trim());
    icon.innerHTML = isEmpty
        ? '<i class="fa-regular fa-comment-dots"></i>'
        : '<i class="fa-solid fa-comment-dots"></i>';
    icon.title = isEmpty
        ? 'Empty comment — click to write'
        : 'Click to view comment';

    // Click on the icon → open the comment sidebar in the appropriate mode.
    // We use click (not pointerdown) so the global pointer handlers in events.js
    // don't fight us — the global handler is the one that creates NEW comments
    // when the user clicks empty space in text-tool mode.
    icon.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const mode = (box.content && box.content.trim()) ? 'preview' : 'split';
        openCommentSidebar(box.id, mode, side);
    });

    // Block the global pointerdown from also firing — otherwise clicking the
    // icon in text-tool mode would create ANOTHER new comment on top of it.
    icon.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
    });

    pageWrapper.appendChild(icon);
}

// Find a textbox annotation by id within a given (docId, pageId).
function findCommentBox(docId, pageId, boxId) {
    const pageData = state.annotations[docId]?.[pageId];
    if (!pageData || !pageData.textBoxes) return null;
    return pageData.textBoxes.find(b => b.id === boxId) || null;
}

// Open the comment sidebar for the given comment id.
//   mode = 'split'   → preview (top) + raw editor (bottom)
//   mode = 'preview' → full-width rendered preview + Edit button
function openCommentSidebar(commentId, mode, side) {
    const docId  = state.view[side].docId;
    const pageId = state.view[side].pageId;
    if (!docId || !pageId) return;

    const box = findCommentBox(docId, pageId, commentId);
    if (!box) return;

    state.activeComment = {
        id: commentId,
        side,
        docId,
        pageId,
        mode,
        isNew: false,
    };

    console.log('[openCommentSidebar] Opening overlay sidebar in', mode, 'mode');

    // Show the floating overlay panel + backdrop. We do NOT touch the AI
    // chat sidebar at all — it stays wherever it was (collapsed or open).
    // The comment panel has a higher z-index so it sits on top of everything.
    const backdrop = document.getElementById('comment-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');

    els.commentEditorPanel.classList.remove('hidden');
    els.commentEditorPanel.style.display = 'flex';

    setCommentSidebarMode(mode);

    // Load existing content into the textarea (so the editor always reflects
    // the current box.content even when entering preview mode first).
    els.commentMarkdownInput.value = box.content || '';

    // Render the markdown preview.
    renderCommentPreview();

    // Focus the textarea in split mode so the user can start typing immediately.
    if (mode === 'split') {
        setTimeout(() => els.commentMarkdownInput.focus(), 50);
    }

    // Re-render the comment icons so the active one gets highlighted.
    ['left', 'right'].forEach(s => renderTextLayer(s));
}

// Switch the sidebar between 'split' and 'preview' modes.
function setCommentSidebarMode(mode) {
    if (!state.activeComment) return;
    if (mode !== 'split' && mode !== 'preview') return;
    state.activeComment.mode = mode;

    // Toggle CSS classes on the panel — the CSS rules in style.css handle
    // showing/hiding the editor area vs. the Edit button.
    els.commentEditorPanel.classList.remove('split-mode', 'preview-mode');
    els.commentEditorPanel.classList.add(mode + '-mode');

    if (mode === 'split') {
        els.commentEditorArea.style.display = 'flex';
        els.commentEditButtonArea.style.display = 'none';
        // Re-render the preview so it reflects the latest textarea content.
        renderCommentPreview();
        setTimeout(() => els.commentMarkdownInput.focus(), 50);
    } else {
        els.commentEditorArea.style.display = 'none';
        els.commentEditButtonArea.style.display = 'block';
        renderCommentPreview();
    }
}
window.setCommentSidebarMode = setCommentSidebarMode;

// Render the markdown preview of the currently active comment into
// #comment-preview-area. Uses the same marked + KaTeX pipeline as the old
// text-box rendering so existing markdown (including math, code, tables)
// looks identical to before — just in the sidebar instead of on the PDF.
function renderCommentPreview() {
    if (!state.activeComment) return;
    const box = findCommentBox(state.activeComment.docId, state.activeComment.pageId, state.activeComment.id);
    if (!box) return;

    const target = els.commentPreviewArea;
    target.innerHTML = '';

    if (!box.content || !box.content.trim()) {
        target.innerHTML = '<div class="comment-empty-hint">Nothing to preview yet. Type markdown in the editor below.</div>';
        return;
    }

    // Live preview in split mode: the textarea is the source of truth while
    // the user is actively editing. Read from it directly so the preview
    // updates as they type.
    let raw = (state.activeComment.mode === 'split' && document.activeElement === els.commentMarkdownInput)
        ? els.commentMarkdownInput.value
        : box.content;

    // Protect math segments from marked.
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
            rendered = `<span class="math-error">${escapeHtml(expr)}</span>`;
        }
        html = html.replaceAll(key, rendered);
    });

    target.innerHTML = html;
    if (typeof renderMathInElement === 'function') {
        try {
            renderMathInElement(target, {
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
window.renderCommentPreview = renderCommentPreview;

// Save the markdown from the sidebar textarea into the box.content, then
// persist to the DB / Yjs. After saving, the sidebar switches to preview
// mode (or closes if the content is empty — matches the old finishEditing
// behavior so we don't end up with empty comment icons everywhere).
async function saveCommentFromSidebar() {
    if (!state.activeComment) return;
    const ac = state.activeComment;
    const box = findCommentBox(ac.docId, ac.pageId, ac.id);
    if (!box) return;

    const newContent = els.commentMarkdownInput.value || '';
    box.content = newContent;

    // If the content is empty, remove the comment entirely (same rule as the
    // old finishEditing: empty textboxes don't survive a save).
    if (!newContent.trim()) {
        const pageData = state.annotations[ac.docId]?.[ac.pageId];
        if (pageData) {
            const idx = pageData.textBoxes.indexOf(box);
            if (idx > -1) pageData.textBoxes.splice(idx, 1);
        }
        // Push to Yjs as null so other devices also remove it.
        if (typeof yjsSetAnnotation === 'function' &&
            typeof yjsIsConnected === 'function' &&
            yjsIsConnected(getProjectId(), ac.docId)) {
            yjsSetAnnotation(ac.docId, ac.pageId, ac.id, null);
        }
    } else {
        // Push the updated content to Yjs (if connected) — otherwise save
        // via the REST API.
        if (typeof yjsSetAnnotation === 'function' &&
            typeof yjsIsConnected === 'function' &&
            yjsIsConnected(getProjectId(), ac.docId)) {
            yjsSetAnnotation(ac.docId, ac.pageId, ac.id, box);
        }
        // Always flush REST save too — debouncedSaveToDB skips when Yjs is
        // connected (it assumes Yjs will persist), but we want a defensive
        // save for projects without Yjs collaboration.
        if (!(typeof yjsIsConnected === 'function' && yjsIsConnected(getProjectId(), ac.docId))) {
            await saveAnnotationsToDB(ac.docId, state.annotations[ac.docId]);
        }
    }

    // Re-render the comment icons on the affected viewport.
    renderTextLayer(ac.side);

    // Switch to preview mode (if content was non-empty) so the user can see
    // the rendered result. If empty, close the sidebar entirely.
    if (newContent.trim()) {
        setCommentSidebarMode('preview');
    } else {
        closeCommentSidebar();
    }
}
window.saveCommentFromSidebar = saveCommentFromSidebar;

// Cancel: closes the sidebar without saving. If the comment was just placed
// (state.activeComment.isNew === true) and still has empty content, we remove
// it from the page so we don't leave stray empty comment icons on the PDF.
async function cancelCommentEdit() {
    if (!state.activeComment) { closeCommentSidebar(); return; }
    const ac = state.activeComment;
    const box = findCommentBox(ac.docId, ac.pageId, ac.id);
    if (box && !(box.content && box.content.trim())) {
        // Empty comment — remove it.
        const pageData = state.annotations[ac.docId]?.[ac.pageId];
        if (pageData) {
            const idx = pageData.textBoxes.indexOf(box);
            if (idx > -1) pageData.textBoxes.splice(idx, 1);
        }
        if (typeof yjsSetAnnotation === 'function' &&
            typeof yjsIsConnected === 'function' &&
            yjsIsConnected(getProjectId(), ac.docId)) {
            yjsSetAnnotation(ac.docId, ac.pageId, ac.id, null);
        }
        if (!(typeof yjsIsConnected === 'function' && yjsIsConnected(getProjectId(), ac.docId))) {
            await saveAnnotationsToDB(ac.docId, state.annotations[ac.docId]);
        }
        renderTextLayer(ac.side);
    }
    closeCommentSidebar();
}
window.cancelCommentEdit = cancelCommentEdit;

// Close the comment sidebar and restore the AI chat view.
function closeCommentSidebar() {
    state.activeComment = {
        id: null, side: null, docId: null, pageId: null, mode: null, isNew: false,
    };
    els.commentEditorPanel.classList.add('hidden');
    els.commentEditorPanel.style.display = 'none';
    const backdrop = document.getElementById('comment-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
    // Re-render comment icons so the previously-active one is no longer highlighted.
    ['left', 'right'].forEach(s => renderTextLayer(s));
}
window.closeCommentSidebar = closeCommentSidebar;

// Live-preview hook: called from the textarea's 'input' event so the preview
// updates as the user types in split mode.
function _onCommentInput() {
    if (!state.activeComment || state.activeComment.mode !== 'split') return;
    renderCommentPreview();
}
window._onCommentInput = _onCommentInput;

// Removed legacy in-place editor functions (renderTextBoxEditor, finishEditing,
// renderTextBoxMarkdown, attachResizeHandles, createWrapperEl). The comment
// feature renders only an icon on the PDF; the markdown is shown in the
// sidebar overlay (see openCommentSidebar / setCommentSidebarMode).

// Place a new comment at the given (x, y) on the specified viewport's current
// page. The comment is created with empty content, then the sidebar is opened
// in split mode so the user can type markdown immediately. Saving an empty
// comment (or cancelling the editor) removes the comment from the page.
async function createCommentAt(side, x, y) {
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;
    if (!docId || !pageId) {
        console.warn('[createCommentAt] Aborted: no doc/page loaded on side', side);
        return;
    }
    console.log('[createCommentAt] Placing new comment at', { side, x, y, docId, pageId });

    if (!state.annotations[docId]) state.annotations[docId] = {};
    if (!state.annotations[docId][pageId]) state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] };

    // Clamp coordinates to keep the icon fully on the page.
    x = Math.max(0.02, Math.min(0.98, x));
    y = Math.max(0.02, Math.min(0.98, y));

    const newBox = {
        id: 'tb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type: 'textBox',
        x, y,
        // w/h are kept for backward-compat with the data model and Yjs sync,
        // but the rendered comment icon ignores them (it has a fixed pixel size).
        w: 0.04, h: 0.04,
        content: '',
        color: state.annoColor,
        fontSize: 14,
        _isNew: true,
    };

    state.annotations[docId][pageId].textBoxes.push(newBox);
    console.log('[createCommentAt] Pushed new comment box', newBox.id, '— page now has', state.annotations[docId][pageId].textBoxes.length, 'textBoxes');

    // Persist via REST (skipped when Yjs is the source of truth).
    if (!(typeof yjsIsConnected === 'function' &&
          yjsIsConnected(getProjectId(), docId))) {
        await saveAnnotationsToDB(docId, state.annotations[docId]);
    }

    // Render the new comment icon immediately so the user sees it appear.
    renderTextLayer(side);
    console.log('[createCommentAt] Called renderTextLayer for side', side);

    // ---- Unified history entry — captures the just-added comment so Undo
    // can remove it (and Redo can re-add it). Mirrors the existing text-box
    // history entries so existing undo/redo behavior is preserved.
    pushHistoryAction(`comment add (${side})`,
        // undo
        () => {
            const arr = (state.annotations[docId] && state.annotations[docId][pageId] &&
                          state.annotations[docId][pageId].textBoxes) || [];
            const idx = arr.indexOf(newBox);
            if (idx !== -1) arr.splice(idx, 1);
            if (typeof yjsSetAnnotation === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                yjsSetAnnotation(docId, pageId, newBox.id, null);
            }
            renderTextLayer(side);
        },
        // redo
        () => {
            const pd = (state.annotations[docId] && state.annotations[docId][pageId]) ||
                (state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] });
            if (!pd.textBoxes) pd.textBoxes = [];
            if (pd.textBoxes.indexOf(newBox) === -1) pd.textBoxes.push(newBox);
            if (typeof yjsSetAnnotation === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                yjsSetAnnotation(docId, pageId, newBox.id, newBox);
            }
            renderTextLayer(side);
        }
    );

    // ---- Push to Yjs so other devices see the new comment icon in real time.
    if (typeof yjsSetAnnotation === 'function' &&
        typeof yjsIsConnected === 'function' &&
        yjsIsConnected(getProjectId(), docId)) {
        yjsSetAnnotation(docId, pageId, newBox.id, newBox);
    }

    // Open the sidebar in split mode (preview top + raw editor bottom) so the
    // user can immediately type markdown. The preview is empty until they type.
    openCommentSidebar(newBox.id, 'split', side);
    state.activeComment.isNew = true;
}
window.createCommentAt = createCommentAt;

function debouncedSaveToDB(side) {
    if (dbSaveDebounceMap[side]) clearTimeout(dbSaveDebounceMap[side]);
    dbSaveDebounceMap[side] = setTimeout(() => {
        const docId = state.view[side].docId;
        if (!docId) return;
        // Skip REST save when Yjs is connected — Yjs is the source of truth.
        if (typeof yjsIsConnected === 'function' &&
            yjsIsConnected(getProjectId(), docId)) {
            // Instead, push the modified textboxes to Yjs (their content may
            // have changed).
            if (typeof yjsSetAnnotation === 'function' && state.annotations[docId]) {
                const pageId = state.view[side].pageId;
                const pageData = state.annotations[docId][pageId];
                if (pageData) {
                    (pageData.textBoxes || []).forEach(tb => {
                        if (tb.id) yjsSetAnnotation(docId, pageId, tb.id, tb);
                    });
                }
            }
            return;
        }
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

    const pageData = (state.annotations[viewState.docId] && state.annotations[viewState.docId][viewState.pageId]) || { strokes: [], images: [], textBoxes: [] };
    
    pageData.images.forEach(img => {
        const imgObj = state.imageCache[img.id];
        if (imgObj) {
            ctx.drawImage(imgObj, img.x * width, img.y * height, img.w * width, img.h * height);
        }
    });

    pageData.strokes.forEach(stroke => {
        drawSmoothPath(ctx, stroke, width, height);
    });

    // ---- Yjs: draw lock outlines around annotations other users are editing.
    if (typeof yjsGetLock === 'function') {
        const drawLockBox = (anno, label) => {
            if (!anno || !anno.id) return;
            const lock = yjsGetLock(anno.id);
            if (!lock) return;
            // Compute the bounding box of the annotation in canvas pixels.
            let bx, by, bw, bh;
            if (anno.points && anno.points.length > 0) {
                // It's a stroke — use its bounds.
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                anno.points.forEach(p => {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                });
                bx = minX * width - 4;
                by = minY * height - 4;
                bw = (maxX - minX) * width + 8;
                bh = (maxY - minY) * height + 8;
            } else if (anno.x !== undefined && anno.w !== undefined) {
                // It's an image / textbox — use x/y/w/h.
                bx = anno.x * width - 4;
                by = anno.y * height - 4;
                bw = anno.w * width + 8;
                bh = anno.h * height + 8;
            } else { return; }
            ctx.save();
            ctx.strokeStyle = lock.color || '#f59e0b';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(bx, by, bw, bh);
            ctx.fillStyle = (lock.color || '#f59e0b') + '20'; // ~12% alpha
            ctx.fillRect(bx, by, bw, bh);
            ctx.setLineDash([]);
            // Label with the editor's name.
            if (lock.userName) {
                ctx.fillStyle = lock.color || '#f59e0b';
                const labelW = ctx.measureText(lock.userName).width + 12;
                ctx.fillRect(bx, by - 18, labelW, 16);
                ctx.fillStyle = 'white';
                ctx.font = '11px sans-serif';
                ctx.fillText(lock.userName, bx + 6, by - 6);
            }
            ctx.restore();
        };
        pageData.images.forEach(img => drawLockBox(img));
        pageData.textBoxes.forEach(tb => drawLockBox(tb));
        pageData.strokes.forEach(stk => drawLockBox(stk));
    }

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

            // Selection handle (bottom-right). On touch devices we draw it
            // bigger so fingers can grab it. The handle hit-area in
            // handlePointerDown (events.js) is similarly enlarged.
            //
            // NOTE: iPadOS reports `pointer: fine` (because of Apple Pencil),
            // so `(pointer: coarse)` doesn't match iPad. We use `hover: none`
            // instead — that's the reliable signal for "touch device".
            const isTouch = (window.matchMedia &&
                (window.matchMedia('(hover: none)').matches ||
                 window.matchMedia('(pointer: coarse)').matches));
            const handleSize = isTouch ? 28 : 16;
            ctx.fillStyle = '#3b82f6';
            ctx.fillRect(sx + sw - handleSize/2, sy + sh - handleSize/2, handleSize, handleSize);
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
    const pageId = state.view[side].pageId;

    if (!state.annotations[docId]) state.annotations[docId] = {};
    if (!state.annotations[docId][pageId]) state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] };

    // ---- BUG FIX (Pen/Highlighter tool switching) ----
    // Stamp the tool/color/thickness onto the stroke at creation time.
    // From this point on, the stroke's *own* `tool` field is the source of
    // truth for how it renders — never `state.annoTool`. This guarantees
    // that even if `state.annoTool` changes mid-stroke (e.g. another device
    // pushes a settings update, or the user fat-fingers a keyboard shortcut),
    // the in-progress stroke continues to render with the tool it started
    // with. Each user's selected tool stays local to that user/device; the
    // remote sync layer syncs annotation DATA (which already carries its
    // own `tool` field), not UI state.
    const strokeTool = state.annoTool;
    const strokeColor = state.annoColor;
    const normalizedSize = state.annoThickness / 1000;

    let sizeMultiplier = 1;
    let compositeOp = 'source-over';
    let alpha = 1.0;

    // Decide rendering params from the STROKE'S OWN tool (not state.annoTool).
    // For the very first point these happen to be the same — but writing it
    // this way documents the invariant and keeps the code robust to future
    // changes that might mutate state.annoTool between this function and
    // continueAnnotationStroke.
    if (strokeTool === 'eraser-pixel') {
        compositeOp = 'destination-out';
    } else if (strokeTool === 'highlighter') {
        compositeOp = 'multiply';
        alpha = 0.4;
        sizeMultiplier = 3;
    }

    const newStroke = {
        id: 'stroke_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type: 'stroke',
        tool: strokeTool,
        color: strokeColor,
        size: normalizedSize,
        points: [{ x, y }]
    };

    state.annotations[docId][pageId].strokes.push(newStroke);

    // Save a reference so finishAnnotationStroke can build an undo entry.
    state.drawing.activeStrokeRef = newStroke;
    state.drawing.activeStrokeTool = strokeTool; // defensive: keep a copy in case state.annoTool flips
    // Mark this stroke as "in flight" so Yjs remote updates don't clobber
    // it while the user is drawing.
    if (typeof yjsBeginInFlight === 'function') yjsBeginInFlight(newStroke.id);

    const canvas = els[side + 'AnnoCanvas'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.beginPath();
    ctx.lineCap = 'round';

    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = normalizedSize * width * sizeMultiplier;

    if (strokeTool !== 'eraser-pixel') {
        ctx.strokeStyle = strokeColor;
    }

    ctx.moveTo(x * width, y * height);
    ctx.lineTo(x * width, y * height);
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;

    // ---- Push the initial single-point stroke to Yjs so other devices see
    // the stroke appear immediately. Subsequent points are pushed by
    // continueAnnotationStroke (throttled).
    if (typeof yjsSetAnnotation === 'function' &&
        typeof yjsIsConnected === 'function' &&
        yjsIsConnected(getProjectId(), docId)) {
        yjsSetAnnotation(docId, pageId, newStroke.id, newStroke);
    }
}

function continueAnnotationStroke(side, x, y) {
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;
    const strokes = state.annotations[docId][pageId].strokes;
    const currentStroke = strokes[strokes.length - 1];

    currentStroke.points.push({ x, y });

    const canvas = els[side + 'AnnoCanvas'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const pts = currentStroke.points;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ---- BUG FIX (Pen/Highlighter tool switching) ----
    // Use the STROKE'S OWN `tool` field (currentStroke.tool) — NOT
    // state.annoTool. This is the root-cause fix for the bug where the
    // user selects Pen but drawing produces a Highlighter stroke:
    //
    //   1. User selects Pen → state.annoTool = 'pen'.
    //   2. User starts drawing → stroke created with tool: 'pen'.
    //   3. WHILE the user is still drawing, state.annoTool somehow flips
    //      to 'highlighter' (e.g. another device's settings save echoes
    //      through `revision_changed` → smartRefreshFromServer; or a
    //      stray keyboard shortcut).
    //   4. Old code: continueAnnotationStroke read state.annoTool and
    //      rendered the in-progress stroke as a highlighter (multiply
    //      blend, 3x width, 0.4 alpha). The user saw a fat yellow stroke
    //      instead of a thin red one.
    //   5. New code: continueAnnotationStroke reads currentStroke.tool —
    //      which was stamped at creation time and never changes — so the
    //      in-progress rendering always matches the stroke's intended tool.
    //
    // (For straight-line mode the stroke's `tool` is also already set at
    // startAnnotationStroke time, so this same fix applies.)
    const strokeTool = currentStroke.tool;

    let sizeMultiplier = 1;
    let compositeOp = 'source-over';
    let alpha = 1.0;

    if (strokeTool === 'eraser-pixel') {
        compositeOp = 'destination-out';
    } else if (strokeTool === 'highlighter') {
        compositeOp = 'multiply';
        alpha = 0.4;
        sizeMultiplier = 3;
    }

    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = currentStroke.size * width * sizeMultiplier;

    if (strokeTool !== 'eraser-pixel') {
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

    // ---- Throttled live push to Yjs so other devices see the stroke being
    // drawn in real time. We throttle to ~10 updates/sec so we don't flood
    // the WebSocket with a separate message per pixel.
    if (currentStroke.id) {
        if (!_yjsLivePushThrottle) _yjsLivePushThrottle = {};
        const now = Date.now();
        const last = _yjsLivePushThrottle[currentStroke.id] || 0;
        if (now - last > 100) { // 100ms = 10 updates/sec
            _yjsLivePushThrottle[currentStroke.id] = now;
            if (typeof yjsSetAnnotation === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                yjsSetAnnotation(docId, pageId, currentStroke.id, currentStroke);
            }
        }
    }
}
let _yjsLivePushThrottle = {};

function finishAnnotationStroke(side) {
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;
    // When Yjs is connected, skip the REST save — Yjs is the source of truth,
    // and the server's `anno_yjs_state` table is what persists the data.
    // Calling saveAnnotationsToDB would either trigger the conflict-detection
    // modal (the "manually sync changes" popup the user is seeing) OR clobber
    // the Yjs-merged state with the REST bulk-replace endpoint.
    const yjsConnected = (typeof yjsIsConnected === 'function' &&
                          yjsIsConnected(getProjectId(), docId));
    if (!yjsConnected) {
        saveAnnotationsToDB(docId, state.annotations[docId]);
    }

    // ---- Push unified history entry ----
    // Captures the just-finished stroke so Undo can remove it.
    const strokeRef = state.drawing.activeStrokeRef;
    state.drawing.activeStrokeRef = null;
    // Clear the in-flight marker — the stroke is done, remote updates can
    // now clobber it safely.
    if (strokeRef && typeof yjsEndInFlight === 'function') yjsEndInFlight(strokeRef.id);
    if (strokeRef) {
        const s = side;
        const dId = docId;
        const pId = pageId;
        const findIdx = () => {
            const arr = (state.annotations[dId] && state.annotations[dId][pId] &&
                          state.annotations[dId][pId].strokes) || [];
            return arr.indexOf(strokeRef);
        };
        pushHistoryAction(`${strokeRef.tool || 'stroke'} add (${s})`,
            // undo
            () => {
                const arr = (state.annotations[dId] && state.annotations[dId][pId] &&
                              state.annotations[dId][pId].strokes) || [];
                const idx = arr.indexOf(strokeRef);
                if (idx !== -1) arr.splice(idx, 1);
                if (strokeRef.id && typeof yjsSetAnnotation === 'function' &&
                    typeof yjsIsConnected === 'function' &&
                    yjsIsConnected(getProjectId(), dId)) {
                    yjsSetAnnotation(dId, pId, strokeRef.id, null);
                }
            },
            // redo
            () => {
                const pageData = (state.annotations[dId] && state.annotations[dId][pId]) ||
                    (state.annotations[dId][pId] = { strokes: [], images: [], textBoxes: [] });
                if (!pageData.strokes) pageData.strokes = [];
                if (findIdx() === -1) pageData.strokes.push(strokeRef);
                if (strokeRef.id && typeof yjsSetAnnotation === 'function' &&
                    typeof yjsIsConnected === 'function' &&
                    yjsIsConnected(getProjectId(), dId)) {
                    yjsSetAnnotation(dId, pId, strokeRef.id, strokeRef);
                }
            }
        );

        // ---- Final push to Yjs with the complete stroke (so other devices
        // see the finalized shape even if intermediate throttled pushes
        // were dropped).
        if (yjsConnected) {
            yjsSetAnnotation(docId, pageId, strokeRef.id, strokeRef);
        }
    }
}

function deleteStrokeAt(side, x, y) {
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;

    if (!state.annotations[docId] || !state.annotations[docId][pageId]) return;

    const strokes = state.annotations[docId][pageId].strokes;
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
        const removedStroke = strokes.splice(foundIndex, 1)[0];
        renderAnnotations(side);
        // Push history so the deletion can be undone.
        pushHistoryAction(`stroke delete (${side})`,
            // undo — re-add the stroke at its old index
            () => {
                const arr = (state.annotations[docId] && state.annotations[docId][pageId] &&
                              state.annotations[docId][pageId].strokes) || [];
                if (foundIndex <= arr.length) arr.splice(foundIndex, 0, removedStroke);
                // Push to Yjs (so other devices see the undo).
                if (removedStroke.id && typeof yjsSetAnnotation === 'function' &&
                    typeof yjsIsConnected === 'function' &&
                    yjsIsConnected(getProjectId(), docId)) {
                    yjsSetAnnotation(docId, pageId, removedStroke.id, removedStroke);
                }
            },
            // redo — remove it again
            () => {
                const arr = (state.annotations[docId] && state.annotations[docId][pageId] &&
                              state.annotations[docId][pageId].strokes) || [];
                const idx = arr.indexOf(removedStroke);
                if (idx !== -1) arr.splice(idx, 1);
                else if (foundIndex < arr.length) arr.splice(foundIndex, 1);
                // Push to Yjs (so other devices see the redo).
                if (removedStroke.id && typeof yjsSetAnnotation === 'function' &&
                    typeof yjsIsConnected === 'function' &&
                    yjsIsConnected(getProjectId(), docId)) {
                    yjsSetAnnotation(docId, pageId, removedStroke.id, null);
                }
            }
        );
        // Push to Yjs (so other devices see the delete in real time).
        if (removedStroke.id && typeof yjsSetAnnotation === 'function' &&
            typeof yjsIsConnected === 'function' &&
            yjsIsConnected(getProjectId(), docId)) {
            yjsSetAnnotation(docId, pageId, removedStroke.id, null);
        }
        return true;
    }
    return false;
}

function deleteSelection() {
    if (!state.selection.active) return;
    const side = state.selection.side;
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;

    if (!state.annotations[docId] || !state.annotations[docId][pageId]) return;
    const pageData = state.annotations[docId][pageId];

    // Snapshot what we're about to delete so we can build an undo entry.
    const deletedImages = state.selection.selectedImages.slice();
    const deletedTextBoxes = state.selection.selectedTextBoxes.slice();
    const deletedStrokes = state.selection.selectedStrokes.slice();
    const deletedLinkIds = [];

    state.selection.selectedImages.forEach(imgObj => {
        const idx = pageData.images.indexOf(imgObj);
        if(idx > -1) {
            pageData.images.splice(idx, 1);
            delete state.imageCache[imgObj.id];

            // Auto delete associated link if there is one attached
            if (imgObj.linkId) {
                const linkIdx = state.links.findIndex(l => l.id === imgObj.linkId);
                if (linkIdx !== -1) {
                    deletedLinkIds.push({ link: state.links[linkIdx], idx: linkIdx });
                    state.links.splice(linkIdx, 1);
                    deleteLinkFromDB(imgObj.linkId);
                }
            }
        }
    });

    state.selection.selectedTextBoxes.forEach(textBoxObj => {
        const idx = pageData.textBoxes.indexOf(textBoxObj);
        if(idx > -1) {
            pageData.textBoxes.splice(idx, 1);
        }
    });
    // Skip REST save when Yjs is connected.
    if (!(typeof yjsIsConnected === 'function' &&
          yjsIsConnected(getProjectId(), state.view[side].docId))) {
        saveAnnotationsToDB(state.view[side].docId, state.annotations[state.view[side].docId]);
    }
    setTimeout(() => renderTextLayer(side), 0);


    state.selection.selectedStrokes.forEach(strokeObj => {
        const idx = pageData.strokes.indexOf(strokeObj);
        if(idx > -1) pageData.strokes.splice(idx, 1);
    });

    // ---- Push unified history entry ----
    if (deletedImages.length || deletedTextBoxes.length || deletedStrokes.length || deletedLinkIds.length) {
        const dId = docId, pId = pageId, s = side;
        pushHistoryAction(
            `delete selection (${s}: ${deletedImages.length}i ${deletedTextBoxes.length}t ${deletedStrokes.length}s)`,
            // undo — re-add everything
            () => {
                const pd = (state.annotations[dId] && state.annotations[dId][pId]) ||
                    (state.annotations[dId][pId] = { strokes: [], images: [], textBoxes: [] });
                if (!pd.images) pd.images = [];
                if (!pd.textBoxes) pd.textBoxes = [];
                if (!pd.strokes) pd.strokes = [];
                deletedImages.forEach(img => {
                    if (pd.images.indexOf(img) === -1) pd.images.push(img);
                    if (img.id && !state.imageCache[img.id]) {
                        const imageObj = new Image();
                        imageObj.src = img.src;
                        state.imageCache[img.id] = imageObj;
                    }
                });
                deletedTextBoxes.forEach(tb => {
                    if (pd.textBoxes.indexOf(tb) === -1) pd.textBoxes.push(tb);
                });
                deletedStrokes.forEach(stk => {
                    if (pd.strokes.indexOf(stk) === -1) pd.strokes.push(stk);
                });
                // Restore links in their original positions (descending order so
                // indices stay valid).
                deletedLinkIds.slice().reverse().forEach(({ link, idx }) => {
                    state.links.splice(idx, 0, link);
                });
                if (deletedLinkIds.length) {
                    // Re-save links that were deleted. (Best-effort — if the
                    // server is unreachable the next save cycle will retry.)
                    deletedLinkIds.forEach(({ link }) => saveLinkToDB(link).catch(() => {}));
                    if (typeof renderMarkersForView === 'function') {
                        renderMarkersForView('left');
                        renderMarkersForView('right');
                    }
                }
            },
            // redo — delete them again
            () => {
                const pd = state.annotations[dId] && state.annotations[dId][pId];
                if (!pd) return;
                deletedImages.forEach(img => {
                    const idx = pd.images.indexOf(img);
                    if (idx !== -1) pd.images.splice(idx, 1);
                    if (img.id && state.imageCache[img.id]) delete state.imageCache[img.id];
                });
                deletedTextBoxes.forEach(tb => {
                    const idx = pd.textBoxes.indexOf(tb);
                    if (idx !== -1) pd.textBoxes.splice(idx, 1);
                });
                deletedStrokes.forEach(stk => {
                    const idx = pd.strokes.indexOf(stk);
                    if (idx !== -1) pd.strokes.splice(idx, 1);
                });
                deletedLinkIds.forEach(({ link }) => {
                    const idx = state.links.findIndex(l => l.id === link.id);
                    if (idx !== -1) state.links.splice(idx, 1);
                    deleteLinkFromDB(link.id).catch(() => {});
                });
                if (deletedLinkIds.length && typeof renderMarkersForView === 'function') {
                    renderMarkersForView('left');
                    renderMarkersForView('right');
                }
            }
        );
    }

    clearSelection();
    // Skip REST save when Yjs is connected.
    if (!(typeof yjsIsConnected === 'function' &&
          yjsIsConnected(getProjectId(), docId))) {
        saveAnnotationsToDB(docId, state.annotations[docId]);
    }
    renderAnnotations(side);
    renderTextLayer(side);

    // ---- Push the deletions to Yjs (so other devices see them in real time).
    if (typeof yjsSetAnnotation === 'function' &&
        typeof yjsIsConnected === 'function' &&
        yjsIsConnected(getProjectId(), docId)) {
        deletedImages.forEach(img => {
            if (img.id) yjsSetAnnotation(docId, pageId, img.id, null);
        });
        deletedTextBoxes.forEach(tb => {
            if (tb.id) yjsSetAnnotation(docId, pageId, tb.id, null);
        });
        deletedStrokes.forEach(stk => {
            if (stk.id) yjsSetAnnotation(docId, pageId, stk.id, null);
        });
    }
}

function clearSelection() {
    // ---- BUG FIX (Annotation movement rendering) ----
    // Defensive: when the selection is cleared (e.g. user presses Esc, or
    // starts a new marquee, or switches tools), end any in-flight markers
    // we may have set on the previously-selected annotations. Otherwise
    // those annotations would stay "in flight" forever, blocking remote
    // updates from clobbering them — even though no one is editing them
    // anymore.
    if (typeof yjsEndInFlight === 'function') {
        if (state.selection) {
            (state.selection.selectedImages || []).forEach(img => img && img.id && yjsEndInFlight(img.id));
            (state.selection.selectedTextBoxes || []).forEach(tb => tb && tb.id && yjsEndInFlight(tb.id));
            (state.selection.selectedStrokes || []).forEach(stk => stk && stk.id && yjsEndInFlight(stk.id));
        }
    }
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

    const leftPageId = state.view.left.pageId;
    const rightPageId = state.view.right.pageId;
    
    let changed = false;

    const undoOnView = (side, dId, pId) => {
        const pageData = state.annotations[dId] && state.annotations[dId][pId];
        if (pageData && pageData.strokes && pageData.strokes.length > 0) {
            pageData.strokes.pop();
            saveAnnotationsToDB(dId, state.annotations[dId]);
            renderAnnotations(side);
            changed = true;
        }
    };

    if (state.view.left.docId === docId) undoOnView('left', docId, leftPageId);
    if (state.view.right.docId === docId) undoOnView('right', docId, rightPageId);

    if (!changed) {
            if(state.view.left.docId) undoOnView('left', state.view.left.docId, state.view.left.pageId);
            if(state.view.right.docId) undoOnView('right', state.view.right.docId, state.view.right.pageId);
    }
}

function clearCurrentPageAnnotations() {
    if(!confirm("Clear all annotations and images on current page(s)?")) return;

    const clearView = (side, dId, pId) => {
        if (dId && state.annotations[dId]) {
            const snapshot = state.annotations[dId][pId] ?
                JSON.parse(JSON.stringify(state.annotations[dId][pId])) :
                null;
            state.annotations[dId][pId] = { strokes: [], images: [], textBoxes: [] };
            // Skip REST save when Yjs is connected.
            if (!(typeof yjsIsConnected === 'function' &&
                  yjsIsConnected(getProjectId(), dId))) {
                saveAnnotationsToDB(dId, state.annotations[dId]);
            }
            renderAnnotations(side);
            renderTextLayer(side);
            if (snapshot) {
                pushHistoryAction(`clear page (${side})`,
                    () => {
                        state.annotations[dId][pId] = JSON.parse(JSON.stringify(snapshot));
                        if (snapshot.images) {
                            snapshot.images.forEach(img => {
                                if (!state.imageCache[img.id]) {
                                    const imageObj = new Image();
                                    imageObj.src = img.src;
                                    state.imageCache[img.id] = imageObj;
                                }
                            });
                        }
                        if (typeof yjsReplacePage === 'function' &&
                            typeof yjsIsConnected === 'function' &&
                            yjsIsConnected(getProjectId(), dId)) {
                            yjsReplacePage(dId, pId, snapshot);
                        }
                    },
                    () => {
                        state.annotations[dId][pId] = { strokes: [], images: [], textBoxes: [] };
                        if (typeof yjsClearPage === 'function' &&
                            typeof yjsIsConnected === 'function' &&
                            yjsIsConnected(getProjectId(), dId)) {
                            yjsClearPage(dId, pId);
                        }
                    }
                );
            }
            if (typeof yjsClearPage === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), dId)) {
                yjsClearPage(dId, pId);
            }
        }
    };
    clearView('left', state.view.left.docId, state.view.left.pageId);
    clearView('right', state.view.right.docId, state.view.right.pageId);
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
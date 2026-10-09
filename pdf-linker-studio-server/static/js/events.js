// ==========================================
// 📁 11. events.js
// ==========================================

// Diagnostic banner — proves this is the NEW comment-feature code.
console.log('%c[events.js] Comment Feature v9 loaded ✓', 'color:#10b981;font-weight:bold;font-size:13px;');

function getMousePosInViewport(evt, side) {
    const rect = els[side + 'Wrapper'].getBoundingClientRect();
    return {
        x: (evt.clientX - rect.left) / rect.width, 
        y: (evt.clientY - rect.top) / rect.height
    };
}

function handlePointerDown(e) {
    // ---- Comment overlay guards (CRITICAL) ----
    // 1. If the pointer landed inside the comment overlay panel or its
    //    backdrop, bail out immediately — we don't want to create a new
    //    comment, start a marquee selection, or do anything else. The
    //    overlay has its own click/keyboard handlers.
    if (e.target.closest('#comment-editor-panel') || e.target.closest('#comment-backdrop')) return;

    // 2. If the comment overlay is currently OPEN, don't start any new
    //    annotation/comment action on the PDF. The user should close the
    //    overlay first (by clicking the backdrop, pressing Esc, or clicking
    //    the X button). This prevents accidental comment creation when the
    //    user taps outside the overlay but the tap lands on the PDF behind
    //    the dimmed backdrop.
    if (state.activeComment && state.activeComment.id) return;

    // 3. Standard early-return guards — now also includes TEXTAREA so that
    //    tapping the markdown editor on touch devices doesn't trigger
    //    comment creation. Without this, the pointerdown event bubbles up
    //    from the textarea to window, handlePointerDown runs, sees the
    //    click is in the right-panel area, and creates a new comment —
    //    stealing focus from the textarea and making typing impossible.
    if (e.target.closest('#vertical-resizer') ||
        e.target.closest('button') ||
        e.target.closest('input') ||
        e.target.closest('textarea') ||
        e.target.closest('[contenteditable]') ||
        e.target.closest('.comment-icon-wrapper')) return;

    // Two-finger gesture (pan/zoom) is active — don't start any drawing/annotation.
    // The touch-based two-finger handler sets _twoFingerState before the second
    // pointerdown fires (touchstart fires before pointerdown per spec).
    if (_twoFingerState) return;

    const leftPanelRect = els.leftPanel.getBoundingClientRect();
    const rightPanelRect = els.rightPanel.getBoundingClientRect();
    let clickedSide = null;

    if (e.clientX >= leftPanelRect.left && e.clientX <= leftPanelRect.right &&
        e.clientY >= leftPanelRect.top && e.clientY <= leftPanelRect.bottom) {
        clickedSide = 'left';
    }
    else if (e.clientX >= rightPanelRect.left && e.clientX <= rightPanelRect.right &&
                e.clientY >= rightPanelRect.top && e.clientY <= rightPanelRect.bottom) {
        clickedSide = 'right';
    }

    if (clickedSide && state.view[clickedSide].docId) {
        state.lastActiveSide = clickedSide;
        updateViewportActiveVisuals();
    }

    // ---- CRITICAL for iPad/touch devices ----
    // In annotation, linking, snip-link, or delete-link modes, we MUST call
    // preventDefault() on the pointer event BEFORE the browser starts its
    // default touch behavior (text selection, long-press callout menu, double-
    // tap zoom, etc.). Without this, iPad Safari/Chrome will select the PDF
    // page text or show the iOS callout menu when the user touches and holds.
    //
    // We only do this when the pointer is inside a viewport AND we're in a
    // drawing/editing mode — in navigation mode we want the browser's default
    // scroll/pan behavior.
    if (clickedSide && state.appMode !== 'navigation') {
        e.preventDefault();
    }
    // Also prevent default for touch events in navigation mode if the target
    // is the PDF canvas (not the text layer or viewport scroll area).
    // This stops the iPad from selecting the canvas element itself.
    if (e.pointerType === 'touch' && e.target.classList.contains('pdf-canvas')) {
        e.preventDefault();
    }

    if (e.target.closest('.link-marker')) {
        if (state.appMode === 'delete-link') {
            e.preventDefault();
            e.stopPropagation();
            const markerEl = e.target.closest('.link-marker');
            const linkId = markerEl.dataset.linkId;
            if (linkId) deleteLink(linkId);
            return;
        }
        return;
    }

    e.target.setPointerCapture(e.pointerId);

    if (state.appMode === 'navigation') {
        const textLayer = e.target.closest('.textLayer');
        if (textLayer) {
            return;
        }
    }

    // SNIP & LINK LOGIC
    if (state.appMode === 'snip-link') {
        if (state.snip.phase === 'idle' && clickedSide && state.view[clickedSide].docId) {
            state.snip.phase = 'drawing';
            state.snip.startSide = clickedSide;
            const pos = getMousePosInViewport(e, clickedSide);
            state.snip.startPos = pos;
            state.snip.currentPos = pos;
            state.drawing.active = true;
            state.drawing.pointerId = e.pointerId;
            
            // Note: Visual rendering handled now by renderAnnotations in js/annotations.js
        } else if (state.snip.phase === 'dragging') {
            if (clickedSide && clickedSide !== state.snip.startSide && state.view[clickedSide].docId) {
                const pos = getMousePosInViewport(e, clickedSide);
                dropSnip(clickedSide, pos.x, pos.y);
            } else {
                cancelSnip();
            }
        }
        return;
    }

    if (!clickedSide) return;
    if (!state.view[clickedSide].docId) return;

    if (state.appMode === 'linking') {
        const pos = getMousePosInViewport(e, clickedSide);
        if (!state.linkCreation.active) {
            // First click: Set Start
            state.linkCreation.active = true;
            state.linkCreation.sourceData = {
                docId: state.view[clickedSide].docId,
                pageId: state.view[clickedSide].pageId,
                x: pos.x, y: pos.y
            };
            state.linkCreation.sourceSide = clickedSide;
            renderMarkersForView(clickedSide);
            els.currentPath.style.display = 'block';
        } else {
            // Second click: Set Target
            const targetData = {
                docId: state.view[clickedSide].docId,
                pageId: state.view[clickedSide].pageId,
                x: pos.x, y: pos.y
            };

            const newLink = {
                id: 'link_' + Date.now(),
                source: state.linkCreation.sourceData,
                target: targetData,
                path: ''
            };

            state.links.push(newLink);
            saveLinkToDB(newLink);

            // Push history so the link creation can be undone.
            pushHistoryAction(`link add (${clickedSide})`,
                () => {
                    const idx = state.links.findIndex(l => l.id === newLink.id);
                    if (idx !== -1) state.links.splice(idx, 1);
                    deleteLinkFromDB(newLink.id).catch(() => {});
                    if (typeof renderMarkersForView === 'function') {
                        renderMarkersForView('left');
                        renderMarkersForView('right');
                    }
                },
                () => {
                    if (state.links.findIndex(l => l.id === newLink.id) === -1) {
                        state.links.push(newLink);
                    }
                    saveLinkToDB(newLink).catch(() => {});
                    if (typeof renderMarkersForView === 'function') {
                        renderMarkersForView('left');
                        renderMarkersForView('right');
                    }
                }
            );

            state.linkCreation.active = false;
            state.linkCreation.sourceData = null;
            els.currentPath.style.display = 'none';
            els.currentPath.setAttribute('d', '');

            renderMarkersForView('left');
            renderMarkersForView('right');
        }
        return; // Prevent passing to drawing/annotation logic
    }
    else if (state.appMode === 'annotation') {
        state.drawing.active = true;
        state.drawing.pointerId = e.pointerId;
        state.drawing.startSide = clickedSide;

        if (state.annoTool === 'image') {
            const pos = getMousePosInViewport(e, clickedSide);
            state.pendingImagePos = { side: clickedSide, x: pos.x, y: pos.y };
            els.imageInput.click();
            state.drawing.active = false;
            return;
        }

        if (state.annoTool === 'select') {
            const pos = getMousePosInViewport(e, clickedSide);
            const pageData = state.annotations[state.view[clickedSide].docId]?.[state.view[clickedSide].pageId];
            let actionTaken = false;

            if (state.selection.active && state.selection.side === clickedSide) {
                const bbox = state.selection.boundingBox;
                // Hit area for the resize handle. Bigger on touch devices so
                // fingers can actually grab it (Apple HIG recommends 44px).
                //
                // NOTE: iPadOS reports `pointer: fine` (because of Apple
                // Pencil), so `(pointer: coarse)` doesn't match iPad. We use
                // `hover: none` instead — that's the reliable signal for a
                // touch-primary device.
                const isTouch = (window.matchMedia &&
                    (window.matchMedia('(hover: none)').matches ||
                     window.matchMedia('(pointer: coarse)').matches));
                const handleSize = isTouch ? 0.05 : 0.02;
                const right = bbox.x + bbox.w;
                const bottom = bbox.y + bbox.h;

                if (pos.x >= right - handleSize && pos.x <= right + handleSize &&
                    pos.y >= bottom - handleSize && pos.y <= bottom + handleSize) {
                    state.selection.mode = 'resizing';
                    state.selection.dragStartMouse = { x: pos.x, y: pos.y };
                    state.selection.dragStartPositions = {
                        bbox: { ...bbox },
                        images: state.selection.selectedImages.map(img => ({ ...img })),
                        strokes: state.selection.selectedStrokes.map(stk => ({ points: stk.points.map(p => ({...p})) })),
                        textBoxes: state.selection.selectedTextBoxes.map(tb => ({ ...tb }))
                    };
                    actionTaken = true;
                    // ---- Yjs: claim edit locks on the selected annotations
                    // so other users see we're resizing them.
                    if (typeof yjsClaimLock === 'function') {
                        state.selection.selectedImages.forEach(img => img.id && yjsClaimLock(img.id, 'resize'));
                        state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsClaimLock(tb.id, 'resize'));
                        state.selection.selectedStrokes.forEach(stk => stk.id && yjsClaimLock(stk.id, 'resize'));
                    }
                    // ---- BUG FIX (Annotation movement rendering) ----
                    // Mark these annotations as IN-FLIGHT so a Yjs remote
                    // update arriving mid-resize doesn't replace the local
                    // objects with clones (which would break our selected
                    // object references and cause the visible object to
                    // stay at its old position while the selection
                    // bounding box moves).
                    if (typeof yjsBeginInFlight === 'function') {
                        state.selection.selectedImages.forEach(img => img.id && yjsBeginInFlight(img.id));
                        state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsBeginInFlight(tb.id));
                        state.selection.selectedStrokes.forEach(stk => stk.id && yjsBeginInFlight(stk.id));
                    }
                }
                else if (pos.x >= bbox.x && pos.x <= bbox.x + bbox.w &&
                            pos.y >= bbox.y && pos.y <= bbox.y + bbox.h) {
                    state.selection.mode = 'dragging';
                    state.selection.dragStartMouse = { x: pos.x, y: pos.y };
                    actionTaken = true;
                    // ---- Yjs: claim edit locks on the selected annotations
                    // so other users see we're moving them.
                    if (typeof yjsClaimLock === 'function') {
                        state.selection.selectedImages.forEach(img => img.id && yjsClaimLock(img.id, 'move'));
                        state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsClaimLock(tb.id, 'move'));
                        state.selection.selectedStrokes.forEach(stk => stk.id && yjsClaimLock(stk.id, 'move'));
                    }
                    // ---- BUG FIX (Annotation movement rendering) ----
                    // Same in-flight protection as for resizing above.
                    if (typeof yjsBeginInFlight === 'function') {
                        state.selection.selectedImages.forEach(img => img.id && yjsBeginInFlight(img.id));
                        state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsBeginInFlight(tb.id));
                        state.selection.selectedStrokes.forEach(stk => stk.id && yjsBeginInFlight(stk.id));
                    }
                }
            }

            if (!actionTaken && pageData) {
                if (pageData.images) {
                    for (let i = pageData.images.length - 1; i >= 0; i--) {
                        const img = pageData.images[i];
                        if (pos.x >= img.x && pos.x <= img.x + img.w &&
                            pos.y >= img.y && pos.y <= img.y + img.h) {
                            clearSelection();
                            state.selection = {
                                active: true, side: clickedSide, mode: 'dragging',
                                selectedImages: [img],
                                selectedTextBoxes: [],
                                selectedStrokes: [],
                                boundingBox: { x: img.x, y: img.y, w: img.w, h: img.h },
                                dragStartMouse: { x: pos.x, y: pos.y }
                            };
                            actionTaken = true;
                            // ---- BUG FIX (Annotation movement rendering) ----
                            // Mark as in-flight so a remote Yjs update
                            // arriving mid-drag doesn't replace this image
                            // with a clone (which would leave our selection
                            // reference pointing at an orphan).
                            if (typeof yjsBeginInFlight === 'function' && img.id) {
                                yjsBeginInFlight(img.id);
                            }
                            renderAnnotations(clickedSide);
                            renderTextLayer(clickedSide);
                            break;
                        }
                    }
                }
                if (!actionTaken && pageData.textBoxes) {
                    for (let i = pageData.textBoxes.length - 1; i >= 0; i--) {
                        const tb = pageData.textBoxes[i];
                        if (pos.x >= tb.x && pos.x <= tb.x + tb.w &&
                            pos.y >= tb.y && pos.y <= tb.y + tb.h) {

                            // If clicking an already-editing box, let textarea handle it natively
                            if (tb._editing) {
                                actionTaken = true;
                                break;
                            }
                            clearSelection();
                            state.selection = {
                                active: true, side: clickedSide, mode: 'dragging',
                                selectedImages: [],
                                selectedTextBoxes: [tb],
                                selectedStrokes: [],
                                boundingBox: { x: tb.x, y: tb.y, w: tb.w, h: tb.h },
                                dragStartMouse: { x: pos.x, y: pos.y }
                            };
                            actionTaken = true;
                            // ---- BUG FIX (Annotation movement rendering) ----
                            // Same in-flight protection as for images above.
                            if (typeof yjsBeginInFlight === 'function' && tb.id) {
                                yjsBeginInFlight(tb.id);
                            }
                            renderAnnotations(clickedSide);
                            setTimeout(() => renderTextLayer(clickedSide), 0);
                            break;
                        }
                    }
                }
            }

            if (!actionTaken) {
                clearSelection();
                state.selection = {
                    active: true,
                    side: clickedSide,
                    mode: 'marquee',
                    marqueeStart: pos,
                    marqueeCurrent: pos
                };
            }
            
            renderAnnotations(clickedSide);
        } else if (state.annoTool === 'text') {
            const pos = getMousePosInViewport(e, clickedSide);
            state.drawing.startPointData = { x: pos.x, y: pos.y };
            // New behaviour: clicking with the text tool places a comment icon
            // at that point. We don't drag-rect anymore — the comment is
            // created on pointerup at the original click position.
            state.drawing.mode = 'comment-create';
            console.log('[events.js] text-tool pointer-down at', pos, '— will create comment on pointer-up');
        }
        else if (e.pointerType === 'pen' || e.button === 0) {
                if (state.annoTool === 'eraser-stroke') {
                state.drawing.startSide = clickedSide;
            } else {
                const pos = getMousePosInViewport(e, clickedSide);
                state.drawing.straightLineStart = { x: pos.x, y: pos.y };
                startAnnotationStroke(clickedSide, pos.x, pos.y);
            }
        }
    }
}

function startDirectTextManipulation(e, domElement, type) {
    const side = state.lastActiveSide;
    const wrapper = els[side + 'Wrapper'];
    const docId = state.view[side].docId;
    const pageId = state.view[side].pageId;
    
    if (!state.annotations[docId] || !state.annotations[docId][pageId]) return;
    const pageData = state.annotations[docId][pageId];
    const box = pageData.textBoxes.find(b => b.id === domElement.dataset.id);
    if (!box) return;

    state.drawing.active = true;
    state.drawing.pointerId = e.pointerId;
    state.drawing.mode = type === 'move' ? 'text-move' : 'text-resize';
    state.drawing.activeTextBox = box;
    state.drawing.activeSide = side;

    const rect = wrapper.getBoundingClientRect();
    state.drawing.startPoint = {
        x: box.x, y: box.y, w: box.w, h: box.h
    };
    state.drawing.startMouse = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

function handlePointerMove(e) {
    state.globalMouse = { x: e.clientX, y: e.clientY };

    const cursorEl = document.getElementById('tool-cursor');
    const cursorIcon = document.getElementById('tool-cursor-icon');
    
    const isInsideViewport = e.target.closest('#left-canvas-wrapper') || e.target.closest('#right-canvas-wrapper');
    
    const showCustomCursor = (
        state.appMode === 'annotation' && 
        isInsideViewport &&
        ['pen', 'highlighter', 'eraser-pixel', 'eraser-stroke', 'image'].includes(state.annoTool)
    );

    if (showCustomCursor) {
        document.body.classList.add('cursor-none');
        cursorEl.classList.remove('hidden');
        cursorEl.style.left = e.clientX + 'px';
        cursorEl.style.top = e.clientY + 'px';

        cursorEl.className = 'fixed pointer-events-none z-[100] flex items-center justify-center';
        cursorIcon.className = 'fa-solid';

        if (state.annoTool === 'pen') {
            cursorIcon.classList.add('fa-pen');
            cursorEl.classList.add('mode-pen');
        } 
        else if (state.annoTool === 'highlighter') {
            cursorIcon.classList.add('fa-highlighter');
            cursorEl.classList.add('mode-highlighter');
        } 
        else if (state.annoTool === 'eraser-pixel' || state.annoTool === 'eraser-stroke') {
            cursorIcon.classList.add('fa-eraser');
            cursorEl.classList.add('mode-eraser');
        }
        else if (state.annoTool === 'image') {
            cursorIcon.className = 'fa-regular fa-image';
            cursorEl.classList.add('mode-image');
        }
    } 
    else {
        document.body.classList.remove('cursor-none');
        cursorEl.classList.add('hidden');
    }

    // SNIP & LINK LOGIC - DRAG
    if (state.appMode === 'snip-link') {
        if (state.snip.phase === 'drawing' && state.drawing.active && state.drawing.pointerId === e.pointerId) {
            const side = state.snip.startSide;
            state.snip.currentPos = getMousePosInViewport(e, side);
            renderAnnotations(side);
        } else if (state.snip.phase === 'dragging') {
            els.snipPreview.style.left = (e.clientX - (els.snipPreview.offsetWidth / 2)) + 'px';
            els.snipPreview.style.top = (e.clientY - (els.snipPreview.offsetHeight / 2)) + 'px';
        }
        return;
    }

    if (!state.drawing.active) return;
    if (state.drawing.pointerId !== e.pointerId) return;

    const side = state.drawing.startSide;
    if (!side) return;

    if (state.appMode === 'annotation' && state.annoTool === 'text') {
        if (state.drawing.mode === 'text-move' || state.drawing.mode === 'text-resize') {
            const wrapper = els[side + 'Wrapper'];
            const box = state.drawing.activeTextBox;
            const startData = state.drawing.startPoint;
            const startMouse = state.drawing.startMouse;
            
            const wrapperRect = wrapper.getBoundingClientRect();
            const currentMouseX = e.clientX - wrapperRect.left;
            const currentMouseY = e.clientY - wrapperRect.top;
            
            const dx = (currentMouseX - startMouse.x) / wrapperRect.width;
            const dy = (currentMouseY - startMouse.y) / wrapperRect.height;

            const domBox = wrapper.querySelector(`.text-box[data-id="${box.id}"]`);

            if (state.drawing.mode === 'text-move') {
                box.x = Math.max(0, Math.min(1 - box.w, startData.x + dx));
                box.y = Math.max(0, Math.min(1 - box.h, startData.y + dy));
                if (domBox) {
                    domBox.style.left = (box.x * 100) + '%';
                    domBox.style.top = (box.y * 100) + '%';
                }
            } else if (state.drawing.mode === 'text-resize') {
                let newW = Math.max(0.05, startData.w + dx);
                let newH = Math.max(0.02, startData.h + dy);
                
                if (box.x + newW > 1) newW = 1 - box.x;
                if (box.y + newH > 1) newH = 1 - box.y;

                box.w = newW;
                box.h = newH;

                if (domBox) {
                    domBox.style.width = (box.w * 100) + '%';
                    domBox.style.height = (box.h * 100) + '%';
                }
            }
            return;
        }
        // Comment-create mode: no drag handling — comment is placed on pointerup
        // at the click position. Just return so we don't try to update a drag rect.
        return;
    }
    else if (state.appMode === 'linking' && state.linkCreation && state.linkCreation.active) {
        const source = state.linkCreation.sourceData;
        const sourceSide = state.linkCreation.sourceSide;
        
        // Only draw line if the source page is currently visible in its original side
        if (state.view[sourceSide].docId === source.docId && state.view[sourceSide].pageId === source.pageId) {
            els.currentPath.style.display = 'block';
            const rect = els[sourceSide + 'Wrapper'].getBoundingClientRect();
            const startX = rect.left + (source.x * rect.width);
            const startY = rect.top + (source.y * rect.height);
            
            const svgRect = els.drawingLayer.getBoundingClientRect();
            const x1 = startX - svgRect.left;
            const y1 = startY - svgRect.top;
            const x2 = e.clientX - svgRect.left;
            const y2 = e.clientY - svgRect.top;
            
            els.currentPath.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
        } else {
            els.currentPath.style.display = 'none';
        }
        return;
    } 
    else if (state.appMode === 'annotation') {
        const pos = getMousePosInViewport(e, side);

        if (state.annoTool === 'select') {
            if (state.selection.mode === 'marquee') {
                state.selection.marqueeCurrent = pos;
                renderAnnotations(side);
            }
            else if (state.selection.mode === 'dragging') {
                // ---- BUG FIX (Annotation movement rendering) ----
                // Defensive: ensure the selection's object references still
                // point at the canonical objects in state.annotations. If a
                // Yjs remote update arrived between pointerdown and this
                // pointermove (e.g. another user edited a *different*
                // annotation on the same page, triggering a full page
                // rebuild), the references might be stale. The primary
                // protection is `yjsBeginInFlight` at drag-start, but this
                // re-link is a belt-and-suspenders safety net.
                _refreshSelectionReferences(side);

                const dx = pos.x - state.selection.dragStartMouse.x;
                const dy = pos.y - state.selection.dragStartMouse.y;
                
                state.selection.selectedImages.forEach(img => {
                    img.x += dx;
                    img.y += dy;
                    if (img.linkId) {
                        const link = state.links.find(l => l.id === img.linkId);
                        if (link) {
                            if (link.target.docId === state.view[side].docId && link.target.pageId === state.view[side].pageId) {
                                link.target.x = img.x;
                                link.target.y = img.y + (img.h / 2);
                            } else if (link.source.docId === state.view[side].docId && link.source.pageId === state.view[side].pageId) {
                                link.source.x = img.x;
                                link.source.y = img.y + (img.h / 2);
                            }
                        }
                    }
                });
                state.selection.selectedTextBoxes.forEach(tb => {
                    if (tb._editing) return;
                    tb.x += dx;
                    tb.y += dy;
                    // side is the correct variable in handlePointerMove scope
                    const pageWrapper = els[side + 'Wrapper'];
                    const wrapperEl = pageWrapper?.querySelector(`.text-box-wrapper[data-id="${tb.id}"]`);
                    if (wrapperEl) {
                        wrapperEl.style.left = (tb.x * 100) + '%';
                        wrapperEl.style.top  = (tb.y * 100) + '%';
                    }
                });
                state.selection.selectedStrokes.forEach(stk => {
                    stk.points.forEach(p => {
                        p.x += dx;
                        p.y += dy;
                    });
                });

                state.selection.boundingBox.x += dx;
                state.selection.boundingBox.y += dy;

                state.selection.dragStartMouse = pos;
                renderAnnotations(side);
                renderTextLayer(side);
                renderMarkersForView(side);
            }
            else if (state.selection.mode === 'resizing') {
                // ---- BUG FIX (Annotation movement rendering) ----
                // Same defensive re-link as in 'dragging' mode above.
                _refreshSelectionReferences(side);

                const originalState = state.selection.dragStartPositions;
                const originX = originalState.bbox.x;
                const originY = originalState.bbox.y;
                const newW = Math.max(0.01, pos.x - originX);
                const scaleX = newW / originalState.bbox.w;
                const scaleY = scaleX; 

                state.selection.selectedImages.forEach((img, idx) => {
                    const oldImg = originalState.images[idx];
                    img.x = originX + (oldImg.x - originX) * scaleX;
                    img.y = originY + (oldImg.y - originY) * scaleY;
                    img.w = oldImg.w * scaleX;
                    img.h = oldImg.h * scaleY;
                    
                    if (img.linkId) {
                        const link = state.links.find(l => l.id === img.linkId);
                        if (link) {
                            if (link.target.docId === state.view[side].docId && link.target.pageId === state.view[side].pageId) {
                                link.target.x = img.x;
                                link.target.y = img.y + (img.h / 2);
                            } else if (link.source.docId === state.view[side].docId && link.source.pageId === state.view[side].pageId) {
                                link.source.x = img.x;
                                link.source.y = img.y + (img.h / 2);
                            }
                        }
                    }
                });

                state.selection.selectedTextBoxes.forEach((tb, idx) => {
                    const oldTb = originalState.textBoxes[idx];
                    tb.x = originX + (oldTb.x - originX) * scaleX;
                    tb.y = originY + (oldTb.y - originY) * scaleY;
                    tb.w = oldTb.w * scaleX;
                    tb.h = oldTb.h * scaleY;
                });

                state.selection.selectedStrokes.forEach((stk, idx) => {
                    const oldStk = originalState.strokes[idx];
                    stk.points.forEach((p, pIdx) => {
                        const oldP = oldStk.points[pIdx];
                        p.x = originX + (oldP.x - originX) * scaleX;
                        p.y = originY + (oldP.y - originY) * scaleY;
                    });
                });

                state.selection.boundingBox.w = newW;
                state.selection.boundingBox.h = originalState.bbox.h * scaleY;
                
                renderAnnotations(side);
                renderTextLayer(side);
                renderMarkersForView(side);
            }
        } 
        else if (state.annoTool === 'eraser-stroke') {
            deleteStrokeAt(side, pos.x, pos.y);
        } else {
            if (state.lineMode === 'straight' && (state.annoTool === 'pen' || state.annoTool === 'highlighter')) {
                // Redraw from scratch each move to show live preview
                const start = state.drawing.straightLineStart;
                const docId = state.view[side].docId;
                const pageId = state.view[side].pageId;
                // ---- BUG FIX (Stroke continuity) ----
                // Used to be strokes[strokes.length - 1] — a positional lookup
                // that targeted the PREVIOUS stroke whenever an async state
                // replacement (smartRefreshFromServer / conflict reload / Yjs
                // rebuild) landed mid-stroke, so the straight-line preview
                // overwrote the WRONG stroke's points. resolveActiveStroke()
                // returns the stroke the user is actually drawing (tracked by
                // reference in state.drawing.activeStrokeRef) and re-links it
                // into the array if a replacement dropped it.
                const currentStroke = (typeof resolveActiveStroke === 'function')
                    ? resolveActiveStroke(docId, pageId)
                    : state.annotations[docId]?.[pageId]?.strokes?.[state.annotations[docId]?.[pageId]?.strokes.length - 1];
                if (!currentStroke) return;
                // Reset points to just start + current, simulating a straight line preview
                currentStroke.points = [start, { x: pos.x, y: pos.y }];
                renderAnnotations(side);
            } else {
                continueAnnotationStroke(side, pos.x, pos.y);
            }
        }
    }
}

async function handlePointerUp(e) {
    const cursorEl = document.getElementById('tool-cursor');
    if(cursorEl) cursorEl.classList.add('hidden');
    document.body.classList.remove('cursor-none');

    // SNIP & LINK LOGIC - FINISH DRAWING
    if (state.appMode === 'snip-link' && state.snip.phase === 'drawing' && state.drawing.pointerId === e.pointerId) {
        state.drawing.active = false;
        
        const side = state.snip.startSide;
        const startPos = state.snip.startPos;
        const endPos = getMousePosInViewport(e, side);

        // Reset currentPos to clear the red dotted rendering immediately
        state.snip.currentPos = startPos; 
        renderAnnotations(side);

        let x = Math.min(startPos.x, endPos.x);
        let y = Math.min(startPos.y, endPos.y);
        let w = Math.abs(startPos.x - endPos.x);
        let h = Math.abs(startPos.y - endPos.y);

        if (w > 0.01 && h > 0.01) {
            captureSnip(side, x, y, w, h);
        } else {
            cancelSnip();
        }
        return;
    }

    if (!state.drawing.active) return;
    if (state.drawing.pointerId !== e.pointerId) return;

    const side = state.drawing.startSide;

    // Handle Text Annotation Finishing (now: comment creation)
    if (state.appMode === 'annotation' && state.annoTool === 'text') {
        if (state.drawing.mode === 'text-move' || state.drawing.mode === 'text-resize') {
            const docId = state.view[side].docId;
            saveAnnotationsToDB(docId, state.annotations[docId]);
            state.drawing.active = false;
            state.drawing.mode = null;
            state.drawing.activeTextBox = null;
            return;
        }

        // New behaviour: a single click places a comment icon at the click
        // point. If the click landed on an existing comment icon, the icon's
        // own click handler already opened the sidebar — we just bail out
        // without creating a duplicate.
        if (state.drawing.mode === 'comment-create') {
            els.textCreationRect.style.display = 'none';
            const startData = state.drawing.startPointData;
            state.drawing.active = false;
            state.drawing.mode = null;

            // If the pointerup target was a comment icon, the icon's own
            // pointerdown stopPropagation should have prevented us from
            // reaching here — but double-check just in case.
            if (e.target && e.target.closest && e.target.closest('.comment-icon-wrapper')) {
                console.log('[events.js] pointer-up on existing comment icon — letting icon click handler run');
                return;
            }

            console.log('[events.js] text-tool pointer-up — calling createCommentAt', startData);
            await createCommentAt(side, startData.x, startData.y);
            return;
        }

        // Legacy drag-create path (kept for safety but not used).
        els.textCreationRect.style.display = 'none';
        const startData = state.drawing.startPointData;
        const endPos = getMousePosInViewport(e, side);
        let w = endPos.x - startData.x;
        let h = endPos.y - startData.y;
        let x = startData.x;
        let y = startData.y;
        if (w < 0) { x += w; w = Math.abs(w); }
        if (h < 0) { y += h; h = Math.abs(h); }
        if (w > 0.01 && h > 0.01) {
            await createCommentAt(side, x + w / 2, y + h / 2);
        }
    }

    // Handle All Other Annotations Finishing
    if (state.appMode === 'annotation') {
        if (state.annoTool === 'select') {
            if (state.selection.mode === 'marquee') {
                const start = state.selection.marqueeStart;
                const curr = state.selection.marqueeCurrent;
                
                const selRect = {
                    x: Math.min(start.x, curr.x),
                    y: Math.min(start.y, curr.y),
                    w: Math.abs(curr.x - start.x),
                    h: Math.abs(curr.y - start.y)
                };

                if (selRect.w > 0.001 && selRect.h > 0.001) {
                    const docId = state.view[side].docId;
                    const pageId = state.view[side].pageId;
                    const pageData = state.annotations[docId]?.[pageId];

                    if (pageData) {
                        const selectedImgs = [];
                        const selectedTbs = [];
                        const selectedStks = [];
                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        let hasSelection = false;

                        if (pageData.images) {
                            pageData.images.forEach(img => {
                                const bounds = { x: img.x, y: img.y, w: img.w, h: img.h };
                                if (rectsIntersect(selRect, bounds)) {
                                    selectedImgs.push(img);
                                    hasSelection = true;
                                    if(img.x < minX) minX = img.x;
                                    if(img.y < minY) minY = img.y;
                                    if(img.x + img.w > maxX) maxX = img.x + img.w;
                                    if(img.y + img.h > maxY) maxY = img.y + img.h;
                                }
                            });
                        }

                        if (pageData.textBoxes) {
                            pageData.textBoxes.forEach(tb => {
                                const bounds = { x: tb.x, y: tb.y, w: tb.w, h: tb.h };
                                if (rectsIntersect(selRect, bounds)) {
                                    selectedTbs.push(tb);
                                    hasSelection = true;
                                    if(tb.x < minX) minX = tb.x;
                                    if(tb.y < minY) minY = tb.y;
                                    if(tb.x + tb.w > maxX) maxX = tb.x + tb.w;
                                    if(tb.y + tb.h > maxY) maxY = tb.y + tb.h;
                                }
                            });
                        }

                        if (pageData.strokes) {
                            pageData.strokes.forEach(stk => {
                                if (stk.tool === 'eraser-pixel') return;
                                const bounds = getStrokeBounds(stk);
                                if (rectsIntersect(selRect, bounds)) {
                                    selectedStks.push(stk);
                                    hasSelection = true;
                                    if(bounds.x < minX) minX = bounds.x;
                                    if(bounds.y < minY) minY = bounds.y;
                                    if(bounds.x + bounds.w > maxX) maxX = bounds.x + bounds.w;
                                    if(bounds.y + bounds.h > maxY) maxY = bounds.y + bounds.h;
                                }
                            });
                        }

                        if (hasSelection) {
                            state.selection.selectedImages = selectedImgs;
                            state.selection.selectedTextBoxes = selectedTbs;
                            state.selection.selectedStrokes = selectedStks;
                            state.selection.boundingBox = {
                                x: minX,
                                y: minY,
                                w: maxX - minX,
                                h: maxY - minY
                            };
                            state.selection.mode = 'idle'; 
                        } else {
                            clearSelection();
                        }
                    } else {
                        clearSelection();
                    }
                } else {
                    clearSelection();
                }
            } 
            else if (state.selection.mode === 'dragging' || state.selection.mode === 'resizing') {
                state.selection.mode = 'idle';
                const docId = state.view[side].docId;
                const pageId = state.view[side].pageId;
                if (docId) saveAnnotationsToDB(docId, state.annotations[docId]);

                state.selection.selectedImages.forEach(img => {
                    if (img.linkId) {
                        const link = state.links.find(l => l.id === img.linkId);
                        if (link) saveLinkToDB(link);
                    }
                });

                // ---- Yjs: push the moved/resized annotations to the room.
                // After a drag/resize, the data has changed — broadcast it.
                if (docId && pageId && typeof yjsSetAnnotation === 'function' &&
                    typeof yjsIsConnected === 'function' &&
                    yjsIsConnected(getProjectId(), docId)) {
                    state.selection.selectedImages.forEach(img => {
                        if (img.id) yjsSetAnnotation(docId, pageId, img.id, img);
                    });
                    state.selection.selectedTextBoxes.forEach(tb => {
                        if (tb.id) yjsSetAnnotation(docId, pageId, tb.id, tb);
                    });
                    state.selection.selectedStrokes.forEach(stk => {
                        if (stk.id) yjsSetAnnotation(docId, pageId, stk.id, stk);
                    });
                    // Release locks on the just-edited annotations.
                    if (typeof yjsReleaseLock === 'function') {
                        state.selection.selectedImages.forEach(img => img.id && yjsReleaseLock(img.id));
                        state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsReleaseLock(tb.id));
                        state.selection.selectedStrokes.forEach(stk => stk.id && yjsReleaseLock(stk.id));
                    }
                }
                // ---- BUG FIX (Annotation movement rendering) ----
                // End the in-flight marker we set at drag/resize start. Now
                // that the drag is done and the final data is pushed to Yjs,
                // future remote updates for these annotations can safely
                // clobber the local state (which matches the remote state).
                // Doing this AFTER the yjsSetAnnotation calls above is
                // important: the in-flight marker also suppresses our own
                // echo during the just-pushed update, which avoids a
                // wasteful re-render of the just-dragged object.
                if (typeof yjsEndInFlight === 'function') {
                    state.selection.selectedImages.forEach(img => img.id && yjsEndInFlight(img.id));
                    state.selection.selectedTextBoxes.forEach(tb => tb.id && yjsEndInFlight(tb.id));
                    state.selection.selectedStrokes.forEach(stk => stk.id && yjsEndInFlight(stk.id));
                }
            } else {
                state.selection.mode = 'idle';
            }
        } 
        else {
            clearSelection();
            if (state.annoTool !== 'text' && state.annoTool !== 'eraser-stroke' && state.annoTool !== 'image') {
                // For straight line, lock in the two-point stroke before saving
                if (state.lineMode === 'straight' && (state.annoTool === 'pen' || state.annoTool === 'highlighter')) {
                    const docId = state.view[side].docId;
                    const pageId = state.view[side].pageId;
                    // ---- BUG FIX (Stroke continuity) ----
                    // Same reference-stable lookup as in handlePointerMove —
                    // never assume the active stroke is strokes[len-1].
                    const lastStroke = (typeof resolveActiveStroke === 'function')
                        ? resolveActiveStroke(docId, pageId)
                        : null;
                    if (lastStroke) {
                        const endPos = getMousePosInViewport(e, side);
                        lastStroke.points = [state.drawing.straightLineStart, { x: endPos.x, y: endPos.y }];
                    }
                }
                finishAnnotationStroke(side);
            }
            else if (state.annoTool !== 'image') {
                const docId = state.view[side].docId;
                // ---- BUG FIX (Stroke continuity / Yjs source of truth) ----
                // The eraser-stroke path used to bulk-REST-save even while the
                // Yjs room is connected. Per-stroke deletions are already
                // pushed to Yjs inside deleteStrokeAt(); the extra REST bulk
                // save both fights the Yjs-merged state (see the comment in
                // finishAnnotationStroke) and bumps the project revision,
                // which self-echoes a revision_changed → smartRefreshFromServer
                // → stale snapshot replacement — the trigger chain behind the
                // "new stroke connects to the previous stroke" bug.
                if (docId && !(typeof yjsIsConnected === 'function' &&
                               yjsIsConnected(getProjectId(), docId))) {
                    saveAnnotationsToDB(docId, state.annotations[docId]);
                }
            }
        }
        
        renderAnnotations(side);
        setTimeout(() => renderTextLayer(side), 0);
    }
    
    state.drawing.active = false;
    e.target.releasePointerCapture(e.pointerId);
}

// ---- BUG FIX (touch devices: pause/hold while drawing) ---------------------
// iPadOS / Android fire pointercancel when the OS takes the pointer over
// (long-press heuristics after a pause, gesture detection, edge swipes,
// palm rejection, notification banners, ...). We had NO pointercancel
// handler, so a cancelled stroke left the gesture state machine half-open:
// state.drawing.active stayed true, activeStrokeRef stayed set, the Yjs
// in-flight marker was never cleared and the pointerup cleanup never ran.
// The next touch could then build on stale state.
//
// pointercancel is handled like a pointerup that finalizes (or, for tiny
// accidental marks, cancels) the current gesture:
function handlePointerCancel(e) {
    // Only react to the pointer that owns the active gesture (mirrors the
    // pointerId guards in handlePointerMove / handlePointerUp).
    if (e && e.pointerId !== undefined && e.pointerId !== null &&
        state.drawing.pointerId !== null &&
        state.drawing.pointerId !== e.pointerId) {
        return;
    }
    // Two-finger takeover already cleaned up (_cancelDrawingAndCleanStroke).
    if (!state.drawing.active) return;

    const side = state.drawing.startSide;

    // Snip & link: abort the marquee.
    if (state.appMode === 'snip-link' && state.snip && state.snip.phase === 'drawing') {
        state.snip.phase = 'idle';
        state.drawing.active = false;
        if (side && typeof renderAnnotations === 'function') renderAnnotations(side);
        return;
    }

    if (state.appMode === 'annotation') {
        // Select tool: end any drag/resize/marquee without treating it as a
        // completed edit. Release Yjs locks + in-flight markers so other
        // devices are not blocked by a phantom editor.
        if (state.annoTool === 'select') {
            if (state.selection.active) {
                state.selection.mode = 'idle';
                ['selectedImages', 'selectedTextBoxes', 'selectedStrokes'].forEach(key => {
                    (state.selection[key] || []).forEach(anno => {
                        if (!anno || !anno.id) return;
                        if (typeof yjsReleaseLock === 'function') yjsReleaseLock(anno.id);
                        if (typeof yjsEndInFlight === 'function') yjsEndInFlight(anno.id);
                    });
                });
                const docId = side && state.view[side] && state.view[side].docId;
                if (docId && typeof saveAnnotationsToDB === 'function' &&
                    !(typeof yjsIsConnected === 'function' &&
                      yjsIsConnected(getProjectId(), docId))) {
                    saveAnnotationsToDB(docId, state.annotations[docId]);
                }
            }
            state.drawing.active = false;
            if (side && typeof renderAnnotations === 'function') renderAnnotations(side);
            return;
        }

        if (state.annoTool === 'image') {
            state.drawing.active = false;
            return;
        }

        if (state.annoTool === 'text') {
            state.drawing.active = false;
            state.drawing.mode = null;
            return;
        }

        // pen / highlighter / eraser-pixel: a stroke is in progress.
        const ref = state.drawing.activeStrokeRef;
        const isTiny = ref && ref.points && ref.points.length <= 3;
        if (isTiny) {
            // The OS took the pointer before real drawing happened — remove
            // the accidental dot, same semantics as the two-finger takeover.
            _cancelDrawingAndCleanStroke();
        } else if (side) {
            // A real stroke was in progress — keep the partial work and
            // finalize it exactly like a pointerup would (undo entry, final
            // Yjs push, in-flight cleanup). This guarantees the NEXT stroke
            // starts from a completely clean, independent state.
            finishAnnotationStroke(side);
            state.drawing.active = false;
        } else {
            state.drawing.active = false;
        }
        if (side && typeof renderAnnotations === 'function') renderAnnotations(side);
        return;
    }

    // Linking / navigation / other modes: just close the gesture.
    state.drawing.active = false;
}
window.handlePointerCancel = handlePointerCancel;

function updatePathVisual() {
    const start = state.drawing.startPoint;
    const end = state.drawing.currentPoint;
    const svgRect = els.drawingLayer.getBoundingClientRect();
    const x1 = start.x - svgRect.left;
    const y1 = start.y - svgRect.top;
    const x2 = end.x - svgRect.left;
    const y2 = end.y - svgRect.top;
    const d = `M ${x1} ${y1} L ${x2} ${y2}`;
    els.currentPath.setAttribute('d', d);
}

function handleKeyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.active) {
        if(e.target.tagName !== 'INPUT' && !e.target.isContentEditable) {
            e.preventDefault();
            deleteSelection();
        }
    }
    
    if (e.key === 'Escape') {
        if (state.appMode === 'snip-link') cancelSnip();
        if (state.appMode === 'linking' && state.linkCreation.active) {
            state.linkCreation.active = false;
            state.linkCreation.sourceData = null;
            els.currentPath.style.display = 'none';
            if (typeof renderMarkersForView === 'function') {
                renderMarkersForView('left');
                renderMarkersForView('right');
            }
        }
    }

    // Ignore shortcuts when typing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    // Ctrl shortcuts
    if (e.ctrlKey) {
        // Undo / Redo: unified chronological history across BOTH canvases.
        // - Ctrl+Z        → undo
        // - Ctrl+Y        → redo
        // - Ctrl+Shift+Z  → redo (alternative binding)
        if (e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            if (typeof undoLastAction === 'function') undoLastAction();
        } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
            e.preventDefault();
            if (typeof redoNextAction === 'function') redoNextAction();
        }
        if (e.key === '/') { e.preventDefault(); toggleAiSidebar(); }
        if (e.key === 'b') { e.preventDefault(); toggleLeftSidebar(); }
        if (e.shiftKey && e.key === 'S') { e.preventDefault(); exportProject(); }
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomAtMouse(0.25); }
        if (e.key === '-') { e.preventDefault(); zoomAtMouse(-0.25); }
        if (e.key === '0') { e.preventDefault(); resetZoomAtMouse(); }
        // New: file-explorer shortcuts (only when not typing in an input)
        if (e.shiftKey && (e.key === 'N' || e.key === 'n')) {
            e.preventDefault();
            if (typeof promptForNewFolder === 'function') promptForNewFolder(state.currentFolderId || 'root');
        }
        if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            if (typeof selectAllFiles === 'function') selectAllFiles();
        }
        if (e.key === 'c' || e.key === 'C') {
            // Copy selected files to internal clipboard.
            if (typeof copySelectedFiles === 'function') copySelectedFiles();
        }
        if (e.key === 'v' || e.key === 'V') {
            // Paste (duplicate into current folder).
            if (typeof pasteClipboardFiles === 'function') pasteClipboardFiles();
        }
        return;
    }

    // Single key shortcuts
    const shortcuts = {
        'v': () => setAppMode('navigation'),
        'l': () => setAppMode('linking'),
        's': () => setAppMode('snip-link'),
        'x': () => setAppMode('delete-link'),
        'p': () => setAnnoTool('pen'),
        'h': () => setAnnoTool('highlighter'),
        't': () => setAnnoTool('text'),
        'e': () => setAnnoTool('eraser-pixel'),
        'd': () => setAnnoTool('eraser-stroke'),
        'i': () => setAnnoTool('image'),
        'f': () => toggleLineMode(),
    };

    // File-explorer single-key shortcuts (only when not in an input).
    if (e.key === 'F2') {
        e.preventDefault();
        // Rename the first selected doc, else the first selected folder.
        const selDoc = Array.from(state.fileSelection.docIds)[0];
        const selFolder = Array.from(state.fileSelection.folderIds)[0];
        if (selDoc) { enableRename(selDoc); return; }
        if (selFolder) { promptForFolderRename(selFolder); return; }
    }
    if (e.key === 'Delete') {
        if (state.fileSelection.docIds.size > 0 || state.fileSelection.folderIds.size > 0) {
            e.preventDefault();
            showBulkDeleteDialog();
            return;
        }
    }
    if (e.key === 'Escape') {
        if (typeof clearFileSelection === 'function') {
            clearFileSelection();
            _closeAllMenus();
            return;
        }
    }
    if (e.key === 'Enter') {
        // Open the first selected doc in the next available viewport.
        const selDoc = Array.from(state.fileSelection.docIds)[0];
        if (selDoc) {
            e.preventDefault();
            if (typeof openDocumentSmart === 'function') openDocumentSmart(selDoc);
            return;
        }
    }

    if (shortcuts[e.key.toLowerCase()]) {
        shortcuts[e.key.toLowerCase()]();
    }
}

const handleScroll = debounce((side) => {
    const viewport = els[side + 'Viewport'];
    state.view[side].scrollTop = viewport.scrollTop;
    // Scroll/pan never re-renders, so record the position here too
    // (resume-on-reopen memory; renderPage covers the page-change paths).
    if (state.view[side].docId && typeof rememberDocPosition === 'function') {
        rememberDocPosition(side);
    }
    if (state.view[side].docId && state.lastActiveSide !== side) {
        // Scrolling/panning a PDF makes it the active one — keep the
        // single header toolbar (tabs + controls) in sync immediately.
        state.lastActiveSide = side;
        updateViewportActiveVisuals();
    } else if (state.lastActiveSide === side) {
        updateViewportActiveVisuals();
    }
    saveSettings();
    renderMarkersForView(side);
}, 200);

function handleViewportZoom(e, side) {
    if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();

        // ---- Single Active-PDF toolbar: zooming a viewport with
        // ctrl+wheel makes that viewport's PDF the active one, so the
        // header's zoom % / page controls immediately reflect it. ----
        if (state.lastActiveSide !== side && state.view[side].docId) {
            state.lastActiveSide = side;
            updateViewportActiveVisuals();
        }

        const zoomSpeed = 0.009; 
        const delta = -e.deltaY * zoomSpeed;
        
        const viewport = els[side + 'Viewport'];
        const wrapper = els[side + 'Wrapper'];
        const oldLiveScale = state.zoomLive[side];
        let newLiveScale = oldLiveScale * (1 + delta);

        if (newLiveScale < 0.1) newLiveScale = 0.1;
        if (newLiveScale > 5.0) newLiveScale = 5.0;

        // --- Zoom toward mouse cursor position ---
        // With transformOrigin at 0 0, the wrapper's visual top-left stays fixed.
        // A content point (cx, cy) in wrapper CSS-pixels appears at:
        //   screenX = wrapperRect.left + cx * liveScale
        // To keep the point under the mouse stable after changing liveScale:
        //   scrollLeft_new = scrollLeft + cx * (newLiveScale - oldLiveScale)
        const wrapperRect = wrapper.getBoundingClientRect();
        const cx = (e.clientX - wrapperRect.left) / oldLiveScale;
        const cy = (e.clientY - wrapperRect.top) / oldLiveScale;

        state.zoomLive[side] = newLiveScale;

        wrapper.style.transformOrigin = '0 0';
        wrapper.style.transform = `scale(${newLiveScale})`;
        wrapper.style.zIndex = '10'; 

        // Adjust scroll to keep the content point under the mouse cursor
        viewport.scrollLeft += cx * (newLiveScale - oldLiveScale);
        viewport.scrollTop += cy * (newLiveScale - oldLiveScale);

        const currentBaseScale = state.view[side].scale;
        const effectiveScale = currentBaseScale * newLiveScale;
        
        els[side + 'ZoomLevel'].innerText = Math.round(effectiveScale * 100) + '%';

        // Debounce commit: after 350ms of no wheel events, re-render at final scale
        if (state.zoomTimer[side]) clearTimeout(state.zoomTimer[side]);
        state.zoomTimer[side] = setTimeout(() => {
            state.zoomTimer[side] = null;
            commitZoom(side, state.globalMouse.x, state.globalMouse.y);
        }, 350);
    }
}

function getActiveSideUnderMouse() {
    const mx = state.globalMouse.x;
    const my = state.globalMouse.y;
    const leftRect = els.leftPanel.getBoundingClientRect();
    const rightRect = els.rightPanel.getBoundingClientRect();

    if (mx >= leftRect.left && mx <= leftRect.right &&
        my >= leftRect.top && my <= leftRect.bottom) return 'left';
    if (mx >= rightRect.left && mx <= rightRect.right &&
        my >= rightRect.top && my <= rightRect.bottom) return 'right';

    // Fallback to last active side
    return state.lastActiveSide;
}

function zoomAtMouse(delta) {
    const side = getActiveSideUnderMouse();
    if (!state.view[side].docId) return;

    const viewport = els[side + 'Viewport'];
    const wrapper = els[side + 'Wrapper'];

    // Mouse position relative to viewport
    const viewportRect = viewport.getBoundingClientRect();
    const mouseX = state.globalMouse.x - viewportRect.left;
    const mouseY = state.globalMouse.y - viewportRect.top;

    // Mouse position as fraction of current canvas
    const wrapperRect = wrapper.getBoundingClientRect();
    const fracX = (state.globalMouse.x - wrapperRect.left) / wrapperRect.width;
    const fracY = (state.globalMouse.y - wrapperRect.top) / wrapperRect.height;

    // Apply zoom
    const oldScale = state.view[side].scale;
    let newScale = oldScale + delta;
    if (newScale < 0.25) newScale = 0.25;
    if (newScale > 5.0) newScale = 5.0;
    state.view[side].scale = newScale;

    updateZoomIndicator(side);

    // Re-render then scroll so the point under mouse stays fixed
    renderPage(side).then ? renderPage(side).then(() => {
        scrollToKeepPoint(side, fracX, fracY, mouseX, mouseY);
    }) : (() => {
        // renderPage is async but may not return promise in all cases
        setTimeout(() => scrollToKeepPoint(side, fracX, fracY, mouseX, mouseY), 50);
    })();

    saveSettings();
}

function scrollToKeepPoint(side, fracX, fracY, mouseX, mouseY) {
    const viewport = els[side + 'Viewport'];
    const wrapper = els[side + 'Wrapper'];

    // New canvas size after render
    const newCanvasWidth = wrapper.offsetWidth;
    const newCanvasHeight = wrapper.offsetHeight;

    // Where that fraction point is now in canvas pixels
    const newPointX = fracX * newCanvasWidth;
    const newPointY = fracY * newCanvasHeight;

    // Scroll so that point aligns back under the mouse.
    // Must include wrapper.offsetLeft/offsetTop for correct positioning
    // (accounts for viewport padding and wrapper centering).
    viewport.scrollLeft = wrapper.offsetLeft + newPointX - mouseX;
    viewport.scrollTop = wrapper.offsetTop + newPointY - mouseY;
}

function resetZoomAtMouse() {
    const side = getActiveSideUnderMouse();
    if (!state.view[side].docId) return;

    const viewport = els[side + 'Viewport'];
    const wrapperRect = els[side + 'Wrapper'].getBoundingClientRect();
    const fracX = (state.globalMouse.x - wrapperRect.left) / wrapperRect.width;
    const fracY = (state.globalMouse.y - wrapperRect.top) / wrapperRect.height;
    const viewportRect = viewport.getBoundingClientRect();
    const mouseX = state.globalMouse.x - viewportRect.left;
    const mouseY = state.globalMouse.y - viewportRect.top;

    state.view[side].scale = 1.5; // default scale
    updateZoomIndicator(side);
    setTimeout(() => scrollToKeepPoint(side, fracX, fracY, mouseX, mouseY), 50);
    saveSettings();
}

// ---- Two-finger gestures for touch devices (iPad / phone) ----
// Two-finger touch handles BOTH pan (drag to scroll) AND pinch-zoom.
// Works in ALL modes — annotation, navigation, linking, etc.
// Two fingers always means "pan/zoom", never "draw", matching the
// behavior of apps like Goodnotes.
//
// Pan: tracks the center point of two fingers and scrolls the viewport
// by the delta each frame. Zoom: tracks the distance between fingers
// and applies a CSS scale transform, committed to a re-render when
// fingers lift. Both can happen simultaneously — the math keeps the
// content point under the gesture center stable.
//
// When a user starts drawing with one finger/stylus and puts down a
// second finger, the in-progress stroke is cancelled (and cleaned up)
// so no annotation artifacts remain, and the two-finger gesture takes over.

let _twoFingerState = null;

function initTwoFingerGestures() {
    // Register touchstart/touchmove/touchend on BOTH viewports.
    // These are registered as non-capture listeners (bubble phase) so they
    // run AFTER the capture-phase touchstart handler that suppresses text
    // selection in annotation mode.
    //
    // ---- Architecture: translate+scale (GPU-composited, zero reflow) ----
    // During the gesture, pan is handled by CSS translate() and zoom by
    // CSS scale().  Both run entirely on the GPU compositor — NO scroll
    // changes and NO layout reads happen between frames, which eliminates:
    //   - Layout thrashing  (no getBoundingClientRect mid-frame)
    //   - Integer scroll snapping jitter (scrollLeft/scrollTop are ints)
    //   - Transform + scroll interaction glitches
    //
    // On finger lift (touchend), the accumulated translate is atomically
    // converted to a viewport scroll offset, the CSS transform is reduced
    // to just scale() (or none), and commitZoom re-renders at the new
    // resolution if the user actually pinched.
    ['left', 'right'].forEach(side => {
        const viewport = els[side + 'Viewport'];
        if (!viewport) return;

        viewport.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 2) return;

            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const cx = (t1.clientX + t2.clientX) / 2;
            const cy = (t1.clientY + t2.clientY) / 2;

            // If the user was drawing with one finger/stylus, cancel the drawing
            // and clean up the partial stroke so no annotation artifacts remain.
            if (state.drawing && state.drawing.active) {
                _cancelDrawingAndCleanStroke();
            }

            // Commit any pending wheel-zoom before starting a gesture
            if (state.zoomTimer[side]) {
                clearTimeout(state.zoomTimer[side]);
                state.zoomTimer[side] = null;
            }

            // Read wrapper screen position ONCE at gesture start.
            // Because we use translate() for panning (not scroll), this
            // value stays valid for the entire gesture - no re-reads needed.
            const wrapper = els[side + 'Wrapper'];
            const wrapperRect = wrapper.getBoundingClientRect();

            _twoFingerState = {
                side: side,
                startDist: dist,
                startScale: state.zoomLive[side] || 1.0,
                startCX: cx,
                startCY: cy,
                // Wrapper's screen position at gesture start (constant).
                // Used to compute translate so the content point under the
                // start center stays under the current center every frame.
                wrapperLeft: wrapperRect.left,
                wrapperTop: wrapperRect.top,
                zoomStarted: false,  // becomes true once pinch intent is confirmed
                lastTX: 0,
                lastTY: 0,
                lastCX: cx,
                lastCY: cy,
            };

            // Promote wrapper to its own GPU layer for the duration of the
            // gesture so translate+scale changes are compositor-only.
            wrapper.style.willChange = 'transform';
            e.preventDefault();
        }, { passive: false });

        viewport.addEventListener('touchmove', (e) => {
            if (!_twoFingerState || _twoFingerState.side !== side) return;
            if (e.touches.length !== 2) return;
            e.preventDefault();

            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const cx = (t1.clientX + t2.clientX) / 2;
            const cy = (t1.clientY + t2.clientY) / 2;
            const s = _twoFingerState;

            // ---- ZOOM: dead-zone gated ----
            // During pure pan the finger distance naturally wobbles by a few
            // px.  We only enter zoom mode once the change exceeds a dead
            // zone, and once entered we stay in zoom mode for the rest of
            // the gesture so the transition is smooth.
            const ZOOM_DEAD_ZONE = Math.max(12, s.startDist * 0.10);
            const distDelta = Math.abs(dist - s.startDist);
            if (!s.zoomStarted && distDelta >= ZOOM_DEAD_ZONE) {
                s.zoomStarted = true;
            }

            let newScale = s.startScale;
            if (s.zoomStarted) {
                const scaleFactor = dist / s.startDist;
                newScale = s.startScale * scaleFactor;
                // Clamp effective scale
                const baseScale = state.view[side].scale;
                const effective = baseScale * newScale;
                if (effective < 0.25) newScale = 0.25 / baseScale;
                if (effective > 5.0) newScale = 5.0 / baseScale;
                // Quantize to 0.1% to avoid sub-pixel raster jitter
                newScale = Math.round(newScale * 1000) / 1000;
            }

            // ---- TRANSLATE: keep content point under start center
            //              pinned to the current gesture center ----
            // With transform-origin 0 0 the math is:
            //   visual_x = wrapperLeft + tx + contentX * newScale
            // We want visual_x = cx, and contentX = (startCX - wrapperLeft)/startScale,
            // so: tx = (cx - wrapperLeft) - (startCX - wrapperLeft) * (newScale / startScale)
            const ratio = newScale / s.startScale;
            const tx = (cx - s.wrapperLeft) - (s.startCX - s.wrapperLeft) * ratio;
            const ty = (cy - s.wrapperTop) - (s.startCY - s.wrapperTop) * ratio;

            // ---- Single DOM write - no layout reads, no scroll changes ----
            const wrapper = els[side + 'Wrapper'];
            state.zoomLive[side] = newScale;
            wrapper.style.transformOrigin = '0 0';
            wrapper.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + newScale + ')';
            wrapper.style.zIndex = '10';

            // Remember for touchend scroll conversion
            s.lastTX = tx;
            s.lastTY = ty;
            s.lastCX = cx;
            s.lastCY = cy;

            // Update zoom indicator
            if (s.zoomStarted) {
                const finalScale = state.view[side].scale * newScale;
                els[side + 'ZoomLevel'].innerText = Math.round(finalScale * 100) + '%';
            }
        }, { passive: false });

        viewport.addEventListener('touchend', (e) => {
            if (!_twoFingerState) return;
            // Only finalize when going from 2 touches to fewer
            if (e.touches.length >= 2) return;

            const s = _twoFingerState;
            const pside = s.side;
            const didZoom = s.zoomStarted;
            const focusX = s.lastCX;
            const focusY = s.lastCY;
            const tx = s.lastTX;
            const ty = s.lastTY;
            _twoFingerState = null;

            const wrapper = els[pside + 'Wrapper'];
            const vp = els[pside + 'Viewport'];

            if (didZoom) {
                // Keep the full transform (translate + scale) so commitZoom can read 
                // the exact visual bounding rect. commitZoom will handle updating the scroll.
                wrapper.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + (state.zoomLive[pside]) + ')';
                wrapper.style.transformOrigin = '0 0';
                wrapper.style.willChange = '';
                if (typeof commitZoom === 'function') {
                    commitZoom(pside, focusX, focusY);
                }
            } else {
                // Pure pan - no pinch detected.
                // Atomically convert translate to scroll.
                vp.scrollLeft -= tx;
                vp.scrollTop -= ty;

                var liveScale = state.zoomLive[pside];
                if (liveScale && liveScale !== 1) {
                    wrapper.style.transform = 'scale(' + liveScale + ')';
                    wrapper.style.transformOrigin = '0 0';
                } else {
                    wrapper.style.transform = 'none';
                    wrapper.style.transformOrigin = '';
                    state.zoomLive[pside] = 1.0;
                }
                wrapper.style.zIndex = '';
                wrapper.style.willChange = '';
            }
        }, { passive: false });

        // Also handle touchcancel (e.g. system gesture interrupts)
        viewport.addEventListener('touchcancel', (e) => {
            if (!_twoFingerState) return;
            const s = _twoFingerState;
            const pside = s.side;
            const didZoom = s.zoomStarted;
            const focusX = s.lastCX;
            const focusY = s.lastCY;
            const tx = s.lastTX;
            const ty = s.lastTY;
            _twoFingerState = null;

            const wrapper = els[pside + 'Wrapper'];
            const vp = els[pside + 'Viewport'];

            if (didZoom) {
                wrapper.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + (state.zoomLive[pside]) + ')';
                wrapper.style.transformOrigin = '0 0';
                wrapper.style.willChange = '';
                if (typeof commitZoom === 'function') {
                    commitZoom(pside, focusX, focusY);
                }
            } else {
                vp.scrollLeft -= tx;
                vp.scrollTop -= ty;

                var liveScale2 = state.zoomLive[pside];
                if (liveScale2 && liveScale2 !== 1) {
                    wrapper.style.transform = 'scale(' + liveScale2 + ')';
                    wrapper.style.transformOrigin = '0 0';
                } else {
                    wrapper.style.transform = 'none';
                    wrapper.style.transformOrigin = '';
                    state.zoomLive[pside] = 1.0;
                }
                wrapper.style.zIndex = '';
                wrapper.style.willChange = '';
            }
        }, { passive: false });
    });
}

// Helper: cancel in-progress drawing and remove the partial stroke artifact.
// When the user transitions from 1-finger draw to 2-finger pan/zoom, the
// first finger may have started a stroke with 1-2 points. We remove it so
// no tiny stray marks are left on the page.
function _cancelDrawingAndCleanStroke() {
    const side = state.drawing.startSide;
    // ---- BUG FIX (Stroke continuity) ----
    // The old code popped strokes[len-1] and leaked state:
    //   - it could remove the WRONG stroke (positional lookup — the active
    //     stroke is not guaranteed to be last after an async state
    //     replacement);
    //   - state.drawing.activeStrokeRef was left dangling;
    //   - the Yjs in-flight marker was never ended (the stroke stayed
    //     "protected" from remote updates forever);
    //   - the removed stroke was never deleted from the Yjs room, so the
    //     next page rebuild resurrected it as a ghost stroke.
    const ref = state.drawing.activeStrokeRef;
    if (side && state.view[side] && state.view[side].docId) {
        const docId = state.view[side].docId;
        const pageId = state.view[side].pageId;
        const pageData = state.annotations[docId] && state.annotations[docId][pageId];

        // Decide WHICH stroke to remove: the active stroke BY REFERENCE when
        // available (only if it is still a tiny accidental mark), otherwise
        // fall back to the last stroke for legacy callers.
        let removeStroke = null;
        if (ref) {
            if (ref.tool !== 'eraser-pixel' &&
                ref.points && ref.points.length <= 3) {
                removeStroke = ref;
            }
        } else if (pageData && pageData.strokes && pageData.strokes.length > 0) {
            const lastStroke = pageData.strokes[pageData.strokes.length - 1];
            if (lastStroke && lastStroke.tool !== 'eraser-pixel' &&
                lastStroke.points && lastStroke.points.length <= 3) {
                removeStroke = lastStroke;
            }
        }

        if (removeStroke && pageData && pageData.strokes) {
            const idx = pageData.strokes.indexOf(removeStroke);
            if (idx !== -1) pageData.strokes.splice(idx, 1);
            // Delete from the Yjs room too, or a rebuild will resurrect it.
            if (removeStroke.id && typeof yjsSetAnnotation === 'function' &&
                typeof yjsIsConnected === 'function' &&
                yjsIsConnected(getProjectId(), docId)) {
                yjsSetAnnotation(docId, pageId, removeStroke.id, null);
            }
            if (typeof renderAnnotations === 'function') renderAnnotations(side);
        }
        // A longer in-progress stroke (>3 points) is real work — keep it
        // (same semantics as before), but the bookkeeping below still runs
        // so the gesture ends cleanly.
    }
    // End the in-flight marker and clear the drawing bookkeeping (the old
    // code leaked all of these on the two-finger takeover path).
    if (ref && ref.id && typeof yjsEndInFlight === 'function') yjsEndInFlight(ref.id);
    state.drawing.active = false;
    state.drawing.activeStrokeRef = null;
    state.drawing.activeStrokeTool = null;
    state.drawing.pointerId = null;
    if (typeof clearSelection === 'function') clearSelection();
}

// ---- BUG FIX (Annotation movement rendering) ------------------------------
// Helper: ensure the selection's image / textbox / stroke references still
// point at the canonical objects in state.annotations. Called from the drag
// and resize handlers in handlePointerMove before any mutation.
//
// WHY: state.annotations[docId][pageId] is rebuilt from the Yjs room state by
// _yjsOnUpdate whenever a remote update arrives. The rebuild creates fresh
// object instances via { ...annoData, id: annoId }. If a remote update
// arrives mid-drag (e.g. another user is editing a DIFFERENT annotation on
// the same page, which still triggers a full page rebuild), the user's
// selectedImages/selectedTextBoxes/selectedStrokes arrays would hold STALE
// references — the dragged object's x/y mutations would land on an orphan,
// and the visible (rendered) object would stay at its old position. This
// helper detects that situation and re-links the references by ID, copying
// the in-progress drag state onto the live object so the drag continues
// smoothly.
//
// This is the "defensive layer 2" safety net. Layer 1 is the
// `yjsBeginInFlight` marker set at drag-start, which prevents the rebuild
// from replacing the in-flight annotations in the first place.
function _refreshSelectionReferences(side) {
    if (!state.selection || !state.selection.active) return;
    if (typeof _relinkSelectionAfterYjsUpdate !== 'function') return;
    const selSide = state.selection.side;
    if (!selSide || selSide !== side) return;
    const docId = state.view[selSide] && state.view[selSide].docId;
    if (!docId) return;
    _relinkSelectionAfterYjsUpdate(docId);
}
window._refreshSelectionReferences = _refreshSelectionReferences;

// Expose for app.js to call
window.initTwoFingerGestures = initTwoFingerGestures;
// Backward-compat alias so existing call sites still work
window.initPinchZoom = initTwoFingerGestures;
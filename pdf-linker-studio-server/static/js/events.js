// ==========================================
// 📁 11. events.js
// ==========================================
function getMousePosInViewport(evt, side) {
    const rect = els[side + 'Wrapper'].getBoundingClientRect();
    return {
        x: (evt.clientX - rect.left) / rect.width, 
        y: (evt.clientY - rect.top) / rect.height
    };
}

function handlePointerDown(e) {
    if (e.target.closest('#vertical-resizer') || e.target.closest('button') || e.target.closest('input')) return;

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
                const handleSize = 0.02; 
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
                } 
                else if (pos.x >= bbox.x && pos.x <= bbox.x + bbox.w &&
                            pos.y >= bbox.y && pos.y <= bbox.y + bbox.h) {
                    state.selection.mode = 'dragging';
                    state.selection.dragStartMouse = { x: pos.x, y: pos.y };
                    actionTaken = true;
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
            
            els.textCreationRect.style.left = e.clientX + 'px';
            els.textCreationRect.style.top = e.clientY + 'px';
            els.textCreationRect.style.width = '0px';
            els.textCreationRect.style.height = '0px';
            els.textCreationRect.style.display = 'block';
            els.textCreationRect.style.borderColor = '#3b82f6'; 
            els.textCreationRect.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
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
        
        const pos = getMousePosInViewport(e, side);
        const start = state.drawing.startPointData;
        const dx = e.clientX - (els[side+'Wrapper'].getBoundingClientRect().left + start.x * els[side+'Wrapper'].offsetWidth);
        const dy = e.clientY - (els[side+'Wrapper'].getBoundingClientRect().top + start.y * els[side+'Wrapper'].offsetHeight);

        els.textCreationRect.style.width = Math.abs(dx) + 'px';
        els.textCreationRect.style.height = Math.abs(dy) + 'px';
        els.textCreationRect.style.left = (e.clientX - Math.max(0, dx)) + 'px';
        els.textCreationRect.style.top = (e.clientY - Math.max(0, dy)) + 'px';
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
                const strokes = state.annotations[docId][pageId].strokes;
                const currentStroke = strokes[strokes.length - 1];
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

    // Handle Text Annotation Finishing
    if (state.appMode === 'annotation' && state.annoTool === 'text') {
        if (state.drawing.mode === 'text-move' || state.drawing.mode === 'text-resize') {
            const docId = state.view[side].docId;
            saveAnnotationsToDB(docId, state.annotations[docId]);
            state.drawing.active = false;
            state.drawing.mode = null;
            state.drawing.activeTextBox = null;
            return;
        }

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
            const docId = state.view[side].docId;
            const pageId = state.view[side].pageId;
            
            if (!state.annotations[docId]) state.annotations[docId] = {};
            if (!state.annotations[docId][pageId]) state.annotations[docId][pageId] = { strokes: [], images: [], textBoxes: [] };

            const newBox = {
                id: 'tb_' + Date.now(),
                x: x, y: y, w: w, h: h,
                content: '',
                color: state.annoColor,
                fontSize: 14,
                _editing: true
            };

            state.annotations[docId][pageId].textBoxes.push(newBox);
            await saveAnnotationsToDB(docId, state.annotations[docId]);
            setTimeout(() => renderTextLayer(side), 0);

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
                if (docId) saveAnnotationsToDB(docId, state.annotations[docId]);
                
                state.selection.selectedImages.forEach(img => {
                    if (img.linkId) {
                        const link = state.links.find(l => l.id === img.linkId);
                        if (link) saveLinkToDB(link);
                    }
                });
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
                    const strokes = state.annotations[docId]?.[pageId]?.strokes;
                    if (strokes && strokes.length > 0) {
                        const lastStroke = strokes[strokes.length - 1];
                        const endPos = getMousePosInViewport(e, side);
                        lastStroke.points = [state.drawing.straightLineStart, { x: endPos.x, y: endPos.y }];
                    }
                }
                finishAnnotationStroke(side);
            }
            else if (state.annoTool !== 'image') {
                const docId = state.view[side].docId;
                if(docId) saveAnnotationsToDB(docId, state.annotations[docId]);
            }
        }
        
        renderAnnotations(side);
        setTimeout(() => renderTextLayer(side), 0);
    }
    
    state.drawing.active = false;
    e.target.releasePointerCapture(e.pointerId);
}

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
        if (e.key === 'z') { e.preventDefault(); undoLastStroke(); }
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
    state.lastActiveSide = side;
    saveSettings();
    renderMarkersForView(side);
}, 200);

function handleViewportZoom(e, side) {
    if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();

        const zoomSpeed = 0.009; 
        const delta = -e.deltaY * zoomSpeed;
        
        let currentLiveScale = state.zoomLive[side];
        let newLiveScale = currentLiveScale * (1 + delta);

        if (newLiveScale < 0.1) newLiveScale = 0.1;
        if (newLiveScale > 5.0) newLiveScale = 5.0;

        state.zoomLive[side] = newLiveScale;

        const wrapper = els[side + 'Wrapper'];
        wrapper.style.transform = `scale(${newLiveScale})`;
        wrapper.style.transformOrigin = 'top left'; 
        wrapper.style.zIndex = '10'; 

        const currentBaseScale = state.view[side].scale;
        const effectiveScale = currentBaseScale * newLiveScale;
        
        els[side + 'ZoomLevel'].innerText = Math.round(effectiveScale * 100) + '%';
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

    // Scroll so that point aligns back under the mouse
    viewport.scrollLeft = newPointX - mouseX;
    viewport.scrollTop = newPointY - mouseY;
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
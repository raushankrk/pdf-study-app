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
                page: state.view[clickedSide].pageNum,
                x: pos.x, y: pos.y
            };
            state.linkCreation.sourceSide = clickedSide;
            renderMarkersForView(clickedSide);
            els.currentPath.style.display = 'block';
        } else {
            // Second click: Set Target
            const targetData = {
                docId: state.view[clickedSide].docId,
                page: state.view[clickedSide].pageNum,
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
            const pageData = state.annotations[state.view[clickedSide].docId]?.[state.view[clickedSide].pageNum];
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
                            renderTextLayer(clickedSide);
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
                startAnnotationStroke(clickedSide, pos.x, pos.y);
            }
        }
    }
}

function startDirectTextManipulation(e, domElement, type) {
    const side = state.lastActiveSide;
    const wrapper = els[side + 'Wrapper'];
    const docId = state.view[side].docId;
    const pageNum = state.view[side].pageNum;
    
    if (!state.annotations[docId] || !state.annotations[docId][pageNum]) return;
    const pageData = state.annotations[docId][pageNum];
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
        if (state.view[sourceSide].docId === source.docId && state.view[sourceSide].pageNum === source.page) {
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
                            if (link.target.docId === state.view[side].docId && link.target.page === state.view[side].pageNum) {
                                link.target.x = img.x;
                                link.target.y = img.y + (img.h / 2);
                            } else if (link.source.docId === state.view[side].docId && link.source.page === state.view[side].pageNum) {
                                link.source.x = img.x;
                                link.source.y = img.y + (img.h / 2);
                            }
                        }
                    }
                });
                state.selection.selectedTextBoxes.forEach(tb => {
                    tb.x += dx;
                    tb.y += dy;
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
                            if (link.target.docId === state.view[side].docId && link.target.page === state.view[side].pageNum) {
                                link.target.x = img.x;
                                link.target.y = img.y + (img.h / 2);
                            } else if (link.source.docId === state.view[side].docId && link.source.page === state.view[side].pageNum) {
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
            continueAnnotationStroke(side, pos.x, pos.y);
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
            const pageNum = state.view[side].pageNum;
            
            if (!state.annotations[docId]) state.annotations[docId] = {};
            if (!state.annotations[docId][pageNum]) state.annotations[docId][pageNum] = { strokes: [], images: [], textBoxes: [] };

            const newBox = {
                id: 'tb_' + Date.now(),
                x: x, y: y, w: w, h: h,
                content: '',
                color: state.annoColor,
                fontSize: 14 
            };

            state.annotations[docId][pageNum].textBoxes.push(newBox);
            await saveAnnotationsToDB(docId, state.annotations[docId]);
            renderTextLayer(side);

            setTimeout(() => {
                const boxEl = els[side+'Wrapper'].querySelector(`.text-box[data-id="${newBox.id}"]`);
                if(boxEl) boxEl.focus();
            }, 0);
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
                    const pageNum = state.view[side].pageNum;
                    const pageData = state.annotations[docId]?.[pageNum];

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
            state.selection.mode = 'idle';
            if (state.annoTool !== 'text' && state.annoTool !== 'eraser-stroke' && state.annoTool !== 'image') {
                finishAnnotationStroke(side);
            } else if (state.annoTool !== 'image') {
                const docId = state.view[side].docId;
                if(docId) saveAnnotationsToDB(docId, state.annotations[docId]);
            }
        }
        
        renderAnnotations(side);
        renderTextLayer(side);
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
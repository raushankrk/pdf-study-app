// ==========================================
// 📁 7. pdf.js
// ==========================================
async function handleFileUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
        const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;
            const page = await pdfDoc.getPage(1);
            const viewport = page.getViewport({ scale: 0.2 }); 
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            const thumbData = canvas.toDataURL();

            const docObj = { id, file, pdfDoc, name: file.name, pageCount: pdfDoc.numPages, thumbnail: thumbData };
            state.documents[id] = docObj;
            await saveDocumentToDB({ id: docObj.id, name: docObj.name, pageCount: docObj.pageCount, thumbnail: docObj.thumbnail, fileBlob: file });

            if (!state.view.left.docId) setActiveDocument('left', id);
            else if (!state.view.right.docId) setActiveDocument('right', id);

        } catch (err) {
            console.error("Error loading PDF:", err);
            showModal("Error", `Could not load ${file.name}`);
        }
    }
    
    indexDocuments();
    renderDocList();
    els.uploadInput.value = ''; 
}

function renderDocList() {
    els.docList.innerHTML = '';
    const docIds = Object.keys(state.documents);
    
    if (docIds.length === 0) {
        els.emptyMsg.style.display = 'block';
        return;
    }
    els.emptyMsg.style.display = 'none';

    docIds.forEach(id => {
        const doc = state.documents[id];
        const isActiveLeft = state.view.left.docId === id;
        const isActiveRight = state.view.right.docId === id;

        const item = document.createElement('div');
        item.className = `group relative p-2 rounded-lg cursor-pointer border transition-all flex items-center gap-3 ${
            (isActiveLeft || isActiveRight) ? 'bg-blue-50 border-blue-200' : 'hover:bg-gray-50 border-transparent bg-white'
        }`;
        
        let badges = '';
        if (isActiveLeft) badges += `<span class="text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded ml-auto">L</span>`;
        if (isActiveRight) badges += `<span class="text-[10px] bg-green-500 text-white px-1.5 py-0.5 rounded ml-auto">R</span>`;

        item.innerHTML = `
            <img src="${doc.thumbnail}" class="w-10 h-12 object-cover rounded border border-gray-200 bg-gray-100">
            <div class="flex-1 min-w-0 overflow-hidden">
                <div id="doc-name-${id}" class="text-sm font-medium text-gray-800 truncate select-none" title="${doc.name}">${doc.name}</div>
                <div class="text-xs text-gray-500">${doc.pageCount} pages</div>
            </div>
            ${badges}
            
            <div class="doc-item-actions ml-2">
                <div class="action-btn action-rename" onclick="event.stopPropagation(); enableRename('${id}')" title="Rename">
                    <i class="fa-solid fa-pen"></i>
                </div>
                <div class="action-btn action-delete" onclick="event.stopPropagation(); deleteDocument('${id}')" title="Delete Document">
                    <i class="fa-solid fa-trash"></i>
                </div>
            </div>
        `;

        item.onclick = (e) => {
            if(e.target.tagName === 'INPUT') return;
            
            let targetSide = null;
            
            if (isActiveLeft) targetSide = 'right';
            else if (isActiveRight) targetSide = 'left';
            else {
                if (!state.view.left.docId) targetSide = 'left';
                else targetSide = 'right';
            }

            if (state.view[targetSide].locked) {
                const otherSide = targetSide === 'left' ? 'right' : 'left';
                if (!state.view[otherSide].locked) {
                    targetSide = otherSide;
                } else {
                    showModal("Viewport Locked", "Cannot open document: Both viewports are locked.");
                    return;
                }
            }

            setActiveDocument(targetSide, id);
            updateViewportActiveVisuals();
            renderDocList();
        };
        els.docList.appendChild(item);
    });
}

function setActiveDocument(side, docId, render = true) {
    state.view[side].docId = docId;
    state.view[side].pageNum = 1;
    state.view[side].scrollTop = 0; 
    state.lastActiveSide = side;
    clearSelection();
    closeViewportSearch(side); 
    saveSettings(); 
    if (render) {
        renderPage(side);
        renderDocList();
    }
}

async function renderPage(side) {
    const viewState = state.view[side];
    const docId = viewState.docId;
    const canvas = els[side + 'Canvas'];
    const ctx = canvas.getContext('2d');
    const annoCanvas = els[side + 'AnnoCanvas'];
    const annoCtx = annoCanvas.getContext('2d');
    const textLayer = els[side + 'TextLayer'];

    if (!docId || !state.documents[docId]) {
        canvas.width = 0; canvas.height = 0;
        annoCanvas.width = 0; annoCanvas.height = 0;
        textLayer.innerHTML = '';
        els[side + 'Title'].innerText = 'None';
        els[side + 'PageInput'].value = '';
        els[side + 'PageTotal'].innerText = '--';
        document.getElementById(side + '-markers-layer').innerHTML = '';
        els[side + 'Wrapper'].querySelectorAll('.text-box').forEach(e => e.remove());
        els[side + 'PageSlider'].classList.add('hidden');
        return;
    }
    if (state.zoomLive[side] !== 1.0) {
        const multiplier = state.zoomLive[side];
        viewState.scale = viewState.scale * multiplier;
        state.zoomLive[side] = 1.0; 
        
        const wrapper = els[side + 'Wrapper'];
        wrapper.style.transform = 'none';
        wrapper.style.zIndex = '';
    }
    
    const doc = state.documents[docId];
    els[side + 'Title'].innerText = doc.name;
    els[side + 'PageInput'].value = viewState.pageNum;
    els[side + 'PageTotal'].innerText = doc.pageCount;

    // Update Slider 
    els[side + 'PageSlider'].classList.remove('hidden');
    els[side + 'PageSlider'].max = doc.pageCount;
    els[side + 'PageSlider'].value = viewState.pageNum;

    try {
        const page = await doc.pdfDoc.getPage(viewState.pageNum);
        const scale = viewState.scale || 1.5;
        const viewport = page.getViewport({ scale: scale }); 

        canvas.width = viewport.width; canvas.height = viewport.height;
        annoCanvas.width = viewport.width; annoCanvas.height = viewport.height;

        const wrapper = els[side + 'Wrapper'];
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        const renderContext = { canvasContext: ctx, viewport: viewport };
        await page.render(renderContext).promise;

        const textContent = await page.getTextContent();
        renderTextLayerCustom(textContent, textLayer, viewport);

        const searchInput = document.getElementById(`${side}-search-input`);
        if (!searchInput.classList.contains('hidden') && searchInput.value) {
            renderSearchHighlights(side);
        }

        // ---- CITATION HIGHLIGHT LOGIC ----
        if (state.activeCitation && state.activeCitation.side === side) {
            // Check if we are physically on the target doc/page
            if (state.activeCitation.docId === docId && state.activeCitation.pageNum === viewState.pageNum) {
                const shouldScroll = !state.activeCitation.scrolled; 
                state.activeCitation.scrolled = true; // Ensure scrolling only happens once immediately after click
                highlightChunk(state.activeCitation.text, side, shouldScroll);
            } else {
                // If user navigates away, clear the state securely.
                state.activeCitation = null;
                if (typeof clearCitationHighlights === 'function') clearCitationHighlights(side);
            }
        } else {
            // Keep clean layer for unrelated views/side
            if (typeof clearCitationHighlights === 'function') clearCitationHighlights(side);
        }
        // ----------------------------------

        const viewportEl = els[side + 'Viewport'];
        if (viewState.scrollTop) viewportEl.scrollTop = viewState.scrollTop;

        renderMarkersForView(side);
        renderAnnotations(side);
        renderTextLayer(side);
    } catch (err) {
        console.error("Error rendering page:", err);
    }
}

function navigatePage(side, delta) {
    const viewState = state.view[side];
    if (!viewState.docId) return;
    const doc = state.documents[viewState.docId];
    const newPage = viewState.pageNum + delta;
    if (newPage >= 1 && newPage <= doc.pageCount) {
        viewState.pageNum = newPage;
        viewState.scrollTop = 0; 
        state.lastActiveSide = side;
        clearSelection();
        saveSettings(); 
        renderPage(side);
    }
}

// NEW: Function to handle direct page jumping from the input field
function jumpToPage(side) {
    const viewState = state.view[side];
    const input = els[side + 'PageInput'];
    
    if (!viewState.docId) {
        input.value = '';
        return;
    }

    const doc = state.documents[viewState.docId];
    let newPage = parseInt(input.value);

    // Validate bounds
    if (isNaN(newPage) || newPage < 1) newPage = 1;
    if (newPage > doc.pageCount) newPage = doc.pageCount;

    input.value = newPage; // Instantly correct the UI input value

    if (newPage !== viewState.pageNum) {
        viewState.pageNum = newPage;
        viewState.scrollTop = 0; 
        state.lastActiveSide = side;
        clearSelection();
        saveSettings(); 
        renderPage(side);
    }
}

// NEW: Slider-Specific syncing functions
window.syncPageInput = function(side) {
    const slider = els[side + 'PageSlider'];
    const input = els[side + 'PageInput'];
    if (slider && input) {
        input.value = slider.value;
        
        // Dynamic Tooltip that follows the slider thumb
        let tooltip = document.getElementById(side + '-slider-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = side + '-slider-tooltip';
            tooltip.className = 'absolute -top-7 transform -translate-x-1/2 bg-blue-600 text-white text-xs font-bold py-1 px-2.5 rounded shadow-lg pointer-events-none transition-opacity duration-150 z-50 whitespace-nowrap';
            slider.parentElement.style.position = 'relative';
            slider.parentElement.appendChild(tooltip);
        }

        const val = slider.value;
        const min = slider.min || 1;
        const max = slider.max || 1;
        const percent = max > min ? ((val - min) / (max - min)) * 100 : 0;
        
        // Perfect positioning by accounting for the width of the thumb handle (approx 14px)
        tooltip.style.left = `calc(${percent}% + ${7 - (percent * 0.14)}px)`;
        tooltip.innerText = `Page ${val}`;
        tooltip.style.opacity = '1';

        // Fade out tooltip after scrolling stops
        if (tooltip.timeoutId) clearTimeout(tooltip.timeoutId);
        tooltip.timeoutId = setTimeout(() => {
            tooltip.style.opacity = '0';
        }, 800);
    }
};

window.jumpToPageFromSlider = function(side) {
    const viewState = state.view[side];
    const slider = els[side + 'PageSlider'];
    
    if (!viewState.docId) {
        slider.value = 1;
        return;
    }

    const doc = state.documents[viewState.docId];
    let newPage = parseInt(slider.value);

    if (isNaN(newPage) || newPage < 1) newPage = 1;
    if (newPage > doc.pageCount) newPage = doc.pageCount;

    slider.value = newPage;

    if (newPage !== viewState.pageNum) {
        viewState.pageNum = newPage;
        viewState.scrollTop = 0; 
        state.lastActiveSide = side;
        clearSelection();
        saveSettings(); 
        renderPage(side);
    }
};


async function deleteDocument(id) {
    if(!confirm("Are you sure you want to delete this PDF and all its annotations/links?")) return;

    delete state.documents[id];
    delete state.annotations[id];

    const updatedLinks = state.links.filter(l => l.source.docId !== id && l.target.docId !== id);
    
    const tx = db.transaction(['documents', 'links', 'annotations'], 'readwrite');
    tx.objectStore('documents').delete(id);
    tx.objectStore('annotations').delete(id);
    
    const linkStore = tx.objectStore('links');
    linkStore.clear();
    updatedLinks.forEach(l => linkStore.put(l));
    state.links = updatedLinks;

    state.embeddings = state.embeddings.filter(e => e.docId !== id);

    if(state.view.left.docId === id) {
        state.view.left.docId = null;
        renderPage('left');
    }
    if(state.view.right.docId === id) {
        state.view.right.docId = null;
        renderPage('right');
    }

    renderDocList();
    renderMarkersForView('left');
    renderMarkersForView('right');
}

function enableRename(id) {
    const el = document.getElementById(`doc-name-${id}`);
    const currentName = state.documents[id].name;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'rename-input';
    
    const doSave = () => {
        saveRename(id, input.value);
    };

    input.onblur = doSave;
    
    input.onkeydown = (e) => {
        if(e.key === 'Enter') { input.blur(); } 
        else if (e.key === 'Escape') { renderDocList(); }
    };

    el.replaceWith(input);
    input.focus();
}

async function saveRename(id, newName) {
    if(!newName.trim()) { renderDocList(); return; }
    state.documents[id].name = newName;
    await saveDocumentToDB(state.documents[id]);
    renderDocList();
}

async function deleteCurrentPage(side) {
    const viewState = state.view[side];
    const docId = viewState.docId;
    const pageNum = viewState.pageNum;

    if (!docId) return;

    if (!confirm(`Delete page ${pageNum} from ${state.documents[docId].name}? This cannot be undone.`)) return;

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Deleting Page...";

    try {
        const originalDoc = state.documents[docId];
        if (originalDoc.pageCount <= 1) {
            showModal("Error", "Cannot delete only page in a document.");
            return;
        }

        const arrayBuffer = await originalDoc.file.arrayBuffer();
        const pdfLibDoc = await PDFDocument.load(arrayBuffer);

        pdfLibDoc.removePage(pageNum - 1);

        const newPdfBytes = await pdfLibDoc.save();
        const newBlob = new Blob([newPdfBytes], { type: 'application/pdf' });

        if (state.annotations[docId]) {
            const newAnnoMap = {};
            for(let i=1; i<pageNum; i++) {
                if(state.annotations[docId][i]) newAnnoMap[i] = state.annotations[docId][i];
            }
            for(let i=pageNum+1; i<=originalDoc.pageCount; i++) {
                if(state.annotations[docId][i]) newAnnoMap[i-1] = state.annotations[docId][i];
            }
            state.annotations[docId] = newAnnoMap;
            await saveAnnotationsToDB(docId, state.annotations[docId]);
        }

        state.embeddings.forEach(e => {
            if (e.docId === docId && e.pageNum > pageNum) {
                e.pageNum -= 1;
            }
        });

        const updatedLinks = [];
        for (const link of state.links) {
            let keepLink = true;
            const updatePoint = (pt) => {
                if (pt.docId === docId) {
                    if (pt.page === pageNum) keepLink = false; 
                    else if (pt.page > pageNum) return { ...pt, page: pt.page - 1 };
                }
                return pt;
            };
            const newSource = updatePoint(link.source);
            const newTarget = updatePoint(link.target);
            if(keepLink) {
                updatedLinks.push({ ...link, source: newSource, target: newTarget });
                await saveLinkToDB(updatedLinks[updatedLinks.length-1]);
            }
        }
        
        const tx = db.transaction(['links'], 'readwrite');
        const linkStore = tx.objectStore('links');
        linkStore.clear();
        updatedLinks.forEach(l => linkStore.put(l));
        state.links = updatedLinks;

        const newPdfJsDoc = await pdfjsLib.getDocument(newPdfBytes).promise;

        state.documents[docId].file = newBlob;
        state.documents[docId].pdfDoc = newPdfJsDoc;
        state.documents[docId].pageCount = newPdfJsDoc.numPages;

        await saveDocumentToDB({
            id: docId,
            name: originalDoc.name,
            pageCount: newPdfJsDoc.numPages,
            thumbnail: originalDoc.thumbnail,
            fileBlob: newBlob
        });

        if (state.view[side].pageNum > state.documents[docId].pageCount) {
            state.view[side].pageNum = state.documents[docId].pageCount;
        }
        
        const otherSide = side === 'left' ? 'right' : 'left';
        if(state.view[otherSide].docId === docId && state.view[otherSide].pageNum >= pageNum) {
            if (state.view[otherSide].pageNum > state.documents[docId].pageCount) {
                state.view[otherSide].pageNum = state.documents[docId].pageCount;
            }
            renderPage(otherSide);
        }

        renderPage(side);
        renderDocList();
        showModal("Success", "Page deleted successfully.");

    } catch (err) {
        console.error(err);
        showModal("Error", "Failed to delete page.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
}

async function insertPage(side, type) {
    const docId = state.view[side].docId;
    if (!docId) { showModal("Error", "No document loaded."); return; }

    const insertIndex = state.view[side].pageNum;
    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = "Processing PDF...";

    try {
        const originalDoc = state.documents[docId];
        const arrayBuffer = await originalDoc.file.arrayBuffer();
        const pdfLibDoc = await PDFDocument.load(arrayBuffer);

        const pages = pdfLibDoc.getPages();
        const refPageIndex = Math.max(0, Math.min(insertIndex - 1, pages.length - 1));
        const refPage = pages[refPageIndex];
        const { width, height } = refPage.getSize();

        if (type === 'blank') {
            pdfLibDoc.insertPage(insertIndex, [width, height]);
        } else if (type === 'duplicate') {
            const [copiedPage] = await pdfLibDoc.copyPages(pdfLibDoc, [refPageIndex]);
            pdfLibDoc.insertPage(insertIndex, copiedPage);
        }

        const newPdfBytes = await pdfLibDoc.save();
        const newBlob = new Blob([newPdfBytes], { type: 'application/pdf' });

        if (state.annotations[docId]) {
            const newAnnoMap = {};
            Object.keys(state.annotations[docId]).forEach(key => {
                const pageNum = parseInt(key);
                if (pageNum > insertIndex) {
                    newAnnoMap[pageNum + 1] = state.annotations[docId][pageNum];
                } else {
                    newAnnoMap[pageNum] = state.annotations[docId][pageNum];
                }
            });
            state.annotations[docId] = newAnnoMap;
            await saveAnnotationsToDB(docId, state.annotations[docId]);
        }

        state.embeddings.forEach(e => {
            if (e.docId === docId && e.pageNum > insertIndex) {
                e.pageNum += 1;
            }
        });

        const updatedLinks = [];
        for (const link of state.links) {
            const updatePoint = (pt) => {
                if (pt.docId === docId && pt.page > insertIndex) {
                    return { ...pt, page: pt.page + 1 };
                }
                return pt;
            };
            const newLink = {
                ...link,
                source: updatePoint(link.source),
                target: updatePoint(link.target)
            };
            updatedLinks.push(newLink);
            await saveLinkToDB(newLink);
        }
        state.links = updatedLinks;

        const newPdfJsDoc = await pdfjsLib.getDocument(newPdfBytes).promise;

        state.documents[docId].file = newBlob;
        state.documents[docId].pdfDoc = newPdfJsDoc;
        state.documents[docId].pageCount = newPdfJsDoc.numPages;

        await saveDocumentToDB({
            id: docId,
            name: originalDoc.name,
            pageCount: newPdfJsDoc.numPages,
            thumbnail: originalDoc.thumbnail,
            fileBlob: newBlob
        });

        state.view[side].pageNum = insertIndex + 1;
        
        renderPage(side);
        renderDocList();
        showModal("Success", `${type === 'blank' ? 'Blank' : 'Duplicated'} page added.`);

    } catch (err) {
        console.error(err);
        showModal("Error", "Failed to process PDF.");
    } finally {
        els.loadingSpinner.classList.add('hidden');
    }
}

function renderTextLayerCustom(textContent, textLayerDiv, viewport) {
    textLayerDiv.innerHTML = '';
    const textItems = textContent.items;
    for (let item of textItems) {
        if (item.str.length === 0) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontSize = Math.sqrt((tx[0] * tx[0]) + (tx[1] * tx[1]));
        const div = document.createElement('span');
        div.textContent = item.str;
        const left = tx[4];
        const top = tx[5] - fontSize; 
        const width = tx[0] * item.width; 
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.fontSize = `${fontSize}px`;
        div.style.fontFamily = item.fontName || 'sans-serif';
        div.style.width = `${width}px`;
        textLayerDiv.appendChild(div);
    }
}

function zoomViewport(side, delta) {
    const currentScale = state.view[side].scale;
    let newScale = currentScale + delta;
    if (newScale < 0.25) newScale = 0.25;
    if (newScale > 5.0) newScale = 5.0;
    state.view[side].scale = newScale;
    updateZoomIndicator(side);
    renderPage(side);
    saveSettings();
}

function resetZoom(side) {
    state.view[side].scale = 1.0;
    updateZoomIndicator(side);
    renderPage(side);
    saveSettings();
}

function commitZoom(side) {
    const liveScale = state.zoomLive[side];
    const baseScale = state.view[side].scale;
    const finalScale = baseScale * liveScale;

    state.zoomLive[side] = 1.0;

    if (finalScale < 0.25) state.view[side].scale = 0.25;
    else if (finalScale > 5.0) state.view[side].scale = 5.0;
    else state.view[side].scale = finalScale;

    const wrapper = els[side + 'Wrapper'];
    wrapper.style.transform = 'none';
    wrapper.style.zIndex = ''; 

    updateZoomIndicator(side);
    renderPage(side);
    saveSettings();
}
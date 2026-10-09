// ==========================================
// 📁 7. pdf.js
// ==========================================

// ---- Lazy document loading ----
// On app boot, state.documents[id] contains metadata only — no PDF bytes.
// We fetch the PDF + annotations on demand when a document is first opened
// in a viewport. This keeps memory low for 100+ PDF libraries and makes
// the app responsive on iPad/phone.
async function ensureDocLoaded(docId) {
    if (!state.documents[docId]) return;
    const doc = state.documents[docId];
    if (doc.pdfDoc) return;  // already loaded

    try {
        // Fetch the PDF bytes from the server.
        const blob = await Api.fetchDocumentBlob(docId);
        doc.file = blob;
        const arrayBuffer = await blob.arrayBuffer();
        doc.pdfDoc = await pdfjsLib.getDocument(arrayBuffer).promise;

        // If pageIds are missing (e.g. legacy import), generate them now.
        if (!doc.pageIds || doc.pageIds.length !== doc.pdfDoc.numPages) {
            doc.pageIds = Array.from({ length: doc.pdfDoc.numPages }, () => generateId());
            // Persist the pageIds back to the server.
            _saveDocById(docId);
        }

        // Lazy-load annotations for this doc (if not already loaded).
        if (!state.annotations[docId]) {
            await loadAnnotationsFromServer(docId);
        }
    } catch (err) {
        console.error('Failed to load document:', docId, err);
        showModal('Load Error', `Could not load PDF: ${escapeHtml(String(err))}`);
    }
}

async function handleFileUpload(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    // Place imports into the currently selected folder (or Root if none).
    const targetFolderId = state.currentFolderId || ROOT_FOLDER_ID;

    els.loadingSpinner.classList.remove('hidden');
    els.loadingSpinner.querySelector('span').innerText = `Uploading ${files.length} file(s)...`;

    try {
        // Upload all files to the server in one request.
        const result = await Api.uploadDocuments(files, targetFolderId);
        const uploaded = result.uploaded || [];

        // For each uploaded doc, fetch its full metadata and add to state.
        for (const item of uploaded) {
            if (item.error) {
                console.error('Upload failed for', item.filename, item.error);
                continue;
            }
            const fullDoc = await Api.getDocument(item.id);
            state.documents[item.id] = {
                id: fullDoc.id,
                name: fullDoc.name,
                file: null,           // Lazy-loaded later via ensureDocLoaded()
                pdfDoc: null,
                pageCount: fullDoc.pageCount,
                thumbnail: fullDoc.thumbnail,
                pageIds: fullDoc.pageIds || [],
                folderId: fullDoc.folderId || 'root',
                fileSize: fullDoc.fileSize || 0,
                createdAt: fullDoc.createdAt,
                modifiedAt: fullDoc.modifiedAt,
                favorite: !!fullDoc.favorite,
                fileHash: fullDoc.fileHash,
            };

            // Open the first uploaded doc in a viewport
            if (!state.view.left.docId) setActiveDocument('left', item.id);
            else if (!state.view.right.docId) setActiveDocument('right', item.id);
            pushRecentDoc(item.id);
        }

        if (uploaded.length > 0) {
            // Trigger server-side indexing for the new docs.
            indexDocuments(false);
        }
    } catch (err) {
        console.error('Upload failed:', err);
        showModal('Upload Error', `Could not upload files: ${escapeHtml(String(err))}`);
    } finally {
        renderDocList();
        els.loadingSpinner.classList.add('hidden');
        els.uploadInput.value = '';
    }
}

// renderDocList now delegates to the file-explorer renderer (filemanager.js).
// The same name is kept for backward compatibility — every existing call site
// (deleteDocument, handleFileUpload, app.js boot, project import, etc.) keeps working.
function renderDocList() {
    // Build the unified file-explorer view: folder tree + breadcrumb + file list.
    // The DOM containers (#folder-tree, #file-breadcrumbs, #file-list) live in index.html.
    if (typeof _renderFolderTree === 'function') _renderFolderTree();
    if (typeof _renderBreadcrumbs === 'function') _renderBreadcrumbs();
    if (typeof _renderFileList === 'function') _renderFileList();
    if (typeof renderRecentFiles === 'function') renderRecentFiles();
}

function setActiveDocument(side, docId, render = true) {
    const doc = state.documents[docId];
    state.view[side].docId = docId;
    state.view[side].pageNum = 1;
    state.view[side].pageId = pageIdFromNum(doc, 1);
    state.view[side].scrollTop = 0;
    state.lastActiveSide = side;
    clearSelection();
    closeViewportSearch(side);
    saveSettings();
    // Track this doc as recently opened (silently — no UI re-render of explorer list itself).
    if (typeof pushRecentDoc === 'function') pushRecentDoc(docId);
    if (render) {
        renderPage(side);
        renderDocList();
    }
}

async function renderPage(side) {
    const viewState = state.view[side];
    const docId = viewState.docId;

    if (!docId || !state.documents[docId]) {
        const canvas = els[side + 'Canvas'];
        const annoCanvas = els[side + 'AnnoCanvas'];
        const textLayer = els[side + 'TextLayer'];
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

    // LAZY LOAD: fetch PDF bytes from server the first time this doc is rendered.
    await ensureDocLoaded(docId);

    const doc = state.documents[docId];
    if (!doc.pdfDoc) {
        // Failed to load — ensureDocLoaded already showed an error modal.
        return;
    }

    // pageId is the source of truth; keep pageNum in sync for display/back-compat
    if (viewState.pageId) {
        const resolvedNum = pageNumFromId(doc, viewState.pageId);
        if (resolvedNum) viewState.pageNum = resolvedNum;
    }

    const canvas = els[side + 'Canvas'];
    const annoCanvas = els[side + 'AnnoCanvas'];
    const textLayer = els[side + 'TextLayer'];

    if (state.zoomLive[side] !== 1.0) {
        const multiplier = state.zoomLive[side];
        viewState.scale = viewState.scale * multiplier;
        state.zoomLive[side] = 1.0;

        const wrapper = els[side + 'Wrapper'];
        wrapper.style.transform = 'none';
        wrapper.style.transformOrigin = '';
        wrapper.style.zIndex = '';
    }

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

        // When a zoom commit is in progress, render the PDF to an
        // offscreen canvas so the visible canvas is never blank.
        const isCommitRender = state._commitFocus && state._commitFocus.side === side;
        const pdfCanvas = isCommitRender ? document.createElement('canvas') : canvas;
        const pdfCtx = pdfCanvas.getContext('2d');

        pdfCanvas.width = viewport.width; pdfCanvas.height = viewport.height;

        // Only resize the annotation canvas directly in non-commit mode.
        // In commit mode the annoCanvas already has upscaled content from
        // commitZoom's atomic swap — renderAnnotations() will redraw it.
        if (!isCommitRender) {
            annoCanvas.width = viewport.width; annoCanvas.height = viewport.height;
        }

        const wrapper = els[side + 'Wrapper'];
        wrapper.style.width = `${viewport.width}px`;
        wrapper.style.height = `${viewport.height}px`;

        const renderContext = { canvasContext: pdfCtx, viewport: viewport };
        await page.render(renderContext).promise;

        // If we rendered offscreen, copy to the visible canvas now.
        // This swap is synchronous — the user never sees a blank frame.
        if (isCommitRender) {
            canvas.width = viewport.width; canvas.height = viewport.height;
            canvas.getContext('2d').drawImage(pdfCanvas, 0, 0);
            // Resize annoCanvas to match so renderAnnotations() draws
            // at the correct scale. It clears and redraws moments later.
            annoCanvas.width = viewport.width; annoCanvas.height = viewport.height;
        }

        const textContent = await page.getTextContent();
        renderTextLayerCustom(textContent, textLayer, viewport);

        const searchInput = document.getElementById(`${side}-search-input`);
        if (!searchInput.classList.contains('hidden') && searchInput.value) {
            renderSearchHighlights(side);
        }

        // ---- CITATION HIGHLIGHT LOGIC ----
        if (state.activeCitation && state.activeCitation.side === side) {
            // Check if we are physically on the target doc/page (by stable pageId)
            if (state.activeCitation.docId === docId && state.activeCitation.pageId === viewState.pageId) {
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
        // If a zoom-commit focus is pending, commitZoom will set the scroll
        // after this render completes — don't snap back to the old scrollTop.
        if (viewState.scrollTop && !state._commitFocus) {
            viewportEl.scrollTop = viewState.scrollTop;
        }

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
        viewState.pageId = pageIdFromNum(doc, newPage);
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
        viewState.pageId = pageIdFromNum(doc, newPage);
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
        viewState.pageId = pageIdFromNum(doc, newPage);
        viewState.scrollTop = 0; 
        state.lastActiveSide = side;
        clearSelection();
        saveSettings(); 
        renderPage(side);
    }
};


async function deleteDocument(id) {
    const doc = state.documents[id];
    const docName = doc ? doc.name : 'this PDF';
    if(!confirm(`Are you sure you want to delete "${docName}" and all its annotations/links? This cannot be undone.`)) return;

    // Use the shared internal deleter (keeps recent/embeddings/links/annotations in sync).
    await _deleteDocumentRecord(id);

    if(state.view.left.docId === id) {
        state.view.left.docId = null;
        renderPage('left');
    }
    if(state.view.right.docId === id) {
        state.view.right.docId = null;
        renderPage('right');
    }

    // Remove from file selection if present.
    state.fileSelection.docIds.delete(id);

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
    newName = (newName || '').trim();
    if(!newName) { renderDocList(); return; }
    const doc = state.documents[id];
    if (!doc) return;
    // If name is unchanged, no-op.
    if (doc.name === newName) { renderDocList(); return; }
    // Avoid duplicate names inside the same folder.
    const conflicting = Object.values(state.documents).some(d =>
        d.id !== id &&
        d.folderId === doc.folderId &&
        d.name.toLowerCase() === newName.toLowerCase()
    );
    if (conflicting) {
        showModal("Duplicate Name", `A file named "${newName}" already exists in this folder.`);
        renderDocList();
        return;
    }
    doc.name = newName;
    doc.modifiedAt = Date.now();
    // Persist asynchronously — but re-render immediately so the UI reflects the new name
    // without waiting for the IndexedDB write to complete.
    if (typeof _saveDocById === 'function') _saveDocById(id);
    renderDocList();
}

async function deleteCurrentPage(side) {
    const viewState = state.view[side];
    const docId = viewState.docId;
    const pageNum = viewState.pageNum;
    const deletedPageId = viewState.pageId;

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

        // --- STABLE ID UPDATE: only the pageIds array shrinks. No page-number math anywhere else. ---
        const newPageIds = originalDoc.pageIds.filter(pid => pid !== deletedPageId);
        originalDoc.pageIds = newPageIds;

        // Drop annotations/textboxes/images that lived on the deleted page. Everything else is untouched.
        if (state.annotations[docId] && state.annotations[docId][deletedPageId]) {
            delete state.annotations[docId][deletedPageId];
            await saveAnnotationsToDB(docId, state.annotations[docId]);
        }

        // Embeddings tied to the deleted page are removed; all others keep their pageId unchanged.
        state.embeddings = state.embeddings.filter(e => !(e.docId === docId && e.pageId === deletedPageId));

        // Links: drop any link whose endpoint was on the deleted page; all surviving links are untouched
        // since they reference pageId, not a page number.
        const updatedLinks = [];
        for (const link of state.links) {
            const sourceDead = link.source.docId === docId && link.source.pageId === deletedPageId;
            const targetDead = link.target.docId === docId && link.target.pageId === deletedPageId;
            if (sourceDead || targetDead) {
                await deleteLinkFromDB(link.id);
                continue;
            }
            updatedLinks.push(link);
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
            fileBlob: newBlob,
            pageIds: newPageIds
        });

        // Re-resolve pageNum for any view pointing at this doc, since page numbers after the
        // deletion point shifted by 1 automatically (pageId lookup handles this for free).
        const clampView = (vSide) => {
            const v = state.view[vSide];
            if (v.docId !== docId) return;
            if (v.pageId && newPageIds.includes(v.pageId)) {
                v.pageNum = pageNumFromId(state.documents[docId], v.pageId);
            } else {
                // The page this view was on just got deleted — fall back to the same index, clamped.
                const fallbackNum = Math.min(pageNum, state.documents[docId].pageCount);
                v.pageNum = fallbackNum;
                v.pageId = pageIdFromNum(state.documents[docId], fallbackNum);
            }
        };
        clampView('left');
        clampView('right');

        renderPage('left');
        renderPage('right');
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

    const insertIndex = state.view[side].pageNum; // new page is inserted right after this page number
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

        // --- STABLE ID UPDATE: just splice a new UUID into pageIds. ---
        // All existing annotations/links/embeddings keep the same pageId they already had,
        // so nothing else needs to shift.
        const newPageId = generateId();
        const newPageIds = [...originalDoc.pageIds];
        newPageIds.splice(insertIndex, 0, newPageId); // insertIndex is 0-based slot right after the ref page
        originalDoc.pageIds = newPageIds;

        const newPdfJsDoc = await pdfjsLib.getDocument(newPdfBytes).promise;

        state.documents[docId].file = newBlob;
        state.documents[docId].pdfDoc = newPdfJsDoc;
        state.documents[docId].pageCount = newPdfJsDoc.numPages;

        await saveDocumentToDB({
            id: docId,
            name: originalDoc.name,
            pageCount: newPdfJsDoc.numPages,
            thumbnail: originalDoc.thumbnail,
            fileBlob: newBlob,
            pageIds: newPageIds
        });

        state.view[side].pageNum = insertIndex + 1;
        state.view[side].pageId = newPageId;

        // The other side, if pointing at the same doc, keeps its pageId — its pageNum
        // is simply re-resolved on next renderPage (it may shift by one, correctly).
        renderPage(side);
        const otherSide = side === 'left' ? 'right' : 'left';
        if (state.view[otherSide].docId === docId) renderPage(otherSide);

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

function commitZoom(side, focusScreenX, focusScreenY) {
    const viewport = els[side + 'Viewport'];
    const wrapper = els[side + 'Wrapper'];
    const canvas = els[side + 'Canvas'];
    const annoCanvas = els[side + 'AnnoCanvas'];
    const textLayer = els[side + 'TextLayer'];
    const liveScale = state.zoomLive[side];

    // If liveScale is 1.0, nothing to commit.
    if (liveScale === 1.0 || !liveScale) {
        wrapper.style.transform = 'none';
        wrapper.style.transformOrigin = '';
        wrapper.style.zIndex = '';
        return;
    }

    const baseScale = state.view[side].scale;
    let finalScale = baseScale * liveScale;
    finalScale = Math.max(0.25, Math.min(5.0, finalScale));

    // ---- Capture focus info BEFORE any visual changes ----
    const wrapperRect = wrapper.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const fracX = wrapperRect.width > 0
        ? Math.max(0, Math.min(1, (focusScreenX - wrapperRect.left) / wrapperRect.width))
        : 0.5;
    const fracY = wrapperRect.height > 0
        ? Math.max(0, Math.min(1, (focusScreenY - wrapperRect.top) / wrapperRect.height))
        : 0.5;
    const vpX = focusScreenX - viewportRect.left;
    const vpY = focusScreenY - viewportRect.top;

    // ---- Step 1: Upscale existing canvas to new size (synchronous) ----
    // This gives us a full-size placeholder that looks identical to the
    // CSS-transformed version, so the visual never blanks out.
    const newW = Math.round(canvas.width * liveScale);
    const newH = Math.round(canvas.height * liveScale);

    const tmpPdf = document.createElement('canvas');
    tmpPdf.width = newW; tmpPdf.height = newH;
    tmpPdf.getContext('2d').drawImage(canvas, 0, 0, newW, newH);

    const tmpAnno = document.createElement('canvas');
    tmpAnno.width = newW; tmpAnno.height = newH;
    tmpAnno.getContext('2d').drawImage(annoCanvas, 0, 0, newW, newH);

    // ---- Step 2: Update state ----
    state.view[side].scale = finalScale;
    state.zoomLive[side] = 1.0;

    // Tell renderPage to render PDF to an offscreen canvas (no blank frame).
    state._commitFocus = { side, fracX, fracY, vpX, vpY };

    // Hide text layer and text-box overlays — they are at the old scale
    // and will be recreated at the correct scale by renderPage.
    textLayer.style.visibility = 'hidden';
    wrapper.querySelectorAll('.text-box').forEach(el => el.style.visibility = 'hidden');

    // ---- Step 3: Atomic swap in a single animation frame ----
    // Resize wrapper, swap canvas content, clear transform, set scroll —
    // all synchronously so there is zero visible gap.
    requestAnimationFrame(() => {
        wrapper.style.width = newW + 'px';
        wrapper.style.height = newH + 'px';

        canvas.width = newW; canvas.height = newH;
        canvas.getContext('2d').drawImage(tmpPdf, 0, 0);

        annoCanvas.width = newW; annoCanvas.height = newH;
        annoCanvas.getContext('2d').drawImage(tmpAnno, 0, 0);

        wrapper.style.transform = 'none';
        wrapper.style.transformOrigin = '';
        wrapper.style.zIndex = '';

        // Scroll so the focus point stays at the same screen position.
        // Must include wrapper.offsetLeft/offsetTop for correct positioning.
        viewport.scrollLeft = wrapper.offsetLeft + fracX * newW - vpX;
        viewport.scrollTop = wrapper.offsetTop + fracY * newH - vpY;
        state.view[side].scrollTop = viewport.scrollTop;

        updateZoomIndicator(side);
        saveSettings();

        // ---- Step 4: Background sharp re-render ----
        // renderPage will render to an offscreen canvas (because _commitFocus
        // is set), then copy to the visible canvas — no blank frame.
        renderPage(side).then(() => {
            if (state._commitFocus && state._commitFocus.side === side) {
                const f = state._commitFocus;
                // Re-adjust scroll for potentially slightly different
                // dimensions from the PDF.js viewport calculation.
                viewport.scrollLeft = wrapper.offsetLeft + f.fracX * wrapper.offsetWidth - f.vpX;
                viewport.scrollTop = wrapper.offsetTop + f.fracY * wrapper.offsetHeight - f.vpY;
                state.view[side].scrollTop = viewport.scrollTop;
                state._commitFocus = null;
            }
        });
    });
}
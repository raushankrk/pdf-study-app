// ==========================================
// 📁 8. search.js
// ==========================================
function toggleViewportSearch(side) {
    const input = document.getElementById(`${side}-search-input`);
    const nav = document.getElementById(`${side}-search-nav`);
    if (input.classList.contains('hidden')) {
        input.classList.remove('hidden');
        nav.classList.remove('hidden');
        input.focus();
    } else {
        input.focus();
    }
}

function closeViewportSearch(side) {
    const input = document.getElementById(`${side}-search-input`);
    const nav = document.getElementById(`${side}-search-nav`);
    input.classList.add('hidden');
    nav.classList.add('hidden');
    input.value = '';
    clearSearchHighlights(side);
    state.search[side] = { query: '', results: [], index: -1, abortController: null };
}

async function performViewportSearch(side, targetPageNum = null) {
    const input = document.getElementById(`${side}-search-input`);
    const query = input.value.trim().toLowerCase();
    const docId = state.view[side].docId;

    if (!query || !docId) {
        clearSearchHighlights(side);
        state.search[side] = { query: '', results: [], index: -1, abortController: null };
        updateSearchCount(side);
        return;
    }

    if (state.search[side].query === query && !targetPageNum) {
        renderSearchHighlights(side);
        return;
    }

    if (state.search[side].abortController) {
        state.search[side].abortController.abort();
    }

    const abortController = new AbortController();
    state.search[side].abortController = abortController;
    state.search[side].query = query;

    const doc = state.documents[docId];
    const allMatches = [];
    const maxPage = Math.min(doc.pageCount, 500); 
    const measureCtx = state.measureCanvas.getContext('2d');

    for (let i = 1; i <= maxPage; i++) {
        if (abortController.signal.aborted) break;

        try {
            const page = await doc.pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            const viewport = page.getViewport({ scale: state.view[side].scale });

            for (let itemIdx = 0; itemIdx < textContent.items.length; itemIdx++) {
                const item = textContent.items[itemIdx];
                const textStr = item.str.toLowerCase();
                
                if (textStr.includes(query)) {
                    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                    const left = tx[4];
                    const bottom = tx[5];
                    const fontSize = Math.sqrt((tx[0] * tx[0]) + (tx[1] * tx[1]));
                    const top = bottom - fontSize;
                    
                    let searchIndex = 0;
                    let matchIndex;
                    while ((matchIndex = textStr.indexOf(query, searchIndex)) !== -1) {
                        const cssFontFamily = getCssFontFamily(item.fontName);
                        measureCtx.font = `${fontSize}px ${cssFontFamily}`;
                        const prefixStr = item.str.substring(0, matchIndex);
                        const prefixWidth = measureCtx.measureText(prefixStr).width;
                        const matchStr = item.str.substring(matchIndex, matchIndex + query.length);
                        const matchWidth = measureCtx.measureText(matchStr).width;

                        const matchLeft = left + prefixWidth;
                        
                        allMatches.push({
                            page: i,
                            index: itemIdx, 
                            x: matchLeft,
                            y: top,
                            w: matchWidth,
                            h: fontSize
                        });

                        searchIndex = matchIndex + 1;
                    }
                }
            }
        } catch (e) { }
    }

    state.search[side].results = allMatches;
    let startIndex = 0;
    if (targetPageNum) {
        startIndex = allMatches.findIndex(m => m.page === targetPageNum);
    } else {
        const currentMatches = allMatches.filter(m => m.page === state.view[side].pageNum);
        if (currentMatches.length > 0) {
            startIndex = allMatches.indexOf(currentMatches[0]);
        } else if (allMatches.length > 0) {
            startIndex = 0;
        }
    }
    
    if (startIndex === -1) startIndex = 0;
    state.search[side].index = startIndex;
    
    const targetMatch = allMatches[startIndex];
    if (targetPageNum && targetMatch && targetMatch.page !== state.view[side].pageNum) {
        state.view[side].pageNum = targetMatch.page;
        renderPage(side); 
    } else {
        renderSearchHighlights(side);
    }
    
    updateSearchCount(side);
}

function clearSearchHighlights(side) {
    document.getElementById(`${side}-search-layer`).innerHTML = '';
}

function renderSearchHighlights(side) {
    const container = document.getElementById(`${side}-search-layer`);
    container.innerHTML = '';
    
    const currentPage = state.view[side].pageNum;
    const pageMatches = state.search[side].results.filter(m => m.page === currentPage);
    const activeGlobalIndex = state.search[side].index;
    
    pageMatches.forEach((res) => {
        const globalIdx = state.search[side].results.indexOf(res);
        const div = document.createElement('div');
        div.className = 'search-highlight' + (globalIdx === activeGlobalIndex ? ' active' : '');
        div.style.left = `${res.x}px`;
        div.style.top = `${res.y}px`;
        div.style.width = `${res.w}px`;
        div.style.height = `${res.h}px`;
        container.appendChild(div);
    });
}

function updateSearchCount(side) {
    const total = state.search[side].results.length;
    const current = total > 0 ? state.search[side].index + 1 : 0;
    document.getElementById(`${side}-search-count`).innerText = `${current}/${total}`;
}

function navigateSearchResult(side, dir) {
    const results = state.search[side].results;
    if (results.length === 0) return;
    
    let newIndex = state.search[side].index + dir;
    if (newIndex < 0) newIndex = results.length - 1;
    if (newIndex >= results.length) newIndex = 0;
    
    state.search[side].index = newIndex;
    const match = results[newIndex];
    
    if (match.page !== state.view[side].pageNum) {
        state.view[side].pageNum = match.page;
        renderPage(side);
    } else {
        renderSearchHighlights(side);
    }
    updateSearchCount(side);
}

async function performGlobalSearch() {
    const query = els.globalSearchInput.value.trim().toLowerCase();
    const container = els.globalSearchResults;
    container.innerHTML = '';

    if (!query) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    container.innerHTML = '<div class="text-xs text-gray-400 p-2 text-center">Searching...</div>';

    let allMatches = [];

    for (const docId of Object.keys(state.documents)) {
        const doc = state.documents[docId];
        const maxPage = Math.min(doc.pageCount, 100); 
        
        for (let i = 1; i <= maxPage; i++) {
            try {
                const page = await doc.pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const foundOnPage = textContent.items.some(item => item.str.toLowerCase().includes(query));
                if (foundOnPage) {
                    allMatches.push({
                        docId: docId,
                        docName: doc.name,
                        page: i
                    });
                }
            } catch(e) { }
        }
    }

    container.innerHTML = '';
    if (allMatches.length === 0) {
        container.innerHTML = '<div class="text-xs text-gray-500 p-2">No matches found.</div>';
        return;
    }

    allMatches.forEach(match => {
        const div = document.createElement('div');
        div.className = 'p-2 border-b border-gray-100 search-result-item hover:bg-blue-50';
        div.innerHTML = `
            <div class="font-bold text-xs text-gray-700 truncate">${match.docName}</div>
            <div class="text-[10px] text-blue-600">Page ${match.page}</div>
        `;

        div.onclick = async () => {
            let side = state.lastActiveSide; 
            
            if (state.view[side].locked) {
                const otherSide = side === 'left' ? 'right' : 'left';
                if (!state.view[otherSide].locked) {
                    side = otherSide;
                } else {
                    showModal("Viewport Locked", "Cannot navigate: Both viewports are locked.");
                    return;
                }
            }

            state.view[side].docId = match.docId;
            state.view[side].pageNum = match.page;
            state.view[side].scrollTop = 0;
            
            const input = document.getElementById(`${side}-search-input`);
            input.value = query;
            input.classList.remove('hidden');
            document.getElementById(`${side}-search-nav`).classList.remove('hidden');

            await performViewportSearch(side, match.page);
            
            renderPage(side);
            renderDocList();
        };
        container.appendChild(div);
    });
}

async function highlightChunk(text, side) {
    const layer = document.getElementById(`${side}-search-layer`);
    layer.innerHTML = ''; 
    const viewState = state.view[side];
    const docId = viewState.docId;
    if (!docId || !state.documents[docId]) return;

    try {
        const page = await state.documents[docId].pdfDoc.getPage(viewState.pageNum);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: viewState.scale });
        
        const searchTerm = text.substring(0, 80).trim().toLowerCase().replace(/\s+/g, ' ');
        const searchWords = searchTerm.split(' ').filter(w => w.length > 2);
        
        const itemsWithPos = textContent.items.map(item => ({
            item,
            text: item.str,
            lower: item.str.toLowerCase()
        }));

        let bestMatchItems = [];
        let bestScore = 0;

        for (let start = 0; start < itemsWithPos.length; start++) {
            for (let len = 1; len <= Math.min(8, itemsWithPos.length - start); len++) {
                const group = itemsWithPos.slice(start, start + len);
                const groupText = group.map(g => g.lower).join(' ');
                
                const matchCount = searchWords.filter(w => groupText.includes(w)).length;
                const score = matchCount / searchWords.length;

                if (score > bestScore && score > 0.5) {
                    bestScore = score;
                    bestMatchItems = group.map(g => g.item);
                }
            }
        }

        bestMatchItems.forEach(item => {
            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const left = tx[4];
            const bottom = tx[5];
            const fontSize = Math.sqrt((tx[0] * tx[0]) + (tx[1] * tx[1]));
            const top = bottom - fontSize;

            const measureCtx = state.measureCanvas.getContext('2d');
            const cssFontFamily = getCssFontFamily(item.fontName);
            measureCtx.font = `${fontSize}px ${cssFontFamily}`;
            const textWidth = measureCtx.measureText(item.str).width;

            const div = document.createElement('div');
            div.className = 'citation-highlight';
            div.style.left = `${left}px`;
            div.style.top = `${top}px`;
            div.style.width = `${textWidth}px`;
            div.style.height = `${fontSize + 2}px`;
            layer.appendChild(div);
        });

        if (bestMatchItems.length > 0) {
            const firstItem = bestMatchItems[0];
            const tx = pdfjsLib.Util.transform(
                page.getViewport({ scale: viewState.scale }).transform, 
                firstItem.transform
            );
            const viewport_el = els[side + 'Viewport'];
            const elementTop = tx[5];
            viewport_el.scrollTo({ 
                top: elementTop - viewport_el.clientHeight / 2, 
                behavior: 'smooth' 
            });
        }

    } catch (e) {
        console.error("Error highlighting chunk", e);
    }
}

// ==========================================
// 📁 10. links.js
// ==========================================
function renderMarkersForView(side) {
    const container = document.getElementById(side + '-markers-layer');
    container.innerHTML = ''; 
    const viewState = state.view[side];
    if (!viewState.docId) return;

    const relevantLinks = state.links.filter(link => 
        (link.source.docId === viewState.docId && link.source.page === viewState.pageNum) ||
        (link.target.docId === viewState.docId && link.target.page === viewState.pageNum)
    );

    let targetMarkerElement = null;

    relevantLinks.forEach(link => {
        let isSource = (link.source.docId === viewState.docId && link.source.page === viewState.pageNum);
        let pointData = isSource ? link.source : link.target;

        const btn = document.createElement('div');
        btn.className = 'link-marker';
        btn.dataset.linkId = link.id; 
        
        const targetDocName = state.documents[isSource ? link.target.docId : link.source.docId]?.name || 'Unknown';
        const targetPage = isSource ? link.target.page : link.source.page;
        btn.title = `Jump to: ${targetDocName} (Page ${targetPage})`;
        
        const wrapper = els[side + 'Wrapper'];
        const x = pointData.x * wrapper.offsetWidth;
        const y = pointData.y * wrapper.offsetHeight;

        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;
        btn.innerHTML = '<i class="fa-solid fa-link"></i>';

        if (state.highlightRequest && 
            state.highlightRequest.side === side && 
            state.highlightRequest.linkId === link.id) {
            
            btn.classList.add('marker-active');
            targetMarkerElement = btn;
            setTimeout(() => {
                state.highlightRequest = null;
                btn.classList.remove('marker-active');
            }, 3000);
        }

        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault(); 
            if(state.appMode === 'delete-link') {
                deleteLink(link.id);
            } else {
                followLink(link, side);
            }
        };

        container.appendChild(btn);
    });

    if (targetMarkerElement) {
        const viewport = els[side + 'Viewport'];
        const elementTop = targetMarkerElement.offsetTop;
        const viewportHeight = viewport.clientHeight;
        const elementHeight = targetMarkerElement.clientHeight;
        const scrollTo = elementTop - (viewportHeight / 2) + (elementHeight / 2);
        viewport.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }
}

function followLink(link, fromSide) {
    const isFromSource = (link.source.docId === state.view[fromSide].docId);
    const targetData = isFromSource ? link.target : link.source;
    const otherSide = fromSide === 'left' ? 'right' : 'left';

    state.highlightRequest = { side: otherSide, linkId: link.id };
    state.view[otherSide].docId = targetData.docId;
    state.view[otherSide].pageNum = targetData.page;
    state.view[otherSide].scrollTop = 0; 
    
    clearSelection();
    saveSettings(); 
    renderPage(otherSide);
}

async function deleteLink(linkId) {
    const idx = state.links.findIndex(l => l.id === linkId);
    if(idx !== -1) {
        state.links.splice(idx,1);
        await deleteLinkFromDB(linkId);
        renderMarkersForView('left');
        renderMarkersForView('right');
    }
}

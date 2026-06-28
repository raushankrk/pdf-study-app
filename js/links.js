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

    // Helper to render individual marker so we can track if it's the start or end
    const renderMarker = (link, isSource) => {
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

        // Check if this specific marker needs highlighting after a jump
        let shouldHighlight = false;
        if (state.highlightRequest && 
            state.highlightRequest.side === side && 
            state.highlightRequest.linkId === link.id) {
            
            // Ensure we highlight the correct end of the link
            if (state.highlightRequest.isSourceMarkerRequest === isSource) {
                shouldHighlight = true;
            }
        }

        if (shouldHighlight) {
            btn.classList.add('marker-active');
            targetMarkerElement = btn;
            setTimeout(() => {
                btn.classList.remove('marker-active');
                if (state.highlightRequest && state.highlightRequest.linkId === link.id) {
                    state.highlightRequest = null;
                }
            }, 3000);
        }

        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault(); 
            if(state.appMode === 'delete-link') {
                deleteLink(link.id);
            } else {
                followLink(link, side, isSource);
            }
        };

        container.appendChild(btn);
    };

    // Render source and/or target markers independently (handles same-page links)
    relevantLinks.forEach(link => {
        if (link.source.docId === viewState.docId && link.source.page === viewState.pageNum) {
            renderMarker(link, true);
        }
        if (link.target.docId === viewState.docId && link.target.page === viewState.pageNum) {
            renderMarker(link, false);
        }
    });

    // Render pending link marker if one is currently being created
    if (state.linkCreation && state.linkCreation.active && 
        state.linkCreation.sourceData.docId === viewState.docId && 
        state.linkCreation.sourceData.page === viewState.pageNum) {
        
        const btn = document.createElement('div');
        btn.className = 'link-marker marker-active'; 
        btn.title = "Pending Link Start (Navigate and click target to finish, or press Esc to cancel)";
        
        const wrapper = els[side + 'Wrapper'];
        const x = state.linkCreation.sourceData.x * wrapper.offsetWidth;
        const y = state.linkCreation.sourceData.y * wrapper.offsetHeight;

        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;
        btn.innerHTML = '<i class="fa-solid fa-link"></i>';
        
        // Allow clicking the pending marker again to cancel it
        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            state.linkCreation.active = false;
            state.linkCreation.sourceData = null;
            els.currentPath.style.display = 'none';
            renderMarkersForView('left');
            renderMarkersForView('right');
        };

        container.appendChild(btn);
    }

    if (targetMarkerElement) {
        const viewport = els[side + 'Viewport'];
        const elementTop = targetMarkerElement.offsetTop;
        const viewportHeight = viewport.clientHeight;
        const elementHeight = targetMarkerElement.clientHeight;
        const scrollTo = elementTop - (viewportHeight / 2) + (elementHeight / 2);
        viewport.scrollTo({ top: scrollTo, behavior: 'smooth' });
    }
}

function followLink(link, fromSide, isSourceMarker) {
    // Correctly resolve target based on which marker was actually clicked
    const targetData = isSourceMarker ? link.target : link.source;
    
    // Determine which side to open the link in
    let targetSide = fromSide === 'left' ? 'right' : 'left';

    // If the intended opposite side is locked, respect the lock and open it in the current side instead
    if (state.view[targetSide].locked) {
        targetSide = fromSide;
    }

    state.highlightRequest = { 
        side: targetSide, 
        linkId: link.id,
        isSourceMarkerRequest: !isSourceMarker // Highlight the opposite marker we clicked
    };
    
    state.view[targetSide].docId = targetData.docId;
    state.view[targetSide].pageNum = targetData.page;
    state.view[targetSide].scrollTop = 0; 
    
    clearSelection();
    saveSettings(); 
    renderPage(targetSide);
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
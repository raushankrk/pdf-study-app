// ==========================================
// 📁 5. ui.js
// ==========================================
function toggleLock(side) {
    state.view[side].locked = !state.view[side].locked;
    const btn = document.getElementById(`lock-${side}-btn`);
    const icon = btn.querySelector('i');
    
    if (state.view[side].locked) {
        btn.classList.add('locked');
        icon.classList.remove('fa-lock-open');
        icon.classList.add('fa-lock');
    } else {
        btn.classList.remove('locked');
        icon.classList.remove('fa-lock');
        icon.classList.add('fa-lock-open');
    }
    saveSettings();
}

function updateLockVisuals() {
    ['left', 'right'].forEach(side => {
        const btn = document.getElementById(`lock-${side}-btn`);
        const icon = btn.querySelector('i');
        const isLocked = state.view[side].locked;

        if (isLocked) {
            btn.classList.add('locked');
            icon.classList.remove('fa-lock-open');
            icon.classList.add('fa-lock');
        } else {
            btn.classList.remove('locked');
            icon.classList.remove('fa-lock');
            icon.classList.add('fa-lock-open');
        }
    });
}

function updateViewportActiveVisuals() {
    const leftViewport = document.getElementById('left-viewport');
    const rightViewport = document.getElementById('right-viewport');
    const active = state.lastActiveSide === 'right' ? 'right' : 'left';

    if (active === 'left') {
        leftViewport.classList.add('viewport-wrapper-active');
        rightViewport.classList.remove('viewport-wrapper-active');
    } else {
        leftViewport.classList.remove('viewport-wrapper-active');
        rightViewport.classList.add('viewport-wrapper-active');
    }

    // ---- Single Active-PDF toolbar (main header) ----
    // 1. body[data-active-pdf] drives the pure-CSS show/hide of the per-side
    //    controls blocks (#pdf-controls-left / #pdf-controls-right) — only
    //    the ACTIVE PDF's controls are visible.
    // 2. The A / B tabs get the .pdf-tab-active highlight.
    // The hidden side's controls still receive DOM updates from
    // renderPage()/zoom paths (they write els[side + '...']), so switching
    // tabs always shows fresh values with zero extra syncing logic.
    document.body.dataset.activePdf = active;
    ['left', 'right'].forEach(side => {
        document.getElementById(`pdf-tab-${side}`)
            ?.classList.toggle('pdf-tab-active', side === active);
    });
}

/**
 * Make the given PDF the ACTIVE PDF (single-toolbar concept).
 *
 * The active PDF is the one that:
 *   - the header's lock / find / zoom / page-nav / page-ops controls
 *     operate on,
 *   - receives pasted images / comments when no explicit viewport was
 *     clicked (state.lastActiveSide consumers),
 *   - is highlighted in the header (A / B tab) and ringed in the workspace.
 *
 * Called from:
 *   - the PDF A / PDF B tabs in the header,
 *   - handlePointerDown (events.js) when the user clicks/taps a viewport
 *     (mouse, touch, Apple Pencil — all emit pointerdown),
 *   - setActiveDocument / navigatePage / jumpToPage / handleScroll, which
 *     set state.lastActiveSide directly and then call
 *     updateViewportActiveVisuals() or renderPage().
 *
 * NOTE: this only changes WHICH PDF is active — it never changes the
 * current tool, mode, or drawing state, and it never re-renders the
 * canvases (safe to call mid-gesture).
 */
function setActivePdf(side, save = true) {
    if (side !== 'left' && side !== 'right') return;

    // ---- Minimized panel: activating a minimized PDF RESTORES it ----
    // The A / B header tab of a minimized canvas doubles as its restore
    // button (the tab shows an expand icon while minimized). Restore first,
    // then continue with the normal activation path. save=false because
    // setActivePdf itself persists below on real switches.
    if (state.minimizedSide === side) restorePanel(side, false);

    const changed = state.lastActiveSide !== side;
    state.lastActiveSide = side;
    updateViewportActiveVisuals();

    // Persist only on real switches (tab clicks). The canvas-tap path in
    // handlePointerDown passes no args but is already debounced-noise-safe:
    // it calls updateViewportActiveVisuals() directly, not this function,
    // and the scroll handler's debounced saveSettings() persists the state.
    if (changed && save) saveSettings();
}
window.setActivePdf = setActivePdf;

// ============================================================================
// ---- Panel minimize (single-toolbar era) ----
// ============================================================================
// Lets the user collapse ONE of the two PDF canvases when it's not needed,
// so the other canvas takes the full workspace width. The minimized canvas:
//   - is AUTO-LOCKED (state.view[side].locked = true) so that newly opened
//     PDFs (file-explorer clicks, recent files) can NEVER land in it —
//     openDocumentSmart() already routes around locked viewports;
//   - keeps its document + annotations in memory (nothing is unloaded —
//     links, AI context and undo history stay intact);
//   - is restored by clicking its A / B tab in the header (the tab shows an
//     expand icon while minimized) — setActivePdf() restores on activation.
// At most one panel can be minimized at a time (the workspace must always
// show at least one canvas).

function otherSide(side) { return side === 'left' ? 'right' : 'left'; }

function applyPanelMinimizeVisuals(side) {
    if (side === 'left' || side === 'right') {
        document.body.dataset.panelMin = side;
    } else {
        delete document.body.dataset.panelMin;
    }
    ['left', 'right'].forEach(s => {
        const tab = document.getElementById(`pdf-tab-${s}`);
        if (!tab) return;
        const minimized = state.minimizedSide === s;
        tab.classList.toggle('pdf-tab-minimized', minimized);
        if (minimized) {
            tab.title = 'PDF ' + (s === 'left' ? 'A' : 'B') + ' is minimized — click to restore it';
            tab.setAttribute('aria-label', 'Restore PDF ' + (s === 'left' ? 'A' : 'B'));
        } else {
            tab.title = 'Activate PDF ' + (s === 'left' ? 'A' : 'B') + ' (tools will operate on this PDF)';
            tab.setAttribute('aria-label', 'Activate PDF ' + (s === 'left' ? 'A' : 'B'));
        }
    });
}

/**
 * Minimize the given panel (hide its canvas, auto-lock it, give the other
 * panel the full workspace width).
 * @param {'left'|'right'} side
 * @param {boolean} [save=true] persist to settings
 */
function minimizePanel(side, save = true) {
    if (side !== 'left' && side !== 'right') return;
    if (state.minimizedSide === side) return;              // already minimized
    if (state.minimizedSide !== null) return;              // never minimize BOTH
                                                           // (button hidden via CSS
                                                           //  anyway — defensive)

    // Safety: if a link/snip gesture is pending FROM this side, cancel the
    // mode first — its source canvas is about to disappear.
    if (state.linkCreation && state.linkCreation.active && state.linkCreation.sourceSide === side) {
        if (typeof setAppMode === 'function') setAppMode('navigation', false);
    }

    state.minimizedSide = side;

    // ---- AUTO-LOCK ----
    // The whole point: a minimized canvas must never receive a newly opened
    // PDF. Remember whether WE applied the lock (so restore can undo it);
    // a manually locked viewport stays locked after restore.
    state.minimizeAutoLock[side] = !state.view[side].locked;
    state.view[side].locked = true;
    if (typeof updateLockVisuals === 'function') updateLockVisuals();

    // Close that side's search dropdown (hidden UI shouldn't keep popups).
    if (typeof closeViewportSearch === 'function') closeViewportSearch(side);

    // The active PDF must always be a VISIBLE one.
    if (state.lastActiveSide === side) setActivePdf(otherSide(side), false);

    applyPanelMinimizeVisuals(side);
    if (save) saveSettings();
}

/**
 * Bring a minimized panel back (split view again, width from splitRatio).
 * Undoes the auto-lock if (and only if) minimize applied it.
 */
function restorePanel(side, save = true) {
    if (state.minimizedSide !== side) return;
    state.minimizedSide = null;

    if (state.minimizeAutoLock && state.minimizeAutoLock[side]) {
        state.view[side].locked = false;
        state.minimizeAutoLock[side] = false;
        if (typeof updateLockVisuals === 'function') updateLockVisuals();
    }

    applyPanelMinimizeVisuals(null);

    // Layout changed (the restored panel gets its width back) — refresh the
    // rect-derived overlays exactly like the splitter's pointerup does.
    if (typeof renderMarkersForView === 'function') {
        renderMarkersForView('left');
        renderMarkersForView('right');
    }
    if (typeof renderTextLayer === 'function') {
        renderTextLayer('left');
        renderTextLayer('right');
    }

    if (save) saveSettings();
}

window.minimizePanel = minimizePanel;
window.restorePanel = restorePanel;

function toggleLeftSidebar() {
    document.body.classList.toggle('left-sidebar-collapsed');
    saveSettings();
}

// ---- Floating tool sidebar (AI Chat + Comments) --------------------------
// ONE liquid glass card floating above the PDF. The PDF canvas never
// resizes or moves — the card is absolutely positioned and takes no flex
// space. Visibility is driven by body.float-sidebar-open; the shown pane
// (AI Chat OR Comments, never both) is driven by exactly one of
// body.fs-mode-chat / body.fs-mode-comments (CSS in style.css).
// The card's surface is frosted translucent glass and it ABSORBS the
// pointer (pointer-events: auto) — clicks on the card never reach the PDF.
function toggleAiSidebar() {
    const nowOpen = document.body.classList.toggle('float-sidebar-open');
    if (nowOpen) applyFloatSidebarPos();   // position/measure needs a visible element
    saveSettings();
}

// Which pane is currently shown ('chat' | 'comments'). Defaults to 'chat'
// whenever neither class is set (e.g. a fresh profile before boot).
function getFloatSidebarMode() {
    return document.body.classList.contains('fs-mode-comments') ? 'comments' : 'chat';
}

function setFloatSidebarMode(mode) {
    if (mode !== 'chat' && mode !== 'comments') return;
    document.body.classList.toggle('fs-mode-chat', mode === 'chat');
    document.body.classList.toggle('fs-mode-comments', mode === 'comments');
    saveSettings();
}

// Open the floating sidebar and optionally switch to a mode. Used by the
// comment feature (opening a comment reveals the sidebar in comments mode)
// and available for any future tool that wants the floating layer.
function openFloatSidebar(mode) {
    document.body.classList.add('float-sidebar-open');
    if (mode) setFloatSidebarMode(mode);
    applyFloatSidebarPos();                // (re)clamp + apply on every open
    if (!mode) saveSettings();
}

// Close the whole floating sidebar. If a comment is currently being edited,
// close the comment first — same semantics as the old comment panel's X
// (a brand-new empty comment is removed instead of leaving a stray icon).
function closeFloatSidebar() {
    if (state.activeComment && state.activeComment.id &&
        typeof cancelCommentEdit === 'function') {
        cancelCommentEdit();
    }
    document.body.classList.remove('float-sidebar-open');
    if (typeof closeChatHistory === 'function') closeChatHistory();
    saveSettings();
}

// ---- Draggable floating sidebar -------------------------------------------
// The sidebar is a compact CARD (not a full-height column) that the user can
// drag anywhere inside #workspace-main via the grip handle (#fs-drag-handle).
//
// Smoothness: the position is applied exclusively through transform:
// translate3d(...) (GPU-composited — no layout, no reflow) with
// requestAnimationFrame coalescing, so dragging tracks the pointer 1:1 at
// display refresh rate. A short CSS transition on transform gives a soft
// glide for programmatic moves (re-dock / resize re-clamp); the body.fs-
// dragging class turns that transition OFF during a drag for zero lag.
//
// Positioning contract:
//   * state.floatSidebarPos === null  → docked at the DEFAULT top-right
//     corner (right edge flush with the workspace, like the original
//     right:0 layout). This stays "dock-like" — it follows the workspace
//     edge on resize — until the user drags the card at least once.
//   * After a drag, state.floatSidebarPos = { x, y } is persisted via
//     saveSettings() and restored (validated + re-clamped) on boot.
//   * The card is always clamped fully inside #workspace-main, so the grip
//     and pills can never be lost off-screen.
let fsCurrentPos = null;        // last APPLIED position {x,y} (workspace CSS px)
let fsDragCtx = null;           // active drag: {startX, startY, origX, origY, pointerId}
let fsPendingXY = null;         // rAF-coalesced next position
let fsRafPending = false;
let fsLastGripTap = 0;          // double-tap-to-re-dock detection (works for touch too)
let fsLastGripTapXY = { x: 0, y: 0 };

// Default resting position: top-right corner of the workspace — the exact
// visual equivalent of the original `right: 0; top: 0` docked sidebar.
function floatSidebarDefaultPos() {
    const ws = document.getElementById('workspace-main');
    const sb = document.getElementById('float-sidebar');
    if (!ws || !sb) return { x: 0, y: 0 };
    const wsRect = ws.getBoundingClientRect();
    const sbRect = sb.getBoundingClientRect();
    return { x: Math.max(0, Math.round(wsRect.width - sbRect.width)), y: 0 };
}

// Keep the card fully inside the workspace: x ∈ [0, wsW - sbW],
// y ∈ [0, wsH - sbH]. Non-finite input falls back to the default corner.
function clampFloatSidebarPos(x, y) {
    if (!isFinite(x) || !isFinite(y)) return floatSidebarDefaultPos();
    const ws = document.getElementById('workspace-main');
    const sb = document.getElementById('float-sidebar');
    if (!ws || !sb) return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
    const wsRect = ws.getBoundingClientRect();
    const sbRect = sb.getBoundingClientRect(); // transform does not affect size
    const maxX = Math.max(0, wsRect.width - sbRect.width);
    const maxY = Math.max(0, wsRect.height - sbRect.height);
    return {
        x: Math.min(Math.max(0, Math.round(x)), Math.round(maxX)),
        y: Math.min(Math.max(0, Math.round(y)), Math.round(maxY)),
    };
}

// Resolve the position to apply: the saved/dragged position when valid,
// otherwise the default corner — always clamped to the current workspace.
function fsResolvePos() {
    if (state.floatSidebarPos &&
        isFinite(state.floatSidebarPos.x) && isFinite(state.floatSidebarPos.y)) {
        return clampFloatSidebarPos(state.floatSidebarPos.x, state.floatSidebarPos.y);
    }
    const d = floatSidebarDefaultPos();
    return clampFloatSidebarPos(d.x, d.y);
}

// Write the position into the inline transform. Called directly by the rAF
// batch and by the drag-end flush.
function fsWriteTransform(pos) {
    const sb = document.getElementById('float-sidebar');
    if (!sb) return;
    fsCurrentPos = pos;
    sb.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0px)`;
}

// Apply the resolved position to the sidebar. MUST run while the sidebar is
// visible (display:none elements have no box to measure) — toggleAiSidebar /
// openFloatSidebar call this right after adding body.float-sidebar-open, so
// the transform is set before the next paint (no visible jump).
function applyFloatSidebarPos() {
    const sb = document.getElementById('float-sidebar');
    if (!sb) return;
    if (!document.body.classList.contains('float-sidebar-open')) return;
    const pos = fsResolvePos();
    // First-ever apply: the inline transform is still empty, so the element
    // would animate from the CSS default (0,0) to the dock corner. Disable
    // the transition for this one write, force a reflow, then re-enable —
    // later programmatic moves (re-dock / re-clamp) glide as intended.
    const firstApply = !sb.style.transform;
    if (firstApply) sb.style.transition = 'none';
    fsWriteTransform(pos);
    if (firstApply) { void sb.offsetWidth; sb.style.transition = ''; }
}

// rAF-coalesced move used while dragging: stores the latest target and
// schedules a single frame to apply it (multiple pointermove events between
// frames collapse into one style write).
function moveFloatSidebarTo(x, y) {
    fsPendingXY = { x, y };
    if (fsRafPending) return;
    fsRafPending = true;
    requestAnimationFrame(() => {
        fsRafPending = false;
        if (!fsPendingXY) return;
        const p = clampFloatSidebarPos(fsPendingXY.x, fsPendingXY.y);
        fsPendingXY = null;
        fsWriteTransform(p);
    });
}

// pointerdown on the grip: start a drag (or detect a double-tap → re-dock).
// preventDefault + setPointerCapture keep the gesture ours: no text
// selection, no focus steal, and — because the grip is inside the guarded
// #float-sidebar island — the annotation pointer handlers never see it.
function beginFloatSidebarDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const sb = document.getElementById('float-sidebar');
    if (!sb || !document.body.classList.contains('float-sidebar-open')) return;
    // Double-tap / double-click on the grip (works for mouse AND touch)
    // re-docks the sidebar to its default corner.
    const now = Date.now();
    const dist = Math.hypot(e.clientX - fsLastGripTapXY.x, e.clientY - fsLastGripTapXY.y);
    if (now - fsLastGripTap < 350 && dist < 8) {
        fsLastGripTap = 0;
        resetFloatSidebarPos();
        return;
    }
    fsLastGripTap = now;
    fsLastGripTapXY = { x: e.clientX, y: e.clientY };
    const startPos = fsCurrentPos || floatSidebarDefaultPos();
    fsDragCtx = {
        startX: e.clientX, startY: e.clientY,
        origX: startPos.x, origY: startPos.y,
        pointerId: e.pointerId,
    };
    document.body.classList.add('fs-dragging');
    if (e.preventDefault) e.preventDefault();
    try {
        if (e.target && e.target.setPointerCapture && e.pointerId !== undefined) {
            e.target.setPointerCapture(e.pointerId);
        }
    } catch (_) { /* capture is best-effort; window listeners cover the rest */ }
    if (!fsCurrentPos) fsWriteTransform(clampFloatSidebarPos(startPos.x, startPos.y));
    window.addEventListener('pointermove', moveFloatSidebarDrag, { passive: false });
    window.addEventListener('pointerup', endFloatSidebarDrag);
    window.addEventListener('pointercancel', endFloatSidebarDrag);
}

function moveFloatSidebarDrag(e) {
    if (!fsDragCtx) return;
    if (e.pointerId !== undefined && fsDragCtx.pointerId !== undefined &&
        e.pointerId !== fsDragCtx.pointerId) return;
    if (e.cancelable) e.preventDefault();
    moveFloatSidebarTo(
        fsDragCtx.origX + (e.clientX - fsDragCtx.startX),
        fsDragCtx.origY + (e.clientY - fsDragCtx.startY));
}

function endFloatSidebarDrag() {
    if (!fsDragCtx) return;
    const ctx = fsDragCtx;
    fsDragCtx = null;
    document.body.classList.remove('fs-dragging');
    window.removeEventListener('pointermove', moveFloatSidebarDrag);
    window.removeEventListener('pointerup', endFloatSidebarDrag);
    window.removeEventListener('pointercancel', endFloatSidebarDrag);
    // Flush a still-pending rAF target so the persisted position matches the
    // visual resting position exactly (very fast flicks can leave one queued).
    if (fsPendingXY) {
        fsWriteTransform(clampFloatSidebarPos(fsPendingXY.x, fsPendingXY.y));
        fsPendingXY = null;
    }
    // Persist only REAL drags: a plain tap (or 1-2px of jitter) must not turn
    // the docked default into an explicit saved position — an untouched card
    // keeps following the workspace edge on resize.
    if (fsCurrentPos) {
        const moved = Math.hypot(fsCurrentPos.x - ctx.origX, fsCurrentPos.y - ctx.origY);
        if (moved >= 3) {
            state.floatSidebarPos = { x: fsCurrentPos.x, y: fsCurrentPos.y };
        }
    }
    saveSettings();
}

// Double-tap on the grip (or any future "re-dock" affordance): forget the
// dragged position — the card glides back to its default top-right corner
// and, being un-personalized again, follows the workspace edge on resize.
function resetFloatSidebarPos() {
    state.floatSidebarPos = null;
    applyFloatSidebarPos();
    saveSettings();
}

// Window resize: re-clamp a dragged position so the card stays inside the
// (possibly smaller) workspace; recompute the dock corner for a never-dragged
// card so it keeps hugging the right edge. No-op while closed.
function handleFloatSidebarResize() {
    if (document.body.classList.contains('float-sidebar-open')) {
        applyFloatSidebarPos();
    }
}

// Bind the grip + workspace-size observation. Called once from app.js boot.
function initFloatSidebarDrag() {
    const grip = document.getElementById('fs-drag-handle');
    if (grip) grip.addEventListener('pointerdown', beginFloatSidebarDrag);
    // Re-clamp / re-dock whenever the WORKSPACE itself changes size — the
    // left file sidebar collapsing (it animates its width over ~300ms, so a
    // single boot-time measurement can be stale), the split resizer moving,
    // a panel being minimized, or the window being resized. A ResizeObserver
    // on #workspace-main covers ALL of those sources with one primitive; the
    // window-resize listener is only the legacy fallback. (Writing the
    // transform changes no layout, so the observer can never loop.)
    const ws = document.getElementById('workspace-main');
    if (typeof ResizeObserver !== 'undefined' && ws && ws.addEventListener) {
        const ro = new ResizeObserver(() => handleFloatSidebarResize());
        ro.observe(ws);
    } else {
        window.addEventListener('resize', handleFloatSidebarResize);
    }
}

function toggleChatHistory() {
    const drawer = document.getElementById('chat-history-drawer');
    if (drawer) {
        if(drawer.classList.contains('-translate-x-full')) {
            drawer.classList.remove('-translate-x-full');
            drawer.classList.add('translate-x-0');
        } else {
            drawer.classList.add('-translate-x-full');
            drawer.classList.remove('translate-x-0');
        }
    }
}

function closeChatHistory() {
    const drawer = document.getElementById('chat-history-drawer');
    if (drawer) {
        drawer.classList.add('-translate-x-full');
        drawer.classList.remove('translate-x-0');
    }
}

function setAppMode(mode, save = true) {
    state.appMode = mode;
    if (save) saveSettings();

    document.body.classList.remove('linking-mode', 'annotation-mode', 'anno-pen', 'anno-pixel-eraser', 'anno-stroke-eraser', 'anno-select', 'anno-text', 'anno-image', 'delete-link-mode', 'snip-link-mode');

    // Reset all mode buttons
    ['mode-nav-btn','mode-link-btn','mode-snip-link-btn','mode-del-link-btn'].forEach(id => {
        document.getElementById(id)?.classList.remove('active-mode');
    });

    if (mode !== 'snip-link' && typeof cancelSnip === 'function') cancelSnip();

    if (state.linkCreation && state.linkCreation.active) {
        state.linkCreation.active = false;
        state.linkCreation.sourceData = null;
        if (els.currentPath) {
            els.currentPath.style.display = 'none';
            els.currentPath.setAttribute('d', '');
        }
        if (typeof renderMarkersForView === 'function') {
            renderMarkersForView('left');
            renderMarkersForView('right');
        }
    }

    const modeMap = {
        'navigation': 'mode-nav-btn',
        'linking': 'mode-link-btn',
        'snip-link': 'mode-snip-link-btn',
        'delete-link': 'mode-del-link-btn'
    };
    document.getElementById(modeMap[mode])?.classList.add('active-mode');

    if (mode === 'linking') {
        document.body.classList.add('linking-mode');
    } else if (mode === 'snip-link') {
        document.body.classList.add('snip-link-mode');
    } else if (mode === 'delete-link') {
        document.body.classList.add('delete-link-mode');
    } else if (mode === 'annotation') {
        document.body.classList.add('annotation-mode');
        setAnnoTool(state.annoTool, false);
    }
}

function setAnnoTool(tool, save = true) {
    // ---- BUG FIX (Pen/Highlighter tool switching) ----
    // `state.annoTool` is per-device UI state. It MUST NEVER be overwritten
    // by remote collaboration (Yjs awareness, project revision changes,
    // smartRefreshFromServer). The remote sync layer syncs annotation DATA
    // (each stroke/image/textbox already carries its own `tool`/`color`/
    // `thickness` fields), not UI state.
    //
    // This function is the ONLY place that mutates state.annoTool — and it
    // is only called from local user input (button taps, keyboard
    // shortcuts 'p'/'h'/'t'/'e'/'d'/'i'/'s', or programmatic tool switches
    // that simulate a user action). Remote sync code paths must NOT call
    // this function.
    state.annoTool = tool;
    if (save) saveSettings();

    // Switch to annotation mode if not already
    if (state.appMode !== 'annotation') {
        state.appMode = 'annotation';
        document.body.classList.add('annotation-mode');
        document.getElementById('mode-nav-btn')?.classList.remove('active-mode');
    }

    // Reset all tool buttons
    ['tool-select','tool-pen','tool-highlighter','tool-text',
     'tool-eraser-pixel','tool-eraser-stroke','tool-image'].forEach(id => {
        document.getElementById(id)?.classList.remove('active-tool', 'active-highlight');
    });

    // Remove all anno body classes
    document.body.classList.remove('anno-pen','anno-pixel-eraser','anno-stroke-eraser','anno-select','anno-text','anno-highlighter','anno-image');

    // Apply tool settings (color/thickness)
    if (!state.toolSettings) {
        state.toolSettings = {
            pen: { color: '#ef4444', thickness: 5 },
            highlighter: { color: '#facc15', thickness: 20 }
        };
    }
    if (state.toolSettings[tool]) {
        const settings = state.toolSettings[tool];
        if (settings.color !== undefined) {
            state.annoColor = settings.color;
            els.colorPicker.value = settings.color;
        }
        if (settings.thickness !== undefined) {
            state.annoThickness = settings.thickness;
            els.thicknessPicker.value = settings.thickness;
            const thicknessDisplay = document.getElementById('thickness-val');
            if (thicknessDisplay) thicknessDisplay.innerText = settings.thickness;
        }
    }

    // Activate correct button and body class
    if (tool === 'highlighter') {
        document.getElementById('tool-highlighter')?.classList.add('active-highlight');
        document.body.classList.add('anno-highlighter');
    } else {
        const toolMap = {
            'select':        { btn: 'tool-select',        cls: 'anno-select' },
            'pen':           { btn: 'tool-pen',           cls: 'anno-pen' },
            'text':          { btn: 'tool-text',          cls: 'anno-text' },
            'eraser-pixel':  { btn: 'tool-eraser-pixel',  cls: 'anno-pixel-eraser' },
            'eraser-stroke': { btn: 'tool-eraser-stroke', cls: 'anno-stroke-eraser' },
            'image':         { btn: 'tool-image',         cls: 'anno-image' },
        };
        if (toolMap[tool]) {
            document.getElementById(toolMap[tool].btn)?.classList.add('active-tool');
            document.body.classList.add(toolMap[tool].cls);
        }
    }

    // Show/hide pen customization panel
    const isLineTool = (tool === 'pen' || tool === 'highlighter');
    const penCustomization = document.getElementById('pen-customization');
    const penSep = document.getElementById('pen-customization-sep');
    if (penCustomization) {
        penCustomization.classList.toggle('hidden', !isLineTool);
        penCustomization.classList.toggle('flex', isLineTool);
    }
    if (penSep) {
        penSep.classList.toggle('hidden', !isLineTool);
    }

    // ---- Image tool: open file picker immediately ----
    // On touch devices (iPad Safari), calling `imageInput.click()` from inside
    // a pointerdown handler on the canvas sometimes gets silently blocked
    // because iOS treats it as not-a-direct-user-gesture by the time the
    // async target resolution finishes. Triggering the picker directly from
    // the tool-button tap (which is the current call stack) is reliable on
    // every browser. The image is then placed at the center of the
    // last-active viewport (or wherever the user clicked last).
    if (tool === 'image' && els.imageInput) {
        // Defer the click() to the next microtask so the button's active
        // styling has time to apply first — also avoids reentrancy if the
        // picker is opened from a click handler that's still bubbling.
        setTimeout(() => {
            try { els.imageInput.click(); } catch (e) { /* ignore */ }
        }, 0);
    }

    // Show/hide line mode button
    const lineModeBtn = document.getElementById('tool-line-mode');
    if (lineModeBtn) lineModeBtn.style.display = isLineTool ? '' : 'none';

    updateThicknessPreview();
}

// ---- Modals ----
function showModal(title, body, isPrompt = false) {
    els.modalTitle.innerText = title;
    els.modalBody.innerHTML = body.replace(/\n/g, '<br>');
    
    if (isPrompt) {
        els.modalBody.classList.add('hidden');
        els.modalInput.classList.remove('hidden');
        els.modalInput.value = '';
        els.modalInput.focus();
        els.modalConfirmBtn.classList.remove('hidden');
    } else {
        els.modalBody.classList.remove('hidden');
        els.modalInput.classList.add('hidden');
        els.modalConfirmBtn.classList.add('hidden');
    }
    
    els.modal.classList.remove('hidden');
}

function showPromptModal(title, defaultValue = '') {
    return new Promise((resolve) => {
        modalResolve = resolve;
        showModal(title, '', true);
        if(defaultValue) els.modalInput.value = defaultValue;
    });
}

function closeModal(result = false) {
    if (modalResolve) {
        const val = result ? els.modalInput.value : null;
        modalResolve(val);
        modalResolve = null;
    }
    els.modal.classList.add('hidden');
}

// ---- AI Settings Panel ----
function openAiSettings() {
    const s = state.aiSettings;
    els.aiSettingModel.value = s.model;
    els.aiSettingPrompt.value = s.systemPrompt;
    els.aiSettingStyle.value = s.responseStyle;
    els.aiSettingTemp.value = s.temperature;
    els.aiSettingTempVal.innerText = s.temperature;
    els.aiSettingStrict.checked = s.strictRag;
    els.aiSettingHistory.checked = s.includeChatHistory !== false; // Default to true if undefined
    els.aiSettingSkipLlm.checked = s.skipLlm || false;
    els.aiSettingSim.value = s.similarityThreshold;
    els.aiSettingSimVal.innerText = s.similarityThreshold;
    els.aiSettingBudget.value = s.contextBudget;
    els.aiSettingMaxChunks.value = s.maxChunks;
    els.aiSettingChunkSize.value = s.chunkSize;
    
    els.aiSettingsModal.classList.remove('hidden');
}

function closeAiSettings() {
    els.aiSettingsModal.classList.add('hidden');
}

async function saveAiSettings() {
    const oldChunkSize = state.aiSettings.chunkSize;
    
    state.aiSettings = {
        model: els.aiSettingModel.value.trim() || "gemma3:1b",
        systemPrompt: els.aiSettingPrompt.value.trim() || "You are a helpful assistant answering questions based on the provided PDF context.",
        responseStyle: els.aiSettingStyle.value,
        temperature: parseFloat(els.aiSettingTemp.value),
        strictRag: els.aiSettingStrict.checked,
        includeChatHistory: els.aiSettingHistory.checked,
        skipLlm: els.aiSettingSkipLlm.checked,
        similarityThreshold: parseFloat(els.aiSettingSim.value),
        contextBudget: parseInt(els.aiSettingBudget.value),
        maxChunks: parseInt(els.aiSettingMaxChunks.value),
        chunkSize: parseInt(els.aiSettingChunkSize.value)
    };

    await saveSettings();
    closeAiSettings();

    // Re-index logic if chunk size changes
    if (oldChunkSize !== state.aiSettings.chunkSize) {
        showModal("Re-indexing Required", "Chunk size changed. Clearing and rebuilding document index...");
        state.embeddings = []; // Clear current embeddings
        indexDocuments(true); // Force re-index with new size
    }
}

function resetAiSettings() {
    if(confirm("Reset all AI settings to default?")) {
        state.aiSettings = {
            model: "gemma3:1b",
            systemPrompt: "You are a helpful assistant answering questions based on the provided PDF context.",
            responseStyle: "Detailed",
            temperature: 0.7,
            strictRag: true,
            includeChatHistory: true,
            skipLlm: false,
            similarityThreshold: 0.65,
            contextBudget: 4000,
            maxChunks: 8,
            chunkSize: 2000
        };
        openAiSettings(); // Refresh form values
    }
}

// ---- Layout Resizer ----
function initResizer() {
    const resizer = els.resizer;
    const leftSide = els.leftPanel;
    const rightSide = els.rightPanel;
    const container = els.workspaceMain;
    
    let x = 0;
    let leftWidth = 0;

    const mouseDownHandler = function(e) {
        x = e.clientX;
        const rect = leftSide.getBoundingClientRect();
        leftWidth = rect.width;

        document.body.classList.add('resizing-active');
        resizer.classList.add('resizing');

        document.addEventListener('pointermove', mouseMoveHandler);
        document.addEventListener('pointerup', mouseUpHandler);
    };

    const mouseMoveHandler = function(e) {
        const dx = e.clientX - x;
        const newLeftWidth = ((leftWidth + dx) * 100) / container.getBoundingClientRect().width;
        if (newLeftWidth > 10 && newLeftWidth < 90) {
            leftSide.style.width = `${newLeftWidth}%`;
            rightSide.style.width = `${100 - newLeftWidth}%`;
            state.splitRatio = newLeftWidth / 100;
        }
    };

    const mouseUpHandler = function() {
        document.body.classList.remove('resizing-active');
        resizer.classList.remove('resizing');
        document.removeEventListener('pointermove', mouseMoveHandler);
        document.removeEventListener('pointerup', mouseUpHandler);
        saveSettings();
        renderMarkersForView('left');
        renderMarkersForView('right');
        ['left', 'right'].forEach(s => renderTextLayer(s));
    };

    resizer.addEventListener('pointerdown', mouseDownHandler);
}

function updateZoomIndicator(side) {
    const percentage = Math.round(state.view[side].scale * 100);
    els[side + 'ZoomLevel'].innerText = percentage + '%';
    renderTextLayer(side);
}

async function clearAllData() {
    if (confirm("Are you sure? This will delete all uploaded PDFs, links, annotations, and chat history permanently.")) {
        await clearDB();
        state.documents = {};
        state.links = [];
        state.annotations = {};
        state.imageCache = {};
        state.embeddings = [];
        state.chats = [];
        // Reset folder state to just root.
        state.folders = {};
        state.folders[ROOT_FOLDER_ID] = {
            id: ROOT_FOLDER_ID, name: 'Root', parentId: null,
            createdAt: Date.now(), expanded: true
        };
        state.currentFolderId = ROOT_FOLDER_ID;
        state.fileSelection.docIds.clear();
        state.fileSelection.folderIds.clear();
        state.recentDocIds = [];
        state.fileExplorerQuery = '';
        state.fileSort = { by: 'name', order: 'asc' };
        state.view.left = { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false };
        state.view.right = { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false };
        state.lastActiveSide = 'left';
        // Reset minimized-panel state too (fresh workspace = both canvases visible).
        state.minimizedSide = null;
        state.minimizeAutoLock = { left: false, right: false };
        applyPanelMinimizeVisuals(null);
        // Fresh workspace: forget all resume-on-reopen reading positions.
        state.lastPositions = {};
        // Fresh workspace: no tagged PDFs (quick-switch rail) either.
        state.taggedDocIds = [];
        updateViewportActiveVisuals();

        await ensureRootFolder();
        await createNewChat();

        renderDocList();
        renderPage('left');
        renderPage('right');
        els.emptyMsg.style.display = 'block';
        showModal("Success", "All data cleared.");
    }
}

function toggleLineMode() {
    state.lineMode = state.lineMode === 'freehand' ? 'straight' : 'freehand';
    const btn = document.getElementById('tool-line-mode');
    if (state.lineMode === 'straight') {
        btn.classList.add('bg-blue-50', 'text-blue-600');
        btn.classList.remove('text-gray-500');
        btn.title = 'Straight Line (click to switch to Freehand)';
    } else {
        btn.classList.remove('bg-blue-50', 'text-blue-600');
        btn.classList.add('text-gray-500');
        btn.title = 'Freehand (click to switch to Straight Line)';
    }
    saveSettings();
}

function updateThicknessPreview() {
    const canvas = document.getElementById('thickness-preview-canvas');
    if (!canvas) return;
    canvas.style.cursor = 'pointer';
    canvas.title = 'Click to change color';
    canvas.onclick = () => document.getElementById('color-picker').click();

    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    const isHighlighter = state.annoTool === 'highlighter';
    const thickness = state.annoThickness;

    // Scale dot radius: thickness 1→2px radius, thickness 20→16px radius
    const radius = 2 + (thickness / 20) * 14;

    const color = state.annoColor || '#ef4444';

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);

    if (isHighlighter) {
        // Highlighter: flat semi-transparent rectangle feel
        ctx.clearRect(0, 0, size, size);
        const hw = radius * 2.5;
        const hh = radius * 0.9;
        ctx.fillStyle = hexToRgba(color, 0.45);
        ctx.fillRect(size / 2 - hw / 2, size / 2 - hh / 2, hw, hh);
    } else {
        ctx.fillStyle = color;
        ctx.fill();
    }
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
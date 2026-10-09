// ============================================================================
// js/floattools.js — Floating Annotation Toolbar drag engine
// ============================================================================
// The annotation + link tools (former header Groups 1-3) live in the liquid
// glass palette #float-toolbar (see index.html, inside #workspace-main).
// This module owns ONLY the palette's position: default placement, smooth
// dragging, clamping, re-dock and persistence. Tool BUSINESS LOGIC (what the
// buttons do) stays in ui.js (setAppMode / setAnnoTool) — completely
// untouched by this file.
//
// Smoothness (same engine design as the floating sidebar in ui.js):
//   * The position is applied exclusively through transform: translate3d(...)
//     (GPU-composited — no layout, no reflow) with requestAnimationFrame
//     coalescing, so dragging tracks the pointer 1:1 at display refresh rate.
//   * A short CSS transition on transform gives a soft glide for programmatic
//     moves (re-dock / resize re-clamp); body.ft-dragging turns that
//     transition OFF during a drag for zero lag.
//
// Positioning contract:
//   * state.floatToolbarPos === null → docked at the DEFAULT spot: top-center
//     of the workspace, just below the minimize-button row (the closest
//     floating equivalent of the old header position). This stays "dock-like"
//     — it re-centers on workspace/toolbar size changes — until the user
//     drags the bar at least once.
//   * After a drag, state.floatToolbarPos = { x, y } is persisted via
//     saveSettings() and restored (validated + re-clamped) on boot.
//   * The bar is always clamped fully inside #workspace-main, so the grip can
//     never be lost off-screen.
//
// The toolbar is ALWAYS visible (it has no open/close toggle), so applying a
// position never has to wait for a visibility class.
// ----------------------------------------------------------------------------

let ftCurrentPos = null;        // last APPLIED position {x,y} (workspace CSS px)
let ftDragCtx = null;           // active drag: {startX, startY, origX, origY, pointerId}
let ftPendingXY = null;         // rAF-coalesced next position
let ftRafPending = false;
let ftLastGripTap = 0;          // double-tap-to-re-dock detection (works for touch too)
let ftLastGripTapXY = { x: 0, y: 0 };

// Default resting position: horizontally centered near the top of the
// workspace. y=44 clears the floating minimize buttons (top:10px + 26px tall
// + margin) so the palette never hides them in its docked spot.
function floatToolbarDefaultPos() {
    const ws = document.getElementById('workspace-main');
    const tb = document.getElementById('float-toolbar');
    if (!ws || !tb) return { x: 0, y: 0 };
    const wsRect = ws.getBoundingClientRect();
    const tbRect = tb.getBoundingClientRect();
    return {
        x: Math.max(0, Math.round((wsRect.width - tbRect.width) / 2)),
        y: 44,
    };
}

// Keep the bar fully inside the workspace: x ∈ [0, wsW - tbW],
// y ∈ [0, wsH - tbH]. Non-finite input falls back to the default spot.
function clampFloatToolbarPos(x, y) {
    if (!isFinite(x) || !isFinite(y)) return floatToolbarDefaultPos();
    const ws = document.getElementById('workspace-main');
    const tb = document.getElementById('float-toolbar');
    if (!ws || !tb) return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
    const wsRect = ws.getBoundingClientRect();
    const tbRect = tb.getBoundingClientRect(); // transform does not affect size
    const maxX = Math.max(0, wsRect.width - tbRect.width);
    const maxY = Math.max(0, wsRect.height - tbRect.height);
    return {
        x: Math.min(Math.max(0, Math.round(x)), Math.round(maxX)),
        y: Math.min(Math.max(0, Math.round(y)), Math.round(maxY)),
    };
}

// Resolve the position to apply: the saved/dragged position when valid,
// otherwise the default spot — always clamped to the current workspace.
function ftResolvePos() {
    if (state.floatToolbarPos &&
        isFinite(state.floatToolbarPos.x) && isFinite(state.floatToolbarPos.y)) {
        return clampFloatToolbarPos(state.floatToolbarPos.x, state.floatToolbarPos.y);
    }
    const d = floatToolbarDefaultPos();
    return clampFloatToolbarPos(d.x, d.y);
}

// Write the position into the inline transform. Called directly by the rAF
// batch and by the drag-end flush.
function ftWriteTransform(pos) {
    const tb = document.getElementById('float-toolbar');
    if (!tb) return;
    ftCurrentPos = pos;
    tb.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0px)`;
}

// Apply the resolved position to the toolbar. Safe to call repeatedly — every
// boot / resize / re-dock path funnels through here.
function applyFloatToolbarPos() {
    const tb = document.getElementById('float-toolbar');
    if (!tb) return;
    const pos = ftResolvePos();
    // First-ever apply: the inline transform is still empty, so the element
    // would animate from the CSS default (0,0) to the dock spot. Disable the
    // transition for this one write, force a reflow, then re-enable — later
    // programmatic moves (re-dock / re-clamp) glide as intended.
    const firstApply = !tb.style.transform;
    if (firstApply) tb.style.transition = 'none';
    ftWriteTransform(pos);
    if (firstApply) { void tb.offsetWidth; tb.style.transition = ''; }
}

// rAF-coalesced move used while dragging: stores the latest target and
// schedules a single frame to apply it (multiple pointermove events between
// frames collapse into one style write).
function moveFloatToolbarTo(x, y) {
    ftPendingXY = { x, y };
    if (ftRafPending) return;
    ftRafPending = true;
    requestAnimationFrame(() => {
        ftRafPending = false;
        if (!ftPendingXY) return;
        const p = clampFloatToolbarPos(ftPendingXY.x, ftPendingXY.y);
        ftPendingXY = null;
        ftWriteTransform(p);
    });
}

// pointerdown on the grip: start a drag (or detect a double-tap → re-dock).
// preventDefault + setPointerCapture keep the gesture ours: no text
// selection, no focus steal, and — because the grip is inside the guarded
// #float-toolbar island — the annotation pointer handlers never see it.
function beginFloatToolbarDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const tb = document.getElementById('float-toolbar');
    if (!tb) return;
    // Double-tap / double-click on the grip (works for mouse AND touch)
    // re-docks the toolbar to its default spot.
    const now = Date.now();
    const dist = Math.hypot(e.clientX - ftLastGripTapXY.x, e.clientY - ftLastGripTapXY.y);
    if (now - ftLastGripTap < 350 && dist < 8) {
        ftLastGripTap = 0;
        resetFloatToolbarPos();
        return;
    }
    ftLastGripTap = now;
    ftLastGripTapXY = { x: e.clientX, y: e.clientY };
    const startPos = ftCurrentPos || floatToolbarDefaultPos();
    ftDragCtx = {
        startX: e.clientX, startY: e.clientY,
        origX: startPos.x, origY: startPos.y,
        pointerId: e.pointerId,
    };
    document.body.classList.add('ft-dragging');
    if (e.preventDefault) e.preventDefault();
    try {
        if (e.target && e.target.setPointerCapture && e.pointerId !== undefined) {
            e.target.setPointerCapture(e.pointerId);
        }
    } catch (_) { /* capture is best-effort; window listeners cover the rest */ }
    if (!ftCurrentPos) ftWriteTransform(clampFloatToolbarPos(startPos.x, startPos.y));
    window.addEventListener('pointermove', moveFloatToolbarDrag, { passive: false });
    window.addEventListener('pointerup', endFloatToolbarDrag);
    window.addEventListener('pointercancel', endFloatToolbarDrag);
}

function moveFloatToolbarDrag(e) {
    if (!ftDragCtx) return;
    if (e.pointerId !== undefined && ftDragCtx.pointerId !== undefined &&
        e.pointerId !== ftDragCtx.pointerId) return;
    if (e.cancelable) e.preventDefault();
    moveFloatToolbarTo(
        ftDragCtx.origX + (e.clientX - ftDragCtx.startX),
        ftDragCtx.origY + (e.clientY - ftDragCtx.startY));
}

function endFloatToolbarDrag() {
    if (!ftDragCtx) return;
    const ctx = ftDragCtx;
    ftDragCtx = null;
    document.body.classList.remove('ft-dragging');
    window.removeEventListener('pointermove', moveFloatToolbarDrag);
    window.removeEventListener('pointerup', endFloatToolbarDrag);
    window.removeEventListener('pointercancel', endFloatToolbarDrag);
    // Flush a still-pending rAF target so the persisted position matches the
    // visual resting position exactly (very fast flicks can leave one queued).
    if (ftPendingXY) {
        ftWriteTransform(clampFloatToolbarPos(ftPendingXY.x, ftPendingXY.y));
        ftPendingXY = null;
    }
    // Persist only REAL drags: a plain tap (or 1-2px of jitter) must not turn
    // the docked default into an explicit saved position — an untouched bar
    // keeps re-centering with the workspace on resize.
    if (ftCurrentPos) {
        const moved = Math.hypot(ftCurrentPos.x - ctx.origX, ftCurrentPos.y - ctx.origY);
        if (moved >= 3) {
            state.floatToolbarPos = { x: ftCurrentPos.x, y: ftCurrentPos.y };
        }
    }
    saveSettings();
}

// Double-tap on the grip: forget the dragged position — the bar glides back
// to its default top-center spot and, being un-personalized again, follows
// the workspace on resize.
function resetFloatToolbarPos() {
    state.floatToolbarPos = null;
    applyFloatToolbarPos();
    saveSettings();
}

// Workspace size changes (file sidebar collapse/expand, split resizer, panel
// minimize, window resize) AND toolbar size changes (pen customization
// appearing/disappearing, wrap on narrow screens) both re-apply the position:
// a dragged bar is re-clamped, a never-dragged bar re-centers. Writing the
// transform changes no layout, so the observers can never loop.
function handleFloatToolbarResize() {
    applyFloatToolbarPos();
}

// Bind the grip + size observation. Called once from app.js boot.
function initFloatToolbarDrag() {
    const grip = document.getElementById('ft-drag-handle');
    if (grip) grip.addEventListener('pointerdown', beginFloatToolbarDrag);
    applyFloatToolbarPos();   // the toolbar is always visible — place it now
    const ws = document.getElementById('workspace-main');
    const tb = document.getElementById('float-toolbar');
    if (typeof ResizeObserver !== 'undefined' && ws && ws.addEventListener) {
        const ro = new ResizeObserver(() => handleFloatToolbarResize());
        ro.observe(ws);
        if (tb) ro.observe(tb);   // bar width changes (pen options, wrap) too
    } else {
        window.addEventListener('resize', handleFloatToolbarResize);
    }
}

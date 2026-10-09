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
//   * state.floatToolbarPos === null → docked at the DEFAULT spot. The spot
//     is ORIENTATION-SPECIFIC: the horizontal ribbon docks top-center (just
//     below the minimize-button row — the closest floating equivalent of the
//     old header position), the vertical rail docks flush left-center like a
//     classic toolbox (the liquid-glass sidebar owns the top-right corner).
//     Either default stays "dock-like" — it re-centers on workspace/toolbar
//     size changes — until the user drags the bar at least once.
//   * After a drag, state.floatToolbarPos = { x, y } is persisted via
//     saveSettings() and restored (validated + re-clamped) on boot. The
//     position is orientation-independent: switching orientation keeps the
//     personalized spot and re-clamps it to fit the new footprint.
//   * The bar is always clamped fully inside #workspace-main, so the grip can
//     never be lost off-screen.
//
// Orientation contract (state.floatToolbarOrientation 'horizontal'|'vertical'):
//   * #ft-orient-toggle flips between the horizontal ribbon and the vertical
//     rail (#float-toolbar.ft-vertical class). Its icon/title always advertise
//     the orientation the NEXT click will produce.
//   * The class flip is applied synchronously, then the position is
//     re-applied (default → orientation-specific re-center; dragged →
//     re-clamp) — measurement right after classList.toggle already sees the
//     new layout. The choice persists via saveSettings() and is restored on
//     boot by initFloatToolbarDrag() (skipSave: boot must not dirty settings).
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

// Default resting position, per orientation: the horizontal ribbon centers
// near the top of the workspace (y=44 clears the floating minimize buttons —
// top:10px + 26px tall + margin — so the palette never hides them in its
// docked spot); the vertical rail docks left-center (see below).
function floatToolbarDefaultPos() {
    const ws = document.getElementById('workspace-main');
    const tb = document.getElementById('float-toolbar');
    if (!ws || !tb) return { x: 0, y: 0 };
    const wsRect = ws.getBoundingClientRect();
    const tbRect = tb.getBoundingClientRect();
    // Vertical rail: dock flush left-center like a classic toolbox (small
    // margin off the left edge; vertically centered). Left, not right — the
    // floating sidebar's default dock occupies the top-right corner.
    if (tb.classList && tb.classList.contains('ft-vertical')) {
        return {
            x: 8,
            y: Math.max(0, Math.round((wsRect.height - tbRect.height) / 2)),
        };
    }
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
    // Moving the toolbar moves the flyout anchors — always close both
    // flyouts when a drag (or a double-tap re-dock) starts.
    // (js/sizemenu.js + js/colormenu.js own them; typeof-guarded so this
    // engine also runs without them.)
    if (typeof closeToolSizeMenu === 'function') closeToolSizeMenu();
    if (typeof closeToolColorMenu === 'function') closeToolColorMenu();
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
// to its default spot (top-center ribbon / left-center rail) and, being
// un-personalized again, follows the workspace on resize.
function resetFloatToolbarPos() {
    state.floatToolbarPos = null;
    applyFloatToolbarPos();
    saveSettings();
}

// ---------------------------------------------------------------------------
// Orientation: horizontal ribbon (default) ⇄ vertical rail. The palette's
// #ft-orient-toggle button flips between them; the choice persists in the
// settings blob and is re-applied on boot.
// ---------------------------------------------------------------------------

// Apply an orientation to the toolbar ('horizontal' | 'vertical'). Unknown
// values are rejected: boot only ever passes validated input, but a stray
// call must never corrupt the layout. After flipping the class the position
// is re-applied — the DEFAULT spot is orientation-specific and a DRAGGED
// position is re-clamped to fit the new footprint (classList.toggle and
// getBoundingClientRect are synchronous, so the measurement below already
// sees the new orientation's layout). opts.skipSave keeps boot-time
// re-application from dirtying the settings blob.
function setFloatToolbarOrientation(orient, opts = {}) {
    if (orient !== 'horizontal' && orient !== 'vertical') return false;
    const tb = document.getElementById('float-toolbar');
    if (!tb) return false;
    // The flip re-places the whole palette (orientation-specific default spot
    // or re-clamped dragged spot) — the flyouts' anchors would move with it,
    // so both close instead of following (js/sizemenu.js + js/colormenu.js
    // own them).
    if (typeof closeToolSizeMenu === 'function') closeToolSizeMenu();
    if (typeof closeToolColorMenu === 'function') closeToolColorMenu();
    tb.classList.toggle('ft-vertical', orient === 'vertical');
    state.floatToolbarOrientation = orient;
    // The toggle always advertises the orientation the NEXT click produces:
    // in the ribbon it offers vertical (up-down arrows), in the rail it
    // offers horizontal (left-right arrows).
    const btn = document.getElementById('ft-orient-toggle');
    if (btn) {
        const toVertical = orient === 'horizontal';
        const icon = btn.querySelector ? btn.querySelector('i') : null;
        if (icon) icon.className = toVertical
            ? 'fa-solid fa-arrows-up-down'
            : 'fa-solid fa-arrows-left-right';
        btn.title = toVertical
            ? 'Switch toolbar to vertical'
            : 'Switch toolbar to horizontal';
        if (btn.setAttribute) {
            btn.setAttribute('aria-label', toVertical
                ? 'Switch annotation toolbar to vertical'
                : 'Switch annotation toolbar to horizontal');
        }
    }
    applyFloatToolbarPos();          // re-center (default) / re-clamp (dragged)
    if (!opts.skipSave) saveSettings();
    return true;
}

// Click handler of #ft-orient-toggle: flip between the two orientations.
function toggleFloatToolbarOrientation() {
    return setFloatToolbarOrientation(
        state.floatToolbarOrientation === 'vertical' ? 'horizontal' : 'vertical');
}

// Workspace size changes (file sidebar collapse/expand, split resizer, panel
// minimize, window resize) AND toolbar size changes (pen customization
// appearing/disappearing, wrap on narrow screens) both re-apply the position:
// a dragged bar is re-clamped, a never-dragged bar re-centers. Writing the
// transform changes no layout, so the observers can never loop.
function handleFloatToolbarResize() {
    // A resize can move the toolbar under an open flyout — closing keeps
    // both flyouts always visually anchored to their controls
    // (js/sizemenu.js + js/colormenu.js own them; typeof-guarded so this
    // engine also runs without them).
    if (typeof closeToolSizeMenu === 'function') closeToolSizeMenu();
    if (typeof closeToolColorMenu === 'function') closeToolColorMenu();
    applyFloatToolbarPos();
}

// Bind the grip + orientation toggle + size observation. Called once from
// app.js boot. The persisted orientation is applied here (state was already
// validated by app.js; skipSave — boot must not dirty the settings blob),
// which also places the bar for that orientation BEFORE the observers are
// wired, so the ResizeObserver baseline is the restored footprint.
function initFloatToolbarDrag() {
    const grip = document.getElementById('ft-drag-handle');
    if (grip) grip.addEventListener('pointerdown', beginFloatToolbarDrag);
    const orientBtn = document.getElementById('ft-orient-toggle');
    if (orientBtn) orientBtn.addEventListener('click', toggleFloatToolbarOrientation);
    setFloatToolbarOrientation(
        state.floatToolbarOrientation === 'vertical' ? 'vertical' : 'horizontal',
        { skipSave: true });
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

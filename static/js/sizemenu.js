// ============================================================================
// js/sizemenu.js — Tool Size Flyout (#tool-size-menu), Apple-Notes style
// ============================================================================
// Secondary menu for the pen / highlighter / eraser sizes. The toolbar no
// longer carries an inline thickness slider (it looked wrong standing inside
// the vertical rail and showed no numeric value); instead:
//
// BEHAVIOR CONTRACT (user-facing):
//   * FIRST tap on pen / highlighter / eraser-pixel / eraser-stroke selects
//     the tool exactly as before (setAnnoTool in ui.js — business logic
//     untouched; keyboard shortcuts and programmatic switches also unchanged).
//   * A SECOND tap on the ALREADY-ACTIVE tool (in annotation mode) opens this
//     flyout; a third tap on the same button — or any click outside it —
//     closes it again. The menu NEVER auto-opens on plain tool selection.
//   * The flyout lists preset sizes as live stroke previews drawn with the
//     tool's own color/opacity; every row is labeled with its NUMERIC value
//     and the header shows the CURRENT size (integer or float) so the user
//     always knows which size the tool is using. A tiny numeric badge on the
//     active tool button keeps the current size visible while closed.
//   * Tapping a size row applies it immediately (persisted via
//     saveSettings()) and keeps the menu open so sizes can be compared; the
//     menu closes on pointerdown anywhere outside it, Escape, tool switch
//     (ui.js setAnnoTool calls closeToolSizeMenu), orientation flip, toolbar
//     drag/re-dock/resize (floattools.js calls closeToolSizeMenu, guarded).
// PLACEMENT:
//   * Body-level position:fixed element — anchored right of the tool button
//     in the vertical rail (falling back to the left near the right edge),
//     below the button in the horizontal ribbon (falling back above near the
//     bottom), always clamped inside the viewport. The workspace overflow
//     can never clip it.
// SEPARATION OF CONCERNS:
//   * This module owns ONLY the flyout (open/close/render/position/apply).
//     floattools.js remains the position/orientation engine of the toolbar
//     itself; ui.js keeps the tool business logic. This module reads UI state
//     (state.annoTool / state.annoThickness) and writes ONLY size state —
//     the same writes the old inline slider performed in app.js.
// ============================================================================

// ---- Module state ----------------------------------------------------------
let tsmOpen = false;            // menu currently visible?
let tsmOwnerTool = null;        // tool whose button owns the open menu
let tsmOwnerBtn = null;         // that button element (anchor + toggle exemption)

// Tools that get a size flyout (all have state.toolSettings[tool].thickness).
const FT_SIZE_TOOLS = ['pen', 'highlighter', 'eraser-pixel', 'eraser-stroke'];
const FT_SIZE_PRESETS = [1, 3, 5, 8, 12, 20];
const FT_SIZE_MIN = 1;
const FT_SIZE_MAX = 20;
const FT_SIZE_TITLES = {
    'pen': 'Pen Size',
    'highlighter': 'Highlighter Size',
    'eraser-pixel': 'Pixel Eraser Size',
    'eraser-stroke': 'Stroke Eraser Size',
};

// ---- Small helpers ----------------------------------------------------------

// The tool button id for a size tool ('pen' -> 'tool-pen', etc.) — all four
// ids follow the same pattern.
function ftSizeToolBtnId(tool) {
    return 'tool-' + tool;
}

// "5" stays "5", "3.5" stays "3.5", "2.25" stays "2.25" — the numeric value
// is always shown exactly (trailing zeros trimmed) so the user can read the
// current tool size at a glance.
function formatToolSize(v) {
    const num = parseFloat(v);
    if (!isFinite(num)) return '';
    if (Number.isInteger(num)) return String(num);
    return String(parseFloat(num.toFixed(2)));
}

function toolSizeMenuEl() {
    return document.getElementById('tool-size-menu');
}

function isToolSizeMenuOpen() {
    return tsmOpen;
}

// Color a tool currently draws with (erasers preview in neutral gray).
function tsmToolColor(tool) {
    if (tool === 'eraser-pixel' || tool === 'eraser-stroke') return '#64748b';
    const ts = state.toolSettings && state.toolSettings[tool];
    return (ts && ts.color) || state.annoColor || '#ef4444';
}

// ---- Open / close / toggle --------------------------------------------------

// Dispatcher behind the pen / highlighter / eraser tool buttons (the onclick
// in index.html points here instead of straight at setAnnoTool):
//   * tool not active yet (or the app is not even in annotation mode — e.g.
//     the user navigated away and now taps the tool again to resume drawing)
//       -> plain selection (menu stays closed)
//   * tool already active IN annotation mode -> toggle the size flyout
function handleToolBtnTap(tool) {
    const activeInAnnotation = state.annoTool === tool &&
        (state.appMode === undefined || state.appMode === 'annotation');
    if (FT_SIZE_TOOLS.indexOf(tool) !== -1 && activeInAnnotation) {
        toggleToolSizeMenu(tool);
        return;
    }
    closeToolSizeMenu();
    setAnnoTool(tool);
}

function toggleToolSizeMenu(tool) {
    if (tsmOpen && tsmOwnerTool === tool) {
        closeToolSizeMenu();
        return;
    }
    openToolSizeMenu(tool);
}

function openToolSizeMenu(tool) {
    const menu = toolSizeMenuEl();
    const btn = document.getElementById(ftSizeToolBtnId(tool));
    if (!menu || !btn) return;
    // The two flyouts are mutually exclusive: opening the size flyout
    // dismisses the color palette (js/colormenu.js does the same in reverse).
    if (typeof closeToolColorMenu === 'function') closeToolColorMenu();
    tsmOpen = true;
    tsmOwnerTool = tool;
    tsmOwnerBtn = btn;
    renderToolSizeMenu();
    // Unhide for synchronous measurement, place, force a reflow so the pop
    // transition actually starts from the hidden state, then animate in.
    menu.classList.remove('tsm-hidden');
    positionToolSizeMenu();
    void menu.offsetWidth;
    menu.classList.add('tsm-open');
    btn.setAttribute('aria-expanded', 'true');
    bindTsmOutsideClose();
}

function closeToolSizeMenu() {
    const menu = toolSizeMenuEl();
    if (menu) {
        menu.classList.remove('tsm-open');
        menu.classList.add('tsm-hidden');
    }
    if (tsmOwnerBtn) {
        try { tsmOwnerBtn.setAttribute('aria-expanded', 'false'); } catch (_) {}
    }
    tsmOpen = false;
    tsmOwnerTool = null;
    tsmOwnerBtn = null;
    unbindTsmOutsideClose();
}

// ---- Rendering --------------------------------------------------------------

// Rebuild the flyout contents for the owner tool: header title + numeric
// value chip, then one preview row per preset size.
function renderToolSizeMenu() {
    const menu = toolSizeMenuEl();
    if (!menu) return;
    const tool = tsmOwnerTool || state.annoTool;
    const title = document.getElementById('tsm-title');
    if (title) title.textContent = FT_SIZE_TITLES[tool] || 'Tool Size';
    tsmUpdateValueChip();
    const wrap = document.getElementById('tsm-options');
    if (!wrap) return;
    wrap.innerHTML = '';
    const color = tsmToolColor(tool);
    const current = parseFloat(state.annoThickness);
    FT_SIZE_PRESETS.forEach((size) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tsm-row';
        row.setAttribute('data-size', String(size));
        row.setAttribute('role', 'menuitemradio');
        row.title = 'Size ' + formatToolSize(size);
        const isActive = isFinite(current) && current === size;
        if (isActive) {
            row.classList.add('tsm-active');
            row.setAttribute('aria-checked', 'true');
        } else {
            row.setAttribute('aria-checked', 'false');
        }
        const canvas = document.createElement('canvas');
        canvas.className = 'tsm-canvas';
        tsmDrawStrokePreview(canvas, size, color, tool);
        const val = document.createElement('span');
        val.className = 'tsm-val';
        val.textContent = formatToolSize(size);
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check tsm-check';
        row.appendChild(canvas);
        row.appendChild(val);
        row.appendChild(check);
        row.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            applyToolSize(size);
        });
        wrap.appendChild(row);
    });
}

// Apply a size chosen in the flyout to the ACTIVE tool: state + per-tool
// settings + persistence + every numeric readout (value chip, row check
// marks, button badge, pen-options preview dot).
function applyToolSize(v) {
    const num = parseFloat(v);
    if (!isFinite(num)) return false;
    const clamped = Math.min(FT_SIZE_MAX, Math.max(FT_SIZE_MIN, num));
    const tool = tsmOwnerTool || state.annoTool;
    state.annoThickness = clamped;
    // Eraser tool ids are hyphenated, their settings buckets camelCase
    // (toolSettingsKeyFor, utils.js); fall back to the raw id so blobs saved
    // by older builds still receive updates.
    if (state.toolSettings) {
        const key = (typeof toolSettingsKeyFor === 'function') ? toolSettingsKeyFor(tool) : tool;
        const bucket = state.toolSettings[key] || state.toolSettings[tool];
        if (bucket) bucket.thickness = clamped;
        else state.toolSettings[key] = { thickness: clamped };
    }
    saveSettings();
    tsmUpdateValueChip();
    tsmMarkActiveRow();
    updateToolSizeBadge();
    if (typeof updateThicknessPreview === 'function') updateThicknessPreview();
    return true;
}

function tsmUpdateValueChip() {
    const chip = document.getElementById('tsm-value');
    if (chip) chip.textContent = formatToolSize(state.annoThickness) || '-';
}

// Sync the row check marks after a size change (rows survive; only the
// active one changes, so the previews are NOT redrawn).
function tsmMarkActiveRow() {
    const wrap = document.getElementById('tsm-options');
    if (!wrap) return;
    const current = parseFloat(state.annoThickness);
    const rows = wrap.querySelectorAll ? wrap.querySelectorAll('.tsm-row') : [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const size = parseFloat(row.getAttribute('data-size'));
        const isActive = isFinite(current) && isFinite(size) && current === size;
        row.classList.toggle('tsm-active', isActive);
        row.setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
}

// Draw one stroke preview: a horizontal stroke of the given width in the
// tool's current color (semi-transparent flat stroke for the highlighter,
// neutral gray for the erasers), DPR-scaled for crispness.
function tsmDrawStrokePreview(canvas, size, color, tool) {
    if (!canvas || !canvas.getContext) return;
    const w = 72, h = 26;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const lw = Math.min(size, h - 4);
    const y = h / 2;
    ctx.lineCap = tool === 'highlighter' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = tool === 'highlighter' ? 0.45 : 1;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(w - 6, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
}

// ---- Placement ---------------------------------------------------------------

// Place the flyout next to the owner tool button, clamped to the viewport.
// Vertical rail -> beside the button (right, then left); horizontal ribbon
// -> below the button, then above. transform-origin follows the placement
// so the pop animation grows out of the anchor.
function positionToolSizeMenu() {
    const menu = toolSizeMenuEl();
    const btn = tsmOwnerBtn;
    if (!menu || !btn || !menu.getBoundingClientRect) return;
    // Measure the menu's UNTRANSFORMED layout size: at this point the menu
    // still carries its scale(0.9) hidden state, and getBoundingClientRect()
    // would return the scaled (smaller) box — the flyout would land ~10% off
    // its anchor. offsetWidth/offsetHeight are transform-independent.
    const mRect = {
        width: menu.offsetWidth || menu.getBoundingClientRect().width,
        height: menu.offsetHeight || menu.getBoundingClientRect().height,
    };
    const bRect = btn.getBoundingClientRect();
    const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
    const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
    const M = 8;   // viewport margin
    const G = 8;   // gap between button and menu
    const tb = document.getElementById('float-toolbar');
    const vertical = !!(tb && tb.classList && tb.classList.contains('ft-vertical'));
    let x, y, origin;
    if (vertical) {
        x = bRect.right + G;
        if (x + mRect.width > vw - M) x = bRect.left - G - mRect.width;
        origin = (x >= bRect.right) ? 'left center' : 'right center';
        y = bRect.top + bRect.height / 2 - mRect.height / 2;
    } else {
        y = bRect.bottom + G;
        if (y + mRect.height > vh - M) y = bRect.top - G - mRect.height;
        origin = (y >= bRect.bottom) ? 'center top' : 'center bottom';
        x = bRect.left + bRect.width / 2 - mRect.width / 2;
    }
    x = Math.min(Math.max(M, x), Math.max(M, vw - M - mRect.width));
    y = Math.min(Math.max(M, y), Math.max(M, vh - M - mRect.height));
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
    menu.style.transformOrigin = origin;
}

// ---- Outside close -------------------------------------------------------------

// Capture-phase closer: any pointerdown outside the flyout dismisses it,
// EXCEPT on the owning tool button (its click toggles instead — closing on
// its pointerdown would make the click immediately re-open the menu).
// Clicks INSIDE the menu never close it (sizes stay comparable).
function tsmOnDocPointerDown(e) {
    if (!tsmOpen) return;
    const target = e.target;
    if (!(target && target.closest)) return;
    if (target.closest('#tool-size-menu')) return;
    if (tsmOwnerBtn && tsmOwnerBtn.contains && tsmOwnerBtn.contains(target)) return;
    closeToolSizeMenu();
}
function bindTsmOutsideClose() {
    if (document.addEventListener) {
        document.addEventListener('pointerdown', tsmOnDocPointerDown, true);
    }
}
function unbindTsmOutsideClose() {
    if (document.removeEventListener) {
        document.removeEventListener('pointerdown', tsmOnDocPointerDown, true);
    }
}

// ---- Numeric badge --------------------------------------------------------------

// Tiny numeric badge on the ACTIVE size tool's button showing the current
// size at all times (menu closed or open). Rebuilt on every call — zero
// stale-badge paths. ui.js setAnnoTool calls this after every tool switch;
// applyToolSize calls it after every size change.
function updateToolSizeBadge() {
    const tb = document.getElementById('float-toolbar');
    if (!tb || !tb.querySelectorAll) return;
    const stale = tb.querySelectorAll('.tool-size-badge');
    for (let i = 0; i < stale.length; i++) stale[i].remove();
    const tool = state.annoTool;
    if (FT_SIZE_TOOLS.indexOf(tool) === -1) return;
    const text = formatToolSize(state.annoThickness);
    if (!text) return;
    const btn = document.getElementById(ftSizeToolBtnId(tool));
    if (!btn) return;
    const badge = document.createElement('span');
    badge.className = 'tool-size-badge';
    badge.textContent = text;
    btn.appendChild(badge);
}

// ---- Boot ------------------------------------------------------------------------

// Called once from app.js boot: binds the Escape closer and draws the badge
// for a restored size-adjustable active tool (settings blob).
function initToolSizeMenu() {
    if (document.addEventListener) {
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Escape' || e.key === 'Esc') && tsmOpen) closeToolSizeMenu();
        });
    }
    updateToolSizeBadge();
}

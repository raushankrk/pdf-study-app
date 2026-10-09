// ============================================================================
// js/colormenu.js — Tool Color Flyout (#tool-color-menu), Apple-Notes style
// ============================================================================
// iPad / iOS BUG FIX. The old color flow was:
//     tap #thickness-preview-canvas  ->  hidden <input type="color">.click()
// iOS Safari has NEVER supported <input type="color"> (it degrades to a text
// input and no picker UI exists), so color selection silently did nothing on
// iPad — while laptops and Android (both with native color pickers) worked.
// The fix removes the native-input dependency completely: tapping the preview
// canvas now opens THIS custom palette — plain DOM buttons + a hex field, so
// it behaves identically on iPad, Android, and desktop.
//
// BEHAVIOR CONTRACT (user-facing):
//   * Tap the color preview canvas (in #pen-customization) -> this flyout
//     opens anchored to the canvas (right/left of it in the vertical rail,
//     below/above it in the horizontal ribbon — always viewport-clamped).
//     Tapping the canvas again toggles it closed.
//   * Header shows the CURRENT color as a swatch + exact hex value
//     (e.g. "#EF4444") so the user always knows which color is active —
//     same "show the value" pattern as the size flyout's numeric chip.
//   * 15 professional preset swatches (GoodNotes / Apple-Freeform feel).
//     Tapping one applies it immediately and keeps the menu open so colors
//     can be compared; the active swatch carries a check.
//   * Custom row: a hex text field (works on EVERY platform, iPad included)
//     plus — only where the browser really supports it (feature-detected,
//     so it stays hidden on iOS) — a native <input type="color"> chip for
//     desktop-style arbitrary picking. Live-apply while typing; invalid
//     input reverts on blur/Enter.
//   * Colors are PER TOOL: the menu edits the ACTIVE line tool's bucket
//     (state.toolSettings[tool].color) and mirrors it into state.annoColor
//     — the exact writes the old native-input 'input' listener performed.
//   * Closing: pointerdown anywhere outside the menu (the anchor canvas
//     instead toggles), Escape, tool switch (ui.js setAnnoTool), opening the
//     size flyout, orientation flip, toolbar drag/re-dock/resize
//     (floattools.js guarded closeToolColorMenu calls).
// SEPARATION OF CONCERNS:
//   * Mirrors js/sizemenu.js: this module owns ONLY the flyout. floattools.js
//     stays the position/orientation engine; ui.js keeps business logic.
//     This module reads UI state and writes ONLY color state.
// ============================================================================

// ---- Module state ----------------------------------------------------------
let tcmOpen = false;            // menu currently visible?
let tcmOwnerTool = null;        // line tool whose color the menu edits
let tcmAnchorEl = null;         // #thickness-preview-canvas (anchor + toggle exemption)
let _tcmNativeSupported = null; // cached <input type="color"> support probe

// Professional preset palette (neutrals + full rainbow; includes the app's
// defaults #ef4444 (pen) and #facc15 (highlighter) so the current color is
// always highlighted in the grid).
const FT_COLORS = [
    '#111827', // ink black
    '#6b7280', // gray
    '#ef4444', // red        (pen default)
    '#f97316', // orange
    '#f59e0b', // amber
    '#facc15', // yellow     (highlighter default)
    '#a3e635', // lime
    '#22c55e', // green
    '#14b8a6', // teal
    '#06b6d4', // cyan
    '#3b82f6', // blue
    '#6366f1', // indigo
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#78350f', // brown
];
const FT_COLOR_TITLES = {
    'pen': 'Pen Color',
    'highlighter': 'Highlighter Color',
};

// ---- Small helpers ----------------------------------------------------------

// Strict hex normalizer: accepts '#rgb', '#rrggbb', 'rgb', 'RRGGBB'.
// Returns lowercase '#rrggbb' or null when the input is not a valid color.
function normalizeHexColor(v) {
    if (typeof v !== 'string') return null;
    let s = v.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(s)) {
        s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    }
    if (!/^[0-9a-f]{6}$/.test(s)) return null;
    return '#' + s;
}

function toolColorMenuEl() {
    return document.getElementById('tool-color-menu');
}

function isToolColorMenuOpen() {
    return tcmOpen;
}

// REAL feature detection for <input type="color">: on iOS Safari the input
// degrades to a text-type input, so probe.type falls back to 'text'. Only
// show the native chip where the picker actually exists (desktops/Android).
function deviceSupportsNativeColorInput() {
    if (_tcmNativeSupported !== null) return _tcmNativeSupported;
    try {
        const probe = document.createElement('input');
        probe.setAttribute('type', 'color');
        _tcmNativeSupported = ((probe.type || '') + '').toLowerCase() === 'color';
    } catch (_) {
        _tcmNativeSupported = false;
    }
    return _tcmNativeSupported;
}

// ---- Open / close / toggle --------------------------------------------------

// Toggle behind the color preview canvas (ui.js updateThicknessPreview binds
// canvas.onclick here). Tapping the canvas when closed opens the flyout;
// tapping it again closes it.
function toggleToolColorMenu() {
    if (tcmOpen) {
        closeToolColorMenu();
        return;
    }
    openToolColorMenu();
}

function openToolColorMenu() {
    const menu = toolColorMenuEl();
    const anchor = document.getElementById('thickness-preview-canvas');
    if (!menu || !anchor) return;
    // The two flyouts are mutually exclusive: opening the color palette
    // dismisses the size flyout (and vice versa in sizemenu.js).
    if (typeof closeToolSizeMenu === 'function') closeToolSizeMenu();
    tcmOpen = true;
    tcmOwnerTool = state.annoTool;
    tcmAnchorEl = anchor;
    renderToolColorMenu();
    // Unhide for synchronous measurement, place, force a reflow so the pop
    // transition actually starts from the hidden state, then animate in.
    menu.classList.remove('tcm-hidden');
    positionToolColorMenu();
    void menu.offsetWidth;
    menu.classList.add('tcm-open');
    anchor.setAttribute('aria-expanded', 'true');
    bindTcmOutsideClose();
}

function closeToolColorMenu() {
    const menu = toolColorMenuEl();
    if (menu) {
        menu.classList.remove('tcm-open');
        menu.classList.add('tcm-hidden');
    }
    if (tcmAnchorEl) {
        try { tcmAnchorEl.setAttribute('aria-expanded', 'false'); } catch (_) {}
    }
    tcmOpen = false;
    tcmOwnerTool = null;
    tcmAnchorEl = null;
    unbindTcmOutsideClose();
}

// ---- Rendering --------------------------------------------------------------

// Rebuild the flyout contents for the owner tool: header (title + current
// color chip with swatch + hex), the preset swatch grid, and the custom row
// (hex field + optional native picker chip).
function renderToolColorMenu() {
    const menu = toolColorMenuEl();
    if (!menu) return;
    const tool = tcmOwnerTool || state.annoTool;
    const current = normalizeHexColor(state.annoColor) || '#ef4444';

    const title = document.getElementById('tcm-title');
    if (title) title.textContent = FT_COLOR_TITLES[tool] || 'Color';

    // Custom row is static markup EXCEPT the native chip, which only exists
    // where <input type="color"> really works (never on iPad).
    const customRow = document.getElementById('tcm-custom-row');
    if (customRow) {
        const oldNative = document.getElementById('tcm-native');
        if (oldNative && oldNative.remove) oldNative.remove();
        if (deviceSupportsNativeColorInput()) {
            const native = document.createElement('input');
            native.type = 'color';
            native.id = 'tcm-native';
            native.className = 'tcm-native';
            native.setAttribute('title', 'Pick any color');
            native.value = current;
            native.addEventListener('input', (e) => {
                const hex = normalizeHexColor(e.target && e.target.value);
                if (hex) applyToolColor(hex);
            });
            customRow.insertBefore(native, customRow.firstChild);
        }
    }

    // Preset swatch grid.
    const wrap = document.getElementById('tcm-options');
    if (!wrap) return;
    wrap.innerHTML = '';
    FT_COLORS.forEach((color) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'tcm-swatch';
        sw.setAttribute('data-color', color);
        sw.setAttribute('role', 'menuitemradio');
        sw.title = color.toUpperCase();
        const isActive = color.toLowerCase() === current.toLowerCase();
        if (isActive) {
            sw.classList.add('tcm-active');
            sw.setAttribute('aria-checked', 'true');
        } else {
            sw.setAttribute('aria-checked', 'false');
        }
        sw.style.background = color;
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check tcm-check';
        sw.appendChild(check);
        sw.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            applyToolColor(color);
        });
        wrap.appendChild(sw);
    });

    tcmUpdateValueChip();
    // Sync the hex field too — it starts as static markup ("#EF4444") and
    // would otherwise show a STALE value whenever the current color differs.
    tcmSyncHexInput();
}

// Apply a color chosen in the flyout to the ACTIVE line tool: state mirror +
// per-tool settings + persistence + every readout (value chip, swatch checks,
// hex field, pen-options preview dot). Menu STAYS OPEN so colors compare.
function applyToolColor(v) {
    const hex = normalizeHexColor(v);
    if (!hex) return false;
    const tool = tcmOwnerTool || state.annoTool;
    state.annoColor = hex;
    // toolSettings buckets are camelCase for hyphenated ids (erasers) —
    // normalize via toolSettingsKeyFor, fall back to the raw id so blobs
    // saved by older builds still receive updates.
    if (state.toolSettings) {
        const key = (typeof toolSettingsKeyFor === 'function') ? toolSettingsKeyFor(tool) : tool;
        const bucket = state.toolSettings[key] || state.toolSettings[tool];
        if (bucket) bucket.color = hex;
        else state.toolSettings[key] = { color: hex };
    }
    saveSettings();
    tcmUpdateValueChip();
    tcmMarkActiveSwatch();
    tcmSyncHexInput();
    if (typeof updateThicknessPreview === 'function') updateThicknessPreview();
    return true;
}

function tcmUpdateValueChip() {
    const chipSwatch = document.getElementById('tcm-chip-swatch');
    // The hex TEXT lives in #tcm-value-text INSIDE the chip wrapper
    // (#tcm-value) — writing the wrapper's textContent would wipe the
    // chip's swatch element out of the DOM.
    const chipText = document.getElementById('tcm-value-text');
    const hex = normalizeHexColor(state.annoColor) || '#ef4444';
    if (chipSwatch) chipSwatch.style.background = hex;
    if (chipText) chipText.textContent = hex.toUpperCase();
}

// Sync the swatch check marks after a color change (previews are plain
// colored buttons — only the active one changes).
function tcmMarkActiveSwatch() {
    const wrap = document.getElementById('tcm-options');
    if (!wrap) return;
    const current = (normalizeHexColor(state.annoColor) || '').toLowerCase();
    const swatches = wrap.querySelectorAll ? wrap.querySelectorAll('.tcm-swatch') : [];
    for (let i = 0; i < swatches.length; i++) {
        const sw = swatches[i];
        const c = (sw.getAttribute('data-color') || '').toLowerCase();
        const isActive = !!current && c === current;
        sw.classList.toggle('tcm-active', isActive);
        sw.setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
}

// Mirror the current color into the hex field — but never while the user is
// actively typing in it (that would fight the keyboard).
function tcmSyncHexInput() {
    const inp = document.getElementById('tcm-hex');
    if (!inp) return;
    const active = (typeof document.activeElement === 'object' && document.activeElement) || null;
    if (active === inp) return;
    const hex = normalizeHexColor(state.annoColor) || '#ef4444';
    inp.value = hex.toUpperCase();
}

// ---- Placement ---------------------------------------------------------------

// Place the flyout next to the color preview canvas, clamped to the viewport.
// Same algorithm as the size flyout: vertical rail -> beside the anchor
// (right, then left); horizontal ribbon -> below the anchor, then above.
function positionToolColorMenu() {
    const menu = toolColorMenuEl();
    const anchor = tcmAnchorEl || document.getElementById('thickness-preview-canvas');
    if (!menu || !anchor || !menu.getBoundingClientRect) return;
    // Measure the UNTRANSFORMED layout size: at this point the menu still
    // carries its scale(0.9) hidden state, and getBoundingClientRect() would
    // return the scaled (smaller) box. offsetWidth/offsetHeight are
    // transform-independent (same fix as the size flyout).
    const mRect = {
        width: menu.offsetWidth || menu.getBoundingClientRect().width,
        height: menu.offsetHeight || menu.getBoundingClientRect().height,
    };
    const aRect = anchor.getBoundingClientRect();
    const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
    const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
    const M = 8;   // viewport margin
    const G = 8;   // gap between anchor and menu
    const tb = document.getElementById('float-toolbar');
    const vertical = !!(tb && tb.classList && tb.classList.contains('ft-vertical'));
    let x, y, origin;
    if (vertical) {
        x = aRect.right + G;
        if (x + mRect.width > vw - M) x = aRect.left - G - mRect.width;
        origin = (x >= aRect.right) ? 'left center' : 'right center';
        y = aRect.top + aRect.height / 2 - mRect.height / 2;
    } else {
        y = aRect.bottom + G;
        if (y + mRect.height > vh - M) y = aRect.top - G - mRect.height;
        origin = (y >= aRect.bottom) ? 'center top' : 'center bottom';
        x = aRect.left + aRect.width / 2 - mRect.width / 2;
    }
    x = Math.min(Math.max(M, x), Math.max(M, vw - M - mRect.width));
    y = Math.min(Math.max(M, y), Math.max(M, vh - M - mRect.height));
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
    menu.style.transformOrigin = origin;
}

// ---- Outside close -------------------------------------------------------------

// Capture-phase closer: any pointerdown outside the flyout dismisses it,
// EXCEPT on the anchor canvas (its click toggles instead — closing on its
// pointerdown would make the click immediately re-open the menu). Clicks
// INSIDE the menu never close it (colors stay comparable).
function tcmOnDocPointerDown(e) {
    if (!tcmOpen) return;
    const target = e.target;
    if (!(target && target.closest)) return;
    if (target.closest('#tool-color-menu')) return;
    if (tcmAnchorEl && tcmAnchorEl.contains && tcmAnchorEl.contains(target)) return;
    if (target === tcmAnchorEl) return;
    closeToolColorMenu();
}
function bindTcmOutsideClose() {
    if (document.addEventListener) {
        document.addEventListener('pointerdown', tcmOnDocPointerDown, true);
    }
}
function unbindTcmOutsideClose() {
    if (document.removeEventListener) {
        document.removeEventListener('pointerdown', tcmOnDocPointerDown, true);
    }
}

// ---- Boot ----------------------------------------------------------------------

// Called once from app.js boot: binds the Escape closer. The menu also binds
// its per-open listeners (hex field, native chip) in renderToolColorMenu.
function initToolColorMenu() {
    const hexInp = document.getElementById('tcm-hex');
    if (hexInp && hexInp.addEventListener) {
        hexInp.addEventListener('input', (e) => {
            // Live-apply complete valid colors while typing; incomplete input
            // is left alone (never fights the keyboard mid-edit).
            const hex = normalizeHexColor(e.target && e.target.value);
            if (hex) applyToolColor(hex);
        });
        hexInp.addEventListener('change', (e) => {
            // Enter / blur: invalid text reverts to the current color.
            const hex = normalizeHexColor(e.target && e.target.value);
            if (hex) applyToolColor(hex);
            else tcmSyncHexInput();
        });
    }
    if (document.addEventListener) {
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Escape' || e.key === 'Esc') && tcmOpen) closeToolColorMenu();
        });
    }
}

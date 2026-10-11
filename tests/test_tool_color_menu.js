// ============================================================================
// tests/test_tool_color_menu.js
// Regression suite: color selection moved from a hidden native
// <input type="color"> (which iOS Safari has NEVER supported — tapping the
// preview canvas on an iPad silently did nothing, while laptop/Android
// worked) into a custom Apple-Notes style liquid-glass palette
// (#tool-color-menu, js/colormenu.js) that is plain DOM and works on every
// platform. Same tool-separator task: ALL separators inside the floating
// annotation toolbar were removed (user request — they cost space; the
// groups' own rounded trays separate them).
//
// Feature contract:
//   * Markup: #tool-color-menu is a BODY-LEVEL element (outside
//     #workspace-main so overflow can never clip it) with #tcm-title,
//     #tcm-value (chip wrapper) > #tcm-chip-swatch + #tcm-value-text,
//     #tcm-options (JS-rendered swatch grid) and #tcm-custom-row
//     (#tcm-hex text field; the native chip #tcm-native is JS-rendered
//     ONLY where <input type="color"> really works — never on iOS).
//   * The hidden #color-picker input and the #pen-customization-sep
//     separator are GONE from the editor page.
//   * Engine (js/colormenu.js): toggleToolColorMenu on the preview canvas;
//     applyToolColor writes state.annoColor +
//     state.toolSettings[tool].color (per tool), persists via
//     saveSettings(), refreshes the chip/active swatch/hex field and the
//     pen-options preview dot; the menu STAYS OPEN so colors compare.
//   * normalizeHexColor accepts #rgb / #rrggbb with or without '#'.
//   * Closing: pointerdown outside (anchor canvas toggles instead),
//     Escape, tool switch (ui.js setAnnoTool), size-menu open
//     (sizemenu.js), toolbar drag / orientation flip / resize
//     (floattools.js guarded closeToolColorMenu calls).
//   * Placement: beside the anchor in the vertical rail (right, then left
//     near the right edge), below it in the horizontal ribbon (then above
//     near the bottom), always viewport-clamped, measured via
//     offsetWidth/offsetHeight (transform-independent).
//   * No tool separators: index.html carries NO w-px / #pen-customization-sep
//     inside the #float-toolbar aside and style.css carries NO
//     '#float-toolbar.ft-vertical .w-px' hairline rule.
//   * Version bumped ftsize-v21 -> ipadcolor-v22 everywhere + colormenu.js
//     added to the script list (after sizemenu.js).
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
const COLORMENU_JS = path.join(ROOT, 'static', 'js', 'colormenu.js');
const SIZEMENU_JS = path.join(ROOT, 'static', 'js', 'sizemenu.js');
const FLOATTOOLS_JS = path.join(ROOT, 'static', 'js', 'floattools.js');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const CONFIG_JS = path.join(ROOT, 'static', 'js', 'config.js');
const UTILS_JS = path.join(ROOT, 'static', 'js', 'utils.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;
// JSON-based deep equality: cross-realm safe (vm objects).
assert.deepStrictEqual = (a, b, msg) => {
    const sa = JSON.stringify(a), sbb = JSON.stringify(b);
    if (sa !== sbb) throw new Error(msg || `expected ${sbb}, got ${sa}`);
};

const html = fs.readFileSync(INDEX_HTML, 'utf8');
const css = fs.readFileSync(STYLE_CSS, 'utf8');
const cmSrc = fs.readFileSync(COLORMENU_JS, 'utf8');
const smSrc = fs.readFileSync(SIZEMENU_JS, 'utf8');
const ftSrc = fs.readFileSync(FLOATTOOLS_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const configSrc = fs.readFileSync(CONFIG_JS, 'utf8');
const utilsSrc = fs.readFileSync(UTILS_JS, 'utf8');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');

// Version chain — ipadcolor-v22 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18',
    'floattools-v19', 'ftorient-v20', 'ftsize-v21'];
const CURRENT_VERSION = 'ipadcolor-v22';

// ---------------------------------------------------------------------------
// Helpers (same harness conventions as the sibling suites)
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    // Walk the PARAMETER LIST first; string + comment aware.
    let i = start + marker.length - 1;
    let depth = 0, inStr = null, inParams = true;
    for (; i < source.length; i++) {
        const c = source[i];
        const next = source[i + 1];
        if (inStr === '__line__') { if (c === '\n') inStr = null; continue; }
        if (inStr === '__block__') {
            if (c === '*' && next === '/') { i++; inStr = null; }
            continue;
        }
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === inStr) inStr = null;
            continue;
        }
        if (c === '/' && next === '/') { inStr = '__line__'; continue; }
        if (c === '/' && next === '*') { inStr = '__block__'; continue; }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (inParams) {
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) inParams = false; }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

function cssBlock(cssText, selector) {
    const i = cssText.indexOf(selector + ' {') !== -1
        ? cssText.indexOf(selector + ' {') : cssText.indexOf(selector + '{');
    if (i === -1) return null;
    const open = cssText.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < cssText.length; j++) {
        if (cssText[j] === '{') depth++;
        else if (cssText[j] === '}') { depth--; if (depth === 0) return cssText.slice(open + 1, j); }
    }
    return null;
}

function makeClassSync(initial = []) {
    const set = new Set(initial);
    return {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c, f) => {
            let now;
            if (f === undefined) {
                if (set.has(c)) { set.delete(c); now = false; } else { set.add(c); now = true; }
            } else if (f) { set.add(c); now = true; } else { set.delete(c); now = false; }
            return now;
        },
        contains: (c) => set.has(c),
        __set: set,
    };
}

function collectByClass(node, cls) {
    const out = [];
    (node.children || []).forEach(function walk(c) {
        if (c.classList && c.classList.contains(cls)) out.push(c);
        (c.children || []).forEach(walk);
    });
    return out;
}

// Mini-DOM node. opts.iosInput: an <input> whose .type degrades to 'text'
// even after type='color' is set (the iOS Safari behavior this suite
// regresses against).
function makeNode(tag, rect, opts = {}) {
    const listeners = {};
    const children = [];
    const attrs = {};
    const node = {
        tagName: tag,
        children,
        attrs,
        __id: null,
        style: {},
        classList: makeClassSync(),
    };
    Object.defineProperty(node, 'className', {
        get: () => Array.from(node.classList.__set).join(' '),
        set: (v) => {
            node.classList.__set.clear();
            String(v).split(/\s+/).filter(Boolean).forEach(c => node.classList.__set.add(c));
        },
    });
    Object.defineProperty(node, 'innerHTML', {
        get: () => '',
        set: () => { children.length = 0; },
    });
    if (tag === 'input') {
        Object.defineProperty(node, 'type', {
            get: () => {
                const t = attrs.type || 'text';
                return (opts.iosInput && t === 'color') ? 'text' : t;
            },
            set: (v) => { attrs.type = String(v); },
        });
    }
    // .id maps into attrs so getElementById-style lookups + child scans see it.
    Object.defineProperty(node, 'id', {
        get: () => (attrs.id !== undefined ? attrs.id : (node.__id || null)),
        set: (v) => { attrs.id = String(v); },
    });
    node.appendChild = (c) => { children.push(c); c.__parent = node; return c; };
    node.insertBefore = (c, ref) => {
        const k = children.indexOf(ref);
        if (k < 0) children.push(c); else children.splice(k, 0, c);
        c.__parent = node;
        return c;
    };
    node.remove = () => {
        if (node.__parent) {
            const arr = node.__parent.children;
            const k = arr.indexOf(node);
            if (k >= 0) arr.splice(k, 1);
        }
    };
    node.setAttribute = (k, v) => { attrs[k] = String(v); };
    node.getAttribute = (k) => (k in attrs ? attrs[k] : null);
    node.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
    node.removeEventListener = (t, f) => {
        if (listeners[t]) listeners[t] = listeners[t].filter(f2 => f2 !== f);
    };
    node.__dispatch = (t, ev) => (listeners[t] || []).forEach(f => f(ev));
    node.querySelectorAll = (sel) => {
        const cls = sel.replace(/^\./, '');
        if (sel.includes('#')) return [];
        return collectByClass(node, cls);
    };
    node.contains = (c) => {
        let cur = c;
        while (cur) { if (cur === node) return true; cur = cur.__parent; }
        return false;
    };
    node.closest = (sel) => {
        if (!sel || sel[0] !== '#') return null;
        const want = sel.slice(1);
        let cur = node;
        while (cur) {
            if ((cur.__id && cur.__id === want) ||
                (cur.attrs && cur.attrs.id === want)) return cur;
            cur = cur.__parent;
        }
        return null;
    };
    // Layout size mirrors the stub rect (positionToolColorMenu measures the
    // menu via offsetWidth/offsetHeight — transform-independent in real DOM).
    Object.defineProperty(node, 'offsetWidth', { get: () => (rect && rect.width) || 100 });
    Object.defineProperty(node, 'offsetHeight', { get: () => (rect && rect.height) || 100 });
    node.getBoundingClientRect = () => {
        const r = rect || { width: 100, height: 100 };
        const left = r.left || 0, top = r.top || 0;
        const w = r.width || 0, h = r.height || 0;
        return { left, top, right: left + w, bottom: top + h, width: w, height: h };
    };
    return node;
}

// Sandbox for js/colormenu.js. opts.rects overrides element rects;
// opts.iosInput=true emulates the iOS type degradation of input elements.
function makeColorMenuSandbox(opts = {}) {
    const rects = Object.assign({}, opts.rects || {});
    if (!rects['tool-color-menu']) rects['tool-color-menu'] = { width: 220, height: 300 };
    if (!rects['thickness-preview-canvas']) rects['thickness-preview-canvas'] = { left: 100, top: 300, width: 32, height: 32 };
    const ids = ['tool-color-menu', 'tcm-title', 'tcm-value', 'tcm-chip-swatch',
     'tcm-value-text', 'tcm-options', 'tcm-custom-row', 'tcm-hex',
     'thickness-preview-canvas', 'float-toolbar', 'tool-pen', 'tool-highlighter'];
    const nodes = {};
    ids.forEach(id => {
        nodes[id] = makeNode(id === 'thickness-preview-canvas' ? 'canvas' : 'div', rects[id]);
        nodes[id].__id = id;
        nodes[id].attrs.id = id;
    });
    nodes['tcm-value'].appendChild(nodes['tcm-chip-swatch']);
    nodes['tcm-value'].appendChild(nodes['tcm-value-text']);
    nodes['tool-color-menu'].appendChild(nodes['tcm-title']);
    nodes['tool-color-menu'].appendChild(nodes['tcm-value']);
    nodes['tool-color-menu'].appendChild(nodes['tcm-options']);
    nodes['tool-color-menu'].appendChild(nodes['tcm-custom-row']);
    nodes['tcm-custom-row'].appendChild(nodes['tcm-hex']);
    nodes['float-toolbar'].appendChild(nodes['tool-pen']);
    nodes['float-toolbar'].appendChild(nodes['tool-highlighter']);

    const docListeners = [];
    const sb = {
        document: {
            getElementById: (id) => nodes[id] || null,
            createElement: (tag) => makeNode(tag, null, { iosInput: !!opts.iosInput }),
            addEventListener: (t, f, cap) => { docListeners.push({ t, f, cap }); },
            removeEventListener: (t, f, cap) => {
                const k = docListeners.findIndex(L => L.t === t && L.f === f && L.cap === cap);
                if (k >= 0) docListeners.splice(k, 1);
            },
            activeElement: null,
            documentElement: { clientWidth: opts.vw, clientHeight: opts.vh },
        },
        window: { innerWidth: opts.vw ?? 1024, innerHeight: opts.vh ?? 768 },
        state: Object.assign({
            appMode: 'annotation',
            annoTool: 'pen',
            annoColor: '#ef4444',
            annoThickness: 5,
            toolSettings: {
                pen: { color: '#ef4444', thickness: 5 },
                highlighter: { color: '#facc15', thickness: 20 },
            },
        }, opts.state || {}),
        saveSettings: () => { sb.__saves = (sb.__saves || 0) + 1; },
        updateThicknessPreview: () => { sb.__previewCalls = (sb.__previewCalls || 0) + 1; },
        closeToolSizeMenu: () => { sb.__sizeMenuCloses = (sb.__sizeMenuCloses || 0) + 1; },
        console,
    };
    vm.createContext(sb);
    // Load the REAL toolSettingsKeyFor helper from utils.js (per-tool color
    // buckets depend on it for hyphenated ids).
    vm.runInContext(extractFunction(utilsSrc, 'toolSettingsKeyFor'), sb, { filename: 'utils.js#toolSettingsKeyFor' });
    // Module prelude: let/const bindings + top-level constants.
    const prelude = cmSrc.slice(cmSrc.indexOf('let tcmOpen'), cmSrc.indexOf('function normalizeHexColor'));
    vm.runInContext(prelude, sb, { filename: 'colormenu.js#prelude' });
    const fns = ['normalizeHexColor', 'toolColorMenuEl', 'isToolColorMenuOpen',
     'deviceSupportsNativeColorInput', 'toggleToolColorMenu', 'openToolColorMenu',
     'closeToolColorMenu', 'renderToolColorMenu', 'applyToolColor', 'tcmUpdateValueChip',
     'tcmMarkActiveSwatch', 'tcmSyncHexInput', 'positionToolColorMenu',
     'tcmOnDocPointerDown', 'bindTcmOutsideClose', 'unbindTcmOutsideClose',
     'initToolColorMenu'];
    fns.forEach(fn => vm.runInContext(extractFunction(cmSrc, fn), sb, { filename: `colormenu.js#${fn}` }));
    sb.__nodes = nodes;
    sb.__docListeners = docListeners;
    sb.__eval = (code) => vm.runInContext(code, sb);
    return sb;
}

function dispatchPointerdown(sb, target) {
    const L = sb.__docListeners.filter(l => l.t === 'pointerdown');
    assert(L.length >= 1, 'no document pointerdown listener bound');
    L.forEach(l => l.f({ target }));
}

function swatches(sb) {
    return sb.__nodes['tcm-options'].querySelectorAll('.tcm-swatch');
}

// ===============================================================
console.log(`\nSuite 1 — cache versioning (${CURRENT_VERSION})`);
// ===============================================================

test(`1.1 CSS link carries ${CURRENT_VERSION}`, () => {
    const m = html.match(/<link rel="stylesheet" href="\/css\/style\.css\?v=([^"]+)">/);
    assert(m, 'CSS link not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
});

test(`1.2 every editor script tag carries ${CURRENT_VERSION}, incl. the NEW colormenu.js`, () => {
    const tags = html.match(/<script src="\/js\/[^"]+"><\/script>/g) || [];
    assert(tags.length >= 21, `expected >= 21 script tags, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
    assert(tags.some(t => t.includes('/js/colormenu.js?')), 'colormenu.js must be tagged');
    assert(tags.some(t => t.includes('/js/sizemenu.js?')), 'sizemenu.js must still be tagged');
});

test(`1.3 header chip shows ${CURRENT_VERSION}`, () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'version chip missing');
});

test(`1.4 ${CURRENT_VERSION} is new + ftsize-v21 fully retired from shipped files`, () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    assert(SHIPPED_VERSIONS.includes('ftsize-v21'), 'ftsize-v21 must be recorded as shipped');
    // ftsize-v21 must not survive in ANY shipped file (index.html, css, js).
    const shipped = ['static/index.html', 'static/css/style.css',
     ...fs.readdirSync(path.join(ROOT, 'static', 'js')).map(f => 'static/js/' + f)]
     .map(p => fs.readFileSync(path.join(ROOT, p), 'utf8'));
    shipped.forEach((src, k) => assert(!src.includes('ftsize-v21'),
        `stale ftsize-v21 in shipped file #${k}`));
});

// ===============================================================
console.log('\nSuite 2 — markup: color menu shell + removals');
// ===============================================================

test('2.1 #tool-color-menu is a BODY-LEVEL element (outside #workspace-main)', () => {
    const menuIdx = html.indexOf('id="tool-color-menu"');
    assert(menuIdx !== -1, '#tool-color-menu missing');
    const wsIdx = html.indexOf('</main>');
    assert(menuIdx > wsIdx, 'menu must be a body-level sibling AFTER the workspace');
    const tsmIdx = html.indexOf('id="tool-size-menu"');
    assert(tsmIdx !== -1 && tsmIdx < menuIdx, 'size menu shell must exist (before color menu)');
});

test('2.2 menu shell ids: title, value chip (swatch + text), options, custom row, hex field', () => {
    ['tcm-title', 'tcm-value', 'tcm-chip-swatch', 'tcm-value-text',
     'tcm-options', 'tcm-custom-row', 'tcm-hex'].forEach(id => {
        assert(html.includes(`id="${id}"`), `missing #${id}`);
    });
    assert(html.includes('id="tcm-hex"') && html.includes('type="text" id="tcm-hex"'),
        'hex field must be a TEXT input (works on iOS too)');
    // The native chip is JS-rendered ONLY where supported — never static markup.
    assert(!html.includes('id="tcm-native"'), 'native chip must not be static markup');
});

test('2.3 the hidden native #color-picker input is GONE from the editor page', () => {
    assert(!html.includes('id="color-picker"'),
        'the iOS-unsupported hidden <input type="color"> must be gone');
});

test('2.4 preview canvas stays in #pen-customization with the tap-to-open title', () => {
    const i = html.indexOf('id="float-toolbar"');
    const block = html.slice(i, html.indexOf('</aside>', i));
    assert(block.includes('id="thickness-preview-canvas"'), 'preview canvas missing');
    assert(block.includes('title="Tap to change color"'), 'canvas title must invite a tap');
});

test('2.5 NO tool separators remain inside the floating toolbar', () => {
    const i = html.indexOf('id="float-toolbar"');
    const block = html.slice(i, html.indexOf('</aside>', i));
    assert(!block.includes('w-px'), 'no w-px separator may remain inside the toolbar');
    assert(!block.includes('pen-customization-sep'), '#pen-customization-sep must be gone');
});

test('2.6 script order: colormenu.js loads after sizemenu.js and before app.js', () => {
    const a = html.indexOf('/js/sizemenu.js?');
    const b = html.indexOf('/js/colormenu.js?');
    const c = html.indexOf('/js/app.js?');
    assert(a !== -1 && b !== -1 && c !== -1, 'script tags missing');
    assert(a < b && b < c, 'expected sizemenu -> colormenu -> app order');
});

// ===============================================================
console.log('\nSuite 3 — CSS contract');
// ===============================================================

test('3.1 #tool-color-menu is the liquid-glass fixed flyout, above the sidebar, absorbing taps', () => {
    const b = cssBlock(css, '#tool-color-menu');
    assert(b, 'main rule missing');
    assert(b.includes('position: fixed'), 'body-level fixed placement');
    assert(b.includes('z-index: 1210'), 'transient popover: above toolbar (1150) AND sidebar (1200); min-btn (1250) still wins');
    assert(b.includes('pointer-events: auto'), 'absorbs its own clicks');
    assert(b.includes('backdrop-filter: blur(20px) saturate(1.7)'), 'liquid glass frost');
    assert(b.includes('-webkit-backdrop-filter'), 'Safari needs the -webkit prefix');
    assert(b.includes('transform: scale(0.9)'), 'hidden state starts scaled for the pop');
    assert(b.includes('touch-action: manipulation'), 'tap-safe');
});

test('3.2 tcm-hidden / tcm-open states + @supports fallback', () => {
    const hid = cssBlock(css, '#tool-color-menu.tcm-hidden');
    assert(hid && hid.includes('display: none'), 'hidden state must display:none');
    const open = cssBlock(css, '#tool-color-menu.tcm-open');
    assert(open && open.includes('opacity: 1') && open.includes('transform: scale(1)'),
        'open state must pop to full scale');
    // Exact near-opaque fallback rules must exist AFTER each flyout's main
    // rule (color menu AND size menu — the sibling must keep its own).
    const mainIdx = css.indexOf('#tool-color-menu {');
    const colorFb = css.indexOf('#tool-color-menu { background: rgba(255, 255, 255, 0.97); }', mainIdx);
    assert(mainIdx !== -1 && colorFb > mainIdx, 'color menu needs its @supports fallback rule');
    const smMainIdx = css.indexOf('#tool-size-menu {');
    const smFb = css.indexOf('#tool-size-menu { background: rgba(255, 255, 255, 0.97); }', smMainIdx);
    assert(smMainIdx !== -1 && smFb > smMainIdx, 'size menu keeps its @supports fallback rule');
});

test('3.3 swatch grid: 5 columns, ring + check on the active swatch', () => {
    const grid = cssBlock(css, '#tcm-options');
    assert(grid && grid.includes('grid-template-columns: repeat(5, 1fr)'),
        'preset grid must be 5 columns');
    const sw = cssBlock(css, '.tcm-swatch');
    assert(sw && sw.includes('cursor: pointer'), 'swatches are tap targets');
    const active = cssBlock(css, '.tcm-swatch.tcm-active');
    assert(active && active.includes('box-shadow'), 'active swatch carries a ring');
    assert(css.includes('.tcm-swatch.tcm-active .tcm-check { visibility: visible; }'),
        'active swatch shows the check');
});

test('3.4 custom row + hex field styled; native chip styled as an extra swatch', () => {
    const row = cssBlock(css, '#tcm-custom-row');
    assert(row && row.includes('border-top'), 'custom row separated from the grid');
    const hex = cssBlock(css, '#tcm-hex');
    assert(hex && hex.includes('monospace'), 'hex field uses the mono font like the size chip');
    const nat = cssBlock(css, '.tcm-native');
    assert(nat && nat.includes('border-radius'), 'native chip styled as a swatch');
    assert(css.includes('::-webkit-color-swatch-wrapper'), 'native chip swatch padding reset');
});

test('3.5 touch media: roomier swatches + menu (in the iPad-matching query)', () => {
    // The touch block uses "(hover: none), (pointer: coarse)" — a bare
    // (pointer: coarse) query does NOT match iPad (learned the hard way).
    const touchIdx = css.indexOf('@media (hover: none), (pointer: coarse)');
    assert(touchIdx !== -1, 'touch media query missing');
    // The touch-only override values exist exactly once, AFTER the base rules.
    const touchColor = css.indexOf('#tool-color-menu { min-width: 224px; padding: 12px; border-radius: 18px; }');
    const touchSwatch = css.indexOf('.tcm-swatch { width: 34px; height: 34px; border-radius: 10px; }');
    assert(touchColor > touchIdx, 'touch block must grow the color menu');
    assert(touchSwatch > touchIdx, 'touch block must grow the swatches to 34px');
});

test('3.6 NO vertical separator hairline rule remains in the CSS', () => {
    assert(cssBlock(css, '#float-toolbar.ft-vertical .w-px') === null,
        'the .w-px hairline rule must be gone');
    assert(!/#float-toolbar[^{]*\.w-px/.test(css), 'no toolbar separator styling at all');
});

// ===============================================================
console.log('\nSuite 4 — engine (js/colormenu.js, VM)');
// ===============================================================

test('4.1 normalizeHexColor: #rgb/#rrggbb, with/without #, rejects garbage', () => {
    const sb = makeColorMenuSandbox();
    assert.strictEqual(sb.__eval(`normalizeHexColor('#EF4444')`), '#ef4444');
    assert.strictEqual(sb.__eval(`normalizeHexColor('ef4444')`), '#ef4444');
    assert.strictEqual(sb.__eval(`normalizeHexColor('#abc')`), '#aabbcc');
    assert.strictEqual(sb.__eval(`normalizeHexColor('FACC15')`), '#facc15');
    assert.strictEqual(sb.__eval(`normalizeHexColor('#ef444')`), null);
    assert.strictEqual(sb.__eval(`normalizeHexColor('#ef4444g')`), null);
    assert.strictEqual(sb.__eval(`normalizeHexColor('')`), null);
    assert.strictEqual(sb.__eval(`normalizeHexColor(null)`), null);
    assert.strictEqual(sb.__eval(`normalizeHexColor(undefined)`), null);
    assert.strictEqual(sb.__eval(`normalizeHexColor(123)`), null);
});

test('4.2 toggleToolColorMenu opens anchored to the preview canvas', () => {
    const sb = makeColorMenuSandbox();
    sb.__eval(`toggleToolColorMenu()`);
    const menu = sb.__nodes['tool-color-menu'];
    assert(!menu.classList.contains('tcm-hidden'), 'hidden class removed');
    assert(menu.classList.contains('tcm-open'), 'open class applied');
    assert.strictEqual(sb.__nodes['thickness-preview-canvas'].getAttribute('aria-expanded'), 'true',
        'anchor aria-expanded=true');
    assert(sb.__sizeMenuCloses === 1, 'opening the color menu closes the size menu');
    assert(sb.__docListeners.some(l => l.t === 'pointerdown' && l.cap === true),
        'outside-close bound in capture phase');
    // Second tap on the canvas toggles it closed again.
    sb.__eval(`toggleToolColorMenu()`);
    assert(menu.classList.contains('tcm-hidden') && !menu.classList.contains('tcm-open'),
        'second canvas tap closes the menu');
    assert(!sb.__docListeners.some(l => l.t === 'pointerdown' && l.cap === true),
        'outside-close unbound after close');
});

test('4.3 render: title per tool + current hex chip + 15 swatches with the active one checked', () => {
    const sb = makeColorMenuSandbox({ state: { annoTool: 'pen', annoColor: '#ef4444' } });
    sb.__eval(`openToolColorMenu()`);
    assert.strictEqual(sb.__nodes['tcm-title'].textContent, 'Pen Color', 'per-tool title');
    assert.strictEqual(sb.__nodes['tcm-value-text'].textContent, '#EF4444',
        'chip shows the exact current hex');
    assert.strictEqual(sb.__nodes['tcm-chip-swatch'].style.background, '#ef4444',
        'chip swatch shows the current color');
    const sws = swatches(sb);
    assert.strictEqual(sws.length, 15, '15 preset swatches');
    const active = sws.filter(s => s.classList.contains('tcm-active'));
    assert.strictEqual(active.length, 1, 'exactly one active swatch');
    assert.strictEqual(active[0].getAttribute('data-color'), '#ef4444',
        'the active swatch is the current color');
    assert(sws[2].getAttribute('data-color') === '#ef4444', 'pen default red is in the grid');
    assert(sws[5].getAttribute('data-color') === '#facc15', 'highlighter default yellow is in the grid');
    // Every swatch is a real BUTTON (guaranteed clickable on iPad).
    assert(sws.every(s => s.tagName === 'button'), 'swatches must be <button> elements');
    // The hex field must reflect the CURRENT color on render (never the
    // stale static markup value).
    assert.strictEqual(sb.__nodes['tcm-hex'].value, '#EF4444', 'hex field synced on render');
});

test('4.4 highlighter gets its own title and its own color', () => {
    const sb = makeColorMenuSandbox({ state: { annoTool: 'highlighter', annoColor: '#facc15' } });
    sb.__eval(`openToolColorMenu()`);
    assert.strictEqual(sb.__nodes['tcm-title'].textContent, 'Highlighter Color');
    assert.strictEqual(sb.__nodes['tcm-value-text'].textContent, '#FACC15');
    const active = swatches(sb).filter(s => s.classList.contains('tcm-active'));
    assert.strictEqual(active[0].getAttribute('data-color'), '#facc15');
});

test('4.5 applyToolColor: per-tool bucket write + persistence + readouts, menu stays open', () => {
    const sb = makeColorMenuSandbox({ state: { annoTool: 'pen', annoColor: '#ef4444' } });
    sb.__eval(`openToolColorMenu()`);
    const saves = sb.__saves || 0;
    const ok = sb.__eval(`applyToolColor('#22C55E')`);
    assert.strictEqual(ok, true, 'valid apply returns true');
    assert.strictEqual(sb.state.annoColor, '#22c55e', 'state.annoColor updated');
    assert.strictEqual(sb.state.toolSettings.pen.color, '#22c55e',
        'PEN bucket updated (per-tool color)');
    assert.strictEqual(sb.state.toolSettings.highlighter.color, '#facc15',
        'highlighter bucket untouched');
    assert.strictEqual(sb.__saves, saves + 1, 'saveSettings called');
    assert.strictEqual(sb.__previewCalls, 1, 'preview dot refreshed');
    assert.strictEqual(sb.__nodes['tcm-value-text'].textContent, '#22C55E', 'chip refreshed');
    const active = swatches(sb).filter(s => s.classList.contains('tcm-active'));
    assert.strictEqual(active.length, 1, 'exactly one active swatch');
    assert.strictEqual(active[0].getAttribute('data-color'), '#22c55e',
        'check moved to the new color');
    assert(sb.__nodes['tool-color-menu'].classList.contains('tcm-open'),
        'menu STAYS open so colors compare');
    assert(sb.__nodes['tcm-hex'].value === '#22C55E', 'hex field synced');
});

test('4.6 applyToolColor: invalid input rejected without touching state', () => {
    const sb = makeColorMenuSandbox();
    const saves = sb.__saves || 0;
    assert.strictEqual(sb.__eval(`applyToolColor('nothex')`), false);
    assert.strictEqual(sb.__eval(`applyToolColor('#12345')`), false);
    assert.strictEqual(sb.state.annoColor, '#ef4444', 'state untouched');
    assert.strictEqual(sb.__saves || 0, saves, 'no save on invalid input');
});

test('4.7 per-tool isolation across owner switches (pen vs highlighter)', () => {
    const sb = makeColorMenuSandbox({ state: { annoTool: 'pen', annoColor: '#ef4444' } });
    sb.__eval(`openToolColorMenu()`);
    sb.__eval(`applyToolColor('#3b82f6')`);           // pen -> blue
    sb.__eval(`closeToolColorMenu()`);
    sb.__eval(`state.annoTool = 'highlighter'; state.annoColor = '#facc15';`);
    sb.__eval(`openToolColorMenu()`);
    sb.__eval(`applyToolColor('#ec4899')`);           // highlighter -> pink
    assert.strictEqual(sb.state.toolSettings.pen.color, '#3b82f6', 'pen keeps its color');
    assert.strictEqual(sb.state.toolSettings.highlighter.color, '#ec4899',
        'highlighter got its own color');
    assert.strictEqual(sb.state.annoColor, '#ec4899', 'state.annoColor mirrors the ACTIVE tool');
    assert.strictEqual(sb.__nodes['tcm-hex'].value, '#EC4899',
        'reopen renders the OTHER tool\'s color in the hex field');
});

test('4.8 outside-close: tap on the PDF closes; taps on the menu / anchor do not', () => {
    const sb = makeColorMenuSandbox();
    sb.__eval(`openToolColorMenu()`);
    const outside = makeNode('div');
    outside.__id = 'right-anno-canvas';
    dispatchPointerdown(sb, outside);
    assert(sb.__nodes['tool-color-menu'].classList.contains('tcm-hidden'),
        'pointerdown outside closes');
    // Reopen: pointerdown INSIDE the menu must not close it.
    sb.__eval(`openToolColorMenu()`);
    dispatchPointerdown(sb, sb.__nodes['tcm-options']);
    assert(sb.__nodes['tool-color-menu'].classList.contains('tcm-open'),
        'pointerdown inside the menu never closes it');
    // Pointerdown on the anchor canvas is exempt (its click toggles instead).
    dispatchPointerdown(sb, sb.__nodes['thickness-preview-canvas']);
    assert(sb.__nodes['tool-color-menu'].classList.contains('tcm-open'),
        'pointerdown on the anchor canvas does not close');
});

test('4.9 Escape closes the menu (bound by initToolColorMenu)', () => {
    const sb = makeColorMenuSandbox();
    sb.__eval(`initToolColorMenu()`);
    sb.__eval(`openToolColorMenu()`);
    const kd = sb.__docListeners.filter(l => l.t === 'keydown');
    assert(kd.length >= 1, 'document keydown listener bound');
    kd.forEach(l => l.f({ key: 'Escape' }));
    assert(sb.__nodes['tool-color-menu'].classList.contains('tcm-hidden'), 'Escape closes');
});

test('4.10 hex field: valid typing live-applies; invalid change reverts', () => {
    const sb = makeColorMenuSandbox();
    sb.__eval(`initToolColorMenu()`);
    sb.__eval(`openToolColorMenu()`);
    const hex = sb.__nodes['tcm-hex'];
    hex.value = '#3b82f6';
    hex.__dispatch('input', { target: hex });
    assert.strictEqual(sb.state.annoColor, '#3b82f6', 'complete hex live-applies while typing');
    hex.value = '#3b8';                      // 3-digit hex IS valid (#33bb88)
    hex.__dispatch('input', { target: hex });
    assert.strictEqual(sb.state.annoColor, '#33bb88', 'shorthand 3-digit hex applies too');
    hex.value = '#3b';                       // genuinely incomplete — no state change
    hex.__dispatch('input', { target: hex });
    assert.strictEqual(sb.state.annoColor, '#33bb88', 'incomplete input does not fight the user');
    hex.value = 'zzz';
    hex.__dispatch('change', { target: hex });
    assert.strictEqual(hex.value, '#33BB88', 'invalid commit reverts the field');
});

test('4.11 hex field never clobbered while focused', () => {
    const sb = makeColorMenuSandbox();
    sb.__eval(`initToolColorMenu()`);
    sb.__eval(`openToolColorMenu()`);
    const hex = sb.__nodes['tcm-hex'];
    sb.document.activeElement = hex;
    sb.__eval(`applyToolColor('#22c55e')`);
    assert(sb.__nodes['tcm-value-text'].textContent === '#22C55E',
        'chip updated even while the field is focused');
    // focused field keeps the user's text (no clobber) — then blur syncs.
    hex.value = '#22';
    sb.__eval(`tcmSyncHexInput()`);
    assert.strictEqual(hex.value, '#22', 'focused field not clobbered');
    sb.document.activeElement = null;
    sb.__eval(`tcmSyncHexInput()`);
    assert.strictEqual(hex.value, '#22C55E', 'blurred field re-synced');
});

test('4.12 native chip: rendered ONLY where <input type="color"> really works', () => {
    // Desktop-style browser: probe keeps type='color' -> chip rendered + wired.
    const sb = makeColorMenuSandbox();
    sb.__eval(`openToolColorMenu()`);
    const row = sb.__nodes['tcm-custom-row'];
    const native = row.children.find(c => c.attrs && c.attrs.id === 'tcm-native');
    assert(native, 'native chip rendered on supporting browsers');
    assert(native.getAttribute('title') === 'Pick any color', 'native chip titled');
    native.__dispatch('input', { target: { value: '#22c55e' } });
    assert.strictEqual(sb.state.annoColor, '#22c55e', 'native picker input applies the color');

    // iOS-style browser: probe degrades to type='text' -> NO chip rendered.
    const sbiOS = makeColorMenuSandbox({ iosInput: true });
    sbiOS.__eval(`openToolColorMenu()`);
    const rowiOS = sbiOS.__nodes['tcm-custom-row'];
    assert(!rowiOS.children.some(c => c.attrs && c.attrs.id === 'tcm-native'),
        'native chip must NOT be rendered on iOS (it would do nothing there)');
    assert(!sbiOS.__eval(`deviceSupportsNativeColorInput()`), 'probe returns false on iOS');
});

test('4.13 placement: rail -> beside the anchor (right, then left flip near the right edge)', () => {
    // Vertical rail, plenty of room on the right.
    const sb = makeColorMenuSandbox({
        rects: { 'thickness-preview-canvas': { left: 40, top: 300, width: 30, height: 30 },
                 'tool-color-menu': { width: 220, height: 300 } },
        vw: 1024, vh: 768,
    });
    sb.__nodes['float-toolbar'].classList.add('ft-vertical');
    sb.__eval(`openToolColorMenu()`);
    const menu = sb.__nodes['tool-color-menu'];
    assert.strictEqual(menu.style.left, '78px', 'rail: right of the anchor (+8 gap)');
    assert.strictEqual(menu.style.top, '165px', 'rail: vertically centered on the anchor');
    assert.strictEqual(menu.style.transformOrigin, 'left center', 'grows out of the anchor');

    // Anchor near the right edge -> flips to the LEFT of the anchor.
    const sb2 = makeColorMenuSandbox({
        rects: { 'thickness-preview-canvas': { left: 986, top: 300, width: 30, height: 30 },
                 'tool-color-menu': { width: 220, height: 300 } },
        vw: 1024, vh: 768,
    });
    sb2.__nodes['float-toolbar'].classList.add('ft-vertical');
    sb2.__eval(`openToolColorMenu()`);
    assert.strictEqual(sb2.__nodes['tool-color-menu'].style.left, '758px',
        'flips left: anchor.left(986) - gap(8) - width(220)');
    assert.strictEqual(sb2.__nodes['tool-color-menu'].style.transformOrigin, 'right center');
});

test('4.14 placement: ribbon -> below the anchor, above near the bottom, viewport-clamped', () => {
    const sb = makeColorMenuSandbox({
        rects: { 'thickness-preview-canvas': { left: 100, top: 44, width: 32, height: 32 },
                 'tool-color-menu': { width: 220, height: 300 } },
        vw: 1024, vh: 768,
    });
    sb.__eval(`openToolColorMenu()`);
    const menu = sb.__nodes['tool-color-menu'];
    assert.strictEqual(menu.style.top, '84px', 'ribbon: below the anchor (+8 gap)');
    assert.strictEqual(menu.style.left, '8px', 'h-centered would be 6 -> clamped to margin 8');
    assert.strictEqual(menu.style.transformOrigin, 'center top');

    const sb2 = makeColorMenuSandbox({
        rects: { 'thickness-preview-canvas': { left: 100, top: 430, width: 32, height: 32 },
                 'tool-color-menu': { width: 220, height: 300 } },
        vw: 1024, vh: 768,
    });
    sb2.__eval(`openToolColorMenu()`);
    assert.strictEqual(sb2.__nodes['tool-color-menu'].style.top, '122px',
        'flips above: anchor.top(430) - gap(8) - height(300)');
    assert.strictEqual(sb2.__nodes['tool-color-menu'].style.transformOrigin, 'center bottom');
});

// ===============================================================
console.log('\nSuite 5 — wiring & separation');
// ===============================================================

test('5.1 ui.js: the preview canvas opens the color menu; no colorPicker left anywhere', () => {
    const upd = extractFunction(uiSrc, 'updateThicknessPreview');
    assert(upd.includes('toggleToolColorMenu'), 'canvas onclick must toggle #tool-color-menu');
    assert(upd.includes("typeof toggleToolColorMenu === 'function'"), 'guarded call');
    assert(!upd.includes("getElementById('color-picker')"), 'old native-input click must be gone');
    assert(!uiSrc.includes('els.colorPicker'), 'ui.js must not reference els.colorPicker');
    assert(!configSrc.includes('colorPicker:'), 'config.js els entry must be gone');
    assert(!appSrc.includes('els.colorPicker'), 'app.js must not reference els.colorPicker');
});

test('5.2 ui.js setAnnoTool closes the color menu on any tool switch', () => {
    const anno = extractFunction(uiSrc, 'setAnnoTool');
    assert(anno.includes("typeof closeToolColorMenu === 'function'"),
        'setAnnoTool must dismiss the color flyout');
    assert(!anno.includes('pen-customization-sep'),
        'setAnnoTool must no longer toggle the removed separator');
});

test('5.3 app.js boots initToolColorMenu (after initToolSizeMenu)', () => {
    const a = appSrc.indexOf('initToolSizeMenu()');
    const b = appSrc.indexOf('initToolColorMenu()');
    assert(a !== -1 && b !== -1 && b > a, 'boot order wrong');
});

test('5.4 sizemenu.js: opening the size flyout closes the color palette', () => {
    const open = extractFunction(smSrc, 'openToolSizeMenu');
    assert(open.includes("typeof closeToolColorMenu === 'function'"),
        'mutual exclusivity must work in both directions');
});

test('5.5 floattools.js closes BOTH flyouts on drag / orientation flip / resize (position-only intact)', () => {
    ['beginFloatToolbarDrag', 'setFloatToolbarOrientation', 'handleFloatToolbarResize'].forEach(fn => {
        const src = extractFunction(ftSrc, fn);
        assert(src.includes("typeof closeToolSizeMenu === 'function'"), `${fn}: size hook missing`);
        assert(src.includes("typeof closeToolColorMenu === 'function'"), `${fn}: color hook missing`);
    });
    assert(!ftSrc.includes('state.annoColor'), 'floattools must stay out of color business');
    assert(!ftSrc.includes('function setAnnoTool'), 'floattools must stay position-only');
});

test('5.6 events.js: pointerdown inside #tool-color-menu never starts a PDF stroke', () => {
    const i = eventsSrc.indexOf('function handlePointerDown');
    const guard = eventsSrc.slice(i, i + 2200);
    assert(guard.includes("e.target.closest('#tool-color-menu')"),
        'the color flyout needs the same guard as #tool-size-menu');
});

test('5.7 settings blob persists annoColor AND the per-tool buckets (survive reloads)', () => {
    const dbSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'database.js'), 'utf8');
    assert(dbSrc.includes('annoColor: state.annoColor'), 'settings save must carry annoColor');
    // ipadcolor-v22 fix: toolSettings was NEVER persisted — per-tool colors
    // AND sizes silently reset to defaults on every reload.
    assert(/toolSettings:\s*state\.toolSettings/.test(dbSrc),
        'settings save must carry the per-tool toolSettings buckets');
    const bootIdx = appSrc.indexOf('if (savedData.settings.annoTool) setAnnoTool');
    const mergeIdx = appSrc.indexOf('savedData.settings.toolSettings');
    assert(mergeIdx !== -1 && mergeIdx < bootIdx,
        'boot must merge toolSettings back BEFORE setAnnoTool reads them');
});

// ===============================================================
console.log(`\n==== test_tool_color_menu: ${passed} passed, ${failed} failed ====`);
if (failed > 0) process.exit(1);


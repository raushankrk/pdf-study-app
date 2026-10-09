// ============================================================================
// tests/test_tool_size_menu.js
// Regression suite: the pen/highlighter (and eraser) SIZE selection moved out
// of the inline toolbar slider into an Apple-Notes style floating flyout
// (#tool-size-menu). The user asked for a secondary menu because the inline
// slider "is looking weird when annotation tool is vertical", asked that it
// NOT show always ("show on second time click/tap": first tap selects, second
// tap on the same tool opens it, clicking anywhere else closes it), asked for
// a professional (Apple-Notes-like) design, and asked to "show the
// integer/float value of tool size".
//
// Feature contract:
//   * Markup: #tool-size-menu is a BODY-LEVEL element (outside
//     #workspace-main, so overflow can never clip it) with #tsm-title,
//     #tsm-value (current size chip) and #tsm-options. The inline
//     #thickness-picker slider is GONE from the toolbar.
//   * Two-tap dispatch: pen/highlighter/eraser buttons call
//     handleToolBtnTap(tool) (js/sizemenu.js). First tap -> setAnnoTool
//     (menu stays closed); second tap on the already-active tool IN
//     annotation mode -> toggle the flyout. Other tools keep calling
//     setAnnoTool directly.
//   * The flyout renders one row per preset size (1,3,5,8,12,20) — each row
//     a live stroke preview + NUMERIC value — and a header chip with the
//     CURRENT value; applyToolSize writes state.annoThickness +
//     state.toolSettings[tool].thickness, persists, updates chip/rows/badge.
//   * Closing: pointerdown anywhere outside the menu (except the owning tool
//     button, which toggles), Escape, tool switch (ui.js setAnnoTool calls
//     closeToolSizeMenu), orientation flip / drag / resize (floattools.js
//     guarded calls).
//   * Numeric badge (.tool-size-badge) on the active size tool button.
//   * floattools.js stays POSITION-ONLY (no annotation state access).
//   * Version bumped ftorient-v20 → ftsize-v21 everywhere + sizemenu.js added
//     to the script list.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
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
const smSrc = fs.readFileSync(SIZEMENU_JS, 'utf8');
const ftSrc = fs.readFileSync(FLOATTOOLS_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const configSrc = fs.readFileSync(CONFIG_JS, 'utf8');
const utilsSrc = fs.readFileSync(UTILS_JS, 'utf8');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');

// Version chain — ftsize-v21 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18',
    'floattools-v19', 'ftorient-v20'];
const CURRENT_VERSION = 'ftsize-v21';

// ---------------------------------------------------------------------------
// Helpers (same harness conventions as the sibling suites)
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    // Walk the PARAMETER LIST first; string + comment aware (apostrophes in
    // comments must not desync brace counting).
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

// Mini-DOM node: classList (source of truth, className synced), children,
// attributes, listeners, optional rect + 2d context recorder.
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

function makeNode(tag, rect) {
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
    // innerHTML='' must clear children (renderToolSizeMenu re-renders rows).
    Object.defineProperty(node, 'innerHTML', {
        get: () => '',
        set: () => { children.length = 0; },
    });
    node.appendChild = (c) => { children.push(c); c.__parent = node; return c; };
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
    // Layout size mirrors the stub rect (positionToolSizeMenu measures the
    // menu via offsetWidth/offsetHeight — transform-independent in real DOM).
    Object.defineProperty(node, 'offsetWidth', { get: () => (rect && rect.width) || 100 });
    Object.defineProperty(node, 'offsetHeight', { get: () => (rect && rect.height) || 100 });
    node.getBoundingClientRect = () => {
        const r = rect || { width: 100, height: 100 };
        const left = r.left || 0, top = r.top || 0;
        const w = r.width || 0, h = r.height || 0;
        return { left, top, right: left + w, bottom: top + h, width: w, height: h };
    };
    if (tag === 'canvas') {
        const ctx = { ops: [], strokeCalls: [] };
        ['scale', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'fill', 'arc', 'fillRect']
            .forEach(op => { ctx[op] = (...a) => ctx.ops.push([op, ...a]); });
        // stroke() snapshots the CURRENT style so tests can assert what was
        // actually drawn (the engine resets globalAlpha after stroking).
        ctx.stroke = () => {
            ctx.strokeCalls.push({
                strokeStyle: ctx.strokeStyle,
                globalAlpha: ctx.globalAlpha,
                lineWidth: ctx.lineWidth,
                lineCap: ctx.lineCap,
            });
            ctx.ops.push(['stroke']);
        };
        node.getContext = () => ctx;
        node.__ctx = ctx;
    }
    return node;
}

// Sandbox for js/sizemenu.js
function makeSizeMenuSandbox(opts = {}) {
    // Resolve rects BEFORE creating nodes (makeNode captures the rect object).
    const rects = Object.assign({}, opts.rects || {});
    if (!rects['tool-size-menu']) rects['tool-size-menu'] = { width: 176, height: 256 };
    if (!rects['tool-pen']) rects['tool-pen'] = { left: 100, top: 300, width: 30, height: 30 };
    if (!rects['tool-highlighter']) rects['tool-highlighter'] = { left: 100, top: 340, width: 30, height: 30 };
    const ids = ['tool-size-menu', 'tsm-title', 'tsm-value', 'tsm-options', 'float-toolbar',
     'tool-pen', 'tool-highlighter', 'tool-eraser-pixel', 'tool-eraser-stroke',
     'tool-select', 'tool-text', 'tool-image',
     'pen-customization', 'pen-customization-sep', 'tool-line-mode'];
    const nodes = {};
    ids.forEach(id => {
        nodes[id] = makeNode('div', rects[id]);
        nodes[id].__id = id;
        nodes[id].attrs.id = id;
    });
    // Real DOM nesting used by the engine: header (title+value) + options live
    // inside the flyout; the tool buttons live inside the toolbar (badge
    // lookups scan the toolbar's descendants).
    nodes['tool-size-menu'].appendChild(nodes['tsm-title']);
    nodes['tool-size-menu'].appendChild(nodes['tsm-value']);
    nodes['tool-size-menu'].appendChild(nodes['tsm-options']);
    ids.filter(id => id.startsWith('tool-') && id !== 'tool-size-menu').forEach(id => {
        nodes['float-toolbar'].appendChild(nodes[id]);
    });
    const docListeners = [];
    const sb = {
        document: {
            getElementById: (id) => nodes[id] || null,
            createElement: (tag) => makeNode(tag),
            addEventListener: (t, f, cap) => { docListeners.push({ t, f, cap }); },
            removeEventListener: (t, f, cap) => {
                const k = docListeners.findIndex(L => L.t === t && L.f === f && L.cap === cap);
                if (k >= 0) docListeners.splice(k, 1);
            },
            documentElement: { clientWidth: opts.vw, clientHeight: opts.vh },
        },
        window: { innerWidth: opts.vw ?? 1024, innerHeight: opts.vh ?? 768 },
        state: Object.assign({
            appMode: 'annotation',
            annoTool: 'select',
            annoColor: '#ef4444',
            annoThickness: 5,
            toolSettings: {
                pen: { color: '#ef4444', thickness: 5 },
                highlighter: { color: '#facc15', thickness: 20 },
                eraserPixel: { thickness: 20 },
                eraserStroke: { thickness: 5 },
            },
        }, opts.state || {}),
        saveSettings: () => { sb.__saves = (sb.__saves || 0) + 1; },
        setAnnoTool: (t, save) => { sb.__annoToolCalls = sb.__annoToolCalls || []; sb.__annoToolCalls.push(t); },
        updateThicknessPreview: () => { sb.__previewCalls = (sb.__previewCalls || 0) + 1; },
        console,
    };
    // Extra DOM surface for the REAL setAnnoTool (loaded on demand by the
    // integration tests): body classes + the color picker element.
    sb.document.body = { classList: makeClassSync() };
    sb.els = { colorPicker: makeNode('input'), imageInput: makeNode('input') };
    vm.createContext(sb);
    // Load the REAL toolSettingsKeyFor helper from utils.js — in the browser
    // it is a prerequisite of sizemenu.js (script order) and the eraser
    // bucket normalization depends on it.
    vm.runInContext(extractFunction(utilsSrc, 'toolSettingsKeyFor'), sb, { filename: 'utils.js#toolSettingsKeyFor' });
    // Module prelude: let/const bindings + every top-level function.
    const prelude = smSrc.slice(smSrc.indexOf('let tsmOpen'), smSrc.indexOf('function ftSizeToolBtnId'));
    vm.runInContext(prelude, sb, { filename: 'sizemenu.js#prelude' });
    const fns = ['ftSizeToolBtnId', 'formatToolSize', 'toolSizeMenuEl', 'isToolSizeMenuOpen',
        'tsmToolColor', 'handleToolBtnTap', 'toggleToolSizeMenu', 'openToolSizeMenu',
        'closeToolSizeMenu', 'renderToolSizeMenu', 'applyToolSize', 'tsmUpdateValueChip',
        'tsmMarkActiveRow', 'tsmDrawStrokePreview', 'positionToolSizeMenu',
        'tsmOnDocPointerDown', 'bindTsmOutsideClose', 'unbindTsmOutsideClose',
        'updateToolSizeBadge', 'initToolSizeMenu'];
    fns.forEach(fn => vm.runInContext(extractFunction(smSrc, fn), sb, { filename: `sizemenu.js#${fn}` }));
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

// ===============================================================
console.log('\nSuite 1 — cache versioning (ftsize-v21)');
// ===============================================================

test('1.1 CSS link carries ftsize-v21', () => {
    const m = html.match(/<link rel="stylesheet" href="\/css\/style\.css\?v=([^"]+)">/);
    assert(m, 'CSS link not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
});

test('1.2 every editor script tag carries ftsize-v21, incl. the NEW sizemenu.js', () => {
    const tags = html.match(/<script src="\/js\/[^"]+"><\/script>/g) || [];
    assert(tags.length >= 20, `expected >= 20 script tags, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
    assert(tags.some(t => t.includes('/js/sizemenu.js?')), 'sizemenu.js must be tagged');
    assert(tags.some(t => t.includes('/js/floattools.js?')), 'floattools.js must still be tagged');
});

test('1.3 header chip shows ftsize-v21', () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'version chip missing');
});

test(`1.4 ${CURRENT_VERSION} is new + ftorient-v20 fully retired from shipped files`, () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    assert(SHIPPED_VERSIONS.includes('ftorient-v20'), 'ftorient-v20 must be recorded as shipped');
    [html, css, smSrc, ftSrc, uiSrc, appSrc, configSrc, eventsSrc].forEach((src, i) => {
        assert(!src.includes('ftorient-v20'), `stale version string in shipped file #${i}`);
    });
});

// ===============================================================
console.log('\nSuite 2 — markup contract (index.html)');
// ===============================================================

test('2.1 #tool-size-menu shell exists: hidden by default, header + value chip + options', () => {
    assert(html.includes('id="tool-size-menu"'), 'flyout shell missing');
    const i = html.indexOf('id="tool-size-menu"');
    const tagStart = html.lastIndexOf('<div', i);
    const tag = html.slice(tagStart, html.indexOf('>', i) + 1);
    assert(tag.includes('tsm-hidden'), 'flyout must start hidden');
    assert(tag.includes('role="menu"'), 'flyout needs role=menu');
    assert(tag.includes('aria-label'), 'flyout needs aria-label');
    const block = html.slice(i, html.indexOf('<!-- AI Settings Modal', i));
    ['tsm-title', 'tsm-value', 'tsm-options'].forEach(id =>
        assert(block.includes(`id="${id}"`), `${id} missing from the flyout`));
});

test('2.2 the flyout is BODY-LEVEL: outside #workspace-main (never clipped)', () => {
    const menuIdx = html.indexOf('id="tool-size-menu"');
    const wsEnd = html.indexOf('</main>');
    assert(wsEnd !== -1 && menuIdx > wsEnd,
        '#tool-size-menu must be placed after (outside) </main>');
});

test('2.3 the inline thickness slider is fully removed from the markup', () => {
    assert(!html.includes('id="thickness-picker"'), 'slider input must be gone');
    assert(!html.includes('thickness-val'), 'old thickness-val readout must be gone');
});

test('2.4 pen/highlighter/erasers dispatch through handleToolBtnTap with "tap again" titles', () => {
    [['tool-pen', "handleToolBtnTap('pen')"],
     ['tool-highlighter', "handleToolBtnTap('highlighter')"],
     ['tool-eraser-pixel', "handleToolBtnTap('eraser-pixel')"],
     ['tool-eraser-stroke', "handleToolBtnTap('eraser-stroke')"]].forEach(([id, fn]) => {
        const idx = html.indexOf(`id="${id}"`);
        assert(idx !== -1, `${id} missing`);
        const tag = html.slice(html.lastIndexOf('<button', idx), html.indexOf('</button>', idx));
        assert(tag.includes(`onclick="${fn}"`), `${id} must call ${fn}`);
        assert(/tap again for size/i.test(tag), `${id} title must advertise the size flyout`);
    });
});

test('2.5 non-size tools keep calling setAnnoTool directly', () => {
    [['tool-select', "setAnnoTool('select')"],
     ['tool-text', "setAnnoTool('text')"],
     ['tool-image', "setAnnoTool('image')"]].forEach(([id, fn]) => {
        const idx = html.indexOf(`id="${id}"`);
        assert(idx !== -1, `${id} missing`);
        const tag = html.slice(html.lastIndexOf('<button', idx), html.indexOf('</button>', idx));
        assert(tag.includes(`onclick="${fn}"`), `${id} must keep ${fn}`);
    });
});

// ===============================================================
console.log('\nSuite 3 — CSS contract (style.css)');
// ===============================================================

test('3.1 #tool-size-menu: body-level fixed card, liquid glass, above toolbar / below sidebar', () => {
    const b = cssBlock(css, '#tool-size-menu');
    assert(b, 'flyout CSS block missing');
    assert(b.includes('position: fixed'), 'must be viewport-positioned');
    assert(b.includes('z-index: 1160'), 'must sit above the toolbar (1150) and below the sidebar (1200)');
    assert(b.includes('backdrop-filter'), 'liquid glass needs backdrop-filter');
    assert(b.includes('pointer-events: auto'), 'must absorb its own clicks');
    assert(b.includes('overscroll-behavior: contain'), 'no scroll chaining to the PDF');
    assert(b.includes('transition'), 'pop animation needs a transition');
});

test('3.2 visibility classes: .tsm-hidden hides, .tsm-open shows (scale pop)', () => {
    const h = cssBlock(css, '#tool-size-menu.tsm-hidden');
    assert(h && h.includes('display: none'), '.tsm-hidden must display:none');
    const o = cssBlock(css, '#tool-size-menu.tsm-open');
    assert(o && o.includes('opacity: 1') && o.includes('scale(1)'), '.tsm-open must pop in');
});

test('3.3 rows + value chip + active check styling present', () => {
    const row = cssBlock(css, '.tsm-row');
    assert(row && row.includes('display: flex'), 'row must be a flex line');
    const active = cssBlock(css, '.tsm-row.tsm-active');
    assert(active, 'active row styling missing');
    const chip = cssBlock(css, '#tsm-value');
    assert(chip && chip.includes('monospace'), 'value chip must read numeric');
    const check = cssBlock(css, '.tsm-row.tsm-active .tsm-check');
    assert(check && check.includes('visibility: visible'), 'active row must show the check');
});

test('3.4 numeric badge styling: absolute, on top of the button, never click-blocking', () => {
    const b = cssBlock(css, '.tool-size-badge');
    assert(b, 'badge CSS missing');
    assert(b.includes('position: absolute'), 'badge must overlay its button');
    assert(b.includes('pointer-events: none'), 'badge must never block button clicks');
});

test('3.5 no slider CSS remains anywhere', () => {
    assert(!css.includes('#thickness-picker'), 'slider selector must be gone from CSS');
});

// ===============================================================
console.log('\nSuite 4 — engine: two-tap dispatch (VM)');
// ===============================================================

test('4.1 first tap on an inactive tool selects it and NEVER opens the menu', () => {
    const sb = makeSizeMenuSandbox();
    sb.__eval("state.annoTool = 'select'");
    vm.runInContext("handleToolBtnTap('pen')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'menu must stay closed');
    assert.deepStrictEqual(sb.__annoToolCalls, ['pen'], 'must delegate to setAnnoTool');
});

test('4.2 second tap on the ACTIVE tool (annotation mode) opens the flyout', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("handleToolBtnTap('pen')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), true, 'menu must be open');
    assert.strictEqual(sb.__eval('tsmOwnerTool'), 'pen', 'pen owns the menu');
    const menu = sb.__nodes['tool-size-menu'];
    assert(!menu.classList.contains('tsm-hidden'), 'must be unhidden');
    assert(menu.classList.contains('tsm-open'), 'must carry the pop-in class');
    assert.strictEqual(sb.__nodes['tool-pen'].attrs['aria-expanded'], 'true',
        'owner button must expose aria-expanded');
    assert.deepStrictEqual(sb.__annoToolCalls || [], [], 'setAnnoTool must NOT run');
});

test('4.3 third tap on the same button toggles the flyout closed again', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("handleToolBtnTap('pen')", sb);
    vm.runInContext("handleToolBtnTap('pen')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'menu must be closed');
    assert.strictEqual(sb.__nodes['tool-pen'].attrs['aria-expanded'], 'false',
        'aria-expanded must flip back');
});

test('4.4 tapping a DIFFERENT tool closes the open flyout and selects that tool', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("handleToolBtnTap('pen')", sb);
    vm.runInContext("handleToolBtnTap('highlighter')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'menu must close');
    assert.deepStrictEqual(sb.__annoToolCalls, ['highlighter'], 'must switch tools');
});

test("4.5 tool button while NOT in annotation mode: selection, not the flyout", () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'navigation' } });
    vm.runInContext("handleToolBtnTap('pen')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'menu must stay closed');
    assert.deepStrictEqual(sb.__annoToolCalls, ['pen'], 'must resume via setAnnoTool');
});

test('4.6 non-size tools always dispatch to setAnnoTool even when already active', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'select', appMode: 'annotation' } });
    vm.runInContext("handleToolBtnTap('select')", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'no flyout for select');
    assert.deepStrictEqual(sb.__annoToolCalls, ['select'], 'must delegate');
});

// ===============================================================
console.log('\nSuite 5 — engine: flyout contents + size application (VM)');
// ===============================================================

test('5.1 render: title + 6 preset rows with numeric values, active row checked', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', annoThickness: 5, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    assert.strictEqual(sb.__nodes['tsm-title'].textContent, 'Pen Size', 'title');
    assert.strictEqual(sb.__nodes['tsm-value'].textContent, '5', 'value chip shows the current size');
    const rows = sb.__nodes['tsm-options'].children;
    assert.strictEqual(rows.length, 6, 'six preset rows');
    assert.deepStrictEqual(rows.map(r => r.getAttribute('data-size')), ['1', '3', '5', '8', '12', '20'],
        'preset values 1..20');
    assert.strictEqual(rows[2].getAttribute('aria-checked'), 'true', 'size 5 is checked');
    assert(rows[2].classList.contains('tsm-active'), 'size 5 row highlighted');
    assert.strictEqual(rows[2].children.find(c => c.tagName === 'span').textContent, '5',
        'numeric label on the row');
    assert(rows[2].children.some(c => c.tagName === 'canvas'), 'stroke preview canvas present');
});

test('5.2 applyToolSize: state + per-tool settings + persistence + all readouts', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', annoThickness: 5, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const before = sb.__saves || 0;
    vm.runInContext("applyToolSize(8)", sb);
    assert.strictEqual(sb.__eval('state.annoThickness'), 8, 'annoThickness updated');
    assert.strictEqual(sb.__eval('state.toolSettings.pen.thickness'), 8, 'per-tool settings updated');
    assert(sb.__saves > before, 'must persist via saveSettings');
    assert.strictEqual(sb.__nodes['tsm-value'].textContent, '8', 'value chip updated');
    const rows = sb.__nodes['tsm-options'].children;
    assert(rows[3].classList.contains('tsm-active') && !rows[2].classList.contains('tsm-active'),
        'active check moved to size 8');
    assert.strictEqual(sb.__previewCalls || 0, 1, 'pen-options preview dot refreshed');
    const badge = sb.__nodes['float-toolbar'].querySelectorAll('.tool-size-badge')[0];
    assert(badge && badge.textContent === '8', 'numeric badge updated on the button');
});

test('5.3 menu stays open after picking a size (sizes stay comparable)', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', annoThickness: 5, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    vm.runInContext("applyToolSize(12)", sb);
    assert.strictEqual(sb.__eval('tsmOpen'), true, 'menu must remain open');
});

test('5.4 numeric formatting: integers exact, floats exact, garbage -> empty', () => {
    const sb = makeSizeMenuSandbox();
    assert.strictEqual(vm.runInContext("formatToolSize(5)", sb), '5');
    assert.strictEqual(vm.runInContext("formatToolSize(3.5)", sb), '3.5');
    assert.strictEqual(vm.runInContext("formatToolSize(2.25)", sb), '2.25');
    assert.strictEqual(vm.runInContext("formatToolSize(8.0)", sb), '8');
    assert.strictEqual(vm.runInContext("formatToolSize('abc')", sb), '');
    assert.strictEqual(vm.runInContext("formatToolSize(undefined)", sb), '');
});

test('5.5 sizes are clamped to the 1..20 slider range', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', annoThickness: 5, appMode: 'annotation' } });
    vm.runInContext("applyToolSize(99)", sb);
    assert.strictEqual(sb.__eval('state.annoThickness'), 20, 'upper clamp');
    vm.runInContext("applyToolSize(0)", sb);
    assert.strictEqual(sb.__eval('state.annoThickness'), 1, 'lower clamp');
});

test('5.6 highlighter flyout: own title, own color, flat semi-transparent preview', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'highlighter', annoThickness: 20, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('highlighter')", sb);
    assert.strictEqual(sb.__nodes['tsm-title'].textContent, 'Highlighter Size');
    assert.strictEqual(sb.__nodes['tsm-value'].textContent, '20');
    const rows = sb.__nodes['tsm-options'].children;
    assert(rows.length > 0, 'no rows rendered');
    const canvas = rows[5].children.find(c => c.tagName === 'canvas');
    const stroke = canvas.__ctx.strokeCalls[0];
    assert(stroke, 'stroke must be drawn');
    assert.strictEqual(stroke.strokeStyle, '#facc15', 'highlighter color');
    assert.strictEqual(stroke.globalAlpha, 0.45, 'highlighter transparency');
    assert.strictEqual(stroke.lineWidth, 20, 'preview stroke width');
    assert.strictEqual(stroke.lineCap, 'butt', 'flat stroke look');
});

test('5.7 eraser flyout: neutral gray previews + badge lands on the eraser button', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'eraser-pixel', annoThickness: 20, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('eraser-pixel')", sb);
    assert.strictEqual(sb.__nodes['tsm-title'].textContent, 'Pixel Eraser Size');
    const canvas = sb.__nodes['tsm-options'].children[5].children.find(c => c.tagName === 'canvas');
    assert.strictEqual(canvas.__ctx.strokeCalls[0].strokeStyle, '#64748b', 'eraser preview is neutral gray');
    vm.runInContext("closeToolSizeMenu()", sb);
    vm.runInContext("updateToolSizeBadge()", sb);
    const badge = sb.__nodes['float-toolbar'].querySelectorAll('.tool-size-badge')[0];
    assert(badge && badge.textContent === '20', 'badge shows eraser size');
    assert(!sb.__nodes['tool-pen'].querySelectorAll('.tool-size-badge').length,
        'no badge on the pen button');
});

// ===============================================================
console.log('\nSuite 6 — engine: close paths (VM)');
// ===============================================================

test('6.1 pointerdown OUTSIDE the menu closes it', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    dispatchPointerdown(sb, makeNode('div')); // canvas-ish target: no #tool-size-menu ancestor
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'outside tap must dismiss');
});

test('6.2 pointerdown INSIDE the menu never closes it (sizes comparable)', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    dispatchPointerdown(sb, sb.__nodes['tsm-options']);
    assert.strictEqual(sb.__eval('tsmOpen'), true, 'inside taps must not dismiss');
});

test('6.3 pointerdown on the OWNER button is exempt (its click toggles instead)', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    dispatchPointerdown(sb, sb.__nodes['tool-pen']);
    assert.strictEqual(sb.__eval('tsmOpen'), true, 'owner pointerdown must not dismiss');
});

test('6.4 Escape closes the flyout (bound by initToolSizeMenu)', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("initToolSizeMenu()", sb);
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const key = sb.__docListeners.filter(l => l.t === 'keydown');
    assert(key.length >= 1, 'keydown listener must be bound');
    key.forEach(l => l.f({ key: 'Escape' }));
    assert.strictEqual(sb.__eval('tsmOpen'), false, 'Escape must dismiss');
    // And it is a no-op while closed.
    key.forEach(l => l.f({ key: 'Escape' }));
    assert.strictEqual(sb.__eval('tsmOpen'), false);
});

test('6.5 close resets: hidden class restored, outside listener unbound', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const bound = sb.__docListeners.filter(l => l.t === 'pointerdown').length;
    assert.strictEqual(bound, 1, 'exactly one outside-close listener while open');
    vm.runInContext("closeToolSizeMenu()", sb);
    const menu = sb.__nodes['tool-size-menu'];
    assert(menu.classList.contains('tsm-hidden'), 'hidden class restored');
    assert(!menu.classList.contains('tsm-open'), 'pop class removed');
    assert.strictEqual(sb.__docListeners.filter(l => l.t === 'pointerdown').length, 0,
        'outside-close listener unbound');
});

test('6.6 re-opening after a tool switch re-renders for the NEW tool', () => {
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'pen', annoThickness: 5, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    vm.runInContext("closeToolSizeMenu()", sb);
    sb.__eval("state.annoTool = 'highlighter'; state.annoThickness = 20");
    vm.runInContext("openToolSizeMenu('highlighter')", sb);
    assert.strictEqual(sb.__eval('tsmOwnerTool'), 'highlighter', 'new owner');
    assert.strictEqual(sb.__nodes['tsm-title'].textContent, 'Highlighter Size', 're-rendered title');
    assert.strictEqual(sb.__nodes['tsm-value'].textContent, '20', 're-rendered value');
});

// ===============================================================
console.log('\nSuite 7 — engine: placement (VM)');
// ===============================================================

test('7.1 vertical rail: flyout opens RIGHT of the button, vertically centered on it', () => {
    const sb = makeSizeMenuSandbox({
        state: { annoTool: 'pen', appMode: 'annotation' },
        rects: { 'tool-pen': { left: 100, top: 300, width: 30, height: 30 } },
    });
    sb.__nodes['float-toolbar'].classList.add('ft-vertical');
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const menu = sb.__nodes['tool-size-menu'];
    assert.strictEqual(menu.style.left, '138px', 'right of button + 8px gap (100+30+8)');
    assert.strictEqual(menu.style.top, '187px', 'centered on the button (300+15-128)');
    assert.strictEqual(menu.style.transformOrigin, 'left center', 'pop grows out of the anchor');
});

test('7.2 vertical rail near the RIGHT viewport edge: flips to the LEFT of the button', () => {
    const sb = makeSizeMenuSandbox({
        state: { annoTool: 'pen', appMode: 'annotation' },
        vw: 800, vh: 600,
        rects: { 'tool-pen': { left: 762, top: 200, width: 30, height: 30 } },
    });
    sb.__nodes['float-toolbar'].classList.add('ft-vertical');
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const menu = sb.__nodes['tool-size-menu'];
    // right side: 762+30+8 = 800; +176 width > 800-8 -> flip: 762-8-176 = 578
    assert.strictEqual(menu.style.left, '578px', 'flipped to the left side');
    assert.strictEqual(menu.style.transformOrigin, 'right center');
});

test('7.3 horizontal ribbon: flyout opens BELOW the button, centered on it', () => {
    const sb = makeSizeMenuSandbox({
        state: { annoTool: 'pen', appMode: 'annotation' },
        rects: { 'tool-pen': { left: 300, top: 50, width: 30, height: 30 } },
    });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const menu = sb.__nodes['tool-size-menu'];
    assert.strictEqual(menu.style.top, '88px', 'below button + 8px gap (50+30+8)');
    assert.strictEqual(menu.style.left, '227px', 'centered on the button (300+15-88)');
    assert.strictEqual(menu.style.transformOrigin, 'center top', 'pop grows out of the anchor');
});

test('7.4 horizontal ribbon near the BOTTOM: flips ABOVE the button', () => {
    const sb = makeSizeMenuSandbox({
        state: { annoTool: 'pen', appMode: 'annotation' },
        vw: 800, vh: 400,
        rects: { 'tool-pen': { left: 300, top: 320, width: 30, height: 30 } },
    });
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const menu = sb.__nodes['tool-size-menu'];
    // below: 350+8+256 = 614 > 400-8 -> above: 320-8-256 = 56
    assert.strictEqual(menu.style.top, '56px', 'flipped above');
    assert.strictEqual(menu.style.transformOrigin, 'center bottom');
});

test('7.5 flyout is always clamped inside the viewport', () => {
    const sb = makeSizeMenuSandbox({
        state: { annoTool: 'pen', appMode: 'annotation' },
        vw: 800, vh: 300,
        rects: { 'tool-pen': { left: 20, top: 260, width: 30, height: 30 } },
    });
    sb.__nodes['float-toolbar'].classList.add('ft-vertical');
    vm.runInContext("openToolSizeMenu('pen')", sb);
    const menu = sb.__nodes['tool-size-menu'];
    const y = parseInt(menu.style.top, 10);
    const x = parseInt(menu.style.left, 10);
    assert(y + 256 <= 300 - 8, `y must be clamped to the viewport (got ${y})`);
    assert(x >= 8, 'x must respect the viewport margin');
});

// ===============================================================
console.log('\nSuite 8 — integration & separation of concerns');
// ===============================================================

test('8.1 ui.js setAnnoTool closes the flyout + refreshes the badge (typeof-guarded)', () => {
    const anno = extractFunction(uiSrc, 'setAnnoTool');
    assert(anno.includes("typeof closeToolSizeMenu === 'function'") && anno.includes('closeToolSizeMenu()'),
        'setAnnoTool must close the flyout');
    assert(anno.includes("typeof updateToolSizeBadge === 'function'") && anno.includes('updateToolSizeBadge()'),
        'setAnnoTool must refresh the numeric badge');
    assert(!anno.includes('els.thicknessPicker'), 'no inline slider writes anymore');
});

test('8.2 floattools.js stays POSITION-ONLY (no size-menu business logic inside)', () => {
    assert(!ftSrc.includes('handleToolBtnTap'), 'dispatch must live in sizemenu.js');
    assert(!ftSrc.includes('state.annoTool'), 'must never touch annotation state');
    assert(!ftSrc.includes('tsmOpen'), 'flyout module state must live in sizemenu.js');
    // ...but its close hooks are typeof-guarded calls (drag/orientation/resize).
    const guarded = (ftSrc.match(/typeof closeToolSizeMenu === 'function'/g) || []).length;
    assert.strictEqual(guarded, 3, 'drag + orientation-flip + resize hooks must be guarded');
});

test('8.3 app.js boots the flyout and no longer binds the old slider', () => {
    assert(appSrc.includes('initToolSizeMenu();'), 'boot must call initToolSizeMenu');
    assert(!appSrc.includes('thicknessPicker'), 'slider binding must be gone');
});

test('8.4 config.js no longer resolves the slider; events.js guards the flyout', () => {
    assert(!configSrc.includes('thicknessPicker'), 'config entry must be gone');
    const guard = eventsSrc.indexOf("e.target.closest('#tool-size-menu')");
    assert(guard !== -1, 'handlePointerDown must ignore flyout events');
    const ftGuard = eventsSrc.indexOf("e.target.closest('#float-toolbar')");
    assert(ftGuard !== -1 && ftGuard < guard, 'flyout guard sits with the toolbar guard');
});

test('8.5 sizemenu.js writes ONLY size state — never the active tool', () => {
    assert(smSrc.includes('state.annoThickness = clamped'), 'applies the size');
    // "===" comparisons must not count as assignments (negative lookahead).
    assert(!/\bstate\.annoTool\s*=(?![=>])/.test(smSrc), 'must never assign state.annoTool');
    assert(smSrc.includes('setAnnoTool(tool)'), 'delegates tool switching to ui.js');
});

test('8.6 eraser sizes stay adjustable (no regression from removing the slider)', () => {
    assert(smSrc.includes("'eraser-pixel'") && smSrc.includes("'eraser-stroke'"),
        'both erasers must be in the size-tool set');
});

test('8.7 eraser sizes land in the camelCase settings buckets (eraserPixel)', () => {
    // Regression: setAnnoTool used to look up 'eraser-pixel' while the bucket
    // is 'eraserPixel', so erasers silently inherited the previous tool size.
    const sb = makeSizeMenuSandbox({ state: { annoTool: 'eraser-pixel', annoThickness: 20, appMode: 'annotation' } });
    vm.runInContext("openToolSizeMenu('eraser-pixel')", sb);
    vm.runInContext("applyToolSize(9)", sb);
    assert.strictEqual(sb.__eval('state.toolSettings.eraserPixel.thickness'), 9,
        'size must be written to eraserPixel.thickness');
    assert.strictEqual(sb.__eval('state.toolSettings["eraser-pixel"]'), undefined,
        'no hyphenated key may be created');
    // ...and the REAL setAnnoTool (ui.js) restores the persisted size when
    // the eraser is re-selected (it must read the camelCase bucket).
    vm.runInContext(extractFunction(uiSrc, 'setAnnoTool'), sb, { filename: 'ui.js#setAnnoTool' });
    vm.runInContext("setAnnoTool('pen', false)", sb);   // switch away
    vm.runInContext("setAnnoTool('eraser-pixel', false)", sb);
    assert.strictEqual(sb.__eval('state.annoThickness'), 9,
        'setAnnoTool must read the camelCase bucket');
    const badge = sb.__nodes['float-toolbar'].querySelectorAll('.tool-size-badge')[0];
    assert(badge && badge.textContent === '9', 'badge reflects the restored eraser size');
});

// ===============================================================
console.log(`\n========================================`);
console.log(`tool size menu: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
process.exit(failed ? 1 : 0);

// ============================================================================
// tests/test_float_toolbar.js
// Regression suite: the annotation + link tools (former header Groups 1-3:
// App Modes, Annotation Draw Tools, Pen/Highlighter options) moved out of the
// header into a DRAGGABLE LIQUID GLASS floating toolbar (#float-toolbar).
//
// Feature contract:
//   * #float-toolbar is an absolutely-positioned child of #workspace-main —
//     the PDF canvas NEVER resizes or moves.
//   * All moved button IDs are IDENTICAL to the old header ones, so
//     setAppMode()/setAnnoTool()/keyboard shortcuts keep working unchanged.
//   * LIQUID GLASS surface (blur + saturate + tint + hairline border) and
//     pointer-events: auto — clicks/taps/wheel ON the bar are ABSORBED,
//     nothing passes through to the PDF underneath.
//   * Grip-only smooth dragging (translate3d + rAF coalescing, pointer-id
//     filtering, ≥3px persist threshold, double-tap re-dock, ResizeObserver
//     on workspace AND the bar itself), position persisted in settings.
//   * Guards: events.js handlePointerDown + app.js touchstart/touchmove bail
//     out inside #float-toolbar.
//   * Version bumped liquidglass-v18 → floattools-v19 everywhere; new script
//     js/floattools.js loads before app.js.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const DB_JS = path.join(ROOT, 'static', 'js', 'database.js');
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const FLOATTOOLS_JS = path.join(ROOT, 'static', 'js', 'floattools.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;
const assertDeep = require('assert').deepStrictEqual;
// JSON-based deep equality: node's deepStrictEqual fails on objects created
// inside a vm context (different Object prototype realm) even when the
// payloads are identical — every object we compare here is a plain JSON
// value, so a canonical string compare is exact AND cross-realm safe.
assert.deepStrictEqual = (a, b, msg) => {
    const sa = JSON.stringify(a), sbb = JSON.stringify(b);
    if (sa !== sbb) throw new Error(msg || `expected ${sbb}, got ${sa}`);
};

// Version chain — ftorient-v20 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18',
    'floattools-v19', 'ftorient-v20'];
const CURRENT_VERSION = 'ftsize-v21';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    // Walk the PARAMETER LIST first, then count body braces: the first `{`
    // after the marker may be a default-value object literal (`opts = {}`),
    // not the function body. String + comment states are tracked so an
    // apostrophe inside a // comment (e.g. "the sidebar's default dock")
    // cannot flip the scanner into string mode and desync the counting.
    let i = start + marker.length - 1;   // positioned at the '(' of the params
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

function makeClassSet(initial = []) {
    const set = new Set(initial);
    return {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c, f) => {
            let now;
            if (f === undefined) {
                if (set.has(c)) { set.delete(c); now = false; }
                else { set.add(c); now = true; }
            } else if (f) { set.add(c); now = true; }
            else { set.delete(c); now = false; }
            return now;
        },
        contains: (c) => set.has(c),
    };
}

// Extract the top-level `let` prelude of the drag module (ftCurrentPos etc.)
// so the VM functions share the same live bindings.
function extractDragLets(src) {
    const start = src.indexOf('let ftCurrentPos');
    const end = src.indexOf('// Default resting position');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('drag module let-prelude not found in floattools.js');
    }
    return src.slice(start, end);
}

// A DOM element stub good enough for the drag math. getBoundingClientRect
// reads the LIVE el.rect property so tests can simulate workspace resizes.
function makeEl(rect) {
    const listeners = {};
    const el = {
        rect,
        style: {},
        offsetWidth: 10,
        classList: makeClassSet(),   // ft-vertical class + RO-driven layout
    };
    el.getBoundingClientRect = () => ({ left: 0, top: 0, ...el.rect });
    el.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
    el.removeEventListener = (t, f) => {
        if (listeners[t]) listeners[t] = listeners[t].filter(f2 => f2 !== f);
    };
    el.__listeners = listeners;
    el.__dispatch = (t, ev) => (listeners[t] || []).forEach(f => f(ev));
    el.setPointerCapture = (id) => { el.__captured = id; };
    return el;
}

// Build a VM sandbox carrying floattools.js's drag engine.
function makeToolbarSandbox(opts = {}) {
    const ws = makeEl({ width: opts.wsW ?? 1000, height: opts.wsH ?? 800 });
    const tbEl = makeEl({ width: opts.tbW ?? 480, height: opts.tbH ?? 44 });
    const grip = makeEl({});
    const els = { 'workspace-main': ws, 'float-toolbar': tbEl, 'ft-drag-handle': grip };
    const winListeners = {};
    const windowStub = {
        addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
        removeEventListener: (t, f) => {
            if (winListeners[t]) winListeners[t] = winListeners[t].filter(f2 => f2 !== f);
        },
    };
    const rafQueue = [];
    const sb = {
        document: {
            body: { classList: makeClassSet(opts.bodyClasses || []) },
            getElementById: (id) => els[id] || null,
        },
        window: windowStub,
        requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
        state: Object.assign({ floatToolbarPos: null }, opts.state || {}),
        saveSettings: () => { sb.__saves = (sb.__saves || 0) + 1; },
        Date: { now: () => sb.__now ?? 1000 },
        console,
    };
    if (opts.withRO) {
        sb.ResizeObserver = class {
            constructor(cb) { sb.__roCb = cb; }
            observe(el) { (sb.__roObserved = sb.__roObserved || []).push(el); }
            unobserve() {} disconnect() {}
        };
    }
    sb.__now = 1000;
    vm.createContext(sb);
    const src = fs.readFileSync(FLOATTOOLS_JS, 'utf8');
    vm.runInContext(extractDragLets(src), sb, { filename: 'floattools.js#dragLets' });
    const fns = ['floatToolbarDefaultPos', 'clampFloatToolbarPos', 'ftResolvePos',
        'ftWriteTransform', 'applyFloatToolbarPos', 'moveFloatToolbarTo',
        'beginFloatToolbarDrag', 'moveFloatToolbarDrag', 'endFloatToolbarDrag',
        'resetFloatToolbarPos', 'handleFloatToolbarResize', 'initFloatToolbarDrag',
        'setFloatToolbarOrientation', 'toggleFloatToolbarOrientation'];
    fns.forEach(fn => vm.runInContext(extractFunction(src, fn), sb, { filename: `floattools.js#${fn}` }));
    sb.__els = els;
    sb.__grip = grip;
    sb.__tb = tbEl;
    sb.__ws = ws;
    sb.__win = winListeners;
    sb.__flushRAF = () => {
        const q = rafQueue.splice(0);
        q.forEach(cb => cb());
    };
    sb.__rafQueueLen = () => rafQueue.length;
    return sb;
}

function makePointerEvent(sb, x, y, extra = {}) {
    return {
        button: 0,
        clientX: x,
        clientY: y,
        pointerId: 1,
        cancelable: true,
        prevented: false,
        preventDefault() { this.prevented = true; },
        target: sb.__grip,
        ...extra,
    };
}

function cssBlock(css, selector) {
    const i = css.indexOf(selector + ' {');
    if (i === -1) throw new Error(`CSS selector not found: ${selector}`);
    let depth = 0, j = css.indexOf('{', i);
    for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
    }
    // Strip comments so prose cannot trip declaration-level regex assertions.
    return css.slice(i, j + 1).replace(/\/\*[\s\S]*?\*\//g, '');
}

// Same as cssBlock but anchored at the LAST occurrence (for selectors that
// appear both in a base rule and inside a media override, e.g.
// .panel-min-btn — the base rule carries the z-index we want).
function cssBlockLast(css, selector) {
    const i = css.lastIndexOf(selector + ' {');
    if (i === -1) throw new Error(`CSS selector not found: ${selector}`);
    let depth = 0, j = css.indexOf('{', i);
    for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
    }
    return css.slice(i, j + 1).replace(/\/\*[\s\S]*?\*\//g, '');
}

// True when `pos` sits inside the @media block that starts at mediaIdx.
function insideMediaBlock(css, mediaIdx, pos) {
    let depth = 0, j = css.indexOf('{', mediaIdx);
    for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) return pos < j; }
    }
    return false;
}

// ===============================================================
console.log('\nSuite 1 — index.html structure (toolbar moved out of the header)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 #float-toolbar exists and is a child of #workspace-main (canvas never resizes)', () => {
    const mainStart = html.indexOf('id="workspace-main"');
    const mainEnd = html.indexOf('</main>', mainStart);
    const tbStart = html.indexOf('id="float-toolbar"');
    assert(mainStart !== -1 && mainEnd !== -1, 'workspace-main not found');
    assert(tbStart > mainStart && tbStart < mainEnd,
        '#float-toolbar must be an absolutely-positioned child of #workspace-main');
    assert(html.includes('<aside id="float-toolbar"'), 'toolbar must be an aside');
});

test('1.2 all 4 App-Mode buttons moved with IDENTICAL ids + onclick handlers', () => {
    const i = html.indexOf('id="float-toolbar"');
    const block = html.slice(i, html.indexOf('</aside>', i));
    [['mode-nav-btn', "setAppMode('navigation')"],
     ['mode-link-btn', "setAppMode('linking')"],
     ['mode-snip-link-btn', "setAppMode('snip-link')"],
     ['mode-del-link-btn', "setAppMode('delete-link')"]].forEach(([id, fn]) => {
        assert(block.includes(`id="${id}"`), `${id} missing from the toolbar`);
        assert(block.includes(`onclick="${fn}"`), `${id} lost its ${fn} handler`);
    });
});

test('1.3 all 7 Annotation Draw Tool buttons + file input moved with IDENTICAL ids', () => {
    const i = html.indexOf('id="float-toolbar"');
    const block = html.slice(i, html.indexOf('</aside>', i));
    // ftsize-v21: the four size-adjustable tools dispatch through
    // handleToolBtnTap (first tap selects, second tap opens the size menu);
    // the rest keep calling setAnnoTool directly. IDs are unchanged.
    [['tool-select', "setAnnoTool('select')"],
     ['tool-pen', "handleToolBtnTap('pen')"],
     ['tool-highlighter', "handleToolBtnTap('highlighter')"],
     ['tool-text', "setAnnoTool('text')"],
     ['tool-eraser-pixel', "handleToolBtnTap('eraser-pixel')"],
     ['tool-eraser-stroke', "handleToolBtnTap('eraser-stroke')"],
     ['tool-image', "setAnnoTool('image')"]].forEach(([id, fn]) => {
        assert(block.includes(`id="${id}"`), `${id} missing from the toolbar`);
        assert(block.includes(`onclick="${fn}"`), `${id} lost its ${fn} handler`);
    });
    assert(block.includes('id="image-upload"'), '#image-upload input must move with the image tool');
});

test('1.4 pen-customization + its separator moved into the toolbar', () => {
    const i = html.indexOf('id="float-toolbar"');
    const block = html.slice(i, html.indexOf('</aside>', i));
    assert(block.includes('id="pen-customization"'), '#pen-customization missing');
    assert(block.includes('id="pen-customization-sep"'), '#pen-customization-sep missing');
    assert(block.includes('id="tool-line-mode"'), 'line-mode button missing');
    // ftsize-v21: the thickness slider moved into the floating size menu
    // (#tool-size-menu, body level) — only the color preview remains inline.
    assert(!block.includes('id="thickness-picker"'), 'inline thickness slider must be gone');
    assert(block.includes('id="thickness-preview-canvas"'), 'color preview canvas missing');
    assert(block.includes('id="color-picker"'), 'color picker missing');
});

test('1.5 grip #ft-drag-handle is the FIRST control of the toolbar', () => {
    assert(html.includes('id="ft-drag-handle"'), 'missing #ft-drag-handle');
    const asideStart = html.indexOf('<aside id="float-toolbar"');
    const aside = html.slice(asideStart, html.indexOf('</aside>', asideStart));
    const gripIdx = aside.indexOf('id="ft-drag-handle"');
    const firstGroupIdx = aside.indexOf('id="mode-nav-btn"');
    assert(gripIdx !== -1 && firstGroupIdx !== -1 && gripIdx < firstGroupIdx,
        'grip must come before the tool groups');
    const i = aside.indexOf('id="ft-drag-handle"');
    const tagStart = aside.lastIndexOf('<button', i);
    const tag = aside.slice(tagStart, aside.indexOf('</button>', i));
    assert(tag.includes('fa-up-down-left-right'), 'grip needs the move icon');
    assert(/title="[^"]*Drag/i.test(tag), 'title must explain dragging');
    assert(/title="[^"]*(double-tap|re-dock)/i.test(tag), 'title must explain double-tap re-dock');
    assert(tag.includes('aria-label'), 'grip needs an aria-label');
});

test('1.6 the header no longer contains the moved tools', () => {
    const header = html.slice(html.indexOf('<body'), html.indexOf('id="workspace-main"'));
    ['mode-nav-btn', 'mode-link-btn', 'mode-snip-link-btn', 'mode-del-link-btn',
     'tool-select', 'tool-pen', 'tool-highlighter', 'tool-text',
     'tool-eraser-pixel', 'tool-eraser-stroke', 'tool-image',
     'pen-customization', 'image-upload'].forEach(id => {
        assert(!header.includes(`id="${id}"`), `${id} is still in the header`);
    });
});

test('1.7 the header keeps Group 0 (Active PDF controls) + Group 4 (Actions)', () => {
    const header = html.slice(html.indexOf('<body'), html.indexOf('id="workspace-main"'));
    ['pdf-switcher', 'pdf-controls-left', 'pdf-controls-right', 'lock-left-btn',
     'lock-right-btn'].forEach(id => assert(header.includes(`id="${id}"`), `${id} missing`));
    assert(header.includes('undoLastAction()'), 'undo button missing');
    assert(header.includes('redoNextAction()'), 'redo button missing');
    assert(header.includes('deleteSelection()'), 'delete-selection button missing');
    assert(header.includes('clearCurrentPageAnnotations()'), 'clear-page button missing');
});

test('1.8 floating sidebar is untouched by this change', () => {
    assert(html.includes('id="float-sidebar"'), 'sidebar missing');
    assert(html.includes('id="fs-drag-handle"'), 'sidebar grip missing');
});

// ===============================================================
console.log('\nSuite 2 — cache versioning (floattools-v19)');

test('2.1 CSS link carries floattools-v19', () => {
    const m = html.match(/style\.css\?v=([\w-]+)/);
    assert(m, 'CSS link version not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
});

test('2.2 ALL editor script tags carry floattools-v19 (>= 19 tags incl. floattools.js)', () => {
    const tags = html.match(/<script src="\/js\/[^"]+\?v=([\w-]+)"><\/script>/g) || [];
    assert(tags.length >= 19, `expected >=19 editor scripts, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
    assert(tags.some(t => t.includes('/js/floattools.js')), 'floattools.js script tag missing');
});

test('2.3 floattools.js loads BEFORE app.js (boot calls initFloatToolbarDrag)', () => {
    const ft = html.indexOf('/js/floattools.js');
    const app = html.indexOf('/js/app.js');
    assert(ft !== -1 && app !== -1 && ft < app, 'floattools.js must load before app.js');
});

test('2.4 header chip shows floattools-v19 and describes the floating tools', () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'version chip');
    assert(/title="[^"]*[Ll]iquid glass[^"]*"/.test(html), 'chip title should mention liquid glass');
});

test('2.5 floattools-v19 was never shipped before + liquidglass-v18 fully retired', () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    ['index.html', 'css/style.css', 'js/ui.js', 'js/app.js', 'js/events.js',
     'js/floattools.js', 'js/database.js', 'js/state.js'].forEach(f => {
        const src = fs.readFileSync(path.join(ROOT, 'static', f), 'utf8');
        assert(!src.includes('liquidglass-v18'), `liquidglass-v18 still present in static/${f}`);
    });
});

// ===============================================================
console.log('\nSuite 3 — CSS contract (liquid glass toolbar + drag mechanics)');
const css = fs.readFileSync(STYLE_CSS, 'utf8');
const TB_BLOCK = cssBlock(css, '#float-toolbar');
const GRIP_BLOCK = cssBlock(css, '#ft-drag-handle');

test('3.1 liquid glass surface: blur + saturate + gradient tint + hairline border', () => {
    assert(/backdrop-filter:\s*blur\(\d+px\)\s+saturate\(/.test(TB_BLOCK), 'must blur + saturate');
    assert(TB_BLOCK.includes('-webkit-backdrop-filter: blur('), 'webkit variant for Safari');
    assert(/background:\s*linear-gradient\(/.test(TB_BLOCK), 'gradient tint');
    assert(/rgba\(255,\s*255,\s*255,\s*0\.\d+\)/.test(TB_BLOCK), 'translucent white layers');
    assert(/border:\s*1px solid rgba\(255,\s*255,\s*255/.test(TB_BLOCK), 'hairline light border');
    assert(/box-shadow:/.test(TB_BLOCK), 'floating shadow');
    assert(/border-radius:\s*\d+px/.test(TB_BLOCK), 'rounded corners');
});

test('3.2 the toolbar ABSORBS the pointer (pointer-events: auto)', () => {
    assert(TB_BLOCK.includes('pointer-events: auto'), 'the bar must absorb clicks');
    assert(!TB_BLOCK.includes('pointer-events: none'), 'no pass-through rule inside the bar');
});

test('3.3 overlay geometry: absolute + transform-driven + GPU layer', () => {
    assert(TB_BLOCK.includes('position: absolute'), 'must be an overlay, no flex space');
    assert(TB_BLOCK.includes('left: 0') && TB_BLOCK.includes('top: 0'), 'JS owns the position');
    assert(TB_BLOCK.includes('transform: translate3d('), 'position applied via transform');
    assert(TB_BLOCK.includes('will-change: transform'), 'GPU-composited layer');
    assert(/transition:\s*transform\s+0\.18s/.test(TB_BLOCK), 'glide for programmatic moves');
    assert(TB_BLOCK.includes('z-index: 1150'), 'above canvas content');
});

test('3.4 @supports fallback: near-opaque surface without backdrop-filter', () => {
    // Search AFTER the toolbar block — the sidebar has its own @supports earlier.
    const tbIdx = css.indexOf('#float-toolbar {');
    const i = css.indexOf('@supports not', tbIdx);
    assert(i !== -1, 'missing @supports fallback for the toolbar');
    const block = css.slice(i, css.indexOf('}', css.indexOf('background', i)));
    assert(block.includes('#float-toolbar'), 'fallback must target the toolbar');
    assert(block.includes('rgba(255, 255, 255, 0.9'), 'fallback must be near-opaque');
});

test('3.5 body.ft-dragging kills the transition + selection during drags', () => {
    assert(cssBlock(css, 'body.ft-dragging #float-toolbar').includes('transition: none'),
        'dragging must disable the glide');
    assert(cssBlock(css, 'body.ft-dragging').includes('user-select: none'),
        'dragging must disable text selection');
});

test('3.6 grip contract: pointer island + touch-action none + grab cursor', () => {
    assert(GRIP_BLOCK.includes('pointer-events: auto'), 'grip must be interactive');
    assert(GRIP_BLOCK.includes('touch-action: none'), 'JS owns touch drags');
    assert(GRIP_BLOCK.includes('cursor: grab'), 'grab affordance');
    assert(/border:\s*1px dashed/.test(GRIP_BLOCK), 'dashed "grab me" border');
});

test('3.7 z-order: toolbar < sidebar < panel-min-btn (minimize stays clickable)', () => {
    const tbZ = parseInt((TB_BLOCK.match(/z-index:\s*(\d+)/) || [])[1], 10);
    const sbZ = parseInt((cssBlock(css, '#float-sidebar').match(/z-index:\s*(\d+)/) || [])[1], 10);
    const minZ = parseInt((cssBlockLast(css, '.panel-min-btn').match(/z-index:\s*(\d+)/) || [])[1], 10);
    assert(tbZ < sbZ, `toolbar (${tbZ}) must sit below the sidebar (${sbZ})`);
    assert(minZ > sbZ, `minimize button (${minZ}) must sit above the sidebar (${sbZ})`);
});

test('3.8 narrow screens: the bar wraps instead of overflowing', () => {
    assert(TB_BLOCK.includes('flex-wrap: wrap'), 'must wrap on narrow screens');
    assert(TB_BLOCK.includes('max-width:'), 'must cap its width');
});

test('3.9 touch devices get a bigger grip (34px) via the touch media block', () => {
    const touchIdx = css.indexOf('#ft-drag-handle { width: 34px');
    assert(touchIdx !== -1, 'touch grip override missing');
    // It must live INSIDE a media query: find the nearest @media before it
    // and brace-match that block to prove it encloses the override.
    const lastMedia = css.lastIndexOf('@media', touchIdx);
    assert(lastMedia !== -1, 'no @media before the override');
    assert(insideMediaBlock(css, lastMedia, touchIdx),
        'override must be inside the @media block');
});

// ===============================================================
console.log('\nSuite 4 — drag engine (floattools.js under VM)');

test('4.1 default position = top-center, below the minimize-button row', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    const d = vm.runInContext('floatToolbarDefaultPos()', sb);
    assert.deepStrictEqual(d, { x: 260, y: 44 });
});

test('4.2 default position clamps at 0 when the bar is wider than the workspace', () => {
    const sb = makeToolbarSandbox({ wsW: 300, wsH: 800, tbW: 480, tbH: 44 });
    const d = vm.runInContext('floatToolbarDefaultPos()', sb);
    assert.strictEqual(d.x, 0, 'x must never go negative');
});

test('4.3 clamp keeps the bar fully inside the workspace', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    const c = (x, y) => vm.runInContext(`clampFloatToolbarPos(${x}, ${y})`, sb);
    assert.deepStrictEqual(c(100, 100), { x: 100, y: 100 }, 'inside → passthrough (rounded)');
    assert.deepStrictEqual(c(-50, -50), { x: 0, y: 0 }, 'negative → 0');
    assert.deepStrictEqual(c(9999, 9999), { x: 520, y: 756 }, 'overflow → maxX/maxY');
});

test('4.4 clamp falls back to the default on non-finite input', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    const c = vm.runInContext('clampFloatToolbarPos(NaN, Infinity)', sb);
    assert.deepStrictEqual(c, { x: 260, y: 44 });
});

test('4.5 resolve: a valid saved position wins (clamped), null falls back to default', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    sb.state.floatToolbarPos = { x: 700, y: 700 };
    assert.deepStrictEqual(vm.runInContext('ftResolvePos()', sb), { x: 520, y: 700 },
        'x clamps to maxX, y=700 is already inside maxY=756');
    sb.state.floatToolbarPos = null;
    assert.deepStrictEqual(vm.runInContext('ftResolvePos()', sb), { x: 260, y: 44 });
});

test('4.6 ftWriteTransform writes translate3d and tracks the applied position', () => {
    const sb = makeToolbarSandbox();
    vm.runInContext('ftWriteTransform({ x: 123, y: 45 })', sb);
    assert.strictEqual(sb.__tb.style.transform, 'translate3d(123px, 45px, 0px)');
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 123, y: 45 });
});

test('4.7 applyFloatToolbarPos places the bar (first apply has no transition)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('applyFloatToolbarPos()', sb);
    assert.strictEqual(sb.__tb.style.transform, 'translate3d(260px, 44px, 0px)');
});

test('4.8 moveFloatToolbarTo coalesces moves through one rAF per frame', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('moveFloatToolbarTo(100, 100)', sb);
    vm.runInContext('moveFloatToolbarTo(200, 200)', sb);
    assert.strictEqual(sb.__rafQueueLen(), 1, 'multiple moves in one frame → one rAF');
    sb.__flushRAF();
    assert.strictEqual(sb.__tb.style.transform, 'translate3d(200px, 200px, 0px)',
        'the LAST target wins');
});

test('4.9 full drag: grip down → move → up persists the new position', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('ftWriteTransform({ x: 260, y: 44 })', sb);   // docked start
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 100, 100));
    assert(sb.document.body.classList.contains('ft-dragging'), 'ft-dragging during drag');
    vm.runInContext('moveFloatToolbarDrag', sb)(
        makePointerEvent(sb, 150, 140, { pointerId: 1 }));
    sb.__flushRAF();
    vm.runInContext('endFloatToolbarDrag', sb)();
    assert(!sb.document.body.classList.contains('ft-dragging'), 'ft-dragging cleared');
    assert.deepStrictEqual(sb.state.floatToolbarPos, { x: 310, y: 84 },
        '260+50, 44+40 — the drag delta must land exactly');
    assert(sb.__saves >= 1, 'drag end must save settings');
});

test('4.10 a plain tap does NOT personalize the docked position', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('ftWriteTransform({ x: 260, y: 44 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 100, 100));
    vm.runInContext('endFloatToolbarDrag', sb)();
    assert.strictEqual(sb.state.floatToolbarPos, null, 'zero movement must not save');
});

test('4.11 2px of jitter is not persisted (3px threshold)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('ftWriteTransform({ x: 260, y: 44 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 100, 100));
    vm.runInContext('moveFloatToolbarDrag', sb)(makePointerEvent(sb, 102, 100));
    sb.__flushRAF();
    vm.runInContext('endFloatToolbarDrag', sb)();
    assert.strictEqual(sb.state.floatToolbarPos, null, 'sub-threshold drag must not save');
});

test('4.12 a drag beyond the edge clamps to 0 and STILL persists', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('ftWriteTransform({ x: 260, y: 44 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 100, 100));
    vm.runInContext('moveFloatToolbarDrag', sb)(makePointerEvent(sb, -500, 100));
    sb.__flushRAF();
    vm.runInContext('endFloatToolbarDrag', sb)();
    assert.deepStrictEqual(sb.state.floatToolbarPos, { x: 0, y: 44 });
});

test('4.13 pointer-id filter: a second pointer cannot hijack the drag', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('ftWriteTransform({ x: 260, y: 44 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 100, 100, { pointerId: 1 }));
    vm.runInContext('moveFloatToolbarDrag', sb)(makePointerEvent(sb, 200, 200, { pointerId: 2 }));
    sb.__flushRAF();
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 260, y: 44 },
        'foreign-pointer moves must be ignored');
    vm.runInContext('endFloatToolbarDrag', sb)();
});

test('4.14 double-tap on the grip re-docks (clears the saved position)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    sb.state.floatToolbarPos = { x: 700, y: 700 };
    vm.runInContext('ftWriteTransform({ x: 700, y: 700 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 10, 10));
    vm.runInContext('endFloatToolbarDrag', sb)();          // first tap: a no-move drag
    sb.__now = 1100;
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 12, 12));
    assert.strictEqual(sb.state.floatToolbarPos, null, 'double-tap must clear the saved pos');
    assert.strictEqual(sb.__tb.style.transform, 'translate3d(260px, 44px, 0px)',
        'the bar glides back to the default top-center spot');
});

test('4.15 taps >350ms apart start a NEW drag instead of re-docking', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 10, 10));
    vm.runInContext('endFloatToolbarDrag', sb)();
    sb.__now = 1600;
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 12, 12));
    assert(sb.document.body.classList.contains('ft-dragging'), 'second tap must start a drag');
    vm.runInContext('endFloatToolbarDrag', sb)();
});

test('4.16 right-button / middle-button pointerdown does not start a drag', () => {
    const sb = makeToolbarSandbox();
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 10, 10, { button: 2 }));
    assert.strictEqual(vm.runInContext('ftDragCtx', sb), null, 'right-click must be ignored');
});

test('4.17 init binds the grip, applies the position, observes workspace + bar', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44, withRO: true });
    vm.runInContext('initFloatToolbarDrag()', sb);
    assert(sb.__grip.__listeners['pointerdown'], 'grip must get a pointerdown listener');
    assert(sb.__tb.style.transform.includes('translate3d'), 'init must place the bar');
    assert.strictEqual(sb.__roObserved.length, 2, 'RO must observe workspace AND toolbar');
    assert(sb.__roObserved.includes(sb.__ws) && sb.__roObserved.includes(sb.__tb));
});

test('4.18 RO callback re-applies (re-centers default / re-clamps dragged)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44, withRO: true });
    vm.runInContext('initFloatToolbarDrag()', sb);
    sb.__els['workspace-main'].rect = { width: 600, height: 500 };   // simulate resize
    sb.__roCb();
    assert.strictEqual(sb.__tb.style.transform, 'translate3d(60px, 44px, 0px)',
        'default spot must follow the workspace center');
});

test('4.19 window fallback listeners exist when ResizeObserver is unavailable', () => {
    const sb = makeToolbarSandbox({ withRO: false });
    vm.runInContext('initFloatToolbarDrag()', sb);
    assert(sb.__win['resize'], 'legacy window resize listener must be bound');
});

// ===============================================================
console.log('\nSuite 5 — wiring, guards & business-logic separation');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');
const dbSrc = fs.readFileSync(DB_JS, 'utf8');
const stateSrc = fs.readFileSync(STATE_JS, 'utf8');
const ftSrc = fs.readFileSync(FLOATTOOLS_JS, 'utf8');

test('5.1 events.js handlePointerDown bails out inside #float-toolbar', () => {
    const start = eventsSrc.indexOf('function handlePointerDown');
    const guard = eventsSrc.slice(start, start + 1600);
    assert(guard.includes("closest('#float-toolbar')"), 'missing #float-toolbar guard');
});

test('5.2 app.js touchstart AND touchmove bail out inside #float-toolbar', () => {
    const ts = appSrc.indexOf("addEventListener('touchstart'");
    const tm = appSrc.indexOf("addEventListener('touchmove'");
    assert(appSrc.slice(ts, ts + 900).includes("closest('#float-toolbar')"), 'touchstart guard');
    assert(appSrc.slice(tm, tm + 900).includes("closest('#float-toolbar')"), 'touchmove guard');
});

test('5.3 database.js persists floatToolbarPos', () => {
    assert(dbSrc.includes('floatToolbarPos: state.floatToolbarPos || null'), 'saveSettings payload');
});

test('5.4 app.js boot restores floatToolbarPos with strict validation', () => {
    const i = appSrc.indexOf('savedData.settings.floatToolbarPos');
    assert(i !== -1, 'boot restore missing');
    const block = appSrc.slice(i - 200, i + 500);
    assert(block.includes('isFinite'), 'must reject NaN/infinite garbage');
});

test('5.5 app.js boot calls initFloatToolbarDrag (after the sidebar init)', () => {
    const a = appSrc.indexOf('initFloatSidebarDrag()');
    const b = appSrc.indexOf('initFloatToolbarDrag()');
    assert(a !== -1 && b !== -1 && b > a, 'init order wrong');
});

test('5.6 state.js declares floatToolbarPos', () => {
    assert(stateSrc.includes('floatToolbarPos: null'), 'state field missing');
});

test('5.7 business logic untouched: setAnnoTool / setAppMode still target the same IDs', () => {
    const anno = extractFunction(uiSrc, 'setAnnoTool');
    ['tool-select', 'tool-pen', 'tool-highlighter', 'tool-text',
     'tool-eraser-pixel', 'tool-eraser-stroke', 'tool-image',
     'pen-customization', 'pen-customization-sep'].forEach(id => {
        assert(anno.includes(`'${id}'`), `setAnnoTool lost its reference to ${id}`);
    });
    const mode = extractFunction(uiSrc, 'setAppMode');
    ['mode-nav-btn', 'mode-link-btn', 'mode-snip-link-btn', 'mode-del-link-btn']
        .forEach(id => assert(mode.includes(`'${id}'`), `setAppMode lost ${id}`));
});

test('5.8 floattools.js is position-ONLY: no tool business logic inside', () => {
    assert(!ftSrc.includes('function setAnnoTool'), 'no setAnnoTool here');
    assert(!ftSrc.includes('function setAppMode'), 'no setAppMode here');
    assert(!ftSrc.includes('state.annoTool'), 'must never touch annotation state');
    assert(ftSrc.includes('initFloatToolbarDrag'), 'engine entry point present');
});

// ===============================================================
console.log(`\n========================================`);
console.log(`float toolbar: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
process.exit(failed ? 1 : 0);

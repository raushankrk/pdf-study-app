// ============================================================================
// tests/test_toolbar_orientation.js
// Regression suite: the floating annotation toolbar (#float-toolbar) gained
// an ORIENTATION toggle — the palette is a horizontal ribbon (default) and
// #ft-orient-toggle stands it up as a vertical rail (#float-toolbar.ft-
// vertical) and back. The user asked for BOTH options "so that user have
// flexibility".
//
// Feature contract:
//   * #ft-orient-toggle sits in the toolbar right after the grip; its icon
//     + title ALWAYS advertise the orientation the NEXT click produces
//     (ribbon → offers vertical via fa-arrows-up-down; rail → offers
//     horizontal via fa-arrows-left-right).
//   * CSS: .ft-vertical flips the bar to a single-column rail — groups and
//     their buttons stack, separators become horizontal hairlines, the
//     thickness slider stretches to the rail width, and the bar can never
//     outgrow the workspace (max-height + overflow-y: auto).
//   * Engine (js/floattools.js): setFloatToolbarOrientation() validates
//     strictly ('horizontal' | 'vertical' only), flips the class, updates
//     state.floatToolbarOrientation, re-applies the position (orientation-
//     specific DEFAULT spot: ribbon top-center / rail left-center; dragged
//     positions are simply re-clamped) and persists via saveSettings()
//     unless opts.skipSave. toggleFloatToolbarOrientation() flips.
//   * initFloatToolbarDrag() applies the persisted orientation on boot
//     (skipSave — boot must not dirty settings) and binds the toggle click.
//   * Version bumped floattools-v19 → ftorient-v20 everywhere.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
const FLOATTOOLS_JS = path.join(ROOT, 'static', 'js', 'floattools.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const DB_JS = path.join(ROOT, 'static', 'js', 'database.js');
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;
// JSON-based deep equality: cross-realm safe (vm objects) — same trick as
// the sibling float-toolbar suite.
assert.deepStrictEqual = (a, b, msg) => {
    const sa = JSON.stringify(a), sbb = JSON.stringify(b);
    if (sa !== sbb) throw new Error(msg || `expected ${sbb}, got ${sa}`);
};

// Version chain — ftorient-v20 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18',
    'floattools-v19'];
const CURRENT_VERSION = 'ftorient-v20';

// ---------------------------------------------------------------------------
// Helpers (same harness conventions as test_float_toolbar.js)
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    // Walk the PARAMETER LIST first (the first `{` may be a default-value
    // object literal, not the body), with string + comment awareness so
    // apostrophes in comments cannot desync the counting.
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

function extractDragLets(src) {
    const start = src.indexOf('let ftCurrentPos');
    const end = src.indexOf('// Default resting position');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('drag module let-prelude not found in floattools.js');
    }
    return src.slice(start, end);
}

function makeEl(rect) {
    const listeners = {};
    const el = {
        rect,
        style: {},
        offsetWidth: 10,
        classList: makeClassSet(),
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

// The orientation toggle button stub: title property, i-icon via
// querySelector, setAttribute recorder — mirrors what the engine touches.
function makeOrientBtn() {
    const el = makeEl({});
    el.title = '';
    el.__attrs = {};
    el.setAttribute = (k, v) => { el.__attrs[k] = v; };
    el.__icon = { className: 'fa-solid fa-arrows-up-down' };
    el.querySelector = (sel) => (sel === 'i' ? el.__icon : null);
    return el;
}

function makeToolbarSandbox(opts = {}) {
    const ws = makeEl({ width: opts.wsW ?? 1000, height: opts.wsH ?? 800 });
    const tbEl = makeEl({ width: opts.tbW ?? 480, height: opts.tbH ?? 44 });
    const grip = makeEl({});
    const orientBtn = makeOrientBtn();
    const els = {
        'workspace-main': ws,
        'float-toolbar': tbEl,
        'ft-drag-handle': grip,
        'ft-orient-toggle': orientBtn,
    };
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
        state: Object.assign({
            floatToolbarPos: opts.statePos !== undefined ? opts.statePos : null,
            floatToolbarOrientation: opts.stateOrient !== undefined ? opts.stateOrient : 'horizontal',
        }, {}),
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
    sb.__orientBtn = orientBtn;
    sb.__tb = tbEl;
    sb.__ws = ws;
    sb.__win = winListeners;
    sb.__flushRAF = () => {
        const q = rafQueue.splice(0);
        q.forEach(cb => cb());
    };
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
console.log('\nSuite 1 — cache versioning (ftorient-v20)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 CSS link carries ftorient-v20', () => {
    const m = html.match(/style\.css\?v=([a-z0-9-]+)/);
    assert(m, 'CSS versioned link not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
});

test('1.2 every editor script tag carries ftorient-v20 (incl. floattools.js)', () => {
    const tags = html.match(/<script src="\/js\/[^"]+"><\/script>/g) || [];
    assert(tags.length >= 19, `expected >= 19 script tags, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
    assert(tags.some(t => t.includes('/js/floattools.js?')), 'floattools.js must be tagged');
});

test('1.3 header chip shows ftorient-v20 and mentions the orientation flexibility', () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'version chip missing');
    const chipIdx = html.indexOf(`>${CURRENT_VERSION}</span>`);
    const tagStart = html.lastIndexOf('<span', chipIdx);
    const tag = html.slice(tagStart, chipIdx);
    assert(/vertical/i.test(tag) && /horizontal/i.test(tag),
        'chip title should mention horizontal/vertical flexibility');
});

test('1.4 ftorient-v20 is new + floattools-v19 fully retired from shipped files', () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    assert(SHIPPED_VERSIONS.includes('floattools-v19'), 'v19 must be recorded as shipped');
    const css = fs.readFileSync(STYLE_CSS, 'utf8');
    const ftSrc = fs.readFileSync(FLOATTOOLS_JS, 'utf8');
    [html, css, ftSrc].forEach((src, i) => {
        assert(!src.includes('floattools-v19'),
            `shipped file #${i} still references the retired floattools-v19`);
    });
});

// ===============================================================
console.log('\nSuite 2 — index.html structure (orientation toggle button)');
const asideStart = html.indexOf('<aside id="float-toolbar"');
const aside = html.slice(asideStart, html.indexOf('</aside>', asideStart));

test('2.1 #ft-orient-toggle exists exactly once, inside the toolbar aside', () => {
    assert(asideStart !== -1, 'toolbar aside missing');
    assert(aside.includes('id="ft-orient-toggle"'), 'toggle button missing from the aside');
    const header = html.slice(html.indexOf('<body'), html.indexOf('id="workspace-main"'));
    assert(!header.includes('id="ft-orient-toggle"'), 'toggle must NOT be in the header');
    assert((html.match(/id="ft-orient-toggle"/g) || []).length === 1, 'must appear exactly once');
});

test('2.2 order: grip FIRST, then the orientation toggle, then the tool groups', () => {
    const gripIdx = aside.indexOf('id="ft-drag-handle"');
    const toggleIdx = aside.indexOf('id="ft-orient-toggle"');
    const firstToolIdx = aside.indexOf('id="mode-nav-btn"');
    assert(gripIdx !== -1 && toggleIdx !== -1 && firstToolIdx !== -1, 'element missing');
    assert(gripIdx < toggleIdx && toggleIdx < firstToolIdx,
        'grip → toggle → tools ordering broken');
});

test('2.3 initial icon = fa-arrows-up-down (default ribbon offers vertical)', () => {
    const i = aside.indexOf('id="ft-orient-toggle"');
    const tagStart = aside.lastIndexOf('<button', i);
    const tag = aside.slice(tagStart, aside.indexOf('</button>', i));
    assert(tag.includes('fa-arrows-up-down'), 'initial icon must offer vertical');
    assert(!tag.includes('fa-arrows-left-right'), 'must not advertise horizontal initially');
    assert(/title="[^"]*vertical/i.test(tag), 'title must say what the click produces');
    assert(tag.includes('aria-label'), 'toggle needs an aria-label');
});

// ===============================================================
console.log('\nSuite 3 — CSS contract (vertical rail + toggle styling)');
const css = fs.readFileSync(STYLE_CSS, 'utf8');

test('3.1 #float-toolbar.ft-vertical flips the bar to a single-column rail', () => {
    const b = cssBlock(css, '#float-toolbar.ft-vertical');
    assert(b.includes('flex-direction: column'), 'must stack children vertically');
    assert(b.includes('flex-wrap: nowrap'), 'the rail must not wrap');
    assert(b.includes('max-height'), 'must cap the height to the workspace');
    assert(b.includes('overflow-y: auto'), 'too-tall rails scroll, not clip');
    assert(b.includes('align-items: stretch'), 'groups span the rail width');
    assert(b.includes('max-width: none'), 'ribbon max-width must be lifted');
});

test('3.2 groups stand up: their buttons stack in a centered column', () => {
    const b = cssBlock(css, '#float-toolbar.ft-vertical > div.flex');
    assert(b.includes('flex-direction: column'), 'group children must stack');
    assert(b.includes('align-items: center'), 'buttons center in the rail');
});

test('3.3 separators become horizontal hairlines; slider stretches to the rail', () => {
    const sep = cssBlock(css, '#float-toolbar.ft-vertical .w-px');
    assert(sep.includes('height: 1px'), 'separator must be a horizontal hairline');
    const slider = cssBlock(css, '#float-toolbar.ft-vertical #thickness-picker');
    assert(slider.includes('min-width: 64px'), 'slider must stay usable in the rail');
});

test('3.4 grip + toggle center on the rail', () => {
    const b = cssBlock(css, '#float-toolbar.ft-vertical > #ft-orient-toggle');
    assert(b.includes('align-self: center'), 'meta buttons must center on the rail');
});

test('3.5 #ft-orient-toggle has its own round button styling (tap-safe)', () => {
    const b = cssBlock(css, '#ft-orient-toggle');
    assert(b.includes('width: 26px') && b.includes('height: 26px'), 'round meta button size');
    assert(b.includes('cursor: pointer'), 'it is a button, not a drag handle');
    assert(b.includes('touch-action: manipulation'),
        'taps toggle; the grip alone owns pointer gestures');
    assert(b.includes('pointer-events: auto'), 'must stay a click-absorbing island');
});

test('3.6 touch media query enlarges the toggle like the grip', () => {
    const lastTouch = css.lastIndexOf('@media (hover: none), (pointer: coarse)');
    assert(lastTouch !== -1, 'touch media query missing');
    const i = css.indexOf('#ft-orient-toggle { width: 34px', lastTouch);
    assert(i !== -1, 'touch rule for the toggle missing');
    assert(insideMediaBlock(css, lastTouch, i), 'toggle touch rule must live in the media block');
});

test('3.7 the horizontal ribbon base rules are untouched', () => {
    const b = cssBlock(css, '#float-toolbar');
    assert(b.includes('flex-wrap: wrap'), 'ribbon still wraps');
    assert(b.includes('backdrop-filter'), 'liquid glass intact');
    assert(b.includes('pointer-events: auto'), 'click absorption intact');
    const grip = cssBlock(css, '#ft-drag-handle');
    assert(grip.includes('touch-action: none'), 'grip still owns gestures');
});

// ===============================================================
console.log('\nSuite 4 — orientation engine (floattools.js under VM)');

test('4.1 setFloatToolbarOrientation("vertical") flips class + state + saves + re-places', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    const ok = vm.runInContext('setFloatToolbarOrientation("vertical")', sb);
    assert.strictEqual(ok, true, 'must report success');
    assert(sb.__tb.classList.contains('ft-vertical'), 'ft-vertical class must be set');
    assert.strictEqual(sb.state.floatToolbarOrientation, 'vertical', 'state must track it');
    assert.strictEqual(sb.__saves, 1, 'the choice must persist');
    assert(sb.__tb.style.transform.includes('translate3d'), 'position must be re-applied');
});

test('4.2 vertical DEFAULT spot = left-center rail (classic toolbox dock)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520 });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    assert.strictEqual(vm.runInContext('ftCurrentPos', sb).x, 8, 'rail hugs the left edge');
    assert.strictEqual(vm.runInContext('ftCurrentPos', sb).y, 140, 'rail is vertically centered');
});

test('4.3 horizontal DEFAULT spot unchanged: top-center, below the min-buttons', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('applyFloatToolbarPos()', sb);
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 260, y: 44 });
});

test('4.4 back to horizontal removes the class and re-centers', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520 });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    sb.__tb.rect = { width: 480, height: 44 };   // footprint back to the ribbon
    vm.runInContext('setFloatToolbarOrientation("horizontal", { skipSave: true })', sb);
    assert(!sb.__tb.classList.contains('ft-vertical'), 'class must be removed');
    assert.strictEqual(sb.state.floatToolbarOrientation, 'horizontal', 'state back to horizontal');
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 260, y: 44 },
        'must return to the ribbon default (no saved position)');
});

test('4.5 invalid orientation values are rejected without side effects', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    ['diagonal', '', null, undefined, 0, {}].forEach(v => {
        const ok = vm.runInContext(`setFloatToolbarOrientation(${JSON.stringify(v === undefined ? null : v)})`, sb);
        assert.strictEqual(ok, false, `value ${String(v)} must be rejected`);
    });
    assert(!sb.__tb.classList.contains('ft-vertical'), 'class must be untouched');
    assert.strictEqual(sb.state.floatToolbarOrientation, 'horizontal', 'state untouched');
    assert.strictEqual(sb.__saves, undefined, 'a rejected call must not save');
});

test('4.6 toggleFloatToolbarOrientation flips both ways and saves each time', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520 });
    vm.runInContext('toggleFloatToolbarOrientation()', sb);
    assert.strictEqual(sb.state.floatToolbarOrientation, 'vertical', 'horizontal → vertical');
    assert(sb.__tb.classList.contains('ft-vertical'), 'class flipped on');
    vm.runInContext('toggleFloatToolbarOrientation()', sb);
    assert.strictEqual(sb.state.floatToolbarOrientation, 'horizontal', 'vertical → horizontal');
    assert(!sb.__tb.classList.contains('ft-vertical'), 'class flipped off');
    assert.strictEqual(sb.__saves, 2, 'both flips persist');
});

test('4.7 a DRAGGED position survives the flip — re-clamped to the new footprint', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520,
        statePos: { x: 900, y: 700 } });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 900, y: 280 },
        'x stays (fits), y clamps to wsH - tbH = 280');
    assert.deepStrictEqual(sb.state.floatToolbarPos, { x: 900, y: 700 },
        'the saved position itself must not be overwritten by a clamp');
});

test('4.8 skipSave: boot-time application never dirties the settings blob', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    assert(sb.__tb.classList.contains('ft-vertical'), 'class applied');
    assert.strictEqual(sb.__saves, undefined, 'skipSave must not call saveSettings');
});

test('4.9 the toggle advertises the NEXT orientation (icon + title + aria)', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44 });
    vm.runInContext('setFloatToolbarOrientation("horizontal", { skipSave: true })', sb);
    assert(sb.__orientBtn.__icon.className.includes('fa-arrows-up-down'),
        'ribbon → button offers vertical');
    assert(/vertical/i.test(sb.__orientBtn.title), 'title offers vertical');
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    assert(sb.__orientBtn.__icon.className.includes('fa-arrows-left-right'),
        'rail → button offers horizontal');
    assert(/horizontal/i.test(sb.__orientBtn.title), 'title offers horizontal');
    assert(/horizontal/i.test(sb.__orientBtn.__attrs['aria-label'] || ''),
        'aria-label tracks the offer too');
});

test('4.10 init restores the persisted vertical orientation WITHOUT saving', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520,
        stateOrient: 'vertical', withRO: true });
    vm.runInContext('initFloatToolbarDrag()', sb);
    assert(sb.__tb.classList.contains('ft-vertical'), 'restored orientation class');
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 8, y: 140 },
        'placed at the vertical default (no saved position)');
    assert.strictEqual(sb.__saves, undefined, 'boot must not dirty the settings blob');
    assert.strictEqual(sb.__roObserved.length, 2, 'RO still observes workspace + bar');
});

test('4.11 init binds the click on the orientation toggle', () => {
    const sb = makeToolbarSandbox({ withRO: false });
    vm.runInContext('initFloatToolbarDrag()', sb);
    assert(sb.__orientBtn.__listeners['click'], 'toggle must have a click listener');
    // Real click path: the bound handler flips the orientation + persists.
    sb.__orientBtn.__dispatch('click', {});
    assert.strictEqual(sb.state.floatToolbarOrientation, 'vertical', 'click flips to vertical');
    assert.strictEqual(sb.__saves, 1, 'user-initiated flips persist');
});

test('4.12 dragging still persists in vertical mode', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520 });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    vm.runInContext('ftWriteTransform({ x: 8, y: 140 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 10, 10));
    vm.runInContext('moveFloatToolbarDrag', sb)(makePointerEvent(sb, 110, 90));
    sb.__flushRAF();
    vm.runInContext('endFloatToolbarDrag', sb)();
    assert.deepStrictEqual(sb.state.floatToolbarPos, { x: 108, y: 220 },
        'the vertical rail drags and persists like the ribbon');
});

test('4.13 double-tap on the grip re-docks the vertical rail to left-center', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 48, tbH: 520,
        statePos: { x: 500, y: 100 } });
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    vm.runInContext('ftWriteTransform({ x: 500, y: 100 })', sb);
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 10, 10));
    vm.runInContext('endFloatToolbarDrag', sb)();
    sb.__now = 1100;
    vm.runInContext('beginFloatToolbarDrag', sb)(makePointerEvent(sb, 12, 12));
    assert.strictEqual(sb.state.floatToolbarPos, null, 'double-tap clears the saved pos');
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 8, y: 140 },
        'the rail glides back to its own default spot');
});

test('4.14 RO re-applies the position after an orientation-driven resize', () => {
    const sb = makeToolbarSandbox({ wsW: 1000, wsH: 800, tbW: 480, tbH: 44, withRO: true });
    vm.runInContext('initFloatToolbarDrag()', sb);
    sb.__tb.rect = { width: 48, height: 520 };           // footprint stood up
    vm.runInContext('setFloatToolbarOrientation("vertical", { skipSave: true })', sb);
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 8, y: 140 });
    // Workspace shrinks afterwards → the rail re-clamps (RO fires).
    sb.__els['workspace-main'].rect = { width: 600, height: 400 };
    sb.__roCb();
    assert.deepStrictEqual(vm.runInContext('ftCurrentPos', sb), { x: 8, y: 0 },
        'y clamps to 0 when the rail is taller than the workspace');
});

// ===============================================================
console.log('\nSuite 5 — wiring, guards & separation');
const stateSrc = fs.readFileSync(STATE_JS, 'utf8');
const dbSrc = fs.readFileSync(DB_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const ftSrc = fs.readFileSync(FLOATTOOLS_JS, 'utf8');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');

test('5.1 state.js declares the horizontal default', () => {
    assert(stateSrc.includes("floatToolbarOrientation: 'horizontal'"),
        'state field missing or wrong default');
});

test('5.2 database.js persists the orientation (normalized to the two strings)', () => {
    assert(dbSrc.includes("state.floatToolbarOrientation === 'vertical' ? 'vertical' : 'horizontal'"),
        'saveSettings payload must normalize the value');
});

test('5.3 app.js boot restores the orientation strictly (old blobs stay horizontal)', () => {
    const i = appSrc.indexOf('savedData.settings.floatToolbarOrientation');
    assert(i !== -1, 'boot restore missing');
    const block = appSrc.slice(i, i + 220);
    assert(block.includes("=== 'vertical'"), "only the exact string 'vertical' may opt in");
});

test('5.4 boot order: sidebar init first, toolbar init after (unchanged)', () => {
    const a = appSrc.indexOf('initFloatSidebarDrag()');
    const b = appSrc.indexOf('initFloatToolbarDrag()');
    assert(a !== -1 && b !== -1 && b > a, 'init order wrong');
});

test('5.5 floattools.js stays position-ONLY: zero tool business logic', () => {
    assert(!ftSrc.includes('function setAnnoTool'), 'no setAnnoTool here');
    assert(!ftSrc.includes('function setAppMode'), 'no setAppMode here');
    assert(!ftSrc.includes('state.annoTool'), 'must never touch annotation state');
    assert(ftSrc.includes('function setFloatToolbarOrientation'), 'orientation engine present');
    assert(ftSrc.includes('function toggleFloatToolbarOrientation'), 'flip helper present');
});

test('5.6 the click-absorbing island is untouched by the orientation work', () => {
    const start = eventsSrc.indexOf('function handlePointerDown');
    assert(eventsSrc.slice(start, start + 1600).includes("closest('#float-toolbar')"),
        'events.js guard missing');
    const ts = appSrc.indexOf("addEventListener('touchstart'");
    assert(appSrc.slice(ts, ts + 900).includes("closest('#float-toolbar')"),
        'app.js touchstart guard missing');
});

// ===============================================================
console.log(`\n========================================`);
console.log(`toolbar orientation: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
process.exit(failed ? 1 : 0);

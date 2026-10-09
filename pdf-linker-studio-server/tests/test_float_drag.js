// ============================================================================
// tests/test_float_drag.js
// Regression suite: the floating tool sidebar (AI Chat + Comments) is a
// DRAGGABLE compact card — the user can move it smoothly anywhere inside
// #workspace-main via the grip handle (#fs-drag-handle).
//
// Feature contract:
//   * The PDF canvas NEVER resizes or moves because of the sidebar or a drag.
//   * Position is applied ONLY via transform: translate3d(...) — GPU
//     composited, rAF-coalesced → smooth 1:1 tracking. No left/top layout.
//   * body.fs-dragging disables the transform transition while dragging
//     (zero lag); programmatic moves (re-dock / re-clamp) glide.
//   * The card is always clamped fully inside #workspace-main.
//   * state.floatSidebarPos === null → docked top-right (the old right:0
//     resting place) and following the workspace edge on resize; after a
//     drag the position is persisted and restored (validated) on boot.
//   * Dragging works with mouse AND touch (pointer events, touch-action:none
//     grip); double-tap on the grip re-docks.
//   * All previous sidebar contracts still hold: liquid glass surface (not
//     plain transparent), the card ABSORBS the pointer (clicks never reach
//     the PDF), one pane at a time, interaction guards intact.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.deepStrictEqual = (a, b, msg) => {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja !== jb) throw new Error(msg || `expected ${jb}, got ${ja}`);
};
assert.ok = assert;

// Version chain — liquidglass-v18 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17'];
const CURRENT_VERSION = 'liquidglass-v18';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    let i = source.indexOf('{', start);
    let depth = 0, inStr = null;
    for (; i < source.length; i++) {
        const c = source[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === inStr) inStr = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
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
        // Mirror the real DOM: toggle returns whether the class is NOW present
        // (toggleAiSidebar depends on that boolean).
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

// Extract the top-level `let` prelude of the drag module (fsCurrentPos etc.)
// so the VM functions share the same live bindings.
function extractDragLets(uiSrc) {
    const start = uiSrc.indexOf('let fsCurrentPos');
    const end = uiSrc.indexOf('// Default resting position');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('drag module let-prelude not found in ui.js');
    }
    return uiSrc.slice(start, end);
}

// A DOM element stub good enough for the drag math.
function makeEl(rect) {
    const listeners = {};
    const el = {
        rect,
        style: {},
        offsetWidth: 10,
        getBoundingClientRect: () => ({ left: 0, top: 0, ...rect }),
        addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
        removeEventListener: (t, f) => {
            if (listeners[t]) listeners[t] = listeners[t].filter(f2 => f2 !== f);
        },
        __listeners: listeners,
        __dispatch: (t, ev) => (listeners[t] || []).forEach(f => f(ev)),
    };
    el.setPointerCapture = (id) => { el.__captured = id; };
    return el;
}

// Build a VM sandbox carrying ui.js's float-sidebar + drag functions.
function makeDragSandbox(opts = {}) {
    const ws = makeEl({ width: opts.wsW ?? 1000, height: opts.wsH ?? 800 });
    const sbEl = makeEl({ width: opts.sbW ?? 380, height: opts.sbH ?? 620 });
    const grip = makeEl({});
    const els = { 'workspace-main': ws, 'float-sidebar': sbEl, 'fs-drag-handle': grip };
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
        state: Object.assign({ floatSidebarPos: null, activeComment: { id: null } }, opts.state || {}),
        saveSettings: () => { sb.__saves = (sb.__saves || 0) + 1; },
        closeChatHistory: () => {},
        cancelCommentEdit: () => { sb.__commentCancelled = true; },
        Date: { now: () => sb.__now ?? 1000 },
        console,
    };
    if (opts.withRO) {
        // Minimal ResizeObserver double: records the observed element and
        // exposes the callback so tests can simulate workspace resizes.
        sb.ResizeObserver = class {
            constructor(cb) { sb.__roCb = cb; }
            observe(el) { sb.__roObserved = el; }
            unobserve() {} disconnect() {}
        };
    }
    sb.__now = 1000;
    vm.createContext(sb);
    const uiSrc = fs.readFileSync(UI_JS, 'utf8');
    vm.runInContext(extractDragLets(uiSrc), sb, { filename: 'ui.js#dragLets' });
    const fns = ['floatSidebarDefaultPos', 'clampFloatSidebarPos', 'fsResolvePos',
        'fsWriteTransform', 'applyFloatSidebarPos', 'moveFloatSidebarTo',
        'beginFloatSidebarDrag', 'moveFloatSidebarDrag', 'endFloatSidebarDrag',
        'resetFloatSidebarPos', 'handleFloatSidebarResize', 'initFloatSidebarDrag',
        'toggleAiSidebar', 'getFloatSidebarMode', 'setFloatSidebarMode',
        'openFloatSidebar', 'closeFloatSidebar'];
    fns.forEach(fn => vm.runInContext(extractFunction(uiSrc, fn), sb, { filename: `ui.js#${fn}` }));
    sb.__els = els;
    sb.__grip = grip;
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
    // Strip comments so prose like "the old right:0 resting place" cannot
    // trip declaration-level regex assertions.
    return css.slice(i, j + 1).replace(/\/\*[\s\S]*?\*\//g, '');
}

// ===============================================================
console.log('\nSuite 1 — index.html structure (drag grip + version)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 #fs-drag-handle exists inside #fs-header, before the mode switch', () => {
    assert(html.includes('id="fs-drag-handle"'), 'missing #fs-drag-handle');
    const header = html.slice(html.indexOf('id="fs-header"'), html.indexOf('id="fs-body"'));
    assert(header.includes('id="fs-drag-handle"'), 'grip must live in the header');
    assert(header.indexOf('fs-drag-handle') < header.indexOf('fs-mode-switch'),
        'grip should be the FIRST control (before mode pills)');
});

test('1.2 grip is a <button> with move icon + double-tap hint in its title', () => {
    const i = html.indexOf('id="fs-drag-handle"');
    const tagStart = html.lastIndexOf('<button', i);
    const tag = html.slice(tagStart, html.indexOf('</button>', i));
    assert(tag.includes('fa-up-down-left-right'), 'expected the move icon');
    assert(/title="[^"]*Drag/i.test(tag), 'title must explain dragging');
    assert(/title="[^"]*(double-tap|re-dock)/i.test(tag), 'title must explain double-tap re-dock');
    assert(tag.includes('aria-label'), 'grip needs an aria-label');
});

test('1.3 version bumped to liquidglass-v18 (CSS + every script + chip)', () => {
    const cssLink = html.match(/rel="stylesheet" href="\/css\/style\.css\?v=([^"]+)"/);
    assert.strictEqual(cssLink[1], CURRENT_VERSION, 'CSS cache version');
    const scripts = html.match(/<script src="\/js\/[^"]+\?v=([\w-]+)"><\/script>/g) || [];
    assert(scripts.length >= 15, `expected >=15 script tags, got ${scripts.length}`);
    scripts.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'header version chip');
});

test('1.4 liquidglass-v18 was never shipped before', () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    assert(!html.includes('floatside-v16'), 'old string must be fully replaced');
    assert(!html.includes('floatdrag-v17'), 'immediately-previous string must be fully replaced');
});

test('1.5 sidebar still an overlay inside #workspace-main (canvas never resizes)', () => {
    const mainStart = html.indexOf('id="workspace-main"');
    const mainEnd = html.indexOf('</main>', mainStart);
    const sidebarStart = html.indexOf('id="float-sidebar"');
    assert(sidebarStart > mainStart && sidebarStart < mainEnd,
        '#float-sidebar must be an absolutely-positioned child of #workspace-main');
});

// ===============================================================
console.log('\nSuite 2 — CSS contract (draggable card + liquid glass intact)');
const css = fs.readFileSync(STYLE_CSS, 'utf8');

test('2.1 #float-sidebar is a transform-driven compact card (no right/bottom dock)', () => {
    const block = cssBlock(css, '#float-sidebar');
    assert(block.includes('position: absolute'), 'must stay absolutely positioned');
    assert(block.includes('left: 0'), 'anchored at left: 0 (transform moves it)');
    assert(block.includes('top: 0'), 'anchored at top: 0');
    assert(!/right:\s*0/.test(block), 'must NOT dock with right: 0 anymore');
    assert(!/bottom:\s*0/.test(block), 'must NOT span with bottom: 0 anymore');
    assert(/height:\s*min\(620px,\s*100%\)/.test(block), 'compact card height cap');
    assert(block.includes('transform: translate3d(0, 0, 0)'), 'JS-driven transform');
    assert(block.includes('will-change: transform'), 'GPU compositing hint');
    assert(/transition:\s*transform/.test(block), 'glide transition for programmatic moves');
    assert(/backdrop-filter:\s*blur\(/.test(block), 'still liquid glass (backdrop blur)');
    assert(/background:\s*linear-gradient/.test(block), 'still a translucent glass tint');
    assert(!/background:\s*transparent/.test(block), 'must NOT be plain transparent');
    assert(block.includes('pointer-events: auto'), 'card still absorbs the pointer');
});

test('2.2 drag state: transition off + selection off while dragging', () => {
    const b = cssBlock(css, 'body.fs-dragging #float-sidebar');
    assert(b.includes('transition: none'), 'drag must track the pointer 1:1 (no lag)');
    const bodyBlock = cssBlock(css, 'body.fs-dragging');
    assert(/user-select:\s*none/.test(bodyBlock), 'no text selection while dragging');
});

test('2.3 grip: pointer-events island + touch-action none + grab cursor', () => {
    const g = cssBlock(css, '#fs-drag-handle');
    assert(g.includes('pointer-events: auto'), 'grip must capture the pointer');
    assert(g.includes('touch-action: none'), 'JS owns touch drags (no pan/scroll)');
    assert(g.includes('cursor: grab'), 'grab affordance');
    assert(g.includes('flex-shrink: 0'), 'grip must not shrink under pill pressure');
    const grabbing = cssBlock(css, 'body.fs-dragging #fs-drag-handle');
    assert(grabbing.includes('cursor: grabbing'), 'grabbing cursor while dragging');
});

test('2.4 pointer blocking layering (clicks on the card never reach the PDF)', () => {
    assert(cssBlock(css, '#float-sidebar').includes('pointer-events: auto'), 'container absorbs');
    const pane = cssBlock(css, '#fs-chat-pane,\n#fs-comment-pane');
    assert(!pane.includes('pointer-events: none'), 'panes are ordinary card content');
    assert(pane.includes('overflow: hidden'), 'drawer clip kept');
    assert(!cssBlock(css, '#chat-history').includes('pointer-events: none'), 'chat list is a normal scroll area');
});

test('2.5 touch media query enlarges the grip for finger dragging', () => {
    const mq = '@media (hover: none), (pointer: coarse)';
    let found = false;
    let idx = css.indexOf(mq);
    while (idx !== -1 && !found) {
        // Properly match the media block with brace counting.
        const open = css.indexOf('{', idx);
        let depth = 0, j = open;
        for (; j < css.length; j++) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') { depth--; if (depth === 0) break; }
        }
        const block = css.slice(idx, j + 1);
        found = /#fs-drag-handle\s*\{[^}]*width:\s*34px/.test(block);
        idx = css.indexOf(mq, j + 1);
    }
    assert(found, 'grip should be 34px on touch devices');
});

console.log(`\nSuite 1+2: ${passed} passed so far`);

// ===============================================================
console.log('\nSuite 3 — ui.js drag logic (VM)');
// Expose a pointer-event factory inside the sandbox for ergonomics.
function withEvt(sb) { sb.__evt = (x, y, extra) => makePointerEvent(sb, x, y, extra); return sb; }
function open(sb) { vm.runInContext('openFloatSidebar()', sb); sb.__saves = 0; return sb; }
function readPos(sb) { return vm.runInContext('({ cur: fsCurrentPos, saved: state.floatSidebarPos })', sb); }
function transform(sb) { return sb.__els['float-sidebar'].style.transform || ''; }

test('3.1 default position = docked top-right (old right:0 resting place)', () => {
    const sb = withEvt(makeDragSandbox());
    const p = vm.runInContext('floatSidebarDefaultPos()', sb);
    assert.deepStrictEqual(p, { x: 620, y: 0 }); // 1000 - 380, top
});

test('3.2 default position degrades to (0,0) when card bigger than workspace', () => {
    const sb = withEvt(makeDragSandbox({ sbW: 1200 }));
    const p = vm.runInContext('floatSidebarDefaultPos()', sb);
    assert.deepStrictEqual(p, { x: 0, y: 0 });
});

test('3.3 clamp keeps the card fully inside the workspace', () => {
    const sb = withEvt(makeDragSandbox());
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(-50, -50)', sb), { x: 0, y: 0 });
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(5000, 5000)', sb), { x: 620, y: 180 });
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(300, 150)', sb), { x: 300, y: 150 });
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(300.4, 150.6)', sb), { x: 300, y: 151 });
    // y beyond the max (800 - 620 = 180) clamps:
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(300, 200)', sb), { x: 300, y: 180 });
});

test('3.4 clamp falls back to the default corner on non-finite input', () => {
    const sb = withEvt(makeDragSandbox());
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(NaN, 100)', sb), { x: 620, y: 0 });
    assert.deepStrictEqual(vm.runInContext('clampFloatSidebarPos(Infinity, 100)', sb), { x: 620, y: 0 });
});

test('3.5 applyFloatSidebarPos is a no-op while the sidebar is closed', () => {
    const sb = withEvt(makeDragSandbox());
    vm.runInContext('applyFloatSidebarPos()', sb);
    assert.strictEqual(transform(sb), '', 'display:none element must not be positioned');
});

test('3.6 first apply while open: docks at default, no slide-in transition', () => {
    const sb = withEvt(makeDragSandbox());
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
    vm.runInContext('applyFloatSidebarPos()', sb);
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)');
    assert.strictEqual(sb.__els['float-sidebar'].style.transition, '',
        'firstApply must restore the stylesheet transition after the jump-free write');
    assert.strictEqual(readPos(sb).cur.x, 620);
});

test('3.7 saved position is applied (and re-clamped if the workspace shrank)', () => {
    const sb = withEvt(makeDragSandbox({ state: { floatSidebarPos: { x: 100, y: 50 } } }));
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
    vm.runInContext('applyFloatSidebarPos()', sb);
    assert.strictEqual(transform(sb), 'translate3d(100px, 50px, 0px)');

    const sb2 = withEvt(makeDragSandbox({ state: { floatSidebarPos: { x: 5000, y: 700 } } }));
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb2);
    vm.runInContext('applyFloatSidebarPos()', sb2);
    assert.strictEqual(transform(sb2), 'translate3d(620px, 180px, 0px)', 'clamped on apply');
});

test('3.8 invalid saved position falls back to the docked corner', () => {
    for (const bad of ['oops', { x: 'a', y: 2 }, { x: 1, y: NaN }, null, 42]) {
        const sb = withEvt(makeDragSandbox({ state: { floatSidebarPos: bad } }));
        vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
        vm.runInContext('applyFloatSidebarPos()', sb);
        assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', `bad=${JSON.stringify(bad)}`);
    }
});

test('3.9 toggleAiSidebar applies the position when opening', () => {
    const sb = withEvt(makeDragSandbox());
    vm.runInContext('toggleAiSidebar()', sb);
    assert(sb.document.body.classList.contains('float-sidebar-open'), 'opened');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'positioned on open');
    assert(sb.__saves >= 1, 'settings saved');
    vm.runInContext('toggleAiSidebar()', sb);
    assert(!sb.document.body.classList.contains('float-sidebar-open'), 'closed again');
});

test('3.10 openFloatSidebar(mode) switches the pane AND positions the card', () => {
    const sb = withEvt(makeDragSandbox());
    vm.runInContext('openFloatSidebar("comments")', sb);
    assert(sb.document.body.classList.contains('fs-mode-comments'), 'comments mode');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'positioned');
});

test('3.11 begin drag: grabs the pointer, marks body, registers window listeners', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    assert(sb.document.body.classList.contains('fs-dragging'), 'fs-dragging on body');
    assert(sb.__grip.__captured === 1, 'pointer captured on the grip');
    assert.deepStrictEqual(vm.runInContext('fsDragCtx && { x: fsDragCtx.origX, y: fsDragCtx.origY }', sb),
        { x: 620, y: 0 }, 'drag starts from the applied position');
    assert((sb.__win['pointermove'] || []).length === 1, 'pointermove listener');
    assert((sb.__win['pointerup'] || []).length === 1, 'pointerup listener');
    assert((sb.__win['pointercancel'] || []).length === 1, 'pointercancel listener');
});

test('3.12 drag move updates the transform through rAF, clamped', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(300, 500))', sb); // delta (-200, +100)
    assert.strictEqual(sb.__rafQueueLen(), 1, 'one rAF scheduled');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'not applied before the frame');
    sb.__flushRAF();
    assert.strictEqual(transform(sb), 'translate3d(420px, 100px, 0px)');
    vm.runInContext('moveFloatSidebarDrag(__evt(300 + 5000, 500 + 5000))', sb); // far out → clamp
    sb.__flushRAF();
    assert.strictEqual(transform(sb), 'translate3d(620px, 180px, 0px)', 'clamped to workspace');
});

test('3.13 rapid moves coalesce into the LAST position (one write per frame)', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(480, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(470, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(460, 400))', sb);
    assert.strictEqual(sb.__rafQueueLen(), 1, 'coalesced to a single frame');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'nothing applied before the frame');
    sb.__flushRAF();
    // orig 620 + (460 - 500) = 580 → the LAST target wins.
    assert.strictEqual(transform(sb), 'translate3d(580px, 0px, 0px)');
});

test('3.14 moves from another pointer are ignored', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(300, 500, { pointerId: 99 }))', sb);
    sb.__flushRAF();
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'foreign pointer must not move the card');
});

test('3.15 end drag: unmarks body, removes listeners, persists the position', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(300, 500))', sb); // → (420, 100)
    sb.__flushRAF();
    vm.runInContext('endFloatSidebarDrag()', sb);
    assert(!sb.document.body.classList.contains('fs-dragging'), 'fs-dragging removed');
    assert((sb.__win['pointermove'] || []).length === 0, 'pointermove listener removed');
    assert((sb.__win['pointerup'] || []).length === 0, 'pointerup listener removed');
    assert((sb.__win['pointercancel'] || []).length === 0, 'pointercancel listener removed');
    const pos = readPos(sb);
    assert.deepStrictEqual(pos.saved, { x: 420, y: 100 }, 'position persisted');
    assert(sb.__saves >= 1, 'settings saved on drag end');
    // After end, moves must be inert.
    vm.runInContext('moveFloatSidebarDrag(__evt(0, 0))', sb);
    sb.__flushRAF();
    assert.strictEqual(transform(sb), 'translate3d(420px, 100px, 0px)', 'no ctx → no movement');
});

test('3.16 end drag flushes a still-pending frame (fast flick)', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(100, 500))', sb); // → 620-400=220, y=100 (pending)
    vm.runInContext('endFloatSidebarDrag()', sb);                  // end BEFORE rAF runs
    assert.strictEqual(transform(sb), 'translate3d(220px, 100px, 0px)',
        'pending target must be flushed synchronously at drag end');
    assert.deepStrictEqual(readPos(sb).saved, { x: 220, y: 100 }, 'persisted = visual resting spot');
});

test('3.17 end without begin is a harmless no-op', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('endFloatSidebarDrag()', sb);
    assert(sb.__saves === 0, 'no save without a drag');
});

test('3.18 pointercancel ends the drag gracefully (position kept, not lost)', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(300, 500))', sb);
    sb.__flushRAF();
    vm.runInContext('endFloatSidebarDrag()', sb); // cancel routes to the same handler
    assert.deepStrictEqual(readPos(sb).saved, { x: 420, y: 100 }, 'position kept');
});

test('3.19 double-tap on the grip re-docks (and never starts a second drag)', () => {
    const sb = withEvt(open(makeDragSandbox()));
    // Drag to (200, 100) first.
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('moveFloatSidebarDrag(__evt(80, 500))', sb); // 620-420=200, 0+100=100
    sb.__flushRAF();
    vm.runInContext('endFloatSidebarDrag()', sb);
    assert.deepStrictEqual(readPos(sb).saved, { x: 200, y: 100 });
    // First tap of the double-tap.
    sb.__now = 2000;
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('endFloatSidebarDrag()', sb);
    // Second tap 100ms later at the same spot → reset to dock.
    sb.__now = 2100;
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    assert(!sb.document.body.classList.contains('fs-dragging'), 'reset tap starts NO drag');
    assert.strictEqual(readPos(sb).saved, null, 'position forgotten (dock-like again)');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 'back at the dock');
    assert(sb.__saves >= 1, 're-dock persists');
    vm.runInContext('endFloatSidebarDrag()', sb); // must be inert
});

test('3.20 two taps >350ms apart are a NEW drag, not a re-dock', () => {
    const sb = withEvt(open(makeDragSandbox()));
    sb.__now = 1000;
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('endFloatSidebarDrag()', sb);
    assert.strictEqual(readPos(sb).saved, null,
        'zero-distance tap must NOT turn the dock default into a saved spot');
    sb.__now = 1500;
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    assert(sb.document.body.classList.contains('fs-dragging'), 'second grab starts a drag');
});

test('3.21 quick taps far apart are a NEW drag, not a re-dock', () => {
    const sb = withEvt(open(makeDragSandbox()));
    sb.__now = 1000;
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    vm.runInContext('endFloatSidebarDrag()', sb);
    sb.__now = 1100;
    vm.runInContext('beginFloatSidebarDrag(__evt(700, 200))', sb); // 200px away
    assert(sb.document.body.classList.contains('fs-dragging'), 'different spot → drag');
});

test('3.22 non-primary button never starts a drag', () => {
    const sb = withEvt(open(makeDragSandbox()));
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400, { button: 2 }))', sb);
    assert(!sb.document.body.classList.contains('fs-dragging'), 'right-click ignored');
});

test('3.23 begin while the sidebar is closed is ignored', () => {
    const sb = withEvt(makeDragSandbox());
    vm.runInContext('beginFloatSidebarDrag(__evt(500, 400))', sb);
    assert(!sb.document.body.classList.contains('fs-dragging'), 'no drag while closed');
    assert((sb.__win['pointermove'] || []).length === 0, 'no listeners while closed');
});

test('3.24 resetFloatSidebarPos forgets the dragged spot and re-docks', () => {
    const sb = withEvt(makeDragSandbox({ state: { floatSidebarPos: { x: 100, y: 50 } } }));
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
    vm.runInContext('applyFloatSidebarPos()', sb);
    vm.runInContext('resetFloatSidebarPos()', sb);
    assert.strictEqual(readPos(sb).saved, null, 'forgotten');
    assert.strictEqual(transform(sb), 'translate3d(620px, 0px, 0px)', 're-docked');
    assert(sb.__saves >= 1, 'persisted');
});

test('3.25 resize re-clamps a dragged position (open) and is inert (closed)', () => {
    const sb = withEvt(makeDragSandbox({ state: { floatSidebarPos: { x: 900, y: 700 } } }));
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
    vm.runInContext('applyFloatSidebarPos()', sb);
    vm.runInContext('handleFloatSidebarResize()', sb);
    assert.strictEqual(transform(sb), 'translate3d(620px, 180px, 0px)', 're-clamped into view');
    const sb2 = withEvt(makeDragSandbox({ state: { floatSidebarPos: { x: 900, y: 700 } } }));
    vm.runInContext('handleFloatSidebarResize()', sb2);
    assert.strictEqual(transform(sb2), '', 'closed sidebar: no positioning');
});

test('3.26 initFloatSidebarDrag binds the grip and (legacy fallback) window resize', () => {
    const sb = withEvt(makeDragSandbox()); // no ResizeObserver in this sandbox
    vm.runInContext('initFloatSidebarDrag()', sb);
    assert((sb.__grip.__listeners['pointerdown'] || []).length === 1, 'grip pointerdown bound');
    assert((sb.__win['resize'] || []).length === 1, 'window resize bound (fallback)');
});

test('3.27 with ResizeObserver available, the WORKSPACE is observed instead', () => {
    const sb = withEvt(makeDragSandbox({ withRO: true }));
    vm.runInContext('initFloatSidebarDrag()', sb);
    assert((sb.__grip.__listeners['pointerdown'] || []).length === 1, 'grip pointerdown bound');
    assert(sb.__roObserved === sb.__els['workspace-main'],
        'ResizeObserver must observe #workspace-main');
    assert((sb.__win['resize'] || []).length === 0, 'window resize NOT bound when RO exists');
    // Simulate the left file sidebar collapsing (workspace grows) while open:
    // the RO callback must re-apply (re-dock the never-dragged card).
    vm.runInContext('document.body.classList.add("float-sidebar-open")', sb);
    vm.runInContext('applyFloatSidebarPos()', sb);
    sb.__els['workspace-main'].rect.width = 1228; // sidebar collapsed
    vm.runInContext('typeof __roCb === "undefined" ? null : __roCb()', sb);
    assert.strictEqual(transform(sb), 'translate3d(848px, 0px, 0px)',
        'dock recomputed for the new workspace width (1228 - 380)');
    // Same callback must stay silent while the sidebar is closed.
    const sb2 = withEvt(makeDragSandbox({ withRO: true }));
    vm.runInContext('initFloatSidebarDrag()', sb2);
    vm.runInContext('__roCb()', sb2);
    assert.strictEqual(transform(sb2), '', 'no positioning while closed');
});

// ===============================================================
console.log('\nSuite 4 — wiring, guards and persistence');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const dbSrc = fs.readFileSync(DATABASE_JS, 'utf8');
const stateSrc = fs.readFileSync(STATE_JS, 'utf8');

test('4.1 annotate-while-open guard intact (grip drags never reach the PDF tools)', () => {
    const guard = extractFunction(eventsSrc, 'handlePointerDown');
    assert(guard.includes("closest('#float-sidebar')"), 'floating sidebar guard missing');
});

test('4.2 touch capture guards still skip the sidebar (touch dragging stays ours)', () => {
    assert(appSrc.includes("if (e.target.closest('#float-sidebar')) return;"),
        'touchstart/touchmove #float-sidebar guards missing');
});

test('4.3 app.js boots the drag module right after the resizer', () => {
    const i = appSrc.indexOf('initResizer()');
    assert(i !== -1, 'initResizer() missing');
    const tail = appSrc.slice(i, i + 200);
    assert(tail.includes('initFloatSidebarDrag()'), 'initFloatSidebarDrag() must run at boot');
});

test('4.4 boot restores the dragged position: validated numbers only + clamp-on-apply', () => {
    const i = appSrc.indexOf('savedData.settings.floatSidebarPos');
    assert(i !== -1, 'boot must read settings.floatSidebarPos');
    const block = appSrc.slice(i, i + 800);
    assert(block.includes('typeof savedFsPos.x === \'number\''), 'x must be a number');
    assert(block.includes('isFinite(savedFsPos.x)'), 'x must be finite');
    assert(block.includes('typeof savedFsPos.y === \'number\''), 'y must be a number');
    assert(block.includes('isFinite(savedFsPos.y)'), 'y must be finite');
    assert(block.includes('applyFloatSidebarPos()'), 'restored position applied when open');
});

test('4.5 saveSettings persists floatSidebarPos', () => {
    assert(dbSrc.includes('floatSidebarPos: state.floatSidebarPos || null'),
        'settings payload must carry floatSidebarPos');
});

test('4.6 state.js declares the field', () => {
    assert(stateSrc.includes('floatSidebarPos: null'), 'state.floatSidebarPos missing');
});

test('4.7 drag listeners registered non-passive so preventDefault sticks', () => {
    const uiSrc = fs.readFileSync(UI_JS, 'utf8');
    assert(uiSrc.includes("window.addEventListener('pointermove', moveFloatSidebarDrag, { passive: false })"),
        'pointermove must be non-passive');
});

// ===============================================================
console.log(`\n========================================`);
console.log(`test_float_drag.js: ${passed} passed, ${failed} failed`);
console.log(`========================================`);
process.exit(failed ? 1 : 0);

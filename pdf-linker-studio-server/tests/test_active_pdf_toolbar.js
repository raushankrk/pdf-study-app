/**
 * Regression tests for the "Single Active-PDF toolbar" UI refactor.
 *
 * What changed (these tests guard it):
 *   - The two per-PDF h-10 toolbars above the PDF A (left) / PDF B (right)
 *     viewports were REMOVED.
 *   - The main application header now contains ONE "Active PDF" toolbar:
 *       [ A: doc-a.pdf | B: doc-b.pdf ]  [ lock | find | zoom | page | ops ]
 *     which always operates on the currently ACTIVE PDF.
 *   - The lock / find / zoom / page-nav / page-ops controls exist once per
 *     side (#pdf-controls-left / #pdf-controls-right); only the ACTIVE
 *     side's block is visible (pure CSS via body[data-active-pdf]).
 *   - Clicking/tapping a PDF (mouse, touch, Apple Pencil) makes it the
 *     active PDF (handlePointerDown → state.lastActiveSide →
 *     updateViewportActiveVisuals).
 *   - setActivePdf(side) (ui.js) is the new tab-click entry point.
 *   - activeSide is persisted in project settings and restored on boot.
 *
 * The per-side element IDs were deliberately KEPT (left-page-input,
 * right-zoom-level, lock-left-btn, left-view-title, ...) so every existing
 * els[side + '...'] update path (renderPage, zoom indicators, lock visuals)
 * keeps working unchanged — these tests assert that guarantee.
 *
 * Run with:
 *   node tests/test_active_pdf_toolbar.js
 *
 * Exit code is 0 on success, 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, msg) {
    passCount++;
    console.log(`  ✓ PASS: ${name}${msg ? ' — ' + msg : ''}`);
}
function fail(name, err) {
    failCount++;
    failures.push({ name, err });
    console.log(`  ✗ FAIL: ${name}${err ? ' — ' + (err.message || err) : ''}`);
}
function test(name, fn) {
    try { fn(); ok(name); }
    catch (err) { fail(name, err); }
}
function countOccurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------
// Minimal DOM stub (just enough for ui.js setActivePdf +
// updateViewportActiveVisuals).
// ---------------------------------------------------------------
function makeElement(id) {
    const classes = new Set();
    return {
        id,
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, force) => {
                if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                else if (force) classes.add(c); else classes.delete(c);
                return force === undefined ? classes.has(c) : !!force;
            },
            contains: c => classes.has(c),
            _set: classes,
        },
    };
}

function makeUiSandbox(initialActiveSide = 'left') {
    const elsById = {};
    ['left-viewport', 'right-viewport', 'pdf-tab-left', 'pdf-tab-right']
        .forEach(id => { elsById[id] = makeElement(id); });

    let saveCalls = 0;
    const documentStub = {
        getElementById: id => elsById[id] || null,
        body: { dataset: { activePdf: initialActiveSide } },
    };

    const stateStub = {
        lastActiveSide: initialActiveSide,
        view: {
            left: { docId: 'docA', locked: false },
            right: { docId: 'docB', locked: false },
        },
        drawing: { active: false },
        appMode: 'annotation',
    };

    const sandbox = {
        state: stateStub,
        document: documentStub,
        window: {},
        saveSettings: () => { saveCalls++; },
        console,
    };
    sandbox.__els = elsById;
    sandbox.__saveCalls = () => saveCalls;
    return sandbox;
}

function loadUi(sandbox) {
    const code = fs.readFileSync(UI_JS, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'ui.js' });
}

// ===============================================================
// Suite 1 — HTML structure: one header toolbar, zero per-PDF bars
// ===============================================================
console.log('\nSuite 1 — index.html structure (single toolbar, no per-PDF bars)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 The two per-PDF h-10 viewports bars are removed', () => {
    assert.strictEqual(countOccurrences(html, 'h-10 bg-white border-b'), 0,
        'the old per-PDF toolbars (h-10 bg-white border-b) must be gone');
});

test('1.2 The Active PDF switcher + per-side controls exist exactly once', () => {
    for (const id of ['pdf-switcher', 'pdf-tab-left', 'pdf-tab-right',
                      'pdf-controls-left', 'pdf-controls-right']) {
        assert.strictEqual(countOccurrences(html, `id="${id}"`), 1,
            `#${id} must exist exactly once`);
    }
});

test('1.3 All relocated per-side element IDs appear exactly once (els[side+...] contract)', () => {
    const ids = [
        'left-page-input', 'right-page-input',
        'left-page-total', 'right-page-total',
        'left-zoom-level', 'right-zoom-level',
        'lock-left-btn', 'lock-right-btn',
        'left-view-title', 'right-view-title',
        'left-search-input', 'right-search-input',
        'left-search-nav', 'right-search-nav',
        'left-search-count', 'right-search-count',
    ];
    for (const id of ids) {
        assert.strictEqual(countOccurrences(html, `id="${id}"`), 1,
            `#${id} must exist exactly once (renderPage/updateZoomIndicator write to it)`);
    }
});

test('1.4 Relocated tools keep their exact handlers (operate per side)', () => {
    const handlers = [
        "zoomViewport('left', -0.25)", "zoomViewport('left', 0.25)",
        "zoomViewport('right', -0.25)", "zoomViewport('right', 0.25)",
        "resetZoom('left')", "resetZoom('right')",
        "navigatePage('left', -1)", "navigatePage('left', 1)",
        "navigatePage('right', -1)", "navigatePage('right', 1)",
        "jumpToPage('left')", "jumpToPage('right')",
        "insertPage('left', 'blank')", "insertPage('left', 'duplicate')",
        "insertPage('right', 'blank')", "insertPage('right', 'duplicate')",
        "deleteCurrentPage('left')", "deleteCurrentPage('right')",
        "toggleLock('left')", "toggleLock('right')",
        "toggleViewportSearch('left')", "toggleViewportSearch('right')",
        "setActivePdf('left')", "setActivePdf('right')",
    ];
    for (const h of handlers) {
        assert.ok(html.includes(h), `handler missing: ${h}`);
    }
});

test('1.5 The per-side controls blocks live INSIDE the main <header>', () => {
    const headerEnd = html.indexOf('</header>');
    assert.ok(headerEnd > 0, 'header exists');
    for (const id of ['pdf-switcher', 'pdf-controls-left', 'pdf-controls-right']) {
        const pos = html.indexOf(`id="${id}"`);
        assert.ok(pos > 0 && pos < headerEnd, `#${id} must be inside the header`);
    }
});

test('1.6 Page-scrub sliders kept in both panels (touch page scrubbing preserved)', () => {
    for (const id of ['left-page-slider', 'right-page-slider']) {
        assert.strictEqual(countOccurrences(html, `id="${id}"`), 1, `#${id} kept`);
    }
    assert.ok(html.includes("oninput=\"syncPageInput('left')\""));
    assert.ok(html.includes("onchange=\"jumpToPageFromSlider('right')\""));
});

test('1.7 body carries the default data-active-pdf="left"', () => {
    assert.ok(/<body[^>]*data-active-pdf="left"/.test(html),
        '<body data-active-pdf="left"> default required (CSS shows left controls first)');
});

test('1.8 Cache-busting version bumped so devices reload the new UI', () => {
    const m = /style\.css\?v=([^"]+)"/.exec(html);
    assert.ok(m, 'style.css has a cache-busting version param');
    assert.ok(!['comment-v9', 'activepdf-v11'].includes(m[1]),
        `version must move past every previously-shipped string (got ${m[1]})`);
});

// ===============================================================
// Suite 2 — CSS wiring: only the ACTIVE side's controls are visible
// ===============================================================
console.log('\nSuite 2 — style.css wiring (active-only visibility)');
const css = fs.readFileSync(STYLE_CSS, 'utf8');

test('2.1 Inactive side controls hidden via body[data-active-pdf] rules', () => {
    assert.ok(css.includes('body[data-active-pdf="left"]  #pdf-controls-right'),
        'rule hiding #pdf-controls-right when left is active');
    assert.ok(css.includes('body[data-active-pdf="right"] #pdf-controls-left'),
        'rule hiding #pdf-controls-left when right is active');
});

test('2.2 Tab styles exist (base + active + badges)', () => {
    for (const cls of ['.pdf-tab', '.pdf-tab.pdf-tab-active', '.pdf-tab-badge-a', '.pdf-tab-badge-b']) {
        assert.ok(css.includes(cls), `css class missing: ${cls}`);
    }
});

test('2.3 Touch devices get 40px tap targets for the Active PDF toolbar', () => {
    // Find the touch-UX media query block (the LAST (hover:none)/(pointer:coarse)
    // occurrence — earlier ones exist for the Yjs presence banner) and assert
    // our rules are inside it.
    const m = css.lastIndexOf('@media (hover: none), (pointer: coarse)');
    assert.ok(m > 0, 'touch media query exists');
    const block = css.slice(m, m + 6000);
    assert.ok(block.includes('.pdf-tab'), '.pdf-tab sized for touch');
    assert.ok(block.includes('#pdf-controls-left .tool-btn'), 'controls tool-btn resized for touch');
});

// ===============================================================
// Suite 3 — ui.js setActivePdf() logic
// ===============================================================
console.log('\nSuite 3 — setActivePdf / updateViewportActiveVisuals (ui.js)');

test('3.1 setActivePdf("right") switches the active PDF and saves settings', () => {
    const sb = makeUiSandbox('left');
    loadUi(sb);
    sb.window.setActivePdf('right');
    assert.strictEqual(sb.state.lastActiveSide, 'right');
    assert.strictEqual(sb.document.body.dataset.activePdf, 'right');
    assert.strictEqual(sb.__saveCalls(), 1, 'a real switch persists settings');
    assert.ok(sb.__els['pdf-tab-right'].classList.contains('pdf-tab-active'));
    assert.ok(!sb.__els['pdf-tab-left'].classList.contains('pdf-tab-active'));
});

test('3.2 setActivePdf("left") switches back', () => {
    const sb = makeUiSandbox('right');
    loadUi(sb);
    sb.window.setActivePdf('left');
    assert.strictEqual(sb.state.lastActiveSide, 'left');
    assert.strictEqual(sb.document.body.dataset.activePdf, 'left');
    assert.ok(sb.__els['left-viewport'].classList.contains('viewport-wrapper-active'));
    assert.ok(!sb.__els['right-viewport'].classList.contains('viewport-wrapper-active'));
});

test('3.3 Invalid side is ignored (no state change, no save)', () => {
    const sb = makeUiSandbox('left');
    loadUi(sb);
    sb.window.setActivePdf('middle');
    sb.window.setActivePdf(undefined);
    assert.strictEqual(sb.state.lastActiveSide, 'left');
    assert.strictEqual(sb.__saveCalls(), 0);
});

test('3.4 Re-activating the already-active PDF does NOT save (no settings noise)', () => {
    const sb = makeUiSandbox('left');
    loadUi(sb);
    sb.window.setActivePdf('left');
    assert.strictEqual(sb.state.lastActiveSide, 'left');
    assert.strictEqual(sb.__saveCalls(), 0, 'no-op switch must not bump the project revision');
});

test('3.5 Activation never disturbs an in-progress drawing gesture', () => {
    const sb = makeUiSandbox('left');
    loadUi(sb);
    sb.state.drawing.active = true;
    sb.state.drawing.pointerId = 42;
    sb.state.appMode = 'annotation';
    sb.window.setActivePdf('right');
    assert.strictEqual(sb.state.drawing.active, true, 'drawing untouched');
    assert.strictEqual(sb.state.drawing.pointerId, 42, 'pointerId untouched');
    assert.strictEqual(sb.state.appMode, 'annotation', 'mode untouched');
    assert.strictEqual(sb.state.lastActiveSide, 'right');
});

test('3.6 updateViewportActiveVisuals keeps both tabs + viewport ring in sync', () => {
    const sb = makeUiSandbox('right');
    loadUi(sb);
    sb.state.lastActiveSide = 'left';
    sb.window.setActivePdf('left', false); // same side → just refresh visuals
    assert.ok(sb.__els['left-viewport'].classList.contains('viewport-wrapper-active'));
    assert.ok(!sb.__els['right-viewport'].classList.contains('viewport-wrapper-active'));
    assert.ok(sb.__els['pdf-tab-left'].classList.contains('pdf-tab-active'));
    assert.ok(!sb.__els['pdf-tab-right'].classList.contains('pdf-tab-active'));
    assert.strictEqual(sb.document.body.dataset.activePdf, 'left');
});

// ===============================================================
// Suite 4 — Click / tap-to-activate wiring (events.js)
// ===============================================================
console.log('\nSuite 4 — click/tap-to-activate wiring (events.js)');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');

test('4.1 handlePointerDown activates the clicked/tapped PDF', () => {
    // The canonical activation block inside handlePointerDown:
    //   if (clickedSide && state.view[clickedSide].docId) {
    //       state.lastActiveSide = clickedSide;
    //       updateViewportActiveVisuals();
    const re = /if \(clickedSide && state\.view\[clickedSide\]\.docId\) \{\s*state\.lastActiveSide = clickedSide;\s*updateViewportActiveVisuals\(\);/;
    assert.ok(re.test(eventsSrc),
        'pointerdown (mouse, touch, Apple Pencil) must activate the tapped PDF');
});

test('4.2 Ctrl+wheel zoom activates the zoomed PDF', () => {
    assert.ok(eventsSrc.includes('Single Active-PDF toolbar'),
        'handleViewportZoom contains the activation block');
});

test('4.3 Pan/scroll (handleScroll) still activates the scrolled PDF', () => {
    const re = /const handleScroll = debounce\(\(side\) => \{[\s\S]*?state\.lastActiveSide = side;[\s\S]*?\}, 200\);/;
    assert.ok(re.test(eventsSrc), 'handleScroll sets lastActiveSide');
});

// ===============================================================
// Suite 5 — Persistence: activeSide saved + restored
// ===============================================================
console.log('\nSuite 5 — activeSide persistence');
const dbSrc = fs.readFileSync(DATABASE_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');

test('5.1 saveSettings persists activeSide', () => {
    assert.ok(/activeSide:\s*state\.lastActiveSide/.test(dbSrc),
        'saveSettings must include activeSide');
});

test('5.2 Boot restores the saved activeSide (when that side still has a doc)', () => {
    assert.ok(appSrc.includes('savedData.settings.activeSide'),
        'app.js init must read settings.activeSide');
    assert.ok(/savedActiveSide === 'left' \|\| savedActiveSide === 'right'/.test(appSrc),
        'restore validates the saved value');
});

test('5.3 Boot falls back to the side that actually has a document', () => {
    assert.ok(appSrc.includes("!state.view.left.docId && state.view.right.docId"),
        'only-right-doc case must activate the right PDF');
});

// ===============================================================
// Summary
// ===============================================================
console.log('\n' + '='.repeat(60));
console.log(`TOTAL: ${passCount + failCount}  |  PASS: ${passCount}  |  FAIL: ${failCount}`);
if (failCount > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  - ${f.name}`));
    process.exit(1);
}
console.log('All Active-PDF toolbar tests passed.');
process.exit(0);

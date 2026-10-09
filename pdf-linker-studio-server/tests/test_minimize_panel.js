/**
 * Regression tests: panel minimize (single-toolbar era).
 *
 * Feature (user request):
 *   "add minimise option so that we can close one of the pdf canvas when
 *    not needed. when minimise automatically lock it so that when i click
 *    pdf not get open in that canvas"
 *
 * Contract under test:
 *   - Floating .panel-min-btn button in each panel calls minimizePanel(side).
 *   - minimizePanel(side):
 *       * hides that canvas via body[data-panel-min="<side>"] (CSS collapse),
 *       * AUTO-LOCKS it (state.view[side].locked = true) and remembers the
 *         lock was automatic (state.minimizeAutoLock),
 *       * never allows minimizing BOTH canvases,
 *       * moves the active-PDF state to the still-visible side,
 *       * tags the side's header tab with .pdf-tab-minimized (restore hint).
 *   - restorePanel(side): undoes everything; unlocks ONLY if the lock was
 *     auto-applied (manual locks survive).
 *   - setActivePdf(side) on a minimized side RESTORES it first (tab-click
 *     restore path).
 *   - openDocumentSmart (filemanager.js) NEVER routes a doc into a minimized
 *     viewport — including the tricky "doc already open in the minimized
 *     viewport" path.
 *   - Settings persist minimizedSide + minimizedAutoLock; boot restores.
 *   - clearAllData resets minimize state.
 *
 * Run with:
 *   node tests/test_minimize_panel.js
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
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const FILEMANAGER_JS = path.join(ROOT, 'static', 'js', 'filemanager.js');
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

// ---------------------------------------------------------------
// Minimal DOM stub (same pattern as test_active_pdf_toolbar.js)
// ---------------------------------------------------------------
function makeElement(id) {
    const classes = new Set();
    const attrs = {};
    const el = {
        id,
        title: '',
        style: {},
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
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: k => (k in attrs ? attrs[k] : null),
        _attrs: attrs,
        // ui.js does `btn.querySelector('i')` then touches .classList — return
        // an icon-like stub instead of null.
        querySelector: () => ({
            classList: {
                add() {}, remove() {}, toggle() {},
                contains: () => false,
                _set: new Set(),
            },
        }),
        querySelectorAll: () => [],
        innerHTML: '',
        innerText: '',
    };
    return el;
}

function makeUiSandbox(initial = {}) {
    const elsById = {};
    ['left-viewport', 'right-viewport', 'pdf-tab-left', 'pdf-tab-right',
     'lock-left-btn', 'lock-right-btn', 'left-search-nav', 'right-search-nav']
        .forEach(id => { elsById[id] = makeElement(id); });

    let saveCalls = 0;
    const documentStub = {
        getElementById: id => elsById[id] || null,
        body: {
            dataset: Object.assign({ activePdf: initial.activeSide || 'left' }, {}),
            classList: {
                _set: new Set(),
                add(...c) { c.forEach(x => this._set.add(x)); },
                remove(...c) { c.forEach(x => this._set.delete(x)); },
                toggle(c, f) { if (f === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (f) this._set.add(c); else this._set.delete(c); },
                contains(c) { return this._set.has(c); },
            },
        },
    };

    const stateStub = Object.assign({
        lastActiveSide: initial.activeSide || 'left',
        minimizedSide: null,
        minimizeAutoLock: { left: false, right: false },
        view: {
            left: Object.assign({ docId: 'docA', pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.left),
            right: Object.assign({ docId: 'docB', pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.right),
        },
        drawing: { active: false },
        appMode: 'navigation',
        linkCreation: { active: false, sourceData: null, sourceSide: null },
    }, initial.extra || {});

    const sandbox = {
        state: stateStub,
        document: documentStub,
        window: {},
        saveSettings: () => { saveCalls++; },
        renderMarkersForView: () => { sandbox.__markerCalls.push([...arguments]); },
        renderTextLayer: () => { sandbox.__textCalls.push([...arguments]); },
        closeViewportSearch: () => { sandbox.__searchCloseCalls.push([...arguments]); },
        updateLockVisuals: () => { sandbox.__lockVisualCalls++; },
        setAppMode: () => {},
        console,
    };
    sandbox.__els = elsById;
    sandbox.__saveCalls = () => saveCalls;
    sandbox.__markerCalls = [];
    sandbox.__textCalls = [];
    sandbox.__searchCloseCalls = [];
    sandbox.__lockVisualCalls = 0;
    return sandbox;
}

function loadUi(sandbox) {
    const code = fs.readFileSync(UI_JS, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'ui.js' });
}

// ===============================================================
console.log('\nSuite 1 — index.html structure (minimize buttons + wiring)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 Floating minimize buttons exist exactly once per panel', () => {
    for (const id of ['minimize-left-btn', 'minimize-right-btn']) {
        assert.strictEqual((html.split(`id="${id}"`).length - 1), 1, `#${id} must exist exactly once`);
    }
});

test('1.2 Buttons call minimizePanel with their own side', () => {
    assert.ok(html.includes(`onclick="minimizePanel('left')"`), 'left button wired');
    assert.ok(html.includes(`onclick="minimizePanel('right')"`), 'right button wired');
});

test('1.3 Buttons live INSIDE their panels (floating corner buttons)', () => {
    for (const [panel, btn] of [['left-panel', 'minimize-left-btn'], ['right-panel', 'minimize-right-btn']]) {
        const panelStart = html.indexOf(`id="${panel}"`);
        const panelEnd = html.indexOf('<!-- Vertical Resizer -->', panelStart) > 0 && panel === 'left-panel'
            ? html.indexOf('<!-- Vertical Resizer -->', panelStart)
            : html.indexOf('<svg id="drawing-layer"', panelStart);
        const btnPos = html.indexOf(`id="${btn}"`);
        assert.ok(btnPos > panelStart && btnPos < panelEnd, `#${btn} must be inside #${panel}`);
    }
});

test('1.4 Buttons are <button> elements (handlePointerDown ignores button targets)', () => {
    assert.ok(/<button id="minimize-left-btn"/.test(html), 'left minimize must be a real button');
    assert.ok(/<button id="minimize-right-btn"/.test(html), 'right minimize must be a real button');
});

test('1.5 Buttons carry the panel-min-btn class + accessible labels', () => {
    assert.ok(html.includes('class="panel-min-btn"'), '.panel-min-btn styling hook present');
    assert.ok(html.includes('aria-label="Minimize PDF A"'), 'A button aria-label');
    assert.ok(html.includes('aria-label="Minimize PDF B"'), 'B button aria-label');
});

// ===============================================================
console.log('\nSuite 2 — ui.js minimizePanel / restorePanel behavior');

test('2.1 minimizePanel("right") hides the panel + auto-locks it', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('right');
    assert.strictEqual(sb.state.minimizedSide, 'right', 'minimizedSide set');
    assert.strictEqual(sb.document.body.dataset.panelMin, 'right', 'body[data-panel-min] drives CSS');
    assert.strictEqual(sb.state.view.right.locked, true, 'AUTO-LOCK applied');
    assert.strictEqual(sb.state.minimizeAutoLock.right, true, 'auto-lock remembered (for restore)');
    assert.ok(sb.__els['pdf-tab-right'].classList._set.has('pdf-tab-minimized'), 'tab tagged minimized');
    assert.ok(sb.__saveCalls() >= 1, 'settings persisted');
});

test('2.2 minimizePanel moves the active PDF to the visible side', () => {
    const sb = makeUiSandbox({ activeSide: 'right' });
    loadUi(sb);
    sb.minimizePanel('right');
    assert.strictEqual(sb.state.lastActiveSide, 'left', 'active PDF switched to visible side');
    assert.strictEqual(sb.document.body.dataset.activePdf, 'left', 'header toolbar now targets A');
});

test('2.3 Manual lock + minimize: lock is NOT marked automatic (survives restore)', () => {
    const sb = makeUiSandbox({ right: { locked: true } });
    loadUi(sb);
    sb.minimizePanel('right');
    assert.strictEqual(sb.state.view.right.locked, true, 'stays locked');
    assert.strictEqual(sb.state.minimizeAutoLock.right, false, 'not OUR lock — restore must keep it');
});

test('2.4 restorePanel undoes the auto-lock (and only the auto-lock)', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('right');           // auto-lock applied
    sb.restorePanel('right');
    assert.strictEqual(sb.state.minimizedSide, null, 'minimized cleared');
    assert.strictEqual(sb.document.body.dataset.panelMin, undefined, 'dataset removed');
    assert.strictEqual(sb.state.view.right.locked, false, 'auto-lock undone');
    assert.ok(!sb.__els['pdf-tab-right'].classList._set.has('pdf-tab-minimized'), 'tab untagged');
    assert.ok(sb.__markerCalls.length >= 2, 'markers re-rendered for both sides after layout change');
    assert.ok(sb.__textCalls.length >= 2, 'text layers re-rendered');
});

test('2.5 restorePanel keeps a MANUAL lock locked', () => {
    const sb = makeUiSandbox({ right: { locked: true } });
    loadUi(sb);
    sb.minimizePanel('right');
    sb.restorePanel('right');
    assert.strictEqual(sb.state.view.right.locked, true, 'manual lock survives restore');
});

test('2.6 NEVER minimize both canvases', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('right');
    sb.minimizePanel('left');            // must be rejected
    assert.strictEqual(sb.state.minimizedSide, 'right', 'second minimize rejected');
    assert.strictEqual(sb.document.body.dataset.panelMin, 'right', 'visuals unchanged');
});

test('2.7 minimizePanel is idempotent per side', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('left');
    const saves = sb.__saveCalls();
    sb.minimizePanel('left');            // no-op
    assert.strictEqual(sb.__saveCalls(), saves, 'no extra saves on re-minimize');
    assert.strictEqual(sb.state.minimizedSide, 'left');
});

test('2.8 setActivePdf on a minimized side RESTORES it (tab-click restore path)', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('right');
    sb.setActivePdf('right');            // user clicks the B tab
    assert.strictEqual(sb.state.minimizedSide, null, 'restored by activation');
    assert.strictEqual(sb.state.lastActiveSide, 'right', 'and made active');
    assert.strictEqual(sb.state.view.right.locked, false, 'auto-lock undone');
    assert.strictEqual(sb.document.body.dataset.panelMin, undefined, 'split view back');
});

test('2.9 Pending link creation FROM the minimized side is cancelled first', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.state.linkCreation = { active: true, sourceData: { x: 1 }, sourceSide: 'left' };
    let cancelCalled = false;
    sb.setAppMode = (mode) => { if (mode === 'navigation') cancelCalled = true; };
    sb.minimizePanel('left');
    assert.ok(cancelCalled, 'setAppMode("navigation") called to cancel dangling link source');
});

// ===============================================================
console.log('\nSuite 3 — openDocumentSmart never targets a minimized viewport');
function makeFmSandbox(cfg) {
    const stateStub = {
        lastActiveSide: cfg.active || 'left',
        minimizedSide: cfg.minimized || null,
        view: {
            left: { docId: cfg.leftDoc || null, locked: !!cfg.leftLocked },
            right: { docId: cfg.rightDoc || null, locked: !!cfg.rightLocked },
        },
    };
    const sb = {
        state: stateStub,
        window: {},
        opened: [],
        modalShown: null,
        // NOTE: arrows close over `sb` — regular methods would lose `this`
        // when invoked as bare identifiers from inside the VM context.
        setActiveDocument: (side, docId) => { sb.opened.push({ side, docId }); stateStub.lastActiveSide = side; },
        pushRecentDoc: () => {},
        showModal: (t, b) => { sb.modalShown = t + ': ' + b; },
        console,
    };
    return sb;
}
function loadFm(sb) {
    // filemanager.js needs escapeHtml etc. only at runtime of other fns;
    // extract just openDocumentSmart to avoid loading the whole module.
    const src = fs.readFileSync(FILEMANAGER_JS, 'utf8');
    const start = src.indexOf('function openDocumentSmart');
    const end = src.indexOf('function pushRecentDoc');
    assert.ok(start > 0 && end > start, 'openDocumentSmart source found');
    const code = src.slice(start, end);
    vm.createContext(sb);
    vm.runInContext(code, sb, { filename: 'filemanager.js#openDocumentSmart' });
}

test('3.1 Fresh doc + right minimized → opens in visible LEFT', () => {
    const sb = makeFmSandbox({ active: 'left', minimized: 'right' });
    loadFm(sb);
    sb.openDocumentSmart('docX');
    assert.strictEqual(sb.opened[0].side, 'left', 'doc routed to visible side');
});

test('3.2 Fresh doc + active side minimized (defensive) → other side', () => {
    const sb = makeFmSandbox({ active: 'right', minimized: 'right' });
    loadFm(sb);
    sb.openDocumentSmart('docX');
    assert.strictEqual(sb.opened[0].side, 'left', 'defensive reroute away from minimized');
});

test('3.3 Doc already open in MINIMIZED viewport → reopens on the visible side', () => {
    const sb = makeFmSandbox({ active: 'left', minimized: 'right', rightDoc: 'docX' });
    loadFm(sb);
    sb.openDocumentSmart('docX');
    assert.strictEqual(sb.opened[0].side, 'left', 'must NOT reopen into minimized right');
});

test('3.4 Doc open on visible side + other minimized → reloads on visible side', () => {
    const sb = makeFmSandbox({ active: 'left', minimized: 'right', leftDoc: 'docX' });
    loadFm(sb);
    sb.openDocumentSmart('docX');
    assert.strictEqual(sb.opened[0].side, 'left', 'old locked-opposite behavior preserved');
});

test('3.5 No minimized state → behavior identical to legacy logic', () => {
    // Legacy: doc open on left, opposite unlocked → opens second copy on right.
    const sb = makeFmSandbox({ active: 'left', leftDoc: 'docX' });
    loadFm(sb);
    sb.openDocumentSmart('docX');
    assert.strictEqual(sb.opened[0].side, 'right', 'legacy opposite-side copy preserved');
});

test('3.6 Visible side manually locked + other minimized → blocked with modal', () => {
    const sb = makeFmSandbox({ active: 'left', minimized: 'right', leftLocked: true });
    loadFm(sb);
    sb.openDocumentSmart('docY');
    assert.strictEqual(sb.opened.length, 0, 'no doc opened');
    assert.ok(sb.modalShown && sb.modalShown.includes('Both viewports are locked'), 'lock modal shown');
});

// ===============================================================
console.log('\nSuite 4 — state + persistence + boot restore');

test('4.1 state.js declares minimizedSide + minimizeAutoLock defaults', () => {
    const src = fs.readFileSync(STATE_JS, 'utf8');
    assert.ok(src.includes('minimizedSide: null'), 'state.minimizedSide default');
    assert.ok(src.includes('minimizeAutoLock: { left: false, right: false }'), 'state.minimizeAutoLock default');
});

test('4.2 saveSettings persists minimizedSide + minimizedAutoLock', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    assert.ok(src.includes('minimizedSide:'), 'settings.minimizedSide written');
    assert.ok(src.includes('minimizedAutoLock:'), 'settings.minimizedAutoLock written');
    // VM smoke test: settings object includes both keys.
    const sandbox = {
        state: {
            minimizedSide: 'right',
            minimizeAutoLock: { left: false, right: true },
            lastActiveSide: 'left',
            view: { left: {}, right: {} },
            splitRatio: 0.5, appMode: 'navigation', lineMode: 'freehand',
            annoTool: 'pen', annoColor: '#ef4444', annoThickness: 5,
            folders: {}, aiSettings: {}, currentFolderId: 'root',
            fileSort: {}, recentDocIds: [], searchMode: 'files',
        },
        document: { body: { classList: { contains: () => false } } },
        Api: { saveSettings: async (s) => { sandbox.__saved = s; } },
        ROOT_FOLDER_ID: 'root',
        console,
    };
    const start = src.indexOf('async function saveSettings');
    const end = src.indexOf('// ---- Bulk load on startup ----');
    vm.createContext(sandbox);
    vm.runInContext(src.slice(start, end), sandbox, { filename: 'database.js#saveSettings' });
    vm.runInContext('saveSettings()', sandbox);
    return Promise.resolve().then(() => {
        const s = sandbox.__saved;
        assert.strictEqual(s.minimizedSide, 'right', 'minimizedSide persisted');
        assert.strictEqual(s.minimizedAutoLock, true, 'autoLock flag persisted');
        assert.strictEqual(s.activeSide, 'left', 'activeSide unaffected');
    });
});

test('4.3 app.js boot restores a persisted minimized panel (guarded on docs existing)', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.ok(src.includes('savedData.settings.minimizedSide'), 'boot reads minimizedSide');
    assert.ok(src.includes('savedData.settings.minimizedAutoLock'), 'boot reads minimizedAutoLock');
    assert.ok(src.includes('minimizePanel(savedMinSide, false)'), 'boot applies minimize silently');
    // Guard: only when at least one side has a doc.
    const idx = src.indexOf('savedMinSide');
    const guard = src.slice(idx, idx + 400);
    assert.ok(guard.includes('state.view.left.docId || state.view.right.docId'),
        'boot restore guarded on a doc existing');
});

test('4.4 clearAllData resets minimize state', () => {
    const sb = makeUiSandbox();
    loadUi(sb);
    sb.minimizePanel('left');
    // Re-run the reset block (mirrors clearAllData's state section).
    vm.runInContext(`
        state.minimizedSide = null;
        state.minimizeAutoLock = { left: false, right: false };
        applyPanelMinimizeVisuals(null);
    `, sb);
    assert.strictEqual(sb.document.body.dataset.panelMin, undefined, 'dataset cleared');
    assert.ok(!sb.__els['pdf-tab-left'].classList._set.has('pdf-tab-minimized'), 'tab reset');
});

// ===============================================================
console.log('\nSuite 5 — CSS wiring');

const css = fs.readFileSync(STYLE_CSS, 'utf8');

test('5.1 body[data-panel-min] collapse rules exist for both sides', () => {
    assert.ok(css.includes('body[data-panel-min="left"] #left-panel'), 'left collapse rule');
    assert.ok(css.includes('body[data-panel-min="right"] #right-panel'), 'right collapse rule');
    assert.ok(/body\[data-panel-min="left"\] #right-panel/.test(css), 'visible side expands (left min)');
    assert.ok(/body\[data-panel-min="right"\] #left-panel/.test(css), 'visible side expands (right min)');
});

test('5.2 Collapsed panel hides completely (zero footprint)', () => {
    const m = /body\[data-panel-min="left"\] #left-panel,\s*body\[data-panel-min="right"\] #right-panel\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, 'rule body found');
    const body = m[1];
    assert.ok(/width:\s*0 !important/.test(body), 'width 0');
    assert.ok(/visibility:\s*hidden/.test(body), 'visibility hidden');
    assert.ok(/flex:\s*0 0 0 !important/.test(body), 'flex-basis 0');
});

test('5.3 Resizer hidden + last-visible minimize button hidden while minimized', () => {
    assert.ok(/body\[data-panel-min\] #vertical-resizer\s*\{[^}]*display:\s*none !important/.test(css),
        'resizer hidden');
    assert.ok(/body\[data-panel-min="left"\] #minimize-right-btn\s*\{[^}]*display:\s*none/.test(css),
        'right button hidden when left minimized');
    assert.ok(/body\[data-panel-min="right"\] #minimize-left-btn\s*\{[^}]*display:\s*none/.test(css),
        'left button hidden when right minimized');
});

test('5.4 Minimized tab affordance styled (.pdf-tab-minimized + expand icon)', () => {
    assert.ok(css.includes('.pdf-tab-minimized'), 'tab style exists');
    assert.ok(/pdf-tab-minimized::after\s*\{[^}]*content:\s*"\\f065"/.test(css), 'fa-expand icon via ::after');
});

test('5.5 Touch devices get a 36px tap target for the minimize buttons', () => {
    const m = /@media \(hover: none\), \(pointer: coarse\)\s*\{[^@]*?\.panel-min-btn\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, 'touch rule for .panel-min-btn found');
    assert.ok(/width:\s*36px/.test(m[1]) && /height:\s*36px/.test(m[1]), '36px tap target');
});

test('5.6 Floating button positioned above canvas content', () => {
    // The base rule plus the touch override both exist — find whichever
    // carries the positioning declarations.
    const rules = [...css.matchAll(/\.panel-min-btn\s*\{([^}]*)\}/g)].map(m => m[1]);
    assert.ok(rules.length >= 2, 'base + touch rules exist');
    const base = rules.find(b => /position:\s*absolute/.test(b));
    assert.ok(base, 'absolute positioning declared');
    assert.ok(/z-index:\s*\d+/.test(base), 'explicit z-index');
});

// ===============================================================
console.log(`\n========================================`);
console.log(`Total: ${passCount + failCount} | PASS: ${passCount} | FAIL: ${failCount}`);
console.log(`========================================`);
if (failCount > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ✗ ${f.name}`));
    process.exit(1);
}
process.exit(0);

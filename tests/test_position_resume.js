// ============================================================================
// tests/test_position_resume.js
// Regression suite: PDFs must RESUME at their last reading position when
// re-opened (re-click in explorer/recent, re-route after canvas minimize,
// or page reload) instead of restarting at page 1.
//
// Root cause this guards: setActiveDocument() used to hard-reset
// pageNum=1 / scrollTop=0 on EVERY open; there was no per-doc memory.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const PDF_JS = path.join(ROOT, 'static', 'js', 'pdf.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const FILEMANAGER_JS = path.join(ROOT, 'static', 'js', 'filemanager.js');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;
assert.deepStrictEqual = (a, b, msg) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(msg || `deep mismatch:\n      got:  ${sa}\n      want: ${sb}`);
};

// Previously shipped cache-busting strings — the version must keep moving.
const SHIPPED_CSS_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13'];

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

// Extract one function's source out of a file so we can VM-test it in
// isolation (loading all of app.js in a sandbox would drag in the world).
function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert(start !== -1, `function ${name}() not found in source`);
    // Walk braces from the function's opening brace to its closing brace.
    let i = source.indexOf('{', start), depth = 0, end = -1;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert(end !== -1, `unbalanced braces extracting ${name}`);
    return source.slice(start, end);
}

function makePdfSandbox(initial = {}) {
    const stateStub = Object.assign({
        documents: initial.documents || {},
        lastActiveSide: 'left',
        lastPositions: initial.lastPositions || {},
        view: {
            left: Object.assign({ docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.left),
            right: Object.assign({ docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.right),
        },
        zoomLive: { left: 1.0, right: 1.0 },
    }, initial.extra || {});

    const sandbox = {
        state: stateStub,
        window: {},
        console,
        // dependencies of setActiveDocument / renderPage — recorded, not run
        clearSelection: () => { sandbox.__clearSel = (sandbox.__clearSel || 0) + 1; },
        closeViewportSearch: () => {},
        saveSettings: () => { sandbox.__saves = (sandbox.__saves || 0) + 1; },
        pushRecentDoc: (id) => { sandbox.__recent = sandbox.__recent || []; sandbox.__recent.push(id); },
        renderPage: (side) => {
            // Mirror the REAL renderPage contract: it calls rememberDocPosition
            // after resolving the page. The stub must do the same so the
            // setActiveDocument → renderPage → memory chain is tested honestly.
            sandbox.__renderCalls = (sandbox.__renderCalls || 0) + 1;
            if (typeof sandbox.rememberDocPosition === 'function') {
                sandbox.rememberDocPosition(side === 'right' ? 'right' : 'left');
            }
        },
        renderDocList: () => {},
        pageNumFromId: (doc, pageId) => {
            if (!doc || !doc.pageIds || !pageId) return 1;
            const idx = doc.pageIds.indexOf(pageId);
            return idx === -1 ? 1 : idx + 1;
        },
        pageIdFromNum: (doc, n) => (doc && doc.pageIds ? doc.pageIds[n - 1] || null : null),
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadPdfFunctions(sandbox, names) {
    const src = fs.readFileSync(PDF_JS, 'utf8');
    const code = names.map(n => extractFunction(src, n)).join('\n');
    vm.runInContext(code, sandbox, { filename: `pdf.js::${names.join(',')}` });
}

// A 30-page doc with stable page ids.
function makeDoc(id, pages = 30) {
    return {
        id, name: `${id}.pdf`, pageCount: pages,
        pageIds: Array.from({ length: pages }, (_, i) => `pg_${id}_${i + 1}`),
    };
}

// ===============================================================
console.log('\nSuite 1 — cache version + source wiring');
const html = fs.readFileSync(INDEX_HTML, 'utf8');
const pdfSrc = fs.readFileSync(PDF_JS, 'utf8');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');
const dbSrc = fs.readFileSync(DATABASE_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const fmSrc = fs.readFileSync(FILEMANAGER_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');

test('1.1 Cache-busting version bumped past every previously-shipped string', () => {
    const m = /style\.css\?v=([^"]+)"/.exec(html);
    assert(m, 'style.css has a cache-busting version param');
    assert.ok(!SHIPPED_CSS_VERSIONS.includes(m[1]),
        `version must move past all shipped strings (got ${m[1]})`);
});

test('1.2 pdf.js has rememberDocPosition + renderPage hook (all page-change paths covered)', () => {
    assert.ok(/function rememberDocPosition\(/.test(pdfSrc), 'rememberDocPosition defined');
    assert.ok(/rememberDocPosition\(side\);/.test(pdfSrc), 'renderPage calls rememberDocPosition(side)');
});

test('1.3 events.js handleScroll records scroll-only position updates', () => {
    // handleScroll is `const handleScroll = debounce((side) => {...}, 200)`.
    assert.ok(/const handleScroll = debounce/.test(eventsSrc), 'handleScroll found');
    const start = eventsSrc.indexOf('const handleScroll = debounce');
    const block = eventsSrc.slice(start, start + 900);
    assert.ok(/rememberDocPosition\(side\)/.test(block),
        'handleScroll captures scroll positions into the memory');
    assert.ok(/state\.view\[side\]\.docId && typeof rememberDocPosition/.test(block),
        'guarded so empty viewports never record');
});

test('1.4 saveSettings persists lastPositions', () => {
    assert.ok(/lastPositions:\s*state\.lastPositions\s*\|\|\s*\{\}/.test(dbSrc),
        'settings payload includes lastPositions');
});

test('1.5 app.js boot restores lastPositions and seeds from the restored viewports', () => {
    assert.ok(/settings\.lastPositions/.test(appSrc), 'boot reads settings.lastPositions');
    assert.ok(/state\.lastPositions\[v\.docId\]/.test(appSrc), 'boot seeds entries from view state');
});

test('1.6 deleting a doc forgets its position memory', () => {
    assert.ok(/if \(state\.lastPositions\) delete state\.lastPositions\[id\];/.test(fmSrc),
        '_deleteDocumentRecord cleans up lastPositions');
});

test('1.7 clearAllData resets the position memory', () => {
    assert.ok(/state\.lastPositions = \{\};/.test(uiSrc), 'clearAllData resets lastPositions');
});

// ===============================================================
console.log('\nSuite 2 — state.js initializes the memory');

test('2.1 state.lastPositions starts as an empty object', () => {
    // state.js creates a measure canvas at load time — stub document.
    const sb = { console, window: {}, document: { createElement: () => ({ getContext: () => ({}) }) } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(STATE_JS, 'utf8'), sb, { filename: 'state.js' });
    // `const state` is context-scoped (not a sandbox property) — read it explicitly.
    const st = vm.runInContext('state', sb);
    assert.deepStrictEqual(st.lastPositions, {}, 'lastPositions: {}');
});

// ===============================================================
console.log('\nSuite 3 — rememberDocPosition captures the reading spot');

test('3.1 records pageId/pageNum/scrollTop for the doc in view', () => {
    const doc = makeDoc('d1');
    const sb = makePdfSandbox({
        documents: { d1: doc },
        left: { docId: 'd1', pageId: 'pg_d1_7', pageNum: 7, scrollTop: 460 },
    });
    loadPdfFunctions(sb, ['rememberDocPosition']);
    sb.rememberDocPosition('left');
    assert.deepStrictEqual(sb.state.lastPositions.d1,
        { pageId: 'pg_d1_7', pageNum: 7, scrollTop: 460 });
});

test('3.2 clamps negative scroll and tolerates missing pageId', () => {
    const doc = makeDoc('d1');
    const sb = makePdfSandbox({
        documents: { d1: doc },
        left: { docId: 'd1', pageId: null, pageNum: 3, scrollTop: -50 },
    });
    loadPdfFunctions(sb, ['rememberDocPosition']);
    sb.rememberDocPosition('left');
    assert.deepStrictEqual(sb.state.lastPositions.d1,
        { pageId: null, pageNum: 3, scrollTop: 0 });
});

test('3.3 ignores empty viewports (no docId)', () => {
    const sb = makePdfSandbox({});
    loadPdfFunctions(sb, ['rememberDocPosition']);
    sb.rememberDocPosition('left');
    sb.rememberDocPosition('right');
    assert.deepStrictEqual(sb.state.lastPositions, {}, 'nothing recorded without a doc');
});

// ===============================================================
console.log('\nSuite 4 — setActiveDocument resumes instead of restarting');

test('4.1 REOPEN: remembered doc resumes at page 7 + scrollTop 460', () => {
    const doc = makeDoc('d1');
    const sb = makePdfSandbox({
        documents: { d1: doc },
        lastPositions: { d1: { pageId: 'pg_d1_7', pageNum: 7, scrollTop: 460 } },
        right: { docId: 'd0' }, // left is the usable side
    });
    loadPdfFunctions(sb, ['rememberDocPosition', 'setActiveDocument']);
    sb.setActiveDocument('left', 'd1');
    const v = sb.state.view.left;
    assert.strictEqual(v.pageId, 'pg_d1_7', 'pageId resumed');
    assert.strictEqual(v.pageNum, 7, 'pageNum resumed');
    assert.strictEqual(v.scrollTop, 460, 'scrollTop resumed');
    assert.strictEqual(sb.state.lastActiveSide, 'left', 'activation side kept');
    assert.strictEqual(sb.__renderCalls, 1, 'renderPage triggered');
});

test('4.2 FRESH OPEN: doc with no memory still starts at page 1', () => {
    const doc = makeDoc('d2');
    const sb = makePdfSandbox({ documents: { d2: doc } });
    loadPdfFunctions(sb, ['rememberDocPosition', 'setActiveDocument']);
    sb.setActiveDocument('left', 'd2');
    const v = sb.state.view.left;
    assert.strictEqual(v.pageNum, 1, 'page 1');
    assert.strictEqual(v.pageId, 'pg_d2_1', 'page 1 id');
    assert.strictEqual(v.scrollTop, 0, 'top of page');
});

test('4.3 STALE MEMORY: page deleted since last visit falls back to page 1', () => {
    const doc = makeDoc('d3', 10); // 10 pages only
    const sb = makePdfSandbox({
        documents: { d3: doc },
        lastPositions: { d3: { pageId: 'pg_deleted_99', pageNum: 42, scrollTop: 900 } },
    });
    loadPdfFunctions(sb, ['rememberDocPosition', 'setActiveDocument']);
    sb.setActiveDocument('left', 'd3');
    const v = sb.state.view.left;
    assert.strictEqual(v.pageNum, 1, 'falls back to page 1');
    assert.strictEqual(v.pageId, 'pg_d3_1', 'page 1 id');
    assert.strictEqual(v.scrollTop, 0, 'scroll reset');
});

test('4.4 RE-OPEN IN SAME PANE: reopening the doc already showing does not reset it', () => {
    // The old bug: doc open in left at page 7, other pane locked → clicking
    // the PDF again re-ran setActiveDocument on the SAME pane → page 1.
    const doc = makeDoc('d1');
    const sb = makePdfSandbox({
        documents: { d1: doc },
        left: { docId: 'd1', pageId: 'pg_d1_7', pageNum: 7, scrollTop: 300 },
    });
    loadPdfFunctions(sb, ['rememberDocPosition', 'setActiveDocument']);
    sb.rememberDocPosition('left');          // memory tracks the current spot
    sb.setActiveDocument('left', 'd1');      // user re-clicks the same PDF
    const v = sb.state.view.left;
    assert.strictEqual(v.pageNum, 7, 'stays on page 7');
    assert.strictEqual(v.scrollTop, 300, 'scroll preserved');
});

test('4.5 memory re-seeds from the resumed spot (stays consistent with the view)', () => {
    const doc = makeDoc('d1');
    const sb = makePdfSandbox({
        documents: { d1: doc },
        left: { docId: 'd1', pageId: 'pg_d1_7', pageNum: 7, scrollTop: 300 },
        lastPositions: { d1: { pageId: 'pg_d1_5', pageNum: 5, scrollTop: 120 } },
    });
    loadPdfFunctions(sb, ['rememberDocPosition', 'setActiveDocument']);
    sb.setActiveDocument('left', 'd1');   // resumes page 5 from memory
    const v = sb.state.view.left;
    assert.strictEqual(v.pageNum, 5, 'view resumed from memory');
    assert.strictEqual(v.scrollTop, 120, 'view scroll resumed');
    // The render hook must have re-recorded the resumed spot — memory and
    // view agree, so the NEXT reopen resumes from the same place.
    assert.deepStrictEqual(sb.state.lastPositions.d1,
        { pageId: 'pg_d1_5', pageNum: 5, scrollTop: 120 });
});

// ===============================================================
console.log('\nSuite 5 — boot restore hardening (app.js source semantics)');

test('5.1 boot ignores malformed/non-object position entries', () => {
    const restoreSrc = appSrc.slice(appSrc.indexOf('settings.lastPositions'));
    assert.ok(/typeof savedPositions === .object.|typeof savedPositions === 'object'/.test(restoreSrc) || /typeof savedPositions === .object./.test(restoreSrc),
        'guards against a corrupted settings blob');
    assert.ok(/parseInt\(p\.pageNum, 10\) \|\| 1/.test(restoreSrc), 'pageNum sanitized');
    assert.ok(/parseInt\(p\.scrollTop, 10\) \|\| 0/.test(restoreSrc), 'scrollTop sanitized');
});

test('5.2 boot drops entries for docs that no longer exist', () => {
    const restoreSrc = appSrc.slice(appSrc.indexOf('settings.lastPositions'));
    assert.ok(/state\.documents\[docId\] && p/.test(restoreSrc), 'existing-doc filter present');
});

// ===============================================================
console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

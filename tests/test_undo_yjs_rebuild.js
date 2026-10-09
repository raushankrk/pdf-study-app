/**
 * Regression tests: Undo/Redo of stroke-add survives Yjs observer rebuilds.
 *
 * Background (Bug 4):
 *   finishAnnotationStroke() captured the local stroke object (strokeRef)
 *   in the undo/redo closures and removed it by IDENTITY
 *   (arr.indexOf(strokeRef)). But the Yjs observer (_yjsOnUpdate) rebuilds
 *   pages into FRESH objects ({ ...annoData, id: annoId }) — after any
 *   rebuild, indexOf returned -1, so:
 *     - UNDO silently did nothing (stroke stayed), and
 *     - REDO pushed strokeRef again → DUPLICATE stroke with the same id.
 *
 * Fix: look up the stroke by id first (fallback to identity) in both the
 * undo splice and the redo's "already present?" check.
 *
 * These tests load the real annotations.js in a VM sandbox, draw a stroke
 * through the REAL pointer handlers, simulate the Yjs rebuild the same way
 * _yjsOnUpdate does (fresh objects, same ids), then run the captured
 * undo/redo closures and assert the state converges.
 *
 * Run with:
 *   node tests/test_undo_yjs_rebuild.js
 *
 * Exit code is 0 on success, 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const STATIC_DIR = path.join(__dirname, '..', 'static', 'js');

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
async function run(name, fn) {
    console.log(`\n${name}`);
    try { await fn(); ok(name); }
    catch (err) { fail(name, err); }
}

// ---------------------------------------------------------------
// Minimal browser stub (same shape as test_stroke_continuity.js).
// makeBrowserStub() loads the REAL annotations.js into a VM context and
// returns { state, yjs, historyCalls, sandbox }.
// ---------------------------------------------------------------
function makeBrowserStub() {
    function makeCtx() {
        return {
            globalCompositeOperation: 'source-over', globalAlpha: 1.0,
            lineWidth: 1, strokeStyle: '#000', lineCap: 'butt', lineJoin: 'miter',
            clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
            quadraticCurveTo() {}, stroke() {}, fillRect() {}, strokeRect() {},
            drawImage() {}, save() {}, restore() {}, setLineDash() {},
            fillText() {}, measureText: (s) => ({ width: (s || '').length * 6 }),
        };
    }
    const canvases = {
        left: { width: 1000, height: 1000, getContext: () => makeCtx() },
        right: { width: 1000, height: 1000, getContext: () => makeCtx() },
    };
    function makeEl(tag) {
        const el = {
            tagName: (tag || 'DIV').toUpperCase(),
            style: {}, children: [], value: '', innerText: '', innerHTML: '',
            className: '', title: '', id: '',
            classList: {
                _set: new Set(),
                add: (...c) => c.forEach(x => el.classList._set.add(x)),
                remove: (...c) => c.forEach(x => el.classList._set.delete(x)),
                toggle: (c, force) => {
                    if (force === undefined) { el.classList._set.has(c) ? el.classList._set.delete(c) : el.classList._set.add(c); }
                    else if (force) el.classList._set.add(c); else el.classList._set.delete(c);
                },
                contains: (c) => el.classList._set.has(c),
            },
            appendChild: (c) => { el.children.push(c); return c; },
            querySelector: () => null, querySelectorAll: () => [],
            addEventListener: () => {}, removeEventListener: () => {},
            setPointerCapture: () => {}, releasePointerCapture: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
            click: () => {}, focus: () => {},
        };
        return el;
    }
    const els = {
        leftAnnoCanvas: canvases.left, rightAnnoCanvas: canvases.right,
        leftCanvas: canvases.left, rightCanvas: canvases.right,
        leftWrapper: makeEl('div'), rightWrapper: makeEl('div'),
        leftViewport: makeEl('div'), rightViewport: makeEl('div'),
        leftPanel: makeEl('div'), rightPanel: makeEl('div'),
        colorPicker: makeEl('input'), thicknessPicker: makeEl('input'),
        drawingLayer: makeEl('svg'), currentPath: makeEl('path'),
        imageInput: makeEl('input'), uploadInput: makeEl('input'),
        importInput: makeEl('input'), loadingSpinner: makeEl('div'),
        snipPreview: makeEl('img'), textCreationRect: makeEl('div'),
    };
    const documentStub = {
        body: makeEl('body'),
        getElementById: (id) => { const el = makeEl('div'); el.id = id; return el; },
        createElement: (tag) => makeEl(tag),
        addEventListener: () => {}, removeEventListener: () => {},
        querySelector: () => null, querySelectorAll: () => [],
        activeElement: makeEl('body'),
    };
    const windowStub = {
        document: documentStub,
        matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
        addEventListener: () => {}, removeEventListener: () => {},
        location: { protocol: 'http:', host: 'localhost:8000', pathname: '/editor/test', href: '' },
    };
    windowStub.window = windowStub;

    const state = {
        view: {
            left: { docId: 'doc1', pageId: 'page_1', pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
            right: { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
        },
        zoomLive: { left: 1.0, right: 1.0 },
        annoTool: 'pen', annoColor: '#ef4444', annoThickness: 5,
        appMode: 'annotation', lineMode: 'freehand',
        annotations: {}, imageCache: {}, lastActiveSide: 'left',
        globalMouse: { x: 0, y: 0 },
        drawing: { active: false, pointerId: null, startSide: null, startPoint: { x: 0, y: 0 }, startPointData: null, mode: null, activeStrokeRef: null, activeStrokeTool: null },
        snip: { active: false, phase: 'idle', startSide: null, startPos: null, currentPos: null },
        selection: { active: false, side: null, mode: 'idle', marqueeStart: null, marqueeCurrent: null, selectedImages: [], selectedTextBoxes: [], selectedStrokes: [], boundingBox: null, dragStartMouse: null, dragStartPositions: null },
        links: [], activeComment: { id: null, docId: null }, chats: [], currentChatId: null,
        documents: {}, folders: {},
        toolSettings: {
            pen: { color: '#ef4444', thickness: 5 },
            highlighter: { color: '#facc15', thickness: 20 },
            eraserPixel: { thickness: 20 }, eraserStroke: { thickness: 5 },
        },
    };

    const yjsCalls = { beginInFlight: [], endInFlight: [], setAnnotation: [] };
    const yjsInFlight = new Set();
    let yjsConnected = false;
    const yjsStub = {
        yjsIsConnected: () => yjsConnected,
        yjsSetAnnotation: (docId, pageId, annoId, data) => { yjsCalls.setAnnotation.push({ docId, pageId, annoId, data }); return true; },
        yjsBeginInFlight: (annoId) => { yjsCalls.beginInFlight.push(annoId); yjsInFlight.add(annoId); },
        yjsEndInFlight: (annoId) => { yjsCalls.endInFlight.push(annoId); yjsInFlight.delete(annoId); },
        yjsClaimLock: () => {}, yjsReleaseLock: () => {}, yjsGetLock: () => null,
        yjsSetPresence: () => {}, yjsSetSelf: () => {}, yjsReplacePage: () => true, yjsClearPage: () => true,
        _calls: yjsCalls, _inFlight: yjsInFlight, _setConnected(v) { yjsConnected = v; },
    };

    let _projectId = 'test-project';
    const historyCalls = [];

    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        Date, Math, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean,
        Error, TypeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        window: windowStub, document: documentStub, state, els,
        yjsIsConnected: yjsStub.yjsIsConnected,
        yjsSetAnnotation: yjsStub.yjsSetAnnotation,
        yjsBeginInFlight: yjsStub.yjsBeginInFlight,
        yjsEndInFlight: yjsStub.yjsEndInFlight,
        yjsClaimLock: yjsStub.yjsClaimLock, yjsReleaseLock: yjsStub.yjsReleaseLock,
        yjsGetLock: yjsStub.yjsGetLock, yjsSetPresence: yjsStub.yjsSetPresence,
        yjsSetSelf: yjsStub.yjsSetSelf, yjsReplacePage: yjsStub.yjsReplacePage,
        yjsClearPage: yjsStub.yjsClearPage,
        getProjectId: () => _projectId, setProjectId: (id) => { _projectId = id; },
        saveSettings: () => {}, saveAnnotationsToDB: () => {},
        saveLinkToDB: () => Promise.resolve(), deleteLinkFromDB: () => Promise.resolve(),
        renderAnnotations: () => {}, renderTextLayer: () => {}, renderMarkersForView: () => {},
        renderPage: () => Promise.resolve(), renderDocList: () => {},
        renderChatList: () => {}, renderChatMessages: () => {},
        updateZoomIndicator: () => {}, updateViewportActiveVisuals: () => {},
        updateLockVisuals: () => {}, updateThicknessPreview: () => {},
        escapeHtml: (s) => String(s || ''), showModal: () => {},
        debounce: (fn) => fn,
        pushHistoryAction: (label, undo, redo) => { historyCalls.push({ label, undo, redo }); },
        intOr: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
        createNewChat: () => Promise.resolve(),
        performViewportSearch: () => {},
        marked: { Renderer: function () { this.code = () => ''; }, setOptions: () => {}, parse: (s) => String(s || '') },
        hljs: { getLanguage: () => null, highlight: () => ({ value: '' }), highlightAuto: () => ({ value: '' }) },
        ROOT_FOLDER_ID: 'root', MAX_RECENT_DOCS: 10,
        editorHistory: { stack: [], pointer: 0, maxLen: 200 },
        conflictState: { projectRevision: 0, projectRevisionLoadedAt: 0, annotationRevisions: {}, syncWebSocket: null, syncWebSocketConnected: false, isRefreshing: false, refreshDebounceTimer: null },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    const code = fs.readFileSync(path.join(STATIC_DIR, 'annotations.js'), 'utf8');
    vm.runInContext(code, sandbox, { filename: 'annotations.js' });

    return { state, yjs: yjsStub, historyCalls, sandbox };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const DOC = 'doc1';
const PAGE = 'page_1';

/** Draw one pen stroke through the REAL handlers, Yjs connected. */
function drawStroke(stub) {
    stub.yjs._setConnected(true);
    vm.runInContext(`startAnnotationStroke('left', 0.10, 0.10)`, stub.sandbox);
    vm.runInContext(`continueAnnotationStroke('left', 0.14, 0.16)`, stub.sandbox);
    vm.runInContext(`continueAnnotationStroke('left', 0.20, 0.22)`, stub.sandbox);
    vm.runInContext(`finishAnnotationStroke('left')`, stub.sandbox);
}

/** Simulate _yjsOnUpdate's page rebuild: fresh objects, SAME ids. */
function simulateYjsRebuild(stub) {
    const page = stub.state.annotations[DOC] && stub.state.annotations[DOC][PAGE];
    if (!page) return;
    const cloneAll = (arr) => (arr || []).map(a => JSON.parse(JSON.stringify(a)));
    stub.state.annotations[DOC][PAGE] = {
        strokes: cloneAll(page.strokes),
        images: cloneAll(page.images),
        textBoxes: cloneAll(page.textBoxes),
    };
}

function strokeCount(stub) {
    const page = stub.state.annotations[DOC] && stub.state.annotations[DOC][PAGE];
    return page ? (page.strokes || []).length : 0;
}

// ---------------------------------------------------------------
// Suites
// ---------------------------------------------------------------
async function suite1() {
    console.log('\n=== Suite 1 — stroke-add undo/redo survives Yjs rebuild ===');

    await run('1.1 UNDO removes the stroke even after a Yjs rebuild changed its identity', async () => {
        const stub = makeBrowserStub();
        drawStroke(stub);
        assert.strictEqual(strokeCount(stub), 1, 'stroke exists after draw');
        assert.strictEqual(stub.historyCalls.length, 1, 'history entry pushed');
        assert.match(stub.historyCalls[0].label, /pen add \(left\)/);

        // The Yjs echo rebuilds the page: fresh object, same id.
        const strokeId = stub.state.annotations[DOC][PAGE].strokes[0].id;
        simulateYjsRebuild(stub);
        assert.ok(strokeId, 'stroke has an id');

        // Run the captured UNDO closure.
        stub.historyCalls[0].undo();
        assert.strictEqual(strokeCount(stub), 0, 'undo removed the rebuilt stroke (by id)');
        const lastSet = stub.yjs._calls.setAnnotation[stub.yjs._calls.setAnnotation.length - 1];
        assert.strictEqual(lastSet.annoId, strokeId, 'yjs told to delete the stroke id');
        assert.strictEqual(lastSet.data, null, 'yjs delete payload is null');
    });

    await run('1.2 undo/redo cycles after rebuilds never duplicate stroke ids', async () => {
        const stub = makeBrowserStub();
        drawStroke(stub);
        const entry = stub.historyCalls[0];

        entry.undo();
        assert.strictEqual(strokeCount(stub), 0, 'plain undo works');
        entry.redo();
        assert.strictEqual(strokeCount(stub), 1, 'plain redo works');

        // Rebuild (fresh identity) → undo by id → redo → still one stroke.
        simulateYjsRebuild(stub);
        entry.undo();
        assert.strictEqual(strokeCount(stub), 0, 'undo by id works after rebuild');
        entry.redo();
        assert.strictEqual(strokeCount(stub), 1, 'redo works after rebuild');
        const ids = stub.state.annotations[DOC][PAGE].strokes.map(s => s.id);
        assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate stroke ids');
    });

    await run('1.3 REDO does not duplicate when a rebuilt copy (same id) is already present', async () => {
        const stub = makeBrowserStub();
        drawStroke(stub);
        const entry = stub.historyCalls[0];

        // Simulate the EXACT old-bug scenario: rebuild replaces identity,
        // undo's old identity-based splice missed, stroke still present.
        simulateYjsRebuild(stub);
        entry.redo();
        assert.strictEqual(strokeCount(stub), 1,
            'redo must recognize the rebuilt copy as already-present (id fallback)');
        const ids = stub.state.annotations[DOC][PAGE].strokes.map(s => s.id);
        assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate stroke ids');
    });

    await run('1.4 UNDO without any rebuild still works (identity path preserved)', async () => {
        const stub = makeBrowserStub();
        drawStroke(stub);
        stub.historyCalls[0].undo();
        assert.strictEqual(strokeCount(stub), 0, 'plain undo still removes the stroke');
    });

    await run('1.5 UNDO works when Yjs is NOT connected (pure local mode)', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(false);
        vm.runInContext(`startAnnotationStroke('left', 0.10, 0.10)`, stub.sandbox);
        vm.runInContext(`continueAnnotationStroke('left', 0.14, 0.16)`, stub.sandbox);
        vm.runInContext(`finishAnnotationStroke('left')`, stub.sandbox);
        simulateYjsRebuild(stub); // even so, id fallback must work
        stub.historyCalls[0].undo();
        assert.strictEqual(strokeCount(stub), 0, 'undo works in local-only mode');
    });
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
(async () => {
    await suite1();

    console.log('\n' + '='.repeat(60));
    console.log(`TOTAL: ${passCount + failCount}  |  PASS: ${passCount}  |  FAIL: ${failCount}`);
    if (failCount > 0) {
        console.log('\nFailed tests:');
        failures.forEach(f => console.log(`  - ${f.name}`));
        process.exit(1);
    }
    console.log('All undo/Yjs-rebuild tests passed.');
    process.exit(0);
})();

/**
 * Regression tests for the "new stroke connects to the previous stroke" bug.
 *
 * Symptom (see Recording.gif): when drawing with the pen/highlighter, a new
 * stroke sometimes starts at the END POINT of the previous stroke — a straight
 * connecting segment is drawn between them. Most visible on touch devices
 * (iPad / Android tablets) when the user lifts the pen, pauses or pans/zooms
 * between strokes. Appeared after the Yjs collaboration layer was added.
 *
 * Root cause:
 *   continueAnnotationStroke() (and the straight-line preview) located the
 *   active stroke POSITIONALLY — strokes[strokes.length - 1] — instead of
 *   using the reference recorded at pointerdown (state.drawing.activeStrokeRef).
 *   Several async paths wholesale-replace state.annotations[docId] (or the
 *   page object) mid-stroke:
 *     - loadAnnotationsFromServer() via smartRefreshFromServer(), triggered by
 *       revision_changed broadcasts (including the SELF-ECHO of our own
 *       settings saves — realtime_sync.py broadcasts to ALL connections).
 *     - the conflict-modal reload path (database.js).
 *     - Yjs page rebuilds (in-flight-safe, but replace the array).
 *   When a replacement landed between pointerdown and a pointermove, the
 *   positional lookup silently returned the PREVIOUS stroke, and every
 *   subsequent point of the new stroke was appended INTO it.
 *
 * Fix under test:
 *   1. resolveActiveStroke() — reference-stable active stroke with re-link
 *      (annotations.js) used by continueAnnotationStroke and the
 *      straight-line preview/lock-in (events.js).
 *   2. _preserveInFlightStrokeInLoadedState() — loadAnnotationsFromServer
 *      re-attaches the in-progress stroke after the replacement
 *      (database.js).
 *   3. smartRefreshFromServer() skips the stale REST annotation reload for
 *      Yjs-connected docs (conflict.js).
 *   4. _cancelDrawingAndCleanStroke() removes the active stroke by identity,
 *      ends the Yjs in-flight marker and deletes it from the Yjs room
 *      (events.js).
 *   5. handlePointerCancel() — pointercancel no longer leaks drawing state
 *      (events.js + app.js registration).
 *
 * Run with:
 *   node tests/test_stroke_continuity.js
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

/**
 * Cross-realm-safe structural equality: objects created inside the VM have a
 * different Object.prototype, so assert.deepStrictEqual fails with "Values
 * have same structure but are not reference-equal". A JSON round-trip
 * normalizes everything into this realm first.
 */
function json(x) { return JSON.parse(JSON.stringify(x)); }
function deq(actual, expected, msg) {
    assert.deepStrictEqual(json(actual), expected, msg);
}

// ---------------------------------------------------------------
// Minimal browser stub (modeled on tests/test_frontend_bugs.js).
// ---------------------------------------------------------------
function makeBrowserStub() {
    function makeCtx() {
        return {
            globalCompositeOperation: 'source-over',
            globalAlpha: 1.0,
            lineWidth: 1,
            strokeStyle: '#000',
            lineCap: 'butt',
            lineJoin: 'miter',
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
                    if (force === undefined) {
                        if (el.classList._set.has(c)) el.classList._set.delete(c);
                        else el.classList._set.add(c);
                    } else if (force) el.classList._set.add(c);
                    else el.classList._set.delete(c);
                },
                contains: (c) => el.classList._set.has(c),
            },
            appendChild: (c) => { el.children.push(c); return c; },
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            setPointerCapture: () => {},
            releasePointerCapture: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
            click: () => {}, focus: () => {},
        };
        return el;
    }

    const els = {
        leftAnnoCanvas: canvases.left,
        rightAnnoCanvas: canvases.right,
        leftCanvas: canvases.left,
        rightCanvas: canvases.right,
        leftWrapper: makeEl('div'),
        rightWrapper: makeEl('div'),
        leftViewport: makeEl('div'),
        rightViewport: makeEl('div'),
        leftPanel: makeEl('div'),
        rightPanel: makeEl('div'),
        colorPicker: makeEl('input'),
        thicknessPicker: makeEl('input'),
        drawingLayer: makeEl('svg'),
        currentPath: makeEl('path'),
        imageInput: makeEl('input'),
        uploadInput: makeEl('input'),
        importInput: makeEl('input'),
        loadingSpinner: makeEl('div'),
        snipPreview: makeEl('img'),
        textCreationRect: makeEl('div'),
    };

    const documentStub = {
        body: makeEl('body'),
        getElementById: (id) => {
            const el = makeEl('div');
            el.id = id;
            return el;
        },
        createElement: (tag) => makeEl(tag),
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: makeEl('body'),
    };

    const registeredListeners = {};
    const windowStub = {
        document: documentStub,
        matchMedia: (q) => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
        addEventListener: (type, fn) => {
            registeredListeners[type] = (registeredListeners[type] || []).concat(fn);
        },
        removeEventListener: () => {},
        location: { protocol: 'http:', host: 'localhost:8000', pathname: '/editor/test', href: '' },
    };
    windowStub.window = windowStub;

    const state = {
        view: {
            left: { docId: 'doc1', pageId: 'page_1', pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
            right: { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
        },
        zoomLive: { left: 1.0, right: 1.0 },
        annoTool: 'pen',
        annoColor: '#ef4444',
        annoThickness: 5,
        appMode: 'annotation',
        lineMode: 'freehand',
        annotations: {},
        imageCache: {},
        lastActiveSide: 'left',
        globalMouse: { x: 0, y: 0 },
        drawing: { active: false, pointerId: null, startSide: null, startPoint: { x: 0, y: 0 }, startPointData: null, mode: null, activeStrokeRef: null, activeStrokeTool: null },
        snip: { active: false, phase: 'idle', startSide: null, startPos: null, currentPos: null },
        selection: {
            active: false, side: null, mode: 'idle',
            marqueeStart: null, marqueeCurrent: null,
            selectedImages: [], selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: null, dragStartMouse: null, dragStartPositions: null,
        },
        links: [],
        activeComment: { id: null, docId: null },
        chats: [],
        currentChatId: null,
        documents: {},
        folders: {},
        toolSettings: {
            pen: { color: '#ef4444', thickness: 5 },
            highlighter: { color: '#facc15', thickness: 20 },
            eraserPixel: { thickness: 20 },
            eraserStroke: { thickness: 5 },
        },
    };

    // ---- Yjs stub.
    const yjsCalls = { beginInFlight: [], endInFlight: [], setAnnotation: [], claimLock: [], releaseLock: [] };
    const yjsInFlight = new Set();
    let yjsConnected = false;
    const yjsStub = {
        yjsIsConnected: () => yjsConnected,
        yjsSetAnnotation: (docId, pageId, annoId, data) => { yjsCalls.setAnnotation.push({ docId, pageId, annoId, data }); return true; },
        yjsBeginInFlight: (annoId) => { yjsCalls.beginInFlight.push(annoId); yjsInFlight.add(annoId); },
        yjsEndInFlight: (annoId) => { yjsCalls.endInFlight.push(annoId); yjsInFlight.delete(annoId); },
        yjsClaimLock: (annoId, kind) => { yjsCalls.claimLock.push({ annoId, kind }); },
        yjsReleaseLock: (annoId) => { yjsCalls.releaseLock.push(annoId); },
        yjsGetLock: () => null,
        yjsSetPresence: () => {},
        yjsSetSelf: () => {},
        yjsReplacePage: () => true,
        yjsClearPage: () => true,
        _calls: yjsCalls,
        _inFlight: yjsInFlight,
        _setConnected(v) { yjsConnected = v; },
    };

    let _projectId = 'test-project';
    const projectIdStub = {
        getProjectId: () => _projectId,
        setProjectId: (id) => { _projectId = id; },
    };

    // ---- Api stub (records calls; configurable per test).
    const apiCalls = { getAnnotations: [], saveAllAnnotations: [] };
    const apiStub = {
        _calls: apiCalls,
        _annotationsResponse: {},
        _getAnnotationsError: null,
        async getAnnotations(docId) {
            apiCalls.getAnnotations.push(docId);
            if (apiStub._getAnnotationsError) throw apiStub._getAnnotationsError;
            return apiStub._annotationsResponse;
        },
        async saveAllAnnotations(docId, pages) {
            apiCalls.saveAllAnnotations.push({ docId, pages });
            return { status: 'ok' };
        },
        async health() { return true; },
        async listDocuments() { return []; },
        async listFolders() { return []; },
        async listLinks() { return []; },
        async listChats() { return []; },
        async getProject() { return { revision: 0 }; },
        async getSettings() { return {}; },
        async saveSettings() { return {}; },
        async createLink() { return {}; },
        async deleteLink() { return {}; },
    };

    const historyCalls = [];

    return {
        canvases, els, document: documentStub, window: windowStub,
        state, yjs: yjsStub, projectId: projectIdStub, api: apiStub,
        registeredListeners, historyCalls,
    };
}

/**
 * Load JS files in a sandboxed VM context sharing one global scope.
 */
function loadJsFiles(filePaths, stub) {
    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
        Date, Math, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean,
        Error, TypeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        window: stub.window,
        document: stub.document,
        state: stub.state,
        els: stub.els,
        Api: stub.api,
        yjsIsConnected: stub.yjs.yjsIsConnected,
        yjsSetAnnotation: stub.yjs.yjsSetAnnotation,
        yjsBeginInFlight: stub.yjs.yjsBeginInFlight,
        yjsEndInFlight: stub.yjs.yjsEndInFlight,
        yjsClaimLock: stub.yjs.yjsClaimLock,
        yjsReleaseLock: stub.yjs.yjsReleaseLock,
        yjsGetLock: stub.yjs.yjsGetLock,
        yjsSetPresence: stub.yjs.yjsSetPresence,
        yjsSetSelf: stub.yjs.yjsSetSelf,
        yjsReplacePage: stub.yjs.yjsReplacePage,
        yjsClearPage: stub.yjs.yjsClearPage,
        getProjectId: stub.projectId.getProjectId,
        setProjectId: stub.projectId.setProjectId,
        saveSettings: () => {},
        saveAnnotationsToDB: () => {},
        saveLinkToDB: () => Promise.resolve(),
        deleteLinkFromDB: () => Promise.resolve(),
        renderAnnotations: () => {},
        renderTextLayer: () => {},
        renderMarkersForView: () => {},
        renderPage: () => Promise.resolve(),
        renderDocList: () => {},
        renderChatList: () => {},
        renderChatMessages: () => {},
        updateZoomIndicator: () => {},
        updateViewportActiveVisuals: () => {},
        updateLockVisuals: () => {},
        updateThicknessPreview: () => {},
        escapeHtml: (s) => String(s || ''),
        showModal: () => {},
        debounce: (fn) => fn,
        pushHistoryAction: (label, undo, redo) => { stub.historyCalls.push({ label, undo, redo }); },
        intOr: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
        createNewChat: () => Promise.resolve(),
        performViewportSearch: () => {},
        // CDN stubs needed by app.js init (configureMarked in annotations.js).
        marked: {
            Renderer: function () { this.code = () => ''; },
            setOptions: () => {},
            parse: (s) => String(s || ''),
        },
        hljs: {
            getLanguage: () => null,
            highlight: () => ({ value: '' }),
            highlightAuto: () => ({ value: '' }),
        },
        ROOT_FOLDER_ID: 'root',
        MAX_RECENT_DOCS: 10,
        editorHistory: { stack: [], pointer: 0, maxLen: 200 },
        conflictState: {
            projectRevision: 0, projectRevisionLoadedAt: 0,
            annotationRevisions: {},
            syncWebSocket: null, syncWebSocketConnected: false,
            isRefreshing: false, refreshDebounceTimer: null,
        },
    };
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    for (const fp of filePaths) {
        const code = fs.readFileSync(fp, 'utf8');
        vm.runInContext(code, sandbox, { filename: fp });
    }
    return sandbox;
}

// ---------------------------------------------------------------
// Helpers shared by the suites.
// ---------------------------------------------------------------
const DOC = 'doc1';
const PAGE = 'page_1';

/** Simulate the smartRefresh-style wholesale replacement that used to
 *  corrupt the in-progress stroke. `staleStrokes` becomes the new page
 *  state (the active stroke is NOT part of it unless included). */
function wholesaleReplace(sandbox, staleStrokes) {
    sandbox.state.annotations[DOC] = {
        [PAGE]: { strokes: staleStrokes, images: [], textBoxes: [] }
    };
}

function makePrevStroke(id) {
    return { id: id || 'stroke_prev', type: 'stroke', tool: 'pen', color: '#ef4444', size: 0.005, points: [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }] };
}

async function run(name, fn) {
    console.log(`\n${name}`);
    try {
        await fn();
    } catch (err) {
        fail(name, err);
        return;
    }
    ok(name);
}

// ---------------------------------------------------------------
// Suite 1 — continueAnnotationStroke is reference-stable (annotations.js).
// ---------------------------------------------------------------
async function suite1() {
    console.log('\n=== Suite 1 — Active stroke is tracked by reference, not position ===');

    await run('1.1 continueAnnotationStroke appends into the stroke created by startAnnotationStroke', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;
        assert(ref, 'activeStrokeRef must be set');
        sb.continueAnnotationStroke('left', 0.20, 0.20);
        sb.continueAnnotationStroke('left', 0.30, 0.30);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.strictEqual(strokes.length, 1, 'one stroke in state');
        assert.strictEqual(strokes[0], ref, 'state holds the ref object (identity)');
        deq(ref.points, [{ x: 0.10, y: 0.10 }, { x: 0.20, y: 0.20 }, { x: 0.30, y: 0.30 }]);
    });

    await run('1.2 REGRESSION: mid-stroke wholesale replacement does not merge new points into the previous stroke', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        // Previous stroke (already finished).
        const prev = makePrevStroke('stroke_S1');
        sb.state.annotations[DOC][PAGE].strokes.push(prev);

        // Stroke 2 starts (pointerdown).
        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.50, 0.50);
        const ref = sb.state.drawing.activeStrokeRef;

        // --- The async replacement lands (e.g. smartRefreshFromServer) ---
        // Stale snapshot: contains the previous stroke (LAST) but NOT the
        // in-progress stroke 2.
        wholesaleReplace(sb, [makePrevStroke('stroke_S1')]);

        // Pointermove for stroke 2 — with the OLD code this appended into
        // strokes[len-1] === the previous stroke (the connecting-line bug).
        sb.continueAnnotationStroke('left', 0.55, 0.55);
        sb.continueAnnotationStroke('left', 0.60, 0.60);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        deq(strokes[0].points, [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }],
            'previous stroke points must NOT receive the new stroke points');
        assert.ok(strokes.includes(ref), 'active stroke re-linked into the replaced array');
        deq(ref.points, [{ x: 0.50, y: 0.50 }, { x: 0.55, y: 0.55 }, { x: 0.60, y: 0.60 }],
            'active stroke holds exactly its own points');
    });

    await run('1.3 new stroke after lift/pause never inherits points from the previous stroke', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        // --- Stroke 1: down → move → up (lift) ---
        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.10, 0.10);
        sb.continueAnnotationStroke('left', 0.15, 0.15);
        const stroke1 = sb.state.drawing.activeStrokeRef;
        const stroke1PointsSnapshot = json(stroke1.points);
        sb.finishAnnotationStroke('left');
        sb.state.drawing.active = false;
        assert.strictEqual(sb.state.drawing.activeStrokeRef, null, 'ref cleared on finish');

        // --- Pause; an async replacement happens between strokes ---
        wholesaleReplace(sb, sb.state.annotations[DOC][PAGE].strokes.map(s => JSON.parse(JSON.stringify(s))));

        // --- Stroke 2: down → move → move (touch drawing) ---
        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.70, 0.70);
        const stroke2 = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.75, 0.75);
        sb.continueAnnotationStroke('left', 0.80, 0.80);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.notStrictEqual(stroke1, stroke2, 'strokes are distinct objects');
        assert.notStrictEqual(stroke1.id, stroke2.id, 'strokes have distinct ids');
        deq(stroke1.points, stroke1PointsSnapshot, 'stroke 1 points unchanged');
        deq(stroke2.points, [{ x: 0.70, y: 0.70 }, { x: 0.75, y: 0.75 }, { x: 0.80, y: 0.80 }],
            'stroke 2 contains ONLY its own points — nothing inherited from stroke 1');
        assert.ok(!stroke2.points.some(p => p.x === 0.15 && p.y === 0.15),
            'stroke 2 does not start at stroke 1 end point (no connecting segment)');
        // After the clone-replacement, stroke 1 is present by ID (identity is
        // legitimately replaced by a rebuild; the DATA must survive).
        const strokesById = new Set(strokes.map(s => s.id));
        assert.ok(strokesById.has(stroke1.id) && strokesById.has(stroke2.id),
            'both strokes present in state (by id)');
        const stroke1InState = strokes.find(s => s.id === stroke1.id);
        deq(stroke1InState.points, stroke1PointsSnapshot, 'stroke 1 data survived the replacement intact');
    });

    await run('1.4 replacement carrying a stale clone of the active stroke canonicalizes back to the live object', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.20, 0.20); // live: 2 points

        // Replacement snapshot: an OLDER clone of the SAME stroke id plus
        // the previous stroke.
        const staleClone = { id: ref.id, type: 'stroke', tool: 'pen', color: '#ef4444', size: 0.005, points: [{ x: 0.10, y: 0.10 }] };
        wholesaleReplace(sb, [makePrevStroke(), staleClone]);

        sb.continueAnnotationStroke('left', 0.30, 0.30);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.strictEqual(strokes[1], ref, 'live object canonicalized into the array');
        deq(ref.points, [{ x: 0.10, y: 0.10 }, { x: 0.20, y: 0.20 }, { x: 0.30, y: 0.30 }],
            'live points preserved (not clobbered by the stale clone)');
        deq(strokes[0].points, [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }], 'previous stroke untouched');
    });

    await run('1.5 repeated replacements during one stroke keep the stroke isolated', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.40, 0.40);
        const ref = sb.state.drawing.activeStrokeRef;

        wholesaleReplace(sb, [makePrevStroke()]);
        sb.continueAnnotationStroke('left', 0.45, 0.45);
        wholesaleReplace(sb, [makePrevStroke()]);
        sb.continueAnnotationStroke('left', 0.50, 0.50);
        wholesaleReplace(sb, [makePrevStroke()]);
        sb.continueAnnotationStroke('left', 0.55, 0.55);

        deq(ref.points, [{ x: 0.40, y: 0.40 }, { x: 0.45, y: 0.45 }, { x: 0.50, y: 0.50 }, { x: 0.55, y: 0.55 }]);
        deq(sb.state.annotations[DOC][PAGE].strokes[0].points, [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }]);
    });
}

// ---------------------------------------------------------------
// Suite 2 — straight-line mode also uses the reference-stable stroke.
// ---------------------------------------------------------------
async function suite2() {
    console.log('\n=== Suite 2 — Straight-line preview/lock-in use the active stroke reference ===');

    function makeStraightLineSandbox() {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };
        sb.state.lineMode = 'straight';
        sb.state.appMode = 'annotation';
        sb.state.annoTool = 'pen';
        // Previous stroke — the OLD positional code would overwrite THIS one.
        const prev = makePrevStroke();
        sb.state.annotations[DOC][PAGE].strokes.push(prev);
        return { stub, sb, prev };
    }

    await run('2.1 straight-line preview writes into the active stroke, not strokes[len-1] (even after a mid-stroke replacement)', async () => {
        const { sb, prev } = makeStraightLineSandbox();

        // pointerdown equivalent.
        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 7;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.30, 0.30);
        sb.state.drawing.straightLineStart = { x: 0.30, y: 0.30 };
        const ref = sb.state.drawing.activeStrokeRef;

        // Mid-stroke replacement drops the active stroke.
        wholesaleReplace(sb, [makePrevStroke()]);

        // pointermove with a touch-style event.
        sb.handlePointerMove({ pointerId: 7, clientX: 600, clientY: 400, target: { closest: () => null } });

        deq(prev.points, [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }],
            'previous stroke points must NOT be overwritten by the preview');
        deq(ref.points, [{ x: 0.30, y: 0.30 }, { x: 0.60, y: 0.40 }],
            'preview written into the active stroke');
    });

    await run('2.2 pointerup straight-line lock-in finalizes the active stroke (not the previous one)', async () => {
        const { sb, prev } = makeStraightLineSandbox();

        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 7;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.30, 0.30);
        sb.state.drawing.straightLineStart = { x: 0.30, y: 0.30 };
        const ref = sb.state.drawing.activeStrokeRef;

        wholesaleReplace(sb, [makePrevStroke()]);

        sb.handlePointerUp({ pointerId: 7, clientX: 800, clientY: 500, target: { closest: () => null, releasePointerCapture: () => {} } });

        deq(prev.points, [{ x: 0.01, y: 0.01 }, { x: 0.02, y: 0.02 }],
            'previous stroke untouched by the lock-in');
        deq(ref.points, [{ x: 0.30, y: 0.30 }, { x: 0.80, y: 0.50 }],
            'lock-in written into the active stroke');
    });
}

// ---------------------------------------------------------------
// Suite 3 — _cancelDrawingAndCleanStroke (two-finger takeover cleanup).
// ---------------------------------------------------------------
async function suite3() {
    console.log('\n=== Suite 3 — Two-finger takeover cleanup is identity-based and complete ===');

    await run('3.1 removes the ACTIVE stroke by identity (not positional pop) and deletes it from Yjs', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        // A previous 2-point stroke (tiny!) that the OLD code would pop.
        const prev = makePrevStroke();
        sb.state.annotations[DOC][PAGE].strokes.push(prev);

        // Active stroke, 2 points, NOT last (simulates post-replacement order).
        sb.state.drawing.active = true;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.50, 0.50);
        const ref = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.52, 0.52);
        sb.state.annotations[DOC][PAGE].strokes.push(prev); // prev is ALSO last again

        sb._cancelDrawingAndCleanStroke();

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.ok(!strokes.includes(ref), 'active stroke removed');
        assert.ok(strokes.includes(prev), 'previous stroke NOT removed (identity-based, not positional)');
        assert.strictEqual(sb.state.drawing.activeStrokeRef, null, 'activeStrokeRef cleared');
        assert.strictEqual(sb.state.drawing.active, false, 'drawing.active cleared');
        assert.ok(!stub.yjs._inFlight.has(ref.id), 'Yjs in-flight marker ended');
        assert.ok(stub.yjs._calls.setAnnotation.some(c => c.annoId === ref.id && c.data === null),
            'stroke deleted from the Yjs room (no ghost resurrection)');
    });

    await run('3.2 a long in-progress stroke is KEPT, but state is fully cleaned and in-flight ended', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;
        for (let i = 1; i <= 6; i++) sb.continueAnnotationStroke('left', 0.10 + i * 0.05, 0.20);

        sb._cancelDrawingAndCleanStroke();

        assert.ok(sb.state.annotations[DOC][PAGE].strokes.includes(ref), 'long stroke kept (real work)');
        assert.strictEqual(sb.state.drawing.active, false, 'drawing.active cleared');
        assert.strictEqual(sb.state.drawing.activeStrokeRef, null, 'activeStrokeRef cleared');
        assert.ok(!stub.yjs._inFlight.has(ref.id), 'in-flight marker ended (no leak)');
    });

    await run('3.3 after a replacement dropped the active stroke, cleanup still ends the in-flight marker and deletes the ghost from Yjs', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.50, 0.50);
        const ref = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.52, 0.52);

        // Replacement drops the active stroke entirely.
        wholesaleReplace(sb, []);

        sb._cancelDrawingAndCleanStroke();

        assert.strictEqual(sb.state.drawing.active, false, 'drawing.active cleared');
        assert.strictEqual(sb.state.drawing.activeStrokeRef, null, 'activeStrokeRef cleared');
        assert.ok(!stub.yjs._inFlight.has(ref.id), 'in-flight marker ended');
        assert.ok(stub.yjs._calls.setAnnotation.some(c => c.annoId === ref.id && c.data === null),
            'partial stroke deleted from Yjs (would otherwise resurrect)');
    });
}

// ---------------------------------------------------------------
// Suite 4 — handlePointerCancel (pointercancel on touch devices).
// ---------------------------------------------------------------
async function suite4() {
    console.log('\n=== Suite 4 — pointercancel finalizes the gesture instead of leaking state ===');

    await run('4.1 pointercancel mid-stroke (long stroke) finalizes it: kept, undo entry, final Yjs push, in-flight ended', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 11;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;
        for (let i = 1; i <= 5; i++) sb.continueAnnotationStroke('left', 0.10 + i * 0.05, 0.30);
        stub.yjs._calls.setAnnotation.length = 0;
        stub.yjs._calls.endInFlight.length = 0;
        const historyCountBefore = stub.historyCalls.length;

        sb.handlePointerCancel({ pointerId: 11 });

        assert.strictEqual(sb.state.drawing.active, false, 'gesture closed');
        assert.ok(!stub.yjs._inFlight.has(ref.id), 'in-flight ended');
        assert.ok(stub.yjs._calls.endInFlight.includes(ref.id), 'yjsEndInFlight called for the stroke');
        const finalPush = stub.yjs._calls.setAnnotation.filter(c => c.annoId === ref.id).pop();
        assert.ok(finalPush && finalPush.data && finalPush.data.points.length === 6,
            'final complete stroke pushed to Yjs');
        assert.ok(stub.historyCalls.length > historyCountBefore, 'undo history entry created');
        assert.ok(sb.state.annotations[DOC][PAGE].strokes.includes(ref), 'partial stroke kept in state');
    });

    await run('4.2 pointercancel with a tiny (≤3 point) accidental stroke cancels and removes it', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 12;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.40, 0.40);
        const ref = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.41, 0.41);

        sb.handlePointerCancel({ pointerId: 12 });

        assert.ok(!sb.state.annotations[DOC][PAGE].strokes.includes(ref), 'tiny accidental stroke removed');
        assert.strictEqual(sb.state.drawing.active, false, 'gesture closed');
        assert.strictEqual(sb.state.drawing.activeStrokeRef, null, 'ref cleared');
    });

    await run('4.3 pointercancel for a DIFFERENT pointerId is ignored (mirrors move/up guards)', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 21;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;

        sb.handlePointerCancel({ pointerId: 99 }); // palm / second finger

        assert.strictEqual(sb.state.drawing.active, true, 'gesture NOT closed by a foreign pointer');
        assert.ok(sb.state.annotations[DOC][PAGE].strokes.includes(ref), 'stroke untouched');
    });

    await run('4.4 pointercancel during a select-tool drag releases locks, ends in-flight and idles the selection', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        const stk = makePrevStroke('stroke_sel');
        sb.state.annotations[DOC][PAGE].strokes.push(stk);
        sb.state.annoTool = 'select';
        sb.state.selection = {
            active: true, side: 'left', mode: 'dragging',
            selectedImages: [], selectedTextBoxes: [], selectedStrokes: [stk],
            boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, dragStartMouse: { x: 0.1, y: 0.1 },
        };
        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 31;
        sb.state.drawing.startSide = 'left';
        sb.yjsClaimLock('stroke_sel', 'move');
        sb.yjsBeginInFlight('stroke_sel');

        sb.handlePointerCancel({ pointerId: 31 });

        assert.strictEqual(sb.state.selection.mode, 'idle', 'selection mode reset');
        assert.strictEqual(sb.state.drawing.active, false, 'gesture closed');
        assert.ok(!stub.yjs._inFlight.has('stroke_sel'), 'in-flight ended');
        assert.ok(stub.yjs._calls.releaseLock.includes('stroke_sel'), 'lock released');
    });

    await run('4.5 app.js registers the pointercancel listener on window', async () => {
        // app.js init() pulls in functions from many modules (pdf.js,
        // database.js, ...), so instead of executing it we verify the wiring:
        //   (a) app.js source registers 'pointercancel' on window, and
        //   (b) events.js exposes handlePointerCancel as the global handler.
        const appSrc = fs.readFileSync(path.join(STATIC_DIR, 'app.js'), 'utf8');
        assert.ok(/window\.addEventListener\(\s*['"]pointercancel['"]\s*,\s*handlePointerCancel/.test(appSrc),
            "app.js must register window 'pointercancel' → handlePointerCancel");

        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        assert.strictEqual(typeof sb.handlePointerCancel, 'function',
            'handlePointerCancel must be a global (events.js)');
        // Smoke: it is a no-op when no gesture is active.
        sb.handlePointerCancel({ pointerId: 1 });
        assert.strictEqual(sb.state.drawing.active, false);
    });
}

// ---------------------------------------------------------------
// Suite 5 — loadAnnotationsFromServer preserves the in-progress stroke.
// ---------------------------------------------------------------
async function suite5() {
    console.log('\n=== Suite 5 — REST load/refresh preserves the stroke being drawn ===');

    await run('5.1 smartRefresh-style reload keeps the in-progress stroke in the replaced state', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'database.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        // Stroke being drawn right now.
        sb.state.drawing.active = true;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.50, 0.50);
        const ref = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.55, 0.55);

        // Stale server snapshot: only the previous stroke, no active stroke.
        stub.api._annotationsResponse = {
            pages: { [PAGE]: { strokes: [makePrevStroke('stroke_S1')], images: [], textBoxes: [] } },
            revisions: {},
        };

        await sb.loadAnnotationsFromServer(DOC);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.ok(strokes.includes(ref), 'in-progress stroke re-attached to the replaced state');
        assert.strictEqual(strokes[strokes.length - 1], ref, 'active stroke is last again');
        deq(ref.points, [{ x: 0.50, y: 0.50 }, { x: 0.55, y: 0.55 }]);
    });

    await run('5.2 fetch error path also preserves the in-progress stroke', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'database.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.state.drawing.startSide = 'left';
        sb.startAnnotationStroke('left', 0.50, 0.50);
        const ref = sb.state.drawing.activeStrokeRef;

        stub.api._getAnnotationsError = new Error('network down');
        await sb.loadAnnotationsFromServer(DOC);

        const strokes = sb.state.annotations[DOC][PAGE].strokes;
        assert.ok(Array.isArray(strokes) && strokes.includes(ref),
            'in-progress stroke preserved even when the fetch fails');
    });

    await run('5.3 with no active drawing, the reload behaves exactly as before', async () => {
        const stub = makeBrowserStub();
        const sb = loadJsFiles([path.join(STATIC_DIR, 'database.js')], stub);
        stub.api._annotationsResponse = {
            pages: { [PAGE]: { strokes: [{ id: 'a', points: [] }], images: [], textBoxes: [] } },
            revisions: { [PAGE]: 3 },
        };
        await sb.loadAnnotationsFromServer(DOC);
        deq(sb.state.annotations[DOC][PAGE].strokes.map(s => s.id), ['a']);
        assert.strictEqual(sb.conflictState.annotationRevisions[DOC][PAGE], 3, 'revision bookkeeping intact');
    });
}

// ---------------------------------------------------------------
// Suite 6 — smartRefreshFromServer stops clobbering Yjs-connected docs.
// ---------------------------------------------------------------
async function suite6() {
    console.log('\n=== Suite 6 — smartRefreshFromServer skips stale REST annotations for Yjs-connected docs ===');

    await run('6.1 Yjs-connected doc: annotation reload skipped, in-memory state untouched, other refreshes still run', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'database.js'), path.join(STATIC_DIR, 'conflict.js')], stub);
        sb.state.view.left.docId = DOC;
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [{ id: 'yjs_stroke', points: [{ x: 0.1, y: 0.1 }] }], images: [], textBoxes: [] } };
        stub.api._annotationsResponse = { pages: { [PAGE]: { strokes: [], images: [], textBoxes: [] } }, revisions: {} };

        await sb.smartRefreshFromServer(true);

        assert.strictEqual(stub.api._calls.getAnnotations.length, 0,
            'REST annotation fetch must be skipped while Yjs is the source of truth');
        assert.strictEqual(sb.state.annotations[DOC][PAGE].strokes.length, 1,
            'local (Yjs-managed) annotations untouched');
    });

    await run('6.2 non-Yjs doc: the annotation refresh still runs (legacy behavior preserved)', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(false);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'database.js'), path.join(STATIC_DIR, 'conflict.js')], stub);
        sb.state.view.left.docId = DOC;
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };
        stub.api._annotationsResponse = {
            pages: { [PAGE]: { strokes: [{ id: 'rest_stroke', points: [] }], images: [], textBoxes: [] } },
            revisions: {},
        };

        await sb.smartRefreshFromServer(true);

        assert.ok(stub.api._calls.getAnnotations.includes(DOC), 'REST fetch happened');
        assert.strictEqual(sb.state.annotations[DOC][PAGE].strokes[0].id, 'rest_stroke',
            'state updated from REST for non-Yjs docs');
    });
}

// ---------------------------------------------------------------
// Suite 7 — Yjs-connected end-to-end stroke lifecycle.
// ---------------------------------------------------------------
async function suite7() {
    console.log('\n=== Suite 7 — Yjs-connected stroke lifecycle (collaboration preserved) ===');

    await run('7.1 start/continue/finish push to Yjs and manage in-flight markers', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.10, 0.10);
        const ref = sb.state.drawing.activeStrokeRef;
        assert.ok(stub.yjs._calls.beginInFlight.includes(ref.id), 'beginInFlight at stroke start');
        const initialPush = stub.yjs._calls.setAnnotation.find(c => c.annoId === ref.id);
        assert.ok(initialPush, 'initial single-point stroke pushed to Yjs');

        sb.continueAnnotationStroke('left', 0.20, 0.20);
        sb.finishAnnotationStroke('left');

        assert.ok(stub.yjs._calls.endInFlight.includes(ref.id), 'endInFlight at stroke finish');
        const finalPush = stub.yjs._calls.setAnnotation.filter(c => c.annoId === ref.id).pop();
        assert.strictEqual(finalPush.data.points.length, 2, 'complete stroke pushed to Yjs at finish');
        assert.ok(stub.historyCalls.some(h => h.label.includes('add')), 'undo entry pushed');
    });

    await run('7.2 two sequential strokes (with lift+pause+refresh between) stay independent under Yjs', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };

        // Stroke 1
        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.05, 0.05);
        const s1 = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.10, 0.10);
        sb.finishAnnotationStroke('left');
        sb.state.drawing.active = false;

        // Pause + refresh-style replacement (clones the array like a rebuild).
        wholesaleReplace(sb, sb.state.annotations[DOC][PAGE].strokes.map(s => JSON.parse(JSON.stringify(s))));

        // Stroke 2
        sb.state.drawing.active = true;
        sb.startAnnotationStroke('left', 0.60, 0.60);
        const s2 = sb.state.drawing.activeStrokeRef;
        sb.continueAnnotationStroke('left', 0.65, 0.65);
        sb.finishAnnotationStroke('left');
        sb.state.drawing.active = false;

        assert.notStrictEqual(s1.id, s2.id, 'distinct ids');
        deq(s1.points, [{ x: 0.05, y: 0.05 }, { x: 0.10, y: 0.10 }]);
        deq(s2.points, [{ x: 0.60, y: 0.60 }, { x: 0.65, y: 0.65 }],
            'stroke 2 has only its own points — no connection to stroke 1');
        const pushedS2 = stub.yjs._calls.setAnnotation.filter(c => c.annoId === s2.id).pop();
        assert.strictEqual(pushedS2.data.points.length, 2, 'Yjs received the clean stroke 2');
    });

    await run('7.3 eraser-stroke pointerup no longer bulk-REST-saves while Yjs is connected', async () => {
        const stub = makeBrowserStub();
        stub.yjs._setConnected(true);
        const sb = loadJsFiles([path.join(STATIC_DIR, 'annotations.js'), path.join(STATIC_DIR, 'events.js')], stub);
        sb.state.annotations[DOC] = { [PAGE]: { strokes: [], images: [], textBoxes: [] } };
        sb.state.annoTool = 'eraser-stroke';
        sb.state.drawing.active = true;
        sb.state.drawing.pointerId = 41;
        sb.state.drawing.startSide = 'left';

        await sb.handlePointerUp({ pointerId: 41, clientX: 100, clientY: 100, target: { closest: () => null, releasePointerCapture: () => {} } });

        assert.strictEqual(stub.api._calls.saveAllAnnotations.length, 0,
            'no REST bulk save while Yjs is connected (deletes go through yjsSetAnnotation)');
    });
}

// ---------------------------------------------------------------
async function main() {
    console.log('Stroke continuity regression tests (pen/highlighter "connects to previous stroke" bug)');
    await suite1();
    await suite2();
    await suite3();
    await suite4();
    await suite5();
    await suite6();
    await suite7();

    console.log('\n========================================');
    console.log(`Results: ${passCount} passed, ${failCount} failed`);
    if (failCount > 0) {
        failures.forEach(f => console.error(` - ${f.name}: ${f.err && f.err.message}`));
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

/**
 * Frontend regression tests for the two annotation/touch interaction bugs.
 *
 * These tests run under plain Node.js (no jsdom, no bun) using a minimal
 * browser stub. The static JS files (annotations.js, yjs-collab.js,
 * events.js) reference a number of browser globals — `window`, `document`,
 * `state`, `els`, `getProjectId`, `setProjectId`, etc. We stub each of
 * these just enough to load the file under test and exercise the
 * specific function that was fixed.
 *
 * Test layout:
 *
 *   Suite 1 — Bug 1 (Pen/Highlighter tool switching):
 *     1.1  startAnnotationStroke stamps state.annoTool onto the new stroke.
 *     1.2  continueAnnotationStroke renders using currentStroke.tool,
 *          NOT state.annoTool (the regression that was fixed).
 *     1.3  A pen stroke stays a pen stroke even if state.annoTool flips
 *          to 'highlighter' mid-stroke (the user-visible symptom).
 *     1.4  A highlighter stroke stays a highlighter stroke even if
 *          state.annoTool flips to 'pen' mid-stroke.
 *
 *   Suite 2 — Bug 2 (Annotation movement rendering):
 *     2.1  _relinkSelectionAfterYjsUpdate re-links a stale image
 *          reference after a Yjs rebuild, preserving the dragged x/y.
 *     2.2  _relinkSelectionAfterYjsUpdate re-links a stale stroke
 *          reference, preserving the dragged points.
 *     2.3  _relinkSelectionAfterYjsUpdate is a no-op when the
 *          references are already correct.
 *     2.4  clearSelection ends in-flight markers (defensive).
 *
 * Run with:
 *   node tests/test_frontend_bugs.js
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

// ---------------------------------------------------------------
// Minimal browser stub.
// ---------------------------------------------------------------
// The JS files use these globals. We provide just enough behaviour for the
// functions under test. Each test creates a fresh stub + loads a fresh copy
// of the file under test (so tests don't share state).
function makeBrowserStub() {
    // ---- Canvas context stub: records every call so tests can inspect it.
    // Each `stroke()` call snapshots the current compositeOp/alpha/lineWidth/
    // strokeStyle — that's what tests verify, since the rendering functions
    // reset these properties back to defaults at the END of each call.
    const ctxCalls = [];
    function makeCtx() {
        const ctx = {
            // property state (most recent assignment wins)
            globalCompositeOperation: 'source-over',
            globalAlpha: 1.0,
            lineWidth: 1,
            strokeStyle: '#000',
            lineCap: 'butt',
            lineJoin: 'miter',
            // methods (push into the call log)
            clearRect: (...a) => ctxCalls.push(['clearRect', a]),
            beginPath: (...a) => ctxCalls.push(['beginPath', a]),
            moveTo: (...a) => ctxCalls.push(['moveTo', a]),
            lineTo: (...a) => ctxCalls.push(['lineTo', a]),
            quadraticCurveTo: (...a) => ctxCalls.push(['quadraticCurveTo', a]),
            // stroke() snapshots the current state so tests can verify what
            // the rendering actually USED — not what's left over after the
            // function resets ctx to defaults at the end.
            stroke: (...a) => ctxCalls.push(['stroke', a, {
                compositeOp: ctx.globalCompositeOperation,
                alpha: ctx.globalAlpha,
                lineWidth: ctx.lineWidth,
                strokeStyle: ctx.strokeStyle,
                lineCap: ctx.lineCap,
                lineJoin: ctx.lineJoin,
            }]),
            fill: (...a) => ctxCalls.push(['fill', a, {
                compositeOp: ctx.globalCompositeOperation,
                alpha: ctx.globalAlpha,
                lineWidth: ctx.lineWidth,
                strokeStyle: ctx.strokeStyle,
            }]),
            fillRect: (...a) => ctxCalls.push(['fillRect', a]),
            strokeRect: (...a) => ctxCalls.push(['strokeRect', a]),
            drawImage: (...a) => ctxCalls.push(['drawImage', a]),
            save: (...a) => ctxCalls.push(['save', a]),
            restore: (...a) => ctxCalls.push(['restore', a]),
            setLineDash: (...a) => ctxCalls.push(['setLineDash', a]),
            fillText: (...a) => ctxCalls.push(['fillText', a]),
            measureText: (s) => ({ width: (s || '').length * 6 }),
        };
        return ctx;
    }

    // ---- Per-side canvas (just enough so `els[side + 'AnnoCanvas']` works).
    const leftCtx = makeCtx();
    const rightCtx = makeCtx();
    const canvases = {
        left: { width: 1000, height: 1000, getContext: () => leftCtx },
        right: { width: 1000, height: 1000, getContext: () => rightCtx },
    };

    // ---- Element stub.
    function makeEl(tag) {
        return {
            tagName: tag || 'DIV',
            style: {},
            classList: {
                _set: new Set(),
                add: (...c) => c.forEach(x => makeEl._last && makeEl._last.classList._set.add(x)),
                remove: (...c) => c.forEach(x => makeEl._last && makeEl._last.classList._set.delete(x)),
                toggle: (c, force) => {
                    if (force === undefined) {
                        if (makeEl._last && makeEl._last.classList._set.has(c)) {
                            makeEl._last.classList._set.delete(c);
                        } else if (makeEl._last) {
                            makeEl._last.classList._set.add(c);
                        }
                    } else if (makeEl._last) {
                        if (force) makeEl._last.classList._set.add(c);
                        else makeEl._last.classList._set.delete(c);
                    }
                },
                contains: (c) => makeEl._last && makeEl._last.classList._set.has(c),
            },
            children: [],
            appendChild: (c) => { makeEl._last && makeEl._last.children.push(c); return c; },
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
            setPointerCapture: () => {},
            releasePointerCapture: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
            value: '',
            innerText: '',
            innerHTML: '',
            click: () => {},
            focus: () => {},
        };
    }

    // ---- els global — minimal subset used by the functions under test.
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
        modal: makeEl('div'),
        modalTitle: makeEl('h2'),
        modalBody: makeEl('div'),
        modalInput: makeEl('input'),
        modalConfirmBtn: makeEl('button'),
        loadingSpinner: makeEl('div'),
        emptyMsg: makeEl('div'),
        chatInput: makeEl('textarea'),
        sendChatBtn: makeEl('button'),
        leftZoomLevel: makeEl('span'),
        rightZoomLevel: makeEl('span'),
        commentEditorPanel: makeEl('div'),
        commentEditorArea: makeEl('div'),
        commentEditButtonArea: makeEl('div'),
        commentPreviewArea: makeEl('div'),
        commentMarkdownInput: makeEl('textarea'),
        resizer: makeEl('div'),
        leftPanel: makeEl('div'),
        rightPanel: makeEl('div'),
        workspaceMain: makeEl('div'),
        snipPreview: makeEl('img'),
        textCreationRect: makeEl('div'),
    };

    // ---- document stub.
    const documentStub = {
        body: makeEl('body'),
        getElementById: (id) => {
            // Return a stub element for any id — enough for the functions under test.
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

    // ---- window stub.
    const windowStub = {
        document: documentStub,
        matchMedia: (q) => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
        location: { protocol: 'http:', host: 'localhost:8000', pathname: '/editor/test' },
    };
    windowStub.window = windowStub;

    // ---- state global — initialized to the same defaults as in state.js
    // (only the fields the functions under test touch).
    const state = {
        view: {
            left: { docId: 'doc1', pageId: 'page_1', pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
            right: { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
        },
        annoTool: 'pen',
        annoColor: '#ef4444',
        annoThickness: 5,
        appMode: 'annotation',
        lineMode: 'freehand',
        annotations: {},
        imageCache: {},
        lastActiveSide: 'left',
        drawing: { active: false, pointerId: null, startSide: null, startPoint: { x: 0, y: 0 }, activeStrokeRef: null },
        selection: {
            active: false, side: null, mode: 'idle',
            marqueeStart: null, marqueeCurrent: null,
            selectedImages: [], selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: null, dragStartMouse: null, dragStartPositions: null,
        },
        links: [],
        toolSettings: {
            pen: { color: '#ef4444', thickness: 5 },
            highlighter: { color: '#facc15', thickness: 20 },
            eraserPixel: { thickness: 20 },
            eraserStroke: { thickness: 5 },
        },
    };

    // ---- Yjs stub: capture calls so tests can assert them.
    const yjsCalls = { beginInFlight: [], endInFlight: [], setAnnotation: [], claimLock: [], releaseLock: [] };
    const yjsInFlight = new Set();
    const yjsStub = {
        yjsIsConnected: () => false,  // tests run without a real Yjs server.
        yjsSetAnnotation: (docId, pageId, annoId, data) => { yjsCalls.setAnnotation.push({ docId, pageId, annoId, data }); return true; },
        yjsBeginInFlight: (annoId) => { yjsCalls.beginInFlight.push(annoId); yjsInFlight.add(annoId); },
        yjsEndInFlight: (annoId) => { yjsCalls.endInFlight.push(annoId); yjsInFlight.delete(annoId); },
        yjsClaimLock: (annoId, kind) => { yjsCalls.claimLock.push({ annoId, kind }); },
        yjsReleaseLock: (annoId) => { yjsCalls.releaseLock.push(annoId); },
        yjsGetLock: () => null,
        yjsSetPresence: () => {},
        yjsSetSelf: () => {},
        _calls: yjsCalls,
        _inFlight: yjsInFlight,
    };

    // ---- Project ID stub.
    let _projectId = 'test-project';
    const projectIdStub = {
        getProjectId: () => _projectId,
        setProjectId: (id) => { _projectId = id; },
    };

    // ---- Misc stubs.
    const misc = {
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
        pushHistoryAction: () => {},
        intOr: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
    };

    return {
        ctxCalls,
        canvases,
        els,
        document: documentStub,
        window: windowStub,
        state,
        yjs: yjsStub,
        projectId: projectIdStub,
        misc,
        leftCtx,
        rightCtx,
    };
}

/**
 * Load one or more JS files in a single sandboxed VM context with the
 * stubbed globals. The files share the same global scope (so functions
 * defined in one file are visible to the next, exactly as they would be
 * in a browser). Returns the sandbox.
 *
 * The provided `extra` object can override or extend the stubbed globals.
 */
function loadJsFiles(filePaths, stub) {
    const sandbox = {
        // Node built-ins
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        Date, Math, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean,
        Error, TypeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        // Browser stubs
        window: stub.window,
        document: stub.document,
        state: stub.state,
        els: stub.els,
        // Yjs stubs
        yjsIsConnected: stub.yjs.yjsIsConnected,
        yjsSetAnnotation: stub.yjs.yjsSetAnnotation,
        yjsBeginInFlight: stub.yjs.yjsBeginInFlight,
        yjsEndInFlight: stub.yjs.yjsEndInFlight,
        yjsClaimLock: stub.yjs.yjsClaimLock,
        yjsReleaseLock: stub.yjs.yjsReleaseLock,
        yjsGetLock: stub.yjs.yjsGetLock,
        yjsSetPresence: stub.yjs.yjsSetPresence,
        yjsSetSelf: stub.yjs.yjsSetSelf,
        // Project ID
        getProjectId: stub.projectId.getProjectId,
        setProjectId: stub.projectId.setProjectId,
        // Misc
        saveSettings: stub.misc.saveSettings,
        saveAnnotationsToDB: stub.misc.saveAnnotationsToDB,
        saveLinkToDB: stub.misc.saveLinkToDB,
        deleteLinkFromDB: stub.misc.deleteLinkFromDB,
        renderAnnotations: stub.misc.renderAnnotations,
        renderTextLayer: stub.misc.renderTextLayer,
        renderMarkersForView: stub.misc.renderMarkersForView,
        renderPage: stub.misc.renderPage,
        renderDocList: stub.misc.renderDocList,
        renderChatList: stub.misc.renderChatList,
        renderChatMessages: stub.misc.renderChatMessages,
        updateZoomIndicator: stub.misc.updateZoomIndicator,
        updateViewportActiveVisuals: stub.misc.updateViewportActiveVisuals,
        updateLockVisuals: stub.misc.updateLockVisuals,
        updateThicknessPreview: stub.misc.updateThicknessPreview,
        escapeHtml: stub.misc.escapeHtml,
        showModal: stub.misc.showModal,
        debounce: stub.misc.debounce,
        pushHistoryAction: stub.misc.pushHistoryAction,
        intOr: stub.misc.intOr,
        // Constants used by state.js / etc.
        ROOT_FOLDER_ID: 'root',
        MAX_RECENT_DOCS: 10,
        // For state.js — leave editorHistory/conflictState accessible.
        editorHistory: { stack: [], pointer: 0, maxLen: 200 },
        conflictState: { projectRevision: 0, annotationRevisions: {} },
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

/** Backward-compat: load a single file. */
function loadJsFile(filePath, stub) {
    return loadJsFiles([filePath], stub);
}

// =====================================================================
// SUITE 1: Bug 1 — Pen/Highlighter tool switching
// =====================================================================
function suite_bug1_tool_switching() {
    console.log("\n" + "=" * 0);
    console.log("SUITE 1: Bug 1 — Pen/Highlighter tool switching");
    console.log("===============================================");
    console.log("Each user's selected tool must remain LOCAL to that user/device.");
    console.log("The in-progress stroke's rendering must use the STROKE'S OWN `tool`");
    console.log("field (stamped at creation time), NOT `state.annoTool`.");
    console.log("");

    // ---- Test 1.1: startAnnotationStroke stamps state.annoTool onto the stroke.
    {
        const stub = makeBrowserStub();
        // Reset canvas call log so we have a clean slate.
        stub.ctxCalls.length = 0;
        // Make sure state.annotations has the right shape.
        stub.state.annotations.doc1 = { page_1: { strokes: [], images: [], textBoxes: [] } };
        stub.state.annoTool = 'pen';
        stub.state.annoColor = '#ef4444';
        stub.state.annoThickness = 5;
        // Disable Yjs so it doesn't push (cleaner test).
        // (yjsIsConnected already returns false in the stub.)

        const sb = loadJsFile(path.join(STATIC_DIR, 'annotations.js'), stub);
        // Call startAnnotationStroke.
        sb.startAnnotationStroke('left', 0.3, 0.4);

        const strokes = stub.state.annotations.doc1.page_1.strokes;
        if (strokes.length !== 1) {
            fail("1.1 startAnnotationStroke stamps tool",
                 new Error(`Expected 1 stroke, got ${strokes.length}`));
        } else {
            const s = strokes[0];
            if (s.tool === 'pen' && s.color === '#ef4444') {
                ok("1.1 startAnnotationStroke stamps state.annoTool onto stroke",
                   `tool=${s.tool}, color=${s.color}`);
            } else {
                fail("1.1 startAnnotationStroke stamps tool",
                     new Error(`Stroke has wrong tool/color: ${s.tool}, ${s.color}`));
            }
        }
    }

    // ---- Test 1.2: continueAnnotationStroke uses currentStroke.tool, NOT state.annoTool.
    // This is the regression test for the actual bug. We:
    //   1. Start a pen stroke (state.annoTool = 'pen').
    //   2. Flip state.annoTool to 'highlighter' (simulating a stray keyboard
    //      shortcut or a remote settings update).
    //   3. Call continueAnnotationStroke.
    //   4. Assert that the rendering used 'pen' settings (source-over, alpha=1,
    //      sizeMultiplier=1), NOT 'highlighter' settings (multiply, alpha=0.4,
    //      sizeMultiplier=3).
    {
        const stub = makeBrowserStub();
        stub.state.annotations.doc1 = { page_1: { strokes: [], images: [], textBoxes: [] } };
        stub.state.annoTool = 'pen';
        stub.state.annoColor = '#ef4444';
        stub.state.annoThickness = 5;

        const sb = loadJsFile(path.join(STATIC_DIR, 'annotations.js'), stub);
        sb.startAnnotationStroke('left', 0.3, 0.4);

        // Clear the call log so we only see what continueAnnotationStroke does.
        stub.ctxCalls.length = 0;

        // Flip the global tool to highlighter AFTER the stroke started.
        // (This is the bug — the in-progress rendering used to switch.)
        stub.state.annoTool = 'highlighter';
        stub.state.annoColor = '#facc15';
        stub.state.annoThickness = 20;

        sb.continueAnnotationStroke('left', 0.35, 0.45);
        // Need 2 more points to trigger the quadraticCurveTo path.
        sb.continueAnnotationStroke('left', 0.40, 0.50);
        sb.continueAnnotationStroke('left', 0.45, 0.55);

        // Find the LAST stroke() call — it has a snapshot of the ctx state
        // AT THE TIME of the stroke, before the function reset ctx to defaults.
        const strokeCalls = stub.ctxCalls.filter(c => c[0] === 'stroke');
        if (strokeCalls.length === 0) {
            fail("1.2 continueAnnotationStroke uses currentStroke.tool",
                 new Error("No stroke() calls recorded"));
        } else {
            const lastStrokeSnapshot = strokeCalls[strokeCalls.length - 1][2];
            // The stroke's own tool is 'pen', so rendering should use pen settings.
            if (lastStrokeSnapshot.compositeOp === 'source-over' &&
                lastStrokeSnapshot.alpha === 1.0 &&
                lastStrokeSnapshot.strokeStyle === '#ef4444') {
                ok("1.2 continueAnnotationStroke uses currentStroke.tool (not state.annoTool)",
                   `compositeOp=${lastStrokeSnapshot.compositeOp}, alpha=${lastStrokeSnapshot.alpha}, strokeStyle=${lastStrokeSnapshot.strokeStyle}`);
            } else {
                fail("1.2 continueAnnotationStroke uses currentStroke.tool",
                     new Error(`Wrong rendering: compositeOp=${lastStrokeSnapshot.compositeOp}, alpha=${lastStrokeSnapshot.alpha}, strokeStyle=${lastStrokeSnapshot.strokeStyle}. Expected source-over / 1.0 / #ef4444.`));
            }
        }
    }

    // ---- Test 1.3: Pen stroke stays pen even if state.annoTool flips mid-stroke.
    // (End-to-end symptom test.)
    {
        const stub = makeBrowserStub();
        stub.state.annotations.doc1 = { page_1: { strokes: [], images: [], textBoxes: [] } };
        stub.state.annoTool = 'pen';
        stub.state.annoColor = '#ef4444';
        stub.state.annoThickness = 5;

        const sb = loadJsFile(path.join(STATIC_DIR, 'annotations.js'), stub);
        sb.startAnnotationStroke('left', 0.3, 0.4);
        // Simulate the tool getting switched mid-stroke.
        stub.state.annoTool = 'highlighter';
        sb.continueAnnotationStroke('left', 0.35, 0.45);
        sb.continueAnnotationStroke('left', 0.40, 0.50);
        sb.continueAnnotationStroke('left', 0.45, 0.55);

        const strokes = stub.state.annotations.doc1.page_1.strokes;
        const s = strokes[strokes.length - 1];
        if (s.tool === 'pen' && s.color === '#ef4444' && s.size === 5/1000) {
            ok("1.3 Pen stroke stays pen (tool/color/size) even if state.annoTool flips",
               `tool=${s.tool}, color=${s.color}, size=${s.size}`);
        } else {
            fail("1.3 Pen stroke stays pen",
                 new Error(`Stroke mutated: tool=${s.tool}, color=${s.color}, size=${s.size}`));
        }
    }

    // ---- Test 1.4: Highlighter stroke stays highlighter even if state.annoTool flips to pen.
    // (Mirror of 1.3 — ensures the fix works in both directions.)
    {
        const stub = makeBrowserStub();
        stub.state.annotations.doc1 = { page_1: { strokes: [], images: [], textBoxes: [] } };
        stub.state.annoTool = 'highlighter';
        stub.state.annoColor = '#facc15';
        stub.state.annoThickness = 20;

        const sb = loadJsFile(path.join(STATIC_DIR, 'annotations.js'), stub);
        sb.startAnnotationStroke('left', 0.3, 0.4);
        // Flip tool mid-stroke.
        stub.state.annoTool = 'pen';
        sb.continueAnnotationStroke('left', 0.35, 0.45);

        const strokes = stub.state.annotations.doc1.page_1.strokes;
        const s = strokes[strokes.length - 1];
        if (s.tool === 'highlighter' && s.color === '#facc15' && s.size === 20/1000) {
            ok("1.4 Highlighter stroke stays highlighter even if state.annoTool flips to pen",
               `tool=${s.tool}, color=${s.color}, size=${s.size}`);
        } else {
            fail("1.4 Highlighter stroke stays highlighter",
                 new Error(`Stroke mutated: tool=${s.tool}, color=${s.color}, size=${s.size}`));
        }

        // Also check the rendering: should be multiply / 0.4 alpha (highlighter),
        // even though state.annoTool was flipped to 'pen' mid-stroke. We look
        // at the snapshot captured at the stroke() call (since the function
        // resets ctx to defaults at the end).
        const strokeCalls = stub.ctxCalls.filter(c => c[0] === 'stroke');
        if (strokeCalls.length === 0) {
            fail("1.4b Highlighter rendering uses multiply + 0.4 alpha",
                 new Error("No stroke() calls recorded"));
        } else {
            const snap = strokeCalls[strokeCalls.length - 1][2];
            if (snap.compositeOp === 'multiply' && snap.alpha === 0.4) {
                ok("1.4b Highlighter rendering uses multiply + 0.4 alpha (not pen's source-over)",
                   `compositeOp=${snap.compositeOp}, alpha=${snap.alpha}`);
            } else {
                fail("1.4b Highlighter rendering uses multiply + 0.4 alpha",
                     new Error(`Wrong rendering: compositeOp=${snap.compositeOp}, alpha=${snap.alpha}`));
            }
        }
    }
}

// =====================================================================
// SUITE 2: Bug 2 — Annotation movement rendering
// =====================================================================
function suite_bug2_movement_rendering() {
    console.log("\n" + "=" * 0);
    console.log("SUITE 2: Bug 2 — Annotation/Image movement rendering");
    console.log("===================================================");
    console.log("When dragging an annotation, the underlying object's x/y must");
    console.log("move together with the blue selection boundary. The Yjs rebuild");
    console.log("must NOT orphan the selection's object references.");
    console.log("");

    // ---- Test 2.1: _relinkSelectionAfterYjsUpdate re-links a stale image
    //               reference and preserves the dragged x/y.
    {
        const stub = makeBrowserStub();
        // Set up: image is at (0.5, 0.5), selected, and the user has dragged
        // it to (0.6, 0.6) (so the SELECTED image has x=0.6, y=0.6).
        const docId = 'doc1';
        const pageId = 'page_1';
        const imgId = 'img_test';

        const selectedImg = { id: imgId, type: 'image', src: 'data:', x: 0.6, y: 0.6, w: 0.2, h: 0.2 };

        stub.state.annotations[docId] = {};
        stub.state.annotations[docId][pageId] = {
            strokes: [],
            // The state.annotations has an OLD clone at (0.5, 0.5) — this is
            // what the Yjs rebuild would replace it with.
            images: [{ id: imgId, type: 'image', src: 'data:', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }],
            textBoxes: [],
        };
        stub.state.view.left.docId = docId;
        stub.state.view.left.pageId = pageId;
        stub.state.selection = {
            active: true, side: 'left', mode: 'dragging',
            selectedImages: [selectedImg],  // the user's dragged reference
            selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
            dragStartMouse: { x: 0.4, y: 0.4 },
        };

        const sb = loadJsFile(path.join(STATIC_DIR, 'yjs-collab.js'), stub);

        // Sanity: selectedImages[0] is NOT the same object as the image in state.annotations.
        const pageImages = stub.state.annotations[docId][pageId].images;
        const beforeSame = (pageImages[0] === stub.state.selection.selectedImages[0]);
        if (beforeSame) {
            fail("2.1 _relinkSelectionAfterYjsUpdate re-links stale image",
                 new Error("Test setup wrong: selectedImages[0] is the same object as state.annotations image (should be different)"));
        } else {
            // Call the function under test.
            sb._relinkSelectionAfterYjsUpdate(docId);

            const sel = stub.state.selection.selectedImages;
            const liveImg = stub.state.annotations[docId][pageId].images.find(i => i.id === imgId);
            if (sel[0] !== liveImg) {
                fail("2.1 _relinkSelectionAfterYjsUpdate re-links stale image",
                     new Error("selectedImages[0] was NOT re-linked to the live image"));
            } else if (liveImg.x !== 0.6 || liveImg.y !== 0.6) {
                fail("2.1 _relinkSelectionAfterYjsUpdate re-links stale image",
                     new Error(`Dragged x/y NOT preserved: liveImg.x=${liveImg.x}, liveImg.y=${liveImg.y} (expected 0.6, 0.6)`));
            } else {
                ok("2.1 _relinkSelectionAfterYjsUpdate re-links stale image + preserves dragged x/y",
                   `liveImg.x=${liveImg.x}, liveImg.y=${liveImg.y}`);
            }
        }
    }

    // ---- Test 2.2: _relinkSelectionAfterYjsUpdate re-links a stale stroke
    //               reference and preserves the dragged points.
    {
        const stub = makeBrowserStub();
        const docId = 'doc1';
        const pageId = 'page_1';
        const stkId = 'stroke_test';

        // The stroke the user is dragging (in selection): points have been
        // shifted by (+0.1, +0.1) — that's the dragged state.
        const selectedStk = {
            id: stkId, type: 'stroke', tool: 'pen', color: '#ef4444', size: 0.005,
            points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }],
        };
        stub.state.annotations[docId] = {};
        stub.state.annotations[docId][pageId] = {
            // The state.annotations has the OLD points (before the drag).
            strokes: [{
                id: stkId, type: 'stroke', tool: 'pen', color: '#ef4444', size: 0.005,
                points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }],
            }],
            images: [], textBoxes: [],
        };
        stub.state.view.left.docId = docId;
        stub.state.view.left.pageId = pageId;
        stub.state.selection = {
            active: true, side: 'left', mode: 'dragging',
            selectedImages: [], selectedTextBoxes: [],
            selectedStrokes: [selectedStk],
            boundingBox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
            dragStartMouse: { x: 0.1, y: 0.1 },
        };

        const sb = loadJsFile(path.join(STATIC_DIR, 'yjs-collab.js'), stub);

        sb._relinkSelectionAfterYjsUpdate(docId);

        const selStk = stub.state.selection.selectedStrokes[0];
        const liveStk = stub.state.annotations[docId][pageId].strokes.find(s => s.id === stkId);
        if (selStk !== liveStk) {
            fail("2.2 _relinkSelectionAfterYjsUpdate re-links stale stroke",
                 new Error("selectedStrokes[0] was NOT re-linked to the live stroke"));
        } else {
            // The dragged points should be copied onto the live stroke.
            const allPointsMatch = liveStk.points.every((p, i) =>
                Math.abs(p.x - selectedStk.points[i].x) < 1e-9 &&
                Math.abs(p.y - selectedStk.points[i].y) < 1e-9);
            if (allPointsMatch) {
                ok("2.2 _relinkSelectionAfterYjsUpdate re-links stale stroke + preserves dragged points",
                   `points[0]=(${liveStk.points[0].x},${liveStk.points[0].y})`);
            } else {
                fail("2.2 _relinkSelectionAfterYjsUpdate re-links stale stroke",
                     new Error(`Dragged points NOT preserved: liveStk.points=${JSON.stringify(liveStk.points)}`));
            }
        }
    }

    // ---- Test 2.3: _relinkSelectionAfterYjsUpdate is a no-op when references
    //               are already correct.
    {
        const stub = makeBrowserStub();
        const docId = 'doc1';
        const pageId = 'page_1';
        const imgId = 'img_test';

        // Set up: the selected image IS the same object as the one in state.annotations.
        const liveImg = { id: imgId, type: 'image', src: 'data:', x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
        stub.state.annotations[docId] = {};
        stub.state.annotations[docId][pageId] = { strokes: [], images: [liveImg], textBoxes: [] };
        stub.state.view.left.docId = docId;
        stub.state.view.left.pageId = pageId;
        stub.state.selection = {
            active: true, side: 'left', mode: 'idle',
            selectedImages: [liveImg],  // SAME reference
            selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        };

        const sb = loadJsFile(path.join(STATIC_DIR, 'yjs-collab.js'), stub);
        sb._relinkSelectionAfterYjsUpdate(docId);

        // After the call, the selected image should STILL be the same object.
        if (stub.state.selection.selectedImages[0] === liveImg) {
            ok("2.3 _relinkSelectionAfterYjsUpdate is a no-op when references are already correct");
        } else {
            fail("2.3 _relinkSelectionAfterYjsUpdate is a no-op when references are already correct",
                 new Error("Selected image reference was changed even though it was already correct"));
        }
    }

    // ---- Test 2.4: clearSelection ends in-flight markers.
    // This tests the defensive fix in annotations.js's clearSelection.
    {
        const stub = makeBrowserStub();
        const docId = 'doc1';
        const pageId = 'page_1';
        const imgId = 'img_inflight_test';

        stub.state.annotations[docId] = {};
        stub.state.annotations[docId][pageId] = {
            strokes: [], images: [{ id: imgId, type: 'image', src: 'data:', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }],
            textBoxes: [],
        };
        stub.state.view.left.docId = docId;
        stub.state.view.left.pageId = pageId;
        stub.state.selection = {
            active: true, side: 'left', mode: 'dragging',
            selectedImages: [{ id: imgId, type: 'image', src: 'data:', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }],
            selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        };
        // Manually mark the image as in-flight (as if the drag had started).
        stub.yjs._inFlight.add(imgId);

        const sb = loadJsFile(path.join(STATIC_DIR, 'annotations.js'), stub);

        // Sanity: in-flight before clear.
        if (!stub.yjs._inFlight.has(imgId)) {
            fail("2.4 clearSelection ends in-flight markers",
                 new Error("Test setup wrong: imgId not in in-flight set before clearSelection"));
        }

        sb.clearSelection();

        if (!stub.yjs._inFlight.has(imgId)) {
            ok("2.4 clearSelection ends in-flight markers (defensive cleanup)");
        } else {
            fail("2.4 clearSelection ends in-flight markers",
                 new Error(`imgId still in in-flight set after clearSelection`));
        }
    }

    // ---- Test 2.5: A typical drag scenario does NOT leave the visible object behind.
    // This is the end-to-end symptom test: simulate a Yjs rebuild mid-drag and
    // verify that the next pointermove correctly mutates the LIVE object
    // (not an orphan).
    //
    // We can't easily run handlePointerMove (it depends on a real DOM event)
    // but we CAN directly call _refreshSelectionReferences (the helper it
    // invokes) and verify it does the right thing.
    {
        const stub = makeBrowserStub();
        const docId = 'doc1';
        const pageId = 'page_1';
        const imgId = 'img_drag_test';

        stub.state.annotations[docId] = {};
        stub.state.annotations[docId][pageId] = {
            strokes: [], images: [], textBoxes: [],
        };
        stub.state.view.left.docId = docId;
        stub.state.view.left.pageId = pageId;

        // Step 1: user selects an image (selectedImages[0] === the live object).
        const originalImg = { id: imgId, type: 'image', src: 'data:', x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
        stub.state.annotations[docId][pageId].images = [originalImg];
        stub.state.selection = {
            active: true, side: 'left', mode: 'dragging',
            selectedImages: [originalImg],
            selectedTextBoxes: [], selectedStrokes: [],
            boundingBox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
            dragStartMouse: { x: 0.4, y: 0.4 },
        };

        // Load both yjs-collab.js (for _relinkSelectionAfterYjsUpdate) AND
        // events.js (for _refreshSelectionReferences). They share globals.
        const sb = loadJsFiles([
            path.join(STATIC_DIR, 'yjs-collab.js'),
            path.join(STATIC_DIR, 'events.js'),
        ], stub);

        // Step 2: simulate a Yjs remote update that rebuilds the page
        // (replacing the image with a clone at the OLD position).
        const clonedImg = { ...originalImg };  // shallow clone — different object ref
        stub.state.annotations[docId][pageId].images = [clonedImg];

        // Step 3: user drags by (+0.05, +0.05) — mutates the SELECTED image.
        // But because the rebuild replaced the live image with a clone,
        // mutating selectedImages[0] would mutate the orphan, not the live one.
        // _refreshSelectionReferences should re-link the references first.

        sb._refreshSelectionReferences('left');

        // After refresh, selectedImages[0] should be the live (cloned) image.
        if (stub.state.selection.selectedImages[0] !== clonedImg) {
            fail("2.5 _refreshSelectionReferences re-links before mutation",
                 new Error("selectedImages[0] was NOT re-linked to the live image"));
        } else {
            // Now mutate (simulating what handlePointerMove would do).
            const img = stub.state.selection.selectedImages[0];
            img.x += 0.05;
            img.y += 0.05;

            // The LIVE image (in state.annotations) should now be at (0.55, 0.55),
            // NOT at (0.50, 0.50). This is the bug: previously the orphan was
            // mutated while the live image stayed put.
            const liveImg = stub.state.annotations[docId][pageId].images[0];
            if (Math.abs(liveImg.x - 0.55) < 1e-9 && Math.abs(liveImg.y - 0.55) < 1e-9) {
                ok("2.5 _refreshSelectionReferences + drag mutation reaches the live image",
                   `liveImg.x=${liveImg.x}, liveImg.y=${liveImg.y}`);
            } else {
                fail("2.5 _refreshSelectionReferences + drag mutation reaches the live image",
                     new Error(`Live image NOT moved: liveImg.x=${liveImg.x}, liveImg.y=${liveImg.y} (expected 0.55, 0.55)`));
            }
        }
    }
}

// =====================================================================
// Main
// =====================================================================
function main() {
    console.log("Frontend regression tests for annotation/touch bug fixes");
    console.log("=========================================================");
    console.log(`Loading JS files from: ${STATIC_DIR}`);
    console.log("");

    suite_bug1_tool_switching();
    suite_bug2_movement_rendering();

    console.log("\n" + "=".repeat(60));
    console.log(`RESULTS: ${passCount} passed, ${failCount} failed`);
    console.log("=".repeat(60));

    if (failCount > 0) {
        console.log("\nFailures:");
        failures.forEach(f => console.log(`  - ${f.name}: ${f.err && (f.err.message || f.err)}`));
    }

    process.exit(failCount > 0 ? 1 : 0);
}

main();

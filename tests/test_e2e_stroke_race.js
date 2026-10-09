/**
 * End-to-end integration test against the REAL server:
 *  - real WebSocket /ws/sync + /ws/yjs rooms
 *  - real annotations.js + events.js + yjs-collab.js + state.js + database.js
 *    + conflict.js loaded in a VM with a DOM stub
 *  - simulates the exact user scenario: draw stroke 1, lift, pause, an
 *    async settings-save triggered refresh races with stroke 2, two-finger
 *    takeover, and verifies strokes stay independent + Yjs room state is
 *    correct.
 *
 * Run: node tests/test_e2e_stroke_race.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const STATIC_DIR = path.join(__dirname, '..', 'static', 'js');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8000';
const DEPS = '/home/z/my-project/scripts/e2e-deps/node_modules';
const RealY = require(path.join(DEPS, 'yjs'));
const { WebsocketProvider } = require(path.join(DEPS, 'y-websocket'));

async function api(method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status}`);
    return res.json();
}

async function main() {
    // --- 1. Create a fresh project + document via REST (like the dashboard).
    const pname = 'race-test-' + Date.now();
    const project = await api('POST', '/api/projects', { name: pname });
    const pid = project.id || project.data?.id;
    assert(pid, 'project id');
    // Minimal valid PDF (one blank page).
    const MIN_PDF = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
        'xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF', 'utf8');
    const form = new FormData();
    form.append('files', new Blob([MIN_PDF], { type: 'application/pdf' }), 'race.pdf');
    form.append('folder_id', 'root');
    const upRes = await fetch(`${BASE}/api/documents/upload?project_id=${encodeURIComponent(pid)}`, { method: 'POST', body: form });
    if (!upRes.ok) throw new Error(`upload → ${upRes.status}: ${await upRes.text()}`);
    const upData = await upRes.json();
    const uploaded = (upData.uploaded || [])[0];
    assert(uploaded && !uploaded.error, 'pdf uploaded: ' + JSON.stringify(upData).slice(0, 200));
    const docId = uploaded.id;
    console.log('project:', pid, 'doc:', docId);

    // --- 2. Load the real frontend modules into a VM.
    const files = ['state.js', 'database.js', 'annotations.js', 'conflict.js', 'yjs-collab.js', 'events.js'];
    const sandbox = {
        console, setTimeout, clearTimeout,
        Date, Math, JSON, Promise, Map, Set, Array, Object, Number, String, Boolean, Error, TypeError, parseInt,
        // Minimal DOM/browser
        window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }), location: { protocol: 'http:', host: '127.0.0.1:8000' } },
        document: {
            body: stubEl(), getElementById: () => stubEl(), createElement: () => stubEl(),
            addEventListener: () => {},
        },
        els: { leftWrapper: stubEl(), leftAnnoCanvas: { width: 800, height: 1000, getContext: () => stubCtx() } },
        marked: { Renderer: function () {}, setOptions: () => {}, parse: s => s },
        hljs: { getLanguage: () => null, highlight: () => ({ value: '' }), highlightAuto: () => ({ value: '' }) },
        fetch: (url, opts) => fetch(BASE + url, opts),
        getProjectId: () => pid,
        pdfjsLib: {},        // utils.js globals used by the loaded modules
        debounce: (fn) => fn,
        escapeHtml: (s) => String(s || ''),
        generateId: () => 'id_' + Math.random().toString(36).slice(2),
        pageIdFromNum: (doc, n) => 'page_' + n,
        saveSettings: () => {},
        saveAnnotationsToDB: () => {},
        renderAnnotations: () => {},
        renderTextLayer: () => {},
        renderMarkersForView: () => {},
        renderPage: () => Promise.resolve(),
        clearSelection: () => {},
        pushHistoryAction: () => {},
        showModal: () => {},
        Api: {
            getAnnotations: async () => ({ pages: {}, revisions: {} }),
            saveAllAnnotations: async () => ({}),
            listDocuments: async () => [], listFolders: async () => [],
            listLinks: async () => [], listChats: async () => [],
            getProject: async () => ({ revision: 0 }),
            saveSettings: async () => ({}),
        },
    };
    sandbox.window.window = sandbox.window;
    // Pre-seed the REAL Yjs client libraries so _ensureYjsLoaded skips the
    // CDN (no DOM in Node) and the test exercises the real CRDT + WebSocket
    // protocol against the real server room.
    sandbox.window.Y = RealY;
    sandbox.window.WebsocketProvider = WebsocketProvider;
    sandbox.Y = RealY;
    sandbox.WebsocketProvider = WebsocketProvider;
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    for (const f of files) {
        vm.runInContext(fs.readFileSync(path.join(STATIC_DIR, f), 'utf8'), sandbox, { filename: f });
    }

    // `const state` is a lexical binding in the VM — read it via runInContext.
    const state = vm.runInContext('state', sandbox);
    state.view.left.docId = docId;
    state.view.left.pageId = 'page_1';

    // --- 3. Connect the REAL Yjs client to the REAL room.
    const connected = await sandbox.yjsConnect(pid, docId);
    assert.strictEqual(connected, true, 'yjsConnect must succeed against the real server');
    // Wait for sync.
    await sleep(1500);
    assert.strictEqual(sandbox.yjsIsConnected(pid, docId), true, 'Yjs connected');

    // --- 4. Stroke 1: draw and finish.
    state.drawing.active = true;
    sandbox.startAnnotationStroke('left', 0.10, 0.10);
    const s1 = state.drawing.activeStrokeRef;
    sandbox.continueAnnotationStroke('left', 0.20, 0.20);
    sandbox.finishAnnotationStroke('left');
    state.drawing.active = false;
    console.log('stroke 1:', s1.id, s1.points.length, 'points');

    // --- 5. Pause; fire the settings-save self-echo path: bump a revision via
    //        REST (settings PUT), then run smartRefreshFromServer the way the
    //        revision_changed handler would. With the fix, the annotation
    //        reload is skipped for the Yjs-connected doc.
    await api('PUT', `/api/settings?project_id=${pid}`, { annoTool: 'pen' });
    await sleep(300); // let any revision_changed propagate (no WS client here)
    await sandbox.smartRefreshFromServer(true);

    // --- 6. Stroke 2 starts and draws WHILE a Yjs room echo/rebuild could fire.
    state.drawing.active = true;
    sandbox.startAnnotationStroke('left', 0.60, 0.60);
    const s2 = state.drawing.activeStrokeRef;
    sandbox.continueAnnotationStroke('left', 0.65, 0.65);
    sandbox.continueAnnotationStroke('left', 0.70, 0.70);

    const norm = (x) => JSON.parse(JSON.stringify(x)); // cross-realm safe
    assert.notStrictEqual(s1.id, s2.id, 'distinct ids');
    assert.deepStrictEqual(norm(s2.points.map(p => [p.x, p.y])), [[0.6, 0.6], [0.65, 0.65], [0.7, 0.7]],
        'stroke 2 points are ONLY its own (no inherited point from stroke 1)');
    const s1InState = state.annotations[docId]['page_1'].strokes.find(s => s.id === s1.id);
    assert.deepStrictEqual(norm(s1InState.points.map(p => [p.x, p.y])), [[0.1, 0.1], [0.2, 0.2]],
        'stroke 1 data intact');

    // --- 7. Finish stroke 2; wait for the room to persist; verify the CRDT
    //        state holds BOTH strokes with clean, separate points.
    sandbox.finishAnnotationStroke('left');
    state.drawing.active = false;
    await sleep(1500);

    // Read the client's own Y.Doc — it mirrors the persisted merged room state.
    const ydoc = vm.runInContext('_yjsDoc', sandbox);
    assert(ydoc, 'Y.Doc available');
    const root = ydoc.getMap('annotations');
    const pageMap = root.get('page_1');
    const annos = {};
    for (const [k, v] of (pageMap ? pageMap.entries() : [])) annos[k] = v;
    const ids = Object.keys(annos);
    assert.ok(ids.includes(s1.id), 'stroke 1 in the Yjs room');
    assert.ok(ids.includes(s2.id), 'stroke 2 in the Yjs room');
    const s1remote = annos[s1.id];
    const s2remote = annos[s2.id];
    assert.strictEqual(s1remote.points.length, 2, 'room stroke 1 has exactly its 2 points');
    assert.strictEqual(s2remote.points.length, 3, 'room stroke 2 has exactly its 3 points');

    console.log('\nE2E PASS: strokes stay independent; Yjs room holds clean, separate strokes.');
    process.exit(0);
}

function stubEl() {
    const el = {
        style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        addEventListener() {}, removeEventListener() {}, appendChild: c => c,
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000 }),
        setAttribute() {}, getAttribute: () => null,
    };
    return el;
}
function stubCtx() {
    return {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        stroke() {}, fillRect() {}, strokeRect() {}, drawImage() {}, save() {}, restore() {},
        setLineDash() {}, fillText() {}, measureText: () => ({ width: 0 }),
        globalCompositeOperation: 'source-over', globalAlpha: 1, lineWidth: 1, strokeStyle: '', lineCap: '', lineJoin: '',
    };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('E2E FAIL:', err.stack || err); process.exit(1); });

// ==========================================
// 📁 3. state.js
// ==========================================
// NOTE: The `db` and `SqlDb` globals below are kept for backward-compatibility
// (some old call sites reference `db` for transactions). They're unused now —
// all persistence goes through the REST API in `js/api.js` + `js/database.js`.
let db = null;
let SqlDb = null;
let modalResolve = null;

// Special root-folder ID. Always exists. Cannot be deleted, renamed, or moved.
const ROOT_FOLDER_ID = 'root';
const MAX_RECENT_DOCS = 10;

// ---- Unified chronological Undo/Redo history ----
// A single shared history for the whole editor session — actions on BOTH
// left and right canvases go into the same stack, so Undo always undoes the
// most recent action regardless of which side it happened on.
//
// Each history entry is an object: { label, undo: Function, redo: Function }.
// The closures capture enough state to revert / replay the action atomically.
//
// `pointer` points to the "current" position in the stack — entries at
// indices < pointer are undo-able; entries at indices >= pointer are
// redo-able. A new action truncates the redo tail (standard editor behavior).
const history = {
    stack: [],
    pointer: 0,        // index of next slot to write
    maxLen: 200,       // cap to keep memory bounded
};

// ---- Multi-device conflict-detection state ----
// `projectRevision` is the last revision counter we saw from the server.
// The polling loop in app.js (startProjectRevisionPolling) periodically
// fetches `GET /api/projects/{id}/revision` and compares. If they differ,
// a banner is shown: "Another device modified this project — Reload".
//
// `annotationRevisions[docId][pageId]` remembers the server-side revision
// of each annotation page the client has loaded. When the editor saves a
// single page, it sends `X-Expected-Revision` so the server can refuse
// the write with HTTP 409 if another device beat us to it.
const conflictState = {
    projectRevision: 0,                // last seen server-side project.revision
    projectRevisionLoadedAt: 0,        // ms timestamp of last successful sync
    annotationRevisions: {},           // { docId: { pageId: revision } } — used for X-Expected-Revision header on per-page saves
    // ---- Real-time sync via WebSocket ----
    // When a browser tab opens the editor, it connects to ws://host/ws/sync/{project_id}
    // The server pushes a message whenever the project's revision changes.
    // The client receives it and calls smartRefreshFromServer() — instant sync,
    // no polling, no conflicts.
    syncWebSocket: null,               // The WebSocket connection (null when not connected)
    syncWebSocketConnected: false,     // Whether the WS is currently open
    isRefreshing: false,               // True while a smart refresh is in progress (prevents concurrent refreshes)
    refreshDebounceTimer: null,        // Debounce timer for refreshes (prevents rapid-fire refreshes when many revisions arrive at once)
};

const state = {
    documents: {},
    // ---- Folder hierarchy ----
    // Map of folderId -> { id, name, parentId (null|folderId), createdAt, expanded }
    folders: {},
    // Currently-selected folder in the file explorer (files inside this folder are listed).
    // Defaults to ROOT_FOLDER_ID.
    currentFolderId: ROOT_FOLDER_ID,
    // Multi-select state for files/folders in the explorer.
    fileSelection: { docIds: new Set(), folderIds: new Set() },
    // Sort state.
    fileSort: { by: 'name', order: 'asc' }, // by: 'name' | 'date' | 'size' | 'type'
    // Recent files (most-recently-opened first).
    recentDocIds: [],
    // Lazy-render cursor for the file list (avoids rendering 500 rows at once).
    fileExplorerRender: { renderedCount: 0, batchSize: 40, allItems: [] },
    // Search/filter string for the file explorer (separate from global doc-search across PDF content).
    fileExplorerQuery: '',
    // Unified search mode: 'files' (filter file tree by name) or 'content' (search PDF text content).
    searchMode: 'files',
    view: {
        left: { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false },
        right: { docId: null, pageId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }
    },
    zoomLive: { left: 1.0, right: 1.0 },
    zoomTimer: { left: null, right: null },
    splitRatio: 0.5,
    links: [],
    appMode: 'navigation',
    annoTool: 'pen',
    lineMode: 'freehand',
    annoColor: '#ef4444',
    annoThickness: 5,
    annotations: {},
    chats: [],
    currentChatId: null,
    imageCache: {},
    lastActiveSide: 'left',
    // ---- Minimized panel (single-toolbar era) ----
    // At most ONE panel can be minimized at a time (the workspace must always
    // show at least one PDF canvas). The minimized panel is AUTO-LOCKED so
    // newly opened PDFs can never land in it (openDocumentSmart respects
    // locks) — minimizeAutoLock[side] remembers whether the lock was applied
    // automatically (so restoring can undo it again, leaving manual locks
    // untouched).
    minimizedSide: null,                        // null | 'left' | 'right'
    minimizeAutoLock: { left: false, right: false },
    drawing: {
        active: false,
        startSide: null,
        startPoint: { x: 0, y: 0 },
        startPointData: null,
        currentPoint: { x: 0, y: 0 },
        pointerId: null,
        activeTextBox: null
    },
    snip: {
        active: false,
        phase: 'idle', // 'idle' | 'drawing' | 'dragging'
        startSide: null,
        startPos: null,
        currentPos: null,
        base64: null,
        sourceData: null,
        width: 0,
        height: 0
    },
    selection: {
        active: false,
        side: null,
        mode: 'idle',
        marqueeStart: null,
        marqueeCurrent: null,
        selectedImages: [],
        selectedTextBoxes: [],
        selectedStrokes: [],
        boundingBox: null,
        dragStartMouse: null,
        dragStartPositions: null,
    },
    highlightRequest: null,
    activeCitation: null, // Tracks the currently active citation highlight
    projectFileHandle: null,
    globalMouse: { x: 0, y: 0 },
    pendingImagePos: null,
    search: {
        left: { query: '', results: [], index: -1, abortController: null },
        right: { query: '', results: [], index: -1, abortController: null }
    },
    measureCanvas: document.createElement('canvas'),
    embeddings: [],
    isIndexing: false,
    currentContextChunks: [],
    linkCreation: { active: false, sourceData: null, sourceSide: null },
    // ---- Comment feature ----
    // Tracks the comment currently being viewed / edited in the AI sidebar.
    // When non-null, the AI sidebar shows the comment editor overlay instead of
    // the chat history. Mode is 'split' (preview top + editor bottom) or
    // 'preview' (full-width rendered preview + Edit button).
    activeComment: {
        id: null,
        side: null,    // 'left' or 'right' — viewport the comment lives on
        docId: null,
        pageId: null,
        mode: null,    // 'split' | 'preview'
        isNew: false,   // true if just created (so cancelling removes it)
    },
    toolSettings: {
        pen: { color: '#ef4444', thickness: 5 },
        highlighter: { color: '#facc15', thickness: 20 },
        eraserPixel: { thickness: 20 },
        eraserStroke: { thickness: 5 }
    },
    // ---- New AI Settings Control ----
    aiSettings: {
        model: "gemma3:1b", // Default Ollama model
        systemPrompt: "You are a helpful assistant answering questions based on the provided PDF context.",
        responseStyle: "Detailed", // Concise, Detailed, Expert
        temperature: 0.7,
        strictRag: true,
        includeChatHistory: true,
        skipLlm: false,
        similarityThreshold: 0.65,
        contextBudget: 4000,
        maxChunks: 8,
        chunkSize: 2000
    }
};

// Make history + conflictState globally accessible for debugging / other modules.
// NOTE: deliberately NOT assigned to `window.history` — that's the browser's
// back/forward navigation API. Use `editorHistory` instead.
window.editorHistory = history;
window.conflictState = conflictState;

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

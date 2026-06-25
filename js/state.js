// ==========================================
// 📁 3. state.js
// ==========================================
let db;
let SqlDb; 
let modalResolve = null;

const state = {
    documents: {}, 
    view: {
        left: { docId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, 
        right: { docId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false } 
    },
    zoomLive: { left: 1.0, right: 1.0 }, 
    zoomTimer: { left: null, right: null }, 
    splitRatio: 0.5,
    links: [], 
    appMode: 'navigation', 
    annoTool: 'pen', 
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
        includeChatHistory: true, // <--- Added option to include chat history
        skipLlm: false,
        similarityThreshold: 0.65,
        contextBudget: 4000,
        maxChunks: 8,
        chunkSize: 500
    }
};
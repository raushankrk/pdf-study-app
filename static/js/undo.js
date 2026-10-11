// Per-PDF undo/redo history. Each document keeps an independent timeline so
// toolbar actions only operate on the currently active PDF.

function getActiveHistorySide() {
    if (!state || !state.view) return null;
    const preferred = state.lastActiveSide === 'right' ? 'right' : 'left';
    if (state.view[preferred] && state.view[preferred].docId) return preferred;
    // If the remembered side is empty, use the other occupied viewport rather
    // than silently disabling actions or falling back to an unrelated PDF.
    const other = preferred === 'right' ? 'left' : 'right';
    return state.view[other] && state.view[other].docId ? other : null;
}

function getActiveHistoryDocId() {
    const side = getActiveHistorySide();
    return side && state.view[side] ? state.view[side].docId : null;
}

function getHistoryBucket(docId, create = true) {
    if (!docId) return null;
    if (!history.byDocId[docId] && create) {
        history.byDocId[docId] = { stack: [], pointer: 0 };
    }
    return history.byDocId[docId] || null;
}

function pushHistoryAction(label, undo, redo, docId = null) {
    if (!history || typeof undo !== 'function' || typeof redo !== 'function') return;

    // Prefer a side explicitly encoded in the label; otherwise use the active
    // PDF at the time the action was created.
    if (!docId) {
        const sideMatch = String(label || '').match(/\((left|right)\)/i);
        const side = sideMatch ? sideMatch[1].toLowerCase() : null;
        docId = side && state.view[side] ? state.view[side].docId : getActiveHistoryDocId();
    }
    if (!docId) return;

    const bucket = getHistoryBucket(docId);
    bucket.stack = bucket.stack.slice(0, bucket.pointer);
    bucket.stack.push({ label, undo, redo, docId });
    bucket.pointer = bucket.stack.length;
    if (bucket.stack.length > history.maxLen) {
        const overflow = bucket.stack.length - history.maxLen;
        bucket.stack.splice(0, overflow);
        bucket.pointer = Math.max(0, bucket.pointer - overflow);
    }
}

function renderHistoryDocument(docId) {
    if (!docId) return;
    ['left', 'right'].forEach(side => {
        if (state.view[side].docId !== docId) return;
        if (typeof renderAnnotations === 'function') renderAnnotations(side);
        if (typeof renderTextLayer === 'function') renderTextLayer(side);
        if (typeof renderMarkersForView === 'function') renderMarkersForView(side);
    });
}


function persistHistoryDocument(docId) {
    if (!docId || !state.annotations || !state.annotations[docId]) return;

    const connected = typeof yjsIsConnected === 'function' &&
        yjsIsConnected(getProjectId(), docId);

    if (connected && typeof yjsReplacePage === 'function') {
        // History callbacks do not all update Yjs themselves (notably
        // Delete Selection). Reconcile every page after undo/redo so the
        // collaboration store cannot restore the pre-action annotation.
        const pages = state.annotations[docId];
        Object.keys(pages).forEach(pageId => {
            const page = pages[pageId] || { strokes: [], images: [], textBoxes: [] };
            yjsReplacePage(docId, pageId, page);
        });
        return;
    }

    // Without Yjs, save the final post-action snapshot. Catch the async
    // request here because toolbar handlers are intentionally synchronous.
    if (typeof saveAnnotationsToDB === 'function') {
        Promise.resolve(saveAnnotationsToDB(docId, state.annotations[docId]))
            .catch(err => console.warn('[history] Could not persist annotation history action:', err));
    }
}

function undoLastAction() {
    // Resolve the active document once per click. Each document owns an
    // independent undo stack; never consume the other open PDF's history.
    const docId = getActiveHistoryDocId();
    if (!docId) return;
    const bucket = getHistoryBucket(docId, false);
    if (!bucket || bucket.pointer <= 0) {
        // Keep legacy stroke undo available, but restrict it to the active PDF.
        if (typeof undoLastStroke === 'function') {
            undoLastStroke();
            persistHistoryDocument(docId);
            renderHistoryDocument(docId);
        }
        return;
    }
    const action = bucket.stack[bucket.pointer - 1];
    try {
        action.undo();
        bucket.pointer--;
        persistHistoryDocument(docId);
        renderHistoryDocument(docId);
    } catch (err) {
        console.warn('[undo] action.undo() threw:', err);
    }
}

function redoNextAction() {
    // Resolve the active document once per click. Redo is scoped to the same
    // per-document timeline as undo.
    const docId = getActiveHistoryDocId();
    if (!docId) return;
    const bucket = getHistoryBucket(docId, false);
    if (!bucket || bucket.pointer >= bucket.stack.length) return;
    const action = bucket.stack[bucket.pointer];
    try {
        action.redo();
        bucket.pointer++;
        persistHistoryDocument(docId);
        renderHistoryDocument(docId);
    } catch (err) {
        console.warn('[redo] action.redo() threw:', err);
    }
}

function clearHistory(docId = null) {
    if (docId) {
        delete history.byDocId[docId];
        return;
    }
    history.byDocId = {};
}

window.pushHistoryAction = pushHistoryAction;
window.undoLastAction = undoLastAction;
window.redoNextAction = redoNextAction;
window.clearHistory = clearHistory;

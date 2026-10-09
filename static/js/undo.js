// Per-PDF undo/redo history. Each document keeps an independent timeline so
// toolbar actions only operate on the currently active PDF.

function getActiveHistoryDocId() {
    const side = state && state.lastActiveSide === 'right' ? 'right' : 'left';
    return state && state.view && state.view[side] ? state.view[side].docId : null;
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

function undoLastAction() {
    const docId = getActiveHistoryDocId();
    if (!docId) return;
    const bucket = getHistoryBucket(docId, false);
    if (!bucket || bucket.pointer <= 0) {
        // Keep legacy stroke undo available, but restrict it to the active PDF.
        if (typeof undoLastStroke === 'function') undoLastStroke();
        return;
    }
    const action = bucket.stack[bucket.pointer - 1];
    try { action.undo(); }
    catch (err) { console.warn('[undo] action.undo() threw:', err); }
    bucket.pointer--;
    renderHistoryDocument(docId);
}

function redoNextAction() {
    const docId = getActiveHistoryDocId();
    if (!docId) return;
    const bucket = getHistoryBucket(docId, false);
    if (!bucket || bucket.pointer >= bucket.stack.length) return;
    const action = bucket.stack[bucket.pointer];
    try { action.redo(); }
    catch (err) { console.warn('[redo] action.redo() threw:', err); }
    bucket.pointer++;
    renderHistoryDocument(docId);
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

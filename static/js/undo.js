// ==========================================
// 📁 undo.js — Unified chronological undo/redo history
// ==========================================
// A single shared history for the whole editor session — actions on BOTH
// left and right canvases go into the same stack, so Undo always undoes
// the most recent action regardless of which side it happened on.
//
// Each history entry is an object: { label, undo: Function, redo: Function }.
// The closures capture enough state to revert / replay the action atomically.
//
// `pointer` points to the "current" position in the stack — entries at
// indices < pointer are undo-able; entries at indices >= pointer are
// redo-able. A new action truncates the redo tail (standard editor behavior).
//
// ---- Action types we record ----
//   * Stroke add (pen / highlighter / pixel-eraser)
//   * Stroke delete (stroke-eraser hit)
//   * Image add
//   * Image delete
//   * Text box add
//   * Text box delete
//   * Selection move / resize (a single drag = one history entry)
//   * Snip & link drop (image add + link add combined)
//   * Manual link add / delete
//   * Clear page annotations
//
// We deliberately DON'T record: zoom, scroll, page navigation, mode switches,
// folder expand/collapse, sidebar toggles — these are not annotation changes
// and undoing them would feel wrong.
// ==========================================

/**
 * Push a new undoable action onto the shared history stack.
 * Truncates the redo tail (any entries after `pointer` are discarded).
 * @param {string} label — short human-readable label, e.g. "Stroke add (left)"
 * @param {Function} undo — closure that reverts the action
 * @param {Function} redo — closure that re-applies the action (after undo)
 */
function pushHistoryAction(label, undo, redo) {
    if (!history || typeof undo !== 'function' || typeof redo !== 'function') return;
    // Truncate the redo tail — once you make a new edit, you can't redo
    // anything you undid before that edit.
    history.stack = history.stack.slice(0, history.pointer);
    history.stack.push({ label, undo, redo });
    history.pointer = history.stack.length;
    // Cap the history length — drop the oldest entries when we hit the limit.
    if (history.stack.length > history.maxLen) {
        const overflow = history.stack.length - history.maxLen;
        history.stack.splice(0, overflow);
        history.pointer = Math.max(0, history.pointer - overflow);
    }
}

/**
 * Pop the most recent action and run its undo callback.
 * Re-enables redo for that action.
 */
function undoLastAction() {
    if (history.pointer <= 0) {
        // Nothing to undo — fall back to the legacy undo behavior (per-side
        // stroke pop) so we don't break any existing muscle memory when no
        // history entry has been pushed yet (e.g. before this update lands).
        if (typeof undoLastStroke === 'function') undoLastStroke();
        return;
    }
    const action = history.stack[history.pointer - 1];
    try {
        action.undo();
    } catch (err) {
        console.warn('[undo] action.undo() threw:', err);
    }
    history.pointer--;
    // Re-render the affected side(s) so the undo is visible. The closure
    // should have captured the side; we don't know it here generically, so
    // we just refresh both to be safe (cheap if no doc is loaded).
    try {
        if (typeof renderAnnotations === 'function') {
            if (state.view.left.docId) renderAnnotations('left');
            if (state.view.right.docId) renderAnnotations('right');
        }
        if (typeof renderTextLayer === 'function') {
            if (state.view.left.docId) renderTextLayer('left');
            if (state.view.right.docId) renderTextLayer('right');
        }
        if (typeof renderMarkersForView === 'function') {
            renderMarkersForView('left');
            renderMarkersForView('right');
        }
    } catch (e) { /* renderers may not be ready */ }
}

/**
 * Re-apply the next action in the redo stack.
 */
function redoNextAction() {
    if (history.pointer >= history.stack.length) return;
    const action = history.stack[history.pointer];
    try {
        action.redo();
    } catch (err) {
        console.warn('[redo] action.redo() threw:', err);
    }
    history.pointer++;
    try {
        if (typeof renderAnnotations === 'function') {
            if (state.view.left.docId) renderAnnotations('left');
            if (state.view.right.docId) renderAnnotations('right');
        }
        if (typeof renderTextLayer === 'function') {
            if (state.view.left.docId) renderTextLayer('left');
            if (state.view.right.docId) renderTextLayer('right');
        }
        if (typeof renderMarkersForView === 'function') {
            renderMarkersForView('left');
            renderMarkersForView('right');
        }
    } catch (e) { /* renderers may not be ready */ }
}

/**
 * Clear the entire history (e.g. when switching projects).
 */
function clearHistory() {
    history.stack = [];
    history.pointer = 0;
}

// Expose globally for inline onclick handlers and other modules.
window.pushHistoryAction = pushHistoryAction;
window.undoLastAction = undoLastAction;
window.redoNextAction = redoNextAction;
window.clearHistory = clearHistory;

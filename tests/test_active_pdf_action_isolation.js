/**
 * Regression tests: undo/redo and destructive annotation actions stay scoped
 * to the currently active PDF document.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const root = path.join(__dirname, '..');
const undoSource = fs.readFileSync(path.join(root, 'static/js/undo.js'), 'utf8');
const annotationsSource = fs.readFileSync(path.join(root, 'static/js/annotations.js'), 'utf8');

const sandbox = {
  console,
  state: {
    lastActiveSide: 'left',
    view: {
      left: { docId: 'doc-a', pageId: 'page-1' },
      right: { docId: 'doc-b', pageId: 'page-1' }
    },
    annotations: {
      'doc-a': { 'page-1': { strokes: [], images: [], textBoxes: [] } },
      'doc-b': { 'page-1': { strokes: [], images: [], textBoxes: [] } }
    }
  },
  history: { byDocId: {}, maxLen: 200 },
  window: {},
  renderCalls: [],
  persisted: [],
  saveAnnotationsToDB: (docId, data) => sandbox.persisted.push(docId),
  yjsIsConnected: () => false,
  getProjectId: () => 'project',
  renderAnnotations: (side) => sandbox.renderCalls.push(['annotations', side]),
  renderTextLayer: (side) => sandbox.renderCalls.push(['text', side]),
  renderMarkersForView: (side) => sandbox.renderCalls.push(['markers', side]),
};
vm.createContext(sandbox);
vm.runInContext(undoSource, sandbox);

let a = 0, b = 0;
sandbox.pushHistoryAction('change A', () => { a--; }, () => { a++; }, 'doc-a');
sandbox.pushHistoryAction('change B', () => { b--; }, () => { b++; }, 'doc-b');

sandbox.state.lastActiveSide = 'left';
sandbox.undoLastAction();
assert.strictEqual(a, -1, 'undo on active PDF A runs A history');
assert.strictEqual(b, 0, 'undo on PDF A must not touch PDF B');
assert.strictEqual(sandbox.history.byDocId['doc-a'].pointer, 0);
assert.strictEqual(sandbox.history.byDocId['doc-b'].pointer, 1);
assert(sandbox.persisted.includes('doc-a'), 'undo persists the active PDF annotation snapshot');

sandbox.state.lastActiveSide = 'right';
sandbox.undoLastAction();
assert.strictEqual(a, -1, 'undo on PDF B must not touch PDF A');
assert.strictEqual(b, -1, 'undo on active PDF B runs B history');

sandbox.redoNextAction();
assert.strictEqual(b, 0, 'redo on PDF B redoes only B history');
assert.strictEqual(a, -1, 'redo on PDF B must not touch PDF A');
assert(sandbox.persisted.includes('doc-b'), 'redo persists the active PDF annotation snapshot');

// When collaboration is active, post-action snapshots must be pushed to Yjs,
// otherwise the old shared annotation can be replayed and visually reappear.
sandbox.yjsPages = [];
sandbox.yjsIsConnected = () => true;
sandbox.yjsReplacePage = (docId, pageId, pageData) => sandbox.yjsPages.push({ docId, pageId });
sandbox.state.lastActiveSide = 'left';
sandbox.redoNextAction();
sandbox.undoLastAction();
assert(sandbox.yjsPages.length > 0, 'undo/redo reconciles annotation pages to Yjs');
assert(sandbox.yjsPages.every(page => page.docId === 'doc-a'), 'Yjs history sync only touches active PDF A');

assert.match(annotationsSource, /function deleteSelection\(\)[\s\S]*?pushHistoryAction\([\s\S]*?docId\s*\n\s*\);/,
  'delete-selection history is explicitly bound to the affected document');
assert.match(annotationsSource, /function clearCurrentPageAnnotations\(\)[\s\S]*?pushHistoryAction\([\s\S]*?, dId\s*\)/,
  'clear-page history is explicitly bound to the affected document');
console.log('PASS: active PDF undo/redo isolation, persistence, and destructive-action ownership checks');

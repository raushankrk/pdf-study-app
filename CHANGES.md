# Annotation / Touch Interaction Bug Fixes

This document summarizes the root-cause fixes applied in this patch.

## Bug 1 — Pen/Highlighter tool switching

**Symptom**: Sometimes the user selects **Pen**, but drawing produces a
**Highlighter** stroke instead (fat, yellow, multiply-blend).

**Root cause**: `continueAnnotationStroke` (in `static/js/annotations.js`)
read `state.annoTool` to decide the rendering parameters
(`globalCompositeOperation`, `globalAlpha`, `lineWidth` multiplier,
`strokeStyle`). If `state.annoTool` flipped mid-stroke — e.g. the user
fat-fingered a keyboard shortcut, OR a remote `revision_changed` event
tripped `smartRefreshFromServer`, OR another device's settings save
echoed through — the in-progress rendering switched tool, even though
the stroke's own `tool` field (stamped at creation time in
`startAnnotationStroke`) was still the original tool.

**Fix**:
- `startAnnotationStroke` now snapshots `state.annoTool`/`state.annoColor`/
  `state.annoThickness` into local consts at the very top, before the
  stroke object is created. The stroke's `tool`/`color`/`size` fields
  are the source of truth from this point on.
- `continueAnnotationStroke` now reads `currentStroke.tool` (and
  `currentStroke.color`) instead of `state.annoTool`/`state.annoColor`.
  This guarantees the in-progress rendering matches the stroke's
  intended tool, regardless of what `state.annoTool` does mid-stroke.
- `setAnnoTool` (in `static/js/ui.js`) now carries a top-of-file comment
  stating that it is the ONLY legitimate mutator of `state.annoTool` and
  must NEVER be called from a remote-sync code path. Each user's
  selected tool stays local to that user/device.

**What was NOT changed**:
- The Yjs collaboration layer still syncs annotation DATA (each
  stroke/image/textbox carries its own `tool`/`color`/etc. fields).
- The Yjs Awareness layer was already NOT syncing `state.annoTool`
  (it only syncs `user.name`, `user.color`, `pageId`, `annoId`, `side`,
  `ts`). Verified.
- The project-level settings (saved via `saveSettings()`) still
  persist `annoTool`/`annoColor`/`annoThickness` so the last-used tool
  is restored on a page reload. This is intentional project-level
  state, not per-session sync.
- `smartRefreshFromServer` (in `static/js/conflict.js`) was already
  NOT touching `state.annoTool`. Verified and unchanged.

## Bug 2 — Annotation/Image movement rendering

**Symptom**: Sometimes when dragging an annotation or image, the blue
selection boundary moves but the actual object stays at its old
position on the canvas.

**Root cause**: When a Yjs remote update arrives mid-drag (e.g. another
user edits a DIFFERENT annotation on the same page), `_yjsOnUpdate`
(in `static/js/yjs-collab.js`) rebuilds `state.annotations[docId][pageId]`
from the Yjs room state. The rebuild creates fresh object instances via
`{ ...annoData, id: annoId }` — different object references than the ones
in `state.selection.selectedImages`/`selectedTextBoxes`/`selectedStrokes`.

After the rebuild, the selection's arrays hold STALE references. The next
`handlePointerMove` calls `img.x += dx` on the orphan, not on the live
image. `renderAnnotations` reads from `state.annotations[docId][pageId]`
(which has the new, untouched image at its old position) and draws it
there. The blue selection bounding box (which lives on
`state.selection.boundingBox`) is updated independently, so it moves
while the object stays put.

**Fix** (multi-layer defense):

1. **Layer 1 — In-flight markers** (`static/js/events.js`):
   - When a drag or resize STARTS, we now call `yjsBeginInFlight(annoId)`
     for every selected annotation (in addition to the existing
     `yjsClaimLock` call). This causes `_yjsOnUpdate` to SKIP those
     annotations during the rebuild, so the local in-progress drag
     state is preserved.
   - When the drag or resize ENDS (`handlePointerUp`), we now call
     `yjsEndInFlight(annoId)` AFTER the final `yjsSetAnnotation` push.
     This unblocks future remote updates.
   - For the fresh-image-textbox click paths (where the user clicks
     directly on an image/textbox without a prior selection), we
     also call `yjsBeginInFlight`.
   - `clearSelection` (in `static/js/annotations.js`) now defensively
     calls `yjsEndInFlight` on any previously-selected annotations, so
     in-flight markers don't leak if the user presses Esc mid-drag.

2. **Layer 2 — Re-link after Yjs rebuild** (`static/js/yjs-collab.js`):
   - New helper `_relinkSelectionAfterYjsUpdate(docId)`: after each
     Yjs rebuild, walks the selection's `selectedImages`/
     `selectedTextBoxes`/`selectedStrokes` arrays and re-links each
     reference by ID to the canonical object now in
     `state.annotations[docId][pageId]`. If a selected object's
     x/y/points have been mutated by an in-progress drag, those
     mutations are copied onto the live object so the drag
     continues smoothly.

3. **Layer 3 — Defensive re-link in the drag handler** (`static/js/events.js`):
   - New helper `_refreshSelectionReferences(side)`: called at the top
     of the drag and resize branches of `handlePointerMove`. Belt-and-
     suspenders safety net that re-links the selection references
     before any mutation, in case a remote update slipped through
     Layers 1 and 2.

**What was NOT changed**:
- The Yjs collaboration layer still syncs annotation data correctly.
- Undo/redo, touch controls, two-finger pan/zoom, and project isolation
  are all preserved.
- The REST save path (`saveAnnotationsToDB`) and the per-page conflict
  detection (`X-Expected-Revision` / HTTP 409) are unchanged.

## Files changed

| File | Change |
|------|--------|
| `static/js/annotations.js` | `startAnnotationStroke` snapshots tool/color/thickness locally; `continueAnnotationStroke` uses `currentStroke.tool` instead of `state.annoTool`; `clearSelection` defensively ends in-flight markers. |
| `static/js/yjs-collab.js` | New helper `_relinkSelectionAfterYjsUpdate` re-links selection references by ID after every Yjs rebuild. |
| `static/js/events.js` | Drag/resize start calls `yjsBeginInFlight`; drag/resize end calls `yjsEndInFlight`; fresh-image/textbox click paths also call `yjsBeginInFlight`; new helper `_refreshSelectionReferences` re-links before mutation in drag/resize handlers. |
| `static/js/ui.js` | `setAnnoTool` carries an explicit "local-only" invariant comment. |

## Tests

| File | What it covers |
|------|----------------|
| `tests/test_realtime_sync.py` | Existing 7-test suite — verifies no regression in the real-time sync WebSocket, revision bumping, propagation speed, and absence of a pause-sync feature. |
| `tests/test_annotation_movement_sync.py` | **NEW** — 4 backend tests covering: (1) annotation move persists at new x/y; (2) Yjs bootstrap endpoint reachable; (3) project isolation (no leak across projects); (4) move → bulk-save → move again (no regression in the bulk-save path). |
| `tests/test_frontend_bugs.js` | **NEW** — 10 frontend tests covering both bugs using a minimal browser stub + Node `vm`: (1.1) `startAnnotationStroke` stamps `state.annoTool` onto the stroke; (1.2) `continueAnnotationStroke` uses `currentStroke.tool` not `state.annoTool`; (1.3) pen stroke stays pen even if `state.annoTool` flips; (1.4) highlighter stroke stays highlighter; (1.4b) rendering uses multiply + 0.4 alpha; (2.1) `_relinkSelectionAfterYjsUpdate` re-links stale image; (2.2) re-links stale stroke; (2.3) no-op when already correct; (2.4) `clearSelection` ends in-flight markers; (2.5) `_refreshSelectionReferences` re-links before mutation. |

### Running the tests

Start the server (the Python tests need it):

```bash
cd pdf-linker-studio-server
./run.sh   # or: .venv/bin/python -m uvicorn server.main:app --port 8000
```

In a separate terminal:

```bash
cd pdf-linker-studio-server

# Frontend tests (don't need the server):
node tests/test_frontend_bugs.js

# Backend tests (need the server running):
.venv/bin/python tests/test_realtime_sync.py --port 8000
.venv/bin/python tests/test_annotation_movement_sync.py --port 8000
```

All three suites should report 0 failures.

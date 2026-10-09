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

---

# Bug 3 — New stroke connects to the previous stroke (Yjs / touch devices)

**Symptom** (see Recording.gif): when drawing with the pen/highlighter, a new
stroke sometimes starts at the END POINT of the previous stroke — a straight
connecting segment is drawn between them. Most visible on touch devices
(iPad / Android tablets) when the user lifts the pen, pauses, or pans/zooms
between strokes. Appeared after the Yjs collaboration layer was added.

**Root cause** (two layers):

1. *Positional stroke lookup.* `continueAnnotationStroke` (and the
   straight-line preview/lock-in) located the active stroke with
   `strokes[strokes.length - 1]` instead of the reference already recorded at
   pointerdown (`state.drawing.activeStrokeRef`). That assumption breaks
   whenever `state.annotations[docId]` (or the per-page object) is
   wholesale-replaced while a stroke is in progress: the in-flight stroke is
   not in the replaced snapshot, so `strokes[len-1]` silently becomes the
   PREVIOUS stroke, and every subsequent pointermove appends the new stroke's
   points into it — drawing a straight segment from the previous stroke's end
   point to the pen position.

2. *Destructive async replacement mid-stroke.* The replacement itself comes
   from `smartRefreshFromServer()` → `loadAnnotationsFromServer()`, which
   assigns `state.annotations[docId] = pages` with NO in-flight protection.
   It is triggered by `revision_changed` WebSocket messages — and the server
   broadcasts those to ALL connections INCLUDING the writer, so the device's
   own `saveSettings()` calls (scroll, zoom, page nav, tool/color changes —
   frequent on touch devices) self-trigger a refresh ~0.5–1.5s later, which
   routinely lands inside the next stroke. With Yjs connected,
   `finishAnnotationStroke` intentionally skips REST saves, so the REST
   snapshot is stale — every such replacement destroyed Yjs-era strokes and
   orphaned the stroke being drawn. (Pre-Yjs, each stroke REST-saved on
   pointerup, so replacements were fresh and the corruption window was far
   less visible.)

**Fix** (smallest safe change set; Yjs collaboration fully preserved):

- `static/js/annotations.js` — new `resolveActiveStroke(docId, pageId)`:
  the active stroke is tracked BY REFERENCE (`state.drawing.activeStrokeRef`)
  and re-linked BY ID (or re-appended) if an async replacement dropped it.
  `continueAnnotationStroke` now uses it, so points can never be appended
  into the wrong stroke. Also guards against a vanished page object.
- `static/js/events.js` — the straight-line preview (pointermove) and the
  pointerup lock-in use `resolveActiveStroke` too (they used to overwrite
  `strokes[len-1]`, which could be the wrong stroke).
- `static/js/events.js` — `_cancelDrawingAndCleanStroke` (two-finger
  takeover) now removes the active stroke BY IDENTITY (not "pop last"),
  clears `activeStrokeRef`, ends the Yjs in-flight marker, and deletes the
  partial stroke from the Yjs room (it used to resurrect as a ghost).
- `static/js/events.js` + `static/js/app.js` — NEW `handlePointerCancel`
  bound to window `pointercancel`. iPadOS/Android fire pointercancel on
  pause/long-press/gesture takeover; previously the gesture state machine
  stayed half-open. Now: tiny (≤3-point) accidental marks are cancelled and
  removed; real strokes are finalized exactly like a pointerup (undo entry +
  final Yjs push + in-flight cleanup); select-tool drags release locks and
  end in-flight markers.
- `static/js/database.js` — `loadAnnotationsFromServer` re-attaches the
  locally in-progress stroke after the wholesale replacement (success AND
  error paths) via `_preserveInFlightStrokeInLoadedState`.
- `static/js/conflict.js` — `smartRefreshFromServer` skips the legacy REST
  annotation reload for docs whose Yjs room is connected (Yjs is the source
  of truth there; the REST snapshot is intentionally stale). Non-Yjs docs
  still refresh normally. Yjs itself keeps syncing through its own
  WebSocket — nothing about collaboration was disabled.
- `static/js/events.js` — the eraser-stroke pointerup no longer bulk-REST-
  saves while Yjs is connected (deletions already go through
  `yjsSetAnnotation(id, null)` in `deleteStrokeAt`; the extra bulk save
  fought the Yjs-merged state and bumped the revision self-echo chain).

**Tests**:
- `tests/test_stroke_continuity.js` — 23 tests in 7 suites covering the
  mid-stroke replacement regression, the lift/pause independence scenario,
  stale-clone canonicalization, straight-line mode, two-finger cleanup,
  pointercancel semantics, REST-reload preservation, smartRefresh skip for
  Yjs docs, and the Yjs-connected lifecycle.
- `tests/test_e2e_stroke_race.js` — end-to-end: real project + PDF + real
  Yjs WebSocket room against the running server; settings-save race mid-
  stroke; verifies the CRDT room holds both strokes with clean points.

---

# UI Refactor — One Active-PDF toolbar in the main header

**Goal**: save vertical space by removing the two per-PDF toolbars
(the `h-10` bars above PDF A / PDF B) and hosting **one** PDF tools
toolbar in the main header that always operates on the **currently
active PDF**.

**New layout**: `Main Header → PDF Tools → PDF A / PDF B Workspace`

**What changed**:

- `static/index.html`
  - Removed both per-PDF `h-10` toolbars (lock / title / find / zoom /
    page nav / insert-duplicate-delete page) above the two viewports.
  - Added a single "Active PDF" toolbar group to the main header:
      `[ A: file-a.pdf | B: file-b.pdf ]  [ lock | find | zoom | page | ops ]`
  - The A / B tabs select the active PDF and show each document's
    filename (the spans keep the historical `left-view-title` /
    `right-view-title` IDs, so `renderPage()` keeps writing the names).
  - The controls block exists once per side (`#pdf-controls-left` /
    `#pdf-controls-right`) with the ORIGINAL element IDs and onclick
    handlers — only the ACTIVE side's block is visible.
  - The 4px page-scrub sliders stay in the panels (touch page scrubbing).
- `static/css/style.css`
  - `.pdf-tab` / `.pdf-tab-badge(-a|-b)` / `.pdf-tab-title` /
    `.pdf-tab-active` styles (desktop + touch tap targets).
  - Visibility rule: `body[data-active-pdf="left"]  #pdf-controls-right`
    and `body[data-active-pdf="right"] #pdf-controls-left` are hidden —
    pure CSS, driven by `updateViewportActiveVisuals()`.
  - The header is now horizontally scrollable on ALL viewports (it was
    touch-only before) with a hidden scrollbar, and the Active-PDF
    toolbar compacts below 1600px (shorter tab titles, slimmer buttons).
- `static/js/ui.js`
  - New `setActivePdf(side)` — makes that PDF active (header tabs,
    controls visibility, viewport ring), persists on real switches,
    never touches drawing/mode state (safe mid-gesture).
  - `updateViewportActiveVisuals()` now also writes
    `document.body.dataset.activePdf` and toggles `.pdf-tab-active`.
- `static/js/pdf.js` — `renderPage()` refreshes the active-PDF visuals so
  doc-open / page-nav / slider paths (which set `lastActiveSide` without a
  pointer event) immediately update the header.
- `static/js/events.js` — ctrl+wheel zoom and scroll/pan activate the PDF
  under the cursor; click/tap-to-activate was already handled by
  `handlePointerDown` (mouse, touch, Apple Pencil all emit pointerdown).
- `static/js/database.js` — `saveSettings()` persists `activeSide`.
- `static/js/app.js` — boot restores the saved active PDF (falls back to
  the side that has a document); header wheel → horizontal scroll when
  the header overflows.
- Cache-busting versions bumped (`?v=activepdf-v11`).

**Preserved by design**: all annotation tools, modes, undo/redo, image
placement, paste targeting, Snip & Link and cross-PDF linking are
pointer-driven (`clickedSide` / `lastActiveSide`) and were not modified.
The hidden side's controls still receive DOM updates, so switching tabs
always shows fresh values.

---

# Bug 4 — Undo/Redo of a stroke silently failed after a Yjs rebuild

**Symptom**: with Yjs connected, drawing a stroke and immediately pressing
Ctrl+Z sometimes did nothing (and Ctrl+Y then added a duplicate stroke).
Observed during browser testing of the toolbar refactor; pre-existing
(introduced by the Yjs observer rebuild, not by the refactor).

**Root cause**: the stroke-add history entry in `finishAnnotationStroke`
removed the stroke by object identity (`arr.indexOf(strokeRef)`). The Yjs
observer rebuilds pages into FRESH objects (`{ ...annoData, id: annoId }`),
so after any rebuild the captured reference no longer matched — undo's
splice became a no-op and redo pushed a duplicate.

**Fix**: `static/js/annotations.js` — the closure's `findIdx()` now looks
the stroke up by `id` first and falls back to identity; undo uses it for
the splice and redo uses it for the "already present?" check, so no
duplicates can be produced.

**Test**: `tests/test_undo_yjs_rebuild.js` — 5 tests: undo/redo after a
simulated rebuild (fresh objects, same ids), no duplicate ids, identity
path preserved, local (non-Yjs) mode still works.

---

# Bug 5 — Blank strip above BOTH PDFs on iPad / touch devices

**Symptom**: after the single-toolbar refactor removed the per-PDF
toolbars, a ~57px strip of blank gray space still sat between the main
header and the PDF pages on touch devices (iPad / Android tablets /
phones) — see the user's iPad screenshot (red box). Desktops were
unaffected.

**Root cause**: two STALE rules inside
`@media (hover: none), (pointer: coarse)` in `static/css/style.css` were
written for the per-PDF toolbars that no longer exist:

```css
#left-panel > div:first-child,
#right-panel > div:first-child {
    flex-wrap: wrap;
    min-height: 48px;
    height: auto !important;   /* overrides the inline height:4px */
    padding-top: 4px;
    padding-bottom: 4px;
}
#left-panel > div:first-child button,
#right-panel > div:first-child button { ... }
```

They used POSITIONAL selectors. When the toolbars were removed,
`div:first-child` became the **4px page-scrub slider bar** (inline
`style="height: 4px"`). A stylesheet `!important` declaration beats a
normal inline style, so `height: auto !important` + `min-height: 48px` +
the 4px paddings inflated the bar to ~57px on every device matching the
media query — which includes iPad (iPadOS reports `hover: none`) but not
desktops (`hover: hover` + `pointer: fine`), exactly matching the
device-specific symptom. The blue slider thumb at the top of the strip in
the screenshot was the giveaway.

**Fix**: both stale rules were REMOVED from the touch media block (with
explanatory comments left behind so the positional selectors are not
re-introduced). The slider bar keeps its inline `height: 4px` everywhere.

**Measured verification** (headless Chromium, `hover: none` active — the
iPad signal):

| state                    | slider bar | page top |
|--------------------------|-----------:|---------:|
| stale rule re-injected   |     57px   |   120px  |
| fixed (shipped)          |      4px   |    76px  |

44px of dead vertical space reclaimed above EACH PDF on tablets.

**Test**: `tests/test_touch_slider_space.js` — 8 tests: no stale
`#left/right-panel > div:first-child` selector anywhere in the stylesheet
(comments excluded), no `min-height + height:auto !important` inflation
pattern inside touch blocks, slider bar keeps `height: 4px` (HTML inline
+ `.page-slider` rule), slider bar is the panels' first child
(mechanism documentation), touch tap-target rules still intact, and the
CSS cache version moved past `activepdf-v11`.

**Files changed**: `static/css/style.css` (2 stale rules removed),
`static/index.html` (cache version → `touchfix-v12`),
`tests/test_touch_slider_space.js` (new),
`tests/test_active_pdf_toolbar.js` (version assertion made
future-proof).

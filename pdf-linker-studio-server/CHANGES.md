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

---

# Feature — Panel minimize with auto-lock (single-toolbar era)

**Request**: "add minimise option so that we can close one of the pdf canvas
when not needed. when minimise automatically lock it so that when i click
pdf not get open in that canvas."

**Behavior**:
- A floating **minimize button** (`.panel-min-btn`) sits in the top-right
  corner of each PDF canvas. Clicking it collapses that canvas; the other
  canvas takes the full workspace width. Works with mouse and touch
  (36px tap target on touch devices).
- **Auto-lock**: minimizing sets that side's `state.view[side].locked =
  true`, so `openDocumentSmart()` (file explorer clicks, recent files)
  can never route a newly opened PDF into the hidden canvas. Whether the
  lock was applied automatically is remembered — restoring unlocks again,
  while a manually locked canvas stays locked.
- **Restore**: click the minimized side's A / B tab in the header
  (`setActivePdf` restores on activation). The minimized tab is dimmed
  with a dashed border and an expand icon.
- **At most one minimized canvas** — the visible panel's minimize button
  is hidden while the other side is collapsed (CSS), so the workspace
  always shows at least one PDF.
- The minimized canvas keeps its document, annotations and links in
  memory (nothing unloads) — AI context, cross-PDF links and undo history
  are unaffected.
- Minimizing the ACTIVE side switches the active PDF to the visible side;
  a pending link/snip gesture sourced from the disappearing canvas is
  cancelled first.
- **Persistence**: `minimizedSide` + `minimizedAutoLock` are saved in
  project settings and re-applied on boot (guarded: only when at least
  one viewport has a document).

**Files changed**:
- `static/index.html` — floating `#minimize-left-btn` / `#minimize-right-btn`
  inside each panel; cache versions → `panelmin-v13`.
- `static/css/style.css` — `.panel-min-btn` (desktop + touch),
  `body[data-panel-min]` collapse/expand rules (hidden panel: width 0 +
  visibility hidden; visible panel: full width; resizer hidden; opposing
  minimize button hidden), `.pdf-tab-minimized` restore affordance.
- `static/js/state.js` — `state.minimizedSide`, `state.minimizeAutoLock`.
- `static/js/ui.js` — `minimizePanel()` / `restorePanel()` /
  `applyPanelMinimizeVisuals()`; `setActivePdf()` restores a minimized
  side on activation; `clearAllData()` resets minimize state.
- `static/js/filemanager.js` — `openDocumentSmart()` rewritten around a
  `usable(side)` check (visible AND unlocked); legacy routing behavior
  preserved exactly for the no-minimized case.
- `static/js/database.js` — settings persist `minimizedSide` +
  `minimizedAutoLock`.
- `static/js/app.js` — boot restores the minimized panel; re-asserts the
  persisted auto-lock flag after `minimizePanel()` recomputes it from the
  already-persisted lock.

**Live verification** (headless Chromium, 1366×1024, real project with
PDFs + a newly uploaded third PDF):
minimize B → A takes full width, resizer hidden, B locked+active switched;
uploading + clicking a new PDF opens it in visible A only; B tab restores
the split view and undoes the auto-lock; reload keeps the minimized state;
minimize A behaves symmetrically; annotations on the restored side render
correctly; zero page errors.

**Test**: `tests/test_minimize_panel.js` — 30 tests across 5 suites
(HTML wiring, minimize/restore semantics incl. manual-lock preservation
and never-minimize-both, openDocumentSmart routing matrix, persistence +
boot restore, CSS wiring).

---

## Improvement — Reopen a PDF where you left off (position resume)

**Reported**: "there is problem when pdf close and reopen it start from
first page ideally it should continue where it last left over."

**Symptom**: Every re-open of a PDF restarted it at page 1 — re-clicking
the PDF in the file explorer / recent list after it had been replaced in
its canvas, re-opening after a canvas minimize re-routed it to the other
pane, or re-opening it in the very pane already showing it.

**Root cause**: `setActiveDocument()` unconditionally forced
`pageNum = 1`, `pageId = page1`, `scrollTop = 0` on EVERY open — there was
no per-document memory of where the user had been. (A full page reload did
restore the spot, because `state.view` is persisted — but any in-app
close/reopen did not.)

**Fix — a persistent per-document reading position**:
- `state.lastPositions[docId] = { pageId, pageNum, scrollTop }` remembers
  where the user is in every document they open. `pageId` (stable page
  identity, not the page number) is the source of truth, so positions stay
  valid even after pages are inserted/deleted; stale entries (page since
  deleted) fall back to page 1 cleanly.
- Recorded automatically from every position-changing path:
  `renderPage()` (covers doc open, page nav, page input, slider, page
  insert/delete) and `handleScroll()` (covers scroll/pan, which never
  re-renders).
- `setActiveDocument()` now RESUMES from the memory instead of resetting
  to page 1. This fixes all three reopen paths in one place:
  re-click in explorer/recent list, re-route after canvas minimize, and
  re-open in the pane already showing the doc (which used to visibly
  restart it).
- Positions persist in the project settings (`saveSettings` /
  boot restore, sanitized: non-object/malformed entries dropped, entries
  for deleted docs dropped, viewports seed the memory on boot so the two
  open docs are always fresh).

**Semantics preserved**: a document open for the first time still starts
at page 1; page navigation/zoom/annotation/link/collaboration behavior is
untouched; deleting a document forgets its position; Clear-All-Data resets
the memory.

**Files changed**:
- `static/js/state.js` — `state.lastPositions` memory table.
- `static/js/pdf.js` — `rememberDocPosition()`; `renderPage()` hook;
  `setActiveDocument()` resume logic (validated pageId, clamped
  pageNum/scrollTop, page-1 fallback).
- `static/js/events.js` — `handleScroll()` records scroll-only updates.
- `static/js/database.js` — settings persist `lastPositions`.
- `static/js/app.js` — boot restores + sanitizes the memory and seeds it
  from the restored viewport state.
- `static/js/filemanager.js` — `_deleteDocumentRecord()` drops the doc's
  memory entry.
- `static/js/ui.js` — `clearAllData()` resets the memory.
- `static/index.html` — cache version → `posresume-v14`.

**Live verification** (headless Chromium, real server, uploaded 20-page
test PDF, page input + real explorer clicks):
open 20p PDF → page 5 → scroll (clamped 331px, memory records exactly the
viewport value) → replace with another PDF → re-click 20p PDF → RESUMED at
page 5 / scroll 331 (page input "5 / 20" visible in screenshot);
reload → boot restores page 5 / scroll 331; minimize A → clicking the 20p
PDF re-routes to visible B and RESUMES at page 5 / scroll 331 (was page 1
before this fix); restore A → both panes consistent; zero page errors.

**Test**: `tests/test_position_resume.js` — 18 tests across 5 suites
(cache version + source wiring, state init, memory capture incl. clamping
and empty viewports, resume-vs-fresh-vs-stale reopen matrix incl.
same-pane reopen, boot restore hardening). Full battery re-run green:
minimize_panel 30, active_pdf_toolbar 23, touch_slider_space 8,
frontend_bugs 10, stroke_continuity 23, undo_yjs_rebuild 5,
realtime_sync 7, annotation_movement 4.

---

## Feature — PDF tags + quick-switch rail (mini sidebar when explorer is collapsed)

**Requested**: "in each pdf add tag option so that even when left side bar
minimise a very small side bar will appear and in this side bar show all
the tagged pdf, show the first 3 letter of pdf name with different
background color for each pdf — user can easily switch between most useful
pdf easily and frequently."

**What was built**:
- **Tag option per PDF** — the file ⋮ context menu gained a "Tag / Untag"
  item (tag icon), and tagged rows show a small blue tag badge next to the
  favorite star (click the badge to untag).
- **Quick-switch tag rail** — a narrow 44px rail (`#tag-rail`) sits next to
  the file explorer and appears ONLY while the left sidebar is collapsed
  (`body.left-sidebar-collapsed`). It shows one small rounded chip per
  tagged PDF with the **first 3 letters of the name** (uppercase) on a
  **per-PDF background color**. A tiny pin icon heads the rail (with a
  teaching tooltip when nothing is tagged yet).
- **Per-PDF colors** — derived deterministically from the doc id (FNV-1a
  hash into a 12-color, white-text-safe palette), so each PDF keeps its own
  color across sessions. A per-render collision resolver shifts any hash
  collision to the next free palette slot, guaranteeing every VISIBLE chip
  is a different color (caught live during verification: two similar doc
  ids hashed to the same slot with the first hash draft).
- **One-tap switching** — tapping a chip calls `openDocumentSmart()`, so it
  routes to a usable viewport (respects minimized/locked panes) and — with
  the previous improvement — **resumes the PDF at its last reading
  position**. Chips of PDFs currently open in a viewport get an active ring
  (dark border + amber halo) that follows the viewports.
- **Persistence** — `state.taggedDocIds` is saved in the project settings,
  restored on boot (entries for deleted docs dropped), untagged
  automatically when a doc is deleted, and reset by Clear-All-Data. The
  rail refreshes on every doc event via the `renderDocList()` chain.
- **Touch friendly** — on touch devices the rail widens to 52px and chips
  grow to 40px tap targets.

**Files changed**:
- `static/js/state.js` — `state.taggedDocIds`.
- `static/js/filemanager.js` — `TAG_CHIP_COLORS` palette, `isDocTagged()`,
  `docTagColor()` (FNV-1a), `docTagShort()`, `toggleDocTag()`,
  `renderTagRail()` (chips + collision resolution + active ring + empty
  hint), context-menu Tag/Untag item + handler, tag badge on doc rows,
  `window.toggleDocTag` export, untag-on-delete in `_deleteDocumentRecord`.
- `static/js/pdf.js` — `renderDocList()` re-renders the tag rail.
- `static/js/database.js` — settings persist `taggedDocIds` (existing docs
  only).
- `static/js/app.js` — boot restores `taggedDocIds` (filtered).
- `static/js/ui.js` — `clearAllData()` resets tags.
- `static/index.html` — `#tag-rail` aside (between sidebar and workspace);
  cache version → `tagrail-v15`.
- `static/css/style.css` — rail (hidden by default, flex when collapsed),
  chip styles + active ring, touch media block (52px rail / 40px chips).

**Live verification** (headless Chromium, real server + project):
tagged 2 PDFs via the real ⋮ menu → collapsed the sidebar → rail appeared
(52px) with "RES" (amber) + "TES" (teal) chips; tapping TES opened
test-upload.pdf in the active pane; tapping RES switched back AND resumed
page 5 / scroll 331; active ring followed the open doc; reload kept tags,
colors, collapse state and ring; untagging via the row badge removed the
chip; zero page errors. Screenshot: tag_rail_final.png.

**Test**: `tests/test_tag_rail.js` — 21 tests across 5 suites (HTML
structure + version, state/persistence wiring, tag helpers, chip rendering
incl. collision resolution + routing, context menu/badge/CSS wiring).
Full battery re-run green: position_resume 18, minimize_panel 30,
active_pdf_toolbar 23, touch_slider_space 8, frontend_bugs 10,
stroke_continuity 23, undo_yjs_rebuild 5, realtime_sync 7,
annotation_movement 4.

## Feature — One fully transparent floating sidebar for AI Chat + Comments

**Requested**: Replace the separate AI Chat sidebar (a flex child that
resized the PDF canvas when toggled) and the Comments overlay (a fixed
panel with a dimming backdrop that blocked all PDF interaction) with ONE
fully transparent floating overlay sidebar. The PDF canvas must never
resize or move; the sidebar is only a transparent floating tool layer.

**Implementation**:
- **New `#float-sidebar` overlay** (`static/index.html`) — an absolutely
  positioned `<aside>` INSIDE `#workspace-main` (no flex space taken). The
  PDF panels keep their exact sizes; live-verified canvas/panel rects are
  byte-identical with the sidebar open, closed and re-opened.
- **100% transparent container** — `background: transparent`, no border,
  no shadow, `backdrop-filter: none` (explicitly no blur / tint / glass).
  PDF content is fully visible behind the sidebar column.
- **pointer-events strategy** — the container, header strip, panes and the
  chat message list are `pointer-events: none`; only real UI elements opt
  in (`pointer-events: auto`): mode pills, header action buttons, chat
  bubbles / hint cards, composer card, comment editor card. Taps on the
  transparent gaps fall straight through to the PDF — scroll, zoom, draw,
  erase and comment placement all work while the sidebar is open (verified
  live with a pen stroke that crosses INTO the sidebar column and a
  comment placed "under" it).
- **Mode switcher** — two pills ("AI Chat" / "Comments") driven purely by
  body classes (`fs-mode-chat` / `fs-mode-comments`, exactly one set):
  pane visibility AND pill active styling are CSS-only. Chat-only header
  actions (history / new chat / AI settings) hide in comments mode; the
  X closes the whole sidebar.
- **Business logic untouched & separate** — AI Chat (ai.js) and Comments
  (annotations.js) keep every element ID and function; the comment editor
  card is the SAME `#comment-editor-panel` markup relocated into the
  comments pane. `openCommentSidebar()` now calls `openFloatSidebar
  ('comments')` (reveals the sidebar in comments mode); `closeComment
  Sidebar()` drops the backdrop and returns the sidebar to the chat pane
  (the original "closing the comment restores the chat view" behavior).
- **No more interaction blockers** — the dimming `#comment-backdrop` and
  the `handlePointerDown` "activeComment open ⇒ do nothing" guard are
  GONE: annotating while a comment is open is now the intended behavior
  (tapping the page with the T tool opens the next comment in the same
  sidebar). Touch handlers (`touchstart` / `touchmove`) skip only real
  sidebar UI, keeping pass-through gaps live on tablets.
- **Comments empty state** — when no comment is active, the comments pane
  shows a hint card (`#comment-editor-panel.hidden ~ #fs-comments-empty`,
  pure CSS) that is itself pointer-events:none, so the user can
  immediately click a comment icon on the PDF — even one sitting behind
  the hint.
- **Persistence + compat** — settings now save `floatSidebarOpen` +
  `floatSidebarMode`; boot restores them and maps older blobs
  (`aiSidebarCollapsed: true` → closed) so returning users keep their
  previous layout. `<body>` defaults to open + chat mode (same default as
  the old sidebar).
- **Layout fixes** — the right panel's floating minimize button stays
  visible/clickable (sidebar content starts below it via top padding);
  the chat-history drawer is clipped by its pane (`overflow: hidden`) so
  the closed drawer can no longer leak over the PDF (caught live); the
  old narrow-viewport/iPad auto-collapse rules for the flex sidebar were
  removed (an overlay needs no auto-collapse); touch devices get bigger
  pills/buttons.
- Header "AI" button and `Ctrl+/` keep toggling the sidebar; the button
  dims while the sidebar is closed. Cache version → `floatside-v16`
  (CSS + all scripts + header chip).

**Files changed**:
- `static/index.html` — `#ai-sidebar` flex child removed; `#float-sidebar`
  overlay added (mode switcher, chat pane with the original chat DOM,
  comments pane with the original `#comment-editor-panel` DOM);
  `#comment-backdrop` deleted; body defaults; versions → `floatside-v16`.
- `static/js/ui.js` — `toggleAiSidebar()` rewritten; new
  `getFloatSidebarMode` / `setFloatSidebarMode` / `openFloatSidebar` /
  `closeFloatSidebar` (close cancels an in-progress comment first — old
  panel-X semantics).
- `static/js/annotations.js` — `openCommentSidebar` / `closeCommentSidebar`
  rewired to the floating sidebar; backdrop references removed.
- `static/js/events.js` — `handlePointerDown` guards `#float-sidebar`
  instead of the backdrop; the activeComment block-guard removed.
- `static/js/app.js` — boot restores open/mode with old-key fallback;
  touch handlers updated; backdrop click-to-close listener removed.
- `static/js/database.js` — persists `floatSidebarOpen` / `floatSidebarMode`.
- `static/js/ai.js` — chat empty-state uses the readable hint card.
- `static/js/config.js` — comment els comment updated.
- `static/css/style.css` — floating sidebar system (transparency,
  pointer-events islands, pills, cards, empty state, touch targets),
  comment panel restyled as a floating card, all old `#ai-sidebar` /
  backdrop rules removed.

**Live verification** (headless Chromium, real server + project):
`#float-sidebar` computed `rgba(0,0,0,0)` + `pointer-events: none`; panel
and canvas rects identical open/closed/reopened; `elementFromPoint` in
transparent gaps hits the PDF (annotation canvas) while pills/composer hit
the sidebar UI; real click on Comments pill switches panes + shows the
empty hint; comment placed UNDER the sidebar via pass-through click →
editor card opened in split mode → markdown saved → preview mode with
rendered bold; pen stroke crossing into the sidebar column recorded all 5
points; Esc closed the comment back to chat view; Ctrl+/ toggled the
sidebar; comment icon clicked THROUGH the transparent layer; sidebar X
preserved the saved comment; reload restored closed/open state + mode;
minimize button clickable in the top padding zone; drawer opens exactly
within its pane. Zero page errors. Screenshots: fs_chat_bubbles.png,
fs_drawer_clipped.png.

**Test**: `tests/test_float_sidebar.js` — 38 tests across 7 suites (HTML
structure incl. overlay placement + preserved IDs, cache versioning,
mode-switcher/open/close logic incl. invalid-mode + cancel-on-close,
comments wiring with zero backdrop references, annotate-while-open guard
removal, persistence + boot compat, CSS transparency/pointer-events/
clipping contract). Full battery re-run green: position_resume 18,
tag_rail 21, minimize_panel 30, active_pdf_toolbar 23, touch_slider_space
8, frontend_bugs 10, stroke_continuity 23, undo_yjs_rebuild 5.

## Feature — Draggable floating sidebar (smooth free movement)

**Request**: "instead of fix overly side bar make it floating so that i can
freely move (smooth move) any where we want" — the transparent floating
sidebar (floatside-v16) was a full-height, right-docked column. It is now a
compact CARD that the user can drag anywhere inside the PDF workspace, with
smooth 1:1 tracking, and the position is remembered.

**Design** (PDF stays the main workspace; the sidebar is only a tool layer):
- `#float-sidebar` changed from `top:0; right:0; bottom:0` (full-height
  dock) to a compact card anchored at `left:0; top:0` with
  `height: min(620px, 100%)` — the on-screen position comes exclusively
  from a JS-driven `transform: translate3d(...)`. The PDF canvas still
  NEVER resizes or moves; transparency (`background: transparent`,
  `backdrop-filter: none`) and the pointer-events layering are untouched.
- Default position (never dragged) = the old docked corner: card's right
  edge flush with the workspace's right edge, top 0. Because
  `state.floatSidebarPos` stays `null` until the first drag, this default
  keeps following the workspace edge (dock-like) until personalized.
- Drag affordance: new `#fs-drag-handle` grip button (dashed circle,
  `fa-up-down-left-right`) at the left of the sidebar header — the ONLY
  drag starter. It is a pointer-events island, so dragging it never steals
  gestures from the PDF; the whole rest of the transparent container keeps
  passing taps through to the PDF.
- Smoothness: pointermove targets are coalesced through
  `requestAnimationFrame` (one style write per frame) and applied as
  `translate3d` (GPU-composited, no layout). `body.fs-dragging` disables
  the transform transition during a drag (zero lag); programmatic moves
  (re-dock, resize re-clamp) glide via a 0.18s transition.
- Clamping: the card is always kept fully inside `#workspace-main`
  (`x ∈ [0, wsW − sbW]`, `y ∈ [0, wsH − sbH]`) — the grip and pills can
  never be dragged off-screen.
- Persistence: `state.floatSidebarPos = {x, y}` is saved via
  `saveSettings()` (settings JSON — zero backend changes) and restored on
  boot with strict validation (only finite `{x,y}` numbers accepted;
  anything else = docked default). Clamping happens on apply, so a
  position saved on a big screen stays visible on a small one.
- Re-dock: double-tap / double-click on the grip (works for touch too —
  manual <350ms + <8px detection) forgets the dragged position and glides
  the card back to the default corner.
- Workspace-aware repositioning: a `ResizeObserver` on `#workspace-main`
  re-applies the position whenever the workspace changes size — the left
  file sidebar collapsing (it animates its width, which made a single
  boot-time measurement stale), the split resizer moving, a panel being
  minimized, or the window resizing. Window-resize listener kept only as
  legacy fallback.
- A drag that moves < 3px (a plain tap) does NOT personalize the position —
  an untouched card keeps its dock-like follow behavior.
- Mouse AND touch: pointer events + `touch-action: none` on the grip
  (no pan/scroll/double-tap-zoom interference); grip enlarged to 34px in
  the touch media query. `preventDefault` + `setPointerCapture` keep the
  gesture ours (no text selection, no focus steal).

**Files changed**:
- `static/index.html` — `#fs-drag-handle` button added as the header's
  first control; cache version → `floatdrag-v17` (CSS + all scripts +
  header chip).
- `static/js/ui.js` — drag module (`floatSidebarDefaultPos`,
  `clampFloatSidebarPos`, `fsResolvePos`, `fsWriteTransform`,
  `applyFloatSidebarPos`, `moveFloatSidebarTo`, `begin/move/end
  FloatSidebarDrag`, `resetFloatSidebarPos`, `handleFloatSidebarResize`,
  `initFloatSidebarDrag`); `toggleAiSidebar`/`openFloatSidebar` now apply
  the position on open.
- `static/js/state.js` — `state.floatSidebarPos: null`.
- `static/js/database.js` — `saveSettings` persists `floatSidebarPos`.
- `static/js/app.js` — boot restores + validates the position (applies it
  when the sidebar opens restored-open); `initFloatSidebarDrag()` called
  at boot.
- `static/css/style.css` — card layout (`left/top` + `height: min(620px,
  100%)`, transform-driven, `will-change`, transition), `body.fs-dragging`
  rules, grip styling (dashed border, grab/grabbing cursor, `touch-action:
  none`), touch media bump.

**Behavior verification** (headless Chromium, real server + project):
- Dock position converges after boot even with the animated file-sidebar
  collapse (right edges flush at 1280px).
- Real mouse drag (grip at 985,156 → −385,+194): card moved to
  `translate3d(523px, 0px, 0px)`; on the short test viewport the card is
  workspace-height so y clamps to 0 — by design; `state.floatSidebarPos`
  persisted; canvas panel rects and scroll positions (0 / 331) remained
  pixel-identical.
- Reload restored `translate3d(523px, ...)`, then later `translate3d(223px,
  ...)` after a second drag to the LEFT panel — free movement anywhere.
- Double-tap on the grip re-docked to `translate3d(908px, 0px, 0px)` and
  cleared the saved position.
- Pen strokes drawn while the sidebar was open: starting OUTSIDE the card
  (recorded + persisted) and starting INSIDE a transparent gap of the
  dragged card (elementFromPoint → `right-anno-canvas`, 3 points recorded,
  sidebar stayed open). Tapping the chat hint card (a real UI element)
  correctly does NOT start a stroke.
- `elementFromPoint` at the minimize button (inside the card's transparent
  padding zone) still resolves to the button — clickable through the
  transparent layer.
- Comments pill switches panes at the dragged position; Ctrl+/ toggles the
  sidebar; zero page errors. Screenshots: fd_docked_default.png,
  fd_dragged_comments.png, fd_dragged_left.png.

**Test**: NEW `tests/test_float_drag.js` — 44 tests across 4 suites (HTML
grip structure + version bump + no reuse of shipped strings; CSS card/
transparency/dragging/touch contract; 27 VM tests of the drag engine —
default-dock math, clamping incl. non-finite input, closed-state no-op,
first-apply jump suppression, saved-position validation, toggle/open
integration, full drag lifecycle with rAF coalescing + end-flush,
pointer-id filtering, zero-distance-tap persistence guard, double-tap
re-dock vs new-drag timing/distance discrimination, resize re-clamp,
ResizeObserver wiring + fallback; wiring/guards/persistence source
contract). `test_float_sidebar.js` updated for the version bump (+1
sandbox stub). Full battery re-run green: float_sidebar 38, position_resume
18, tag_rail 21, minimize_panel 30, active_pdf_toolbar 23, touch_slider_space
8, frontend_bugs 10, stroke_continuity 23, undo_yjs_rebuild 5.

## Feature — Liquid glass floating sidebar (frosted card, clicks blocked)

**Request**: "i think better to not make 100 % transparent give them a liquid
effect also make sure click and other action/effect not get pass over this" —
the draggable floating sidebar (floatdrag-v17) had a 100% transparent
background and let clicks/taps/draws fall through its empty areas to the PDF.
It is now a LIQUID GLASS card: a frosted translucent surface, and it ABSORBS
every interaction — nothing passes through to the PDF underneath.

**Design** (PDF stays the main workspace; the card is a floating tool layer):
- Liquid glass surface on `#float-sidebar`: translucent white
  `linear-gradient` tint (rgba 0.44–0.68 stops), `backdrop-filter:
  blur(20px) saturate(1.75)` (+ `-webkit-` variant), hairline light border
  (`rgba(255,255,255,0.72)`), 18px rounded corners, layered floating shadow
  (ambient + key + inner top highlight). The PDF glows softly through the
  card, but the card reads as a real object hovering above the page.
- Pointer blocking: `pointer-events: auto` on the container. ALL old
  pass-through islands are gone — `pointer-events: none` removed from
  `#fs-header`, `#fs-body`, `#fs-chat-pane`/`#fs-comment-pane`,
  `#chat-history` (+ its `> *` island rule), `#fs-composer`,
  `#fs-comments-empty`. Clicks / taps / wheel / pen gestures ON the card
  never reach the PDF; to scroll, zoom, draw or annotate, aim OUTSIDE the
  card. The `events.js` handlePointerDown + `app.js` touch guards for
  `#float-sidebar` remain as a second line of defense.
- Wheel over the card scrolls the CHAT list (normal overflow-y behavior),
  never the PDF; text selection / typing in the composer and comment editor
  behave like any normal window.
- Translucent inner cards so the glass shows through: composer card 0.78,
  hint cards 0.72, comment editor 0.88, assistant bubbles 0.88 (were solid
  white). User bubbles stay solid blue.
- `@supports not (backdrop-filter...)` fallback: engines without backdrop
  filtering (older Firefox) get a near-opaque `rgba(255,255,255,0.95)`
  surface — readable, same blocking behavior, no frost.
- Minimize buttons stay king: `.panel-min-btn` z-index 115 → 1250 (above
  the card's 1200, below modals at 9999). The card's default dock covers
  the top-right corner, so the right panel's minimize button now floats
  ABOVE the glass and stays visible + clickable (previously it sat in the
  transparent 44px padding zone).
- Drag engine untouched: grip is still the only drag starter, position
  still transform-driven (`translate3d` + rAF coalescing), clamping,
  double-tap re-dock, ResizeObserver re-positioning, persistence — all as
  shipped in floatdrag-v17.
- Geometry preserved: same padding (44px top / 46px touch), same width
  caps, same `height: min(620px, 100%)` — the layout of the docked card is
  pixel-identical to v17; only the surface material changed.

**Files changed**:
- `static/css/style.css` — liquid glass container block (+ `@supports`
  fallback), removed all pass-through `pointer-events: none` rules inside
  the card, translucent inner cards, `.panel-min-btn` z-index 1250,
  updated section documentation.
- `static/index.html` — aside/header/pane doc comments rewritten for the
  liquid glass + blocking semantics; cache version → `liquidglass-v18`
  (CSS + all scripts + header chip; chip title now says "Liquid glass").
- `static/js/ui.js`, `static/js/events.js`, `static/js/app.js` — comment
  updates only (the guards and drag engine logic are unchanged).
- `tests/test_float_sidebar.js` — suite 7 rewritten (glass contract +
  blocking contract), version constants bumped.
- `tests/test_float_drag.js` — suite 2 CSS contract inverted (glass +
  blocking instead of transparency + pass-through), version constants
  bumped, floatdrag-v17 added to the shipped/retired list.
- `tests/test_liquid_glass.js` — NEW regression suite (19 tests).

**Behavior verification** (headless Chromium, real server + project):
- Computed styles live: `backdrop-filter: blur(20px) saturate(1.75)`,
  gradient background, 18px radius, light border, layered shadow,
  `pointer-events: auto`, z-order 1200 vs `.panel-min-btn` 1250.
- Pen stroke drawn ACROSS the card (mouse down/move/up over the glass):
  ZERO strokes recorded — the card absorbs the pointer.
- Pen stroke on the canvas OUTSIDE the card: recorded (5th stroke, 3
  points) — the PDF is fully interactive around the card.
- `elementFromPoint` inside the card hits card elements (glass padding →
  `#float-sidebar` itself, chat area → hint card, header → buttons);
  outside → `left-viewport`.
- Wheel over the card: left/right viewport scrollTops unchanged (0 / 331).
- Real click on the minimize button THROUGH/ABOVE the docked glass:
  right panel minimized, sidebar stayed open; panel restored via header
  tab. `elementFromPoint` at the button center resolves to the button
  even though the docked card geometrically covers it.
- Real mouse drag of the grip: position updated smoothly
  (`translate3d(342px, 0px, 0px)`; y clamps on the 521px-tall test
  workspace where the card is full-height — by design, same as v17).
- Reload restored: sidebar open, comments mode (as set pre-reload),
  position (342, 0), glass styles. Composer typing works; comments pill
  switches panes; version chip shows `liquidglass-v18`; zero page errors
  (yjs CDN warning is the pre-existing offline-sandbox condition).
- Screenshots: lg_docked.png, lg_nocard.png (PDF behind), 
  lg_dragged_comments.png (dragged card over both panels, comments mode,
  minimize button floating above the glass).

**Test battery** (all green): liquid_glass 19 (NEW), float_sidebar 38,
float_drag 44, position_resume 18, tag_rail 21, minimize_panel 30,
active_pdf_toolbar 23, touch_slider_space 8, frontend_bugs 10,
stroke_continuity 23, undo_yjs_rebuild 5 — 239 total. `node --check`
clean on all edited JS; CSS braces balanced.

---

# Feature — Draggable liquid glass annotation toolbar (floattools-v19)

## Request
> "instead of fix annotation tool in header make it floating so that i can
> freely move(smooth move) any where we want dont move all tool look image
> only move those tool"

The user's screenshot showed exactly two header groups: the App Modes row
(Navigate / Draw Link / Snip & Link / Delete Link) and the Annotation Draw
Tools row (Select / Pen / Highlighter / Add Comment / Pixel Eraser / Stroke
Eraser / Add Image). Those — plus the Pen/Highlighter options group that
follows them — had to become a freely movable floating palette. Everything
else in the header (Active-PDF tabs + controls, Undo/Redo/Delete/Clear,
Save/Open/AI) stays put.

## What changed

* **index.html** — the three groups moved OUT of the header into a new
  `<aside id="float-toolbar">` inside `#workspace-main` (the same overlay
  pattern as the floating sidebar). Markup is verbatim: every button keeps
  its exact id (`mode-nav-btn`, `tool-pen`, `pen-customization`, …) and
  onclick, so `setAppMode()` / `setAnnoTool()` / keyboard shortcuts work
  unchanged. A dashed drag grip (`#ft-drag-handle`) sits first in the bar.
  Header note comments document the move. Cache version → `floattools-v19`
  on the CSS link, all 20 script tags and the header chip; new script tag
  `js/floattools.js` loads before `app.js`.
* **css/style.css** — new "Floating Annotation Toolbar" section: the same
  liquid glass recipe as the sidebar (translucent gradient tint +
  `backdrop-filter: blur(18px) saturate(1.7)`, hairline white border,
  14px radius, layered shadow + inner highlight, `@supports` near-opaque
  fallback), `position: absolute` + JS-driven `translate3d` (zero flex
  space → the PDF canvas can never resize or move), `pointer-events: auto`
  (every click/tap/wheel ON the bar is absorbed — nothing passes through
  to the PDF), `flex-wrap` + max-width for narrow screens, `z-index: 1150`
  (above canvas, below the sidebar 1200 and the minimize buttons 1250),
  `body.ft-dragging` transition kill + user-select lock, touch media block
  grows the grip to 34px.
* **js/floattools.js (NEW)** — self-contained position engine (mirrors the
  proven sidebar engine; tool BUSINESS LOGIC stays in ui.js):
  - default spot = horizontally centered, 44px below the workspace top
    (the closest floating equivalent of the old header position, clear of
    the minimize buttons); a never-dragged bar re-centers on resize;
  - smooth drag: grip-only `pointerdown` → `setPointerCapture` → rAF-
    coalesced `translate3d` writes (1:1 pointer tracking, GPU-composited),
    clamped fully inside `#workspace-main`, pointer-id filtered,
    right/middle button ignored;
  - ≥3px drag threshold before the position counts as "personalized";
  - double-tap on the grip re-docks to the default spot;
  - ResizeObserver on BOTH `#workspace-main` and the bar itself (file
    sidebar collapse, split resizer, panel minimize, pen-customization
    appearing, narrow-screen wrap) re-applies/re-clamps; window resize
    fallback; position persisted in the settings blob (`floatToolbarPos`,
    strict finite {x,y} validation on boot restore).

## Files
* static/index.html (groups moved, aside added, version bump, script tag)
* static/css/style.css (toolbar glass section + touch overrides)
* static/js/floattools.js (NEW — drag/position engine)
* static/js/state.js (+floatToolbarPos), static/js/database.js (persist),
  static/js/app.js (boot restore + guards + init call), static/js/events.js
  (pointerdown guard)

## Tests
NEW tests/test_float_toolbar.js — 49 tests / 5 suites: HTML structure
(aside inside workspace, all 11 buttons + inputs with identical ids and
handlers, header keeps Groups 0+4), versioning (bump + full retirement of
liquidglass-v18 + floattools.js load order), CSS contract (glass, pointer
absorption, overlay geometry, z-order 1150 < 1200 < 1250, wrap, touch
grip), 19 VM drag-engine tests (default top-center math, clamping,
non-finite fallback, rAF coalescing, full-drag persistence, tap/jitter
thresholds, edge clamps, pointer-id filter, double-tap re-dock vs new
drag, button filter, init/RO wiring incl. toolbar self-observation),
wiring & separation (events/app guards, persistence, boot validation,
ui.js business logic untouched, floattools.js contains no tool logic).
Version constants updated in test_liquid_glass.js, test_float_sidebar.js,
test_float_drag.js (SHIPPED += liquidglass-v18).

**Test battery** (all green): float_toolbar 49 (NEW), float_drag 44,
float_sidebar 38, liquid_glass 19, position_resume 18, tag_rail 21,
minimize_panel 30, active_pdf_toolbar 23, touch_slider_space 8,
frontend_bugs 10, stroke_continuity 23, undo_yjs_rebuild 5 — 288 total.
(test_e2e_stroke_race remains excluded: pre-existing missing yjs module in
scripts/e2e-deps, unrelated.) `node --check` clean; CSS braces balanced.

## Live verification (agent-browser, real server + test project)
* Docked default `translate3d(230px, 44px, 0px)` on the 1228px workspace
  (bar 769px wide with pen options visible → perfectly centered, below the
  minimize buttons); glass computed styles live (blur 18px saturate 1.7,
  pointer-events auto, z 1150).
* Header verified slim: no mode/tool buttons in `body > header`; Groups 0
  and 4 intact; version chip floattools-v19.
* Tool switching from the bar: select/pen activate with correct pill
  styling; pen options appear INSIDE the bar; app-mode auto-switch
  semantics unchanged.
* ABSORPTION: real pen drag ACROSS the bar → zero strokes (guard +
  pointer-events); real drag on glass padding → no drawing AND the bar
  does not move (only the grip drags); elementFromPoint on the glass hits
  `#float-toolbar`, on the grip hits `#ft-drag-handle`.
* REAL smooth drag: grip down + move (+150,+100) → `translate3d(380px,
  144px, 0px)` — EXACT 1:1 delta — persisted to settings; left/right
  panel rects + scrollTop pixel-identical before/after (canvas untouched).
* Reload restored (380,144); accidental-drag persistence (310,54) also
  confirmed earlier; double-tap re-dock → back to (230,44), savedPos null.
* Dragged to the bottom edge → clamped flush inside the workspace
  (212,457 on the 521px-tall workspace) — screenshots ft_final.png
  (docked) + ft_dragged_bottom.png (bottom-left float).
* Floating sidebar untouched: re-dock double-tap still works, its position
  persistence intact; when the two layers overlap the sidebar (z 1200)
  wins and both remain draggable.
* Zero page errors (yjs CDN warning = pre-existing offline sandbox).

---

# Feature — Toolbar orientation toggle: horizontal ribbon ⇄ vertical rail (ftorient-v20)

## Request
> "the orientation of annotation tool is horizontal better to have both
> option vertical or horizontal so that user have flexibility"

The floating annotation toolbar shipped as a horizontal ribbon only. The
user wants BOTH orientations with a switch, so the palette can stand up as
a slim vertical rail (classic toolbox, great along a page edge) or lie
flat as the familiar ribbon.

## What changed

* **index.html** — new `#ft-orient-toggle` button sits in the bar right
  after the drag grip (before the tool groups). Its initial icon
  (`fa-arrows-up-down`) + title advertise the VERTICAL orientation the
  first click produces; `js/floattools.js` swaps icon/title/aria-label on
  every flip so the button always shows what the NEXT click yields.
  Aside doc comment extended. Cache version → `ftorient-v20` on the CSS
  link, all script tags and the header chip (chip title now mentions the
  horizontal/vertical flexibility).
* **css/style.css** — new `#float-toolbar.ft-vertical` block: the bar
  becomes a single-column rail (`flex-direction: column`, no wrap, ribbon
  max-width lifted). Every group stands up too (`> div.flex` → column,
  buttons centered), the group separators become short centered horizontal
  hairlines, the thickness slider stretches (`width: 100%`, min 64px) so
  it stays usable, and the two round meta buttons (grip + toggle) center
  on the rail. `max-height: calc(100% - 20px)` + `overflow-y: auto` keep a
  rail that is taller than a short workspace scrollable instead of clipped
  (thin translucent scrollbar styling included). New `#ft-orient-toggle`
  rules mirror the grip's round button styling (solid border to
  distinguish it from the dashed "grab me" grip; `touch-action:
  manipulation` — the grip alone owns pointer gestures); the touch media
  block grows both to 34px. The horizontal ribbon base rules are untouched.
* **js/floattools.js** — orientation engine (still position-ONLY, zero
  tool business logic):
  - `setFloatToolbarOrientation(orient, opts)` — strict validation
    ('horizontal' | 'vertical' only; anything else is rejected without
    side effects), flips the `ft-vertical` class, updates
    `state.floatToolbarOrientation`, syncs the toggle button
    icon/title/aria, then RE-APPLIES the position: measurement right after
    `classList.toggle` is synchronous, so the new footprint is what gets
    clamped. Persists via `saveSettings()` unless `opts.skipSave` (boot).
  - `toggleFloatToolbarOrientation()` — the button's flip helper.
  - `floatToolbarDefaultPos()` is now orientation-aware: the ribbon still
    docks top-center (y=44, below the minimize buttons); the rail docks
    flush LEFT-CENTER like a classic toolbox (x=8, vertically centered —
    left, not right, because the liquid-glass sidebar owns the top-right
    corner). Double-tap re-dock uses the same default, so it re-docks
    correctly in either orientation.
  - `initFloatToolbarDrag()` binds the toggle's click and applies the
    persisted orientation (skipSave) BEFORE wiring the ResizeObserver, so
    the observer baseline is the restored footprint.
  - Dragged positions are orientation-INDEPENDENT: flipping keeps the
    personalized spot and re-clamps it to the new footprint; the saved
    {x,y} itself is never overwritten by a clamp.
* **js/state.js** — `floatToolbarOrientation: 'horizontal'` default.
* **js/database.js** — persists it, normalized to the two exact strings.
* **js/app.js** — boot restore with strict validation (only the exact
  string 'vertical' opts into the rail; old settings blobs predate the key
  → horizontal default). Applied by `initFloatToolbarDrag` (single
  application point, no boot-time settings write).

## Files
* static/index.html (toggle button + aside comment + version bump)
* static/css/style.css (#ft-orient-toggle rules + #float-toolbar.ft-vertical rail section + touch override)
* static/js/floattools.js (orientation engine + orientation-aware default + init wiring)
* static/js/state.js (+floatToolbarOrientation), static/js/database.js
  (persist), static/js/app.js (boot restore)

## Tests
NEW tests/test_toolbar_orientation.js — 34 tests / 5 suites: versioning
(bump + full retirement of floattools-v19 from shipped files), HTML
structure (toggle once, grip → toggle → tools order, initial icon offers
vertical), CSS contract (rail flip rules, stacked groups, hairline
separators, slider stretch, meta-button centering, tap-safe toggle,
touch-media growth, ribbon base untouched), 14 VM engine tests (class +
state + save on flip, vertical default left-center math, horizontal
default unchanged, invalid values rejected without side effects, both-way
toggle persistence, dragged position survives the flip re-clamped,
skipSave boot purity, next-orientation icon/title/aria advertising, init
restore without saving + RO wiring, click binding, vertical drag
persistence, vertical double-tap re-dock, RO re-apply after orientation-
driven resize incl. short-workspace clamp), wiring & separation (state/
database/app contracts, boot order, position-only engine, island guards).
The shared harness in test_float_toolbar.js was upgraded: extractFunction
now walks the parameter list before counting body braces (default-value
`opts = {}` used to truncate extraction) and skips `//` comments
(apostrophes in comments used to desync the scanner); makeEl grew a
classList. Version constants updated in test_float_toolbar.js,
test_float_sidebar.js, test_liquid_glass.js, test_float_drag.js
(SHIPPED += floattools-v19).

**Test battery** (all green): toolbar_orientation 34 (NEW), float_toolbar
49, float_drag 44, float_sidebar 38, liquid_glass 19, position_resume 18,
tag_rail 21, minimize_panel 30, active_pdf_toolbar 23, touch_slider_space
8, frontend_bugs 10, stroke_continuity 23, undo_yjs_rebuild 5 — 322 total.
(test_e2e_stroke_race remains excluded: pre-existing missing yjs module in
scripts/e2e-deps, unrelated.) `node --check` clean; CSS braces balanced
(486/486).

## Live verification (agent-browser, real server + test project)
* Docked default horizontal: `translate3d(209px, 44px, 0px)` on the 1228px
  workspace (bar 811×64 → perfectly centered); chip ftorient-v20; toggle
  icon `fa-arrows-up-down`, title "Switch toolbar to vertical".
* Click toggle → `ft-vertical` class, footprint 163×501, rail placed at
  `translate3d(8px, 10px, 0px)` — x=8 flush left, y=10 = (521−501)/2
  exactly centered; icon flipped to `fa-arrows-left-right`, title "Switch
  toolbar to horizontal"; state vertical; left viewport rect + scrollTop
  pixel-identical before/after (canvas untouched).
* Vertical rail works: tool clicks switch (`state.annoTool` follows), pen
  options render inside the rail (rail content taller than the capped
  max-height scrolls — overflow-y: auto), elementFromPoint mid-rail hits
  toolbar buttons (click absorption intact), rail width driven by the
  stretched thickness slider.
* REAL mouse drag of the rail (+150,+5) → `translate3d(158px, 15px, 0px)`
  — EXACT 1:1 — persisted; drag far down → y clamped flush to 20
  (= 521−501) and still persisted; reload restored orientation vertical +
  position (154,20) + icon/title state (and the document + scroll from the
  position-resume feature, untouched).
* Toggle back → horizontal ribbon at the kept position re-clamped for the
  wider footprint; icon/title offer vertical again; double-tap re-dock
  glides the ribbon back to the default top-center (209,44), savedPos null.
* Zero page errors (yjs CDN warning = pre-existing offline sandbox).
* Screenshots: scripts/ori_vertical_rail.png (vertical rail with pen
  active), scripts/ori_horizontal_final.png (ribbon re-docked).

---

# Feature — Tool Size Flyout: Apple-Notes style secondary size menu (ftsize-v21)

## Request
> "i think for pen/highlighter size selection show the secondary menu because
> it is looking wired when annotation tool is vertical also dont show always
> show on second time click/tap — that is when first time click pen/highlighter
> got selected on second time click same tool click show the size selection and
> click any where except the tool selection will automatically close the size
> selection menu. third design it like profession app (like apple notes) also
> show the integer/float value of tool size for easy understanding which size
> tool current user is using"

The floating toolbar carried an inline thickness slider. Inside the vertical
rail it stayed horizontal (awkward), showed no numeric value, and was always
on screen.

## What changed

* **Inline slider removed** — `#thickness-picker` is gone from
  `#pen-customization` (markup, CSS rule, `config.js` els entry, the app.js
  `input` binding and the boot-restore write). `#pen-customization` keeps the
  line-mode toggle + color swatch exactly as before.
* **New body-level flyout `#tool-size-menu`** (shell in index.html, engine in
  the NEW `static/js/sizemenu.js`, styles in style.css): a liquid glass card
  (same material recipe as the toolbar — white gradient tint, backdrop blur
  20px + saturate 1.7, hairline border, floating shadow, scale-pop
  animation with placement-aware transform-origin). Header = tool title +
  the CURRENT size as a numeric chip (`5`, `3.5`, `2.25` — integers exact,
  floats trimmed). Below: one row per preset size (1, 3, 5, 8, 12, 20),
  each row a live DPR-crisp stroke preview drawn with the tool's OWN color
  and opacity (flat 0.45-alpha bar for the highlighter, neutral gray for
  erasers) + its numeric value + a check on the active row.
* **Two-tap behavior** — the four size tools (pen, highlighter,
  eraser-pixel, eraser-stroke) now dispatch through `handleToolBtnTap`:
  FIRST tap selects the tool (menu stays closed); a SECOND tap on the
  already-active tool IN annotation mode opens the flyout; a third tap on
  the same button toggles it closed. Non-size tools and keyboard shortcuts
  keep calling `setAnnoTool` directly. The menu NEVER auto-opens on
  selection.
* **Auto-dismiss** — capture-phase `pointerdown` closer: any press outside
  the flyout closes it (canvas taps close it AND still draw), EXCEPT the
  owning tool button (its click toggles instead — closing on pointerdown
  would re-open on click). Also closes on Escape, tool switch
  (`setAnnoTool` calls `closeToolSizeMenu()`), orientation flip, toolbar
  drag/re-dock and workspace resizes (guarded calls in floattools.js).
* **Placement** — anchored to the owning tool button: vertical rail →
  beside it (right preferred, left near the right viewport edge);
  horizontal ribbon → below it (above near the bottom); always clamped to
  the viewport with an 8px margin. Measured via offsetWidth/offsetHeight
  (transform-independent) so the scale(0.9) hidden state cannot skew the
  anchor math. Body-level `position: fixed` → the workspace overflow can
  never clip it; z-index 1160 (above toolbar 1150, below sidebar 1200).
* **Numeric size badge** — a tiny monospace chip (`.tool-size-badge`) on
  the ACTIVE size tool's button shows the current size at all times
  (menu closed or open); rebuilt on every tool switch and size change.
* **Sizes apply + persist** — `applyToolSize` writes `state.annoThickness`
  and the tool's `toolSettings` bucket (clamped 1..20), calls
  `saveSettings()`, updates chip/rows/badge and the pen-options preview
  dot; the menu STAYS OPEN so sizes can be compared (Apple Notes
  behavior).
* **Bug fix found on the way** — `setAnnoTool('eraser-pixel')` looked up
  `state.toolSettings['eraser-pixel']` but the buckets are camelCase
  (`eraserPixel`/`eraserStroke`), so erasers silently inherited the
  previous tool's thickness. New `toolSettingsKeyFor()` (utils.js)
  normalizes the lookup (with fallback to legacy hyphen keys written by
  older builds) in both `setAnnoTool` (ui.js) and `applyToolSize`
  (sizemenu.js).
* **events.js** — `handlePointerDown` also ignores events targeting
  `#tool-size-menu` (the flyout floats above the canvas; its container
  padding is not a button).
* **floattools.js stays position-only** — the size engine lives in its own
  module (`sizemenu.js`, script tag after floattools.js, cache version
  included); floattools keeps only typeof-guarded `closeToolSizeMenu()`
  hooks in the drag/orientation/resize paths plus nothing else. app.js
  boot calls the new `initToolSizeMenu()` (Escape binding + boot badge).
* **Version bump** — `ftorient-v20` → `ftsize-v21` on the CSS link, all 21
  script tags and the header chip (ftorient-v20 fully retired from shipped
  files).

## Files

* static/index.html (slider removed, flyout shell, handleToolBtnTap
  dispatch, sizemenu.js tag, v21)
* static/js/sizemenu.js (NEW — the whole flyout engine)
* static/js/floattools.js (guarded close hooks only; still position-only)
* static/js/ui.js (setAnnoTool closes flyout + refreshes badge; eraser
  settings key fix)
* static/js/app.js (boot initToolSizeMenu; slider binding removed)
* static/js/config.js (thicknessPicker entry removed)
* static/js/utils.js (toolSettingsKeyFor helper)
* static/js/events.js (#tool-size-menu pointer guard)
* static/css/style.css (slider rule removed; flyout + badge styles; touch
  media rows)

## Tests

* NEW tests/test_tool_size_menu.js — 45 assertions across 8 suites:
  versioning (incl. ftorient-v20 retirement), markup contract (body-level
  shell, slider gone, tap-again titles), CSS contract (fixed/1160/glass/
  hidden+open/badge), VM engine tests (two-tap dispatch incl. non-
  annotation-mode + non-size tools; render + apply + persistence + badge;
  float formatting 3.5/2.25; clamping; highlighter/eraser preview
  styles via ctx snapshots; outside-close + owner exemption + Escape +
  unbind; placement math for rail/ribbon incl. flip and clamp), and
  integration (real setAnnoTool restores eraser size; floattools
  position-only intact; no thicknessPicker anywhere).
* Sibling suites updated: version constants (SHIPPED += ftorient-v20,
  CURRENT = ftsize-v21) in float_toolbar/float_drag/float_sidebar/
  liquid_glass/orientation/position_resume/tag_rail; slider and onclick
  assertions modernized.
* Battery: 367 tests green across 14 JS suites (tool_size_menu 45,
  toolbar_orientation 34, float_toolbar 49, float_drag 44, float_sidebar
  38, liquid_glass 19, minimize_panel 30, position_resume 18, tag_rail 21,
  active_pdf_toolbar 23, touch_slider_space 8, frontend_bugs 10,
  stroke_continuity 23, undo_yjs_rebuild 5). node --check clean; CSS
  braces 505/505.

## Live verification (agent-browser, real server + test project)

* Vertical rail: first tap selects pen (menu closed, badge "5" already on
  the button); second tap pops the flyout RIGHT of the rail, vertically
  anchored (clamped exactly as computed: top 244 == expected 244); header
  "Pen Size" + chip "5"; rows 1/3/5/8/12/20 with red stroke previews and
  the check on 5.
* Tapping row 8 → thickness 8 everywhere (state + chip + badge), menu
  stays open; canvas pointerdown → menu closes AND pen stays active;
  third/fourth taps toggle; switching to text closes the flyout and no
  badge leaks onto non-size tools.
* Float value: applyToolSize(2.5) → chip + badge read "2.5"; highlighter
  flyout shows "Highlighter Size" with flat yellow 0.45-alpha previews;
  pen badge removed when highlighter active (zero stale badges); eraser
  flyout titles "Pixel Eraser Size", badge shows the eraser's OWN size
  (20 — after the camelCase fix), not the pen's.
* Horizontal ribbon: single tap on the active tool opens the flyout BELOW
  the button, horizontally centered, above the page; Escape closes.
* Event isolation: elementFromPoint inside the flyout hits the flyout;
  pointerdown on it starts NO stroke; left viewport dimensions + scrollTop
  byte-identical before/after the whole flow (canvas never resizes);
  drawing a pen stroke after flyout use works (annotations committed).
* Zero page errors (yjs CDN warning = pre-existing offline sandbox).
* Screenshots: scripts/sm_vertical_rail.png (rail + flyout, badge "5"),
  scripts/sm_horizontal_ribbon.png (ribbon + flyout below, chip "12"),
  scripts/sm_highlighter.png (highlighter yellow previews + "2.5").

# Fix — Color selection did nothing on iPad + separator cleanup (ipadcolor-v22)

## Request

> "color selection is not working in working on ipad, it is working on laptop
> and android tab/mobile but it is not working on ipad"
> "also no need of tool seperator in between different catagory of annotation
> tool this will save some space"

## Root cause (iPad color bug)

The editor's color flow was: tap the color preview canvas → programmatically
`.click()` a **hidden `<input type="color">`**. iOS Safari has **never
supported `<input type="color">`** (it degrades to a text-type input; no
picker UI exists), so the tap did nothing on iPad — while laptops and Android
(both with native color pickers) worked. Exactly the reported split.

## Fix — custom color palette (`#tool-color-menu`, js/colormenu.js)

The native-input dependency is GONE. Tapping the preview canvas now opens a
custom, Apple-Notes-style liquid-glass palette that is plain DOM and behaves
identically on iPad / Android / desktop:

* Body-level `position:fixed` flyout (same proven pattern as the size menu):
  anchored beside the canvas in the vertical rail (right, then left near the
  right edge) and below it in the horizontal ribbon (then above near the
  bottom), always viewport-clamped, never clipped by the workspace.
* Header shows the tool name ("Pen Color" / "Highlighter Color") plus the
  CURRENT color as a swatch + exact hex chip (e.g. `#3B82F6`) — same
  "show the value" pattern as the size menu.
* 15 professional preset swatches (includes the pen default `#ef4444` and
  highlighter default `#facc15`); the active one carries a check; tapping
  applies immediately and the menu stays open so colors compare.
* Custom row: a hex TEXT field (works on every platform, iPad included; live
  applies `#rgb`/`#rrggbb` while typing, invalid input reverts on
  blur/Enter) plus a **feature-detected** native `<input type="color">` chip
  that renders ONLY where that API actually exists — never on iOS.
* Per-tool colors: writes `state.annoColor` +
  `state.toolSettings[tool].color` (pen/highlighter keep independent colors).
* Closing: pointerdown anywhere outside (the anchor canvas toggles instead),
  Escape, tool switch (`setAnnoTool`), opening the size flyout (the two
  flyouts are mutually exclusive), orientation flip, toolbar drag/re-dock/
  resize (floattools.js guarded `closeToolColorMenu()` hooks).
* `events.js` handlePointerDown ignores `#tool-color-menu` (same stroke
  guard as `#tool-size-menu`).

## Bonus fix — per-tool colors AND sizes now survive reloads

While verifying persistence it turned out `state.toolSettings` (the per-tool
color + thickness buckets) was **never included in the settings blob** — so
every reload reset colors AND tool sizes to the in-code defaults. The blob
now carries `toolSettings` and boot MERGES it back **before** `setAnnoTool`
reads it. Pick blue once → reload → still blue (verified live).

## Separators removed

All separators inside the floating annotation toolbar are gone (the
`w-px` sliver between the App-Modes and Draw-Tools groups, the
`#pen-customization-sep` before the pen options, and the hairline inside
pen-customization) — the groups' own rounded gray trays already separate
them, and the bar gets measurably narrower. The dead
`#float-toolbar.ft-vertical .w-px` hairline CSS rule is removed too.

## Other changes

* The dead hidden `<input type="color">` markup, the `config.js` els entry
  and every `els.colorPicker` reference are removed; `ui.js`
  `updateThicknessPreview` binds the canvas to `toggleToolColorMenu`.
* z-index chain updated: toolbar 1150 < sidebar 1200 < **flyouts 1210**
  (a transient popover floats above the persistent sidebar card; the panel
  minimize button at 1250 still wins).
* Touch media query grows the palette + swatches (34px targets) inside the
  existing `(hover: none), (pointer: coarse)` block.
* Cache version bumped `ftsize-v21` → **`ipadcolor-v22`** everywhere
  (CSS link, all 22 script tags, header chip) + `colormenu.js` added after
  `sizemenu.js`.

## Tests

* NEW `tests/test_tool_color_menu.js` — 37 tests / 5 suites: versioning
  (incl. ftsize-v21 retirement from all shipped files), markup (body-level
  shell, ids, native input + separators GONE, script order), CSS contract
  (glass, z-1210, hidden/open states, @supports fallback, grid, touch), VM
  engine (hex normalization, open/close/toggle, render + per-tool titles,
  apply/persist/readouts, invalid rejection, owner switches, outside-close
  semantics incl. anchor exemption, Escape, hex live-apply/revert/no-clobber,
  iOS-vs-desktop native-chip feature detection, rail/ribbon placement math
  incl. flips + clamps), wiring (ui.js/app.js/config.js/events.js/
  sizemenu.js/floattools.js contracts).
* Sibling suites updated: version constants (`CURRENT=ipadcolor-v22`,
  `SHIPPED += ftsize-v21`), separator + color-picker absence assertions,
  z-order expectation, script-tag list.
* Battery: 404 JS tests green across 15 suites (+ 11 Python). Zero page
  errors (yjs CDN warning pre-existing).

## Live verification (agent-browser, real server)

* Chip `ipadcolor-v22`; no `#color-picker`, no separators in the toolbar.
* Pen → tap canvas → palette opens below the canvas in ribbon mode and
  beside it (exactly anchor.right+8) in the rail; 15 swatches; active check;
  chip + hex synced; native chip present on desktop Chromium.
* Swatch tap → `state.annoColor`/pen bucket updated, highlighter bucket
  untouched, menu stays open; real mouse-drawn stroke carries the picked
  color end-to-end.
* Hex typing live-applies; outside pointerdown closes; canvas toggles;
  Escape closes; second pen tap opens the SIZE menu and closes the palette.
* Reload → per-tool colors restored (`toolSettings` round-trip).
* Menu floats above the docked AI sidebar (z-1210) — no clipped columns.
* Screenshots: scripts/cm_ribbon_open2.png (palette over sidebar),
  scripts/cm_rail_open.png (rail + palette right of pen), scripts/cm_pink_hex.png.

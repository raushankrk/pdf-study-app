# Testing checklist for PDF Linker Studio touch + multi-device fixes

This file documents the testing that was performed (and the additional manual
testing the user can do to verify each fix).

## Automated tests (already run)

### Backend (`scripts/test_backend_fixes.py`)
- `GET /api/projects/{id}/revision` returns the current revision counter.
- `PUT /api/annotations/{doc}/{page}` without `X-Expected-Revision` succeeds.
- `PUT` with a stale `X-Expected-Revision` returns HTTP 409 with the current
  server data + revision.
- `PUT` with `X-Force-Write: 1` skips the check and overwrites.
- `PUT` with the correct `X-Expected-Revision` succeeds and bumps the revision.
- Deleting Project A removes every related row from every table.
- Deleting Project A leaves Project B's rows completely untouched.
- The on-disk DB file shrinks after delete + VACUUM.

### Frontend (`scripts/test_frontend_undo.js`)
- 30 assertions covering the unified undo/redo history.
- Pushing actions on left then right then left then right, undo removes them
  in reverse chronological order (right-2, left-image, right-1, left-1).
- Redo restores them in forward chronological order.
- A new action after undos correctly truncates the redo tail.

## Manual testing (touch / multi-device)

### Touch — iPad / Android tablet
1. Open the editor URL on the iPad (same Wi-Fi as the PC).
2. Verify tool buttons are at least 40×40px (CSS @media pointer: coarse).
3. Tap the **Pen** tool, then drag one finger on the PDF — stroke draws.
4. Tap **Highlighter**, then drag — highlighter stroke draws.
5. Tap **Select**, then tap an existing stroke — selection rectangle appears
   with a bigger handle (28×28 on touch).
6. Drag the selection — moves with the finger.
7. Drag the bottom-right handle — resizes proportionally.
8. Pinch with two fingers — zooms in/out, content stays under gesture center.
9. Two-finger drag — pans (scrolls) the viewport.
10. Tap **Snip & Link**, draw a rectangle on the left with one finger.
11. Lift finger — preview image appears at the lift position.
12. Tap on the right viewport — image + link dropped at the tap location.
13. Tap **Add Image** — file picker opens immediately (was: required a tap
    on the canvas first, which often failed on iOS Safari).
14. Tap **Undo** — most recent action is removed, regardless of side.
15. Tap **Redo** — restores the just-undone action.
16. Page navigation (chevron buttons) work with single taps.
17. Zoom buttons (− 100% +) work with single taps.
18. No accidental text-selection callouts during long-press on canvas.

### Multi-device
1. Open the same project on Device A and Device B.
2. On Device A, draw a stroke on page 1 of doc X.
3. Wait ~30 seconds. Device B shows a yellow banner at top-right:
   "Another device modified this project. Reload now".
4. On Device B, draw a stroke on page 1 of doc X (same page).
5. Server returns 409 — Device B shows a modal:
   "Conflict — another device modified this page.
   [Cancel] [Overwrite] [Reload from server]".
6. Tap **Reload from server** — Device B's local stroke is discarded, the
   server's stroke is loaded.
7. Repeat step 4 — this time tap **Overwrite** — Device B's stroke replaces
   the server's.
8. Repeat step 4 — tap **Cancel** — local change is kept, no save made.

### Undo / Redo
1. With doc A on left, doc B on right.
2. Draw stroke A1 (left), then B1 (right), then A2 (left), then B2 (right).
3. Press Ctrl+Z (or tap Undo button) — B2 is removed first.
4. Press Ctrl+Z — A2 is removed.
5. Press Ctrl+Z — B1 is removed.
6. Press Ctrl+Z — A1 is removed.
7. Press Ctrl+Y (or Ctrl+Shift+Z, or tap Redo) — A1 is restored.
8. Continue redo — order is restored chronologically.
9. Insert an image on left after undos — redo tail is correctly truncated.

### Database cleanup
1. Note the DB file size before: `ls -la data/app.db*`
2. Create a new project "Tmp" via the dashboard.
3. Upload 3 PDFs, draw annotations, add images, create links, chat.
4. Export the project (optional backup).
5. Delete the project via the dashboard (Delete Permanently).
6. Check the server logs — `[vacuum] full VACUUM completed` should print.
7. Note the DB file size after: `ls -la data/app.db*`
8. The total size (.db + .wal + .shm) should be ≤ what it was before step 2.
9. Verify no `data/pdfs/<deleted_project_id>/` directory remains.
10. Open a DIFFERENT project — its PDFs, annotations, links, chats should
    all still be there.

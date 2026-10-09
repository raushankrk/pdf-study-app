# Real-time collaboration (Yjs CRDT + y-websocket)

This document explains the real-time collaborative annotation editing layer
added on top of the existing PDF Linker Studio Server.

## What it does

When two devices (e.g. an iPad and a PC) open the same PDF in the same
project, every annotation edit — **create, move, resize, delete** — is
synchronized between them in real time, with no lost updates.

* If user A draws a stroke while user B is drawing a different stroke on
  the same page, both strokes appear on both devices.
* If user A moves an annotation while user B deletes it, the delete wins
  (tombstones are respected).
* If both devices refresh, the merged state is rebuilt from the
  server-side persistence and reapplied — annotations survive.
* Annotations from Project A **never** appear in Project B (room isolation).

## Architecture

```
┌──────────────┐         WebSocket            ┌──────────────────────┐
│  Device A    │  ◄─────────────────────►   │  Yjs WebSocket server  │
│  Y.Doc       │     binary Yjs updates      │  per (project,doc)     │
│  + Awareness │                              │  + Awareness           │
│              │   ◄─── presence ──►        │  + Y.Map<annoId, lock> │
└──────────────┘                              │  + YStore → SQLite     │
                                              └──────────────────────────┘
┌──────────────┐                                       │
│  Device B    │  ◄────────── same room ──────►       │
│  Y.Doc       │                                       │
└──────────────┘                                       ▼
                                              SQLite (data/app.db)
                                                  anno_yjs_state table
                                                  (every update binary,
                                                   replayed on restart)
```

### The bridge to existing render path

The existing app keeps annotations in `state.annotations[docId][pageId]`
as `{ strokes: [...], images: [...], textBoxes: [...] }`. The render code
(`renderAnnotations`, `renderTextLayer`) reads from there. **We don't
change that.**

Instead, `yjs-collab.js` keeps Yjs as the source of truth and rebuilds
`state.annotations[docId][pageId]` from the Yjs room state whenever it
changes:

```
Yjs update (local OR remote)
    │
    ▼
Yjs observeDeep handler (in yjs-collab.js)
    │
    ▼
rebuild state.annotations[doc][page] from Y.Map<pageId, Y.Map<annoId, data>>
    │
    ▼
renderAnnotations(side) ← existing function, unchanged
```

When the user mutates an annotation locally (drawing a stroke, moving an
image, deleting a text box), the existing mutation code also calls
`yjsSetAnnotation(docId, pageId, annoId, data)` — which pushes the change
into the Yjs CRDT. Yjs then broadcasts the binary update to every other
device in the room, where it gets applied and re-rendered.

## Yjs data model

```
ydoc.getMap('annotations')               // Y.Map<pageId, Y.Map<annoId, data>>
  └─ "page_1" → Y.Map<annoId, {
                  id, type, tool, color, points, ...   // for strokes
                  id, type, src, x, y, w, h              // for images
                  id, type, content, x, y, w, h, fontSize // for text boxes
                }
  └─ "page_2" → Y.Map<annoId, {...}>

ydoc.getMap('locks')                      // Y.Map<annoId, lock>
  └─ "stroke_xxx" → { clientId, userName, color, kind, ts }
```

The `locks` map is the soft edit-lock indicator: when a user starts
dragging or resizing an annotation, their client claims a lock; other
devices see a colored dashed outline + the editor's name on that
annotation. The lock auto-expires after 60 seconds of inactivity.

## Persistence

Every Yjs binary update is appended to the `anno_yjs_state` table in the
existing SQLite database (`data/app.db`):

```sql
CREATE TABLE anno_yjs_state (
    path TEXT NOT NULL,         -- "<project_id>/<doc_id>"
    yupdate BLOB NOT NULL,      -- binary Yjs update
    metadata BLOB,
    timestamp REAL NOT NULL
);
CREATE INDEX idx_anno_yjs_state_path_ts ON anno_yjs_state(path, timestamp);
```

When the Yjs server starts a room (first client connects), it reads every
stored update for that `path`, applies them in order to a fresh `Y.Doc`,
and that becomes the room's state. So a server restart or browser refresh
just rebuilds the same state.

## Project isolation

Every (project_id, doc_id) pair gets its own Yjs room, named
`"<project_id>/<doc_id>"`. Two rooms never share state — the YStore keys
its rows by path, and the project-deletion cascade includes a
`DELETE FROM anno_yjs_state WHERE path LIKE '<project_id>/%'`.

This means: deleting Project A removes all its Yjs CRDT state. Project B's
Yjs state is untouched.

## REST endpoints still work

The existing REST API (`/api/annotations/{doc_id}` etc.) is unchanged —
it's still used for the initial load (before Yjs connects) and as a
fallback if the Yjs server is unreachable. The Yjs layer is purely
additive.

Two new endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| WS | `/ws/yjs/{project_id}/{doc_id}` | Yjs room — sync + awareness |
| GET | `/api/yjs/state/{project_id}/{doc_id}` | Returns merged Yjs binary state |

## Presence

Each connected client sets an Awareness state with `{ user: { name, color }, pageId, annoId }`.
The presence banner at the top-right of the editor shows every connected
user as a colored avatar. When a user disconnects (closes the tab, etc.),
their awareness entry is removed within ~30 seconds.

## Edit locks

When a user starts dragging or resizing an annotation, `yjsClaimLock(annoId, kind)`
is called — it sets an entry in the Yjs `locks` map. Other devices see the
lock via `yjsGetLock(annoId)` and draw a colored dashed outline + the
editor's name on the annotation.

When the drag/resize ends, `yjsReleaseLock(annoId)` clears the lock.
Locks also auto-expire after 60s of inactivity (so a crashed browser
doesn't permanently lock an annotation).

If two users start editing the same annotation simultaneously, both see
each other's lock. Last-writer-wins on the actual data (the CRDT merge
resolves concurrent edits to the same field).

## Files changed

### Backend (Python)

| File | Change |
|------|--------|
| `server/yjs_collab.py` | **NEW** — Yjs WebSocket server, `AppDbYStore` (writes to app.db), `AppYjsServer` (room manager), WebSocket endpoint, REST bootstrap endpoint |
| `server/main.py` | Added the Yjs WebSocket route `/ws/yjs/{project_id}/{doc_id}`, the REST bootstrap endpoint `/api/yjs/state/{project_id}/{doc_id}`, startup/shutdown hooks to start/stop the Yjs server |
| `server/database.py` | Added the `anno_yjs_state` table to the schema (created on `init_db()`) |
| `server/routers/projects.py` | Project-deletion cascade now includes `DELETE FROM anno_yjs_state WHERE path LIKE '<project_id>/%'` |
| `server/routers/documents.py` | Per-doc delete now includes `DELETE FROM anno_yjs_state WHERE path = '<project_id>/<doc_id>'` |
| `server/requirements.txt` | Added `ypy`, `ypy-websocket`, `aiosqlite`, `anyio` |

### Frontend (JavaScript)

| File | Change |
|------|--------|
| `static/js/yjs-collab.js` | **NEW** — Yjs client bridge: `yjsConnect`, `yjsDisconnect`, `yjsSetAnnotation`, `yjsClaimLock`, `yjsReleaseLock`, presence banner, lock-overlay rendering |
| `static/js/pdf.js` | `ensureDocLoaded` now also calls `yjsConnect(projectId, docId)` after the PDF loads |
| `static/js/annotations.js` | Every annotation now has an `id` field; stroke/image/textbox creation + deletion + drag-end + clear-page all push to Yjs; `renderAnnotations` draws lock outlines from `yjsGetLock` |
| `static/js/events.js` | Drag/resize start now calls `yjsClaimLock`; drag/resize end calls `yjsReleaseLock` + pushes the updated data to Yjs |
| `static/index.html` | Added Yjs + y-protocols + y-websocket CDN scripts; added `<script src="/js/yjs-collab.js">` |
| `static/css/style.css` | Added `.yjs-presence-banner`, `.yjs-avatar`, `.yjs-lock-overlay` styles |

## How to test manually

1. Start the server: `./run.sh` (or `python3 -m uvicorn server.main:app`)
2. Open `http://localhost:8000/` on Device A (e.g. the PC).
3. Open the same project/PDF in another browser tab or another device
   on the same LAN (e.g. iPad at `http://PC-IP:8000/editor/<project_id>`).
4. Draw a stroke on Device A — it should appear on Device B within
   ~500ms.
5. Drag an annotation on Device A — Device B shows a colored outline
   with your name on it while you drag.
6. Delete an annotation on Device B — it disappears on Device A.
7. Refresh both browsers — the annotations remain.
8. Switch to a different project — annotations from the first project
   do NOT appear.

## Automated tests

* `scripts/test_yjs_collab.py` — 4 backend tests:
  1. Two clients sync edits without overwrite (add, move, delete).
  2. Persistence — server restart keeps state; REST bootstrap works.
  3. Project isolation — Project A's annotations never appear in Project B.
  4. Project deletion cascades to Yjs state.
* `scripts/test_yjs_frontend.js` — 20 tests verifying the yjs-collab.js
  module exports the expected functions and is safe to call when not
  connected.
* `scripts/test_backend_fixes.py` — existing backend regression tests
  (still pass — conflict detection, VACUUM, project isolation).
* `scripts/test_frontend_undo.js` — existing frontend undo/redo tests
  (still pass — 30/30).

All tests pass.

## Dependencies

Open-source only:
* Backend: [`y-py`](https://github.com/y-crdt/ypy) (Python port of Yjs CRDT)
  + [`ypy-websocket`](https://github.com/y-crdt/ypy-websocket) (y-websocket server)
  + `aiosqlite` + `anyio` (already pulled by ypy-websocket).
* Frontend: [`yjs`](https://github.com/yjs/yjs) +
  [`y-protocols`](https://github.com/yjs/y-protocols) +
  [`y-websocket`](https://github.com/yjs/y-websocket) — loaded from CDN.

## Limitations / known issues

* **Stroke-level merge only.** If two users move the same annotation at
  the same time, last-write-wins on the data (the CRDT only guarantees
  no update is *lost* — concurrent edits to the same field are
  last-writer-wins, not field-level merge).
* **Images are synced as base64.** A large pasted image will create a
  large Yjs update. For typical use this is fine; for very large
  images, consider uploading via REST first and storing only the URL.
* **No auth.** Anyone on the LAN can join any room. This matches the
  existing single-user-no-auth model.
* **Awareness cleanup:** if a browser crashes without cleanly closing
  the WebSocket, its awareness entry lingers for ~30 seconds before
  the Yjs server times it out. Locks auto-expire after 60s.

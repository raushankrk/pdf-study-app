"""
Yjs collaboration server for real-time annotation editing.

Architecture
------------
* Each (project_id, document_id) pair maps to a Yjs "room" identified by
  the URL path `/ws/yjs/{project_id}/{doc_id}`. Two clients editing the same
  PDF on the same project join the same room and receive each other's
  updates in real time.
* Each room owns a `Y.YDoc` with the following structure::

      ydoc.getMap('annotations')          # Y.Map<pageId, Y.Map<annoId, annoData>>
        └─ page X → Y.Map<annoId, annoData>     # one entry per annotation
        └─ page Y → Y.Map<annoId, annoData>

  Plus the Yjs Awareness protocol handles presence (who is online, what
  page they're looking at, what annotation they're currently editing).

* Durable persistence: a SQLiteYStore subclass writes every Yjs update
  binary into the existing `app.db` SQLite database, in a new table
  `anno_yjs_state`. So when the server restarts or a client refreshes,
  the Yjs document state is rebuilt from the stored updates and replayed
  into a fresh Y.Doc — surviving crashes / refreshes.

* Project isolation: the room name encodes `{project_id}/{doc_id}`, and
  the SQLiteYStore keys its rows by that path. Two projects never share
  a room or a YStore row.

This module runs as a sidecar task inside the FastAPI process. The main
app routes WebSocket connections on `/ws/yjs/{project_id}/{doc_id}` to
`WebsocketServer.serve(websocket)`.

No existing REST endpoints are modified — Yjs is purely additive. The
old `/api/annotations/{doc_id}` REST endpoints still work for non-
collaborative clients; the frontend decides which transport to use.
"""
import os
import asyncio
import logging
from typing import Optional

import y_py as Y
from ypy_websocket import WebsocketServer, YRoom
from ypy_websocket.ystore import SQLiteYStore
from anyio import create_task_group

from . import config
from . import database as db

logger = logging.getLogger("pdf_linker_studio.yjs")
if not logger.handlers:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter("[yjs] %(levelname)s %(message)s"))
    logger.addHandler(h)
logger.setLevel(logging.INFO)


# ---- Persistence layer -----------------------------------------------------
#
# Subclass SQLiteYStore so all Yjs update binaries are stored in the SAME
# SQLite database file as the rest of the application data (data/app.db).
# This keeps the deployment a single file (easy backup / export / import)
# and lets the existing VACUUM cleanup logic reclaim space when a project
# is deleted.

class AppDbYStore(SQLiteYStore):
    """SQLiteYStore that writes Yjs updates into the main application DB.

    `path` here is the Yjs room path (e.g. "proj_abc/doc_xyz"), NOT a
    filesystem path — the SQLiteYStore uses it as the row's `path` column
    so multiple rooms can coexist in one DB file.
    """
    # Override: use the existing app DB file.
    db_path = config.DB_PATH

    async def _init_db(self):
        """Ensure the yupdates table exists. Idempotent.

        The table is also created by the main schema in database.py — but
        we keep this check so the YStore works even on a database that
        predates the schema addition (or if someone creates a fresh DB
        without going through init_db).
        """
        import aiosqlite
        async with self.lock:
            async with aiosqlite.connect(self.db_path) as database:
                await database.execute(
                    "CREATE TABLE IF NOT EXISTS anno_yjs_state ("
                    "  path TEXT NOT NULL,"
                    "  yupdate BLOB NOT NULL,"
                    "  metadata BLOB,"
                    "  timestamp REAL NOT NULL"
                    ")"
                )
                await database.execute(
                    "CREATE INDEX IF NOT EXISTS idx_anno_yjs_state_path_ts "
                    "ON anno_yjs_state(path, timestamp)"
                )
                await database.commit()
        self.db_initialized.set()

    async def read(self):
        """Replay every stored Yjs update for this room's path, in order.

        Yields (update, metadata, timestamp) tuples. The caller (YRoom)
        applies each update to a fresh Y.Doc to reconstruct the full state.
        """
        import aiosqlite
        await self.db_initialized.wait()
        try:
            async with self.lock:
                async with aiosqlite.connect(self.db_path) as database:
                    async with database.execute(
                        "SELECT yupdate, metadata, timestamp FROM anno_yjs_state "
                        "WHERE path = ? ORDER BY timestamp ASC",
                        (self.path,),
                    ) as cursor:
                        found = False
                        async for update, metadata, timestamp in cursor:
                            found = True
                            yield update, metadata, timestamp
                        if not found:
                            from ypy_websocket.ystore import YDocNotFound
                            raise YDocNotFound
        except Exception:
            from ypy_websocket.ystore import YDocNotFound
            raise YDocNotFound

    async def write(self, data: bytes) -> None:
        """Persist one Yjs update binary for this room's path.

        `data` is a binary Yjs update — small (typically a few hundred bytes
        per change) and self-describing (CRDT ops are idempotent + commutative,
        so storing every update is safe and ordering-independent).
        """
        import aiosqlite
        import time as _time
        await self.db_initialized.wait()
        async with self.lock:
            async with aiosqlite.connect(self.db_path) as database:
                metadata = b""
                if self.metadata_callback:
                    md = self.metadata_callback()
                    if asyncio.iscoroutine(md):
                        metadata = await md
                    else:
                        metadata = md
                await database.execute(
                    "INSERT INTO anno_yjs_state (path, yupdate, metadata, timestamp) "
                    "VALUES (?, ?, ?, ?)",
                    (self.path, data, metadata, _time.time()),
                )
                await database.commit()


# ---- Room manager ---------------------------------------------------------
#
# We subclass WebsocketServer only to override `get_room` so it constructs
# each room with our AppDbYStore pointing at the same SQLite database file.
# Everything else (broadcasting, awareness, sync handshake) is handled by
# the base class.

class AppYjsServer(WebsocketServer):
    """WebsocketServer whose rooms persist updates into the main app DB.

    Each room name (e.g. "proj_abc/doc_xyz") becomes the YStore path —
    so updates from different rooms never mix.
    """

    async def get_room(self, name: str) -> YRoom:
        if name not in self.rooms:
            ystore = AppDbYStore(path=name, log=self.log)
            self.rooms[name] = YRoom(ready=self.rooms_ready, ystore=ystore, log=self.log)
        room = self.rooms[name]
        await self.start_room(room)
        return room


# Singleton — created once at app startup.
_yjs_server: Optional[AppYjsServer] = None
_yjs_task: Optional[asyncio.Task] = None


def get_yjs_server() -> AppYjsServer:
    global _yjs_server
    if _yjs_server is None:
        _yjs_server = AppYjsServer(auto_clean_rooms=True, log=logger)
    return _yjs_server


async def start_yjs_server() -> None:
    """Start the Yjs WebSocket server task. Called once at FastAPI startup.

    The task group inside WebsocketServer runs forever (until stop()) and
    manages all per-room broadcast/persistence tasks.
    """
    global _yjs_task, _yjs_server
    server = get_yjs_server()
    if _yjs_task is None or _yjs_task.done():
        _yjs_task = asyncio.create_task(server.start())
        await server.started.wait()
        logger.info("Yjs WebSocket server started")


async def stop_yjs_server() -> None:
    """Stop the Yjs server. Called on FastAPI shutdown."""
    global _yjs_task, _yjs_server
    if _yjs_server is not None:
        _yjs_server.stop()
    if _yjs_task is not None:
        _yjs_task.cancel()
        try:
            await _yjs_task
        except (asyncio.CancelledError, Exception):
            pass
        _yjs_task = None


# ---- REST helpers ----------------------------------------------------------
#
# A simple REST endpoint lets a client bootstrap the initial Yjs state for a
# room WITHOUT a WebSocket round-trip. Useful for:
#   - Very first load (skip WS handshake, GET the merged state, apply it).
#   - Mobile networks where WS may be flaky.
# The endpoint returns the binary Yjs state update (content-type
# application/octet-stream). Clients pass it to Y.applyUpdate(doc, bytes).

def get_yjs_state_binary(project_id: str, doc_id: str) -> bytes:
    """Return the merged Yjs state for a (project_id, doc_id) room.

    Reads every stored update for this room's path from the database, applies
    them to a fresh Y.Doc, and returns Y.encodeStateAsUpdate(doc). This is the
    "snapshot" form — clients can apply it directly with Y.applyUpdate.
    """
    path = f"{project_id}/{doc_id}"
    # Read all stored updates directly from the SQLite DB.
    import sqlite3
    rows = db.query_all(
        "SELECT yupdate FROM anno_yjs_state WHERE path = ? ORDER BY timestamp ASC",
        (path,)
    )
    if not rows:
        return b""
    ydoc = Y.YDoc()
    for r in rows:
        try:
            Y.apply_update(ydoc, r["yupdate"])
        except Exception as e:
            logger.warning(f"failed to apply stored update for {path}: {e}")
    return Y.encode_state_as_update(ydoc)


def delete_yjs_state_for_project(project_id: str) -> int:
    """Delete every stored Yjs update for every document in a project.

    Called from the project-deletion cascade so Yjs data doesn't leak after a
    project is deleted. Returns the number of rows deleted.

    NOTE: this must be invoked INSIDE the project-deletion transaction so the
    cleanup is atomic with the rest of the cascade.
    """
    import sqlite3
    # The path column is "<project_id>/<doc_id>" — a LIKE 'project_id/%'
    # prefix match gets every doc in the project.
    prefix = f"{project_id}/%"
    conn = db.get_conn()
    cur = conn.execute(
        "DELETE FROM anno_yjs_state WHERE path LIKE ?",
        (prefix,)
    )
    n = cur.rowcount
    conn.commit()
    return n


def delete_yjs_state_for_doc(project_id: str, doc_id: str) -> int:
    """Delete every stored Yjs update for a single doc. Used when a doc is
    deleted (called from documents._delete_document_completely).
    """
    path = f"{project_id}/{doc_id}"
    conn = db.get_conn()
    cur = conn.execute(
        "DELETE FROM anno_yjs_state WHERE path = ?",
        (path,)
    )
    n = cur.rowcount
    conn.commit()
    return n


# ---- WebSocket route handler ----------------------------------------------
#
# This is the function FastAPI calls when a client connects to
# /ws/yjs/{project_id}/{doc_id}. We:
#   1. Validate the project exists.
#   2. Validate the doc exists in that project (cheap SQL check).
#   3. Look up the Yjs room (creating it lazily + replaying persisted state).
#   4. Hand off to room.serve(websocket) — which handles the sync handshake,
#      forwards updates, broadcasts awareness, and writes to the YStore.

async def yjs_websocket_endpoint(websocket, project_id: str, doc_id: str):
    """FastAPI WebSocket handler for Yjs collaboration.

    `websocket` is the FastAPI WebSocket object (matches the ypy_websocket
    Websocket protocol — has recv()/send()/path).
    """
    # Validate project + doc BEFORE accepting the connection. If they don't
    # exist, refuse the upgrade. FastAPI's WS API: we accept then close with
    # a code, because you can't send an HTTP-level rejection from a
    # WebSocket route — but the client gets a clean code 4404 + reason.
    project = db.query_one("SELECT id FROM projects WHERE id = ?", (project_id,))
    if not project:
        await websocket.accept()
        await websocket.close(code=4404, reason="Project not found")
        return
    doc = db.query_one(
        "SELECT id FROM documents WHERE id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    if not doc:
        await websocket.accept()
        await websocket.close(code=4404, reason="Document not found in this project")
        return

    await websocket.accept()
    server = get_yjs_server()
    room_name = f"{project_id}/{doc_id}"
    room = await server.get_room(room_name)
    try:
        await room.serve(_FastApiWebsocketAdapter(websocket))
    except Exception as e:
        logger.debug(f"Yjs room {room_name} disconnected: {e}")


class _FastApiWebsocketAdapter:
    """Adapter that wraps a FastAPI WebSocket to match ypy_websocket's
    Websocket protocol (recv/send/path/aiter).

    FastAPI's WebSocket already has `recv()` / `send(bytes)` / `path`, but
    `recv()` returns either str or bytes — ypy_websocket expects bytes only.
    We also expose `__aiter__` so `async for message in websocket` works.
    """
    def __init__(self, ws):
        self._ws = ws

    @property
    def path(self) -> str:
        return self._ws.url.path if hasattr(self._ws, 'url') else '/'

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        try:
            msg = await self._ws.receive_bytes()
            return msg
        except Exception:
            raise StopAsyncIteration()

    async def send(self, message: bytes) -> None:
        await self._ws.send_bytes(message)

    async def recv(self) -> bytes:
        return await self._ws.receive_bytes()

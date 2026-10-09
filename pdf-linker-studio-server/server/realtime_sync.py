"""
Real-time sync via WebSocket.
================================

Provides instant push notifications when a project's data changes, so clients
don't need to poll. This replaces the old 30-second polling loop and makes
conflicts impossible — changes propagate to all connected devices in real time.

How it works:
  1. Each browser tab opens a WebSocket to /ws/sync/{project_id}
  2. When ANY write happens on the server (annotation save, link add, etc.),
     bump_project_revision() is called.
  3. We hook into that call and broadcast a JSON message to all connected
     clients for that project: {"type": "revision_changed", "revision": N}
  4. The client receives the message and calls smartRefreshFromServer() to
     pull the latest data — automatically, instantly, no user action needed.

This is simpler than the old conflict-detection + pause + queue + merge system:
  - No sync toggle button
  - No pending save queue
  - No conflict modal
  - No polling timer
  - Changes appear on all devices within ~100ms
"""

import asyncio
import json
from typing import Dict, Set

from fastapi import WebSocket

# ---- Connection registry ----
# Maps project_id → set of WebSocket connections.
# When a write happens, we broadcast to all connections for that project.
_project_connections: Dict[str, Set[WebSocket]] = {}
_lock = asyncio.Lock()


async def add_connection(project_id: str, ws: WebSocket):
    """Register a WebSocket connection for a project."""
    async with _lock:
        if project_id not in _project_connections:
            _project_connections[project_id] = set()
        _project_connections[project_id].add(ws)


async def remove_connection(project_id: str, ws: WebSocket):
    """Remove a WebSocket connection from a project."""
    async with _lock:
        if project_id in _project_connections:
            _project_connections[project_id].discard(ws)
            if not _project_connections[project_id]:
                del _project_connections[project_id]


async def broadcast_revision_change(project_id: str, revision: int):
    """
    Notify all connected clients for a project that the revision changed.
    Called after every bump_project_revision().

    The message is a small JSON object:
      {"type": "revision_changed", "project_id": "...", "revision": N}

    Clients receive this and immediately call smartRefreshFromServer() to
    pull the latest data. Failed sends (disconnected clients) are silently
    ignored — the client will reconnect on its own.
    """
    message = json.dumps({
        "type": "revision_changed",
        "project_id": project_id,
        "revision": revision,
    })
    async with _lock:
        connections = list(_project_connections.get(project_id, set()))
    for ws in connections:
        try:
            await ws.send_text(message)
        except Exception:
            # Client disconnected — remove it from the set.
            async with _lock:
                if project_id in _project_connections:
                    _project_connections[project_id].discard(ws)
                    if not _project_connections[project_id]:
                        del _project_connections[project_id]


def broadcast_revision_change_sync(project_id: str, revision: int):
    """
    Synchronous wrapper for broadcast_revision_change.
    Used from sync code paths (e.g., inside bump_project_revision which is
    called from sync REST handlers). Schedules the async broadcast on the
    running event loop without blocking.

    FastAPI runs sync route handlers in a thread pool (not the main event
    loop's thread), so we use asyncio.run_coroutine_threadsafe() to schedule
    the coroutine on the main event loop. This is the correct way to call
    async code from a sync context in an async framework.
    """
    global _main_event_loop
    try:
        # If we already captured the main event loop, use it.
        if _main_event_loop is not None and not _main_event_loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                broadcast_revision_change(project_id, revision),
                _main_event_loop
            )
            return
        # Otherwise, try to get the running loop (works if we're in an async handler).
        loop = asyncio.get_running_loop()
        loop.create_task(broadcast_revision_change(project_id, revision))
    except RuntimeError:
        # No running event loop and no captured main loop — fall back to
        # creating a new loop. This is less efficient but works as a last resort.
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(broadcast_revision_change(project_id, revision))
        except Exception:
            pass

# The main event loop, captured on startup so sync handlers can schedule
# coroutines on it. Set by capture_main_event_loop() below.
_main_event_loop = None

def capture_main_event_loop():
    """
    Capture the main event loop so sync REST handlers can schedule async
    broadcasts on it. Called once during server startup.
    """
    global _main_event_loop
    try:
        _main_event_loop = asyncio.get_running_loop()
        print(f"[realtime-sync] captured main event loop: {_main_event_loop}")
    except RuntimeError:
        _main_event_loop = None


async def sync_websocket_endpoint(websocket: WebSocket, project_id: str):
    """
    WebSocket endpoint for real-time sync notifications.

    The client opens: ws://host:port/ws/sync/{project_id}
    The server keeps the connection open and sends a JSON message whenever
    the project's revision changes. The client doesn't need to send anything
    — this is a one-way push channel (but we accept ping/pong for keepalive).
    """
    await websocket.accept()
    await add_connection(project_id, websocket)
    try:
        # Send an initial "connected" message so the client knows it's live.
        await websocket.send_text(json.dumps({
            "type": "connected",
            "project_id": project_id,
        }))
        # Listen for incoming messages (we don't expect any real data, but
        # we need to keep the connection alive and detect disconnects).
        while True:
            # receive_text blocks until a message arrives or the client
            # disconnects. We don't care about the content.
            await websocket.receive_text()
    except Exception:
        # Client disconnected or error — clean up.
        pass
    finally:
        await remove_connection(project_id, websocket)

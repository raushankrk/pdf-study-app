"""FastAPI application entry point. Run with: uvicorn server.main:app"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Request, WebSocket
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .database import init_db
from .routers import documents, folders, annotations, links, chats, settings, projects, ai
from . import yjs_collab
from . import realtime_sync


def create_app() -> FastAPI:
    app = FastAPI(title="PDF Linker Studio API", version="2.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register all REST routers under /api
    app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
    app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
    app.include_router(folders.router, prefix="/api/folders", tags=["folders"])
    app.include_router(annotations.router, prefix="/api/annotations", tags=["annotations"])
    app.include_router(links.router, prefix="/api/links", tags=["links"])
    app.include_router(chats.router, prefix="/api/chats", tags=["chats"])
    app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
    app.include_router(ai.router, prefix="/api/ai", tags=["ai"])

    @app.get("/api/health")
    def health():
        return {"status": "ok", "data_dir": config.DATA_DIR, "version": "2.0.0"}

    # ---- Yjs collaboration: WebSocket endpoint ----
    # Each (project_id, doc_id) maps to a Yjs "room". Clients connect to this
    # endpoint with the y-websocket client library and exchange binary Yjs
    # updates. The room is backed by AppDbYStore which persists every update
    # to the same SQLite DB as the rest of the app — so Yjs state survives
    # server restarts and browser refreshes.
    @app.websocket("/ws/yjs/{project_id}/{doc_id}")
    async def yjs_ws(websocket: WebSocket, project_id: str, doc_id: str):
        await yjs_collab.yjs_websocket_endpoint(websocket, project_id, doc_id)

    # ---- Real-time sync: project-level WebSocket for revision notifications ----
    # Each browser tab connects to this endpoint when the editor loads. The
    # server pushes a JSON message whenever the project's revision changes
    # (i.e., whenever any write happens — annotation save, link add, etc.).
    # The client receives the message and calls smartRefreshFromServer() to
    # pull the latest data instantly — no polling, no conflicts.
    @app.websocket("/ws/sync/{project_id}")
    async def sync_ws(websocket: WebSocket, project_id: str):
        await realtime_sync.sync_websocket_endpoint(websocket, project_id)

    # ---- Yjs collaboration: bootstrap REST endpoint ----
    # Returns the merged Yjs state as binary. A client that can't (or doesn't
    # want to) use the WebSocket can fetch this and call Y.applyUpdate().
    # Most clients will use the WebSocket directly — this is a fallback.
    @app.get("/api/yjs/state/{project_id}/{doc_id}")
    def yjs_state(project_id: str, doc_id: str):
        binary = yjs_collab.get_yjs_state_binary(project_id, doc_id)
        return Response(content=binary, media_type="application/octet-stream")

    # ---- Static frontend ----
    static_dir = config.STATIC_DIR
    if not os.path.isdir(static_dir):
        os.makedirs(static_dir, exist_ok=True)

    app.mount("/css", StaticFiles(directory=os.path.join(static_dir, "css")), name="css")
    app.mount("/js", StaticFiles(directory=os.path.join(static_dir, "js")), name="js")

    # Root: dashboard page (project manager)
    @app.get("/")
    async def root():
        dashboard_path = os.path.join(static_dir, "dashboard.html")
        if os.path.exists(dashboard_path):
            return FileResponse(dashboard_path)
        # Fallback to the editor if dashboard.html is missing (legacy installs)
        return FileResponse(os.path.join(static_dir, "index.html"))

    # Editor: the full PDF editor SPA. The project_id is in the URL path
    # so a refresh keeps you in the same project, and the URL can be shared.
    @app.get("/editor/{project_id}")
    async def editor_page(project_id: str):
        return FileResponse(os.path.join(static_dir, "index.html"))

    # Legacy /editor without project_id → redirect to dashboard
    @app.get("/editor")
    async def editor_no_project():
        return RedirectResponse(url="/")

    # Fallback for any non-API, non-file URL — try static file, else return dashboard.
    @app.exception_handler(404)
    async def not_found_handler(request: Request, exc):
        path = request.url.path
        if path.startswith("/api/"):
            return JSONResponse({"error": "Not found", "path": path}, status_code=404)
        # Try to serve a static file (js, css, favicon)
        file_path = os.path.join(static_dir, path.lstrip("/"))
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        # If it looks like an editor URL without /editor/, serve dashboard.
        return FileResponse(os.path.join(static_dir, "dashboard.html"))

    return app


app = create_app()


@app.on_event("startup")
async def on_startup():
    """Initialize the database schema, data directory, and Yjs server."""
    init_db()
    # Capture the main event loop so sync REST handlers can schedule async
    # WebSocket broadcasts on it (see server/realtime_sync.py).
    realtime_sync.capture_main_event_loop()
    # Start the Yjs WebSocket server as a background task. It owns the room
    # table and the YStore background task that writes updates to SQLite.
    try:
        await yjs_collab.start_yjs_server()
    except Exception as e:
        # Yjs is optional — if it fails to start, the rest of the app still
        # works (REST annotations still function). Log and continue.
        print(f"[startup] Yjs server failed to start (non-fatal): {e}")
    ip = config.get_local_ip()
    if ip:
        print(f"\n  PDF Linker Studio running. Access from other devices at:  http://{ip}:{config.PORT}\n")
    print(f"  Dashboard:  http://localhost:{config.PORT}/")
    print(f"  Editor:     http://localhost:{config.PORT}/editor/<project_id>")
    print(f"  Yjs WS:     ws://localhost:{config.PORT}/ws/yjs/<project_id>/<doc_id>")
    print(f"  Sync WS:    ws://localhost:{config.PORT}/ws/sync/<project_id>\n")


@app.on_event("shutdown")
async def on_shutdown():
    """Stop the Yjs server cleanly so any pending YStore writes flush."""
    try:
        await yjs_collab.stop_yjs_server()
    except Exception:
        pass

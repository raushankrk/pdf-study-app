"""FastAPI application entry point. Run with: uvicorn server.main:app"""
import os
import sys
from pathlib import Path

# Make sure `server` is importable when run as `python -m server.main` or via uvicorn.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .database import init_db
from .routers import documents, folders, annotations, links, chats, settings, projects, ai


def create_app() -> FastAPI:
    app = FastAPI(title="PDF Linker Studio API", version="1.0.0")

    # Allow cross-origin requests (useful if the frontend is served separately or for dev tools).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register all REST routers under /api
    app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
    app.include_router(folders.router, prefix="/api/folders", tags=["folders"])
    app.include_router(annotations.router, prefix="/api/annotations", tags=["annotations"])
    app.include_router(links.router, prefix="/api/links", tags=["links"])
    app.include_router(chats.router, prefix="/api/chats", tags=["chats"])
    app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
    app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
    app.include_router(ai.router, prefix="/api/ai", tags=["ai"])

    # Health check endpoint
    @app.get("/api/health")
    def health():
        return {"status": "ok", "data_dir": config.DATA_DIR}

    # ---- Static frontend ----
    # The frontend lives in static/. Serve index.html for "/" and all other
    # files (js, css) from the static dir.
    static_dir = config.STATIC_DIR
    if not os.path.isdir(static_dir):
        os.makedirs(static_dir, exist_ok=True)

    # Mount /css, /js etc. for direct file access.
    app.mount("/css", StaticFiles(directory=os.path.join(static_dir, "css")), name="css")
    app.mount("/js", StaticFiles(directory=os.path.join(static_dir, "js")), name="js")

    # Root: serve index.html
    @app.get("/")
    async def root():
        return FileResponse(os.path.join(static_dir, "index.html"))

    # Fallback for any non-API, non-file URL — return index.html (SPA-style).
    @app.exception_handler(404)
    async def not_found_handler(request: Request, exc):
        path = request.url.path
        if path.startswith("/api/"):
            return JSONResponse({"error": "Not found", "path": path}, status_code=404)
        # Try to serve a static file
        file_path = os.path.join(static_dir, path.lstrip("/"))
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(static_dir, "index.html"))

    return app


app = create_app()


@app.on_event("startup")
def on_startup():
    """Initialize the database schema and data directory."""
    init_db()
    ip = config.get_local_ip()
    if ip:
        print(f"\n  PDF Linker Studio running. Access from other devices at:  http://{ip}:{config.PORT}\n")

"""FastAPI application entry point. Run with: uvicorn server.main:app"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .database import init_db
from .routers import documents, folders, annotations, links, chats, settings, projects, ai


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
def on_startup():
    """Initialize the database schema and data directory."""
    init_db()
    ip = config.get_local_ip()
    if ip:
        print(f"\n  PDF Linker Studio running. Access from other devices at:  http://{ip}:{config.PORT}\n")
    print(f"  Dashboard:  http://localhost:{config.PORT}/")
    print(f"  Editor:     http://localhost:{config.PORT}/editor/<project_id>\n")

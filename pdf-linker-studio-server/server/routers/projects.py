"""
Projects REST API — multi-project dashboard support.

Endpoints:
  GET    /api/projects                       — list all projects
  POST   /api/projects                       — create a new project
  GET    /api/projects/{project_id}          — get one project (with stats)
  PATCH  /api/projects/{project_id}         — update project metadata (name, description, color)
  DELETE /api/projects/{project_id}          — delete project + ALL its data (DB rows + PDF files)
  POST   /api/projects/{project_id}/export   — download a self-contained .plsx backup file
  POST   /api/projects/import                — import a .plsx backup as a NEW copy

The .plsx backup format is a ZIP archive containing:
  - manifest.json   — project metadata + a list of all files
  - data.sqlite     — SQLite snapshot of all DB rows for this project
  - pdfs/<doc_id>.pdf  — one file per document
"""
import io
import os
import json
import sqlite3
import time
import shutil
import zipfile
import tempfile
import re
from typing import Optional

from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Form, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse, Response
from pydantic import BaseModel

from .. import config
from .. import database as db
from ..deps import get_current_project

router = APIRouter()


# ---- Models ----
class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    color: Optional[str] = "#3b82f6"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None


# ---- Helpers ----
def _generate_id(prefix: str = "proj") -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{os.urandom(4).hex()}"


def _project_row_to_dict(row: dict, include_stats: bool = False) -> dict:
    out = {
        "id": row["id"],
        "name": row["name"],
        "description": row.get("description") or "",
        "color": row.get("color") or "#3b82f6",
        "createdAt": row.get("created_at"),
        "modifiedAt": row.get("modified_at"),
    }
    if include_stats:
        pid = row["id"]
        doc_count = db.query_one(
            "SELECT COUNT(*) as c FROM documents WHERE project_id = ?", (pid,)
        )["c"]
        folder_count = db.query_one(
            "SELECT COUNT(*) as c FROM folders WHERE project_id = ? AND id != 'root'", (pid,)
        )["c"]
        anno_count = db.query_one(
            "SELECT COUNT(*) as c FROM annotations WHERE project_id = ?", (pid,)
        )["c"]
        link_count = db.query_one(
            "SELECT COUNT(*) as c FROM links WHERE project_id = ?", (pid,)
        )["c"]
        chat_count = db.query_one(
            "SELECT COUNT(*) as c FROM chats WHERE project_id = ?", (pid,)
        )["c"]
        emb_count = db.query_one(
            "SELECT COUNT(*) as c FROM embeddings WHERE project_id = ?", (pid,)
        )["c"]
        # Compute total size of PDFs on disk
        total_size = 0
        proj_pdf_dir = os.path.join(config.PDF_DIR, pid)
        if os.path.isdir(proj_pdf_dir):
            for f in os.listdir(proj_pdf_dir):
                try:
                    total_size += os.path.getsize(os.path.join(proj_pdf_dir, f))
                except OSError:
                    pass
        # Add a bit for thumbnails + annotations stored as TEXT in the DB.
        db_size = db.query_one(
            "SELECT COALESCE(SUM(LENGTH(data_json)), 0) as s FROM annotations WHERE project_id = ?",
            (pid,)
        )["s"]
        total_size += db_size or 0
        out.update({
            "docCount": doc_count,
            "folderCount": folder_count,
            "annotationCount": anno_count,
            "linkCount": link_count,
            "chatCount": chat_count,
            "embeddingCount": emb_count,
            "size": total_size,  # bytes
        })
    return out


def _format_size(n: int) -> str:
    if n is None or n <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB"]
    val = float(n)
    for u in units:
        if val < 1024:
            return f"{val:.1f} {u}" if u != "B" else f"{int(val)} {u}"
        val /= 1024
    return f"{val:.1f} TB"


# ---- Endpoints ----

@router.get("")
def list_projects():
    """List all projects with basic stats for the dashboard."""
    rows = db.query_all("SELECT * FROM projects ORDER BY modified_at DESC")
    return [_project_row_to_dict(r, include_stats=True) for r in rows]


@router.post("")
def create_project(project: ProjectCreate):
    name = (project.name or "").strip()
    if not name:
        raise HTTPException(400, "Project name cannot be empty")
    # Duplicate name check (case-insensitive)
    existing = db.query_one(
        "SELECT id FROM projects WHERE LOWER(name) = LOWER(?)", (name,)
    )
    if existing:
        raise HTTPException(409, f"A project named '{name}' already exists")

    pid = _generate_id("proj")
    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO projects (id, name, description, created_at, modified_at, color) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (pid, name, project.description or "", now, now, project.color or "#3b82f6"),
    )
    # Create root folder for this project
    db.execute(
        "INSERT INTO folders (id, project_id, name, parent_id, created_at, expanded) "
        "VALUES ('root', ?, 'Root', NULL, ?, 1)",
        (pid, now),
    )
    # Create the project's PDF directory
    os.makedirs(os.path.join(config.PDF_DIR, pid), exist_ok=True)
    return _project_row_to_dict(db.query_one("SELECT * FROM projects WHERE id = ?", (pid,)))


@router.get("/{project_id}")
def get_project(project_id: str):
    row = db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not row:
        raise HTTPException(404, "Project not found")
    return _project_row_to_dict(row, include_stats=True)


@router.patch("/{project_id}")
def update_project(project_id: str, update: ProjectUpdate):
    row = db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not row:
        raise HTTPException(404, "Project not found")
    updates = []
    params = []
    if update.name is not None:
        name = update.name.strip()
        if not name:
            raise HTTPException(400, "Project name cannot be empty")
        # Duplicate name check (excluding self)
        dup = db.query_one(
            "SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id != ?",
            (name, project_id)
        )
        if dup:
            raise HTTPException(409, f"A project named '{name}' already exists")
        updates.append("name = ?")
        params.append(name)
    if update.description is not None:
        updates.append("description = ?")
        params.append(update.description)
    if update.color is not None:
        updates.append("color = ?")
        params.append(update.color)
    if updates:
        updates.append("modified_at = ?")
        params.append(int(time.time() * 1000))
        params.append(project_id)
        db.execute(f"UPDATE projects SET {', '.join(updates)} WHERE id = ?", tuple(params))
    return _project_row_to_dict(db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,)))


@router.delete("/{project_id}")
def delete_project(project_id: str):
    """Permanently delete a project + all its data (DB rows + PDF files)."""
    if project_id == "default":
        raise HTTPException(400, "The 'default' project cannot be deleted (it holds migrated data).")
    project = db.query_one("SELECT id, name FROM projects WHERE id = ?", (project_id,))
    if not project:
        raise HTTPException(404, "Project not found")

    # Delete all DB rows belonging to this project.
    db.execute("DELETE FROM embeddings WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM annotations WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM links WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM chats WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM documents WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM folders WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM settings WHERE project_id = ?", (project_id,))
    db.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    # Delete all PDF files for this project.
    proj_pdf_dir = os.path.join(config.PDF_DIR, project_id)
    if os.path.isdir(proj_pdf_dir):
        shutil.rmtree(proj_pdf_dir, ignore_errors=True)

    return {"status": "deleted", "project_id": project_id}


# ---- Export ----

@router.post("/{project_id}/export")
def export_project(project_id: str):
    """Export a single project as a self-contained .plsx (zip) backup file.

    The backup contains:
      - manifest.json   — project metadata + version
      - data.sqlite     — SQLite snapshot of all DB rows for this project
                          (tables: folders, documents, annotations, links,
                                    chats, embeddings, settings, project_meta)
      - pdfs/<doc_id>.pdf  — one file per document

    The browser never builds this file — all packing happens server-side.
    """
    project = db.query_one("SELECT * FROM projects WHERE id = ?", (project_id,))
    if not project:
        raise HTTPException(404, "Project not found")

    # Build the SQLite snapshot in memory.
    snapshot = sqlite3.connect(":memory:")
    snapshot.row_factory = sqlite3.Row
    snapshot.executescript("""
        CREATE TABLE project_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE folders (
            id TEXT, name TEXT, parent_id TEXT,
            created_at INTEGER, expanded INTEGER
        );
        CREATE TABLE documents (
            id TEXT, name TEXT, folder_id TEXT, thumbnail TEXT,
            page_count INTEGER, page_ids_json TEXT, file_size INTEGER,
            file_hash TEXT, created_at INTEGER, modified_at INTEGER, favorite INTEGER,
            has_pdf_file INTEGER DEFAULT 1
        );
        CREATE TABLE annotations (
            doc_id TEXT, page_id TEXT, data_json TEXT,
            PRIMARY KEY (doc_id, page_id)
        );
        CREATE TABLE links (id TEXT, source_json TEXT, target_json TEXT, created_at INTEGER);
        CREATE TABLE chats (id TEXT, title TEXT, messages_json TEXT, created_at INTEGER);
        CREATE TABLE embeddings (id TEXT, doc_id TEXT, page_id TEXT, text TEXT, vector_json TEXT);
        CREATE TABLE settings (key TEXT, value TEXT);
    """)

    # Project metadata
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('id', ?)", (project["id"],)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('name', ?)", (project["name"],)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('description', ?)",
        (project.get("description") or "",)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('color', ?)",
        (project.get("color") or "#3b82f6",)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('created_at', ?)",
        (str(project["created_at"]),)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('modified_at', ?)",
        (str(project["modified_at"]),)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('backup_format_version', ?)",
        ("1",)
    )
    snapshot.execute(
        "INSERT INTO project_meta (key, value) VALUES ('backup_created_at', ?)",
        (str(int(time.time() * 1000)),)
    )

    # Copy each table's rows (project_id stripped — the import generates fresh IDs anyway).
    for row in db.query_all(
        "SELECT id, name, parent_id, created_at, expanded FROM folders WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO folders (id, name, parent_id, created_at, expanded) VALUES (?, ?, ?, ?, ?)",
            (row["id"], row["name"], row["parent_id"], row["created_at"], row["expanded"])
        )

    pdfs_to_pack = []  # list of (doc_id, file_path)
    for row in db.query_all(
        "SELECT id, name, folder_id, thumbnail, page_count, page_ids_json, file_size, "
        "file_hash, created_at, modified_at, favorite, file_path FROM documents WHERE project_id = ?",
        (project_id,)
    ):
        # Check if the PDF file actually exists on disk
        has_pdf = 1
        if not row["file_path"] or not os.path.exists(row["file_path"]):
            has_pdf = 0
        else:
            pdfs_to_pack.append((row["id"], row["file_path"]))
        snapshot.execute(
            "INSERT INTO documents (id, name, folder_id, thumbnail, page_count, page_ids_json, "
            "file_size, file_hash, created_at, modified_at, favorite, has_pdf_file) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (row["id"], row["name"], row["folder_id"], row["thumbnail"], row["page_count"],
             row["page_ids_json"], row["file_size"], row["file_hash"],
             row["created_at"], row["modified_at"], row["favorite"], has_pdf)
        )

    for row in db.query_all(
        "SELECT doc_id, page_id, data_json FROM annotations WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO annotations (doc_id, page_id, data_json) VALUES (?, ?, ?)",
            (row["doc_id"], row["page_id"], row["data_json"])
        )

    for row in db.query_all(
        "SELECT id, source_json, target_json, created_at FROM links WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO links (id, source_json, target_json, created_at) VALUES (?, ?, ?, ?)",
            (row["id"], row["source_json"], row["target_json"], row["created_at"])
        )

    for row in db.query_all(
        "SELECT id, title, messages_json, created_at FROM chats WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO chats (id, title, messages_json, created_at) VALUES (?, ?, ?, ?)",
            (row["id"], row["title"], row["messages_json"], row["created_at"])
        )

    for row in db.query_all(
        "SELECT id, doc_id, page_id, text, vector_json FROM embeddings WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO embeddings (id, doc_id, page_id, text, vector_json) VALUES (?, ?, ?, ?, ?)",
            (row["id"], row["doc_id"], row["page_id"], row["text"], row["vector_json"])
        )

    for row in db.query_all(
        "SELECT key, value FROM settings WHERE project_id = ?",
        (project_id,)
    ):
        snapshot.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            (row["key"], row["value"])
        )

    snapshot.commit()

    # Serialize the snapshot to bytes via the backup API to a temp file.
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        snap_path = tmp.name
    snap_target = sqlite3.connect(snap_path)
    snapshot.backup(snap_target)
    snap_target.close()
    snapshot.close()
    with open(snap_path, "rb") as f:
        snap_bytes = f.read()
    os.remove(snap_path)

    # ---- Pack everything into a zip ----
    # We stream the zip from memory; for large projects this could be improved
    # by writing to a temp file and using FileResponse, but memory is fine for
    # typical use (<2 GB).
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Manifest
        manifest = {
            "format": "pdf-linker-studio-project",
            "version": 1,
            "project_id": project["id"],
            "project_name": project["name"],
            "created_at": int(time.time() * 1000),
            "pdf_count": len(pdfs_to_pack),
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        # SQLite snapshot
        zf.writestr("data.sqlite", snap_bytes)
        # PDFs
        for doc_id, file_path in pdfs_to_pack:
            try:
                with open(file_path, "rb") as f:
                    zf.writestr(f"pdfs/{doc_id}.pdf", f.read())
            except OSError as e:
                print(f"[export] could not read {file_path}: {e}")
                # Write a placeholder so import knows the PDF is missing
                zf.writestr(f"pdfs/{doc_id}.pdf.MISSING", b"")

    buf.seek(0)
    safe_name = re.sub(r"[^\w\-. ]", "_", project["name"]) or "project"
    filename = f"{safe_name}.plsx"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---- Import ----

@router.post("/peek")
async def peek_backup(file: UploadFile = File(...)):
    """Read just the manifest.json from an uploaded .plsx file and return the
    project name + metadata. This lets the dashboard show the user the original
    project name BEFORE committing to the import.

    Returns: { project_name, project_id, description, color, format, version }
    """
    contents = await file.read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".plsx", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        if not zipfile.is_zipfile(tmp_path):
            raise HTTPException(400, "Uploaded file is not a valid .plsx backup")

        with zipfile.ZipFile(tmp_path, "r") as zf:
            names = zf.namelist()
            if "manifest.json" not in names:
                raise HTTPException(400, "Backup is missing manifest.json")

            manifest = json.loads(zf.read("manifest.json"))
            if manifest.get("format") != "pdf-linker-studio-project":
                raise HTTPException(400, "Backup format is not recognized")

            # If the snapshot is also available, read the project_meta for richer info
            project_name = manifest.get("project_name", "Imported Project")
            project_id = manifest.get("project_id", "")
            description = ""
            color = "#3b82f6"
            created_at = manifest.get("created_at")

            if "data.sqlite" in names:
                snap_bytes = zf.read("data.sqlite")
                with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as snap_tmp:
                    snap_tmp.write(snap_bytes)
                    snap_path = snap_tmp.name
                try:
                    src = sqlite3.connect(snap_path)
                    src.row_factory = sqlite3.Row
                    def meta(key, default=None):
                        r = src.execute(
                            "SELECT value FROM project_meta WHERE key = ?", (key,)
                        ).fetchone()
                        return r[0] if r else default
                    project_name = meta("name", project_name)
                    project_id = meta("id", project_id)
                    description = meta("description", "") or ""
                    color = meta("color", "#3b82f6")
                    created_at = int(meta("created_at", str(created_at or 0)))
                    src.close()
                finally:
                    try:
                        os.remove(snap_path)
                    except OSError:
                        pass

            return {
                "project_name": project_name,
                "project_id": project_id,
                "description": description,
                "color": color,
                "created_at": created_at,
                "format": manifest.get("format"),
                "version": manifest.get("version", 1),
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Could not read backup: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@router.post("/import")
async def import_project(
    file: UploadFile = File(...),
    new_name: Optional[str] = Form(None),
    on_conflict: str = Form("copy"),  # 'copy' (default) or 'cancel'
):
    """Import a .plsx backup file as a NEW project copy.

    Args:
        file: the uploaded .plsx file
        new_name: optional custom name for the imported project. If omitted,
                  uses the original project name + " (Imported)".
        on_conflict: what to do if a project with the same name already exists.
                     'copy' (default) appends " (Copy N)" until unique.
                     'cancel' returns 409 without importing.

    Returns:
        {id, name, ...} of the newly-created project.
    """
    # 1. Read the uploaded file to a temp location
    contents = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".plsx", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        # 2. Open as a zip
        if not zipfile.is_zipfile(tmp_path):
            raise HTTPException(400, "Uploaded file is not a valid .plsx backup")
        with zipfile.ZipFile(tmp_path, "r") as zf:
            names = zf.namelist()
            if "manifest.json" not in names or "data.sqlite" not in names:
                raise HTTPException(400, "Backup is missing manifest.json or data.sqlite")

            manifest = json.loads(zf.read("manifest.json"))
            if manifest.get("format") != "pdf-linker-studio-project":
                raise HTTPException(400, "Backup format is not recognized")

            # Read the SQLite snapshot to a temp file
            with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as snap_tmp:
                snap_tmp.write(zf.read("data.sqlite"))
                snap_path = snap_tmp.name

            try:
                src = sqlite3.connect(snap_path)
                src.row_factory = sqlite3.Row

                # Read project metadata from the snapshot
                def meta(key, default=None):
                    r = src.execute(
                        "SELECT value FROM project_meta WHERE key = ?", (key,)
                    ).fetchone()
                    return r[0] if r else default

                original_name = meta("name", "Imported Project")
                original_id = meta("id", "imported")

                # 3. Resolve the new project name (handle conflict)
                desired_name = (new_name or original_name).strip()
                if not desired_name:
                    desired_name = "Imported Project"

                # If on_conflict='cancel' and a project with this name exists, bail out
                if on_conflict == "cancel":
                    existing = db.query_one(
                        "SELECT id FROM projects WHERE LOWER(name) = LOWER(?)", (desired_name,)
                    )
                    if existing:
                        raise HTTPException(
                            409,
                            f"A project with the name '{desired_name}' already exists. "
                            "Use on_conflict='copy' to import as a new copy."
                        )
                else:
                    # Find a unique name
                    candidate = desired_name
                    counter = 1
                    while db.query_one(
                        "SELECT id FROM projects WHERE LOWER(name) = LOWER(?)", (candidate,)
                    ):
                        candidate = f"{desired_name} (Copy {counter})"
                        counter += 1
                    desired_name = candidate

                # 4. Create the new project
                new_pid = _generate_id("proj")
                now = int(time.time() * 1000)
                color = meta("color", "#3b82f6")
                original_created = int(meta("created_at", str(now)))
                db.execute(
                    "INSERT INTO projects (id, name, description, created_at, modified_at, color) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (new_pid, desired_name, meta("description", "") or "", original_created, now, color)
                )

                # 5. Build a folder-ID remapping (the source IDs may collide with existing rows
                # if the same backup has been imported before; to be 100% safe we generate new
                # IDs for every row). The 'root' folder always keeps its ID.
                folder_id_map = {"root": "root"}
                for row in src.execute("SELECT id FROM folders").fetchall():
                    old_id = row["id"]
                    if old_id == "root":
                        continue
                    folder_id_map[old_id] = _generate_id("folder")

                # 6. Insert folders with new IDs (preserving parent_id mapping)
                for row in src.execute("SELECT * FROM folders").fetchall():
                    old_id = row["id"]
                    new_id = folder_id_map.get(old_id, old_id)
                    old_parent = row["parent_id"]
                    new_parent = folder_id_map.get(old_parent, "root") if old_parent else None
                    db.execute(
                        "INSERT INTO folders (id, project_id, name, parent_id, created_at, expanded) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (new_id, new_pid, row["name"], new_parent,
                         row["created_at"] or now, row["expanded"] if "expanded" in row.keys() else 1)
                    )

                # 7. Insert documents (with new doc IDs) + copy PDF files
                doc_id_map = {}
                # Create the project's PDF directory
                proj_pdf_dir = os.path.join(config.PDF_DIR, new_pid)
                os.makedirs(proj_pdf_dir, exist_ok=True)

                for row in src.execute("SELECT * FROM documents").fetchall():
                    old_doc_id = row["id"]
                    new_doc_id = _generate_id("doc")
                    doc_id_map[old_doc_id] = new_doc_id

                    # Map folder_id
                    old_folder = row["folder_id"]
                    new_folder = folder_id_map.get(old_folder, "root") if old_folder else "root"

                    # Copy the PDF file from the zip if present
                    has_pdf = row["has_pdf_file"] if "has_pdf_file" in row.keys() else 1
                    pdf_missing_marker = f"pdfs/{old_doc_id}.pdf.MISSING"
                    pdf_entry = f"pdfs/{old_doc_id}.pdf"
                    new_file_path = ""
                    if has_pdf and pdf_entry in names:
                        try:
                            pdf_bytes = zf.read(pdf_entry)
                            new_file_path = os.path.join(proj_pdf_dir, f"{new_doc_id}.pdf")
                            with open(new_file_path, "wb") as f:
                                f.write(pdf_bytes)
                        except (KeyError, OSError) as e:
                            print(f"[import] failed to extract PDF for {old_doc_id}: {e}")
                            new_file_path = ""
                    elif pdf_missing_marker in names:
                        print(f"[import] PDF for {old_doc_id} was missing in the backup — skipping file")

                    page_ids_json = row["page_ids_json"] or "[]"
                    db.execute(
                        "INSERT INTO documents (id, project_id, name, folder_id, file_path, "
                        "thumbnail, page_count, page_ids_json, file_size, file_hash, "
                        "created_at, modified_at, favorite) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_doc_id, new_pid, row["name"], new_folder, new_file_path,
                         row["thumbnail"] or "", row["page_count"] or 0, page_ids_json,
                         row["file_size"] or 0, row["file_hash"],
                         row["created_at"] or now, row["modified_at"] or now,
                         row["favorite"] if "favorite" in row.keys() else 0)
                    )

                # 8. Insert annotations (with remapped doc_id)
                # Annotations contain page_ids embedded in the data_json — but the page_ids
                # are also stored in documents.page_ids_json. To keep things simple AND make
                # the imported copy truly independent, we re-key every pageId in both the
                # annotations data_json AND the document's page_ids_json.

                # First, build a per-doc page_id remap
                page_id_maps = {}  # {old_doc_id: {old_page_id: new_page_id}}
                for row in src.execute("SELECT id, page_ids_json FROM documents").fetchall():
                    old_doc_id = row["id"]
                    try:
                        old_page_ids = json.loads(row["page_ids_json"] or "[]")
                    except json.JSONDecodeError:
                        old_page_ids = []
                    page_map = {}
                    for opid in old_page_ids:
                        page_map[opid] = _generate_id("id")
                    page_id_maps[old_doc_id] = page_map

                    # Update the document's page_ids_json with the new IDs
                    new_doc_id = doc_id_map.get(old_doc_id, old_doc_id)
                    new_page_ids = [page_map.get(p, p) for p in old_page_ids]
                    db.execute(
                        "UPDATE documents SET page_ids_json = ? WHERE id = ? AND project_id = ?",
                        (json.dumps(new_page_ids), new_doc_id, new_pid)
                    )

                # Helper to remap any page_id appearing in a JSON blob.
                def remap_page_ids_in_json(json_str, old_doc_id):
                    """Walk a JSON tree, replacing any string value that matches a known
                    old page_id with its new counterpart. Also rewrites 'docId' fields."""
                    if not json_str:
                        return json_str
                    try:
                        obj = json.loads(json_str)
                    except json.JSONDecodeError:
                        return json_str
                    page_map = page_id_maps.get(old_doc_id, {})
                    new_doc_id = doc_id_map.get(old_doc_id, old_doc_id)

                    def walk(node):
                        if isinstance(node, dict):
                            new_node = {}
                            for k, v in node.items():
                                if k in ("pageId", "page_id") and isinstance(v, str):
                                    new_node[k] = page_map.get(v, v)
                                elif k in ("docId", "doc_id") and isinstance(v, str):
                                    new_node[k] = doc_id_map.get(v, v)
                                else:
                                    new_node[k] = walk(v)
                            return new_node
                        elif isinstance(node, list):
                            return [walk(x) for x in node]
                        elif isinstance(node, str):
                            # Could be a stray page_id stored as a bare string
                            return page_map.get(node, node)
                        return node

                    remapped = walk(obj)
                    return json.dumps(remapped)

                # 9. Insert annotations with remapped doc_id + page_id
                for row in src.execute("SELECT * FROM annotations").fetchall():
                    old_doc_id = row["doc_id"]
                    new_doc_id = doc_id_map.get(old_doc_id, old_doc_id)
                    old_page_id = row["page_id"]
                    page_map = page_id_maps.get(old_doc_id, {})
                    new_page_id = page_map.get(old_page_id, old_page_id)
                    # Rewrite any page_id references inside the data_json (annotations
                    # may reference other pages in links, etc.)
                    new_data_json = remap_page_ids_in_json(row["data_json"], old_doc_id)
                    db.execute(
                        "INSERT INTO annotations (doc_id, project_id, page_id, data_json) "
                        "VALUES (?, ?, ?, ?)",
                        (new_doc_id, new_pid, new_page_id, new_data_json)
                    )

                # 10. Insert links with remapped doc_id + page_id inside source/target JSON
                for row in src.execute("SELECT * FROM links").fetchall():
                    src_json = row["source_json"]
                    tgt_json = row["target_json"]
                    # Determine which doc_id the source/target refers to (we need to know to
                    # pick the right page_id_map). Both endpoints are JSON objects like
                    # {docId, pageId, x, y}.
                    def remap_link_json(jstr):
                        try:
                            obj = json.loads(jstr)
                        except json.JSONDecodeError:
                            return jstr
                        old_did = obj.get("docId") or obj.get("doc_id")
                        new_did = doc_id_map.get(old_did, old_did)
                        if "docId" in obj:
                            obj["docId"] = new_did
                        if "doc_id" in obj:
                            obj["doc_id"] = new_did
                        page_map = page_id_maps.get(old_did, {})
                        if "pageId" in obj:
                            obj["pageId"] = page_map.get(obj["pageId"], obj["pageId"])
                        if "page_id" in obj:
                            obj["page_id"] = page_map.get(obj["page_id"], obj["page_id"])
                        return json.dumps(obj)

                    new_link_id = _generate_id("link")
                    db.execute(
                        "INSERT INTO links (id, project_id, source_json, target_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (new_link_id, new_pid, remap_link_json(src_json),
                         remap_link_json(tgt_json), row["created_at"] or now)
                    )

                # 11. Insert chats (no doc/page references to remap)
                for row in src.execute("SELECT * FROM chats").fetchall():
                    new_chat_id = _generate_id("chat")
                    # Chat messages may contain citation chips with data-doc / data-page-id
                    # attributes that point to old IDs. We remap them so citations still work.
                    msgs_json = row["messages_json"] or "[]"
                    try:
                        msgs = json.loads(msgs_json)
                    except json.JSONDecodeError:
                        msgs = []
                    for m in msgs:
                        if isinstance(m, dict) and "html" in m:
                            html = m["html"]
                            # Replace data-doc="OLD" → data-doc="NEW"
                            for old_did, new_did in doc_id_map.items():
                                html = html.replace(f'data-doc="{old_did}"', f'data-doc="{new_did}"')
                            # Replace data-page-id="OLD" → data-page-id="NEW"
                            # (do this per-doc so we use the right page_map)
                            for old_did, page_map in page_id_maps.items():
                                new_did = doc_id_map.get(old_did, old_did)
                                # IMPORTANT: use new_page_id here, NOT new_pid —
                                # new_pid is the PROJECT ID and must not be shadowed.
                                for old_page_id, new_page_id in page_map.items():
                                    html = html.replace(f'data-page-id="{old_page_id}"', f'data-page-id="{new_page_id}"')
                            m["html"] = html
                        # Also remap any 'context' field's chunks (docId / doc_id, pageId / page_id)
                        if isinstance(m, dict) and isinstance(m.get("context"), list):
                            for chunk in m["context"]:
                                if not isinstance(chunk, dict):
                                    continue
                                old_did = chunk.get("docId") or chunk.get("doc_id")
                                new_did = doc_id_map.get(old_did, old_did)
                                if "docId" in chunk:
                                    chunk["docId"] = new_did
                                if "doc_id" in chunk:
                                    chunk["doc_id"] = new_did
                                page_map = page_id_maps.get(old_did, {})
                                if "pageId" in chunk:
                                    chunk["pageId"] = page_map.get(chunk["pageId"], chunk["pageId"])
                                if "page_id" in chunk:
                                    chunk["page_id"] = page_map.get(chunk["page_id"], chunk["page_id"])
                    db.execute(
                        "INSERT INTO chats (id, project_id, title, messages_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (new_chat_id, new_pid, row["title"] or "Imported Chat",
                         json.dumps(msgs), row["created_at"] or now)
                    )

                # 12. Insert embeddings with remapped doc_id + page_id
                for row in src.execute("SELECT * FROM embeddings").fetchall():
                    old_doc_id = row["doc_id"]
                    new_doc_id = doc_id_map.get(old_doc_id, old_doc_id)
                    old_page_id = row["page_id"]
                    page_map = page_id_maps.get(old_doc_id, {})
                    new_page_id = page_map.get(old_page_id, old_page_id) if old_page_id else None
                    new_emb_id = _generate_id("chunk")
                    db.execute(
                        "INSERT INTO embeddings (id, project_id, doc_id, page_id, text, vector_json) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (new_emb_id, new_pid, new_doc_id, new_page_id,
                         row["text"], row["vector_json"])
                    )

                # 13. Insert settings
                for row in src.execute("SELECT * FROM settings").fetchall():
                    key = row["key"]
                    value = row["value"]
                    # If the settings value references doc IDs (e.g. recentDocIds, view.left.docId),
                    # remap them.
                    if key in ("appState",) or True:
                        try:
                            settings_obj = json.loads(value)
                            if isinstance(settings_obj, dict):
                                # Remap recentDocIds
                                if "recentDocIds" in settings_obj and isinstance(settings_obj["recentDocIds"], list):
                                    settings_obj["recentDocIds"] = [
                                        doc_id_map.get(x, x) for x in settings_obj["recentDocIds"]
                                    ]
                                # Remap view.left.docId / view.right.docId + pageId
                                for side in ("left", "right"):
                                    v = settings_obj.get("view", {}).get(side, {})
                                    if "docId" in v:
                                        v["docId"] = doc_id_map.get(v["docId"], v["docId"])
                                    if "pageId" in v:
                                        # Find the right page_map
                                        old_did = v["docId"]
                                        page_map = page_id_maps.get(
                                            next((k for k, val in doc_id_map.items() if val == old_did), old_did),
                                            {}
                                        )
                                        v["pageId"] = page_map.get(v["pageId"], v["pageId"])
                                value = json.dumps(settings_obj)
                        except json.JSONDecodeError:
                            pass
                    db.execute(
                        "INSERT OR REPLACE INTO settings (key, project_id, value) VALUES (?, ?, ?)",
                        (key, new_pid, value)
                    )

                src.close()
                # Return the new project
                proj_row = db.query_one("SELECT * FROM projects WHERE id = ?", (new_pid,))
                if not proj_row:
                    # This should never happen — if it does, the import partially
                    # failed. Raise a clear error so the user knows to check.
                    raise HTTPException(500, f"Import appeared to succeed but the project "
                                         f"(id={new_pid}) could not be found in the database. "
                                         f"The import may have partially failed.")
                return _project_row_to_dict(proj_row, include_stats=True)

            finally:
                try:
                    os.remove(snap_path)
                except OSError:
                    pass

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Import failed: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

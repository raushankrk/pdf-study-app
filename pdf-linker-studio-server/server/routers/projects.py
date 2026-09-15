"""
Projects export/import REST API.

Mirrors the original SQLite export/import feature, but now happens server-side:
  - Export: build a self-contained SQLite file with all data, return as download
  - Import: receive an uploaded SQLite file, restore all data
"""
import io
import os
import json
import sqlite3
import time
import shutil

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse

from .. import config
from .. import database as db
from .documents import _generate_id, _save_pdf

router = APIRouter()


@router.get("/export")
def export_project():
    """Build a SQLite file containing all data and return it as a download."""
    # Use an in-memory SQLite database for the export.
    out = sqlite3.connect(":memory:")
    out.row_factory = sqlite3.Row

    # Schema mirrors the on-disk schema.
    out.executescript("""
        CREATE TABLE documents (
            id TEXT PRIMARY KEY, name TEXT, pdf_blob BLOB, thumbnail TEXT,
            page_ids_json TEXT, folder_id TEXT, file_size INTEGER,
            created_at INTEGER, modified_at INTEGER, favorite INTEGER DEFAULT 0,
            file_hash TEXT
        );
        CREATE TABLE folders (
            id TEXT PRIMARY KEY, name TEXT, parent_id TEXT,
            created_at INTEGER, expanded INTEGER DEFAULT 1
        );
        CREATE TABLE links (id TEXT PRIMARY KEY, source_json TEXT, target_json TEXT);
        CREATE TABLE annotations (doc_id TEXT, page_id TEXT, data_json TEXT,
            PRIMARY KEY (doc_id, page_id));
        CREATE TABLE embeddings (id TEXT PRIMARY KEY, text TEXT, vector_json TEXT,
            doc_id TEXT, page_id TEXT);
        CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, messages_json TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    """)

    # Copy data row-by-row, loading PDF blobs from disk for the export.
    folders = db.query_all("SELECT * FROM folders")
    for f in folders:
        out.execute("INSERT INTO folders VALUES (?, ?, ?, ?, ?)",
                    (f["id"], f["name"], f["parent_id"], f["created_at"], f["expanded"]))

    docs = db.query_all("SELECT * FROM documents")
    for d in docs:
        pdf_blob = None
        if d["file_path"] and os.path.exists(d["file_path"]):
            with open(d["file_path"], "rb") as f:
                pdf_blob = f.read()
        out.execute(
            """INSERT INTO documents
               (id, name, pdf_blob, thumbnail, page_ids_json, folder_id, file_size,
                created_at, modified_at, favorite, file_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (d["id"], d["name"], pdf_blob, d["thumbnail"], d["page_ids_json"],
             d["folder_id"], d["file_size"], d["created_at"], d["modified_at"],
             d["favorite"], d["file_hash"]),
        )

    links = db.query_all("SELECT * FROM links")
    for l in links:
        out.execute("INSERT INTO links VALUES (?, ?, ?)",
                    (l["id"], l["source_json"], l["target_json"]))

    annos = db.query_all("SELECT * FROM annotations")
    for a in annos:
        out.execute("INSERT INTO annotations VALUES (?, ?, ?)",
                    (a["doc_id"], a["page_id"], a["data_json"]))

    embs = db.query_all("SELECT * FROM embeddings")
    for e in embs:
        out.execute("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?)",
                    (e["id"], e["text"], e["vector_json"], e["doc_id"], e["page_id"]))

    chats = db.query_all("SELECT * FROM chats")
    for c in chats:
        out.execute("INSERT INTO chats VALUES (?, ?, ?)",
                    (c["id"], c["title"], c["messages_json"]))

    s = db.query_one("SELECT value FROM settings WHERE key = 'appState'")
    if s:
        out.execute("INSERT INTO settings VALUES ('appState', ?)", (s["value"],))

    out.commit()

    # Serialize the in-memory DB to bytes.
    buf = io.BytesIO()
    for chunk in out.iterdump():
        pass  # iterdump is text-only; use the backup API instead.
    # Better: use sqlite3 backup to a file-like object.
    target = sqlite3.connect(":memory:")
    out.backup(target)
    # Read the bytes from a temp file (sqlite3 can't dump to bytes directly).
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        target_path = tmp.name
    target2 = sqlite3.connect(target_path)
    target.backup(target2)
    target2.close()
    with open(target_path, "rb") as f:
        data = f.read()
    os.remove(target_path)
    out.close()
    target.close()

    filename = f"pdf_linker_project_{int(time.time())}.sqlite"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/x-sqlite3",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import")
async def import_project(file: UploadFile = File(...)):
    """Receive an uploaded SQLite file and restore all data into the running app."""
    # Read the uploaded file to a temp location
    contents = await file.read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        src = sqlite3.connect(tmp_path)
        src.row_factory = sqlite3.Row

        # Check which tables exist
        def table_cols(table):
            try:
                return [r[1] for r in src.execute(f"PRAGMA table_info({table})").fetchall()]
            except sqlite3.OperationalError:
                return []

        # ---- Folders ----
        # Always ensure root exists
        db.execute(
            "INSERT OR REPLACE INTO folders (id, name, parent_id, created_at, expanded) VALUES (?, ?, ?, ?, ?)",
            ("root", "Root", None, int(time.time() * 1000), 1),
        )
        if "folders" in [r[0] for r in src.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM folders").fetchall():
                if row["id"] == "root":
                    continue
                db.execute(
                    "INSERT OR REPLACE INTO folders (id, name, parent_id, created_at, expanded) VALUES (?, ?, ?, ?, ?)",
                    (row["id"], row["name"], row["parent_id"] or "root",
                     row["created_at"] if "created_at" in row.keys() else int(time.time() * 1000),
                     row["expanded"] if "expanded" in row.keys() else 1),
                )

        # ---- Documents ----
        doc_cols = table_cols("documents")
        if "documents" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            # Build SELECT with only existing columns
            base_cols = ["id", "name", "pdf_blob", "thumbnail", "page_ids_json"]
            optional_cols = ["folder_id", "file_size", "created_at", "modified_at", "favorite", "file_hash"]
            select_cols = base_cols + [c for c in optional_cols if c in doc_cols]
            select_sql = f"SELECT {', '.join(select_cols)} FROM documents"

            for row in src.execute(select_sql).fetchall():
                d = {k: row[k] for k in select_cols}
                doc_id = d["id"]

                # Write PDF blob to disk
                pdf_blob = d.get("pdf_blob")
                if pdf_blob:
                    file_path = os.path.join(config.PDF_DIR, f"{doc_id}.pdf")
                    with open(file_path, "wb") as f:
                        f.write(pdf_blob)
                else:
                    file_path = ""

                page_ids_json = d.get("page_ids_json") or "[]"
                now = int(time.time() * 1000)
                folder_id = d.get("folder_id") or "root"
                # Validate folder exists
                if folder_id != "root" and not db.query_one("SELECT id FROM folders WHERE id = ?", (folder_id,)):
                    folder_id = "root"

                db.execute(
                    """INSERT OR REPLACE INTO documents
                       (id, name, folder_id, file_path, thumbnail, page_count, page_ids_json,
                        file_size, file_hash, created_at, modified_at, favorite)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (doc_id, d["name"], folder_id, file_path, d.get("thumbnail") or "",
                     len(json.loads(page_ids_json)) if page_ids_json else 0, page_ids_json,
                     d.get("file_size") or (len(pdf_blob) if pdf_blob else 0),
                     d.get("file_hash"), d.get("created_at") or now, d.get("modified_at") or now,
                     1 if d.get("favorite") else 0),
                )

        # ---- Annotations ----
        if "annotations" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM annotations").fetchall():
                db.execute(
                    "INSERT OR REPLACE INTO annotations (doc_id, page_id, data_json) VALUES (?, ?, ?)",
                    (row["doc_id"], row["page_id"], row["data_json"]),
                )

        # ---- Links ----
        if "links" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM links").fetchall():
                db.execute(
                    "INSERT OR REPLACE INTO links (id, source_json, target_json, created_at) VALUES (?, ?, ?, ?)",
                    (row["id"], row["source_json"], row["target_json"], int(time.time() * 1000)),
                )

        # ---- Embeddings ----
        if "embeddings" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM embeddings").fetchall():
                db.execute(
                    "INSERT OR REPLACE INTO embeddings (id, text, vector_json, doc_id, page_id) VALUES (?, ?, ?, ?, ?)",
                    (row["id"], row["text"], row["vector_json"], row["doc_id"], row["page_id"]),
                )

        # ---- Chats ----
        if "chats" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM chats").fetchall():
                db.execute(
                    "INSERT OR REPLACE INTO chats (id, title, messages_json, created_at) VALUES (?, ?, ?, ?)",
                    (row["id"], row["title"], row["messages_json"], int(time.time() * 1000)),
                )

        # ---- Settings ----
        if "settings" in [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]:
            for row in src.execute("SELECT * FROM settings").fetchall():
                if row["key"] == "appState":
                    db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                               (row["key"], row["value"]))

        src.close()
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(500, f"Import failed: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

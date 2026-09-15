"""
Documents REST API.

Endpoints:
  GET    /api/documents                 — list all documents (metadata only)
  GET    /api/documents/{doc_id}        — get one document's metadata
  GET    /api/documents/{doc_id}/file   — get PDF bytes (for PDF.js in browser)
  GET    /api/documents/{doc_id}/thumbnail — get thumbnail data URL
  POST   /api/documents/upload           — upload one or more PDFs to a folder
  PUT    /api/documents/{doc_id}         — update metadata (name, folderId, favorite, modifiedAt)
  POST   /api/documents/{doc_id}/duplicate — duplicate the doc
  DELETE /api/documents/{doc_id}         — delete doc + its annotations + links + embeddings + file
  PUT    /api/documents/{doc_id}/move    — move to a different folder
  PUT    /api/documents/{doc_id}/file    — replace the PDF file (after page insert/delete in browser)
"""
import json
import os
import time
import hashlib
import shutil
from typing import Optional, List

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Response
from pydantic import BaseModel

from .. import config
from .. import database as db

router = APIRouter()


# ---- Models ----
class DocumentUpdate(BaseModel):
    name: Optional[str] = None
    folder_id: Optional[str] = None
    favorite: Optional[bool] = None
    modified_at: Optional[int] = None
    page_count: Optional[int] = None
    page_ids: Optional[List[str]] = None


class MoveRequest(BaseModel):
    target_folder_id: str


# ---- Helpers ----
def _doc_row_to_dict(row: dict) -> dict:
    """Convert a DB row to the JSON shape expected by the frontend."""
    page_ids = []
    if row.get("page_ids_json"):
        try:
            page_ids = json.loads(row["page_ids_json"])
        except json.JSONDecodeError:
            page_ids = []
    return {
        "id": row["id"],
        "name": row["name"],
        "folderId": row.get("folder_id") or "root",
        "pageCount": row.get("page_count", 0),
        "thumbnail": row.get("thumbnail"),
        "pageIds": page_ids,
        "fileSize": row.get("file_size", 0),
        "fileHash": row.get("file_hash"),
        "createdAt": row.get("created_at"),
        "modifiedAt": row.get("modified_at"),
        "favorite": bool(row.get("favorite", 0)),
        # Note: we don't return the PDF bytes here — fetched on demand via /file endpoint.
    }


def _generate_id(prefix: str = "doc") -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{os.urandom(4).hex()}"


def _compute_file_hash(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _save_pdf(file: UploadFile, doc_id: str) -> tuple[str, int, str]:
    """Save the uploaded PDF to disk. Returns (file_path, file_size, file_hash)."""
    file_path = os.path.join(config.PDF_DIR, f"{doc_id}.pdf")
    file_size = 0
    sha = hashlib.sha256()
    with open(file_path, "wb") as out:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            sha.update(chunk)
            file_size += len(chunk)
    return file_path, file_size, sha.hexdigest()


def _generate_thumbnail(file_path: str, doc_id: str) -> str:
    """Generate a small thumbnail data URL from page 1 of the PDF.

    Tries PyMuPDF first (much faster, no external deps), falls back to base64
    placeholder if PyMuPDF is not installed.
    """
    try:
        import fitz
        doc = fitz.open(file_path)
        if doc.page_count > 0:
            page = doc.load_page(0)
            pix = page.get_pixmap(matrix=fitz.Matrix(0.2, 0.2))
            png_bytes = pix.tobytes("png")
            import base64
            thumb = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
            doc.close()
            return thumb
        doc.close()
    except ImportError:
        pass
    except Exception as e:
        print(f"Thumbnail generation failed for {file_path}: {e}")
    return ""  # Empty thumbnail — frontend handles gracefully


def _get_page_count(file_path: str) -> int:
    """Return the page count of the PDF. Uses PyMuPDF if available."""
    try:
        import fitz
        doc = fitz.open(file_path)
        count = doc.page_count
        doc.close()
        return count
    except ImportError:
        pass
    except Exception as e:
        print(f"Page count failed for {file_path}: {e}")
    return 0


def _delete_document_completely(doc_id: str):
    """Delete a document and all its associated data (file, annotations, links, embeddings)."""
    row = db.query_one("SELECT file_path FROM documents WHERE id = ?", (doc_id,))
    if row and os.path.exists(row["file_path"]):
        try:
            os.remove(row["file_path"])
        except OSError as e:
            print(f"Failed to remove PDF file {row['file_path']}: {e}")
    db.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    db.execute("DELETE FROM annotations WHERE doc_id = ?", (doc_id,))
    db.execute("DELETE FROM embeddings WHERE doc_id = ?", (doc_id,))
    # Delete any links that reference this doc
    all_links = db.query_all("SELECT id, source_json, target_json FROM links")
    for link in all_links:
        try:
            src = json.loads(link["source_json"])
            tgt = json.loads(link["target_json"])
            if src.get("docId") == doc_id or tgt.get("docId") == doc_id:
                db.execute("DELETE FROM links WHERE id = ?", (link["id"],))
        except json.JSONDecodeError:
            pass


# ---- Endpoints ----

@router.get("")
def list_documents():
    rows = db.query_all("SELECT * FROM documents ORDER BY name")
    return [_doc_row_to_dict(r) for r in rows]


@router.get("/{doc_id}")
def get_document(doc_id: str):
    row = db.query_one("SELECT * FROM documents WHERE id = ?", (doc_id,))
    if not row:
        raise HTTPException(404, "Document not found")
    return _doc_row_to_dict(row)


@router.get("/{doc_id}/file")
def get_document_file(doc_id: str):
    row = db.query_one("SELECT file_path, name FROM documents WHERE id = ?", (doc_id,))
    if not row:
        raise HTTPException(404, "Document not found")
    if not os.path.exists(row["file_path"]):
        raise HTTPException(404, "PDF file missing from server storage")
    with open(row["file_path"], "rb") as f:
        data = f.read()
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{row["name"]}"'})


@router.get("/{doc_id}/thumbnail")
def get_document_thumbnail(doc_id: str):
    row = db.query_one("SELECT thumbnail FROM documents WHERE id = ?", (doc_id,))
    if not row:
        raise HTTPException(404, "Document not found")
    return {"thumbnail": row["thumbnail"]}


@router.post("/upload")
async def upload_documents(
    files: List[UploadFile] = File(...),
    folder_id: str = Form("root"),
):
    """Upload one or more PDFs into the specified folder."""
    if folder_id != "root":
        folder = db.query_one("SELECT id FROM folders WHERE id = ?", (folder_id,))
        if not folder:
            raise HTTPException(400, f"Folder '{folder_id}' does not exist")

    results = []
    for upload in files:
        doc_id = _generate_id("doc")
        try:
            # Save file to disk
            file_path, file_size, file_hash = _save_pdf(upload, doc_id)

            # Generate metadata
            thumbnail = _generate_thumbnail(file_path, doc_id)
            page_count = _get_page_count(file_path)
            # Stable page IDs
            page_ids = [_generate_id("id") for _ in range(page_count)]
            now = int(time.time() * 1000)

            # Auto-rename if name conflicts in the same folder
            name = upload.filename or f"{doc_id}.pdf"
            existing = db.query_one(
                "SELECT id FROM documents WHERE folder_id = ? AND LOWER(name) = LOWER(?)",
                (folder_id, name),
            )
            if existing:
                base = name.rsplit(".", 1)[0]
                ext = name.rsplit(".", 1)[1] if "." in name else ""
                i = 1
                while existing:
                    candidate = f"{base} ({i}){'.' + ext if ext else ''}"
                    existing = db.query_one(
                        "SELECT id FROM documents WHERE folder_id = ? AND LOWER(name) = LOWER(?)",
                        (folder_id, candidate),
                    )
                    i += 1
                name = candidate

            db.execute(
                """INSERT INTO documents
                   (id, name, folder_id, file_path, thumbnail, page_count, page_ids_json,
                    file_size, file_hash, created_at, modified_at, favorite)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (doc_id, name, folder_id, file_path, thumbnail, page_count,
                 json.dumps(page_ids), file_size, file_hash, now, now),
            )
            results.append({"id": doc_id, "name": name, "pageCount": page_count, "fileSize": file_size})
        except Exception as e:
            results.append({"filename": upload.filename, "error": str(e)})

    return {"uploaded": results}


@router.put("/{doc_id}")
def update_document(doc_id: str, update: DocumentUpdate):
    row = db.query_one("SELECT * FROM documents WHERE id = ?", (doc_id,))
    if not row:
        raise HTTPException(404, "Document not found")

    updates = []
    params = []
    if update.name is not None:
        updates.append("name = ?")
        params.append(update.name)
    if update.folder_id is not None:
        # Validate folder
        if update.folder_id != "root":
            f = db.query_one("SELECT id FROM folders WHERE id = ?", (update.folder_id,))
            if not f:
                raise HTTPException(400, "Target folder does not exist")
        updates.append("folder_id = ?")
        params.append(update.folder_id)
    if update.favorite is not None:
        updates.append("favorite = ?")
        params.append(1 if update.favorite else 0)
    if update.modified_at is not None:
        updates.append("modified_at = ?")
        params.append(update.modified_at)
    if update.page_count is not None:
        updates.append("page_count = ?")
        params.append(update.page_count)
    if update.page_ids is not None:
        updates.append("page_ids_json = ?")
        params.append(json.dumps(update.page_ids))

    if updates:
        updates.append("modified_at = ?")
        params.append(int(time.time() * 1000))
        params.append(doc_id)
        db.execute(f"UPDATE documents SET {', '.join(updates)} WHERE id = ?", tuple(params))

    return {"status": "ok"}


@router.post("/{doc_id}/duplicate")
def duplicate_document(doc_id: str):
    src = db.query_one("SELECT * FROM documents WHERE id = ?", (doc_id,))
    if not src:
        raise HTTPException(404, "Document not found")

    new_id = _generate_id("doc")
    new_path = os.path.join(config.PDF_DIR, f"{new_id}.pdf")
    shutil.copyfile(src["file_path"], new_path)

    # Auto-name the duplicate
    base_name = src["name"]
    name = base_name + " (copy)"
    counter = 1
    while db.query_one("SELECT id FROM documents WHERE folder_id = ? AND LOWER(name) = LOWER(?",
                       (src["folder_id"], name)):
        name = f"{base_name} ({counter})"
        counter += 1

    now = int(time.time() * 1000)
    # Fresh page IDs (the duplicate's pages are a fresh copy)
    page_ids = json.loads(src["page_ids_json"]) if src["page_ids_json"] else []
    new_page_ids = [_generate_id("id") for _ in page_ids]

    db.execute(
        """INSERT INTO documents
           (id, name, folder_id, file_path, thumbnail, page_count, page_ids_json,
            file_size, file_hash, created_at, modified_at, favorite)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
        (new_id, name, src["folder_id"], new_path, src["thumbnail"], src["page_count"],
         json.dumps(new_page_ids), src["file_size"], src["file_hash"], now, now),
    )

    # Copy annotations (deep copy, with new page IDs)
    annos = db.query_all("SELECT page_id, data_json FROM annotations WHERE doc_id = ?", (doc_id,))
    for anno in annos:
        try:
            idx = page_ids.index(anno["page_id"])
            new_page_id = new_page_ids[idx]
            db.execute(
                "INSERT OR REPLACE INTO annotations (doc_id, page_id, data_json) VALUES (?, ?, ?)",
                (new_id, new_page_id, anno["data_json"]),
            )
        except (ValueError, json.JSONDecodeError):
            pass

    return {"id": new_id, "name": name}


@router.delete("/{doc_id}")
def delete_document(doc_id: str):
    if doc_id == "root":
        raise HTTPException(400, "Cannot delete root")
    _delete_document_completely(doc_id)
    return {"status": "deleted"}


@router.put("/{doc_id}/move")
def move_document(doc_id: str, req: MoveRequest):
    target = req.target_folder_id
    if target != "root":
        f = db.query_one("SELECT id FROM folders WHERE id = ?", (target,))
        if not f:
            raise HTTPException(400, "Target folder does not exist")
    db.execute(
        "UPDATE documents SET folder_id = ?, modified_at = ? WHERE id = ?",
        (target, int(time.time() * 1000), doc_id),
    )
    return {"status": "moved"}


@router.put("/{doc_id}/file")
async def replace_document_file(doc_id: str, file: UploadFile = File(...)):
    """Replace the PDF file (after page insert/delete in browser using PDF-Lib)."""
    row = db.query_one("SELECT file_path FROM documents WHERE id = ?", (doc_id,))
    if not row:
        raise HTTPException(404, "Document not found")
    # Save new PDF
    file_path, file_size, file_hash = _save_pdf(file, doc_id)
    page_count = _get_page_count(file_path)
    thumbnail = _generate_thumbnail(file_path, doc_id)

    db.execute(
        "UPDATE documents SET file_size = ?, file_hash = ?, page_count = ?, thumbnail = ?, modified_at = ? WHERE id = ?",
        (file_size, file_hash, page_count, thumbnail, int(time.time() * 1000), doc_id),
    )
    return {"status": "ok", "pageCount": page_count, "fileSize": file_size}

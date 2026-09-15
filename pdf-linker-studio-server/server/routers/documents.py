"""
Documents REST API (project-scoped).

Every endpoint requires the `X-Project-Id` header (injected by the
get_current_project dependency). All DB queries filter by project_id, so
projects are fully isolated.
"""
import json
import os
import time
import hashlib
import shutil
from typing import Optional, List

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Response, Depends
from pydantic import BaseModel

from .. import config
from .. import database as db
from ..deps import get_current_project

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
    }


def _generate_id(prefix: str = "doc") -> str:
    return f"{prefix}_{int(time.time() * 1000)}_{os.urandom(4).hex()}"


def _save_pdf(file: UploadFile, doc_id: str, project_id: str) -> tuple[str, int, str]:
    """Save the uploaded PDF to disk under the project's PDF directory."""
    proj_pdf_dir = os.path.join(config.PDF_DIR, project_id)
    os.makedirs(proj_pdf_dir, exist_ok=True)
    file_path = os.path.join(proj_pdf_dir, f"{doc_id}.pdf")
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
    return ""


def _get_page_count(file_path: str) -> int:
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


def _delete_document_completely(doc_id: str, project_id: str):
    """Delete a document and all its associated data (file, annotations, links, embeddings)."""
    row = db.query_one(
        "SELECT file_path FROM documents WHERE id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    if row and os.path.exists(row["file_path"]):
        try:
            os.remove(row["file_path"])
        except OSError as e:
            print(f"Failed to remove PDF file {row['file_path']}: {e}")
    db.execute("DELETE FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id))
    db.execute("DELETE FROM annotations WHERE doc_id = ? AND project_id = ?", (doc_id, project_id))
    db.execute("DELETE FROM embeddings WHERE doc_id = ? AND project_id = ?", (doc_id, project_id))
    # Delete any links that reference this doc
    all_links = db.query_all(
        "SELECT id, source_json, target_json FROM links WHERE project_id = ?", (project_id,)
    )
    for link in all_links:
        try:
            src = json.loads(link["source_json"])
            tgt = json.loads(link["target_json"])
            if (src.get("docId") == doc_id or src.get("doc_id") == doc_id or
                tgt.get("docId") == doc_id or tgt.get("doc_id") == doc_id):
                db.execute("DELETE FROM links WHERE id = ? AND project_id = ?", (link["id"], project_id))
        except json.JSONDecodeError:
            pass


# ---- Endpoints ----

@router.get("")
def list_documents(project_id: str = Depends(get_current_project)):
    rows = db.query_all(
        "SELECT * FROM documents WHERE project_id = ? ORDER BY name", (project_id,)
    )
    return [_doc_row_to_dict(r) for r in rows]


@router.get("/{doc_id}")
def get_document(doc_id: str, project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT * FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Document not found")
    return _doc_row_to_dict(row)


@router.get("/{doc_id}/file")
def get_document_file(doc_id: str, project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT file_path, name FROM documents WHERE id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Document not found")
    if not os.path.exists(row["file_path"]):
        raise HTTPException(404, "PDF file missing from server storage")
    with open(row["file_path"], "rb") as f:
        data = f.read()
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{row["name"]}"'})


@router.get("/{doc_id}/thumbnail")
def get_document_thumbnail(doc_id: str, project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT thumbnail FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Document not found")
    return {"thumbnail": row["thumbnail"]}


@router.post("/upload")
async def upload_documents(
    files: List[UploadFile] = File(...),
    folder_id: str = Form("root"),
    project_id: str = Depends(get_current_project),
):
    if folder_id != "root":
        folder = db.query_one(
            "SELECT id FROM folders WHERE id = ? AND project_id = ?",
            (folder_id, project_id)
        )
        if not folder:
            raise HTTPException(400, f"Folder '{folder_id}' does not exist in this project")

    results = []
    for upload in files:
        doc_id = _generate_id("doc")
        try:
            file_path, file_size, file_hash = _save_pdf(upload, doc_id, project_id)
            thumbnail = _generate_thumbnail(file_path, doc_id)
            page_count = _get_page_count(file_path)
            page_ids = [_generate_id("id") for _ in range(page_count)]
            now = int(time.time() * 1000)

            # Auto-rename if name conflicts in the same folder
            name = upload.filename or f"{doc_id}.pdf"
            existing = db.query_one(
                "SELECT id FROM documents WHERE project_id = ? AND folder_id = ? AND LOWER(name) = LOWER(?)",
                (project_id, folder_id, name)
            )
            if existing:
                base = name.rsplit(".", 1)[0]
                ext = name.rsplit(".", 1)[1] if "." in name else ""
                i = 1
                while existing:
                    candidate = f"{base} ({i}){'.' + ext if ext else ''}"
                    existing = db.query_one(
                        "SELECT id FROM documents WHERE project_id = ? AND folder_id = ? AND LOWER(name) = LOWER(?)",
                        (project_id, folder_id, candidate)
                    )
                    i += 1
                name = candidate

            db.execute(
                """INSERT INTO documents
                   (id, project_id, name, folder_id, file_path, thumbnail, page_count, page_ids_json,
                    file_size, file_hash, created_at, modified_at, favorite)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (doc_id, project_id, name, folder_id, file_path, thumbnail, page_count,
                 json.dumps(page_ids), file_size, file_hash, now, now),
            )
            results.append({"id": doc_id, "name": name, "pageCount": page_count, "fileSize": file_size})
        except Exception as e:
            results.append({"filename": upload.filename, "error": str(e)})

    return {"uploaded": results}


@router.put("/{doc_id}")
def update_document(doc_id: str, update: DocumentUpdate, project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT * FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Document not found")

    updates = []
    params = []
    if update.name is not None:
        updates.append("name = ?")
        params.append(update.name)
    if update.folder_id is not None:
        if update.folder_id != "root":
            f = db.query_one(
                "SELECT id FROM folders WHERE id = ? AND project_id = ?",
                (update.folder_id, project_id)
            )
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
        params.append(project_id)
        db.execute(
            f"UPDATE documents SET {', '.join(updates)} WHERE id = ? AND project_id = ?",
            tuple(params)
        )

    return {"status": "ok"}


@router.post("/{doc_id}/duplicate")
def duplicate_document(doc_id: str, project_id: str = Depends(get_current_project)):
    src = db.query_one(
        "SELECT * FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id)
    )
    if not src:
        raise HTTPException(404, "Document not found")

    new_id = _generate_id("doc")
    new_path = os.path.join(config.PDF_DIR, project_id, f"{new_id}.pdf")
    os.makedirs(os.path.dirname(new_path), exist_ok=True)
    shutil.copyfile(src["file_path"], new_path)

    base_name = src["name"]
    name = base_name + " (copy)"
    counter = 1
    while db.query_one(
        "SELECT id FROM documents WHERE project_id = ? AND folder_id = ? AND LOWER(name) = LOWER(?)",
        (project_id, src["folder_id"], name)
    ):
        name = f"{base_name} ({counter})"
        counter += 1

    now = int(time.time() * 1000)
    page_ids = json.loads(src["page_ids_json"]) if src["page_ids_json"] else []
    new_page_ids = [_generate_id("id") for _ in page_ids]

    db.execute(
        """INSERT INTO documents
           (id, project_id, name, folder_id, file_path, thumbnail, page_count, page_ids_json,
            file_size, file_hash, created_at, modified_at, favorite)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
        (new_id, project_id, name, src["folder_id"], new_path, src["thumbnail"],
         src["page_count"], json.dumps(new_page_ids), src["file_size"], src["file_hash"], now, now),
    )

    # Copy annotations (deep copy, with new page IDs)
    annos = db.query_all(
        "SELECT page_id, data_json FROM annotations WHERE doc_id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    for anno in annos:
        try:
            idx = page_ids.index(anno["page_id"])
            new_page_id = new_page_ids[idx]
            db.execute(
                "INSERT OR REPLACE INTO annotations (doc_id, project_id, page_id, data_json) VALUES (?, ?, ?, ?)",
                (new_id, project_id, new_page_id, anno["data_json"]),
            )
        except (ValueError, json.JSONDecodeError):
            pass

    return {"id": new_id, "name": name}


@router.delete("/{doc_id}")
def delete_document(doc_id: str, project_id: str = Depends(get_current_project)):
    _delete_document_completely(doc_id, project_id)
    return {"status": "deleted"}


@router.put("/{doc_id}/move")
def move_document(doc_id: str, req: MoveRequest, project_id: str = Depends(get_current_project)):
    target = req.target_folder_id
    if target != "root":
        f = db.query_one(
            "SELECT id FROM folders WHERE id = ? AND project_id = ?", (target, project_id)
        )
        if not f:
            raise HTTPException(400, "Target folder does not exist")
    db.execute(
        "UPDATE documents SET folder_id = ?, modified_at = ? WHERE id = ? AND project_id = ?",
        (target, int(time.time() * 1000), doc_id, project_id),
    )
    return {"status": "moved"}


@router.put("/{doc_id}/file")
async def replace_document_file(
    doc_id: str,
    file: UploadFile = File(...),
    project_id: str = Depends(get_current_project)
):
    row = db.query_one(
        "SELECT file_path FROM documents WHERE id = ? AND project_id = ?", (doc_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Document not found")
    # Save new PDF
    file_path, file_size, file_hash = _save_pdf(file, doc_id, project_id)
    page_count = _get_page_count(file_path)
    thumbnail = _generate_thumbnail(file_path, doc_id)

    db.execute(
        "UPDATE documents SET file_path = ?, file_size = ?, file_hash = ?, page_count = ?, "
        "thumbnail = ?, modified_at = ? WHERE id = ? AND project_id = ?",
        (file_path, file_size, file_hash, page_count, thumbnail,
         int(time.time() * 1000), doc_id, project_id),
    )
    return {"status": "ok", "pageCount": page_count, "fileSize": file_size}

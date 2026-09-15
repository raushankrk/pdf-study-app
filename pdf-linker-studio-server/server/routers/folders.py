"""Folders REST API."""
import time
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import database as db

router = APIRouter()


class FolderCreate(BaseModel):
    name: str
    parent_id: str = "root"


class FolderUpdate(BaseModel):
    name: Optional[str] = None


class FolderMove(BaseModel):
    target_folder_id: str


def _folder_row_to_dict(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "parentId": row.get("parent_id") or "root" if row["id"] != "root" else None,
        "createdAt": row.get("created_at"),
        "expanded": bool(row.get("expanded", 1)),
    }


def _get_child_folders(parent_id: str) -> list[dict]:
    if parent_id is None:
        # Children of root have parent_id == NULL OR 'root'
        rows = db.query_all("SELECT * FROM folders WHERE parent_id IS NULL OR parent_id = 'root' ORDER BY name")
    else:
        rows = db.query_all("SELECT * FROM folders WHERE parent_id = ? ORDER BY name", (parent_id,))
    return [_folder_row_to_dict(r) for r in rows]


def _get_descendant_ids(folder_id: str) -> list[str]:
    """Recursively collect all descendant folder IDs (not including folder_id itself)."""
    out = []
    stack = [folder_id]
    while stack:
        current = stack.pop()
        children = _get_child_folders(current)
        for c in children:
            if c["id"] != "root" and c["id"] not in out:
                out.append(c["id"])
                stack.append(c["id"])
    return out


@router.get("")
def list_folders():
    rows = db.query_all("SELECT * FROM folders ORDER BY name")
    return [_folder_row_to_dict(r) for r in rows]


@router.get("/tree")
def get_tree():
    """Return folders nested as a tree starting at root."""
    def build(parent_id):
        children = _get_child_folders(parent_id)
        for c in children:
            c["children"] = build(c["id"])
        return children
    return {
        "id": "root",
        "name": "Root",
        "parentId": None,
        "children": build(None)
    }


@router.post("")
def create_folder(folder: FolderCreate):
    if folder.parent_id != "root":
        parent = db.query_one("SELECT id FROM folders WHERE id = ?", (folder.parent_id,))
        if not parent:
            raise HTTPException(400, "Parent folder does not exist")
    # Duplicate name check (case-insensitive among siblings)
    sibs = _get_child_folders(folder.parent_id)
    if any(s["name"].lower() == folder.name.lower() for s in sibs):
        raise HTTPException(409, f"A folder named '{folder.name}' already exists here")

    fid = f"folder_{int(time.time() * 1000)}_{__import__('os').urandom(4).hex()}"
    parent_param = None if folder.parent_id == "root" else folder.parent_id
    db.execute(
        "INSERT INTO folders (id, name, parent_id, created_at, expanded) VALUES (?, ?, ?, ?, 1)",
        (fid, folder.name, parent_param, int(time.time() * 1000)),
    )
    return {"id": fid, "name": folder.name, "parentId": folder.parent_id}


@router.put("/{folder_id}")
def rename_folder(folder_id: str, update: FolderUpdate):
    if folder_id == "root":
        raise HTTPException(400, "Root folder cannot be renamed")
    folder = db.query_one("SELECT * FROM folders WHERE id = ?", (folder_id,))
    if not folder:
        raise HTTPException(404, "Folder not found")
    if update.name is None or not update.name.strip():
        raise HTTPException(400, "Name cannot be empty")
    # Duplicate check
    parent_id = folder["parent_id"]
    sibs = _get_child_folders(parent_id)
    if any(s["id"] != folder_id and s["name"].lower() == update.name.lower() for s in sibs):
        raise HTTPException(409, "A folder with that name already exists here")
    db.execute("UPDATE folders SET name = ? WHERE id = ?", (update.name.strip(), folder_id))
    return {"status": "ok"}


@router.put("/{folder_id}/move")
def move_folder(folder_id: str, req: FolderMove):
    if folder_id == "root":
        raise HTTPException(400, "Root folder cannot be moved")
    if folder_id == req.target_folder_id:
        raise HTTPException(400, "Cannot move a folder into itself")

    target = req.target_folder_id
    if target != "root":
        t = db.query_one("SELECT id FROM folders WHERE id = ?", (target,))
        if not t:
            raise HTTPException(400, "Target folder does not exist")

    # Cycle check: target must not be a descendant of folder_id (or itself).
    descendants = _get_descendant_ids(folder_id)
    if target in descendants:
        raise HTTPException(400, "Cannot move a folder into one of its own descendants")

    # Duplicate name at destination
    target_sibs = _get_child_folders(target)
    folder = db.query_one("SELECT name FROM folders WHERE id = ?", (folder_id,))
    if any(s["name"].lower() == folder["name"].lower() for s in target_sibs):
        raise HTTPException(409, "A folder with that name already exists at the destination")

    target_param = None if target == "root" else target
    db.execute("UPDATE folders SET parent_id = ? WHERE id = ?", (target_param, folder_id))
    return {"status": "moved"}


@router.put("/{folder_id}/expanded")
def set_expanded(folder_id: str, expanded: bool):
    if folder_id == "root":
        return {"status": "ok"}  # root is always expanded
    db.execute("UPDATE folders SET expanded = ? WHERE id = ?", (1 if expanded else 0, folder_id))
    return {"status": "ok"}


@router.delete("/{folder_id}")
def delete_folder(folder_id: str, move_contents_to_root: bool = False):
    """Delete a folder. If move_contents_to_root is True, child items move to root
    instead of being deleted. Otherwise cascade-delete everything inside."""
    if folder_id == "root":
        raise HTTPException(400, "Root folder cannot be deleted")

    folder = db.query_one("SELECT * FROM folders WHERE id = ?", (folder_id,))
    if not folder:
        raise HTTPException(404, "Folder not found")

    descendants = _get_descendant_ids(folder_id)
    all_folder_ids = [folder_id] + descendants

    # Find all docs in the doomed folders
    placeholders = ",".join("?" * len(all_folder_ids))
    docs = db.query_all(f"SELECT id FROM documents WHERE folder_id IN ({placeholders})", tuple(all_folder_ids))

    if move_contents_to_root:
        # Reparent child folders to root
        children = _get_child_folders(folder_id)
        for c in children:
            db.execute("UPDATE folders SET parent_id = NULL WHERE id = ?", (c["id"],))
        # Move docs to root
        for d in docs:
            db.execute("UPDATE documents SET folder_id = 'root' WHERE id = ?", (d["id"],))
        # Delete the folder itself only
        db.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    else:
        # Cascade-delete documents (file, annotations, links, embeddings)
        from .documents import _delete_document_completely
        for d in docs:
            _delete_document_completely(d["id"])
        # Delete all the folders
        for fid in all_folder_ids:
            db.execute("DELETE FROM folders WHERE id = ?", (fid,))

    return {"status": "deleted", "documents_deleted": 0 if move_contents_to_root else len(docs)}

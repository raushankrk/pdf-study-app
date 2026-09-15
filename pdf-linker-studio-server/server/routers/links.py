"""Links REST API (project-scoped)."""
import json
import time
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from .. import database as db
from ..deps import get_current_project

router = APIRouter()


class LinkCreate(BaseModel):
    id: Optional[str] = None
    source: dict
    target: dict


@router.get("")
def list_links(project_id: str = Depends(get_current_project)):
    rows = db.query_all(
        "SELECT * FROM links WHERE project_id = ? ORDER BY created_at", (project_id,)
    )
    out = []
    for r in rows:
        try:
            src = json.loads(r["source_json"])
            tgt = json.loads(r["target_json"])
            out.append({"id": r["id"], "source": src, "target": tgt})
        except json.JSONDecodeError:
            continue
    return out


@router.post("")
def create_link(link: LinkCreate, project_id: str = Depends(get_current_project)):
    lid = link.id or f"link_{int(time.time() * 1000)}_{os.urandom(4).hex()}"
    db.execute(
        "INSERT OR REPLACE INTO links (id, project_id, source_json, target_json, created_at) VALUES (?, ?, ?, ?, ?)",
        (lid, project_id, json.dumps(link.source), json.dumps(link.target), int(time.time() * 1000)),
    )
    return {"id": lid, "source": link.source, "target": link.target}


@router.delete("/{link_id}")
def delete_link(link_id: str, project_id: str = Depends(get_current_project)):
    db.execute(
        "DELETE FROM links WHERE id = ? AND project_id = ?", (link_id, project_id)
    )
    return {"status": "deleted"}


@router.delete("")
def delete_all_links(project_id: str = Depends(get_current_project)):
    db.execute("DELETE FROM links WHERE project_id = ?", (project_id,))
    return {"status": "ok"}

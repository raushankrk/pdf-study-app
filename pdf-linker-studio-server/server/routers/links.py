"""Links REST API."""
import json
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import database as db

router = APIRouter()


class LinkCreate(BaseModel):
    id: Optional[str] = None
    source: dict
    target: dict


@router.get("")
def list_links():
    rows = db.query_all("SELECT * FROM links ORDER BY created_at")
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
def create_link(link: LinkCreate):
    lid = link.id or f"link_{int(time.time() * 1000)}_{__import__('os').urandom(4).hex()}"
    db.execute(
        "INSERT OR REPLACE INTO links (id, source_json, target_json, created_at) VALUES (?, ?, ?, ?)",
        (lid, json.dumps(link.source), json.dumps(link.target), int(time.time() * 1000)),
    )
    return {"id": lid, "source": link.source, "target": link.target}


@router.delete("/{link_id}")
def delete_link(link_id: str):
    db.execute("DELETE FROM links WHERE id = ?", (link_id,))
    return {"status": "deleted"}


@router.delete("")
def delete_all_links():
    db.execute("DELETE FROM links")
    return {"status": "ok"}

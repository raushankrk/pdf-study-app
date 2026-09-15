"""Annotations REST API.

Annotations are stored per (doc_id, page_id). Each page's annotation data is a
JSON blob containing strokes, text boxes, images, etc.
"""
import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import database as db

router = APIRouter()


class AnnotationData(BaseModel):
    data: dict  # Free-form — the frontend dictates the schema


@router.get("/{doc_id}")
def get_annotations_for_doc(doc_id: str):
    """Return { pageId: annotationData, ... } for the whole document."""
    rows = db.query_all("SELECT page_id, data_json FROM annotations WHERE doc_id = ?", (doc_id,))
    out = {}
    for r in rows:
        try:
            out[r["page_id"]] = json.loads(r["data_json"])
        except json.JSONDecodeError:
            continue
    return out


@router.get("/{doc_id}/{page_id}")
def get_annotation(doc_id: str, page_id: str):
    row = db.query_one("SELECT data_json FROM annotations WHERE doc_id = ? AND page_id = ?",
                       (doc_id, page_id))
    if not row:
        return {"data": None}
    return {"data": json.loads(row["data_json"])}


@router.put("/{doc_id}/{page_id}")
def save_annotation(doc_id: str, page_id: str, body: AnnotationData):
    """Insert or update annotations for one page."""
    data_json = json.dumps(body.data)
    db.execute(
        "INSERT OR REPLACE INTO annotations (doc_id, page_id, data_json) VALUES (?, ?, ?)",
        (doc_id, page_id, data_json),
    )
    return {"status": "ok"}


@router.put("/{doc_id}")
def save_all_annotations(doc_id: str, body: dict):
    """Replace ALL annotations for a document. body is { pageId: data, ... }"""
    # Delete existing first
    db.execute("DELETE FROM annotations WHERE doc_id = ?", (doc_id,))
    for page_id, data in body.items():
        if data is None:
            continue
        data_json = json.dumps(data) if not isinstance(data, str) else data
        db.execute(
            "INSERT OR REPLACE INTO annotations (doc_id, page_id, data_json) VALUES (?, ?, ?)",
            (doc_id, page_id, data_json),
        )
    return {"status": "ok"}


@router.delete("/{doc_id}")
def delete_all_annotations(doc_id: str):
    db.execute("DELETE FROM annotations WHERE doc_id = ?", (doc_id,))
    return {"status": "ok"}


@router.delete("/{doc_id}/{page_id}")
def delete_annotation(doc_id: str, page_id: str):
    db.execute("DELETE FROM annotations WHERE doc_id = ? AND page_id = ?", (doc_id, page_id))
    return {"status": "ok"}

"""Annotations REST API (project-scoped).

Conflict detection (multi-device):
  - The `annotations` table has a per-row `revision` column (integer, starts at 0).
    Every successful PUT on a (doc_id, page_id) row bumps the revision by 1.
  - GET responses include the revision alongside the data, so the client can
    remember what revision it last loaded.
  - PUT accepts an optional `X-Expected-Revision` header. If present and the
    stored revision does NOT match, the server returns HTTP 409 Conflict with
    the current server-side data + revision. The client can then prompt the
    user to reload, overwrite, or cancel.
  - PUT also accepts `X-Force-Write: 1` to skip the check (used when the user
    explicitly chooses "Overwrite" in the conflict modal).
"""
import json
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel

from .. import database as db
from ..deps import get_current_project

router = APIRouter()


class AnnotationData(BaseModel):
    data: dict


@router.get("/{doc_id}")
def get_annotations_for_doc(doc_id: str, project_id: str = Depends(get_current_project)):
    """Return all annotation pages for a document.

    Response shape (NEW):
      {
        "pages": { "<pageId>": <pageData>, ... },
        "revisions": { "<pageId>": <int>, ... },
        "docRevision": <int>          # highest revision among the doc's pages, or 0
      }

    The `revisions` map lets the client remember the revision of each page so
    it can send `X-Expected-Revision` when saving. The legacy response shape
    (just `{ pageId: pageData }`) is preserved when there are no annotations
    yet, but `pages`/`revisions` always exist.
    """
    rows = db.query_all(
        "SELECT page_id, data_json, revision FROM annotations WHERE doc_id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    pages = {}
    revisions = {}
    doc_rev = 0
    for r in rows:
        try:
            pages[r["page_id"]] = json.loads(r["data_json"])
            rev = int(r.get("revision") or 0)
            revisions[r["page_id"]] = rev
            if rev > doc_rev:
                doc_rev = rev
        except json.JSONDecodeError:
            continue
    return {
        "pages": pages,
        "revisions": revisions,
        "docRevision": doc_rev,
    }


@router.get("/{doc_id}/{page_id}")
def get_annotation(doc_id: str, page_id: str, project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT data_json, revision FROM annotations WHERE doc_id = ? AND page_id = ? AND project_id = ?",
        (doc_id, page_id, project_id)
    )
    if not row:
        return {"data": None, "revision": 0}
    try:
        data = json.loads(row["data_json"])
    except json.JSONDecodeError:
        data = None
    return {"data": data, "revision": int(row.get("revision") or 0)}


@router.put("/{doc_id}/{page_id}")
def save_annotation(
    doc_id: str,
    page_id: str,
    body: AnnotationData,
    project_id: str = Depends(get_current_project),
    x_expected_revision: Optional[str] = Header(None, alias="X-Expected-Revision"),
    x_force_write: Optional[str] = Header(None, alias="X-Force-Write"),
):
    """Save a single page's annotations.

    Conflict handling:
      - If `X-Force-Write: 1` is sent, the write always succeeds (used when
        the user explicitly chooses "Overwrite" in the conflict modal).
      - Else if `X-Expected-Revision` is sent and does NOT match the current
        stored revision, the server returns HTTP 409 with the current data
        + revision so the client can prompt the user.
      - Otherwise the write succeeds and the row's revision is bumped by 1.
    """
    data_json = json.dumps(body.data)

    # Look up the existing row (if any) to check the revision.
    existing = db.query_one(
        "SELECT revision, data_json FROM annotations WHERE doc_id = ? AND page_id = ? AND project_id = ?",
        (doc_id, page_id, project_id)
    )
    current_rev = int(existing["revision"]) if existing else 0

    # Conflict check (unless the client forces the write).
    if x_force_write != "1" and x_expected_revision is not None:
        try:
            expected_rev = int(x_expected_revision)
        except (TypeError, ValueError):
            expected_rev = -1  # invalid header → never matches → always 409
        if expected_rev != current_rev:
            # Return the current server data so the client can show a diff /
            # ask the user what to do. We do NOT modify the row.
            try:
                server_data = json.loads(existing["data_json"]) if existing else None
            except json.JSONDecodeError:
                server_data = None
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "conflict",
                    "message": "Another device has modified this page. Reload to merge their changes, or overwrite to discard them.",
                    "docId": doc_id,
                    "pageId": page_id,
                    "expectedRevision": expected_rev,
                    "currentRevision": current_rev,
                    "serverData": server_data,
                }
            )

    # Perform the write — bump revision (or initialize to 1 on first insert).
    new_rev = current_rev + 1
    now_ms = int(time.time() * 1000)
    db.execute(
        "INSERT OR REPLACE INTO annotations (doc_id, project_id, page_id, data_json, revision, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (doc_id, project_id, page_id, data_json, new_rev, now_ms),
    )
    # Bump the project's revision so other devices polling getProject() notice.
    db.bump_project_revision(project_id)

    return {"status": "ok", "revision": new_rev}


@router.put("/{doc_id}")
def save_all_annotations(doc_id: str, body: dict, project_id: str = Depends(get_current_project)):
    """Replace ALL annotations for a document. This is the bulk-save path used
    by the editor's debounced save.

    Conflict handling for bulk save:
      - For simplicity and to avoid breaking the existing editor flow, this
        endpoint does NOT do per-page conflict checks. It uses last-write-wins
        for the bulk replace. Per-page conflict detection happens via the
        single-page PUT endpoint (which the editor now prefers for incremental
        saves). The bulk endpoint is kept for legacy callers and the initial
        page-load path.
      - The project's revision counter is still bumped so other devices
        polling the project can detect that something changed.
    """
    # Replace all rows for this doc in one transaction.
    statements = [("DELETE FROM annotations WHERE doc_id = ? AND project_id = ?",
                   (doc_id, project_id))]
    now_ms = int(time.time() * 1000)
    for page_id, data in body.items():
        if data is None:
            continue
        data_json = json.dumps(data) if not isinstance(data, str) else data
        statements.append((
            "INSERT OR REPLACE INTO annotations (doc_id, project_id, page_id, data_json, revision, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (doc_id, project_id, page_id, data_json, 1, now_ms)
        ))
    db.execute_many(statements)
    db.bump_project_revision(project_id)
    return {"status": "ok"}


@router.delete("/{doc_id}")
def delete_all_annotations(doc_id: str, project_id: str = Depends(get_current_project)):
    db.execute(
        "DELETE FROM annotations WHERE doc_id = ? AND project_id = ?", (doc_id, project_id)
    )
    db.bump_project_revision(project_id)
    return {"status": "ok"}


@router.delete("/{doc_id}/{page_id}")
def delete_annotation(doc_id: str, page_id: str, project_id: str = Depends(get_current_project)):
    db.execute(
        "DELETE FROM annotations WHERE doc_id = ? AND page_id = ? AND project_id = ?",
        (doc_id, page_id, project_id)
    )
    db.bump_project_revision(project_id)
    return {"status": "ok"}

"""Settings REST API (project-scoped).

Settings are stored as key-value pairs in the settings table, scoped by project_id.
The frontend stores its full app-state object here under the key 'appState'.
"""
import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import database as db
from ..deps import get_current_project

router = APIRouter()


class SettingsUpdate(BaseModel):
    settings: dict


@router.get("")
def get_settings(project_id: str = Depends(get_current_project)):
    row = db.query_one(
        "SELECT value FROM settings WHERE project_id = ? AND key = 'appState'", (project_id,)
    )
    if row:
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            pass
    return {}


@router.put("")
def save_settings(body: dict, project_id: str = Depends(get_current_project)):
    db.execute(
        "INSERT OR REPLACE INTO settings (key, project_id, value) VALUES ('appState', ?, ?)",
        (project_id, json.dumps(body)),
    )
    # Bump the project's revision + modified_at so other devices polling
    # the project detect the change. (View state, recent docs, sidebar
    # collapse state, etc. are all part of settings — a change here means
    # the project has been interacted with.)
    db.bump_project_revision(project_id)
    return {"status": "ok"}

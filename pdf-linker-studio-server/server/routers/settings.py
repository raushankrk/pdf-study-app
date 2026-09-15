"""Settings REST API.

Settings are stored as key-value pairs in the settings table. The frontend
stores its full app-state object here under the key 'appState'.
"""
import json

from fastapi import APIRouter
from pydantic import BaseModel

from .. import database as db

router = APIRouter()


class SettingsUpdate(BaseModel):
    """A free-form dict of settings. We store the whole thing under 'appState'."""
    settings: dict


@router.get("")
def get_settings():
    """Return the full app-state settings object."""
    row = db.query_one("SELECT value FROM settings WHERE key = 'appState'")
    if row:
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            pass
    return {}  # empty settings


@router.put("")
def save_settings(body: dict):
    """Replace the full app-state settings object."""
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('appState', ?)",
        (json.dumps(body),),
    )
    return {"status": "ok"}


@router.get("/raw")
def get_all_settings_raw():
    """Return every key-value pair in the settings table."""
    rows = db.query_all("SELECT key, value FROM settings")
    return {r["key"]: r["value"] for r in rows}

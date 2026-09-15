"""Chats REST API."""
import json
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import database as db

router = APIRouter()


class ChatCreate(BaseModel):
    title: str = "New Chat"


class ChatUpdate(BaseModel):
    title: Optional[str] = None
    messages: Optional[list] = None  # [{role, html, context?}, ...]


@router.get("")
def list_chats():
    rows = db.query_all("SELECT * FROM chats ORDER BY created_at DESC")
    out = []
    for r in rows:
        try:
            msgs = json.loads(r["messages_json"])
        except json.JSONDecodeError:
            msgs = []
        out.append({"id": r["id"], "title": r["title"], "messages": msgs, "createdAt": r["created_at"]})
    return out


@router.get("/{chat_id}")
def get_chat(chat_id: str):
    row = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if not row:
        raise HTTPException(404, "Chat not found")
    return {
        "id": row["id"],
        "title": row["title"],
        "messages": json.loads(row["messages_json"]) if row["messages_json"] else [],
        "createdAt": row["created_at"],
    }


@router.post("")
def create_chat(chat: ChatCreate):
    cid = f"chat_{int(time.time() * 1000)}_{__import__('os').urandom(4).hex()}"
    db.execute(
        "INSERT INTO chats (id, title, messages_json, created_at) VALUES (?, ?, ?, ?)",
        (cid, chat.title, "[]", int(time.time() * 1000)),
    )
    return {"id": cid, "title": chat.title, "messages": []}


@router.put("/{chat_id}")
def update_chat(chat_id: str, update: ChatUpdate):
    row = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if not row:
        raise HTTPException(404, "Chat not found")
    if update.title is not None:
        db.execute("UPDATE chats SET title = ? WHERE id = ?", (update.title, chat_id))
    if update.messages is not None:
        db.execute("UPDATE chats SET messages_json = ? WHERE id = ?", (json.dumps(update.messages), chat_id))
    return {"status": "ok"}


@router.delete("/{chat_id}")
def delete_chat(chat_id: str):
    db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return {"status": "deleted"}

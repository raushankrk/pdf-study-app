"""
SQLite database setup + low-level helpers.
Uses the built-in sqlite3 module (synchronous) wrapped in a thread-pool via FastAPI.
"""
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Optional

from . import config

# Use a per-thread connection so each request gets its own SQLite handle.
# SQLite handles can't be shared across threads safely.
_thread_local = threading.local()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    expanded INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_id TEXT DEFAULT 'root',
    file_path TEXT NOT NULL,
    thumbnail TEXT,
    page_count INTEGER DEFAULT 0,
    page_ids_json TEXT,
    file_size INTEGER DEFAULT 0,
    file_hash TEXT,
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    favorite INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS annotations (
    doc_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (doc_id, page_id)
);

CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    source_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    page_id TEXT,
    text TEXT NOT NULL,
    vector_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(doc_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init_db():
    """Create the schema if it doesn't exist. Called once at server startup."""
    config.ensure_data_dirs()
    with get_conn() as conn:
        conn.executescript(_SCHEMA)
        # Always ensure the root folder exists.
        row = conn.execute("SELECT id FROM folders WHERE id = ?", ("root",)).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO folders (id, name, parent_id, created_at, expanded) VALUES (?, ?, ?, ?, ?)",
                ("root", "Root", None, int(time.time() * 1000), 1),
            )
        conn.commit()


def get_conn() -> sqlite3.Connection:
    """Get a thread-local SQLite connection. Creates one if missing."""
    if not hasattr(_thread_local, "conn") or _thread_local.conn is None:
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row  # return dicts
        conn.execute("PRAGMA journal_mode = WAL")  # better concurrent read performance
        conn.execute("PRAGMA foreign_keys = ON")
        _thread_local.conn = conn
    return _thread_local.conn


@contextmanager
def transaction():
    """Context manager yielding a connection and committing on success."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---- Generic helpers used by routers ----

def query_all(sql: str, params: tuple = ()) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def query_one(sql: str, params: tuple = ()) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def execute(sql: str, params: tuple = ()) -> None:
    with transaction() as conn:
        conn.execute(sql, params)

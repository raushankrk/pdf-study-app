"""
SQLite database setup + low-level helpers.
Uses the built-in sqlite3 module (synchronous) wrapped in a thread-pool via FastAPI.

Multi-project support: every resource table has a `project_id` column. Queries
must filter by project_id (the FastAPI `get_current_project` dependency injects it).
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
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    color TEXT
);

CREATE TABLE IF NOT EXISTS folders (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    expanded INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
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
    favorite INTEGER DEFAULT 0,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

CREATE TABLE IF NOT EXISTS annotations (
    doc_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    page_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (project_id, doc_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations(project_id);

CREATE TABLE IF NOT EXISTS links (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    source_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_links_project ON links(project_id);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);

CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    doc_id TEXT NOT NULL,
    page_id TEXT,
    text TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_doc ON embeddings(doc_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    value TEXT NOT NULL,
    PRIMARY KEY (project_id, key)
);
CREATE INDEX IF NOT EXISTS idx_settings_project ON settings(project_id);
"""

# Tables whose primary key changed from a single-column `id` (or `key`) to a
# composite `(project_id, id)`. We recreate them with the new PK on migration.
_TABLES_TO_RECREATE = [
    # (table_name, create_sql_after_migration, select_sql_for_backup,
    #  insert_sql_with_default_project)
    ("folders",
     "CREATE TABLE folders (id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "name TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL, expanded INTEGER DEFAULT 1, "
     "PRIMARY KEY (project_id, id))",
     "SELECT id, name, parent_id, created_at, expanded FROM folders",
     "INSERT INTO folders (id, project_id, name, parent_id, created_at, expanded) "
     "VALUES (?, 'default', ?, ?, ?, ?)"),
    ("documents",
     "CREATE TABLE documents (id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "name TEXT NOT NULL, folder_id TEXT DEFAULT 'root', file_path TEXT NOT NULL, thumbnail TEXT, "
     "page_count INTEGER DEFAULT 0, page_ids_json TEXT, file_size INTEGER DEFAULT 0, "
     "file_hash TEXT, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, favorite INTEGER DEFAULT 0, "
     "PRIMARY KEY (project_id, id))",
     "SELECT id, name, folder_id, file_path, thumbnail, page_count, page_ids_json, "
     "file_size, file_hash, created_at, modified_at, favorite FROM documents",
     "INSERT INTO documents (id, project_id, name, folder_id, file_path, thumbnail, "
     "page_count, page_ids_json, file_size, file_hash, created_at, modified_at, favorite) "
     "VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    ("links",
     "CREATE TABLE links (id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "source_json TEXT NOT NULL, target_json TEXT NOT NULL, created_at INTEGER NOT NULL, "
     "PRIMARY KEY (project_id, id))",
     "SELECT id, source_json, target_json, created_at FROM links",
     "INSERT INTO links (id, project_id, source_json, target_json, created_at) "
     "VALUES (?, 'default', ?, ?, ?)"),
    ("chats",
     "CREATE TABLE chats (id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "title TEXT NOT NULL, messages_json TEXT NOT NULL, created_at INTEGER NOT NULL, "
     "PRIMARY KEY (project_id, id))",
     "SELECT id, title, messages_json, created_at FROM chats",
     "INSERT INTO chats (id, project_id, title, messages_json, created_at) "
     "VALUES (?, 'default', ?, ?, ?)"),
    ("embeddings",
     "CREATE TABLE embeddings (id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "doc_id TEXT NOT NULL, page_id TEXT, text TEXT NOT NULL, vector_json TEXT NOT NULL, "
     "PRIMARY KEY (project_id, id))",
     "SELECT id, doc_id, page_id, text, vector_json FROM embeddings",
     "INSERT INTO embeddings (id, project_id, doc_id, page_id, text, vector_json) "
     "VALUES (?, 'default', ?, ?, ?, ?)"),
    ("annotations",
     "CREATE TABLE annotations (doc_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "page_id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (project_id, doc_id, page_id))",
     "SELECT doc_id, page_id, data_json FROM annotations",
     "INSERT INTO annotations (doc_id, project_id, page_id, data_json) "
     "VALUES (?, 'default', ?, ?)"),
    ("settings",
     "CREATE TABLE settings (key TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'default', "
     "value TEXT NOT NULL, PRIMARY KEY (project_id, key))",
     "SELECT key, value FROM settings",
     "INSERT INTO settings (key, project_id, value) VALUES (?, 'default', ?)"),
]


def _table_exists(conn, table_name):
    r = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,)
    ).fetchone()
    return r is not None


def _column_exists(conn, table, column):
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return column in cols


def _pk_columns(conn, table):
    """Return list of column names that are part of the primary key."""
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall() if r[5]]


def _migrate(conn):
    """Recreate tables that have the old single-column PK so they use the new
    composite (project_id, ...) PK. Idempotent."""
    # 1) Ensure the projects table exists.
    if not _table_exists(conn, "projects"):
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
            "description TEXT, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, "
            "color TEXT)"
        )

    # 2) Recreate tables whose PK changed.
    for table, create_sql, select_sql, insert_sql in _TABLES_TO_RECREATE:
        if not _table_exists(conn, table):
            # Table doesn't exist yet — the main _SCHEMA will create it correctly.
            continue
        # Check if the table has the project_id column AND it's part of the PK.
        pk_cols = _pk_columns(conn, table)
        if "project_id" in pk_cols:
            # Already migrated — skip.
            continue
        # Old shape: back up data, drop, recreate, restore with default project.
        try:
            rows = conn.execute(select_sql).fetchall()
            conn.execute(f"DROP TABLE {table}")
            conn.execute(create_sql)
            # Recreate the project_id index too.
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{table}_project ON {table}(project_id)"
            )
            for r in rows:
                conn.execute(insert_sql, tuple(r))
            print(f"[migrate] {table} recreated with project_id PK, {len(rows)} rows restored")
        except sqlite3.OperationalError as e:
            print(f"[migrate] {table} recreate failed: {e}")

    # 3) Ensure a default project exists. If there's already data without a project
    # (e.g. migrated from the previous single-project version), create a "default"
    # project and bind all rows to it.
    default_proj = conn.execute("SELECT id FROM projects WHERE id = 'default'").fetchone()
    if not default_proj:
        now = int(time.time() * 1000)
        conn.execute(
            "INSERT INTO projects (id, name, description, created_at, modified_at, color) "
            "VALUES ('default', 'My First Project', 'Auto-migrated from previous version', ?, ?, '#3b82f6')",
            (now, now)
        )
        print("[migrate] created 'default' project to hold pre-existing data")

    # 4) Ensure root folder exists for every project that doesn't have one.
    projects = conn.execute("SELECT id FROM projects").fetchall()
    for p in projects:
        pid = p[0]
        existing_root = conn.execute(
            "SELECT id FROM folders WHERE project_id = ? AND id = 'root'", (pid,)
        ).fetchone()
        if not existing_root:
            conn.execute(
                "INSERT INTO folders (id, project_id, name, parent_id, created_at, expanded) "
                "VALUES ('root', ?, 'Root', NULL, ?, 1)",
                (pid, int(time.time() * 1000))
            )


def init_db():
    """Create the schema if it doesn't exist. Called once at server startup."""
    config.ensure_data_dirs()
    with get_conn() as conn:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        # Always ensure the root folder exists for the default project.
        row = conn.execute(
            "SELECT id FROM folders WHERE id = 'root' AND project_id = 'default'"
        ).fetchone()
        if not row:
            conn.execute(
                "INSERT INTO folders (id, project_id, name, parent_id, created_at, expanded) "
                "VALUES ('root', 'default', 'Root', NULL, ?, 1)",
                (int(time.time() * 1000),)
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
# All helpers take a `project_id` parameter so they're project-scoped by design.
# (Routers receive the project_id from the `get_current_project` FastAPI dependency.)

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

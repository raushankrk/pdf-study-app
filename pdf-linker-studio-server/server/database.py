"""
SQLite database setup + low-level helpers.
Uses the built-in sqlite3 module (synchronous) wrapped in a thread-pool via FastAPI.

Multi-project support: every resource table has a `project_id` column. Queries
must filter by project_id (the FastAPI `get_current_project` dependency injects it).

Conflict detection (multi-device):
  - The `annotations` table has a `revision` column (INTEGER, default 0).
    Every successful PUT on a (doc_id, page_id) row bumps the revision by 1.
    Clients send the last-seen revision via the `X-Expected-Revision` header;
    the server compares and refuses the write with HTTP 409 if it doesn't match.
  - The `projects` table has a `revision` column too, bumped on any write that
    touches project data (annotations, links, settings, etc.). Clients poll
    `GET /api/projects/{id}` and compare `revision` to detect remote changes.

Storage reclamation:
  - `PRAGMA auto_vacuum = INCREMENTAL` is set on every connection so deleted
    pages can be returned to the OS cheaply via `PRAGMA incremental_vacuum`.
  - `vacuum_after_project_delete()` runs `VACUUM` (a full, off-transaction
    rebuild) after a project is deleted. This is safe because the operation
    is rare, not in a transaction, and runs on a fresh dedicated connection.
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

# A separate lock used only for the rare VACUUM operation, which must run
# with NO other connections active inside the same DB file to be safe.
_vacuum_lock = threading.Lock()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    color TEXT,
    revision INTEGER NOT NULL DEFAULT 0
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
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, doc_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations(project_id);
CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(project_id, doc_id);

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

-- Yjs CRDT collaboration state.
-- Each row is one binary Yjs update for a (project_id, doc_id) "room".
-- The `path` column is "<project_id>/<doc_id>" — the YStore uses it as the
-- room identifier. Updates are applied in timestamp order to reconstruct
-- the full Y.Doc state on server restart / browser refresh.
--
-- This table is created here (rather than lazily by the YStore) so the
-- main schema knows about it, and so the per-project / per-doc cascade
-- deletes (which use a LIKE '<project_id>/%' or path = '<pid>/<did>' match)
-- work even if the YStore was never opened for that room.
CREATE TABLE IF NOT EXISTS anno_yjs_state (
    path TEXT NOT NULL,
    yupdate BLOB NOT NULL,
    metadata BLOB,
    timestamp REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anno_yjs_state_path_ts ON anno_yjs_state(path, timestamp);
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
    composite (project_id, ...) PK. Idempotent.

    Also adds new columns (projects.revision, annotations.revision,
    annotations.updated_at) to existing tables without dropping data.
    """
    # 1) Ensure the projects table exists.
    if not _table_exists(conn, "projects"):
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
            "description TEXT, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, "
            "color TEXT, revision INTEGER NOT NULL DEFAULT 0)"
        )

    # 1b) Add the `revision` column to projects if missing (online ALTER).
    if not _column_exists(conn, "projects", "revision"):
        try:
            conn.execute(
                "ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
            )
            print("[migrate] projects.revision column added")
        except sqlite3.OperationalError as e:
            # Already exists or table just created — ignore.
            print(f"[migrate] projects.revision add skipped: {e}")

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

    # 2b) Add new columns to existing annotations table (online ALTER, no data loss).
    if _table_exists(conn, "annotations"):
        if not _column_exists(conn, "annotations", "revision"):
            try:
                conn.execute(
                    "ALTER TABLE annotations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
                )
                print("[migrate] annotations.revision column added")
            except sqlite3.OperationalError as e:
                print(f"[migrate] annotations.revision add skipped: {e}")
        if not _column_exists(conn, "annotations", "updated_at"):
            try:
                conn.execute(
                    "ALTER TABLE annotations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"
                )
                print("[migrate] annotations.updated_at column added")
            except sqlite3.OperationalError as e:
                print(f"[migrate] annotations.updated_at add skipped: {e}")
        # Index for fast per-doc lookups.
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(project_id, doc_id)"
            )
        except sqlite3.OperationalError as e:
            print(f"[migrate] annotations doc index skipped: {e}")

    # 3) Ensure a default project exists. If there's already data without a project
    # (e.g. migrated from the previous single-project version), create a "default"
    # project and bind all rows to it.
    default_proj = conn.execute("SELECT id FROM projects WHERE id = 'default'").fetchone()
    if not default_proj:
        now = int(time.time() * 1000)
        conn.execute(
            "INSERT INTO projects (id, name, description, created_at, modified_at, color, revision) "
            "VALUES ('default', 'My First Project', 'Auto-migrated from previous version', ?, ?, '#3b82f6', 0)",
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
        # WAL gives much better concurrent read performance and lets readers
        # coexist with a single writer.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        # Incremental auto-vacuum: when rows are deleted, the freed pages are
        # tracked in a free-page list. `PRAGMA incremental_vacuum` (called from
        # vacuum_after_project_delete) then returns them to the OS in chunks.
        # This avoids the heavy full-table-rewrite of plain VACUUM on every
        # delete, while still letting us reclaim space after big deletes.
        try:
            mode = conn.execute("PRAGMA auto_vacuum").fetchone()[0]
            if mode != 2:  # 2 = INCREMENTAL
                conn.execute("PRAGMA auto_vacuum = INCREMENTAL")
        except sqlite3.OperationalError:
            # Cannot change auto_vacuum mode on an existing DB without VACUUM;
            # the full VACUUM below will pick it up.
            pass
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


def execute_many(sqls_with_params: list[tuple[str, tuple]]) -> None:
    """Run multiple statements in a single transaction. Useful for cascading
    deletes (e.g. project deletion) so that either all rows are removed or none.
    """
    with transaction() as conn:
        for sql, params in sqls_with_params:
            conn.execute(sql, params)


# ---- Conflict-detection helpers ----

def bump_project_revision(project_id: str, conn: Optional[sqlite3.Connection] = None) -> None:
    """Atomically increment a project's revision counter and refresh modified_at.

    The revision is a monotonic counter used for real-time sync. Bumping it on
    every write lets connected clients instantly know that something changed and
    pull the latest data via WebSocket push notification.

    After bumping, this function also triggers a WebSocket broadcast to all
    connected clients for this project (see server/realtime_sync.py).
    """
    now = int(time.time() * 1000)
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    new_revision = None
    try:
        conn.execute(
            "UPDATE projects SET revision = revision + 1, modified_at = ? WHERE id = ?",
            (now, project_id)
        )
        if own_conn:
            conn.commit()
        # Read back the new revision so we can broadcast it.
        row = conn.execute(
            "SELECT revision FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row:
            new_revision = int(row[0])
    except Exception:
        if own_conn:
            conn.rollback()
        raise
    # ---- Real-time sync: broadcast the revision change to all connected ----
    # ---- clients via WebSocket so they can pull the latest instantly.   ----
    if new_revision is not None:
        try:
            from . import realtime_sync
            realtime_sync.broadcast_revision_change_sync(project_id, new_revision)
        except Exception:
            # Broadcast failure is non-fatal — clients will catch up on the
            # next poll fallback (if any) or on their next save.
            pass


def get_project_revision(project_id: str) -> Optional[int]:
    """Return the current revision of the project, or None if it doesn't exist."""
    row = query_one(
        "SELECT revision, modified_at FROM projects WHERE id = ?", (project_id,)
    )
    if not row:
        return None
    return int(row.get("revision") or 0)


# ---- Storage reclamation ----

def vacuum_after_project_delete() -> None:
    """Reclaim SQLite file space after a project deletion.

    Strategy:
      1. Run `PRAGMA incremental_vacuum` if auto_vacuum is INCREMENTAL —
         this trims the file by N pages without a full rebuild, and is safe
         to run while other connections are open.
      2. As a fallback / belt-and-braces, run a full VACUUM on a *dedicated*
         connection with no other statements inside the transaction. VACUUM
         rewrites the entire database file, which is the most thorough way to
         release space but locks the DB for the duration. We only do this
         for project deletions because they're infrequent and the user is
         already expecting a short pause.

    Both calls are wrapped in a process-wide lock so two concurrent deletes
    don't fight each other.
    """
    acquired = _vacuum_lock.acquire(blocking=True, timeout=30.0)
    if not acquired:
        print("[vacuum] could not acquire vacuum lock; skipping")
        return

    # Step 1: incremental vacuum on the per-thread connection (cheap).
    try:
        conn = get_conn()
        mode = conn.execute("PRAGMA auto_vacuum").fetchone()[0]
        if mode == 2:  # INCREMENTAL
            # Trims as many free pages as possible.
            conn.execute("PRAGMA incremental_vacuum")
            conn.commit()
            print("[vacuum] incremental_vacuum ran after project delete")
    except Exception as e:
        print(f"[vacuum] incremental_vacuum failed: {e}")

    # Step 2: full VACUUM on a fresh, isolated connection.
    # VACUUM cannot run inside a transaction, so we use a dedicated connection
    # that has not started any transaction. WAL mode allows readers to continue
    # during VACUUM, but writers will briefly block.
    try:
        vacuum_conn = sqlite3.connect(config.DB_PATH, timeout=60.0, isolation_level=None)
        try:
            vacuum_conn.execute("VACUUM")
            print("[vacuum] full VACUUM completed; database file compacted")
        finally:
            vacuum_conn.close()
    except Exception as e:
        print(f"[vacuum] full VACUUM failed: {e}")
    finally:
        _vacuum_lock.release()

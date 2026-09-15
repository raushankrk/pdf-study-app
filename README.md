# PDF Linker Studio — Server Edition (Multi-Project)

A server-side PDF management studio with a **Project Dashboard** that lets you
manage multiple isolated projects. Each project contains its own PDFs, folders,
annotations, links, chats, and AI/RAG indexes — completely independent of other
projects.

```
   ┌──────────────────────────────────────┐
   │  Windows PC                           │
   │  ┌────────────┐  ┌────────────────┐ │
   │  │ FastAPI     │→ │ SQLite (app.db) │ │
   │  │  :8000      │  │ + /data/pdfs/   │ │
   │  │             │  │   per-project   │ │
   │  └─────┬──────┘  └────────────────┘ │
   │        │                             │
   │        ↓                             │
   │  ┌────────────┐                      │
   │  │ Ollama     │  (LLM + embeddings)  │
   │  └────────────┘                      │
   └──────────────────────────────────────┘
                    ↑
                    │ HTTP
                    │
   ┌────────────────┴─────────────────────┐
   │  iPad / Phone / Laptop browser        │
   │  http://WINDOWS-PC-IP:8000           │
   │                                        │
   │  /  → Project Dashboard                │
   │  /editor/<project_id> → PDF Editor    │
   └───────────────────────────────────────┘
```

---

## What's New (this revision)

### Project Dashboard (`/`)
A new landing page that lists all projects on the server. Each project card
shows:
- Project name + color tag
- Description
- Number of PDFs, folders
- Total size
- Created / modified dates

### Multi-project isolation
- Every database table now has a `project_id` column
- All API endpoints require the `X-Project-Id` header (or `?project_id=` query param)
- PDFs are stored at `data/pdfs/<project_id>/<doc_id>.pdf` — one subdirectory per project
- Opening Project A never displays or modifies Project B's data

### Project actions (dashboard)
1. **Create New Project** — modal asks for name, description, color → server creates the project + root folder → automatically opens the editor
2. **Open Project** — click a card to navigate to `/editor/<project_id>`
3. **Export Project** — downloads a `.plsx` backup file (zip with `manifest.json`, `data.sqlite`, and all PDFs)
4. **Import Project** — uploads a `.plsx` file. If a project with the same name exists, a modal asks for a new name (always imports as a **copy** with fresh IDs)
5. **Delete Project** — modal shows a strong warning, recommends exporting first, and offers three buttons: Cancel / Export Backup / Delete Permanently

### Navigation
- Editor header has a **← Dashboard** button that returns to the dashboard
- The button warns the user if there are pending saves (via `beforeunload`)
- The URL `/editor/<project_id>` is shareable — refresh keeps you in the same project

### Auto-migration of existing data
On first startup with an existing `data/app.db`, the server:
1. Creates a `projects` table
2. Recreates every resource table with a composite `(project_id, id)` primary key
3. Moves all existing rows into a project named **"My First Project"** (ID: `default`)
4. Creates a root folder for every project that lacks one
5. The `default` project cannot be deleted (it holds migrated data)

---

## 1. Files added

```
pdf-linker-studio-server/
├── server/
│   ├── deps.py                        ← NEW: FastAPI dependency for X-Project-Id
│   └── ... (existing files, see below)
├── static/
│   ├── dashboard.html                 ← NEW: dashboard page (project cards)
│   ├── css/
│   │   └── dashboard.css              ← NEW: dashboard styles
│   └── js/
│       └── dashboard.js               ← NEW: dashboard logic (CRUD + modals)
└── README.md                          ← this file (updated)
```

## 2. Files modified

| File | Change |
|------|--------|
| `server/database.py` | Rewrote schema with `project_id` columns + composite PKs. Added `_migrate()` that recreates old tables preserving data, plus a default-project auto-creation step. |
| `server/main.py` | Routes `/` → dashboard, `/editor/{project_id}` → editor. Updated startup banner. |
| `server/deps.py` | **NEW** — `get_current_project` dependency reads `X-Project-Id` header (or `?project_id=`), validates against `projects` table, returns the project_id. |
| `server/routers/projects.py` | Replaced single-project export/import with full project CRUD: `GET /api/projects`, `POST`, `GET /{id}`, `PATCH /{id}`, `DELETE /{id}`, `POST /{id}/export`, `POST /import`. Import creates new IDs for all resources (folders, documents, pages, annotations, links, chats, embeddings, settings) so the imported copy is fully independent. |
| `server/routers/documents.py` | All endpoints now take `project_id: str = Depends(get_current_project)` and filter queries by it. PDFs saved to `data/pdfs/<project_id>/`. |
| `server/routers/folders.py` | Same project-scoping applied. |
| `server/routers/annotations.py` | Same project-scoping applied. |
| `server/routers/links.py` | Same project-scoping applied. |
| `server/routers/chats.py` | Same project-scoping applied. |
| `server/routers/settings.py` | Same project-scoping applied. Updates project's `modified_at` when settings are saved. |
| `server/routers/ai.py` | All AI/RAG endpoints are project-scoped — embeddings and chats never leak across projects. |
| `server/services/embeddings.py` | `index_documents(project_id, force)` and `search(project_id, ...)` now take project_id. Indexing state is tracked per-project. |
| `static/js/api.js` | Added `CURRENT_PROJECT_ID` + `setProjectId()`/`getProjectId()`. Every request sends `X-Project-Id` header. Added project management methods: `listProjects`, `createProject`, `getProject`, `updateProject`, `deleteProject`, `exportProject`, `importProject`, `checkProjectNameExists`. |
| `static/js/app.js` | Reads project_id from URL `/editor/<project_id>`, calls `setProjectId()` before init. Added `goToDashboard()` with pending-save warning. |
| `static/js/database.js` | `exportProject()` now exports the CURRENT project via `Api.exportProject(projectId)`. `handleProjectImport()` redirects to the dashboard. |
| `static/index.html` | Added "← Dashboard" button in the editor header. Made all script/css paths absolute (`/js/...`, `/css/...`) so they work from `/editor/<id>` URLs. |

## 3. Database changes

```sql
-- New table
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    color TEXT
);

-- All existing tables now have a project_id column + composite PK:
folders       (project_id, id, name, parent_id, ...)        PK (project_id, id)
documents     (project_id, id, name, folder_id, ...)       PK (project_id, id)
annotations   (project_id, doc_id, page_id, data_json)      PK (project_id, doc_id, page_id)
links         (project_id, id, source_json, target_json)    PK (project_id, id)
chats         (project_id, id, title, messages_json)        PK (project_id, id)
embeddings    (project_id, id, doc_id, page_id, ...)        PK (project_id, id)
settings      (project_id, key, value)                     PK (project_id, key)
```

The migration is **idempotent and automatic** — on first startup with an old DB:
1. Backs up each table's rows
2. Drops the table
3. Recreates it with the new composite PK
4. Restores the rows with `project_id = 'default'`
5. Creates the `default` project named "My First Project"

No manual migration steps required.

## 4. API endpoints added

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/projects` | List all projects (with stats: doc count, folder count, size) |
| POST | `/api/projects` | Create a new project |
| GET | `/api/projects/{project_id}` | Get one project with full stats |
| PATCH | `/api/projects/{project_id}` | Update name/description/color |
| DELETE | `/api/projects/{project_id}` | Delete project + ALL its data (DB rows + PDF files). The `default` project cannot be deleted. |
| POST | `/api/projects/{project_id}/export` | Export as `.plsx` backup file |
| POST | `/api/projects/import` | Import a `.plsx` file as a NEW copy with fresh IDs |

All other endpoints (`/api/documents/*`, `/api/folders/*`, etc.) now require the
`X-Project-Id` header.

## 5. Project export format

A `.plsx` file is a standard ZIP archive containing:

```
my-project.plsx
├── manifest.json         # { format, version, project_id, project_name, created_at, pdf_count }
├── data.sqlite           # SQLite snapshot with tables: project_meta, folders, documents,
│                         #   annotations, links, chats, embeddings, settings
└── pdfs/
    ├── <doc_id_1>.pdf
    ├── <doc_id_2>.pdf
    └── ...
```

The SQLite snapshot contains a `project_meta` table with the original project's
metadata (id, name, description, color, created_at, modified_at) and a
`backup_format_version` field (currently `1`).

The browser never builds this file — all packing happens server-side.

## 6. Project import behavior

1. Server receives the `.plsx` file
2. Opens the ZIP, reads `manifest.json` and `data.sqlite`
3. Resolves the new project name:
   - If `new_name` is provided in the form data, use it (after uniqueness check)
   - Otherwise use the original name from the backup
   - If a project with that name already exists AND `on_conflict='copy'` (default):
     append " (Copy N)" until unique
   - If `on_conflict='cancel'`: return 409 without importing
4. Creates a new project with a fresh `proj_...` ID
5. Inserts all resources with **fresh IDs**:
   - Folders: new `folder_...` IDs (root keeps `root`)
   - Documents: new `doc_...` IDs
   - Pages: new `id_...` pageIds (so annotations/links/chat-citations stay valid)
   - Annotations: new page_id keys, with internal `pageId`/`docId` references remapped
   - Links: source/target JSON `docId`/`pageId` fields remapped
   - Chats: message HTML `data-doc`/`data-page-id` attributes remapped; `context` array remapped
   - Embeddings: new `chunk_...` IDs, `doc_id`/`page_id` remapped
   - Settings: `recentDocIds` and `view.left.docId`/`view.right.docId` remapped
6. Copies PDF files from the zip into `data/pdfs/<new_project_id>/`
7. Returns the new project's metadata

The imported copy is fully independent — no shared IDs with the original.

## 7. Delete / backup behavior

**Delete** endpoint (`DELETE /api/projects/{project_id}`):
1. Refuses to delete the `default` project (holds migrated data)
2. Deletes all DB rows for this project across all tables (embeddings, annotations, links, chats, documents, folders, settings, projects)
3. Removes the project's PDF directory `data/pdfs/<project_id>/` from disk
4. No orphaned files or DB records remain

**Backup recommendation**: The dashboard's delete modal shows:
- Strong warning: "Deleting this project will permanently remove its PDFs, folders, annotations, links, chats, AI/RAG data, and other project data from the server."
- "This action cannot be undone."
- Recommendation: "We recommend exporting this project before deleting it."
- Three buttons: **Cancel** / **Export Backup** / **Delete Permanently**

The "Export Backup" button triggers the export, then re-opens the delete modal so the user can confirm after backing up.

## 8. How to test (create / open / export / import / delete)

### Via the dashboard UI
1. Start the server: `run.bat` (Windows) or `./run.sh` (Linux/Mac)
2. Open `http://localhost:8000/` in your browser → dashboard loads
3. **Create**: Click "New Project" → fill in name → submit → editor opens automatically
4. **Open**: Click any project card → editor opens for that project
5. **Export**: Hover over a card → click the download icon → `.plsx` file downloads
6. **Import**: Click "Import" → select a `.plsx` file → if name conflicts, modal asks for a new name → confirm → project appears in dashboard
7. **Delete**: Hover over a card → click the trash icon → modal with warning + 3 buttons → choose Cancel / Export Backup / Delete Permanently

### Via curl (for scripting)
```bash
# List projects
curl http://localhost:8000/api/projects

# Create project
curl -X POST http://localhost:8000/api/projects \
    -H "Content-Type: application/json" \
    -d '{"name":"My Project","description":"Test","color":"#3b82f6"}'

# Upload a PDF into a project (note the X-Project-Id header)
curl -X POST http://localhost:8000/api/documents/upload \
    -H "X-Project-Id: proj_xxx" \
    -F "files=@test.pdf" \
    -F "folder_id=root"

# Export project
curl -X POST http://localhost:8000/api/projects/proj_xxx/export -o backup.plsx

# Import as a copy
curl -X POST http://localhost:8000/api/projects/import \
    -F "file=@backup.plsx" \
    -F "new_name=Imported Copy" \
    -F "on_conflict=copy"

# Delete project
curl -X DELETE http://localhost:8000/api/projects/proj_xxx
```

### Verify isolation
1. Create Project A and Project B
2. Upload a PDF into Project A
3. Open Project B's editor — the PDF list should be empty
4. List documents via API with each project's ID — only that project's docs are returned

## 9. Migration required for existing projects

**Automatic — no manual steps required.**

On first startup with an existing `data/app.db` from the previous (single-project) version:
1. The server detects old table shapes (single-column PK without `project_id`)
2. Backs up all rows
3. Drops and recreates each table with the new composite PK
4. Restores rows with `project_id = 'default'`
5. Creates a project named **"My First Project"** (ID: `default`) to hold the migrated data
6. The `default` project shows up in the dashboard like any other project

You can rename "My First Project" via the dashboard (open it, then use the editor's Save button — the project name comes from the URL/title), or via the API:
```bash
curl -X PATCH http://localhost:8000/api/projects/default \
    -H "Content-Type: application/json" \
    -d '{"name":"My Renamed Project"}'
```

The `default` project cannot be deleted (to prevent accidental loss of migrated data). To "delete" it, export it first, then manually clear the database.

---

## How to install (unchanged from previous version)

1. Install Python 3.9+ (with "Add to PATH" checked) and Ollama from ollama.com
2. Pull models: `ollama pull nomic-embed-text` and `ollama pull gemma3:1b`
3. Unzip the archive and double-click `run.bat`

See the previous README sections for full Windows setup, firewall, and LAN access instructions.

## How to access from iPad / phone

1. Find the PC's local IP (`ipconfig` → IPv4 Address)
2. On the iPad/phone (same Wi-Fi), open `http://WINDOWS-PC-IP:8000`
3. The dashboard loads → tap a project card to open the editor
4. The URL bar shows `/editor/<project_id>` — bookmarkable per project

## Windows Firewall requirements

Same as before — allow port 8000 (TCP) inbound. The first time you run `run.bat`,
Windows Defender Firewall shows a popup for Python; tick both Private and Public
networks.

## Remaining limitations

1. **Ollama required on the PC** — AI chat/search won't work without it
2. **Single-user, no auth** — anyone on the LAN can access the dashboard and modify any project
3. **No concurrent-edit merging** — last save wins if two devices edit the same project simultaneously
4. **PDF bytes transfer over Wi-Fi** — large PDFs take a few seconds to load on mobile
5. **Annotation images stored as base64 in DB** — fine for typical use
6. **Indexing is synchronous per project** — large libraries (100+ PDFs) may take a few minutes per project on first index
7. **No upload progress bar** — large PDFs upload in one POST
8. **SQLite only** — fine for personal use (millions of rows); swap to PostgreSQL in `database.py` if needed
9. **Project dashboard is a separate page** — not a SPA. Navigation between dashboard and editor is a full page load (fast, but not animated)

## Architecture summary

```
Browser (iPad/phone/PC)             Windows PC
─────────────────────               ────────────────────────
┌──────────────────┐                ┌──────────────────────┐
│ Dashboard page   │  HTTP/REST     │ FastAPI (port 8000)  │
│  /               │ ←──────────→   │  ├ routers/          │
│  - list projects │                │  │  ├ projects       │
│  - CRUD actions  │                │  │  ├ documents      │
│                  │                │  │  ├ folders        │
│ Editor page      │                │  │  ├ annotations    │
│  /editor/<pid>   │                │  │  ├ chats/links    │
│  ├ PDF.js        │                │  │  ├ settings       │
│  ├ PDF-Lib       │                │  │  └ ai (Ollama)    │
│  ├ Tailwind      │                │  └ services/         │
│  └ api.js        │                │     ├ ollama.py      │
│                  │                │     └ embeddings.py │
│  All data via    │                │                      │
│  REST API +      │                │  SQLite (data/app.db)│
│  X-Project-Id    │                │  + data/pdfs/<pid>/  │
│  header          │                │    per-project       │
└──────────────────┘                └──────────────────────┘
                                                ↓
                                        Ollama (port 11434)
```

- **Dashboard page** (`/`): lists projects, manages CRUD. No project context.
- **Editor page** (`/editor/<project_id>`): full PDF editor. Reads project_id from URL, sends it as `X-Project-Id` header on every API call.
- **Server**: validates every project-scoped request against the `projects` table; queries always filter by `project_id`; PDFs stored in per-project subdirectories.

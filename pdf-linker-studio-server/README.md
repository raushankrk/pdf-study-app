# PDF Linker Studio — Server Edition

A server-side version of **PDF Linker Studio** that runs on your Windows PC and is
accessible from any device (iPad, phone, laptop) on the same local network via a
browser URL.

```
   ┌──────────────────────────────────────┐
   │  Windows PC                           │
   │  ┌────────────┐  ┌────────────────┐ │
   │  │ FastAPI    │→ │ SQLite (app.db) │ │
   │  │  :8000     │  │ + /data/pdfs/   │ │
   │  └─────┬──────┘  └────────────────┘ │
   │        │                             │
   │        ↓                             │
   │  ┌────────────┐                      │
   │  │ Ollama     │  (LLM + embeddings)  │
   │  │ :11434     │                      │
   │  └────────────┘                      │
   └──────────────────────────────────────┘
                    ↑
                    │ HTTP (LAN / Wi-Fi)
                    │
   ┌────────────────┴─────────────────────┐
   │  iPad / Phone / Laptop browser        │
   │  http://WINDOWS-PC-IP:8000            │
   │  PDF.js renders pages locally         │
   └───────────────────────────────────────┘
```

The browser never talks to Ollama directly — every AI/RAG request goes through
the FastAPI backend, which forwards it to Ollama running on the same PC.

---

## 1. Files changed (vs. the previous standalone version)

| File | Status | Purpose |
|------|--------|---------|
| `server/main.py` | **NEW** | FastAPI app entry point, registers routers + static file serving |
| `server/config.py` | **NEW** | Loads `config.ini`, resolves paths, exposes `HOST`/`PORT`/`OLLAMA_URL`/etc. |
| `server/database.py` | **NEW** | SQLite schema + thread-local connection helper |
| `server/routers/documents.py` | **NEW** | Documents REST API (list/get/upload/move/delete/duplicate/replace-file) |
| `server/routers/folders.py` | **NEW** | Folders REST API (CRUD + tree + cycle-safe move) |
| `server/routers/annotations.py` | **NEW** | Annotations REST API (per-doc and per-page) |
| `server/routers/links.py` | **NEW** | Links REST API |
| `server/routers/chats.py` | **NEW** | Chats REST API |
| `server/routers/settings.py` | **NEW** | Settings REST API (key/value store for app state) |
| `server/routers/projects.py` | **NEW** | Project export/import (build/restore SQLite file) |
| `server/routers/ai.py` | **NEW** | AI/RAG endpoints: index, search, streaming chat, Ollama status |
| `server/services/ollama.py` | **NEW** | Ollama HTTP client (embeddings + generate + generate_stream) |
| `server/services/embeddings.py` | **NEW** | Server-side indexing (PyMuPDF text extraction + chunking + Ollama embeddings) |
| `server/config.ini.example` | **NEW** | Default config template (auto-copied to `config.ini` on first run) |
| `server/requirements.txt` | **NEW** | Python deps: fastapi, uvicorn, python-multipart, pydantic, PyMuPDF |
| `run.bat` | **NEW** | Windows launcher — creates venv, installs deps, starts uvicorn |
| `run.sh` | **NEW** | Linux/macOS launcher (optional, kept for parity) |
| `static/js/api.js` | **NEW** | Frontend REST client (wraps `fetch` for every endpoint) |
| `static/js/database.js` | **REWRITTEN** | Originally IndexedDB wrapper; now routes everything through `Api.*`. Same function names so the rest of the code doesn't change. |
| `static/js/ai.js` | **MODIFIED** | `getEmbedding()` and `generateLLMResponse()` are now no-ops (server does the work). `indexDocuments()` calls `Api.triggerIndexing()`. `handleChat()` uses `Api.streamChat()` for streaming SSE retrieval + LLM. |
| `static/js/pdf.js` | **MODIFIED** | New `ensureDocLoaded()` lazy-loads PDF bytes + annotations on first viewport open. `handleFileUpload()` uploads to server. `renderPage()` awaits `ensureDocLoaded()`. |
| `static/js/folders.js` | **MODIFIED** | `createFolder`/`renameFolder`/`moveFolder`/`deleteFolder`/`toggleFolderExpanded` now call `Api.*` instead of writing to IndexedDB. Same external API. |
| `static/js/filemanager.js` | **MODIFIED** | `duplicateDocument()` calls server. `_deleteDocumentRecord()` calls `Api.deleteDocument`. |
| `static/js/app.js` | **MODIFIED** | Init flow no longer loads every PDF into memory — only metadata. PDF bytes are lazy-loaded when a doc is opened. |
| `static/js/state.js` | **MODIFIED** | `db` and `SqlDb` globals kept as `null` for backward-compat (no longer used). |
| `static/js/config.js` | **MODIFIED** | `els.globalSearchInput` now aliases the unified-search input element. |
| `static/index.html` | **MODIFIED** | Added `<script src="js/api.js">` before `database.js`. |

All existing UI features (folder tree, breadcrumbs, file explorer, annotation tools,
link drawing, snip-link, page insert/delete, AI settings modal, project export/import,
keyboard shortcuts) are preserved.

---

## 2. New files

```
pdf-linker-studio-server/
├── server/
│   ├── __init__.py
│   ├── main.py                      ← FastAPI app
│   ├── config.py                    ← config loader
│   ├── config.ini.example           ← copy to config.ini to customize
│   ├── database.py                  ← SQLite schema + helpers
│   ├── requirements.txt
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── documents.py
│   │   ├── folders.py
│   │   ├── annotations.py
│   │   ├── links.py
│   │   ├── chats.py
│   │   ├── settings.py
│   │   ├── projects.py
│   │   └── ai.py
│   └── services/
│       ├── __init__.py
│       ├── ollama.py                ← Ollama HTTP client
│       └── embeddings.py            ← text extraction + chunking + retrieval
├── static/                           ← existing frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js                   ← NEW: REST client
│       ├── database.js              ← REWRITTEN: routes through API
│       ├── ai.js                    ← MODIFIED: server-side AI
│       ├── pdf.js                   ← MODIFIED: lazy loading
│       ├── folders.js               ← MODIFIED: API calls
│       ├── filemanager.js           ← MODIFIED: API calls
│       ├── app.js                   ← MODIFIED: lazy init
│       ├── state.js, config.js, ui.js, events.js, annotations.js, links.js, search.js, utils.js  (unchanged)
├── data/                             ← created on first run
│   ├── app.db                        ← SQLite database
│   ├── pdfs/                         ← uploaded PDFs
│   ├── images/                       ← annotation images
│   └── thumbnails/
├── run.bat                           ← Windows launcher
├── run.sh                            ← Linux/macOS launcher
└── README.md                         ← this file
```

---

## 3. How to install

### Prerequisites

1. **Python 3.9 or newer** — download from <https://www.python.org/downloads/>
   - During install, **check "Add Python to PATH"**.
2. **Ollama** — download from <https://ollama.com/> and install.
3. Pull the AI models (one-time, ~1 GB download each):
   ```bat
   ollama pull nomic-embed-text
   ollama pull gemma3:1b
   ```
   (You can change these models in `server/config.ini` later.)

### Install steps

1. **Unzip** the `pdf-linker-studio-server.zip` to any folder, e.g.
   `C:\Users\YourName\PDF Linker Studio`.
2. **Double-click `run.bat`**. On first run it will:
   - Create a Python virtual environment in `.venv\`
   - Install FastAPI, uvicorn, PyMuPDF, and other dependencies
   - Copy `server/config.ini.example` → `server/config.ini` (edit this to customize)
   - Start the server on `http://0.0.0.0:8000`
3. The first run takes ~1-2 minutes for dependency installation. Subsequent
   runs start in ~3 seconds.

You only need to do this once. After that, double-clicking `run.bat` is enough.

---

## 4. How to run on Windows

1. **Start Ollama** (if not already running in the system tray):
   - Launch the Ollama app, or run `ollama serve` in a terminal.
2. **Double-click `run.bat`**.
3. A console window opens showing:
   ```
   Starting PDF Linker Studio server...

     Web UI:  http://localhost:8000

     To access from another device on your network (iPad, phone, etc.):
     Replace WINDOWS-PC-IP below with this PC's local IP address, then
     open this URL on the other device:

     http://WINDOWS-PC-IP:8000
   ```
4. **Open the URL in your browser** on the same PC: <http://localhost:8000>
5. **Leave the console window open** while you use the app. Close it (or press
   `Ctrl+C`) to stop the server.

### Find your Windows PC's local IP address

The startup console prints it for you. Or to find it manually:

- Press `Win + R`, type `cmd`, press Enter.
- Run: `ipconfig`
- Look for the line `IPv4 Address` under your active network adapter
  (Ethernet or Wi-Fi). It will look like `192.168.1.42` or `10.0.0.15`.

---

## 5. How to access from iPad / phone

1. Make sure your iPad/phone is on the **same Wi-Fi network** as the Windows PC.
2. Open Safari/Chrome on the iPad/phone.
3. Type the URL: `http://WINDOWS-PC-IP:8000`
   - Example: `http://192.168.1.42:8000`
4. The full PDF Linker Studio UI loads. You can:
   - Browse the folder tree
   - Upload PDFs (from the iPad's Files app or photo library)
   - Open PDFs in either viewport
   - Annotate, draw, highlight, add text boxes, images
   - Create links between PDFs/pages
   - Search content (the search runs on the server)
   - Chat with the AI (uses Ollama running on the PC)

### Tips for mobile use

- Pinch-to-zoom works in the PDF viewports.
- The left/right split view is most useful on iPad landscape; on a phone,
  collapse one of the viewports (lock icon) to focus on the other.
- Long-press a file/folder to bring up the right-click context menu.

---

## 6. Windows Firewall requirements

When you first run `run.bat`, **Windows Defender Firewall** will likely show
a popup asking: *"Windows Defender Firewall has blocked some features of
this app"* — for **Python**.

**Tick both checkboxes**:
- ✅ Private networks (such as my home or work network)
- ✅ Public networks (use this only if you trust the network)

Then click **Allow access**.

### If you missed the popup, or want to verify

1. Press `Win + R`, type `wf.msc`, press Enter (opens Windows Defender Firewall
   with Advanced Security).
2. Click **Inbound Rules** on the left.
3. Look for **Python** in the list. There should be two entries (one for TCP,
   one for UDP) marked as **Allowed, Yes** for both Profile and Enabled.
4. If not present, click **New Rule…** on the right:
   - Rule type: **Port**
   - Protocol: **TCP**
   - Specific local ports: **8000** (or whatever port you set in `config.ini`)
   - Action: **Allow the connection**
   - Profile: tick all three (Domain, Private, Public)
   - Name: `PDF Linker Studio`

### Alternative: open port via netsh (Command Prompt as admin)

```bat
netsh advfirewall firewall add rule name="PDF Linker Studio" dir=in action=allow protocol=TCP localport=8000
```

### Verifying the firewall rule

From another device, try opening `http://WINDOWS-PC-IP:8000/api/health` in
a browser. If you see `{"status":"ok","data_dir":"..."}` — the firewall is
open. If the page hangs or times out — the firewall is blocking port 8000.

---

## 7. Configuration

All settings live in `server/config.ini`. Edit it (any text editor) and
restart `run.bat` to apply.

```ini
[server]
host = 0.0.0.0          # 0.0.0.0 = listen on all interfaces (LAN access)
port = 8000              # change if 8000 is in use
static_dir = static      # frontend folder (relative to project root)
data_dir = data          # SQLite DB + PDF storage (relative to project root)

[ollama]
url = http://localhost:11434
embedding_model = nomic-embed-text
llm_model = gemma3:1b    # change to llama3.2, mistral, qwen2.5, etc.

[ai]
max_pages_per_doc = 50   # cap on text extraction per PDF during indexing
request_timeout = 120    # seconds before Ollama requests time out
```

### Where data is stored

- **Database**: `data/app.db` (SQLite, ~10 KB to several MB depending on library size)
- **PDF files**: `data/pdfs/<doc_id>.pdf` (one file per uploaded PDF)
- **Thumbnails**: stored inline in the database as base64 PNG
- **Annotation images**: stored inline in the database as base64

To back up your library, just copy the `data/` folder somewhere safe.

---

## 8. REST API endpoints (for power users / scripting)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/documents` | List all documents (metadata only) |
| GET | `/api/documents/{id}` | Get one document's metadata |
| GET | `/api/documents/{id}/file` | Download the PDF bytes |
| POST | `/api/documents/upload` | Upload PDF(s) to a folder (multipart/form-data) |
| PUT | `/api/documents/{id}` | Update metadata (name, folder, favorite) |
| POST | `/api/documents/{id}/duplicate` | Duplicate a document |
| DELETE | `/api/documents/{id}` | Delete a document (cascades to annotations, links, embeddings, file) |
| PUT | `/api/documents/{id}/move` | Move to a different folder |
| PUT | `/api/documents/{id}/file` | Replace the PDF (after page insert/delete in browser) |
| GET | `/api/folders` | List all folders |
| GET | `/api/folders/tree` | Get nested folder tree |
| POST | `/api/folders` | Create folder |
| PUT | `/api/folders/{id}` | Rename folder |
| PUT | `/api/folders/{id}/move` | Move folder (cycle-safe) |
| PUT | `/api/folders/{id}/expanded` | Toggle expanded state |
| DELETE | `/api/folders/{id}` | Delete folder (cascade or move-to-root) |
| GET | `/api/annotations/{doc_id}` | Get all page annotations for a doc |
| PUT | `/api/annotations/{doc_id}/{page_id}` | Save one page's annotations |
| PUT | `/api/annotations/{doc_id}` | Replace all annotations for a doc |
| DELETE | `/api/annotations/{doc_id}` | Delete all annotations |
| GET | `/api/links` | List all links |
| POST | `/api/links` | Create link |
| DELETE | `/api/links/{id}` | Delete link |
| GET | `/api/chats` | List chats |
| POST | `/api/chats` | Create chat |
| PUT | `/api/chats/{id}` | Update chat (title or messages) |
| DELETE | `/api/chats/{id}` | Delete chat |
| GET | `/api/settings` | Get app-state settings |
| PUT | `/api/settings` | Save app-state settings |
| GET | `/api/projects/export` | Download SQLite backup file |
| POST | `/api/projects/import` | Upload SQLite backup file |
| POST | `/api/ai/index` | Trigger server-side indexing |
| GET | `/api/ai/index/status` | Indexing progress |
| POST | `/api/ai/search` | Semantic search across PDFs |
| POST | `/api/ai/chat` | Streaming chat (SSE) with retrieval |
| GET | `/api/ai/status` | Ollama connection + model status |

---

## 9. Remaining limitations

1. **Ollama required on the PC** — the AI chat and semantic search won't work
   unless Ollama is installed and running on the same Windows PC. The browser
   shows a clear error if Ollama is unreachable.
2. **Single-user server** — there's no authentication. Anyone on your LAN can
   access the app and modify the library. For home use this is fine; for a
   shared office, put it behind a reverse proxy with auth (nginx + basic auth).
3. **No concurrent edits** — if two devices edit the same annotation at the
   same time, the last save wins. The server uses SQLite WAL mode so reads
   don't block writes, but there's no operational-transform merging.
4. **PDF rendering stays in the browser** — large PDFs (100+ MB) take a few
   seconds to load on iPad/phone because the bytes have to transfer over Wi-Fi.
   Once loaded, scrolling/zooming is local and fast.
5. **Annotation images stored as base64 in DB** — for libraries with thousands
   of annotation images, consider migrating to filesystem storage. Not a
   problem for typical use (<1000 images).
6. **Indexing is synchronous** — for libraries with 100+ PDFs, the first
   indexing call blocks the HTTP request until done (~1-3 sec per PDF
   depending on length). The browser shows a "Indexing PDFs on server..."
   spinner. A background-task version is possible but not implemented.
7. **No upload progress bar** — large PDFs upload in a single POST. For
   multi-GB PDFs, chunked upload would be better.
8. **SQLite is the only DB** — fine for personal use (millions of rows
   supported). For multi-user heavy load, swap to PostgreSQL by changing
   `server/database.py`.

---

## 10. Troubleshooting

### "Cannot reach Ollama at http://localhost:11434"

- Make sure Ollama is running: open a terminal and run `ollama list` — it should
  list your installed models without error.
- If Ollama is running on a different port, edit `server/config.ini` and change
  `url` under `[ollama]`.
- If the embedding model isn't pulled yet: `ollama pull nomic-embed-text`.

### Browser can't open `http://WINDOWS-PC-IP:8000`

- Verify the IP is correct: on the PC, run `ipconfig` and use the IPv4 address.
- Verify both devices are on the same Wi-Fi (some routers isolate clients —
  check your router's "AP Isolation" / "Client Isolation" setting).
- Verify Windows Firewall allows port 8000 (see section 6).
- Try `http://localhost:8000` on the PC itself — if that works but other devices
  can't reach it, it's definitely a firewall issue.

### "Init failed" or blank page

- Check the server console for Python tracebacks.
- Verify `/api/health` responds: open `http://localhost:8000/api/health` in
  the browser.
- Clear browser cache and reload with Ctrl+F5.

### PDF upload fails

- Check the server console. Most common cause: the `data/pdfs/` folder isn't
  writable. Right-click the project folder → Properties → Security → make sure
  your user has Write permission.
- Large PDFs (>50 MB) may need `client_max_body_size` raised if you put nginx
  in front — but uvicorn alone has no upload size limit.

### AI chat returns an error

- The error message includes the underlying cause (e.g. "Cannot reach Ollama",
  "model not found"). Pull the model with `ollama pull <name>`.
- If the chat hangs forever, the LLM may be too large for your PC's RAM. Try
  a smaller model (e.g. `gemma3:1b` instead of `gemma3:4b`).

---

## 11. Architecture summary

```
Browser (iPad/phone/PC)             Windows PC
─────────────────────               ────────────────────────
┌──────────────────┐                ┌──────────────────────┐
│ HTML/CSS/JS      │  HTTP/REST     │ FastAPI (port 8000)  │
│  ├ PDF.js        │ ←──────────→   │  ├ routers/          │
│  ├ PDF-Lib       │                │  │  ├ documents      │
│  ├ Tailwind      │                │  │  ├ folders         │
│  ├ KaTeX         │                │  │  ├ annotations     │
│  └ api.js        │                │  │  ├ chats/links     │
│                  │                │  │  ├ settings        │
│  Renders pages   │                │  │  └ projects       │
│  locally; all    │                │  └ services/         │
│  data goes via   │                │     ├ ollama.py ───→ Ollama (11434)
│  REST API.       │                │     └ embeddings.py   │
└──────────────────┘                │                      │
                                    │  SQLite (data/app.db)│
                                    │  + data/pdfs/*.pdf   │
                                    └──────────────────────┘
```

- **Browser**: PDF.js renders PDF pages on canvas; PDF-Lib edits pages; the
  annotation system draws on overlay canvas. **No data is stored in the
  browser** — everything goes through the REST API.
- **FastAPI**: serves the static frontend, handles all REST endpoints, and
  proxies AI/RAG requests to Ollama.
- **SQLite**: stores folder tree, document metadata, annotations, links,
  chats, embeddings, and settings.
- **Filesystem**: `data/pdfs/<doc_id>.pdf` — one file per uploaded PDF.
- **Ollama**: runs locally on the PC. Provides embedding generation
  (`nomic-embed-text`) and chat completion (`gemma3:1b` by default).

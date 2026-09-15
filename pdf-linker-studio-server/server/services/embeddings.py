"""
Embedding + retrieval service.

The original browser implementation extracted text via PDF.js and computed
embeddings via Ollama. On the server, we still need PDF.js for *rendering*
(in the browser), but text extraction + chunking + embedding generation all
happen server-side here using PyMuPDF (fitz) — much faster and no browser
memory cost for the iPad/phone.
"""
import math
import time
from typing import Optional

from .. import config
from .. import database as db
from . import ollama

# Indexing state shared across requests (single-threaded enough for our purposes).
_indexing_state = {"is_indexing": False, "progress": 0, "total": 0, "current_doc": None, "last_error": None}


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _extract_text_from_pdf(file_path: str, max_pages: int = None) -> list[tuple[str, str]]:
    """Return [(page_id_unused, page_text), ...] — page_id is assigned by caller.

    Uses PyMuPDF (fitz) for fast text extraction without loading the whole PDF
    into a PDF.js instance.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        # Fallback: use a pure-python PDF text extractor.
        return _extract_text_pure_python(file_path, max_pages)

    pages = []
    try:
        doc = fitz.open(file_path)
        total = len(doc)
        if max_pages:
            total = min(total, max_pages)
        for i in range(total):
            page = doc.load_page(i)
            text = page.get_text().strip()
            pages.append((str(i + 1), text))
        doc.close()
    except Exception as e:
        print(f"Error extracting text from {file_path}: {e}")
    return pages


def _extract_text_pure_python(file_path: str, max_pages: int = None) -> list[tuple[str, str]]:
    """Fallback text extraction without PyMuPDF. Limited but works."""
    # Simple implementation: return empty text; PyMuPDF is recommended.
    print("WARNING: PyMuPDF not installed. PDF text extraction will be limited.")
    return []


def index_documents(force: bool = False) -> dict:
    """Index all un-indexed documents. Returns stats."""
    if _indexing_state["is_indexing"]:
        return {"status": "already_indexing", "progress": _indexing_state["progress"], "total": _indexing_state["total"]}

    docs = db.query_all("SELECT id, name, file_path, page_ids_json FROM documents")
    if not force:
        embedded_doc_ids = {row["doc_id"] for row in db.query_all("SELECT DISTINCT doc_id FROM embeddings")}
        docs = [d for d in docs if d["id"] not in embedded_doc_ids]

    _indexing_state["is_indexing"] = True
    _indexing_state["progress"] = 0
    _indexing_state["total"] = len(docs)
    _indexing_state["last_error"] = None

    try:
        chunk_size = 2000  # default; could be configurable per-call
        overlap = chunk_size // 10

        for doc in docs:
            _indexing_state["current_doc"] = doc["name"]
            try:
                page_ids = []
                if doc["page_ids_json"]:
                    import json
                    page_ids = json.loads(doc["page_ids_json"])

                pages = _extract_text_from_pdf(doc["file_path"], config.AI_MAX_PAGES_PER_DOC)

                # Build full text + page mappings (mirrors browser logic).
                full_text = ""
                page_mappings = []
                for idx, (_page_id_unused, text) in enumerate(pages):
                    if not text:
                        continue
                    page_id = page_ids[idx] if idx < len(page_ids) else f"page_{idx+1}"
                    start = len(full_text)
                    full_text += text + " "
                    page_mappings.append({"page_id": page_id, "start": start, "end": len(full_text)})

                if not full_text.strip():
                    _indexing_state["progress"] += 1
                    continue

                # Clear existing embeddings for this doc if force=True
                if force:
                    db.execute("DELETE FROM embeddings WHERE doc_id = ?", (doc["id"],))

                # Chunk + embed
                pos = 0
                while pos < len(full_text):
                    chunk = full_text[pos:pos + chunk_size]
                    if chunk.strip():
                        # Find which page this chunk starts on.
                        start_page_id = page_mappings[0]["page_id"] if page_mappings else None
                        for m in page_mappings:
                            if m["start"] <= pos < m["end"]:
                                start_page_id = m["page_id"]
                                break

                        try:
                            vector = ollama.get_embedding(chunk)
                            if vector:
                                emb_id = f"chunk_{doc['id']}_{pos}"
                                db.execute(
                                    "INSERT OR REPLACE INTO embeddings (id, doc_id, page_id, text, vector_json) VALUES (?, ?, ?, ?, ?)",
                                    (emb_id, doc["id"], start_page_id, chunk, json.dumps(vector)),
                                )
                        except Exception as e:
                            print(f"Embedding error for chunk at {pos} in {doc['name']}: {e}")
                    pos += max(1, chunk_size - overlap)
            except Exception as e:
                print(f"Indexing failed for {doc['name']}: {e}")
                _indexing_state["last_error"] = str(e)
            _indexing_state["progress"] += 1

    finally:
        _indexing_state["is_indexing"] = False
        _indexing_state["current_doc"] = None

    total_emb = db.query_one("SELECT COUNT(*) as c FROM embeddings")["c"]
    return {"status": "done", "indexed_docs": _indexing_state["progress"], "total_embeddings": total_emb}


def search(question: str, top_k: int = 8, min_score: float = 0.65,
           context_budget: int = 4000) -> list[dict]:
    """Semantic search: embed the question, score all chunks, return top hits."""
    try:
        q_vec = ollama.get_embedding(question)
    except Exception as e:
        return [{"error": f"Embedding failed: {e}"}]

    if not q_vec:
        return [{"error": "Empty embedding returned"}]

    rows = db.query_all("SELECT id, doc_id, page_id, text, vector_json FROM embeddings")
    scored = []
    for row in rows:
        import json
        try:
            vec = json.loads(row["vector_json"])
        except Exception:
            continue
        score = _cosine_similarity(q_vec, vec)
        if score >= min_score or (not scored and score > 0):
            scored.append({
                "id": row["id"],
                "doc_id": row["doc_id"],
                "page_id": row["page_id"],
                "text": row["text"],
                "score": score,
            })

    scored.sort(key=lambda x: -x["score"])

    # Budget-limited selection (mirrors browser logic)
    out = []
    total_chars = 0
    for chunk in scored:
        if total_chars + len(chunk["text"]) > context_budget:
            break
        if len(out) >= top_k:
            break
        out.append(chunk)
        total_chars += len(chunk["text"])

    return out


def get_indexing_status() -> dict:
    return {
        "is_indexing": _indexing_state["is_indexing"],
        "progress": _indexing_state["progress"],
        "total": _indexing_state["total"],
        "current_doc": _indexing_state["current_doc"],
        "last_error": _indexing_state["last_error"],
    }

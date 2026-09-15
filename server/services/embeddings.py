"""
Embedding + retrieval service (project-scoped).

All queries take a `project_id` parameter so embeddings from one project
never leak into another project's searches.
"""
import math
import json
from typing import Optional

from .. import config
from .. import database as db
from . import ollama

# Indexing state shared across requests (keyed by project_id).
_indexing_states: dict[str, dict] = {}


def _get_state(project_id: str) -> dict:
    if project_id not in _indexing_states:
        _indexing_states[project_id] = {
            "is_indexing": False, "progress": 0, "total": 0,
            "current_doc": None, "last_error": None
        }
    return _indexing_states[project_id]


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
    try:
        import fitz
    except ImportError:
        print("WARNING: PyMuPDF not installed. PDF text extraction will be limited.")
        return []

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


def index_documents(project_id: str, force: bool = False) -> dict:
    """Index all un-indexed documents in the given project."""
    state = _get_state(project_id)
    if state["is_indexing"]:
        return {"status": "already_indexing", "progress": state["progress"], "total": state["total"]}

    docs = db.query_all(
        "SELECT id, name, file_path, page_ids_json FROM documents WHERE project_id = ?",
        (project_id,)
    )
    if not force:
        embedded_doc_ids = {
            row["doc_id"] for row in db.query_all(
                "SELECT DISTINCT doc_id FROM embeddings WHERE project_id = ?", (project_id,)
            )
        }
        docs = [d for d in docs if d["id"] not in embedded_doc_ids]

    state["is_indexing"] = True
    state["progress"] = 0
    state["total"] = len(docs)
    state["last_error"] = None

    try:
        chunk_size = 2000
        overlap = chunk_size // 10

        for doc in docs:
            state["current_doc"] = doc["name"]
            try:
                page_ids = []
                if doc["page_ids_json"]:
                    page_ids = json.loads(doc["page_ids_json"])

                pages = _extract_text_from_pdf(doc["file_path"], config.AI_MAX_PAGES_PER_DOC)

                full_text = ""
                page_mappings = []
                for idx, (_unused, text) in enumerate(pages):
                    if not text:
                        continue
                    page_id = page_ids[idx] if idx < len(page_ids) else f"page_{idx+1}"
                    start = len(full_text)
                    full_text += text + " "
                    page_mappings.append({"page_id": page_id, "start": start, "end": len(full_text)})

                if not full_text.strip():
                    state["progress"] += 1
                    continue

                if force:
                    db.execute(
                        "DELETE FROM embeddings WHERE doc_id = ? AND project_id = ?",
                        (doc["id"], project_id)
                    )

                pos = 0
                while pos < len(full_text):
                    chunk = full_text[pos:pos + chunk_size]
                    if chunk.strip():
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
                                    "INSERT OR REPLACE INTO embeddings "
                                    "(id, project_id, doc_id, page_id, text, vector_json) "
                                    "VALUES (?, ?, ?, ?, ?, ?)",
                                    (emb_id, project_id, doc["id"], start_page_id, chunk, json.dumps(vector)),
                                )
                        except Exception as e:
                            print(f"Embedding error for chunk at {pos} in {doc['name']}: {e}")
                    pos += max(1, chunk_size - overlap)
            except Exception as e:
                print(f"Indexing failed for {doc['name']}: {e}")
                state["last_error"] = str(e)
            state["progress"] += 1

    finally:
        state["is_indexing"] = False
        state["current_doc"] = None

    total_emb = db.query_one(
        "SELECT COUNT(*) as c FROM embeddings WHERE project_id = ?", (project_id,)
    )["c"]
    return {"status": "done", "indexed_docs": state["progress"], "total_embeddings": total_emb}


def search(project_id: str, question: str, top_k: int = 8, min_score: float = 0.65,
           context_budget: int = 4000) -> list[dict]:
    """Semantic search: embed the question, score all chunks in this project, return top hits."""
    try:
        q_vec = ollama.get_embedding(question)
    except Exception as e:
        return [{"error": f"Embedding failed: {e}"}]

    if not q_vec:
        return [{"error": "Empty embedding returned"}]

    rows = db.query_all(
        "SELECT id, doc_id, page_id, text, vector_json FROM embeddings WHERE project_id = ?",
        (project_id,)
    )
    scored = []
    for row in rows:
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


def get_indexing_status(project_id: str) -> dict:
    state = _get_state(project_id)
    return {
        "is_indexing": state["is_indexing"],
        "progress": state["progress"],
        "total": state["total"],
        "current_doc": state["current_doc"],
        "last_error": state["last_error"],
    }

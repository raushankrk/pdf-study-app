"""
AI / RAG REST API (project-scoped).

All Ollama communication happens here on the server. The browser never calls
Ollama directly — it calls these endpoints instead.

Every endpoint requires the `X-Project-Id` header so AI/RAG indexes and chats
are isolated per project.
"""
import json
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import config
from .. import database as db
from ..deps import get_current_project
from ..services import ollama, embeddings

router = APIRouter()


class IndexRequest(BaseModel):
    force: bool = False


class SearchRequest(BaseModel):
    query: str
    top_k: int = 8
    min_score: float = 0.65
    context_budget: int = 4000


class ChatRequest(BaseModel):
    question: str
    system_prompt: str = "You are a helpful assistant answering questions based on the provided PDF context."
    chat_history: list = []
    model: Optional[str] = None
    temperature: float = 0.7
    response_style: str = "Detailed"
    strict_rag: bool = True
    skip_llm: bool = False
    include_chat_history: bool = True
    similarity_threshold: float = 0.65
    context_budget: int = 4000
    max_chunks: int = 8


@router.post("/index")
def index_endpoint(req: IndexRequest, project_id: str = Depends(get_current_project)):
    try:
        result = embeddings.index_documents(project_id, force=req.force)
        return result
    except Exception as e:
        raise HTTPException(500, f"Indexing failed: {e}")


@router.get("/index/status")
def index_status(project_id: str = Depends(get_current_project)):
    return embeddings.get_indexing_status(project_id)


@router.post("/search")
def search_endpoint(req: SearchRequest, project_id: str = Depends(get_current_project)):
    try:
        results = embeddings.search(
            project_id,
            req.query,
            top_k=req.top_k,
            min_score=req.min_score,
            context_budget=req.context_budget,
        )
        for r in results:
            if "error" in r:
                continue
            doc = db.query_one(
                "SELECT name FROM documents WHERE id = ? AND project_id = ?",
                (r.get("doc_id"), project_id)
            )
            r["docName"] = doc["name"] if doc else "Unknown"
        return {"results": results}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/status")
def status(project_id: str = Depends(get_current_project)):
    return {
        "ollama_reachable": ollama.check_connection(),
        "ollama_url": config.OLLAMA_URL,
        "embedding_model": config.OLLAMA_EMBEDDING_MODEL,
        "llm_model": config.OLLAMA_LLM_MODEL,
        "embedding_count": (db.query_one(
            "SELECT COUNT(*) as c FROM embeddings WHERE project_id = ?", (project_id,)
        ) or {}).get("c", 0),
    }


@router.post("/chat")
def chat_endpoint(req: ChatRequest, project_id: str = Depends(get_current_project)):
    """Streaming chat with retrieval (Server-Sent Events)."""
    def event_stream():
        try:
            search_results = embeddings.search(
                project_id,
                req.question,
                top_k=req.max_chunks,
                min_score=req.similarity_threshold,
                context_budget=req.context_budget,
            )
            if search_results and "error" in search_results[0]:
                yield f"data: {json.dumps({'type': 'error', 'message': search_results[0]['error']})}\n\n"
                return

            for r in search_results:
                doc = db.query_one(
                    "SELECT name, page_ids_json FROM documents WHERE id = ? AND project_id = ?",
                    (r.get("doc_id"), project_id)
                )
                r["docName"] = doc["name"] if doc else "Unknown"
                page_num = "?"
                if doc and doc.get("page_ids_json"):
                    try:
                        page_ids = json.loads(doc["page_ids_json"])
                        if r.get("page_id") in page_ids:
                            page_num = page_ids.index(r["page_id"]) + 1
                    except (ValueError, json.JSONDecodeError):
                        pass
                r["pageNum"] = page_num

            yield f"data: {json.dumps({'type': 'sources', 'data': search_results})}\n\n"

            if req.skip_llm:
                yield f"data: {json.dumps({'type': 'done', 'answer': '', 'skipped_llm': True})}\n\n"
                return

            context_text = "\n---\n".join(
                f"[{i+1}] Source: {r.get('docName')} (Page {r.get('pageNum')})\nText: {r.get('text', '')}"
                for i, r in enumerate(search_results)
            )
            history_text = ""
            if req.include_chat_history and req.chat_history:
                recent = req.chat_history[-6:]
                if recent:
                    history_text = "--- Recent Chat History ---\n"
                    for m in recent:
                        text = re.sub(r"<[^>]+>", "", m.get("html", "")).strip()
                        role = "User" if m.get("role") == "user" else "Assistant"
                        history_text += f"{role}: {text}\n\n"
                    history_text += "---------------------------\n\n"

            system_prompt = req.system_prompt
            if req.strict_rag:
                system_prompt += "\n\nSTRICT RAG INSTRUCTION: Answer ONLY using the provided Context. If the context does not contain the answer, reply exactly with: 'I don't know based on the provided context.' Do not use outside knowledge."

            if req.response_style == "Concise":
                system_prompt += "\n\nResponse Style Instruction: Be extremely concise and direct. Provide only the essential facts extracted from the context. Keep your response brief (2-3 sentences if possible) without unnecessary fluff or conversational filler."
            elif req.response_style == "Expert":
                system_prompt += "\n\nResponse Style Instruction: Answer as a domain expert. Use precise, technical, and professional language. Provide a nuanced, highly rigorous analysis based on the context. Assume the reader possesses advanced technical knowledge."
            else:
                system_prompt += "\n\nResponse Style Instruction: Provide a thorough, comprehensive, and detailed explanation. Break down the information clearly, step-by-step. Use formatting like bullet points or bold text if helpful to make the detailed answer highly readable."

            full_prompt = f"{system_prompt}\n\nContext:\n{context_text}\n\n{history_text}User Question: {req.question}\n\nAnswer:"

            full_answer = ""
            try:
                for token in ollama.generate_stream(full_prompt, model=req.model, temperature=req.temperature):
                    full_answer += token
                    yield f"data: {json.dumps({'type': 'token', 'text': token, 'full': full_answer})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'message': f'LLM error: {e}'})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'done', 'answer': full_answer, 'sources': search_results})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/embeddings/{doc_id}")
def list_embeddings(doc_id: str, project_id: str = Depends(get_current_project)):
    rows = db.query_all(
        "SELECT id, page_id, text FROM embeddings WHERE doc_id = ? AND project_id = ?",
        (doc_id, project_id)
    )
    return {"chunks": [{"id": r["id"], "pageId": r["page_id"], "text": r["text"]} for r in rows]}

"""
Ollama HTTP client. Wraps /api/embeddings and /api/generate so the rest of the
backend doesn't need to know about Ollama's wire protocol.
"""
import json
import urllib.request
import urllib.error
from typing import Optional, Iterator

from .. import config


def _post(url: str, payload: dict, timeout: int = None) -> dict:
    """Synchronous POST to Ollama (called from a thread-pool by FastAPI)."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    timeout = timeout or config.AI_REQUEST_TIMEOUT
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama HTTP {e.code}: {body}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cannot reach Ollama at {url}: {e.reason}") from None


def get_embedding(text: str, model: Optional[str] = None) -> list[float]:
    """Return a single embedding vector for the given text."""
    model = model or config.OLLAMA_EMBEDDING_MODEL
    payload = {"model": model, "prompt": text}
    url = f"{config.OLLAMA_URL}/api/embeddings"
    result = _post(url, payload)
    return result.get("embedding", [])


def generate(prompt: str, model: Optional[str] = None, temperature: float = 0.7) -> str:
    """Non-streaming generate — returns the full response string."""
    model = model or config.OLLAMA_LLM_MODEL
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature},
    }
    url = f"{config.OLLAMA_URL}/api/generate"
    result = _post(url, payload)
    return result.get("response", "")


def generate_stream(prompt: str, model: Optional[str] = None,
                    temperature: float = 0.7) -> Iterator[str]:
    """Streaming generate — yields response chunks as they arrive.

    Ollama emits one JSON object per line per token; we parse and yield
    the .response field of each line.
    """
    model = model or config.OLLAMA_LLM_MODEL
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "options": {"temperature": temperature},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{config.OLLAMA_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    timeout = config.AI_REQUEST_TIMEOUT
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        buffer = ""
        while True:
            chunk = resp.read(1024)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if "response" in obj and obj["response"]:
                        yield obj["response"]
                except json.JSONDecodeError:
                    continue
        # Drain any leftover buffer
        if buffer.strip():
            try:
                obj = json.loads(buffer.strip())
                if "response" in obj and obj["response"]:
                    yield obj["response"]
            except json.JSONDecodeError:
                pass


def check_connection() -> bool:
    """Quick check whether Ollama is reachable. Used by /api/ai/status."""
    try:
        url = f"{config.OLLAMA_URL}/api/tags"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=5):
            return True
    except Exception:
        return False

"""
Configuration loader for PDF Linker Studio server.
Reads server/config.ini (or config.ini.example as a fallback template).
"""
import os
import configparser
from pathlib import Path
from typing import Optional

# Resolve paths relative to this file, not the CWD — important because run.bat
# may be invoked from any directory.
BASE_DIR = Path(__file__).resolve().parent  # .../server/
PROJECT_ROOT = BASE_DIR.parent               # .../pdf-linker-studio-server/

CONFIG_PATH = BASE_DIR / "config.ini"
CONFIG_EXAMPLE_PATH = BASE_DIR / "config.ini.example"


def _load_config() -> configparser.ConfigParser:
    """Load config.ini, falling back to config.ini.example on first run."""
    cp = configparser.ConfigParser()
    if CONFIG_PATH.exists():
        cp.read(CONFIG_PATH, encoding="utf-8")
    elif CONFIG_EXAMPLE_PATH.exists():
        cp.read(CONFIG_EXAMPLE_PATH, encoding="utf-8")
    else:
        # Empty config — defaults will fill in.
        cp.read_string("")
    return cp


_cp = _load_config()


def _get(section: str, key: str, default: str) -> str:
    try:
        return _cp.get(section, key)
    except (configparser.NoSectionError, configparser.NoOptionError, KeyError):
        return default


def _get_int(section: str, key: str, default: int) -> int:
    try:
        return _cp.getint(section, key)
    except (configparser.NoSectionError, configparser.NoOptionError, ValueError, KeyError):
        return default


# ---- Server ----
HOST = _get("server", "host", "0.0.0.0")
PORT = _get_int("server", "port", 8000)
STATIC_DIR = _get("server", "static_dir", str(PROJECT_ROOT / "static"))
DATA_DIR = _get("server", "data_dir", str(PROJECT_ROOT / "data"))

# Resolve relative paths against the project root.
if not os.path.isabs(STATIC_DIR):
    STATIC_DIR = str((PROJECT_ROOT / STATIC_DIR).resolve())
if not os.path.isabs(DATA_DIR):
    DATA_DIR = str((PROJECT_ROOT / DATA_DIR).resolve())

# ---- Subdirectories inside data_dir ----
DB_PATH = os.path.join(DATA_DIR, "app.db")
PDF_DIR = os.path.join(DATA_DIR, "pdfs")
IMAGE_DIR = os.path.join(DATA_DIR, "images")
THUMBNAIL_DIR = os.path.join(DATA_DIR, "thumbnails")

# ---- Ollama ----
OLLAMA_URL = _get("ollama", "url", "http://localhost:11434").rstrip("/")
OLLAMA_EMBEDDING_MODEL = _get("ollama", "embedding_model", "nomic-embed-text")
OLLAMA_LLM_MODEL = _get("ollama", "llm_model", "gemma3:1b")

# ---- AI settings ----
AI_MAX_PAGES_PER_DOC = _get_int("ai", "max_pages_per_doc", 50)
AI_REQUEST_TIMEOUT = _get_int("ai", "request_timeout", 120)


def ensure_data_dirs():
    """Create the data directory tree on first run."""
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(PDF_DIR, exist_ok=True)
    os.makedirs(IMAGE_DIR, exist_ok=True)
    os.makedirs(THUMBNAIL_DIR, exist_ok=True)


def get_local_ip() -> Optional[str]:
    """Best-effort lookup of the LAN IP address (for printing access URLs)."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Connect to a public address without sending data — kernel picks the LAN iface.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None

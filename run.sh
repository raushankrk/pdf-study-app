#!/usr/bin/env bash
# Linux/macOS launcher (optional — primarily for Windows users, but kept for parity)
set -e
cd "$(dirname "$0")"

# Create venv on first run
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi

# Install deps on first run
if [ ! -f ".venv/.installed" ]; then
    .venv/bin/pip install --upgrade pip
    .venv/bin/pip install -r server/requirements.txt
    touch .venv/.installed
fi

# Copy config on first run
if [ ! -f "server/config.ini" ] && [ -f "server/config.ini.example" ]; then
    cp server/config.ini.example server/config.ini
fi

# Start server
exec .venv/bin/python -m uvicorn server.main:app --host 0.0.0.0 --port 8000

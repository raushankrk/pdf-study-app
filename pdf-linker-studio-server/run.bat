@echo off
REM ============================================================
REM   PDF Linker Studio — Windows launcher
REM   Run this file to start the FastAPI server.
REM   Then open http://localhost:8000 in your browser,
REM   or http://WINDOWS-PC-IP:8000 from another device on your LAN.
REM ============================================================

setlocal
cd /d "%~dp0"

REM --- Check Python is installed ---
where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] Python is not installed or not on PATH.
    echo Install Python 3.9+ from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

REM --- Create virtualenv on first run ---
if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment (first run only)...
    python -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

REM --- Install/upgrade dependencies on first run ---
if not exist ".venv\.installed" (
    echo Installing dependencies (first run only)...
    call ".venv\Scripts\python.exe" -m pip install --upgrade pip
    call ".venv\Scripts\python.exe" -m pip install -r server\requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo done > ".venv\.installed"
)

REM --- Copy config.ini.example to config.ini on first run ---
if not exist "server\config.ini" (
    if exist "server\config.ini.example" (
        copy "server\config.ini.example" "server\config.ini" >nul
        echo Created server\config.ini from config.ini.example.
        echo Edit it to change the port or Ollama URL.
    )
)

REM --- Start the server ---
echo.
echo Starting PDF Linker Studio server...
echo.
echo   Web UI:  http://localhost:8000
echo.
echo   To access from another device on your network (iPad, phone, etc.):
echo   Replace WINDOWS-PC-IP below with this PC's local IP address, then
echo   open this URL on the other device:
echo.
echo   http://WINDOWS-PC-IP:8000
echo.
echo   Press Ctrl+C in this window to stop the server.
echo.

".venv\Scripts\python.exe" -m uvicorn server.main:app --host 0.0.0.0 --port 8000

pause

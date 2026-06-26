@echo off
cd /d "%~dp0"
set "BUNDLED_PY=C:\Users\my computer\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%BUNDLED_PY%" (
  "%BUNDLED_PY%" -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
) else (
  python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
)

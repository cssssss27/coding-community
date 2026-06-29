@echo off
cd /d "%~dp0"

if "%CODING_COMMUNITY_PORT%"=="" set "CODING_COMMUNITY_PORT=8010"

echo Starting Coding Community FastAPI server...
echo Local URL: http://127.0.0.1:%CODING_COMMUNITY_PORT%/
echo Upload URL: http://127.0.0.1:%CODING_COMMUNITY_PORT%/upload.html
echo.

python -m uvicorn server:app --host 127.0.0.1 --port %CODING_COMMUNITY_PORT%

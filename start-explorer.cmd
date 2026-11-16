@echo off
setlocal
cd /d "%~dp0"

set "EXPLORER_PYTHON=python"
if exist ".venv\Scripts\python.exe" set "EXPLORER_PYTHON=.venv\Scripts\python.exe"

if not defined FIRMS_OUTPUT_DIR if not exist "backend\outputs\history.json" if not exist "backend\outputs\manifest.json" (
    if exist "backend\outputs\check-overlap\history.json" set "FIRMS_OUTPUT_DIR=backend\outputs\check-overlap"
)

set "EXPLORER_URL=http://127.0.0.1:8765"
"%EXPLORER_PYTHON%" -c "from urllib.request import urlopen; import os; assert b'analysis-date' in urlopen(os.environ['EXPLORER_URL'], timeout=1).read()" >nul 2>&1
if not errorlevel 1 (
    start "" "%EXPLORER_URL%/"
    exit /b
)

echo Hotspot Explorer will open at %EXPLORER_URL%/
echo Close this window or press Ctrl+C to stop the server.
start "" /b powershell.exe -NoProfile -NonInteractive -Command "$deadline = (Get-Date).AddSeconds(15); do { try { $spec = Invoke-RestMethod ($env:EXPLORER_URL + '/openapi.json') -TimeoutSec 1; if ($spec.info.title -eq 'NASA Hotspot Explorer') { Start-Process ($env:EXPLORER_URL + '/'); exit } } catch {} ; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $deadline)"
"%EXPLORER_PYTHON%" -m uvicorn backend.api:app --host 127.0.0.1 --port 8765
if errorlevel 1 pause

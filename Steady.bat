@echo off
rem Double-click to start Steady on Windows. Keep this window open while you read; close it to stop.
cd /d "%~dp0"

rem Already running? Just open it.
curl -s -o nul --max-time 1 http://localhost:41737/api/voices && (start "" http://localhost:41737 & exit /b 0)

rem uv may be installed but not yet on PATH in this window.
set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 (
  echo First start: installing uv, which runs Steady. This happens once.
  powershell -NoProfile -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
)
where uv >nul 2>nul
if errorlevel 1 (
  echo Could not install uv. Install it by hand with:  winget install --id=astral-sh.uv -e
  pause
  exit /b 1
)
echo Starting Steady. The first start downloads Python and its packages, a few minutes.

rem Keep the Windows environment apart from the Mac .venv, in case the folder is synced both ways.
set "UV_PROJECT_ENVIRONMENT=.venv-windows"
uv run app.py
pause

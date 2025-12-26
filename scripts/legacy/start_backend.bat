@echo off
echo ========================================================
echo WARNING: This script is for DEVELOPMENT/DEBUGGING only.
echo The official build procedure is 'tauri build'.
echo ========================================================
echo.
cd /d %~dp0\..\..
call .venv\Scripts\activate
cd backend
python server.py

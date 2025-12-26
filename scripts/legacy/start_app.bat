@echo off
echo ========================================================
echo WARNING: This script is for DEVELOPMENT/DEBUGGING only.
echo The official build procedure is 'tauri build'.
echo ========================================================
echo.
echo Starting Tepora App (Dev Mode)...
start "Tepora Backend" "%~dp0\start_backend.bat"
start "Tepora Frontend" "%~dp0\start_frontend.bat"
echo App started.

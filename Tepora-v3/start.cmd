@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Tepora V3 source edition needs Node.js 22.16 or later.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22 || a===22 && b<16)process.exit(1)"
if errorlevel 1 (
  echo Please update Node.js to version 22.16 or later.
  pause
  exit /b 1
)
node core/server.mjs --open
if errorlevel 1 pause

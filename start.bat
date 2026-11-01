@echo off
rem Keep the Windows entry point small; scripts/start.js installs for this platform.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20.19+ or 22.12+ from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)
node scripts\start.js
if errorlevel 1 pause

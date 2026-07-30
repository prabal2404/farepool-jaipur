@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the visual demo instead.
  echo Install Node.js LTS later to save pools using the backend.
  start "FarePool Demo" "%~dp0index.html"
  pause
  exit /b
)
start "FarePool" :http//localhost:3000
node server.js

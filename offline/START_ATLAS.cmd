@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Node runtime is missing. Extract the complete ZIP before starting Atlas.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0offline\server.cjs"
if errorlevel 1 pause

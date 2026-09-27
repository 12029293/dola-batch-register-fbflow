@echo off
rem DoubaoManager launcher (CRLF + ASCII only, cmd-safe)
rem Clear ELECTRON_RUN_AS_NODE: if set (VSCode/CI terminals), Electron degrades to pure Node
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] node_modules\electron\dist\electron.exe not found
  echo Run in this folder first:  npm install
  pause
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

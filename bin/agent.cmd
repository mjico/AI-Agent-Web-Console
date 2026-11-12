@echo off
set "WEB_BIN=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%WEB_BIN%ensure-console.ps1"
set "REAL=%LOCALAPPDATA%\cursor-agent\agent.cmd"
if not exist "%REAL%" (
  echo Cursor CLI not found: %REAL%
  exit /b 1
)
call "%REAL%" %*
exit /b %ERRORLEVEL%

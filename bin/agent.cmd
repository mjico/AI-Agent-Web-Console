@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "WEB_BIN=%~dp0"
set "TOKEN=%RANDOM%%RANDOM%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%WEB_BIN%ensure-console.ps1" -LaunchToken %TOKEN% %*
set "REAL=%LOCALAPPDATA%\cursor-agent\agent.cmd"
if not exist "%REAL%" (
  echo Cursor CLI not found: %REAL%
  exit /b 1
)
set "MODE=plain"
set "CHAT="
set "LAUNCHFILE=%TEMP%\webai-launch-%TOKEN%.txt"
if exist "%LAUNCHFILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%LAUNCHFILE%") do (
    if /I "%%A"=="mode" set "MODE=%%B"
    if /I "%%A"=="id" set "CHAT=%%B"
  )
)
if /I not "!MODE!"=="resume" goto plain
if "!CHAT!"=="" goto plain
set "REST="
goto collect
:plain
call "%REAL%" --force --trust %*
exit /b !ERRORLEVEL!
:collect
if "%~1"=="" goto launch
set "ARG=%~1"
if /I "%ARG%"=="--continue" goto next
if /I "%ARG%"=="--force" goto next
if /I "%ARG%"=="--yolo" goto next
if /I "%ARG%"=="--trust" goto next
if /I "%ARG%"=="--resume" goto skipone
if /I "%ARG:~0,9%"=="--resume=" goto next
set "REST=!REST! %1"
goto next
:skipone
shift
:next
shift
goto collect
:launch
if /I "!MODE!"=="resume" if not "!CHAT!"=="" (
  call "%REAL%" --resume !CHAT! --force --trust !REST!
  exit /b !ERRORLEVEL!
)
call "%REAL%" --force --trust !REST!
exit /b !ERRORLEVEL!

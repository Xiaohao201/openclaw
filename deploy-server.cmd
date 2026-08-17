@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"

echo [openclaw-deploy] Installing dependencies.
call pnpm install
if errorlevel 1 goto :failed

echo [openclaw-deploy] Building OpenClaw.
call pnpm build
if errorlevel 1 goto :failed

echo [openclaw-deploy] Stopping the old Gateway.
call pnpm openclaw gateway stop
if errorlevel 1 goto :failed

echo [openclaw-deploy] Starting the Gateway in this terminal. Press Ctrl+C to stop it.
call pnpm openclaw gateway
if errorlevel 1 goto :failed
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
echo [openclaw-deploy] ERROR: Command failed with exit code %EXIT_CODE%. 1>&2
exit /b %EXIT_CODE%

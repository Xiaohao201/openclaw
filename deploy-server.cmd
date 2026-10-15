@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"

echo [openclaw-deploy] Pulling origin/v1.
call git pull origin v1
if errorlevel 1 goto :failed

echo [openclaw-deploy] Installing dependencies.
call pnpm install
if errorlevel 1 goto :failed

echo [openclaw-deploy] Building OpenClaw.
call pnpm build
if errorlevel 1 goto :failed

echo [openclaw-deploy] Building the Control UI.
call pnpm ui:build
if errorlevel 1 goto :failed

echo [openclaw-deploy] Preparing the complaint Python runtime.
call python extensions\leading-v2\python\setup_runtime.py
if errorlevel 1 goto :failed

if exist "dist\extensions\leading-v2\openclaw.plugin.json" (
  call node extensions\leading-v2\stage-python.mjs dist\extensions\leading-v2
  if errorlevel 1 goto :failed
  call python extensions\leading-v2\python\setup_runtime.py --runtime-dir dist\extensions\leading-v2\python
  if errorlevel 1 goto :failed
)

if exist "dist-runtime\extensions\leading-v2\openclaw.plugin.json" (
  call node extensions\leading-v2\stage-python.mjs dist-runtime\extensions\leading-v2
  if errorlevel 1 goto :failed
  call python extensions\leading-v2\python\setup_runtime.py --runtime-dir dist-runtime\extensions\leading-v2\python
  if errorlevel 1 goto :failed
)

echo [openclaw-deploy] Restarting the Gateway.
call pnpm openclaw gateway restart
if errorlevel 1 goto :failed
exit /b 0

:failed
set "EXIT_CODE=%ERRORLEVEL%"
echo [openclaw-deploy] ERROR: Command failed with exit code %EXIT_CODE%. 1>&2
exit /b %EXIT_CODE%

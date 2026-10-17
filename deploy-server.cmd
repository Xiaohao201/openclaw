@echo off
setlocal
chcp 65001 >nul
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

echo [openclaw-deploy] Verifying native complaint assets.
call node extensions\leading-v2\check-runtime.mjs extensions\leading-v2
if errorlevel 1 goto :failed

if exist "dist\extensions\leading-v2\openclaw.plugin.json" (
  call node extensions\leading-v2\check-runtime.mjs dist\extensions\leading-v2
  if errorlevel 1 goto :failed
)

if exist "dist-runtime\extensions\leading-v2\openclaw.plugin.json" (
  call node extensions\leading-v2\check-runtime.mjs dist-runtime\extensions\leading-v2
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

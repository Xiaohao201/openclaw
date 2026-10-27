@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="prepare" goto :prepare
if /i "%~1"=="verify" goto :verify
if /i not "%~1"=="legacy-restart" goto :usage

echo [openclaw-deploy] WARNING: legacy-restart builds in place and interrupts the Gateway.

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

echo [openclaw-deploy] Restarting the Gateway.
call pnpm openclaw gateway restart
if errorlevel 1 goto :failed
exit /b 0

:prepare
if "%~2"=="" goto :usage
call pnpm deploy:prepare --output "%~2"
if errorlevel 1 goto :failed
exit /b 0

:verify
if "%~2"=="" goto :usage
call pnpm deploy:verify "%~2"
if errorlevel 1 goto :failed
exit /b 0

:usage
echo Usage: deploy-server.cmd prepare ^<new-release-directory^>
echo        deploy-server.cmd verify ^<release-directory^>
echo        deploy-server.cmd legacy-restart
echo Preparation builds committed HEAD outside this tree; it does not switch services.
exit /b 2

:failed
set "EXIT_CODE=%ERRORLEVEL%"
echo [openclaw-deploy] ERROR: Command failed with exit code %EXIT_CODE%. 1>&2
exit /b %EXIT_CODE%

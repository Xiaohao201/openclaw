@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\server-deploy.ps1" %*
exit /b %ERRORLEVEL%


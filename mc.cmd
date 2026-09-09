@echo off
set "SCRIPT_DIR=%~dp0"
if "%~1"=="login" goto login
node "%SCRIPT_DIR%mc_terminal.cjs" %*
exit /b 0

:login
node "%SCRIPT_DIR%mc_login.cjs" %2
exit /b 0
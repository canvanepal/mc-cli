@echo off
setlocal enabledelayedexpansion
title mc — one-click setup
echo.
echo  ==============================================
echo   mc  —  MonkeyCode terminal CLI  —  setup
echo  ==============================================
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [1/2] Node.js not found. Installing via winget...
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  echo  NOTE: restart this terminal after install, then run setup.cmd again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo  [1/2] Node.js OK: %NODE_VER%

rem ---------- 2. Smoke test ----------
echo  [2/2] Verifying...
node --check mc_terminal.cjs && node --check mc_login.cjs && node --check mc_check.cjs
if %errorlevel% neq 0 (
  echo  ERROR: syntax check failed — something is wrong with the scripts.
  pause
  exit /b 1
)

echo.
echo  ==============================================
echo   Setup complete! No npm packages needed.
echo.
echo   Next steps:
echo     mc login 1        sign in account 1  (paste cookie)
echo     mc login 2        sign in account 2  (repeat for each)
echo     mc check          verify all accounts
echo     mc                connect terminal
echo  ==============================================
echo.
pause
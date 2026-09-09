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
  echo  [1/3] Node.js not found. Installing via winget...
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  echo  NOTE: restart this terminal after install, then run setup.cmd again.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo  [1/3] Node.js OK: %NODE_VER%

rem ---------- 2. Playwright ----------
where npm >nul 2>nul
if %errorlevel% neq 0 (
  echo  [2/3] npm not found — reinstall Node.js (npm comes with it).
  pause
  exit /b 1
)
npm list -g playwright >nul 2>nul
if %errorlevel% neq 0 (
  echo  [2/3] Installing playwright globally...
  npm install -g playwright
  npx playwright install chromium
) else (
  echo  [2/3] Playwright already installed.
)

rem ---------- 3. Smoke test ----------
echo  [3/3] Verifying...
node --check mc_terminal.cjs && node --check mc_login.cjs && node --check mc_check.cjs
if %errorlevel% neq 0 (
  echo  ERROR: syntax check failed — something is wrong with the scripts.
  pause
  exit /b 1
)

echo.
echo  ==============================================
echo   Setup complete!
echo.
echo   Next steps:
echo     mc login 1        sign in account 1
echo     mc login 2        sign in account 2  (repeat for each)
echo     mc check          verify all accounts
echo     mc                connect terminal
echo  ==============================================
echo.
pause
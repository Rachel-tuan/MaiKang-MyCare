@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MyCare Launcher

REM ===================================================================
REM  IMPORTANT: keep this file PURE ASCII.
REM  cmd.exe mis-parses batch files that mix UTF-8 Chinese with
REM  parenthesised blocks - it can split a line in the middle of a
REM  multi-byte character and try to execute the rest of that line,
REM  printing "is not recognized as an internal or external command".
REM  All Chinese output therefore lives in scripts/launch.mjs.
REM ===================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found. Please install Node.js 22.13 or newer:
  echo          https://nodejs.org/
  echo.
  pause >nul
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo  [INFO] node_modules not found, running "npm install" first ...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERROR] "npm install" failed. Check your network and retry.
    echo.
    pause >nul
    exit /b 1
  )
)

node scripts\launch.mjs precheck
if errorlevel 1 goto :hold

start "MyCare Backend 3001" cmd /k "npm run dev:server"
start "MyCare Frontend 3000" cmd /k "npm run dev:web"

node scripts\launch.mjs waitready

:hold
pause >nul

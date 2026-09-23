@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MyCare Stop Services

REM ===================================================================
REM  IMPORTANT: keep this file PURE ASCII.
REM  cmd.exe mis-parses batch files that mix UTF-8 Chinese with
REM  parenthesised blocks. See the header of scripts/launch.mjs
REM  for the measurements behind this rule.
REM ===================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found, the stop helper cannot run.
  echo          Please end the node.exe processes via Task Manager.
  echo.
  pause >nul
  exit /b 1
)

node scripts\launch.mjs stop

pause >nul

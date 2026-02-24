@echo off
title Lyblics WoW Agent
cd /d "%~dp0"

echo.
echo   Starting Lyblics WoW Agent...
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   [ERREUR] Node.js non trouve. Installe-le depuis https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo   Installing dependencies...
    npm install --production
    echo.
)

:loop
:: Start the agent
node agent.js

:: If agent crashes, auto-restart after 5 seconds
echo.
echo   Agent stopped. Redemarrage dans 5 secondes...
timeout /t 5 /nobreak >nul
echo   Redemarrage...
echo.
goto loop

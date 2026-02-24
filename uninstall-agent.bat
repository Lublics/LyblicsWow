@echo off
echo.
echo   ======================================
echo     Lyblics WoW Agent - Desinstallation
echo   ======================================
echo.

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_NAME=LyblicsWowAgent.bat"

if exist "%STARTUP_DIR%\%SHORTCUT_NAME%" (
    del "%STARTUP_DIR%\%SHORTCUT_NAME%"
    echo   [OK] Agent retire du demarrage Windows.
) else (
    echo   Agent non installe dans le demarrage.
)

echo.
pause

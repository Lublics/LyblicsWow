@echo off
echo.
echo   ======================================
echo     Lyblics WoW Agent - Installation
echo   ======================================
echo.

:: Get the script directory
set "AGENT_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_NAME=LyblicsWowAgent.bat"

:: Create a startup script that runs minimized
echo @echo off > "%STARTUP_DIR%\%SHORTCUT_NAME%"
echo start /min "" cmd /c "cd /d "%AGENT_DIR%" ^&^& node agent.js" >> "%STARTUP_DIR%\%SHORTCUT_NAME%"

echo   [OK] Agent ajoute au demarrage Windows !
echo.
echo   Fichier: %STARTUP_DIR%\%SHORTCUT_NAME%
echo.
echo   L'agent demarrera automatiquement au prochain login.
echo   Pour le lancer maintenant: start-agent.bat
echo.
echo   Pour desinstaller: supprimer le fichier dans le dossier Startup
echo   ou lancer uninstall-agent.bat
echo.
pause

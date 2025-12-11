@echo off
echo Starting Discord Bot...

REM Wechsle zum Projekt-Root (zwei Ordner über scripts/)
cd /d "%~dp0\..\.."

REM Prüfen ob Node.js installiert ist
node --version >nul 2>&1
if errorlevel 1 (
    echo FEHLER: Node.js ist nicht installiert oder nicht im PATH!
    echo Bitte installieren Sie Node.js von https://nodejs.org/
    pause
    exit /b 1
)

REM Prüfen ob package.json existiert
if not exist "package.json" (
    echo FEHLER: package.json nicht gefunden!
    echo Sind Sie im richtigen Verzeichnis?
    pause
    exit /b 1
)

REM Abhängigkeiten installieren falls node_modules nicht existiert
if not exist "node_modules" (
    echo Installiere Dependencies...
    npm install
)

REM Bot starten
echo Starte Discord Bot...
node app\src\bot\index.js

REM Bei Fehler Fenster offen lassen
if errorlevel 1 (
    echo Bot wurde mit Fehler beendet. Code: %errorlevel%
    pause
)

@echo off
rem Start the HRM Raw RR dashboard from the local .venv (run install.bat first).
rem All options are passed to app.py, e.g. run.bat --demo
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo error: .venv not found - run install.bat first
    pause
    exit /b 1
)
".venv\Scripts\python.exe" app.py %*

@echo off
rem HRM Raw RR dashboard - Windows installer (double-click friendly).
rem Runs install.ps1 without changing the system-wide PowerShell execution policy.
rem   install.bat          install
rem   install.bat -Force   recreate .venv from scratch
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%

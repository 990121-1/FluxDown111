@echo off
setlocal
cd /d "%~dp0"
title FluxDown One-Click Installer

echo.
echo ==============================================
echo  FluxDown one-click build / install
echo ==============================================
echo.
echo Repository:
echo   %CD%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo [ERROR] FluxDown installation failed. Exit code: %EXITCODE%
    echo.
    echo Do not paste install-windows.ps1 into a PowerShell window.
    echo Run this INSTALL.cmd file directly from the cloned repository.
    echo.
    pause
    exit /b %EXITCODE%
)

echo [OK] FluxDown installation completed.
echo.
pause
exit /b 0

@echo off
title MODOROClaw - Soft Reset
echo.
echo   SOFT RESET (xoa config, giu plugin + binary)
echo   =============================================
echo.

:: Kill processes
taskkill /f /im electron.exe 2>nul
timeout /t 2 /nobreak >nul

:: Chi xoa config, giu plugin
echo   Xoa OpenClaw config (giu plugin)...
if exist "%USERPROFILE%\.openclaw\openclaw.json" del "%USERPROFILE%\.openclaw\openclaw.json"
if exist "%USERPROFILE%\.openclaw\openclaw.json.bak" del "%USERPROFILE%\.openclaw\openclaw.json.bak"

:: Xoa 9Router config (giu binary)
echo   Xoa 9Router config...
if exist "%APPDATA%\9router\db.json" del "%APPDATA%\9router\db.json"

:: Xoa Zalo session
echo   Xoa Zalo session...
if exist "%USERPROFILE%\.openzca\profiles\default\credentials.json" del "%USERPROFILE%\.openzca\profiles\default\credentials.json"

:: Xoa logs
echo   Xoa logs...
if exist "%~dp0logs" rmdir /s /q "%~dp0logs"

echo.
echo   Done! Config da xoa, plugin van con.
echo   Chay RUN.bat de setup lai.
echo.
pause

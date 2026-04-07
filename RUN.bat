@echo off
title MODOROClaw
cd /d "%~dp0electron"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js chua cai. Dang tai va cai dat...
    powershell -ExecutionPolicy Bypass -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi' -OutFile '%TEMP%\node_install.msi' }"
    if exist "%TEMP%\node_install.msi" (
        msiexec /i "%TEMP%\node_install.msi" /qn
        del "%TEMP%\node_install.msi"
        set "PATH=%PATH%;C:\Program Files\nodejs"
    ) else (
        echo Khong tai duoc. Cai Node.js tai https://nodejs.org roi chay lai.
        pause
        exit /b 1
    )
)

if not exist "node_modules" (
    echo Dang cai dat lan dau, vui long doi...
    call npm install 2>nul
)

:: Clear old logs
if exist "%~dp0logs\openclaw.log" del "%~dp0logs\openclaw.log"

:: Start 9Router hidden (no CMD window)
where 9router >nul 2>&1
if %errorlevel% equ 0 (
    if exist "%APPDATA%\npm\node_modules\9router\cli.js" (
        start /B node "%APPDATA%\npm\node_modules\9router\cli.js" -n --skip-update >nul 2>&1
    ) else (
        start /B 9router -n --skip-update >nul 2>&1
    )
)

:: Start Gateway hidden (pre-warm while Electron loads)
where openclaw >nul 2>&1
if %errorlevel% equ 0 (
    curl -s http://127.0.0.1:18789 >nul 2>&1
    if %errorlevel% neq 0 (
        start /B openclaw gateway run >nul 2>&1
    )
)

:: Launch Electron immediately (shows UI while services warm up)
call node_modules\.bin\electron .

echo.
echo === App da dong ===
if exist "%~dp0logs\openclaw.log" (
    powershell -Command "Get-Content '%~dp0logs\openclaw.log' -Tail 20"
)
pause

@echo off
title MODOROClaw
cd /d "%~dp0electron"

:: CRITICAL: openzca requires Node >= 22.13.0 (openzca built with tsup --target node22).
:: Node 20 LTS is too old — openzca will throw syntax errors at runtime.
:: If the user already has Node installed, check its major version.
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=1 delims=v." %%i in ('node -v 2^>nul') do set "NODE_MAJOR=%%j"
    :: NODE_MAJOR will be set to "22" for v22.x
    if "%NODE_MAJOR%"=="" (
        set NEED_NODE_INSTALL=1
    ) else if %NODE_MAJOR% LSS 22 (
        echo Node.js v%NODE_MAJOR% qua cu. Can Node 22+ cho openzca.
        set NEED_NODE_INSTALL=1
    ) else (
        set NEED_NODE_INSTALL=0
    )
) else (
    set NEED_NODE_INSTALL=1
)

if "%NEED_NODE_INSTALL%"=="1" (
    echo Dang tai va cai dat Node.js 22 LTS...
    powershell -ExecutionPolicy Bypass -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi' -OutFile '%TEMP%\node_install.msi' }"
    if exist "%TEMP%\node_install.msi" (
        msiexec /i "%TEMP%\node_install.msi" /qn
        del "%TEMP%\node_install.msi"
        set "PATH=%PATH%;C:\Program Files\nodejs"
    ) else (
        echo Khong tai duoc Node 22. Cai Node 22+ tai https://nodejs.org roi chay lai.
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

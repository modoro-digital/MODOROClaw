@echo off
title MODOROClaw - Full Reset
echo.
echo   FULL RESET (mo phong may hoan toan moi)
echo   ========================================
echo.

:: Stop gateway properly first
echo   Dang gateway...
call openclaw gateway stop 2>nul

:: Kill processes
taskkill /f /im electron.exe 2>nul
taskkill /f /im openclaw.exe 2>nul
taskkill /f /im node.exe 2>nul
timeout /t 2 /nobreak >nul

:: Xoa OpenClaw + 9Router
echo   Xoa OpenClaw + 9Router...
call npm uninstall -g openclaw 2>nul
call npm uninstall -g 9router 2>nul
if exist "%APPDATA%\npm\openclaw.cmd" del "%APPDATA%\npm\openclaw.cmd"
if exist "%APPDATA%\npm\openclaw" del "%APPDATA%\npm\openclaw"
if exist "%APPDATA%\npm\9router.cmd" del "%APPDATA%\npm\9router.cmd"
if exist "%APPDATA%\npm\9router" del "%APPDATA%\npm\9router"

:: Xoa OpenClaw data
echo   Xoa OpenClaw config + data...
if exist "%USERPROFILE%\.openclaw" rmdir /s /q "%USERPROFILE%\.openclaw"

:: Xoa 9Router data (providers, combos, keys)
echo   Xoa 9Router config...
if exist "%APPDATA%\9router" rmdir /s /q "%APPDATA%\9router"

:: Xoa legacy cron files (tu phien ban cu - truoc khi chuyen vao workspace)
echo   Xoa legacy schedule files...
if exist "%APPDATA%\claw-schedules.json" del "%APPDATA%\claw-schedules.json"
if exist "%APPDATA%\MODOROClaw" rmdir /s /q "%APPDATA%\MODOROClaw"

:: Xoa openzca data (Zalo session)
echo   Xoa Zalo session...
if exist "%USERPROFILE%\.openzca" rmdir /s /q "%USERPROFILE%\.openzca"

:: Xoa app logs
echo   Xoa logs...
if exist "%~dp0logs" rmdir /s /q "%~dp0logs"
if exist "%~dp0electron\logs" rmdir /s /q "%~dp0electron\logs"

:: Xoa runtime files — seedWorkspace() se tao lai defaults khi app chay
echo   Xoa runtime files (schedules.json, custom-crons.json, zalo-blocklist.json)...
if exist "%~dp0schedules.json" del "%~dp0schedules.json"
if exist "%~dp0custom-crons.json" del "%~dp0custom-crons.json"
if exist "%~dp0zalo-blocklist.json" del "%~dp0zalo-blocklist.json"

:: Xoa memory hang ngay va session data (nhung giu bo nho co cau truc nhu people/, projects/)
echo   Xoa daily memory + sessions...
if exist "%~dp0memory" for %%f in ("%~dp0memory\20*.md") do del "%%f" 2>nul
if exist "%~dp0memory\heartbeat-state.json" del "%~dp0memory\heartbeat-state.json"

:: Xoa active.md da personalize (wizard se tao lai)
echo   Xoa personalization (active.md)...
if exist "%~dp0skills\active.md" del "%~dp0skills\active.md"
if exist "%~dp0industry\active.md" del "%~dp0industry\active.md"
if exist "%~dp0prompts\sop\active.md" del "%~dp0prompts\sop\active.md"
if exist "%~dp0prompts\training\active.md" del "%~dp0prompts\training\active.md"

:: Xoa config runtime (zalo mode, v.v.)
if exist "%~dp0config\zalo-mode.txt" del "%~dp0config\zalo-mode.txt"

:: Xoa Knowledge tab DB (memory.db) + uploaded files - re-seeded by seedWorkspace()
echo   Xoa Knowledge DB + uploaded files...
if exist "%~dp0memory.db" del "%~dp0memory.db"
if exist "%~dp0knowledge\cong-ty\files" rmdir /s /q "%~dp0knowledge\cong-ty\files"
if exist "%~dp0knowledge\san-pham\files" rmdir /s /q "%~dp0knowledge\san-pham\files"
if exist "%~dp0knowledge\nhan-vien\files" rmdir /s /q "%~dp0knowledge\nhan-vien\files"
if exist "%~dp0knowledge\cong-ty\index.md" del "%~dp0knowledge\cong-ty\index.md"
if exist "%~dp0knowledge\san-pham\index.md" del "%~dp0knowledge\san-pham\index.md"
if exist "%~dp0knowledge\nhan-vien\index.md" del "%~dp0knowledge\nhan-vien\index.md"

:: Xoa better-sqlite3 native binary - postinstall script will re-fetch the
:: prebuilt that matches the bundled Electron's NODE_MODULE_VERSION on next
:: `npm install`. Without this, an old binary compiled for a different
:: Node/Electron ABI may persist across resets and silently break Knowledge.
echo   Xoa better-sqlite3 binary (postinstall se tai lai dung ABI)...
if exist "%~dp0electron\node_modules\better-sqlite3\build" rmdir /s /q "%~dp0electron\node_modules\better-sqlite3\build"

:: Force RUN.bat to trigger npm install (which fires postinstall fix-better-sqlite3.js).
:: We don't wipe the whole node_modules because that's slow (~5 min). Instead, mark
:: a sentinel that RUN.bat checks; OR just rely on RUN.bat's `if not exist node_modules`
:: check. Since we kept node_modules, we run npm install ourselves to fire postinstall.
echo   Re-run npm install in electron/ to fire postinstall (fix-better-sqlite3)...
pushd "%~dp0electron"
call npm install --silent 2>nul
popd

echo.
echo   Done! May sach nhu moi.
echo   Chay RUN.bat de test tu dau.
echo.
pause

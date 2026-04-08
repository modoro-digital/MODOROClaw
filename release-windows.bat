@echo off
setlocal enabledelayedexpansion
title MODOROClaw - Release Windows EXE to MODOROClaw-Setup

echo.
echo   ====================================================
echo     MODOROClaw - Build + Release Windows installer
echo   ====================================================
echo.

:: ================================================================
::  Config
:: ================================================================
set SETUP_REPO_URL=https://github.com/modoro-digital/MODOROClaw-Setup.git
set SETUP_REPO_DIR=%~dp0..\MODOROClaw-Setup
set BRANCH=main
set ELECTRON_DIR=%~dp0electron
set DIST_DIR=%~dp0dist
set VERSION=

:: Read version from electron/package.json
for /f "usebackq tokens=2 delims=:," %%i in (`findstr /c:"\"version\"" "%ELECTRON_DIR%\package.json"`) do (
    set VERSION=%%i
    set VERSION=!VERSION:"=!
    set VERSION=!VERSION: =!
)
if "%VERSION%"=="" (
    echo X Khong doc duoc version tu electron/package.json
    pause
    exit /b 1
)
echo   Version: %VERSION%
echo   Setup repo: %SETUP_REPO_URL%
echo.

:: ================================================================
::  Pre-checks
:: ================================================================
where git >nul 2>nul
if errorlevel 1 (
    echo X git khong cai. Tai tu https://git-scm.com/download/win
    pause
    exit /b 1
)

:: ================================================================
::  STEP 1 — Build Windows installer (electron-builder --win)
:: ================================================================
echo.
echo   [1/4] Building Windows installer (electron-builder --win)...
echo   This may take 3-5 minutes for the first build.
echo.

cd /d "%ELECTRON_DIR%"
call npx electron-builder --win
if errorlevel 1 (
    echo.
    echo X electron-builder failed. Check the error above.
    pause
    exit /b 1
)

:: Verify the installer was produced
set EXE_PATH=
for %%f in ("%DIST_DIR%\MODOROClaw Setup %VERSION%.exe") do set EXE_PATH=%%~ff
if not exist "!EXE_PATH!" (
    :: Fallback: any .exe in dist/
    for %%f in ("%DIST_DIR%\*.exe") do (
        if not defined EXE_PATH set EXE_PATH=%%~ff
    )
)
if not exist "!EXE_PATH!" (
    echo.
    echo X Khong tim thay file .exe trong %DIST_DIR%\
    dir "%DIST_DIR%"
    pause
    exit /b 1
)
echo.
echo   [OK] Built: !EXE_PATH!
for %%f in ("!EXE_PATH!") do echo   Size: %%~zf bytes
echo.

:: ================================================================
::  STEP 2 — Clone or update MODOROClaw-Setup repo locally
:: ================================================================
echo.
echo   [2/4] Preparing MODOROClaw-Setup repo at %SETUP_REPO_DIR%...

if not exist "%SETUP_REPO_DIR%" (
    echo   Clone fresh from %SETUP_REPO_URL% ...
    git clone "%SETUP_REPO_URL%" "%SETUP_REPO_DIR%" || (
        echo X Clone failed. Kiem tra:
        echo     - Repo URL co dung khong: %SETUP_REPO_URL%
        echo     - Anh co quyen push vao repo nay khong ^(GitHub token^)
        pause
        exit /b 1
    )
) else (
    echo   Repo already exists. Pulling latest...
    cd /d "%SETUP_REPO_DIR%"
    git fetch origin %BRANCH% 2>nul
    git checkout %BRANCH% 2>nul
    git pull --rebase origin %BRANCH% 2>nul || echo   ^(pull skipped^)
)

:: ================================================================
::  STEP 3 — Copy installer into the Setup repo
:: ================================================================
echo.
echo   [3/4] Copying installer into Setup repo...

cd /d "%SETUP_REPO_DIR%"
if not exist "windows" mkdir "windows"

:: Copy with version-stamped name + a stable "latest" alias
copy /Y "!EXE_PATH!" "windows\MODOROClaw-Setup-%VERSION%.exe" >nul
copy /Y "!EXE_PATH!" "windows\MODOROClaw-Setup-latest.exe" >nul

:: Write/update a small README in the windows/ folder so users see install instructions
> "windows\README.md" echo # MODOROClaw — Windows installer
>> "windows\README.md" echo.
>> "windows\README.md" echo Phien ban moi nhat: **%VERSION%**
>> "windows\README.md" echo.
>> "windows\README.md" echo ## Cach cai
>> "windows\README.md" echo.
>> "windows\README.md" echo 1. Tai file `MODOROClaw-Setup-latest.exe` ben canh
>> "windows\README.md" echo 2. Double-click de cai. Windows Defender co the canh bao ^(unsigned installer^) — bam **More info -^> Run anyway**.
>> "windows\README.md" echo 3. Sau khi cai xong, MODOROClaw mo ra. Lan dau se chay wizard de:
>> "windows\README.md" echo    - Cau hinh Telegram bot token
>> "windows\README.md" echo    - Login Zalo qua QR
>> "windows\README.md" echo    - Cai dat OpenClaw + 9Router + openzca ^(can Internet^)
>> "windows\README.md" echo.
>> "windows\README.md" echo ## Yeu cau
>> "windows\README.md" echo.
>> "windows\README.md" echo - Windows 10 / 11 64-bit
>> "windows\README.md" echo - Internet ^(lan dau setup wizard^)

echo   [OK] Copied to %SETUP_REPO_DIR%\windows\

:: ================================================================
::  STEP 4 — Commit + push
:: ================================================================
echo.
echo   [4/4] Commit + push to GitHub...

git add windows/
git commit -m "Release Windows installer v%VERSION%" || echo   ^(no changes to commit^)
git push origin %BRANCH% || (
    echo.
    echo X Push failed. Co the do:
    echo     - Anh chua dang nhap GitHub: chay 'gh auth login' hoac setup credential helper
    echo     - File qua lon cho git plain ^(^>100MB^): can dung GitHub Releases ^(xem ghi chu cuoi^)
    echo     - Khong co quyen push vao modoro-digital/MODOROClaw-Setup
    pause
    exit /b 1
)

echo.
echo   ==============================================
echo   DONE! Push xong release v%VERSION% len:
echo     %SETUP_REPO_URL%
echo.
echo   User co the tai installer tu:
echo     https://github.com/modoro-digital/MODOROClaw-Setup/blob/main/windows/MODOROClaw-Setup-latest.exe
echo   ^(bam "Download" o goc tren ben phai^)
echo.
echo   ==============================================
echo.

:: ================================================================
::  IMPORTANT NOTE about file size
:: ================================================================
echo.
echo   GHI CHU: NSIS installer thuong ~150 MB. GitHub free han 100MB / file
echo   trong git history. Neu push fail vi qua kich thuoc:
echo.
echo     1. Cai 'gh' CLI: https://cli.github.com
echo     2. Dung GitHub Releases (khong commit binary vao git tree):
echo        gh release create v%VERSION% "%EXE_PATH%" \
echo          --repo modoro-digital/MODOROClaw-Setup \
echo          --title "MODOROClaw v%VERSION%" \
echo          --notes "Windows installer for MODOROClaw v%VERSION%"
echo.

pause

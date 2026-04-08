@echo off
setlocal enabledelayedexpansion
title MODOROClaw - Push to GitHub (Mac repo)

echo.
echo   ====================================================
echo     MODOROClaw - Push source to GitHub for Mac build
echo   ====================================================
echo.

:: Doi URL nay neu repo o account khac (huybt-peter, modoro-digital, v.v.)
set REPO_URL=https://github.com/modoro-digital/MODOROClaw.git
set BRANCH=main

cd /d "%~dp0"

:: Check git
where git >nul 2>nul
if errorlevel 1 (
    echo   X git khong cai. Tai tu https://git-scm.com/download/win
    pause
    exit /b 1
)

:: First-time init
if not exist ".git" (
    echo   [init] Khoi tao git repo lan dau...
    git init -b %BRANCH% || ( echo X git init failed & pause & exit /b 1 )
    git remote add origin %REPO_URL% || ( echo X git remote add failed & pause & exit /b 1 )
)

:: Make sure remote is correct
for /f "delims=" %%i in ('git remote get-url origin 2^>nul') do set CURRENT_REMOTE=%%i
if not "%CURRENT_REMOTE%"=="%REPO_URL%" (
    echo   [remote] Sua remote origin -^> %REPO_URL%
    git remote set-url origin %REPO_URL%
)

:: Show what will be pushed
echo.
echo   [status] Cac file se push:
git add -A
git status --short
echo.

:: Get commit message from user
set /p MSG="  Commit message (Enter de dung mac dinh): "
if "%MSG%"=="" set MSG=Sync source for Mac build

git commit -m "%MSG%" || echo   (Khong co thay doi de commit)

echo.
echo   [push] Day code len GitHub...
git push -u origin %BRANCH%
if errorlevel 1 (
    echo.
    echo   X Push that bai. Co the do:
    echo     - Branch %BRANCH% chua ton tai tren remote: thu git push --force-with-lease
    echo     - Login chua dung: dung Personal Access Token thay password
    echo       https://github.com/settings/tokens
    pause
    exit /b 1
)

echo.
echo   ===================================================
echo     OK! Code da push len:
echo     %REPO_URL%
echo.
echo     De build .dmg, tao tag va push:
echo       git tag v1.0.0
echo       git push --tags
echo.
echo     GitHub Actions se tu build .dmg trong ~8-10 phut.
echo     Vao: https://github.com/modoro-digital/MODOROClaw/actions
echo     Khi xong, file .dmg se o GitHub Releases:
echo     https://github.com/modoro-digital/MODOROClaw/releases
echo   ===================================================
echo.
pause

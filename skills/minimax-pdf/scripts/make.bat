@echo off
REM make.bat — minimax-pdf Windows launcher
REM Usage: make.bat check
REM        make.bat fix
REM        make.bat run --title "Title" --type report --out output.pdf

setlocal enabledelayedexpansion

set "PY=python"
set "NODE=node"
set "SCRIPTS=%~dp0"

if "%1"=="" (
    echo Usage: make.bat ^<command^> [options]
    echo Commands: check, fix, run, fill, reformat, demo
    exit /b 1
)

REM — check —
if "%1"=="check" (
    echo Checking dependencies...

    !PY! --version >nul 2>&1
    if errorlevel 1 (
        echo   [X] python3 not found
        set "OK=false"
    ) else (
        echo   [OK] python !PY!
    )

    !PY! -c "import reportlab" >nul 2>&1
    if errorlevel 1 (
        echo   [W] reportlab not installed — run: make.bat fix
    ) else (
        echo   [OK] reportlab
    )

    !PY! -c "import pypdf" >nul 2>&1
    if errorlevel 1 (
        echo   [W] pypdf not installed — run: make.bat fix
    ) else (
        echo   [OK] pypdf
    )

    !NODE! --version >nul 2>&1
    if errorlevel 1 (
        echo   [X] node not found
        set "OK=false"
    ) else (
        echo   [OK] node
    )

    exit /b 0
)

REM — fix —
if "%1"=="fix" (
    echo Installing Python packages...
    !PY! -m pip install -q reportlab pypdf matplotlib
    if errorlevel 1 (
        echo   [W] pip install failed — try: pip install reportlab pypdf matplotlib
        exit /b 3
    )
    echo   [OK] Python packages installed
    echo.
    echo Vietnamese font will be downloaded automatically on first render_body.py run.
    exit /b 0
)

REM — demo —
if "%1"=="demo" (
    !PY! "%SCRIPTS%palette.py" --title "minimax-pdf demo" --type report --author "minimax-pdf" --date "May 2026" --out "%TEMP%\mp_demo_tokens.json"
    !PY! "%SCRIPTS%cover.py" --tokens "%TEMP%\mp_demo_tokens.json" --out "%TEMP%\mp_demo_cover.html"
    !NODE! "%SCRIPTS%render_cover.js" --input "%TEMP%\mp_demo_cover.html" --out "%TEMP%\mp_demo_cover.pdf"
    echo Body rendering requires --content flag. Run: make.bat run --title T --type TYPE --out out.pdf --content content.json
    exit /b 0
)

REM — run — forward all args
if "%1"=="run" (
    set "CMD=!PY! "%SCRIPTS%render_body.py""
    shift
    :loop
    if "%1"=="" goto done
    set "CMD=!CMD! %1"
    shift
    goto :loop
    :done
    echo Forwarding to render_body.py...
    echo !CMD!
    !PY! "%SCRIPTS%render_body.py" %2 %3 %4 %5 %6 %7 %8 %9 %10 %11 %12 %13 %14 %15 %16
    exit /b 0
)

echo Unknown command: %1
exit /b 1

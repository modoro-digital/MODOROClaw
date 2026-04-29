@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Clean-installed 9BizClaw/MODOROClaw on Windows.
rem This removes installed app files, app runtime data, OpenClaw/OpenZCA profile
rem data, updater cache, shortcuts, and uninstall registry entries.
rem It does NOT delete this source repo.

set "AUTO_YES="
if /I "%~1"=="/y" set "AUTO_YES=1"
if /I "%~1"=="-y" set "AUTO_YES=1"

echo.
echo 9BizClaw Windows clean uninstall
echo =================================
echo This will delete:
echo   %APPDATA%\9bizclaw
echo   %APPDATA%\MODOROClaw
echo   %APPDATA%\modoro-claw
echo   %LOCALAPPDATA%\Programs\9BizClaw
echo   %LOCALAPPDATA%\Programs\MODOROClaw
echo   %LOCALAPPDATA%\9bizclaw-updater
echo   %LOCALAPPDATA%\modoro-claw-updater
echo   %USERPROFILE%\.openclaw
echo   %USERPROFILE%\.openclaw-test
echo   %USERPROFILE%\.openzca
echo.
echo It will also stop related 9BizClaw/OpenClaw/OpenZCA/9Router processes.
echo.

if not defined AUTO_YES (
  set /P "CONFIRM=Type CLEAN then press Enter to continue: "
  if /I not "!CONFIRM!"=="CLEAN" (
    echo Aborted.
    exit /B 1
  )
)

echo.
echo [1/5] Stopping related processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$match='AppData\\Roaming\\9bizclaw|AppData\\Local\\Programs\\9BizClaw|AppData\\Local\\Programs\\MODOROClaw|\\.openclaw|\\.openzca|vendor\\node_modules\\(openclaw|openzca|9router)|9bizclaw|MODOROClaw';" ^
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('9BizClaw.exe','MODOROClaw.exe','node.exe','openclaw.exe','openzca.exe','9router.exe','electron.exe')) -and ($_.CommandLine -match $match) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Host ('  stopped PID ' + $_.ProcessId + ' ' + $_.Name) } catch {} }"

timeout /T 2 /NOBREAK >NUL

echo.
echo [2/5] Removing installed app and user data...
call :RemoveDir "%APPDATA%\9bizclaw"
call :RemoveDir "%APPDATA%\MODOROClaw"
call :RemoveDir "%APPDATA%\modoro-claw"
call :RemoveDir "%LOCALAPPDATA%\Programs\9BizClaw"
call :RemoveDir "%LOCALAPPDATA%\Programs\MODOROClaw"
call :RemoveDir "%LOCALAPPDATA%\9bizclaw-updater"
call :RemoveDir "%LOCALAPPDATA%\modoro-claw-updater"
call :RemoveDir "%USERPROFILE%\.openclaw"
call :RemoveDir "%USERPROFILE%\.openclaw-test"
call :RemoveDir "%USERPROFILE%\.openzca"

echo.
echo [3/5] Removing shortcuts...
call :RemoveFile "%USERPROFILE%\Desktop\9BizClaw.lnk"
call :RemoveFile "%USERPROFILE%\Desktop\MODOROClaw.lnk"
call :RemoveFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\9BizClaw.lnk"
call :RemoveFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\MODOROClaw.lnk"
call :RemoveDir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\9BizClaw"
call :RemoveDir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\MODOROClaw"

echo.
echo [4/5] Removing registry uninstall entries...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$roots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall');" ^
  "foreach($root in $roots){ if(Test-Path $root){ Get-ChildItem $root | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if(($p.DisplayName -match '9BizClaw|MODOROClaw|MODORO.*Claw') -or ($_.PSChildName -match '9BizClaw|MODOROClaw|vn\.9biz\.claw')){ try { Remove-Item $_.PSPath -Recurse -Force; Write-Host ('  removed ' + $_.PSChildName) } catch {} } } } };" ^
  "foreach($k in @('HKCU:\Software\9BizClaw','HKCU:\Software\MODOROClaw','HKCU:\Software\vn.9biz.claw')){ if(Test-Path $k){ try { Remove-Item $k -Recurse -Force; Write-Host ('  removed ' + $k) } catch {} } }"

echo.
echo [5/5] Removing temp leftovers...
call :RemoveDir "%TEMP%\9bizclaw"
call :RemoveDir "%TEMP%\MODOROClaw"
call :RemoveDir "%TEMP%\modoro-claw"
call :RemoveDir "%TEMP%\openclaw"
call :RemoveDir "%TEMP%\openzca"

echo.
echo Done. Reboot Windows before reinstalling if any process/file was locked.
exit /B 0

:RemoveDir
if exist "%~1" (
  echo   deleting "%~1"
  rmdir /S /Q "%~1" 2>NUL
  if exist "%~1" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath '%~1' -Recurse -Force -ErrorAction SilentlyContinue"
  )
) else (
  echo   skip "%~1"
)
exit /B 0

:RemoveFile
if exist "%~1" (
  echo   deleting "%~1"
  del /F /Q "%~1" 2>NUL
) else (
  echo   skip "%~1"
)
exit /B 0

@echo off
setlocal DisableDelayedExpansion
rem Installs iq-code@iq-routing; hidden key input and stdin-only configure are handled by install.ps1.
rem Standalone CMD entry point: it downloads the HTTPS copy of install.ps1 and runs that.
set "iq_args="
:options
if "%~1"=="" goto ready
if /I "%~1"=="--uninstall" goto uninstall
if /I "%~1"=="-Uninstall" goto uninstall
if /I "%~1"=="--purge" goto purge
if /I "%~1"=="-Purge" goto purge
if /I "%~1"=="--help" goto help
if /I "%~1"=="-Help" goto help
echo install.cmd: unknown option 1>&2
exit /b 2
:uninstall
set "iq_args=%iq_args% -Uninstall"
shift
goto options
:purge
set "iq_args=%iq_args% -Purge"
shift
goto options
:help
echo Usage: install.cmd [--uninstall [--purge]]
exit /b 0
:ready
if not defined HOME if not defined USERPROFILE (
  echo install.cmd: HOME and USERPROFILE are unset; no files were changed 1>&2
  exit /b 1
)
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo install.cmd: Windows PowerShell is required 1>&2
  exit /b 1
)
if not defined TEMP (
  echo install.cmd: TEMP is unset 1>&2
  exit /b 1
)
set "iq_temp=%TEMP%\iq-install-%RANDOM%-%RANDOM%"
if exist "%iq_temp%" (
  echo install.cmd: temporary directory already exists; retry 1>&2
  exit /b 1
)
mkdir "%iq_temp%" >nul 2>nul
if errorlevel 1 exit /b 1
curl.exe -fsSL --proto "=https" --proto-redir "=https" "https://iq-routing.com/install.ps1" -o "%iq_temp%\install.ps1"
if errorlevel 1 (
  rmdir /s /q "%iq_temp%"
  exit /b 1
)
rem PowerShell 7 passes cmd its own PSModulePath, which Windows PowerShell 5.1 cannot load Microsoft.PowerShell.Security from; clear it so 5.1 builds its default.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%iq_temp%\install.ps1" %iq_args%
set "iq_exit=%ERRORLEVEL%"
rmdir /s /q "%iq_temp%"
exit /b %iq_exit%

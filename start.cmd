@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0scripts\start.ps1" %*
set "PERSONAL_AGENT_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%PERSONAL_AGENT_LAUNCH_EXIT%"=="0" (
  echo Startup failed. See README.md and the .runtime log files. No security policy was changed.
  pause
)
exit /b %PERSONAL_AGENT_LAUNCH_EXIT%

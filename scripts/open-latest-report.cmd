@echo off
rem Opens the newest qa-framework HTML report in the default browser.
rem Usage:
rem   scripts\open-latest-report.cmd          -> prints path AND opens it
rem   scripts\open-latest-report.cmd print    -> prints path only
setlocal
set "BASE=%~dp0..\reports"
for %%i in ("%BASE%") do set "BASE=%%~fi"

for /f "delims=" %%d in ('dir "%BASE%" /b /ad /o-d 2^>nul') do (
  if exist "%BASE%\%%d\summary.html" (
    echo Latest run : %%d
    echo Report     : %BASE%\%%d\summary.html
    if /i not "%~1"=="print" start "" "%BASE%\%%d\summary.html"
    exit /b 0
  )
)

echo No report found under %BASE%
echo Run a suite first, e.g.: scripts\docker-live-run.sh via docker
exit /b 1

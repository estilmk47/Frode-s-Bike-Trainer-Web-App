@echo off
rem Stops what start-server.bat started: nginx, PHP (php-cgi) and the Party Spin server.
setlocal
cd /d "%~dp0"
set "ROOT=%cd%"

for /f "delims=" %%i in ('where nginx 2^>nul') do if not defined NGINX_DIR set "NGINX_DIR=%%~dpi"
if defined NGINX_DIR (
    set "NGINX_DIR=%NGINX_DIR:~0,-1%"
)
if defined NGINX_DIR (
    echo Stopping nginx ...
    nginx -p "%NGINX_DIR%" -c "%ROOT%\nginx.conf" -s quit 2>nul || taskkill /f /im nginx.exe >nul 2>nul
)

echo Stopping PHP ...
taskkill /f /im php-cgi.exe >nul 2>nul

echo Stopping the Party Spin server ...
rem Only the Python that runs partyspin_server.py, no other Python programs.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%%'\" | Where-Object { $_.CommandLine -like '*partyspin_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Stopped.

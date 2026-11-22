@echo off
rem Starts Frode's Bike Trainer on this computer, served by nginx over HTTPS (see nginx.conf):
rem   PHP (php-cgi), the Party Spin server and nginx, each in a small window of its own.
rem Run it from anywhere: start-server.bat (cmd), .\start-server.bat (PowerShell) or double-click.
rem Stop everything with stop-server.bat.
setlocal
cd /d "%~dp0"
set "ROOT=%cd%"

rem nginx's own folder (for its logs\ and temp\), found from PATH. Without the last backslash.
for /f "delims=" %%i in ('where nginx 2^>nul') do if not defined NGINX_DIR set "NGINX_DIR=%%~dpi"
if not defined NGINX_DIR (
    echo nginx was not found. Install it and add its folder to PATH.
    exit /b 1
)
set "NGINX_DIR=%NGINX_DIR:~0,-1%"

where php-cgi >nul 2>nul || (
    echo php-cgi was not found. It comes with PHP: add PHP's folder to PATH.
    exit /b 1
)

rem The Party Spin server's Python: its venv when there is one.
set "PY=%ROOT%\applications\PartySpin\server\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

rem Check the nginx configuration before starting anything.
nginx -p "%NGINX_DIR%" -c "%ROOT%\nginx.conf" -t 2>nul || (
    nginx -p "%NGINX_DIR%" -c "%ROOT%\nginx.conf" -t
    exit /b 1
)

echo Starting PHP, the Party Spin server and nginx ...
rem PHP_FCGI_MAX_REQUESTS=0: php-cgi would otherwise quit after 500 requests.
start "FBT PHP" /min cmd /c "set PHP_FCGI_MAX_REQUESTS=0&& php-cgi -b 127.0.0.1:9123"
rem 127.0.0.1: only nginx reaches the Party Spin server, so browsers use wss://.
start "FBT Party Spin" /min /d "%ROOT%\applications\PartySpin\server" "%PY%" partyspin_server.py --host 127.0.0.1
start "FBT nginx" /min /d "%NGINX_DIR%" nginx -p "%NGINX_DIR%" -c "%ROOT%\nginx.conf"

echo.
echo Running. Open https://^<this computer's IP^>/  (ipconfig shows it)
echo Logs: nginx in "%NGINX_DIR%\logs", PHP and Party Spin in their windows.
echo Stop:  stop-server.bat

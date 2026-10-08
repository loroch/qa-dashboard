@echo off
REM Starts the Sensor Health Validator web UI and opens it in the browser.
REM Keep this window open while using the page; close it to stop the server.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
start "" http://localhost:8090
python sensor_health_web.py --port 8090
pause

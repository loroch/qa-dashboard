@echo off
REM On-demand Sensor Health comparison: BI vs Elasticsearch vs Units log (DEV1).
REM Double-click to run. Opens the HTML report in the browser when done.
setlocal
set SHARE=\\192.168.35.109\c$
set REPORTS=%USERPROFILE%\Documents\SensorHealthReports
if not exist "%REPORTS%" mkdir "%REPORTS%"

if not exist "%SHARE%\C-Insight\Application\LOGS\DEV1-APP1" (
    echo Connecting to DEV1-APP1 log share - enter the c4isrv password when asked.
    net use %SHARE% /user:int.local\c4isrv *
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i
set REPORT=%REPORTS%\sensor_health_%TS%.html

set PYTHONIOENCODING=utf-8
python "%~dp0sensor_health_validator.py" --html "%REPORT%"

if exist "%REPORT%" start "" "%REPORT%"
echo.
pause

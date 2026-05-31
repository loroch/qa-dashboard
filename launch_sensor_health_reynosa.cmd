@echo off
REM Thin launcher called by Zabbix UserParameter.
REM Starts the script detached (no window, no wait), returns 1 immediately.
REM Zabbix gets "1" back in under 1 second — no timeout issues.
start "" /B "C:\Python313\pythonw.exe" "C:\Program Files\Zabbix Agent\scripts\sensor_health_reynosa.py" --send
echo 1

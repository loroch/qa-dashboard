@echo off
REM Thin launcher called by Zabbix UserParameter.
REM Starts the script detached (no window, no wait), returns 1 immediately.
start "" /B "C:\Python313\pythonw.exe" "C:\Program Files\Zabbix Agent\scripts\sensor_health_ica.py" --send
echo 1

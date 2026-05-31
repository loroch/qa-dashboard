@echo off
REM Called by Zabbix UserParameter with site name as argument.
REM Example: launch_sensor_health_site.cmd REYNOSA
REM Fires script in background, returns 1 immediately (no timeout risk).
start "" /B "C:\Python313\pythonw.exe" "C:\Program Files\Zabbix Agent\scripts\sensor_health_reynosa.py" --site %1 --send
echo 1

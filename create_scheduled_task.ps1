# Run once as Administrator on the Zabbix agent machine.
# Uses schtasks.exe — no XML duration issues.

$pythonPath = "C:\Python313\python.exe"
$scriptPath = "C:\Program Files\Zabbix Agent\scripts\sensor_health_report.py"
$logPath    = "C:\Program Files\Zabbix Agent\scripts\sensor_health.log"
$taskName   = "SensorHealthReport"
$command    = "`"$pythonPath`" `"$scriptPath`" --send"

# Delete old task if exists
schtasks /delete /tn $taskName /f 2>$null

# Create: runs every 10 hours, as SYSTEM, highest privilege
schtasks /create `
    /tn  $taskName `
    /tr  $command `
    /sc  HOURLY `
    /mo  10 `
    /ru  SYSTEM `
    /rl  HIGHEST `
    /f

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Task '$taskName' registered successfully."
    Write-Host ""
    Write-Host "Run immediately:"
    Write-Host "  schtasks /run /tn `"$taskName`""
    Write-Host ""
    Write-Host "Check status:"
    Write-Host "  schtasks /query /tn `"$taskName`" /fo LIST"
    Write-Host ""
    Write-Host "Log: $logPath"
} else {
    Write-Host "ERROR: Task registration failed."
}

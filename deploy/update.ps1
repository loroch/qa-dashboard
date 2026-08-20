#Requires -Version 5.1
param()
$ErrorActionPreference = "Stop"
$INSTALL_DIR = "C:\qa-dashboard"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "Run as Administrator" -ForegroundColor Red; exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  QA Dashboard - Update" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

$REPO_TOKEN = Read-Host "  GitHub access token (get from Loro)"
$authUrl = "https://$REPO_TOKEN@github.com/KABATONE-OP/QA.git"

Write-Host "  [..] Pulling latest code..." -ForegroundColor Yellow
Push-Location $INSTALL_DIR
git remote set-url origin $authUrl
git pull origin master --rebase

Write-Host "  [..] Updating Python dependencies..." -ForegroundColor Yellow
Push-Location "$INSTALL_DIR\backend"
& "$INSTALL_DIR\venv\Scripts\pip.exe" install -r requirements.txt 2>&1 | Out-Null
Pop-Location

Write-Host "  [..] Rebuilding frontend..." -ForegroundColor Yellow
Push-Location "$INSTALL_DIR\frontend"
npm install 2>&1 | Out-Null
npm run build
Pop-Location

Pop-Location

Write-Host "  [..] Restarting services..." -ForegroundColor Yellow
Stop-ScheduledTask -TaskName "QA-Dashboard-Backend"  -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName "QA-Dashboard-Frontend" -ErrorAction SilentlyContinue

# Kill old processes on those ports
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Start-Sleep 2
Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$INSTALL_DIR\deploy\start-backend.ps1`""
Start-Sleep 5
Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$INSTALL_DIR\deploy\start-frontend.ps1`""

Write-Host ""
Write-Host "  [OK] Dashboard updated and restarted." -ForegroundColor Green
Write-Host "  [OK] http://localhost:3000" -ForegroundColor Green
Write-Host ""

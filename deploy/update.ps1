#Requires -Version 5.1
<#
.SYNOPSIS
    QA Dashboard — Update script (pull latest + rebuild)
.NOTES
    Run as Administrator from any machine that already has the dashboard installed.
#>
$INSTALL_DIR = "C:\qa-dashboard"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "Run as Administrator" -ForegroundColor Red; exit 1
}

$REPO_TOKEN = Read-Host "GitHub access token (get from Loro)"

Write-Host "Pulling latest code..." -ForegroundColor Cyan
Push-Location $INSTALL_DIR
$authUrl = "https://$REPO_TOKEN@github.com/KABATONE-OP/QA.git"
git remote set-url origin $authUrl
git pull origin master --rebase

Write-Host "Rebuilding containers..." -ForegroundColor Cyan
docker-compose build
docker-compose up -d

Write-Host ""
Write-Host "Dashboard updated and running." -ForegroundColor Green
Pop-Location

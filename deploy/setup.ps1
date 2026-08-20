#Requires -Version 5.1
<#
.SYNOPSIS
    QA Dashboard — Team Setup Script
.DESCRIPTION
    Installs Git, Docker Desktop, clones the repo, configures environment
    variables, builds Docker images, starts services, and opens firewall ports.
    Run this script ONCE on any Windows machine to get a fully working QA Dashboard.
.NOTES
    Must be run as Administrator.
    After first run the dashboard is available at http://<this-PC-IP>:3000
#>

Set-StrictMode -Off
$ErrorActionPreference = "Stop"

# ── Config ────────────────────────────────────────────────────────────────────
$INSTALL_DIR   = "C:\qa-dashboard"
$REPO_URL      = "https://github.com/KABATONE-OP/QA.git"
$FRONTEND_PORT = 3000
$BACKEND_PORT  = 8000
$DOCKER_INSTALLER = "$env:TEMP\DockerDesktopInstaller.exe"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Write-Header($text) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════" -ForegroundColor Cyan
}
function Write-OK($text)   { Write-Host "  [OK]  $text" -ForegroundColor Green }
function Write-INFO($text) { Write-Host "  [..] $text"  -ForegroundColor Yellow }
function Write-FAIL($text) { Write-Host "  [!!]  $text" -ForegroundColor Red }

# ── Admin check ───────────────────────────────────────────────────────────────
Write-Header "QA Dashboard — Team Setup"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-FAIL "Please run this script as Administrator (right-click → Run as Administrator)"
    exit 1
}

# ── Collect secrets ───────────────────────────────────────────────────────────
Write-Header "Step 1/6  — Collect API credentials"
Write-Host ""
Write-Host "  You need credentials to clone the repo and connect to Jira/AI services." -ForegroundColor White
Write-Host "  Press ENTER to skip optional tokens (those features will be disabled)." -ForegroundColor Gray
Write-Host ""

$REPO_TOKEN = Read-Host "  GitHub access token (get from Loro)"
$jiraEmail  = Read-Host "  Jira email (e.g. you@kabatone.com)"
$jiraToken  = Read-Host "  Jira API token (get from Jira → Profile → Security → API tokens)"
$anthropicKey = Read-Host "  Anthropic API key (for AI test plans / handover criteria)"
$zohoToken = Read-Host "  Zoho Desk token (optional, press ENTER to skip)"
$zohoOrgId = Read-Host "  Zoho Org ID (optional, press ENTER to skip)"

# ── Install Git ───────────────────────────────────────────────────────────────
Write-Header "Step 2/6  — Git"
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    Write-OK "Git already installed: $(git --version)"
} else {
    Write-INFO "Installing Git via winget..."
    try {
        winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements
        $env:PATH += ";C:\Program Files\Git\cmd"
        Write-OK "Git installed"
    } catch {
        Write-FAIL "winget failed. Download Git from https://git-scm.com/download/win and re-run this script."
        exit 1
    }
}

# ── Install Docker Desktop ────────────────────────────────────────────────────
Write-Header "Step 3/6  — Docker Desktop"
$dockerRunning = $false
try {
    $null = docker info 2>$null
    $dockerRunning = $true
} catch {}

if ($dockerRunning) {
    Write-OK "Docker Desktop already running"
} else {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-INFO "Docker Desktop found but not running — starting it..."
        Start-Process $dockerExe
        Write-INFO "Waiting up to 90 seconds for Docker to be ready..."
        $waited = 0
        while ($waited -lt 90) {
            Start-Sleep 5; $waited += 5
            try { $null = docker info 2>$null; $dockerRunning = $true; break } catch {}
        }
        if ($dockerRunning) { Write-OK "Docker Desktop is running" }
        else { Write-FAIL "Docker did not start in time. Start Docker Desktop manually then re-run this script."; exit 1 }
    } else {
        Write-INFO "Downloading Docker Desktop installer (~600 MB) — this takes a few minutes..."
        $dlUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
        try {
            Invoke-WebRequest -Uri $dlUrl -OutFile $DOCKER_INSTALLER -UseBasicParsing
        } catch {
            Write-FAIL "Download failed. Download Docker Desktop manually from https://www.docker.com/products/docker-desktop/ and re-run."
            exit 1
        }
        Write-INFO "Installing Docker Desktop (silent)..."
        Start-Process -FilePath $DOCKER_INSTALLER -ArgumentList "install --quiet --accept-license" -Wait
        Write-OK "Docker Desktop installed"
        Write-Host ""
        Write-Host "  ┌─────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
        Write-Host "  │  REBOOT REQUIRED after Docker Desktop first install.    │" -ForegroundColor Yellow
        Write-Host "  │  After reboot, run this script again to continue setup. │" -ForegroundColor Yellow
        Write-Host "  └─────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
        Write-Host ""
        Read-Host "  Press ENTER to reboot now, or Ctrl+C to reboot manually later"
        Restart-Computer -Force
        exit 0
    }
}

# ── Clone / pull repo ─────────────────────────────────────────────────────────
Write-Header "Step 4/6  — Repository"
$authUrl = $REPO_URL -replace "https://", "https://$REPO_TOKEN@"

if (Test-Path "$INSTALL_DIR\.git") {
    Write-INFO "Repo already exists — pulling latest changes..."
    Push-Location $INSTALL_DIR
    try {
        git remote set-url origin $authUrl
        git pull origin master --rebase
        Write-OK "Repository updated"
    } catch {
        Write-FAIL "git pull failed: $_"
    } finally {
        Pop-Location
    }
} else {
    Write-INFO "Cloning repository to $INSTALL_DIR ..."
    git clone $authUrl $INSTALL_DIR
    Write-OK "Repository cloned"
}

# ── Write .env ────────────────────────────────────────────────────────────────
Write-Header "Step 5/6  — Environment configuration"

# Detect this machine's LAN IP for CORS
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254)" } |
    Select-Object -First 1).IPAddress

$envContent = @"
# ==========================================================
# QA Dashboard — Environment Variables  (auto-generated)
# ==========================================================

# --- Jira ---
JIRA_BASE_URL=https://avite.atlassian.net
JIRA_USER_EMAIL=$jiraEmail
JIRA_API_TOKEN=$jiraToken

# --- AI (Anthropic) ---
ANTHROPIC_API_KEY=$anthropicKey

# --- Zoho ---
ZOHO_DESK_TOKEN=$zohoToken
ZOHO_ORG_ID=$zohoOrgId

# --- Field Mapping ---
FIELD_MAPPING_PATH=./config/field_mapping.yaml

# --- Cache ---
CACHE_TTL_SECONDS=300
BACKGROUND_REFRESH_HOURS=5

# --- Database ---
DATABASE_URL=sqlite+aiosqlite:///./data/qa_dashboard.db

# --- CORS (allow browser from any team PC on LAN) ---
CORS_ORIGINS=http://localhost:3000,http://localhost:5173,http://${lanIP}:3000

# --- Misc ---
LOG_LEVEL=INFO
ENVIRONMENT=production
EXPORT_MAX_ROWS=10000
JIRA_MAX_RESULTS=100
"@

$envPath = Join-Path $INSTALL_DIR ".env"
$envContent | Out-File -FilePath $envPath -Encoding utf8 -Force
Write-OK ".env written to $envPath"
Write-OK "Detected LAN IP: $lanIP (added to CORS_ORIGINS)"

# ── Build & start containers ──────────────────────────────────────────────────
Write-Header "Step 6/6  — Build & launch Docker containers"
Push-Location $INSTALL_DIR
try {
    Write-INFO "Building images (first build takes 5-10 minutes)..."
    docker-compose build
    Write-OK "Images built"

    Write-INFO "Starting containers..."
    docker-compose up -d
    Write-OK "Containers started"

    Write-INFO "Waiting for backend health check..."
    $ready = $false
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep 5
        try {
            $r = Invoke-WebRequest "http://localhost:$BACKEND_PORT/health" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
    }
    if ($ready) { Write-OK "Backend is healthy" }
    else { Write-FAIL "Backend health check timed out — check: docker logs qa-dashboard-api" }
} finally {
    Pop-Location
}

# ── Open Windows Firewall ─────────────────────────────────────────────────────
Write-INFO "Configuring Windows Firewall..."
$rules = @(
    @{ Name = "QA Dashboard Frontend (3000)"; Port = $FRONTEND_PORT },
    @{ Name = "QA Dashboard Backend (8000)";  Port = $BACKEND_PORT  }
)
foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-OK "Firewall rule already exists: $($rule.Name)"
    } else {
        New-NetFirewallRule `
            -DisplayName $rule.Name `
            -Direction Inbound `
            -Protocol TCP `
            -LocalPort $rule.Port `
            -Action Allow `
            -Profile Any | Out-Null
        Write-OK "Firewall rule added: $($rule.Name) → port $($rule.Port)"
    }
}

# ── Register auto-start task ──────────────────────────────────────────────────
Write-INFO "Registering auto-start task (starts dashboard on Windows boot)..."
$startScript = @"
Set-Location '$INSTALL_DIR'
docker-compose up -d
"@
$startScriptPath = Join-Path $INSTALL_DIR "deploy\start-on-boot.ps1"
$startScript | Out-File -FilePath $startScriptPath -Encoding utf8 -Force

$taskName = "QA-Dashboard-Autostart"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -WindowStyle Hidden -File `"$startScriptPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Write-OK "Auto-start task registered: '$taskName'"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║            QA Dashboard is ready!                           ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║                                                              ║" -ForegroundColor Green
Write-Host "║  This machine:   http://localhost:$FRONTEND_PORT                     ║" -ForegroundColor Green
Write-Host "║  Other PCs:      http://${lanIP}:${FRONTEND_PORT}               ║" -ForegroundColor Green
Write-Host "║                                                              ║" -ForegroundColor Green
Write-Host "║  Useful commands (run in $INSTALL_DIR):               ║" -ForegroundColor Green
Write-Host "║    docker-compose logs -f     (live logs)                   ║" -ForegroundColor Green
Write-Host "║    docker-compose down        (stop all)                    ║" -ForegroundColor Green
Write-Host "║    docker-compose pull        (update images)               ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

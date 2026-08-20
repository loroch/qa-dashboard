#Requires -Version 5.1
param()
Set-StrictMode -Off
$ErrorActionPreference = "Stop"

# ── Config ────────────────────────────────────────────────────────────────────
$INSTALL_DIR   = "C:\qa-dashboard"
$REPO_URL      = "https://github.com/KABATONE-OP/QA.git"
$FRONTEND_PORT = 3000
$BACKEND_PORT  = 8000
$RESUME_FILE   = "$env:TEMP\qa-dashboard-setup.json"
$RESUME_TASK   = "QA-Dashboard-Setup-Resume"

function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}
function Write-OK   { param([string]$T); Write-Host "  [OK]  $T" -ForegroundColor Green  }
function Write-INFO { param([string]$T); Write-Host "  [..]  $T" -ForegroundColor Yellow }
function Write-FAIL { param([string]$T); Write-Host "  [!!]  $T" -ForegroundColor Red    }

function Save-Resume {
    param([hashtable]$Data)
    $Data | ConvertTo-Json | Out-File -FilePath $RESUME_FILE -Encoding utf8 -Force
}

function Remove-ResumeTask {
    if (Get-ScheduledTask -TaskName $RESUME_TASK -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $RESUME_TASK -Confirm:$false
    }
}

# ── Admin check ───────────────────────────────────────────────────────────────
Write-Header "QA Dashboard - Team Setup"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-FAIL "Please run as Administrator (right-click -> Run as Administrator)"
    exit 1
}

# ── Load resume state or collect credentials ──────────────────────────────────
$resumeStep = 1
$REPO_TOKEN = $jiraEmail = $jiraToken = $anthropicKey = $zohoToken = $zohoOrgId = ""

if (Test-Path $RESUME_FILE) {
    Write-HOST ""
    Write-HOST "  Resuming from previous run..." -ForegroundColor Magenta
    try {
        $saved = Get-Content $RESUME_FILE | ConvertFrom-Json
        $REPO_TOKEN   = $saved.REPO_TOKEN
        $jiraEmail    = $saved.jiraEmail
        $jiraToken    = $saved.jiraToken
        $anthropicKey = $saved.anthropicKey
        $zohoToken    = $saved.zohoToken
        $zohoOrgId    = $saved.zohoOrgId
        $resumeStep   = [int]$saved.nextStep
        Write-OK "Credentials loaded from resume file. Continuing at step $resumeStep."
    } catch {
        Write-INFO "Could not read resume file - starting fresh."
        Remove-Item $RESUME_FILE -Force -ErrorAction SilentlyContinue
        $resumeStep = 1
    }
}

if ($resumeStep -le 1) {
    Write-Header "Step 1/6 - Collect credentials"
    Write-Host ""
    Write-Host "  Enter credentials below. Press ENTER to skip optional items." -ForegroundColor White
    Write-Host ""

    $REPO_TOKEN   = Read-Host "  GitHub access token (get from Loro)"
    $jiraEmail    = Read-Host "  Jira email (e.g. you@kabatone.com)"
    $jiraToken    = Read-Host "  Jira API token"
    $anthropicKey = Read-Host "  Anthropic API key (for AI features, optional)"
    $zohoToken    = Read-Host "  Zoho Desk token (optional)"
    $zohoOrgId    = Read-Host "  Zoho Org ID (optional)"

    Save-Resume @{
        REPO_TOKEN   = $REPO_TOKEN
        jiraEmail    = $jiraEmail
        jiraToken    = $jiraToken
        anthropicKey = $anthropicKey
        zohoToken    = $zohoToken
        zohoOrgId    = $zohoOrgId
        nextStep     = 2
    }
    Write-OK "Credentials saved"
} else {
    Write-Header "Step 1/6 - Collect credentials"
    Write-OK "Skipped (already collected)"
}

# ── Install Git ───────────────────────────────────────────────────────────────
if ($resumeStep -le 2) {
    Write-Header "Step 2/6 - Git"
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        Write-OK "Git already installed"
    } else {
        Write-INFO "Installing Git via winget..."
        try {
            winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements
            $env:PATH = $env:PATH + ";C:\Program Files\Git\cmd"
            Write-OK "Git installed"
        } catch {
            Write-FAIL "winget failed. Install Git manually from https://git-scm.com and re-run."
            exit 1
        }
    }
    Save-Resume @{
        REPO_TOKEN = $REPO_TOKEN; jiraEmail = $jiraEmail; jiraToken = $jiraToken
        anthropicKey = $anthropicKey; zohoToken = $zohoToken; zohoOrgId = $zohoOrgId
        nextStep = 3
    }
} else {
    Write-Header "Step 2/6 - Git"
    Write-OK "Skipped"
}

# ── Install / start Docker Desktop ────────────────────────────────────────────
function Test-DockerRunning {
    try { $null = docker info 2>$null; return $true } catch { return $false }
}

Write-Header "Step 3/6 - Docker Desktop"

# Check CPU virtualization before downloading anything
$virt = (Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled
$hyperv = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue).State
if ($virt -eq $false) {
    Write-FAIL "CPU Virtualization is DISABLED in BIOS."
    Write-Host ""
    Write-Host "  Fix:" -ForegroundColor Yellow
    Write-Host "  1. Reboot and enter BIOS (press Del or F2 during boot logo)" -ForegroundColor White
    Write-Host "  2. Find: Advanced > CPU > Intel Virtualization Technology -> ENABLE" -ForegroundColor White
    Write-Host "  3. Save & Exit (F10), then re-run this script" -ForegroundColor White
    Write-Host ""
    exit 1
}
if ($hyperv -ne "Enabled") {
    Write-INFO "Hyper-V is not enabled - enabling now (requires one more reboot)..."
    Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart | Out-Null

    Save-Resume @{
        REPO_TOKEN = $REPO_TOKEN; jiraEmail = $jiraEmail; jiraToken = $jiraToken
        anthropicKey = $anthropicKey; zohoToken = $zohoToken; zohoOrgId = $zohoOrgId
        nextStep = 3
    }
    Write-OK "Hyper-V enabled. A reboot is required."
    Read-Host "  Press ENTER to reboot"
    Restart-Computer -Force
    exit 0
}

if (Test-DockerRunning) {
    Write-OK "Docker Desktop is already running"
} else {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-INFO "Docker Desktop found but not running - starting it..."
        Start-Process $dockerExe
        Write-INFO "Waiting up to 3 minutes for Docker Engine to be ready..."
        $ok = $false
        for ($i = 0; $i -lt 36; $i++) {
            Start-Sleep 5
            if (Test-DockerRunning) { $ok = $true; break }
            if ($i % 6 -eq 5) { Write-INFO "Still waiting... ($([int](($i+1)*5/60))m $([int](($i+1)*5%60))s)" }
        }
        if ($ok) {
            Write-OK "Docker Desktop is running"
        } else {
            Write-FAIL "Docker did not start in 3 minutes."
            Write-FAIL "Open Docker Desktop from the Start Menu, wait for the whale icon in the taskbar, then re-run setup.ps1."
            exit 1
        }
    } else {
        Write-INFO "Downloading Docker Desktop (~600 MB)..."
        $installer = "$env:TEMP\DockerDesktopInstaller.exe"
        try {
            Invoke-WebRequest -Uri "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" `
                -OutFile $installer -UseBasicParsing
        } catch {
            Write-FAIL "Download failed. Get Docker Desktop from https://www.docker.com and re-run."
            exit 1
        }
        Write-INFO "Installing Docker Desktop (silent)..."
        Start-Process -FilePath $installer -ArgumentList "install --quiet --accept-license" -Wait
        Write-OK "Docker Desktop installed"

        # Resolve script path now (before reboot - MyInvocation works here)
        $scriptPath = $MyInvocation.MyCommand.Path
        if (-not $scriptPath) {
            $scriptPath = $PSCommandPath
        }
        if (-not $scriptPath) {
            $scriptPath = Join-Path (Get-Location) "setup.ps1"
        }

        # Save resume state + script path so the scheduled task knows where to find us
        Save-Resume @{
            REPO_TOKEN   = $REPO_TOKEN; jiraEmail = $jiraEmail; jiraToken = $jiraToken
            anthropicKey = $anthropicKey; zohoToken = $zohoToken; zohoOrgId = $zohoOrgId
            nextStep     = 3
            scriptPath   = $scriptPath
        }

        # Write a tiny launcher batch that opens a visible window and runs this script
        $launcherPath = "$env:TEMP\qa-setup-resume.bat"
        $batContent = "@echo off`r`npowershell.exe -ExecutionPolicy Bypass -File `"$scriptPath`"`r`npause"
        [System.IO.File]::WriteAllText($launcherPath, $batContent)

        # Register scheduled task: fire at logon, 90-second delay (lets Docker Desktop start first)
        Remove-ResumeTask
        $action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$launcherPath`""
        $trigger  = New-ScheduledTaskTrigger -AtLogOn
        $trigger.Delay = "PT90S"
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
        Register-ScheduledTask -TaskName $RESUME_TASK -Action $action -Trigger $trigger `
            -Settings $settings -RunLevel Highest -Force | Out-Null
        Write-OK "Auto-resume task registered (fires 90 sec after login)"

        Write-Host ""
        Write-Host "  *** REBOOT REQUIRED ***" -ForegroundColor Yellow
        Write-Host "  Setup will CONTINUE AUTOMATICALLY 90 sec after you log back in." -ForegroundColor Yellow
        Write-Host "  A CMD window will open - let it run until it says 'QA Dashboard is ready'." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "  Press ENTER to reboot now"
        Restart-Computer -Force
        exit 0
    }
}

# Remove the auto-resume task now that Docker is running
Remove-ResumeTask

# ── Clone / pull repo ─────────────────────────────────────────────────────────
if ($resumeStep -le 4) {
    Write-Header "Step 4/6 - Repository"
    $authUrl = "https://" + $REPO_TOKEN + "@github.com/KABATONE-OP/QA.git"

    if (Test-Path (Join-Path $INSTALL_DIR ".git")) {
        Write-INFO "Repo exists - pulling latest..."
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
        Write-INFO "Cloning to $INSTALL_DIR ..."
        git clone $authUrl $INSTALL_DIR
        Write-OK "Repository cloned"
    }
    Save-Resume @{
        REPO_TOKEN = $REPO_TOKEN; jiraEmail = $jiraEmail; jiraToken = $jiraToken
        anthropicKey = $anthropicKey; zohoToken = $zohoToken; zohoOrgId = $zohoOrgId
        nextStep = 5
    }
} else {
    Write-Header "Step 4/6 - Repository"
    Write-OK "Skipped"
}

# ── Write .env ────────────────────────────────────────────────────────────────
Write-Header "Step 5/6 - Environment configuration"
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254)" } |
    Select-Object -First 1).IPAddress

$corsOrigins = "http://localhost:3000,http://localhost:5173,http://" + $lanIP + ":3000"
$envLines = @(
    "# QA Dashboard - Environment Variables"
    ""
    "JIRA_BASE_URL=https://avite.atlassian.net"
    "JIRA_USER_EMAIL=$jiraEmail"
    "JIRA_API_TOKEN=$jiraToken"
    ""
    "KONE_JIRA_BASE_URL=https://kabatone-ops-it.atlassian.net"
    "KONE_JIRA_EMAIL=$jiraEmail"
    "KONE_JIRA_TOKEN=$jiraToken"
    ""
    "ANTHROPIC_API_KEY=$anthropicKey"
    ""
    "ZOHO_DESK_TOKEN=$zohoToken"
    "ZOHO_ORG_ID=$zohoOrgId"
    ""
    "FIELD_MAPPING_PATH=./config/field_mapping.yaml"
    "CACHE_TTL_SECONDS=300"
    "BACKGROUND_REFRESH_HOURS=5"
    "DATABASE_URL=sqlite+aiosqlite:///./data/qa_dashboard.db"
    "LOG_LEVEL=INFO"
    "ENVIRONMENT=production"
    "EXPORT_MAX_ROWS=10000"
    "JIRA_MAX_RESULTS=100"
    "CORS_ORIGINS=$corsOrigins"
)
$envPath = Join-Path $INSTALL_DIR ".env"
$envLines -join "`r`n" | Out-File -FilePath $envPath -Encoding utf8 -Force
Write-OK ".env written to $envPath"
Write-OK "LAN IP: $lanIP  (team access: http://${lanIP}:${FRONTEND_PORT})"

# ── Build and start containers ────────────────────────────────────────────────
Write-Header "Step 6/6 - Build and launch Docker containers"
Push-Location $INSTALL_DIR
try {
    Write-INFO "Building images (first build: 5-10 min)..."
    docker-compose build
    Write-OK "Images built"

    Write-INFO "Starting containers..."
    docker-compose up -d
    Write-OK "Containers started"

    Write-INFO "Waiting for backend health check..."
    $healthy = $false
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep 5
        try {
            $r = Invoke-WebRequest "http://localhost:$BACKEND_PORT/health" -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch {}
    }
    if ($healthy) { Write-OK "Backend is healthy" }
    else { Write-FAIL "Backend health check timed out. Check: docker logs qa-dashboard-api" }
} finally {
    Pop-Location
}

# ── Firewall ──────────────────────────────────────────────────────────────────
Write-INFO "Configuring Windows Firewall..."
foreach ($entry in @("QA Dashboard Frontend,$FRONTEND_PORT", "QA Dashboard Backend,$BACKEND_PORT")) {
    $parts    = $entry -split ","
    $ruleName = $parts[0]
    $port     = [int]$parts[1]
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
            -LocalPort $port -Action Allow -Profile Any | Out-Null
        Write-OK "Firewall rule added: $ruleName (port $port)"
    } else {
        Write-OK "Firewall rule already exists: $ruleName"
    }
}

# ── Auto-start on boot ────────────────────────────────────────────────────────
Write-INFO "Registering auto-start scheduled task..."
$bootScript = Join-Path $INSTALL_DIR "deploy\start-on-boot.ps1"
"Set-Location '$INSTALL_DIR'; docker-compose up -d" | Out-File -FilePath $bootScript -Encoding utf8 -Force
$taskName = "QA-Dashboard-Autostart"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NonInteractive -WindowStyle Hidden -File `"$bootScript`""
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Highest -Force | Out-Null
Write-OK "Auto-start task registered"

# ── Cleanup resume file ───────────────────────────────────────────────────────
Remove-Item $RESUME_FILE -Force -ErrorAction SilentlyContinue

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  QA Dashboard is ready!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  This machine : http://localhost:$FRONTEND_PORT" -ForegroundColor White
Write-Host "  Team access  : http://${lanIP}:${FRONTEND_PORT}" -ForegroundColor White
Write-Host ""
Write-Host "  Commands (run in $INSTALL_DIR):" -ForegroundColor Gray
Write-Host "    docker-compose logs -f    (live logs)" -ForegroundColor Gray
Write-Host "    docker-compose down       (stop)" -ForegroundColor Gray
Write-Host "    docker-compose up -d      (start)" -ForegroundColor Gray
Write-Host "    .\deploy\update.ps1       (pull latest + rebuild)" -ForegroundColor Gray
Write-Host ""

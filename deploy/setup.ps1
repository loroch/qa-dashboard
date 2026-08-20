#Requires -Version 5.1
param()
Set-StrictMode -Off
$ErrorActionPreference = "Stop"

# ── Config ────────────────────────────────────────────────────────────────────
$INSTALL_DIR   = "C:\qa-dashboard"
$VENV_DIR      = "$INSTALL_DIR\venv"
$LOG_DIR       = "$INSTALL_DIR\logs"
$RESUME_FILE   = "$env:TEMP\qa-dashboard-setup.json"
$FRONTEND_PORT = 3000
$BACKEND_PORT  = 8000

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

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

# ── Admin check ───────────────────────────────────────────────────────────────
Write-Header "QA Dashboard - Team Setup (No Docker)"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-FAIL "Please run as Administrator (right-click -> Run as Administrator)"
    exit 1
}

# ── Load resume state or start fresh ─────────────────────────────────────────
$resumeStep = 1
$REPO_TOKEN = $jiraEmail = $jiraToken = $anthropicKey = $zohoToken = $zohoOrgId = ""

if (Test-Path $RESUME_FILE) {
    Write-Host ""
    Write-Host "  Resuming from previous run..." -ForegroundColor Magenta
    try {
        $saved       = Get-Content $RESUME_FILE | ConvertFrom-Json
        $REPO_TOKEN  = $saved.REPO_TOKEN
        $jiraEmail   = $saved.jiraEmail
        $jiraToken   = $saved.jiraToken
        $anthropicKey= $saved.anthropicKey
        $zohoToken   = $saved.zohoToken
        $zohoOrgId   = $saved.zohoOrgId
        $resumeStep  = [int]$saved.nextStep
        Write-OK "Credentials loaded. Continuing at step $resumeStep."
    } catch {
        Write-INFO "Could not read resume file - starting fresh."
        Remove-Item $RESUME_FILE -Force -ErrorAction SilentlyContinue
        $resumeStep = 1
    }
}

# ── Step 1: Credentials ───────────────────────────────────────────────────────
if ($resumeStep -le 1) {
    Write-Header "Step 1/5 - Credentials"
    Write-Host ""
    Write-Host "  Enter the values below. Press ENTER to skip optional items." -ForegroundColor White
    Write-Host ""

    $REPO_TOKEN   = Read-Host "  GitHub access token (get from Loro)"
    $jiraEmail    = Read-Host "  Jira email (e.g. you@kabatone.com)"
    $jiraToken    = Read-Host "  Jira API token"
    $anthropicKey = Read-Host "  Anthropic API key (optional - for AI features)"
    $zohoToken    = Read-Host "  Zoho Desk token (optional)"
    $zohoOrgId    = Read-Host "  Zoho Org ID (optional)"

    Save-Resume @{
        REPO_TOKEN=$REPO_TOKEN; jiraEmail=$jiraEmail; jiraToken=$jiraToken
        anthropicKey=$anthropicKey; zohoToken=$zohoToken; zohoOrgId=$zohoOrgId; nextStep=2
    }
    Write-OK "Credentials saved"
} else {
    Write-Header "Step 1/5 - Credentials"
    Write-OK "Skipped (already collected)"
}

# ── Step 2: Install Git, Python, Node.js ──────────────────────────────────────
Write-Header "Step 2/5 - Install tools (Git, Python, Node.js)"

# Git
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-OK "Git already installed"
} else {
    Write-INFO "Installing Git..."
    winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    Write-OK "Git installed"
}

# Python 3.11
$pyExe = "C:\Python311\python.exe"
if (-not (Test-Path $pyExe)) {
    $tmp = Get-Command python -ErrorAction SilentlyContinue
    if ($tmp) { $pyExe = $tmp.Source }
}
if ($pyExe -and (Test-Path $pyExe)) {
    $pyVer = & $pyExe --version 2>&1
    Write-OK "Python already installed: $pyVer"
} else {
    Write-INFO "Installing Python 3.11..."
    winget install --id Python.Python.3.11 -e --source winget --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $pyExe = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
    if (-not (Test-Path $pyExe)) { $pyExe = "C:\Python311\python.exe" }
    if (-not (Test-Path $pyExe)) {
        $tmp = Get-Command python -ErrorAction SilentlyContinue
        if ($tmp) { $pyExe = $tmp.Source }
    }
    Write-OK "Python installed"
}

# Node.js
$tmp = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($tmp) { $tmp.Source } else { $null }
if ($nodeExe) {
    $nodeVer = & $nodeExe --version 2>&1
    Write-OK "Node.js already installed: $nodeVer"
} else {
    Write-INFO "Installing Node.js LTS..."
    winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
    $tmp = Get-Command node -ErrorAction SilentlyContinue
    $nodeExe = if ($tmp) { $tmp.Source } else { $null }
    Write-OK "Node.js installed"
}

# Install serve globally for SPA hosting
$tmp = Get-Command serve -ErrorAction SilentlyContinue
$serveCmd = if ($tmp) { $tmp.Source } else { $null }
if (-not $serveCmd) {
    Write-INFO "Installing 'serve' (static file server for frontend)..."
    $ErrorActionPreference = "Continue"
    npm install -g serve --silent
    $ErrorActionPreference = "Stop"
    Refresh-Path
    Write-OK "'serve' installed"
} else {
    Write-OK "'serve' already installed"
}

Save-Resume @{
    REPO_TOKEN=$REPO_TOKEN; jiraEmail=$jiraEmail; jiraToken=$jiraToken
    anthropicKey=$anthropicKey; zohoToken=$zohoToken; zohoOrgId=$zohoOrgId; nextStep=3
}

# ── Step 3: Clone / update repository ────────────────────────────────────────
Write-Header "Step 3/5 - Repository"

Refresh-Path
$authUrl = "https://$REPO_TOKEN@github.com/KABATONE-OP/QA.git"

if (Test-Path (Join-Path $INSTALL_DIR ".git")) {
    Write-INFO "Repo already exists - pulling latest..."
    Push-Location $INSTALL_DIR
    try {
        git remote set-url origin $authUrl
        git pull origin master --rebase
        Write-OK "Repository updated"
    } catch {
        Write-FAIL "git pull failed: $_"
    } finally { Pop-Location }
} else {
    Write-INFO "Cloning repository to $INSTALL_DIR ..."
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    git clone $authUrl $INSTALL_DIR
    Write-OK "Repository cloned"
}

Save-Resume @{
    REPO_TOKEN=$REPO_TOKEN; jiraEmail=$jiraEmail; jiraToken=$jiraToken
    anthropicKey=$anthropicKey; zohoToken=$zohoToken; zohoOrgId=$zohoOrgId; nextStep=4
}

# ── Step 4: Configure (venv, deps, .env, frontend build) ─────────────────────
Write-Header "Step 4/5 - Configure backend and frontend"

# Detect Python executable (winget path varies)
$tmp = Get-Command python -ErrorAction SilentlyContinue
$pyFromPath = if ($tmp) { $tmp.Source } else { "" }
$candidates = @(
    "C:\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    $pyFromPath
)
$pyExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $pyExe) {
    Write-FAIL "Cannot find Python. Close this window, reopen as Admin, and re-run."
    exit 1
}
Write-OK "Using Python: $pyExe"

# Create virtual environment
if (-not (Test-Path "$VENV_DIR\Scripts\python.exe")) {
    Write-INFO "Creating Python virtual environment..."
    & $pyExe -m venv $VENV_DIR
    Write-OK "Virtual environment created"
} else {
    Write-OK "Virtual environment already exists"
}

$venvPy  = "$VENV_DIR\Scripts\python.exe"
$venvPip = "$VENV_DIR\Scripts\pip.exe"

# Install Python dependencies
Write-INFO "Installing Python dependencies (may take a few minutes)..."
Push-Location "$INSTALL_DIR\backend"
try {
    $ErrorActionPreference = "Continue"
    & $venvPip install --upgrade pip --quiet
    $ErrorActionPreference = "Stop"
    & $venvPip install -r requirements.txt
    Write-OK "Python dependencies installed"
} finally { Pop-Location }

# Write .env
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254)" } |
    Select-Object -First 1).IPAddress

$corsOrigins = "http://localhost:3000,http://localhost:5173,http://${lanIP}:3000"
$envLines = @(
    "# QA Dashboard - Environment Variables",
    "",
    "JIRA_BASE_URL=https://avite.atlassian.net",
    "JIRA_USER_EMAIL=$jiraEmail",
    "JIRA_API_TOKEN=$jiraToken",
    "",
    "KONE_JIRA_BASE_URL=https://kabatone-ops-it.atlassian.net",
    "KONE_JIRA_EMAIL=$jiraEmail",
    "KONE_JIRA_TOKEN=$jiraToken",
    "",
    "ANTHROPIC_API_KEY=$anthropicKey",
    "",
    "ZOHO_DESK_TOKEN=$zohoToken",
    "ZOHO_ORG_ID=$zohoOrgId",
    "",
    "FIELD_MAPPING_PATH=./config/field_mapping.yaml",
    "CACHE_TTL_SECONDS=300",
    "BACKGROUND_REFRESH_HOURS=5",
    "DATABASE_URL=sqlite+aiosqlite:///./data/qa_dashboard.db",
    "LOG_LEVEL=INFO",
    "ENVIRONMENT=production",
    "EXPORT_MAX_ROWS=10000",
    "JIRA_MAX_RESULTS=100",
    "CORS_ORIGINS=$corsOrigins"
)
$envLines -join "`r`n" | Out-File -FilePath "$INSTALL_DIR\.env" -Encoding utf8 -Force
Write-OK ".env written"

# Build frontend
Write-INFO "Installing frontend dependencies..."
Push-Location "$INSTALL_DIR\frontend"
$ErrorActionPreference = "Continue"
try {
    npm install --silent
    Write-OK "Frontend packages installed"
    Write-INFO "Building frontend (production)..."
    npm run build
    Write-OK "Frontend built"
} finally {
    $ErrorActionPreference = "Stop"
    Pop-Location
}

# Create logs directory
New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null

# Write start-backend.ps1
$backendScript = @(
    '$envFile = "C:\qa-dashboard\.env"',
    'if (Test-Path $envFile) {',
    '    Get-Content $envFile | ForEach-Object {',
    '        if ($_ -match "^\s*([^#][^=]*?)\s*=\s*(.*)\s*$") {',
    '            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")',
    '        }',
    '    }',
    '}',
    'Set-Location "C:\qa-dashboard\backend"',
    'New-Item -ItemType Directory -Path "C:\qa-dashboard\data" -Force | Out-Null',
    '& "C:\qa-dashboard\venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 2>&1 | Tee-Object -FilePath "C:\qa-dashboard\logs\backend.log" -Append'
)
$backendScript -join "`r`n" | Out-File -FilePath "$INSTALL_DIR\deploy\start-backend.ps1" -Encoding utf8 -Force
Write-OK "start-backend.ps1 written"

# Write start-frontend.ps1
$npmPath = (Get-Command npm -ErrorAction SilentlyContinue)
$npmDir  = if ($npmPath) { Split-Path $npmPath.Source } else { "C:\Program Files\nodejs" }
$frontendScript = @(
    '$env:PATH = "' + $npmDir + ';' + "$env:APPDATA\npm" + ';$env:PATH"',
    'Set-Location "C:\qa-dashboard\frontend"',
    'New-Item -ItemType Directory -Path "C:\qa-dashboard\logs" -Force | Out-Null',
    'npx serve -s dist -l 3000 2>&1 | Tee-Object -FilePath "C:\qa-dashboard\logs\frontend.log" -Append'
)
$frontendScript -join "`r`n" | Out-File -FilePath "$INSTALL_DIR\deploy\start-frontend.ps1" -Encoding utf8 -Force
Write-OK "start-frontend.ps1 written"

Save-Resume @{
    REPO_TOKEN=$REPO_TOKEN; jiraEmail=$jiraEmail; jiraToken=$jiraToken
    anthropicKey=$anthropicKey; zohoToken=$zohoToken; zohoOrgId=$zohoOrgId; nextStep=5
}

# ── Step 5: Start services + auto-start tasks + firewall ──────────────────────
Write-Header "Step 5/5 - Start services and register auto-start"

function Register-AppTask {
    param([string]$Name, [string]$Script, [int]$DelaySeconds)
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
    $delay   = "PT" + $DelaySeconds + "S"
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                   -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = $delay
    $settings= New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 `
                   -RestartInterval (New-TimeSpan -Minutes 1) `
                   -ExecutionTimeLimit (New-TimeSpan -Hours 12)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -RunLevel Highest -Force | Out-Null
    Write-OK "Auto-start registered: $Name (delay: ${DelaySeconds}s)"
}

Register-AppTask "QA-Dashboard-Backend"  "$INSTALL_DIR\deploy\start-backend.ps1"  10
Register-AppTask "QA-Dashboard-Frontend" "$INSTALL_DIR\deploy\start-frontend.ps1" 25

# Firewall rules
foreach ($entry in @("QA Dashboard Frontend,3000", "QA Dashboard Backend,8000")) {
    $parts = $entry -split ","
    $rName = $parts[0]; $rPort = [int]$parts[1]
    if (-not (Get-NetFirewallRule -DisplayName $rName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $rName -Direction Inbound -Protocol TCP `
            -LocalPort $rPort -Action Allow -Profile Any | Out-Null
        Write-OK "Firewall: opened port $rPort ($rName)"
    } else {
        Write-OK "Firewall: port $rPort already open"
    }
}

# Start backend now
Write-INFO "Starting backend..."
Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$INSTALL_DIR\deploy\start-backend.ps1`""
Write-INFO "Waiting for backend to come up (up to 60 seconds)..."
$healthy = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep 5
    try {
        $r = Invoke-WebRequest "http://localhost:$BACKEND_PORT/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
}
if ($healthy) { Write-OK "Backend is up at http://localhost:$BACKEND_PORT" }
else { Write-FAIL "Backend didn't respond in 60s. Check: $LOG_DIR\backend.log" }

# Start frontend now
Write-INFO "Starting frontend..."
Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$INSTALL_DIR\deploy\start-frontend.ps1`""
Start-Sleep 5
Write-OK "Frontend started at http://localhost:$FRONTEND_PORT"

# Cleanup
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
Write-Host "  Logs:" -ForegroundColor Gray
Write-Host "    $LOG_DIR\backend.log" -ForegroundColor Gray
Write-Host "    $LOG_DIR\frontend.log" -ForegroundColor Gray
Write-Host ""
Write-Host "  To update: run .\deploy\update.ps1 as Admin" -ForegroundColor Gray
Write-Host ""

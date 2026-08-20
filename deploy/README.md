# QA Dashboard — Team Deployment Guide

## What this does
Installs Git, Python 3.11, and Node.js, clones the repo, builds the frontend,
and starts the backend + frontend as background services.
No Docker or virtualization required.

---

## First-time setup on a new PC

### Requirements
- Windows 10 / 11 (64-bit)
- Internet access for first install
- **Run as Administrator**

### Steps

1. **Copy `setup.ps1`** to the target PC (USB / network share / email from Loro)

2. **Right-click `setup.ps1` -> Run with PowerShell as Administrator**

3. **Enter credentials when prompted:**

   | Prompt | Value |
   |--------|-------|
   | GitHub access token | Get from Loro |
   | Jira email | `you@kabatone.com` |
   | Jira API token | Get from Jira profile > Security > API tokens |
   | Anthropic API key | Get from Loro (needed for AI Test Plans) |
   | Zoho token | Optional — press ENTER to skip |

4. **Wait** — setup installs tools, clones the repo, and builds everything.
   First run takes about 10-15 minutes.

5. When done, the script prints the URL and opens the dashboard.

---

## Access from any team PC

Once the dashboard PC is running, open a browser on **any PC in the same network**:

```
http://192.168.36.13:3000
```

> The dashboard server PC must be **on and not sleeping**.

---

## Update to latest version

When there is a new version pushed to GitHub, run **as Administrator** on the server PC:

```powershell
C:\qa-dashboard\deploy\update.ps1
```

Pulls latest code, updates deps, rebuilds frontend, restarts both services.
Takes about 2-5 minutes.

---

## Start / stop manually

Open **Admin PowerShell** in `C:\qa-dashboard\deploy\`:

```powershell
# Start
Start-ScheduledTask -TaskName "QA-Dashboard-Backend"
Start-ScheduledTask -TaskName "QA-Dashboard-Frontend"

# Stop
Stop-ScheduledTask -TaskName "QA-Dashboard-Backend"
Stop-ScheduledTask -TaskName "QA-Dashboard-Frontend"
```

Or run start scripts directly (visible window, useful for debugging):

```powershell
# Backend
powershell -ExecutionPolicy Bypass -File "C:\qa-dashboard\deploy\start-backend.ps1"

# Frontend (open a second Admin PowerShell)
powershell -ExecutionPolicy Bypass -File "C:\qa-dashboard\deploy\start-frontend.ps1"
```

---

## Logs

| File | Contents |
|------|---------|
| `C:\qa-dashboard\logs\backend.log` | Python API logs |
| `C:\qa-dashboard\logs\frontend.log` | Frontend server logs |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Permission denied" | Run PowerShell as Administrator |
| Backend not responding | Check `logs\backend.log` — usually a .env credential issue |
| Frontend shows blank page | Check `logs\frontend.log`; hard-refresh browser (Ctrl+Shift+R) |
| Port 3000 / 8000 already in use | `netstat -ano \| findstr :3000` then kill that PID |
| Can't reach from another PC | Check Windows Firewall — port 3000 must allow Inbound TCP |
| After update, page shows old version | Hard-refresh browser (Ctrl+Shift+R) |
| API errors in dashboard | Check `.env` credentials: `notepad C:\qa-dashboard\.env` |

---

## File locations

| Path | Contents |
|------|---------|
| `C:\qa-dashboard\` | Project files |
| `C:\qa-dashboard\.env` | API keys and config (keep private) |
| `C:\qa-dashboard\venv\` | Python virtual environment |
| `C:\qa-dashboard\frontend\dist\` | Built frontend (served by `serve`) |
| `C:\qa-dashboard\logs\` | Runtime logs |
| `C:\qa-dashboard\deploy\` | This guide and scripts |

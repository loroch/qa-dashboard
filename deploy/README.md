# QA Dashboard — Team Deployment Guide

## What this does
Installs Docker Desktop + Git, clones the repo, builds and starts the QA Dashboard,
opens the Windows Firewall, and registers an auto-start task so the dashboard
comes back up automatically after every reboot.

---

## First-time setup on a new PC

### Requirements
- Windows 10 / 11 (64-bit)
- Internet access for first install
- **Run as Administrator**

### Steps

1. **Copy `setup.ps1`** to the target PC (USB / network share / email)

2. **Right-click `setup.ps1` → Run with PowerShell as Administrator**
   (or open an Admin PowerShell and run `.\setup.ps1`)

3. **Enter credentials when prompted:**
   | Prompt | Value |
   |--------|-------|
   | Jira email | `loroc@kabatone.com` |
   | Jira API token | *(get from Loro or Jira profile → Security → API tokens)* |
   | Anthropic API key | *(get from Loro — needed for AI Test Plans / Handover Criteria)* |
   | Zoho token | *(optional — leave blank to skip)* |

4. **If Docker Desktop is being installed for the first time**, the script will
   ask you to reboot. After rebooting, run `setup.ps1` again — it will skip
   already-completed steps.

5. **First build takes 5–10 minutes** (downloading base images). Subsequent
   updates are much faster.

6. When done, the script prints:
   ```
   This machine:  http://localhost:3000
   Other PCs:     http://192.168.X.X:3000
   ```

---

## Access from any team PC

Once the dashboard PC is running, open a browser on **any PC in the same network**:

```
http://192.168.36.13:3000
```

> The dashboard server PC must be **on and not sleeping** for others to connect.

---

## Update to latest version

When there's a new version pushed to GitHub, run **as Administrator** on the server PC:

```powershell
C:\qa-dashboard\deploy\update.ps1
```

This pulls the latest code, rebuilds changed images, and restarts containers.
The update typically takes 1–3 minutes and the dashboard is briefly unavailable.

---

## Useful commands (run in `C:\qa-dashboard`)

| Command | Purpose |
|---------|---------|
| `docker-compose ps` | Show running containers |
| `docker-compose logs -f` | Stream live logs |
| `docker-compose down` | Stop the dashboard |
| `docker-compose up -d` | Start the dashboard |
| `docker-compose restart` | Restart all services |
| `docker logs qa-dashboard-api --tail 50` | Backend logs only |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Permission denied" | Run PowerShell as Administrator |
| Docker won't start | Open Docker Desktop manually; wait for whale icon in tray |
| Port 3000 already in use | `netstat -ano \| findstr :3000` → kill that PID |
| Can't reach from another PC | Check Windows Firewall — port 3000 must allow Inbound TCP |
| Dashboard loads but API errors | Check `.env` credentials: `notepad C:\qa-dashboard\.env` |
| After update, page shows old version | Hard-refresh browser (Ctrl+Shift+R) |

---

## File locations on the server PC

| Path | Contents |
|------|---------|
| `C:\qa-dashboard\` | Project files |
| `C:\qa-dashboard\.env` | API keys & config (keep private) |
| `C:\qa-dashboard\deploy\` | This guide + scripts |
| Docker volume `qa_data` | SQLite database (persisted across rebuilds) |

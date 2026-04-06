# QA Manager Dashboard

A production-ready QA management dashboard connected to **Jira** and **Zoho Desk**.  
Built for QA Managers to track team workload, ready-for-testing items, aging, blockers, bugs, Zoho tickets per project, and cross-referenced Zoho ↔ Jira reports — all in one place.

---

## Features

| Area | Feature |
|---|---|
| **Jira** | Ready for Testing items grouped by member / version / activity / priority |
| **Jira** | Team workload overview with overload/idle indicators |
| **Jira** | Aging report — Warning (3d) / Critical (7d) / Overdue (14d) |
| **Jira** | Blockers — Highest/Critical priority and blocker-labeled items |
| **Jira** | Bugs created in the last 30 days |
| **Jira** | 7-day trend charts + member workload bar chart |
| **Zoho Desk** | Tickets by department, assignee, status with date-range filter |
| **Zoho Desk** | By-project ticket counts with status breakdown |
| **Zoho Reports** | Zoho ↔ Jira cross-reference: Bug ID → Jira key, status, fix version, parent |
| **All pages** | Date range filter: All time / Last 1 month / Last 2 months / Last 3 months |
| **All pages** | Sort, filter, search, active filter chips |
| **Export** | CSV + Excel for all major views (tickets, linked report, changelog) |
| **Refresh** | Auto-refresh every 5 min (UI) + deep backend refresh every 5 hours |
| **Changelog** | Full audit trail of dashboard changes |

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Python | 3.11+ | Backend (FastAPI) |
| Node.js | 18+ | Frontend (React + Vite) |
| npm | 9+ | Frontend package manager |
| Docker + Docker Compose | any | Optional — containerized deployment |

---

## Project Structure

```
qa-dashboard/
├── backend/
│   └── app/
│       ├── main.py                   # FastAPI entry point + APScheduler
│       ├── config.py                 # All settings loaded from .env
│       ├── jira/
│       │   ├── client.py             # Async Jira REST API client (v3)
│       │   ├── queries.py            # All JQL queries (centralized)
│       │   └── field_mapper.py       # Maps raw Jira fields → dashboard models
│       ├── zoho/
│       │   ├── client.py             # Async Zoho Desk client (OAuth2 auto-refresh)
│       │   └── mapper.py             # Maps raw Zoho ticket fields → dashboard models
│       ├── services/
│       │   ├── dashboard_service.py  # Jira aggregation (RFT, aging, trends)
│       │   ├── zoho_service.py       # Zoho Desk aggregation (by dept, status, etc.)
│       │   ├── zoho_jira_service.py  # Cross-reference: Zoho Bug ID → Jira issue
│       │   ├── cache_service.py      # In-memory TTL cache with per-key locking
│       │   ├── changelog_service.py  # Audit trail stored in SQLite
│       │   └── export_service.py     # CSV + Excel export helpers
│       └── api/routes/
│           ├── dashboard.py          # /api/dashboard/*
│           ├── zoho.py               # /api/zoho/*
│           ├── changelog.py          # /api/changelog
│           ├── export.py             # /api/export/*
│           └── jira_meta.py          # /api/jira/*
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.jsx
│       │   ├── ReadyForTesting.jsx
│       │   ├── TeamOverview.jsx
│       │   ├── AgingReport.jsx
│       │   ├── BlockersPage.jsx
│       │   ├── BugsReport.jsx
│       │   ├── TrendsPage.jsx
│       │   ├── ZohoDeskPage.jsx      # Zoho tickets by dept / assignee / status
│       │   ├── ZohoReportsPage.jsx   # By-project report + Zoho ↔ Jira linked
│       │   └── Changelog.jsx
│       ├── components/               # Cards, charts, tables, layout, badges
│       ├── hooks/useAutoRefresh.js   # 5-minute auto-refresh
│       └── store/filterStore.js      # Zustand global filter state
├── config/
│   └── field_mapping.yaml            # ← Jira field IDs and team config
├── .env                              # ← Your credentials (never commit this)
├── .env.example                      # Template — copy and fill in
├── docker-compose.yml
└── CHANGELOG.md
```

---

## Setup — Local Development

### 1. Clone the repository

```bash
git clone https://github.com/loroch/qa-dashboard.git
cd qa-dashboard
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials:

```env
# ── Jira ──────────────────────────────────────────────────
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_USER_EMAIL=your.email@company.com
JIRA_API_TOKEN=your_jira_api_token

# ── Zoho Desk ─────────────────────────────────────────────
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REFRESH_TOKEN=your_zoho_refresh_token
ZOHO_DESK_PORTAL=your_portal_name          # e.g. cityshob
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_DESK_BASE_URL=https://desk.zoho.com
```

> See **"Getting API tokens"** section below for how to obtain each credential.

### 3. Start the backend

```bash
cd backend

# Create virtual environment
python -m venv .venv

# Activate it
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the server
python -m uvicorn app.main:app --reload --port 8000
```

Backend runs at: `http://localhost:8000`  
Interactive API docs: `http://localhost:8000/docs`

### 4. Start the frontend

Open a new terminal:

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at: `http://localhost:5173`

The Vite dev server automatically proxies all `/api` requests to `http://localhost:8000`.

---

## Setup — Docker (Recommended for Production)

### 1. Configure `.env` as described above

### 2. Build and launch

```bash
docker-compose up -d
```

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`

### 3. Check logs

```bash
docker-compose logs -f backend
docker-compose logs -f frontend
```

### 4. Stop

```bash
docker-compose down
```

---

## Getting API Tokens

### Jira API Token

1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Copy the token into `JIRA_API_TOKEN` in `.env`

### Zoho Desk OAuth Credentials

Zoho Desk uses OAuth2 with a long-lived refresh token.

**Step 1 — Create a Self Client**

1. Go to: https://api-console.zoho.com
2. Click **Add Client** → choose **Self Client**
3. Copy the **Client ID** and **Client Secret** into `.env`

**Step 2 — Generate a Grant Token**

In the Self Client console:
1. Click **Generate Code**
2. Set **Scope** to:
   ```
   Desk.tickets.READ,Desk.contacts.READ,Desk.agents.READ,Desk.search.READ
   ```
3. Set **Time Duration** to `10 minutes`
4. Click **Create** and copy the grant code

**Step 3 — Exchange for a Refresh Token**

Run this in a terminal (replace the values):

```bash
curl -X POST https://accounts.zoho.com/oauth/v2/token \
  -d "code=YOUR_GRANT_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://www.zoho.com" \
  -d "grant_type=authorization_code"
```

Copy the `refresh_token` from the response into `ZOHO_REFRESH_TOKEN` in `.env`.

> The refresh token does **not** expire. The dashboard will automatically exchange it for short-lived access tokens.

---

## Configuration — Jira Fields (`config/field_mapping.yaml`)

After starting the backend, discover your Jira custom field IDs:

```
GET http://localhost:8000/api/jira/fields
```

Search the response for field names like "QA Owner", "Sprint", "Story Points", then paste the IDs into `config/field_mapping.yaml`:

```yaml
jira:
  ready_for_testing_status: "Ready for Testing"   # ← exact Jira status name
  fields:
    sprint_field: "customfield_10020"
    epic_link_field: "customfield_10014"
    story_points: "story_points"
    qa_owner: null        # set if you have a custom QA Owner field
```

Reload config without restarting:

```
POST http://localhost:8000/api/jira/config/reload
```

---

## API Reference

### Jira / Dashboard

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/dashboard/summary` | Full dashboard (RFT, bugs, blockers, trends) |
| GET | `/api/dashboard/ready-for-testing` | RFT items only |
| GET | `/api/dashboard/bugs` | 30-day bugs |
| GET | `/api/dashboard/blockers` | Critical/blocker items |
| POST | `/api/dashboard/refresh` | Force full cache refresh |
| GET | `/api/jira/status` | Test Jira connection |
| GET | `/api/jira/fields` | List all Jira fields (for field ID discovery) |
| GET | `/api/jira/projects` | List accessible projects |
| POST | `/api/jira/config/reload` | Reload field_mapping.yaml |

### Zoho Desk

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/zoho/status` | Test Zoho Desk connection |
| GET | `/api/zoho/dashboard` | Tickets by dept, assignee, status |
| GET | `/api/zoho/tickets` | All tickets (flat list) |
| GET | `/api/zoho/reports/by-project` | Ticket counts grouped by project + status |
| GET | `/api/zoho/reports/linked` | Zoho ↔ Jira cross-reference report |
| GET | `/api/zoho/reports/linked/export/csv` | Export linked report as CSV |
| GET | `/api/zoho/reports/linked/export/excel` | Export linked report as Excel |
| GET | `/api/zoho/tickets/export/csv` | Export all Zoho tickets as CSV |
| POST | `/api/zoho/refresh` | Force refresh Zoho cache |

### Debug (Zoho field discovery)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/zoho/debug/fields` | List custom field API names |
| GET | `/api/zoho/debug/list-sample` | Raw `cf` fields from first 3 tickets |
| GET | `/api/zoho/debug/ticket/{id}` | Full raw ticket payload |

### Export / Changelog

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/export/ready-for-testing/csv` | RFT export CSV |
| GET | `/api/export/ready-for-testing/excel` | RFT export Excel |
| GET | `/api/export/bugs/csv` | Bugs export CSV |
| GET | `/api/changelog` | Paginated changelog |
| GET | `/api/export/changelog/excel` | Changelog export Excel |

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_BASE_URL` | ✅ | — | `https://company.atlassian.net` |
| `JIRA_USER_EMAIL` | ✅ | — | Jira account email |
| `JIRA_API_TOKEN` | ✅ | — | Jira API token |
| `ZOHO_CLIENT_ID` | ✅ | — | Zoho API console Client ID |
| `ZOHO_CLIENT_SECRET` | ✅ | — | Zoho API console Client Secret |
| `ZOHO_REFRESH_TOKEN` | ✅ | — | Zoho OAuth2 refresh token |
| `ZOHO_DESK_PORTAL` | ✅ | — | Zoho Desk portal name (subdomain) |
| `ZOHO_ACCOUNTS_URL` | | `https://accounts.zoho.com` | Zoho accounts endpoint |
| `ZOHO_DESK_BASE_URL` | | `https://desk.zoho.com` | Zoho Desk API base URL |
| `FIELD_MAPPING_PATH` | | `./config/field_mapping.yaml` | Path to Jira field config |
| `CACHE_TTL_SECONDS` | | `300` | Cache expiry (5 minutes) |
| `BACKGROUND_REFRESH_HOURS` | | `5` | Deep background refresh interval |
| `DATABASE_URL` | | SQLite `./data/qa_dashboard.db` | Changelog database |
| `CORS_ORIGINS` | | `http://localhost:5173` | Allowed frontend origins |
| `LOG_LEVEL` | | `INFO` | `DEBUG` / `INFO` / `WARNING` |
| `ENVIRONMENT` | | `development` | `development` disables API docs in prod |

---

## Verifying the Setup

After starting the backend, test connectivity:

```bash
# Jira connection
curl http://localhost:8000/api/jira/status

# Zoho Desk connection
curl http://localhost:8000/api/zoho/status
```

Both should return `{"ok": true, ...}`.

Then open the frontend (`http://localhost:5173` or `http://localhost:3000` with Docker) and you should see live data within a few seconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Backend won't start — missing env vars | Check `.env` exists at project root and all required variables are filled |
| Jira returns 401 | Check `JIRA_USER_EMAIL` and `JIRA_API_TOKEN` |
| Jira returns 410 Gone | The `/search` endpoint is deprecated — the client already uses `/search/jql` |
| Zoho returns 401 | Refresh token may have been revoked — regenerate from Zoho API console |
| Zoho returns 422 | Check that `ZOHO_DESK_PORTAL` matches your portal name exactly |
| No project names in Zoho | The custom field API name is `cf_site_name` — already mapped in `zoho/mapper.py` |
| Linked report returns empty | Tickets need a Bug ID (Zoho custom field `cf_bug_id`) pointing to a Jira key |
| `uvicorn` not found | Use `python -m uvicorn app.main:app --reload` instead of `uvicorn` directly |
| Frontend shows stale data | Click **Refresh** on any page, or call `POST /api/dashboard/refresh` |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, Pydantic v2, httpx (async) |
| Scheduler | APScheduler (background cache refresh) |
| Cache | In-memory TTL cache with per-key asyncio locking |
| Database | SQLite via SQLAlchemy async + aiosqlite (changelog) |
| Frontend | React 18, Vite, Tailwind CSS |
| Charts | Recharts |
| Data fetching | TanStack React Query v5 |
| State | Zustand |
| Deployment | Docker + Docker Compose |

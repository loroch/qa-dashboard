# QA Manager Dashboard

A production-ready QA management dashboard powered by Jira. Built for QA Managers to track team workload, ready-for-testing items, aging, blockers, bugs, and trends — all in one place.

---

## Features

| Feature | Details |
|---|---|
| Ready for Testing | All RFT items grouped by member, version, activity, priority |
| Team Workload | Per-member summary with overload/idle detection |
| Aging Report | Warning (3d) / Critical (7d) / Overdue (14d) |
| Blockers | Highest/Critical priority items and blocker-labeled items |
| Bugs (30d) | Bugs created by QA team in the last 30 days |
| Trend Charts | 7-day activity area chart + member workload bar chart |
| Auto Refresh | Every 5 minutes (UI) + every 5 hours (deep backend refresh) |
| Manual Refresh | Refresh button on every page |
| Export | CSV + Excel for all major views |
| Changelog | Full audit trail of dashboard and config changes |
| Filters | Project, assignee, version, status, priority, date range |

---

## Quick Start (Docker)

### 1. Clone and configure

```bash
git clone <repo-url>
cd qa-dashboard
cp .env.example .env
```

### 2. Fill in `.env`

```
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_USER_EMAIL=you@company.com
JIRA_API_TOKEN=your_api_token_here
```

Get your API token: https://id.atlassian.com/manage-profile/security/api-tokens

### 3. Configure Jira fields

Edit `config/field_mapping.yaml`:
- Update team member **display names** (IDs are already set)
- Update **project keys** if you want to limit scope
- Discover custom field IDs (see below) and fill in the `fields:` section

### 4. Launch

```bash
docker-compose up -d
```

Open: http://localhost:3000

API docs: http://localhost:8000/docs

---

## Discovering Custom Field IDs

After starting the backend, call:

```
GET http://localhost:8000/api/jira/fields
```

Search the response for your field names (e.g. "QA Owner", "Bundle", "Module") and copy the `id` value into `config/field_mapping.yaml`.

Then reload config without restarting:
```
POST http://localhost:8000/api/jira/config/reload
```

---

## Local Development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../.env.example .env      # fill in values
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev     # opens http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:8000`.

---

## Project Structure

```
qa-dashboard/
├── backend/
│   └── app/
│       ├── main.py                 # FastAPI entry point + scheduler
│       ├── config.py               # Settings from .env
│       ├── jira/
│       │   ├── client.py           # Async Jira REST API client
│       │   ├── queries.py          # All JQL queries (centralized)
│       │   └── field_mapper.py     # Maps Jira fields → dashboard models
│       ├── services/
│       │   ├── dashboard_service.py  # Business logic + aggregation
│       │   ├── cache_service.py      # TTL cache with locking
│       │   ├── changelog_service.py  # Audit trail (SQLite)
│       │   └── export_service.py     # CSV + Excel export
│       ├── api/routes/
│       │   ├── dashboard.py        # /api/dashboard/*
│       │   ├── changelog.py        # /api/changelog
│       │   ├── export.py           # /api/export/*
│       │   └── jira_meta.py        # /api/jira/*
│       ├── models/                 # Pydantic response models
│       └── database/               # SQLAlchemy async setup
├── frontend/
│   └── src/
│       ├── pages/                  # Dashboard, RFT, Team, Aging, Bugs, Trends, Changelog
│       ├── components/             # Cards, charts, tables, filters, layout
│       ├── services/api.js         # All API calls
│       ├── hooks/useAutoRefresh.js # 5-minute auto-refresh hook
│       └── store/filterStore.js    # Zustand filter state
├── config/
│   └── field_mapping.yaml          # ← Configure Jira fields here
├── docker-compose.yml
├── .env.example
└── CHANGELOG.md
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/dashboard/summary` | Full dashboard data |
| GET | `/api/dashboard/ready-for-testing` | RFT items only |
| GET | `/api/dashboard/bugs` | 30-day bugs |
| GET | `/api/dashboard/blockers` | Critical/blocker items |
| POST | `/api/dashboard/refresh` | Manual full refresh |
| GET | `/api/dashboard/cache/status` | Cache state |
| GET | `/api/changelog` | Paginated changelog |
| POST | `/api/changelog` | Record a change |
| GET | `/api/export/ready-for-testing/csv` | Export RFT as CSV |
| GET | `/api/export/ready-for-testing/excel` | Export RFT as Excel |
| GET | `/api/export/bugs/csv` | Export bugs as CSV |
| GET | `/api/export/changelog/excel` | Export changelog as Excel |
| GET | `/api/jira/status` | Test Jira connection |
| GET | `/api/jira/fields` | List all Jira fields (for discovery) |
| GET | `/api/jira/projects` | List accessible projects |
| POST | `/api/jira/config/reload` | Reload field mapping config |

---

## Configuration Reference

### `.env` variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_BASE_URL` | ✅ | — | `https://company.atlassian.net` |
| `JIRA_USER_EMAIL` | ✅ | — | Your Jira login email |
| `JIRA_API_TOKEN` | ✅ | — | Jira API token |
| `CACHE_TTL_SECONDS` | | 300 | Cache expiry (5 min) |
| `BACKGROUND_REFRESH_HOURS` | | 5 | Full refresh interval |
| `DATABASE_URL` | | SQLite | Changelog storage |
| `CORS_ORIGINS` | | localhost | Allowed frontend origins |

### `config/field_mapping.yaml`

Key sections:
- `ready_for_testing_status` — exact Jira status name
- `fields.*` — custom field IDs (discover via `/api/jira/fields`)
- `team_members` — update display names
- `projects` — limit to specific projects
- `aging.*` — aging thresholds in days

---

## Extending the Dashboard

### Add Confluence integration
1. Set `confluence.enabled: true` in `field_mapping.yaml`
2. Create `backend/app/services/confluence_service.py`
3. Add route in `backend/app/api/routes/confluence.py`
4. Import and include in `main.py`

### Add Email reports
1. Set `email.enabled: true` in `field_mapping.yaml`
2. Add SMTP env vars to `.env`
3. Create `backend/app/services/email_service.py`
4. Schedule via APScheduler in `main.py`

### Add Authentication
1. Add `python-jose` and `passlib` to `requirements.txt`
2. Create `backend/app/auth/` module
3. Add JWT middleware to `main.py`
4. The `changed_by` field in changelog is already ready for user tracking

### Switch to PostgreSQL
Change `DATABASE_URL` in `.env`:
```
DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/qa_dashboard
```

---

## Assumptions & Placeholders

| Item | Assumption | To fix |
|---|---|---|
| Status name | "Ready for Testing" | Update `ready_for_testing_status` in YAML |
| QA Owner field | Using assignee | Set `qa_owner` field ID in YAML |
| Test count | Not available | Set `test_count` field ID or enable Xray |
| Bundle/Module | Using Epic Link | Set `bundle_field` ID in YAML |
| Activity | Using first label | Set `activity_field` ID in YAML |
| Member names | "QA Engineer 1-5" | Update names in YAML `team_members` |

---

## Cloud Deployment

### AWS / GCP / Azure Container Apps
The `docker-compose.yml` structure maps directly to any container platform.

Key environment variables to set in your cloud secrets manager:
- `JIRA_API_TOKEN`
- `SECRET_KEY`
- `DATABASE_URL` (use managed PostgreSQL in production)

### Environment
- Set `ENVIRONMENT=production` to disable API docs
- Set `CORS_ORIGINS` to your production frontend domain
- Mount `config/field_mapping.yaml` as a config volume or ConfigMap

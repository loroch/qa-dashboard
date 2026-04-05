# QA Dashboard — Changelog

All notable changes to this project are documented here.
Format: [version] — [date] — [change type] — [description]

Change types: `design` | `backend` | `config` | `query` | `widget` | `jira`

---

## [1.0.0] — 2026-04-05 — Initial Release

### Added
- **design**: Full QA Manager Dashboard created
- **design**: Overview page with summary cards, trend chart, member workload
- **design**: Ready for Testing page with grouping by member / version / activity / priority
- **design**: Team Overview page with per-member drill-down
- **design**: Aging Report page (warning: 3d, critical: 7d, overdue: 14d)
- **design**: Blockers & Critical Items page
- **design**: Bugs (30 days) report page
- **design**: Trends page with 7-day activity area chart
- **design**: Changelog & Audit Trail page with export

- **backend**: FastAPI backend with async Jira REST API v3 integration
- **backend**: Dedicated Jira client layer (`jira/client.py`)
- **backend**: JQL query builder (`jira/queries.py`) — all queries centralized
- **backend**: Field mapper (`jira/field_mapper.py`) — no hardcoded field names
- **backend**: Cache service with 5-minute TTL and thundering-herd protection
- **backend**: Background refresh scheduler (every 5 hours via APScheduler)
- **backend**: Changelog service with SQLite persistence (upgradeable to PostgreSQL)
- **backend**: Export service (CSV + Excel with color-coded aging rows)
- **backend**: RESTful API: `/api/dashboard/*`, `/api/changelog`, `/api/export/*`, `/api/jira/*`

- **config**: `config/field_mapping.yaml` — all Jira field IDs and team member IDs
- **config**: `.env.example` — all environment variables documented
- **config**: No hardcoded Jira field IDs — all configurable via YAML

- **jira**: JQL queries: Ready for Testing, Bugs (30d), Blockers, Aging, Trend, Activity
- **jira**: Team member IDs: 5 QA engineers registered

- **query**: `issuetype = Bug AND created >= -30d AND creator in (<team>)`
- **query**: `status = "Ready for Testing" AND assignee in (<team>)`
- **query**: `priority in (Highest, Critical) AND status != Done AND assignee in (<team>)`

- **widget**: Summary cards: RFT count, Bugs 30d, Critical/Overdue, Tests Written, Overloaded members
- **widget**: Area chart: 7-day trend (created, RFT, bugs)
- **widget**: Bar chart: member workload
- **widget**: Sortable/paginated issue table with clickable Jira links
- **widget**: Aging timeline with color-coded severity rows
- **widget**: Changelog timeline with before/after value diff view

### Infrastructure
- Dockerfile for backend (Python 3.11 slim)
- Dockerfile for frontend (Node 20 + nginx)
- docker-compose.yml with health checks and named volumes
- SQLite for changelog (upgrade path to PostgreSQL documented)

### Assumptions (see config/field_mapping.yaml for details)
- "Ready for Testing" is the exact Jira status name
- QA Owner = Assignee (no custom qa_owner field configured yet)
- Test count = null (Xray not integrated yet)
- Bundle/Module = Epic Link (no custom bundle field configured yet)
- Activity = first label on the issue

---

## How to Record Changes

**Option 1 — Automatic (via API):**
POST /api/changelog with body:
```json
{
  "change_type": "config",
  "component": "field_mapping",
  "description": "Updated qa_owner field ID",
  "old_value": null,
  "new_value": "customfield_10200",
  "changed_by": "your.name@company.com",
  "version": "1.0.1"
}
```

**Option 2 — Via Dashboard UI:**
Go to Changelog page → entries are shown with before/after diffs.

**Option 3 — This file:**
Add a new version section above using the format shown.

**Change types:**
- `config` — field_mapping.yaml changes, env var changes
- `query` — JQL query changes
- `widget` — UI widget additions or modifications
- `design` — page layout, navigation, UX changes
- `backend` — service logic, API endpoint changes
- `jira` — Jira integration changes (new fields, new queries)

"""
Bug Triage / Priority Meeting service.
Fetches bugs by epic or date range, returns metadata for inline editing,
and applies single-field updates to Jira issues.
"""
import logging
import hashlib
from datetime import datetime, timezone

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

SPRINT_FIELD  = "customfield_10020"
EPIC_LK_FIELD = "customfield_10014"

BUG_FIELDS = [
    "summary", "status", "priority", "assignee", "reporter",
    "fixVersions", "parent", "labels", "created", "issuetype",
    SPRINT_FIELD, EPIC_LK_FIELD,
]


def _sprint_from_field(raw) -> dict | None:
    """Extract the active (or latest) sprint from the customfield value."""
    if not raw:
        return None
    entries = raw if isinstance(raw, list) else [raw]
    active = [s for s in entries if isinstance(s, dict) and s.get("state") == "active"]
    pick = active[0] if active else (entries[-1] if entries else None)
    if not pick or not isinstance(pick, dict):
        return None
    return {"id": pick.get("id"), "name": pick.get("name", ""), "state": pick.get("state", "")}


def _fmt_bug(issue: dict, jira_base_url: str) -> dict:
    f = issue.get("fields", {})
    sprint = _sprint_from_field(f.get(SPRINT_FIELD))
    parent_raw = f.get("parent") or {}
    parent_f   = parent_raw.get("fields") or {}

    return {
        "key":          issue["key"],
        "url":          f"{jira_base_url}/browse/{issue['key']}",
        "summary":      f.get("summary", ""),
        "status":       (f.get("status") or {}).get("name", ""),
        "priority":     (f.get("priority") or {}).get("name", ""),
        "assignee":     (f.get("assignee") or {}).get("displayName", ""),
        "assignee_id":  (f.get("assignee") or {}).get("accountId", ""),
        "reporter":     (f.get("reporter") or {}).get("displayName", ""),
        "reporter_id":  (f.get("reporter") or {}).get("accountId", ""),
        "fix_versions": [v["name"] for v in (f.get("fixVersions") or [])],
        "sprint":       sprint.get("name", "") if sprint else "",
        "sprint_id":    sprint.get("id")       if sprint else None,
        "parent_key":   parent_raw.get("key", ""),
        "parent_summary": parent_f.get("summary", ""),
        "parent_type":  (parent_f.get("issuetype") or {}).get("name", ""),
        "epic_link":    f.get(EPIC_LK_FIELD, "") or "",
        "labels":       f.get("labels") or [],
        "created":      f.get("created", ""),
    }


class BugTriageService:
    _board_id: int | None = None

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    async def _get_sprints(self) -> list[dict]:
        """Fetch active + future sprints for TMT0, caching the Scrum board ID."""
        try:
            if BugTriageService._board_id is None:
                # Filter for Scrum boards only — Kanban boards don't support sprints
                board_data = await self.jira.agile_get(
                    "/board", {"projectKeyOrId": "TMT0", "type": "scrum", "maxResults": 10}
                )
                boards = board_data.get("values", [])
                if not boards:
                    logger.warning("No Scrum boards found for TMT0")
                    return []
                BugTriageService._board_id = boards[0]["id"]
                logger.info(f"TMT0 Scrum board ID: {BugTriageService._board_id}")
            sprint_data = await self.jira.agile_get(
                f"/board/{BugTriageService._board_id}/sprint",
                {"state": "active,future", "maxResults": 50},
            )
            sprints = [
                {"id": s["id"], "name": s["name"], "state": s.get("state", "")}
                for s in sprint_data.get("values", [])
                if s.get("state") in ("active", "future")
            ]
            logger.info(f"Fetched {len(sprints)} sprints for TMT0")
            return sprints
        except Exception as e:
            logger.warning(f"Could not fetch sprints: {e}")
            BugTriageService._board_id = None  # reset so next call retries
            return []

    # ── Epic search ───────────────────────────────────────────────

    async def search_epics(self, q: str, max_results: int = 20) -> list[dict]:
        if not q or len(q.strip()) < 2:
            return []
        q_safe = q.replace('"', "").strip()
        if q_safe.upper().startswith("TMT0-"):
            jql = f'project = TMT0 AND issuetype = Epic AND (key = "{q_safe}" OR summary ~ "{q_safe}") ORDER BY updated DESC'
        else:
            jql = f'project = TMT0 AND issuetype = Epic AND summary ~ "{q_safe}*" ORDER BY updated DESC'
        try:
            issues_raw = await self.jira.search_issues(
                jql, fields=["summary", "status"], max_total=max_results
            )
        except Exception as e:
            logger.warning(f"Epic search failed: {e}")
            return []
        return [
            {
                "key":     i["key"],
                "url":     f"{self.jira_base_url}/browse/{i['key']}",
                "summary": i.get("fields", {}).get("summary", ""),
                "status":  (i.get("fields", {}).get("status") or {}).get("name", ""),
            }
            for i in issues_raw
        ]

    # ── Bug fetching ──────────────────────────────────────────────

    async def get_bugs_by_epics(
        self, epic_keys: list[str], force_refresh: bool = False
    ) -> list[dict]:
        cache_key = f"triage:epics:{hashlib.md5(','.join(sorted(epic_keys)).encode()).hexdigest()[:12]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            keys_clause = ", ".join(f'"{k}"' for k in epic_keys)
            jql = (
                f'project = TMT0 AND issuetype = Bug '
                f'AND parent in ({keys_clause}) ORDER BY priority ASC, created DESC'
            )
            raw = await self.jira.search_issues(jql, fields=BUG_FIELDS, max_total=500)
            return [_fmt_bug(i, self.jira_base_url) for i in raw]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    async def get_bugs_by_date(
        self,
        days: int,
        creators: list[str] | None = None,
        force_refresh: bool = False,
    ) -> list[dict]:
        creators_slug = "_".join(sorted(creators or []))
        cache_key = f"triage:date:{days}:{hashlib.md5(creators_slug.encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = f'project = TMT0 AND issuetype = Bug AND created >= "-{days}d"'
            if creators:
                ids = ", ".join(creators)
                jql += f' AND reporter in ({ids})'
            jql += ' ORDER BY priority ASC, created DESC'
            raw = await self.jira.search_issues(jql, fields=BUG_FIELDS, max_total=500)
            return [_fmt_bug(i, self.jira_base_url) for i in raw]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    async def get_creators(self, days: int = 30) -> list[dict]:
        """Return unique reporters for bugs opened in last N days."""
        cache_key = f"triage:creators:{days}"

        async def fetch():
            jql = f'project = TMT0 AND issuetype = Bug AND created >= "-{days}d" ORDER BY created DESC'
            raw = await self.jira.search_issues(jql, fields=["reporter"], max_total=500)
            seen: dict[str, str] = {}
            for i in raw:
                r = (i.get("fields", {}).get("reporter") or {})
                aid = r.get("accountId", "")
                name = r.get("displayName", "")
                if aid and aid not in seen:
                    seen[aid] = name
            return [{"id": aid, "name": name} for aid, name in seen.items()]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    # ── Meta (fix versions, sprints, assignees, priorities) ───────

    async def get_meta(self, force_refresh: bool = False) -> dict:
        cache_key = "triage:meta_base"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch_base():
            versions, priorities, assignees = [], [], []

            # Fix versions
            try:
                raw_v = await self.jira.get("/project/TMT0/versions")
                versions = [
                    {"id": v["id"], "name": v["name"], "released": v.get("released", False)}
                    for v in (raw_v or [])
                ]
                versions.sort(key=lambda x: (x["released"], x["name"]), reverse=True)
            except Exception as e:
                logger.warning(f"Failed to fetch versions: {e}")

            # Priorities
            try:
                raw_p = await self.jira.get("/priority")
                priorities = [{"id": p["id"], "name": p["name"]} for p in (raw_p or [])]
            except Exception as e:
                logger.warning(f"Failed to fetch priorities: {e}")
                priorities = [
                    {"id": "1", "name": "Highest"},
                    {"id": "2", "name": "High"},
                    {"id": "3", "name": "Medium"},
                    {"id": "4", "name": "Low"},
                    {"id": "5", "name": "Lowest"},
                ]

            # Assignees
            try:
                raw_a = await self.jira.get(
                    "/user/assignable/search",
                    {"project": "TMT0", "maxResults": 100},
                )
                assignees = [
                    {"id": u.get("accountId", ""), "name": u.get("displayName", "")}
                    for u in (raw_a or [])
                    if u.get("accountId")
                ]
            except Exception as e:
                logger.warning(f"Failed to fetch assignees: {e}")

            return {"versions": versions, "priorities": priorities, "assignees": assignees}

        base = await self.cache.get_or_fetch(cache_key, fetch_base, ttl=600)
        # Sprints are fetched fresh (short-lived data, changes during sprint meetings)
        sprints = await self._get_sprints()
        return {**base, "sprints": sprints}

    # ── Single-field update ───────────────────────────────────────

    async def update_field(self, key: str, field: str, value: str | None) -> dict:
        """Update a single Jira field on a bug."""
        payload: dict = {}

        if field == "priority":
            payload = {"priority": {"name": value} if value else None}

        elif field == "fix_version":
            payload = {"fixVersions": [{"name": value}] if value else []}

        elif field == "assignee":
            payload = {"assignee": {"accountId": value} if value else None}

        elif field == "sprint":
            # sprint_id is an integer
            payload = {SPRINT_FIELD: int(value) if value else None}

        elif field == "parent":
            payload = {"parent": {"key": value} if value else None}

        else:
            raise ValueError(f"Unknown field: {field}")

        await self.jira.put(f"/issue/{key}", json={"fields": payload})

        # Bust relevant caches
        for k in list(self.cache._store.keys()):
            if k.startswith("triage:"):
                self.cache.invalidate(k)

        return {"ok": True, "key": key, "field": field}

    # ── Parent search (for inline parent editor) ──────────────────

    async def search_parents(self, q: str) -> list[dict]:
        """Search Epics and Stories to use as parent."""
        if not q or len(q.strip()) < 2:
            return []
        q_safe = q.replace('"', "").strip()
        if q_safe.upper().startswith("TMT0-"):
            jql = f'project = TMT0 AND issuetype in (Epic, Story) AND (key = "{q_safe}" OR summary ~ "{q_safe}") ORDER BY updated DESC'
        else:
            jql = f'project = TMT0 AND issuetype in (Epic, Story) AND summary ~ "{q_safe}*" ORDER BY updated DESC'
        try:
            raw = await self.jira.search_issues(jql, fields=["summary", "issuetype"], max_total=15)
        except Exception:
            return []
        return [
            {
                "key":     i["key"],
                "summary": i.get("fields", {}).get("summary", ""),
                "type":    (i.get("fields", {}).get("issuetype") or {}).get("name", ""),
            }
            for i in raw
        ]


_service: BugTriageService | None = None


def get_bug_triage_service() -> BugTriageService:
    global _service
    if _service is None:
        _service = BugTriageService()
    return _service

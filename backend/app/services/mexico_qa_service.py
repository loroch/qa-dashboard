"""
Mexico QA Team Dashboard service.
Tracks QA work and bugs for Ana Jacob and Rubi Lopez across CS / KB / KM projects.
"""
import asyncio
import logging
import hashlib

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

MEXICO_QA_TEAM = ["Ana Jacob", "Rubi Lopez"]
QA_PROJECTS    = ["CS", "KB", "KM"]
ALL_PROJECTS   = ["CS", "KB", "KM", "TMT0"]

# Epics pinned from the active release plan (Paloma's Slack message)
PINNED_EPIC_KEYS = [
    "CS-12643",  # K1-Dispatch Stabilization Operator Module
    "KB-559",    # K1-BI V1.0.0
    "KM-984",    # K1-Mobile BCS App
    "KB-749",    # K1-BI V2.0.0 / Reportes K-Dispatch fase 1
    "CS-12605",  # K1-Dispatch V3.6.0
]

ISSUE_FIELDS = [
    "summary", "description", "status", "priority", "assignee", "reporter",
    "issuetype", "created", "updated", "parent", "fixVersions", "versions",
    "customfield_10020",   # Sprint
    "customfield_10014",   # Epic Link (classic projects)
]


def _adf_to_text(adf, max_chars: int = 600) -> str:
    """Extract plain text from Atlassian Document Format (ADF)."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf[:max_chars]
    parts: list[str] = []

    def _walk(node):
        if not isinstance(node, dict):
            return
        if node.get("type") == "text":
            parts.append(node.get("text", ""))
        for child in node.get("content") or []:
            _walk(child)

    _walk(adf)
    text = " ".join(p.strip() for p in parts if p.strip())
    return text[:max_chars]


def _fmt_issue(issue: dict, base_url: str) -> dict:
    f = issue.get("fields", {})
    sprint_raw = f.get("customfield_10020") or []
    sprint_items = sprint_raw if isinstance(sprint_raw, list) else [sprint_raw]
    active = [s for s in sprint_items if isinstance(s, dict) and s.get("state") == "active"]
    sprint = (active[0] if active else sprint_items[-1] if sprint_items else None)
    sprint_name = sprint.get("name", "") if isinstance(sprint, dict) else ""

    parent_raw = f.get("parent") or {}
    parent_f   = parent_raw.get("fields") or {}

    return {
        "key":              issue["key"],
        "url":              f"{base_url}/browse/{issue['key']}",
        "summary":          f.get("summary", ""),
        "description":      _adf_to_text(f.get("description")),
        "status":           (f.get("status") or {}).get("name", ""),
        "priority":         (f.get("priority") or {}).get("name", ""),
        "type":             (f.get("issuetype") or {}).get("name", ""),
        "assignee":         (f.get("assignee") or {}).get("displayName", ""),
        "assignee_id":      (f.get("assignee") or {}).get("accountId", ""),
        "reporter":         (f.get("reporter") or {}).get("displayName", ""),
        "reporter_id":      (f.get("reporter") or {}).get("accountId", ""),
        "fix_versions":     [v["name"] for v in (f.get("fixVersions") or [])],
        "found_in_versions":[v["name"] for v in (f.get("versions") or [])],
        "sprint":           sprint_name,
        "parent_key":       parent_raw.get("key", ""),
        "parent_summary":   parent_f.get("summary", ""),
        "parent_type":      (parent_f.get("issuetype") or {}).get("name", ""),
        "created":          f.get("created", ""),
        "updated":          f.get("updated", ""),
    }


def _fmt_epic(issue: dict, base_url: str) -> dict:
    f = issue.get("fields", {})
    project = issue["key"].split("-")[0]
    return {
        "key":     issue["key"],
        "url":     f"{base_url}/browse/{issue['key']}",
        "summary": f.get("summary", ""),
        "status":  (f.get("status") or {}).get("name", ""),
        "project": project,
        "assignee": (f.get("assignee") or {}).get("displayName", ""),
    }


class MexicoQAService:
    _team: list[dict] | None = None   # cached member list with account IDs

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    # ── Team lookup ──────────────────────────────────────────────────

    async def get_team(self, force_refresh: bool = False) -> list[dict]:
        """Resolve Ana Jacob & Rubi Lopez to Jira account IDs."""
        if MexicoQAService._team is not None and not force_refresh:
            return MexicoQAService._team

        members = []
        for name in MEXICO_QA_TEAM:
            try:
                results = await self.jira.get("/user/search", {"query": name, "maxResults": 5})
                if results:
                    u = results[0]
                    members.append({
                        "name":   u.get("displayName", name),
                        "id":     u.get("accountId", ""),
                        "email":  u.get("emailAddress", ""),
                        "avatar": (u.get("avatarUrls") or {}).get("48x48", ""),
                    })
                else:
                    logger.warning(f"Mexico QA: user not found: {name}")
                    members.append({"name": name, "id": "", "email": "", "avatar": ""})
            except Exception as e:
                logger.warning(f"Mexico QA: user lookup failed for {name}: {e}")
                members.append({"name": name, "id": "", "email": "", "avatar": ""})

        MexicoQAService._team = members
        logger.info(f"Mexico QA team resolved: {[m['name'] for m in members]}")
        return members

    # ── Pinned epics ─────────────────────────────────────────────────

    async def get_pinned_epics(self, force_refresh: bool = False) -> list[dict]:
        """Fetch the fixed set of release-plan epics."""
        cache_key = "mxqa:pinned_epics"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            keys_clause = ", ".join(f'"{k}"' for k in PINNED_EPIC_KEYS)
            jql = f'key in ({keys_clause}) ORDER BY key ASC'
            try:
                raw = await self.jira.search_issues(
                    jql, fields=["summary", "status", "assignee", "project"], max_total=20
                )
            except Exception as e:
                logger.warning(f"Mexico QA pinned epics fetch failed: {e}")
                return []
            # Return in the same order as PINNED_EPIC_KEYS
            by_key = {i["key"]: _fmt_epic(i, self.jira_base_url) for i in raw}
            return [by_key[k] for k in PINNED_EPIC_KEYS if k in by_key]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    # ── Epic search ──────────────────────────────────────────────────

    async def search_epics(self, q: str, max_results: int = 20) -> list[dict]:
        if not q or len(q.strip()) < 2:
            return []
        q_safe = q.replace('"', "").strip()
        proj = ", ".join(QA_PROJECTS)
        key_prefix = q_safe.upper().split("-")[0]
        if key_prefix in QA_PROJECTS + ["TMT0"]:
            jql = (
                f'project in ({proj}, TMT0) AND issuetype = Epic '
                f'AND (key = "{q_safe}" OR summary ~ "{q_safe}") ORDER BY updated DESC'
            )
        else:
            jql = (
                f'project in ({proj}) AND issuetype = Epic '
                f'AND summary ~ "{q_safe}*" ORDER BY updated DESC'
            )
        try:
            raw = await self.jira.search_issues(
                jql, fields=["summary", "status", "assignee", "project"], max_total=max_results
            )
        except Exception as e:
            logger.warning(f"Mexico QA epic search failed: {e}")
            return []
        return [_fmt_epic(i, self.jira_base_url) for i in raw]

    # ── Epic work (QA tasks + bugs) ──────────────────────────────────

    async def get_epic_work(
        self, epic_key: str, member_ids: list[str], force_refresh: bool = False
    ) -> dict:
        """Return QA tasks/tests and bugs under an epic for the team."""
        cache_key = f"mxqa:epic:{epic_key}:{hashlib.md5(','.join(sorted(member_ids)).encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            ids_clause = ", ".join(f'"{m}"' for m in member_ids if m)
            if not ids_clause:
                return {"tasks": [], "bugs": []}

            # QA tasks/tests: non-bug issues assigned to team under this epic
            jql_tasks = (
                f'parent = "{epic_key}" '
                f'AND assignee in ({ids_clause}) '
                f'AND issuetype not in (Bug) '
                f'ORDER BY updated DESC'
            )
            # Bugs: reported OR assigned to team under this epic
            jql_bugs = (
                f'parent = "{epic_key}" '
                f'AND issuetype = Bug '
                f'AND (reporter in ({ids_clause}) OR assignee in ({ids_clause})) '
                f'ORDER BY created DESC'
            )

            tasks_raw, bugs_raw = await asyncio.gather(
                self.jira.search_issues(jql_tasks, fields=ISSUE_FIELDS, max_total=200),
                self.jira.search_issues(jql_bugs,  fields=ISSUE_FIELDS, max_total=200),
            )
            return {
                "tasks": [_fmt_issue(i, self.jira_base_url) for i in tasks_raw],
                "bugs":  [_fmt_issue(i, self.jira_base_url) for i in bugs_raw],
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    # ── Bugs by date ─────────────────────────────────────────────────

    async def get_bugs_by_date(
        self, days: int, member_ids: list[str], force_refresh: bool = False
    ) -> list[dict]:
        ids_slug = hashlib.md5(",".join(sorted(member_ids)).encode()).hexdigest()[:8]
        cache_key = f"mxqa:bugs:{days}:{ids_slug}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            ids_clause = ", ".join(f'"{m}"' for m in member_ids if m)
            if not ids_clause:
                return []
            proj = ", ".join(ALL_PROJECTS)
            jql = (
                f'project in ({proj}) AND issuetype = Bug '
                f'AND reporter in ({ids_clause}) '
                f'AND created >= "-{days}d" '
                f'ORDER BY created DESC'
            )
            raw = await self.jira.search_issues(jql, fields=ISSUE_FIELDS, max_total=500)
            return [_fmt_issue(i, self.jira_base_url) for i in raw]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    # ── Assigned work by date ────────────────────────────────────────

    async def get_assigned_by_date(
        self, days: int, member_ids: list[str], force_refresh: bool = False
    ) -> dict:
        """
        Return all issues currently assigned to each team member that were
        updated (active work) within the last N days, grouped by assignee.
        """
        ids_slug = hashlib.md5(",".join(sorted(member_ids)).encode()).hexdigest()[:8]
        cache_key = f"mxqa:assigned:{days}:{ids_slug}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            ids_clause = ", ".join(f'"{m}"' for m in member_ids if m)
            if not ids_clause:
                return {}
            proj = ", ".join(ALL_PROJECTS)
            jql = (
                f'project in ({proj}) '
                f'AND assignee in ({ids_clause}) '
                f'AND updated >= "-{days}d" '
                f'ORDER BY updated DESC'
            )
            raw = await self.jira.search_issues(jql, fields=ISSUE_FIELDS, max_total=500)
            issues = [_fmt_issue(i, self.jira_base_url) for i in raw]
            # Group by assignee
            grouped: dict[str, list] = {}
            for issue in issues:
                name = issue["assignee"] or "Unassigned"
                grouped.setdefault(name, []).append(issue)
            return grouped

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=120)


_service: MexicoQAService | None = None


def get_mexico_qa_service() -> MexicoQAService:
    global _service
    if _service is None:
        _service = MexicoQAService()
    return _service

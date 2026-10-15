"""
Investigation service.
Fetches Jira changelog per issue and extracts key milestone dates:
  - todo_date    : first transition TO "To Do"
  - rft_date     : first transition TO "Ready for Testing"
  - post_rft_date: first transition OUT OF "Ready for Testing"
"""
import logging
from datetime import datetime, timezone

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

RFT_STATUS  = "Ready for Testing"
TODO_STATUS = "To Do"

# Statuses that mean "ready to ship" — first time the issue reaches any of these
# is when R&D's job is considered done for estimation comparison purposes.
DEPLOY_STATUSES = {
    "done", "closed", "resolved", "released", "deployed",
    "ready for deployment", "ready to deploy", "approved",
}


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


class InvestigationService:

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    def _issue_url(self, key: str) -> str:
        return f"{self.jira_base_url}/browse/{key}"

    async def get_timeline(self, keys: list[str], force_refresh: bool = False) -> list[dict]:
        import hashlib
        cache_key = f"investigation:timeline:{hashlib.md5(','.join(sorted(keys)).encode()).hexdigest()[:12]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            results = []
            for key in keys:
                item = await self._build_timeline_item(key)
                if item:
                    results.append(item)
            return results

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def _build_timeline_item(self, key: str) -> dict | None:
        try:
            issue = await self.jira.get_issue(
                key,
                fields=[
                    "summary", "status", "issuetype", "created", "assignee", "priority", "parent",
                    "customfield_10016", "timeoriginalestimate", "story_points",
                ],
            )
        except Exception as e:
            logger.warning(f"Failed to fetch issue {key}: {e}")
            return None

        f = issue.get("fields", {})
        created_dt = _parse_dt(f.get("created"))

        # Fetch changelog — single call (Jira returns up to 100 entries by default)
        transitions: list[dict] = []
        try:
            cl = await self.jira.get_issue_changelog(key)
            for entry in cl.get("values", []):
                ts = _parse_dt(entry.get("created"))
                for item in entry.get("items", []):
                    if item.get("field") == "status":
                        transitions.append({
                            "dt":   ts,
                            "from": item.get("fromString", ""),
                            "to":   item.get("toString", ""),
                        })
            # Handle pagination if there are more entries
            if not cl.get("isLast", True):
                start_at = len(cl.get("values", []))
                while True:
                    page = await self.jira.get(
                        f"/issue/{key}/changelog",
                        params={"startAt": start_at, "maxResults": 100},
                    )
                    for entry in page.get("values", []):
                        ts = _parse_dt(entry.get("created"))
                        for item in entry.get("items", []):
                            if item.get("field") == "status":
                                transitions.append({
                                    "dt":   ts,
                                    "from": item.get("fromString", ""),
                                    "to":   item.get("toString", ""),
                                })
                    if page.get("isLast", True) or not page.get("values"):
                        break
                    start_at += len(page.get("values", []))
        except Exception as e:
            logger.warning(f"Failed to fetch changelog for {key}: {e}")

        transitions.sort(key=lambda x: x["dt"] or datetime.min.replace(tzinfo=timezone.utc))

        todo_dt         = None
        dev_start_dt    = None   # first transition OUT of "To Do" (dev actually begins)
        rft_dt          = None
        post_rft_dt     = None
        post_rft_status = None
        deploy_dt       = None   # first transition TO a deployment-ready status

        for t in transitions:
            if t["to"] == TODO_STATUS and todo_dt is None:
                todo_dt = t["dt"]
            if t["from"] == TODO_STATUS and dev_start_dt is None:
                dev_start_dt = t["dt"]
            if t["to"] == RFT_STATUS and rft_dt is None:
                rft_dt = t["dt"]
            if t["from"] == RFT_STATUS and post_rft_dt is None:
                post_rft_dt    = t["dt"]
                post_rft_status = t["to"]
            if deploy_dt is None and t["to"].lower() in DEPLOY_STATUSES:
                deploy_dt = t["dt"]

        if todo_dt is None:
            todo_dt = created_dt

        parent_raw = f.get("parent") or {}
        parent_f   = parent_raw.get("fields") or {}

        # R&D estimation: story points (customfield_10016) or original time estimate
        sp_raw = f.get("customfield_10016") or f.get("story_points")
        story_points = float(sp_raw) if sp_raw is not None else None

        time_est_sec = f.get("timeoriginalestimate")
        estimated_hours = round(time_est_sec / 3600, 1) if time_est_sec else None

        # Actual cycle: from leaving "To Do" → deploy-ready (Done/Closed/etc.)
        # Falls back to → now if still in progress.
        now_dt = datetime.now(timezone.utc)
        actual_dev_days = None
        cycle_end_dt = deploy_dt  # prefer deploy date as the definitive end
        if dev_start_dt:
            end = cycle_end_dt or now_dt
            actual_dev_days = round((end - dev_start_dt).total_seconds() / 86400, 1)

        return {
            "key":             key,
            "url":             self._issue_url(key),
            "summary":         f.get("summary", ""),
            "type":            (f.get("issuetype") or {}).get("name", ""),
            "status":          (f.get("status") or {}).get("name", ""),
            "assignee":        ((f.get("assignee") or {}).get("displayName") or ""),
            "priority":        (f.get("priority") or {}).get("name", ""),
            "created":         _iso(created_dt),
            "todo_date":       _iso(todo_dt),
            "dev_start_date":  _iso(dev_start_dt),
            "rft_date":        _iso(rft_dt),
            "post_rft_date":   _iso(post_rft_dt),
            "post_rft_status": post_rft_status,
            "deploy_date":     _iso(deploy_dt),
            "is_deployed":     deploy_dt is not None,
            "parent_key":      parent_raw.get("key", ""),
            "parent_summary":  parent_f.get("summary", ""),
            "story_points":    story_points,
            "estimated_hours": estimated_hours,
            "actual_dev_days": actual_dev_days,
        }

    async def search_issues(
        self,
        q: str,
        types: list[str] | None = None,
        max_results: int = 20,
    ) -> list[dict]:
        if not q or len(q.strip()) < 2:
            return []
        q_safe     = q.replace('"', "").strip()
        type_filter = ", ".join(types) if types else "Epic, Story, Bug"

        if q_safe.upper().startswith("TMT0-"):
            jql = (
                f'project = TMT0 AND issuetype in ({type_filter}) '
                f'AND (key = "{q_safe}" OR summary ~ "{q_safe}") ORDER BY updated DESC'
            )
        else:
            jql = (
                f'project = TMT0 AND issuetype in ({type_filter}) '
                f'AND summary ~ "{q_safe}*" ORDER BY updated DESC'
            )
        try:
            issues_raw = await self.jira.search_issues(
                jql,
                fields=["summary", "status", "issuetype"],
                max_total=max_results,
            )
        except Exception as e:
            logger.warning(f"Search failed for q={q!r}: {e}")
            return []

        return [
            {
                "key":     issue["key"],
                "url":     self._issue_url(issue["key"]),
                "summary": issue.get("fields", {}).get("summary", ""),
                "type":    (issue.get("fields", {}).get("issuetype") or {}).get("name", ""),
                "status":  (issue.get("fields", {}).get("status") or {}).get("name", ""),
            }
            for issue in issues_raw
        ]

    async def get_children(self, parent_key: str, issue_types: list[str]) -> list[dict]:
        import hashlib
        type_slug = "_".join(sorted(issue_types))
        cache_key = f"investigation:children:{hashlib.md5((parent_key + type_slug).encode()).hexdigest()[:10]}"

        async def fetch():
            types_str = ", ".join(issue_types)
            jql       = f'parent = "{parent_key}" AND issuetype in ({types_str}) ORDER BY created DESC'
            issues_raw = await self.jira.search_issues(
                jql,
                fields=["summary", "status", "issuetype", "parent"],
                max_total=200,
            )
            return [
                {
                    "key":        issue["key"],
                    "url":        self._issue_url(issue["key"]),
                    "summary":    issue.get("fields", {}).get("summary", ""),
                    "type":       (issue.get("fields", {}).get("issuetype") or {}).get("name", ""),
                    "status":     (issue.get("fields", {}).get("status") or {}).get("name", ""),
                    "parent_key": (issue.get("fields", {}).get("parent") or {}).get("key", ""),
                }
                for issue in issues_raw
            ]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_epic_bugs(self, epic_key: str, force_refresh: bool = False) -> list[dict]:
        import hashlib
        cache_key = f"investigation:epic_bugs:{hashlib.md5(epic_key.encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND issuetype = Bug AND parent = "{epic_key}" '
                f'ORDER BY created DESC'
            )
            issues_raw = await self.jira.search_issues(
                jql,
                fields=["summary", "status"],
                max_total=200,
            )
            return [
                {
                    "key":     issue["key"],
                    "url":     self._issue_url(issue["key"]),
                    "summary": issue.get("fields", {}).get("summary", ""),
                    "type":    "Bug",
                    "status":  (issue.get("fields", {}).get("status") or {}).get("name", ""),
                }
                for issue in issues_raw
            ]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_issues_by_version(self, version: str, types: list[str]) -> list[dict]:
        """All Epics/Stories for a fix version — used by the VersionLoader panel."""
        import hashlib
        type_slug = "_".join(sorted(types))
        cache_key = f"investigation:by_version:{hashlib.md5((version + type_slug).encode()).hexdigest()[:10]}"

        async def fetch():
            types_str = ", ".join(types)
            jql = (
                f'project = TMT0 AND issuetype in ({types_str}) '
                f'AND fixVersion = "{version}" ORDER BY issuetype ASC, key ASC'
            )
            issues_raw = await self.jira.search_issues(
                jql,
                fields=["summary", "status", "issuetype", "parent"],
                max_total=500,
            )
            return [
                {
                    "key":        i["key"],
                    "url":        self._issue_url(i["key"]),
                    "summary":    i.get("fields", {}).get("summary", ""),
                    "type":       (i.get("fields", {}).get("issuetype") or {}).get("name", ""),
                    "status":     (i.get("fields", {}).get("status") or {}).get("name", ""),
                    "parent_key": (i.get("fields", {}).get("parent") or {}).get("key", ""),
                }
                for i in issues_raw
            ]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)


_service: InvestigationService | None = None


def get_investigation_service() -> InvestigationService:
    global _service
    if _service is None:
        _service = InvestigationService()
    return _service

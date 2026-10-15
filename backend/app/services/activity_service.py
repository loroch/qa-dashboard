"""
QA Activity Service — changelog-based report of who moved what, when.
"""
import asyncio
import hashlib
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache

logger = logging.getLogger(__name__)

DONE_STATUSES = {"Done", "DONE", "Closed", "Removed", "Won't Fix", "Resolved"}
RFT_STATUSES  = {"Ready for Testing", "Ready For Testing", "ReadyForTesting"}
EXEC_STATUSES = {"In Progress", "Passed", "Failed", "Blocked", "Done", "DONE"}


def _parse_jira_dt(s: str) -> datetime:
    """Parse Jira ISO timestamp to UTC datetime."""
    if not s:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


class ActivityService:
    def __init__(self):
        self.jira        = get_jira_client()
        self.cache       = get_cache()
        self._base_url   = None

    @property
    def jira_base_url(self) -> str:
        if self._base_url is None:
            self._base_url = getattr(self.jira, "base_url", "https://avite.atlassian.net")
        return self._base_url

    # ── Public ─────────────────────────────────────────────────────────────────

    async def get_activity_report(
        self,
        days: int = 7,
        version: Optional[str] = None,
        scope_key: Optional[str] = None,   # epic or story key
        force_refresh: bool = False,
    ) -> dict:
        h = hashlib.md5(f"{days}|{version}|{scope_key}".encode()).hexdigest()[:8]
        cache_key = f"activity:report:{h}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            since = datetime.now(timezone.utc) - timedelta(days=days)
            time_str = f"-{days}d"

            base_parts = [f'project = TMT0', f'updated >= "{time_str}"']
            if version:
                base_parts.append(f'fixVersion = "{version}"')
            if scope_key:
                # could be epic or story — check both parent-of and self
                base_parts.append(
                    f'(issueKey = "{scope_key}" OR parent = "{scope_key}" '
                    f'OR "Epic Link" = "{scope_key}")'
                )
            base_jql = " AND ".join(base_parts)

            # Parallel: bugs, stories, tests — each with changelog
            bugs_jql    = base_jql + ' AND issuetype = Bug    ORDER BY updated DESC'
            stories_jql = base_jql + ' AND issuetype = Story  ORDER BY updated DESC'
            tests_jql   = base_jql + ' AND issuetype = Test   ORDER BY updated DESC'

            bugs_raw, stories_raw, tests_raw = await asyncio.gather(
                self._search_changelog(bugs_jql,    max_issues=300),
                self._search_changelog(stories_jql, max_issues=300),
                self._search_changelog(tests_jql,   max_issues=500),
            )

            bugs_report    = self._process_issues(bugs_raw,    since, "Bug")
            stories_report = self._process_issues(stories_raw, since, "Story")
            tests_report   = self._process_issues(tests_raw,   since, "Test")

            # Summary
            bugs_closed = sum(
                1 for b in bugs_raw
                if any(
                    _parse_jira_dt(h2["created"]) >= since
                    and any(
                        it["field"] == "status" and it.get("toString","") in DONE_STATUSES
                        for it in h2["items"]
                    )
                    for h2 in (b.get("changelog") or {}).get("histories", [])
                )
            )
            bugs_opened = sum(
                1 for b in bugs_raw
                if _parse_jira_dt((b.get("fields") or {}).get("created","")) >= since
            )
            stories_rft = sum(
                1 for s in stories_raw
                if any(
                    _parse_jira_dt(h2["created"]) >= since
                    and any(
                        it["field"] == "status" and it.get("toString","") in RFT_STATUSES
                        for it in h2["items"]
                    )
                    for h2 in (s.get("changelog") or {}).get("histories", [])
                )
            )
            stories_done = sum(
                1 for s in stories_raw
                if any(
                    _parse_jira_dt(h2["created"]) >= since
                    and any(
                        it["field"] == "status" and it.get("toString","") in DONE_STATUSES
                        for it in h2["items"]
                    )
                    for h2 in (s.get("changelog") or {}).get("histories", [])
                )
            )
            tests_added = sum(
                1 for t in tests_raw
                if _parse_jira_dt((t.get("fields") or {}).get("created","")) >= since
            )
            tests_executed = sum(
                1 for t in tests_raw
                if any(
                    _parse_jira_dt(h2["created"]) >= since
                    and any(it["field"] == "status" for it in h2["items"])
                    for h2 in (t.get("changelog") or {}).get("histories", [])
                )
            )

            def _issue_row(issue):
                f = issue.get("fields") or {}
                key = issue["key"]
                parent = f.get("parent") or {}
                pf = parent.get("fields") or {}
                return {
                    "key":          key,
                    "summary":      f.get("summary", ""),
                    "url":          f"{self.jira_base_url}/browse/{key}",
                    "created":      f.get("created", ""),
                    "status":       (f.get("status") or {}).get("name", ""),
                    "epic_key":     parent.get("key", ""),
                    "epic_summary": pf.get("summary", ""),
                    "epic_url":     f"{self.jira_base_url}/browse/{parent['key']}" if parent.get("key") else "",
                }

            tests_created_list = [
                _issue_row(t) for t in tests_raw
                if _parse_jira_dt((t.get("fields") or {}).get("created", "")) >= since
            ]
            bugs_opened_list = [
                _issue_row(b) for b in bugs_raw
                if _parse_jira_dt((b.get("fields") or {}).get("created", "")) >= since
            ]

            # ── Daily trend data ───────────────────────────────────────────
            REOPEN_STATUSES = {"Reopened", "Open"}
            trend_days = {}
            for i in range(days):
                d = (datetime.now(timezone.utc) - timedelta(days=days - 1 - i)).date()
                trend_days[str(d)] = {
                    "date": str(d),
                    "bugs_opened": 0,
                    "done": 0,
                    "rft": 0,
                    "reopened": 0,
                    "rfd": 0,
                }

            # Bugs opened: use created field
            for b in bugs_raw:
                created_dt = _parse_jira_dt((b.get("fields") or {}).get("created", ""))
                if created_dt >= since:
                    key = str(created_dt.date())
                    if key in trend_days:
                        trend_days[key]["bugs_opened"] += 1

            # Status transitions: bucket by changelog date
            for b in bugs_raw:
                for h2 in (b.get("changelog") or {}).get("histories", []):
                    hist_dt = _parse_jira_dt(h2.get("created", ""))
                    if hist_dt < since:
                        continue
                    day_key = str(hist_dt.date())
                    if day_key not in trend_days:
                        continue
                    for it in h2.get("items", []):
                        if it.get("field") != "status":
                            continue
                        to_s = it.get("toString", "")
                        if to_s in DONE_STATUSES:
                            trend_days[day_key]["done"] += 1
                        if to_s in REOPEN_STATUSES:
                            trend_days[day_key]["reopened"] += 1

            for s in stories_raw:
                for h2 in (s.get("changelog") or {}).get("histories", []):
                    hist_dt = _parse_jira_dt(h2.get("created", ""))
                    if hist_dt < since:
                        continue
                    day_key = str(hist_dt.date())
                    if day_key not in trend_days:
                        continue
                    for it in h2.get("items", []):
                        if it.get("field") != "status":
                            continue
                        to_s = it.get("toString", "")
                        if to_s in RFT_STATUSES:
                            trend_days[day_key]["rft"] += 1
                        if to_s in DONE_STATUSES:
                            trend_days[day_key]["done"] += 1
                        if to_s in {"Ready For Deployment", "Ready for Deployment"}:
                            trend_days[day_key]["rfd"] += 1

            trend_data = sorted(trend_days.values(), key=lambda x: x["date"])

            return {
                "period_days": days,
                "version":     version,
                "scope_key":   scope_key,
                "summary": {
                    "bugs_opened":     bugs_opened,
                    "bugs_closed":     bugs_closed,
                    "bugs_active":     len(bugs_raw),
                    "stories_rft":     stories_rft,
                    "stories_done":    stories_done,
                    "stories_active":  len(stories_raw),
                    "tests_added":     tests_added,
                    "tests_executed":  tests_executed,
                    "tests_active":    len(tests_raw),
                },
                "bugs":             bugs_report,
                "stories":          stories_report,
                "tests":            tests_report,
                "tests_created":    tests_created_list,
                "bugs_opened_list": bugs_opened_list,
                "trend_data":       trend_data,
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    # ── Helpers ────────────────────────────────────────────────────────────────

    async def _search_changelog(self, jql: str, max_issues: int = 200) -> list[dict]:
        """Fetch issues with changelog via expand=changelog (single page, most recent)."""
        params = {
            "jql":        jql,
            "maxResults": min(max_issues, 200),
            "fields":     "summary,status,priority,issuetype,assignee,created,updated,fixVersions,parent",
            "expand":     "changelog",
        }
        try:
            data = await self.jira.get("/search/jql", params)
            return data.get("issues", [])
        except Exception as e:
            logger.warning(f"Activity search failed: {e}")
            return []

    def _process_issues(self, issues: list[dict], since: datetime, issue_type: str) -> dict:
        """Process changelog for a set of issues into transition/activity data."""
        transitions: dict[str, dict] = {}   # "From -> To" -> {count, issues[]}
        activity_feed: list[dict] = []
        assignee_activity: dict[str, int] = defaultdict(int)

        for issue in issues:
            f          = issue.get("fields") or {}
            key        = issue["key"]
            summary    = f.get("summary", "")
            issue_url  = f"{self.jira_base_url}/browse/{key}"
            histories  = (issue.get("changelog") or {}).get("histories", [])

            for history in histories:
                hist_dt = _parse_jira_dt(history.get("created", ""))
                if hist_dt < since:
                    continue

                author_name = (
                    (history.get("author") or {}).get("displayName")
                    or (history.get("author") or {}).get("emailAddress")
                    or "Unknown"
                )

                for item in history.get("items", []):
                    if item.get("field") != "status":
                        continue

                    from_s = item.get("fromString") or "—"
                    to_s   = item.get("toString")   or "—"
                    label  = f"{from_s} → {to_s}"

                    if label not in transitions:
                        transitions[label] = {
                            "from":   from_s,
                            "to":     to_s,
                            "count":  0,
                            "issues": [],
                        }
                    transitions[label]["count"] += 1
                    if len(transitions[label]["issues"]) < 10:
                        transitions[label]["issues"].append({
                            "key":     key,
                            "summary": summary,
                            "url":     issue_url,
                        })

                    activity_feed.append({
                        "key":        key,
                        "summary":    summary,
                        "url":        issue_url,
                        "from":       from_s,
                        "to":         to_s,
                        "changed_by": author_name,
                        "changed_at": history.get("created", ""),
                    })
                    assignee_activity[author_name] += 1

        # Sort transitions by count desc
        sorted_transitions = sorted(
            transitions.values(), key=lambda x: -x["count"]
        )

        # Activity feed: most recent first, cap at 50
        activity_feed.sort(key=lambda x: x["changed_at"], reverse=True)

        return {
            "transitions":       sorted_transitions,
            "activity_feed":     activity_feed[:50],
            "by_author":         sorted(assignee_activity.items(), key=lambda x: -x[1]),
            "total_transitions": sum(t["count"] for t in sorted_transitions),
        }


_instance: Optional[ActivityService] = None


def get_activity_service() -> ActivityService:
    global _instance
    if _instance is None:
        _instance = ActivityService()
    return _instance

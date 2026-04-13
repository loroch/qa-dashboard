"""
Dashboard business logic: aggregates Jira data into dashboard views.
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.jira.client import get_jira_client
from app.jira.queries import get_jql_builder
from app.jira.field_mapper import get_field_mapper
from app.services.cache_service import get_cache
from app.config import get_field_mapping

logger = logging.getLogger(__name__)

CACHE_KEY_FULL = "dashboard:full"
CACHE_KEY_RFT = "dashboard:rft"
CACHE_KEY_BUGS = "dashboard:bugs"
CACHE_KEY_ACTIVITY = "dashboard:activity"
CACHE_KEY_BLOCKERS = "dashboard:blockers"


class DashboardService:
    def __init__(self):
        self.jira = get_jira_client()
        self.jql = get_jql_builder()
        self.mapper = get_field_mapper()
        self.cache = get_cache()
        self.mapping = get_field_mapping()

    @property
    def team_members(self) -> dict:
        """Always read fresh from config so reloads take effect."""
        mapping = get_field_mapping()
        return {m["id"]: m["name"] for m in mapping["jira"]["team_members"]}

    # ------------------------------------------------------------------
    # Fetch helpers
    # ------------------------------------------------------------------

    async def _fetch_rft(self, filters: dict | None = None) -> list[dict]:
        jql = self.jql.ready_for_testing(
            projects=filters.get("projects") if filters else None,
            assignee_ids=filters.get("assignee_ids") if filters else None,
        )
        logger.info(f"RFT JQL: {jql}")
        issues = await self.jira.search_issues(jql)
        return self.mapper.map_issues(issues)

    async def _fetch_bugs(self, filters: dict | None = None) -> list[dict]:
        jql = self.jql.bugs_last_30_days(
            creator_ids=filters.get("creator_ids") if filters else None,
            projects=filters.get("projects") if filters else None,
        )
        logger.info(f"Bugs JQL: {jql}")
        issues = await self.jira.search_issues(jql)
        return self.mapper.map_issues(issues)

    async def _fetch_blockers(self, filters: dict | None = None) -> list[dict]:
        jql = self.jql.blockers(
            projects=filters.get("projects") if filters else None,
            assignee_ids=filters.get("assignee_ids") if filters else None,
        )
        issues = await self.jira.search_issues(jql)
        return self.mapper.map_issues(issues)

    async def _fetch_activity(self, filters: dict | None = None) -> list[dict]:
        jql = self.jql.team_activity_last_7_days(
            projects=filters.get("projects") if filters else None,
        )
        issues = await self.jira.search_issues(jql)
        return self.mapper.map_issues(issues)

    # ------------------------------------------------------------------
    # Aggregation helpers
    # ------------------------------------------------------------------

    def _group_by_member(self, issues: list[dict]) -> list[dict]:
        groups: dict[str, dict] = {}
        for member_id, member_name in self.team_members.items():
            groups[member_id] = {
                "member_id": member_id,
                "member_name": member_name,
                "ready_for_testing_count": 0,
                "total_assigned": 0,
                "avg_days_in_status": 0.0,
                "versions": set(),
                "issues": [],
                "days_list": [],
            }

        for issue in issues:
            qa_owner = issue.get("qa_owner") or issue.get("assignee")
            if not qa_owner:
                continue
            member_id = qa_owner.get("id")
            if member_id not in groups:
                continue
            g = groups[member_id]
            g["issues"].append(issue)
            g["total_assigned"] += 1
            if issue.get("status") == self.jql.rft_status:
                g["ready_for_testing_count"] += 1
            for v in issue.get("fix_versions", []):
                g["versions"].add(v["name"])
            g["days_list"].append(issue.get("days_in_status", 0))

        result = []
        for member_id, g in groups.items():
            days_list = g.pop("days_list", [])
            avg = sum(days_list) / len(days_list) if days_list else 0.0
            versions = list(g.pop("versions", set()))
            result.append({
                **g,
                "avg_days_in_status": round(avg, 1),
                "versions": versions,
                "overloaded": g["total_assigned"] > 10,
                "has_no_work": g["total_assigned"] == 0,
            })
        return sorted(result, key=lambda x: x["ready_for_testing_count"], reverse=True)

    def _group_by_version(self, issues: list[dict]) -> list[dict]:
        groups: dict[str, list] = defaultdict(list)
        for issue in issues:
            versions = issue.get("fix_versions", [])
            if versions:
                for v in versions:
                    groups[v["name"]].append(issue)
            else:
                groups["No Version"].append(issue)
        return [
            {"version": k, "count": len(v), "issues": v}
            for k, v in sorted(groups.items(), key=lambda x: len(x[1]), reverse=True)
        ]

    def _group_by_activity(self, issues: list[dict]) -> list[dict]:
        groups: dict[str, list] = defaultdict(list)
        for issue in issues:
            activity = issue.get("activity") or "Uncategorized"
            groups[activity].append(issue)
        return [
            {"activity": k, "count": len(v), "issues": v}
            for k, v in sorted(groups.items(), key=lambda x: len(x[1]), reverse=True)
        ]

    def _group_by_priority(self, issues: list[dict]) -> list[dict]:
        groups: dict[str, int] = defaultdict(int)
        for issue in issues:
            p = issue.get("priority") or "None"
            groups[p] += 1
        priority_order = ["Highest", "Critical", "High", "Medium", "Low", "Lowest", "None"]
        return [
            {"priority": p, "count": groups[p]}
            for p in priority_order if p in groups
        ]

    def _build_aging_report(self, issues: list[dict]) -> list[dict]:
        aging = []
        cfg = self.mapping["jira"]["aging"]
        for issue in issues:
            days = issue.get("days_in_status", 0)
            if days >= cfg["warning_days"]:
                aging.append({
                    "issue": issue,
                    "days_in_status": days,
                    "aging_level": issue.get("aging_level", "ok"),
                })
        return sorted(aging, key=lambda x: x["days_in_status"], reverse=True)

    def _build_active_areas(self, issues: list[dict]) -> list[dict]:
        component_counts: dict[str, list] = defaultdict(list)
        label_counts: dict[str, list] = defaultdict(list)
        epic_counts: dict[str, list] = defaultdict(list)

        for issue in issues:
            for comp in issue.get("components", []):
                component_counts[comp].append(issue["key"])
            for label in issue.get("labels", []):
                label_counts[label].append(issue["key"])
            if issue.get("epic_name"):
                epic_counts[issue["epic_name"]].append(issue["key"])

        areas = []
        for name, keys in component_counts.items():
            areas.append({"area": name, "area_type": "component", "count": len(keys), "issues": keys})
        for name, keys in label_counts.items():
            areas.append({"area": name, "area_type": "label", "count": len(keys), "issues": keys})
        for name, keys in epic_counts.items():
            areas.append({"area": name, "area_type": "epic", "count": len(keys), "issues": keys})

        return sorted(areas, key=lambda x: x["count"], reverse=True)[:20]

    def _build_trend_data(self, issues: list[dict]) -> list[dict]:
        """Build last-7-day trend from issue created/updated dates."""
        today = datetime.now(timezone.utc).date()
        days = [(today - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
        trend = {d: {"date": d, "created": 0, "resolved": 0, "ready_for_testing": 0, "bugs": 0} for d in days}

        for issue in issues:
            created = issue.get("created", "")
            if created:
                day = created[:10]
                if day in trend:
                    trend[day]["created"] += 1
                    if issue.get("issue_type") == "Bug":
                        trend[day]["bugs"] += 1
            if issue.get("status") == self.jql.rft_status:
                updated = issue.get("updated", "")
                if updated:
                    day = updated[:10]
                    if day in trend:
                        trend[day]["ready_for_testing"] += 1

        return list(trend.values())

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_full_dashboard(self, filters: dict | None = None, force_refresh: bool = False) -> dict:
        cache_key = CACHE_KEY_FULL
        if filters:
            import hashlib, json
            cache_key += ":" + hashlib.md5(json.dumps(filters, sort_keys=True).encode()).hexdigest()[:8]

        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            rft, bugs, blockers, activity = await _gather_all(self, filters)
            return self._assemble_dashboard(rft, bugs, blockers, activity)

        return await self.cache.get_or_fetch(cache_key, fetch)

    async def get_ready_for_testing(self, filters: dict | None = None, force_refresh: bool = False) -> list[dict]:
        cache_key = CACHE_KEY_RFT
        if force_refresh:
            self.cache.invalidate(cache_key)
        return await self.cache.get_or_fetch(cache_key, lambda: self._fetch_rft(filters))

    async def get_bugs(self, filters: dict | None = None, force_refresh: bool = False) -> list[dict]:
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_BUGS)
        return await self.cache.get_or_fetch(CACHE_KEY_BUGS, lambda: self._fetch_bugs(filters))

    async def get_blockers(self, filters: dict | None = None, force_refresh: bool = False) -> list[dict]:
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_BLOCKERS)
        return await self.cache.get_or_fetch(CACHE_KEY_BLOCKERS, lambda: self._fetch_blockers(filters))

    async def get_bugs_by_version(self, version: str, force_refresh: bool = False) -> dict:
        import hashlib
        cache_key = f"dashboard:bugs_by_version:{hashlib.md5(version.encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND issuetype = Bug AND fixVersion = "{version}" '
                f'ORDER BY created DESC'
            )
            issues_raw = await self.jira.search_issues(
                jql,
                fields=[
                    "summary", "status", "priority", "reporter", "assignee",
                    "created", "updated", "labels", "components",
                    "fixVersions", "parent", "customfield_10020",
                ],
                max_total=2000,
            )
            bugs = self.mapper.map_issues(issues_raw)

            by_status: dict[str, int] = defaultdict(int)
            by_priority: dict[str, int] = defaultdict(int)
            by_reporter: dict[str, int] = defaultdict(int)
            for b in bugs:
                by_status[b.get("status") or "Unknown"] += 1
                by_priority[b.get("priority") or "None"] += 1
                reporter_name = (b.get("reporter") or {}).get("display_name") or "Unknown"
                by_reporter[reporter_name] += 1

            open_bugs = sum(1 for b in bugs if b.get("status_category") != "Done")
            high_critical = sum(1 for b in bugs if b.get("priority") in ("Highest", "Critical", "High"))
            priority_order = ["Highest", "Critical", "High", "Medium", "Low", "Lowest", "None"]

            return {
                "version": version,
                "bugs": bugs,
                "stats": {
                    "total": len(bugs),
                    "open": open_bugs,
                    "high_critical": high_critical,
                    "by_status": [
                        {"status": s, "count": c}
                        for s, c in sorted(by_status.items(), key=lambda x: -x[1])
                    ],
                    "by_priority": [
                        {"priority": p, "count": by_priority[p]}
                        for p in priority_order if p in by_priority
                    ],
                    "by_reporter": [
                        {"reporter": r, "count": c}
                        for r, c in sorted(by_reporter.items(), key=lambda x: -x[1])
                    ],
                },
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    def _assemble_dashboard(
        self,
        rft: list[dict],
        bugs: list[dict],
        blockers: list[dict],
        activity: list[dict],
    ) -> dict:
        total_tests = sum(i.get("test_count") or 0 for i in rft)
        critical_count = sum(1 for i in rft if i.get("aging_level") in ("critical", "overdue"))
        overdue_count = sum(1 for i in rft if i.get("aging_level") == "overdue")

        by_member = self._group_by_member(rft)
        overloaded = sum(1 for m in by_member if m["overloaded"])
        no_work = sum(1 for m in by_member if m["has_no_work"])

        cached_entry = self.cache.get_meta(CACHE_KEY_FULL)

        return {
            "summary": {
                "total_ready_for_testing": len(rft),
                "total_bugs_30d": len(bugs),
                "total_tests_written": total_tests,
                "overloaded_members": overloaded,
                "members_with_no_work": no_work,
                "critical_items": critical_count,
                "overdue_items": overdue_count,
                "cached_at": cached_entry["cached_at"] if cached_entry else None,
                "cache_age_seconds": cached_entry["age_seconds"] if cached_entry else 0,
            },
            "ready_for_testing": rft,
            "by_member": by_member,
            "by_version": self._group_by_version(rft),
            "by_activity": self._group_by_activity(rft),
            "by_priority": self._group_by_priority(rft),
            "aging_report": self._build_aging_report(rft),
            "blockers": blockers,
            "trend_data": self._build_trend_data(activity),
            "active_areas": self._build_active_areas(activity),
            "bugs_30d": bugs,
            "recent_activity": activity[:50],
        }

    async def refresh_all(self):
        """Force refresh all cache keys. Called by background scheduler."""
        logger.info("Background refresh: starting full data refresh")
        self.cache.invalidate_all()
        try:
            rft, bugs, blockers, activity = await _gather_all(self, None)
            data = self._assemble_dashboard(rft, bugs, blockers, activity)
            self.cache.set(CACHE_KEY_FULL, data)
            logger.info(
                f"Background refresh complete: {len(rft)} RFT, {len(bugs)} bugs"
            )
        except Exception as e:
            logger.error(f"Background refresh failed: {e}")


async def _gather_all(svc: DashboardService, filters):
    """Run all Jira fetches concurrently."""
    import asyncio
    rft, bugs, blockers, activity = await asyncio.gather(
        svc._fetch_rft(filters),
        svc._fetch_bugs(filters),
        svc._fetch_blockers(filters),
        svc._fetch_activity(filters),
    )
    return rft, bugs, blockers, activity


# Singleton
_service: DashboardService | None = None


def get_dashboard_service() -> DashboardService:
    global _service
    if _service is None:
        _service = DashboardService()
    return _service

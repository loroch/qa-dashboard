"""
Dashboard business logic: aggregates Jira data into dashboard views.
"""
import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.jira.client import get_jira_client
from app.jira.queries import get_jql_builder
from app.jira.field_mapper import get_field_mapper
from app.services.cache_service import get_cache
from app.config import get_field_mapping, get_settings

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
        self.jira_base_url = get_settings().jira_base_url.rstrip("/")

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
        mapped = self.mapper.map_issues(issues)
        return await self._apply_qa_estimates(mapped)

    async def _apply_qa_estimates(self, issues: list[dict]) -> list[dict]:
        """Merge in each issue's QA time estimate: a stored override if one
        exists, otherwise the type-based default (configurable for Bugs via
        the default_bug_qa_hours setting; blank for every other type)."""
        overrides = await self.get_qa_estimates([i["key"] for i in issues])
        default_bug_hours = await self.get_default_bug_qa_hours()
        for i in issues:
            if i["key"] in overrides:
                i["qa_estimate_hours"] = overrides[i["key"]]
            else:
                i["qa_estimate_hours"] = default_bug_hours if i.get("issue_type") == "Bug" else None
        return issues

    async def get_default_bug_qa_hours(self) -> float:
        value = await self._get_app_setting("default_bug_qa_hours")
        try:
            return float(value) if value is not None else 0.5
        except (TypeError, ValueError):
            return 0.5

    async def set_default_bug_qa_hours(self, hours: float) -> None:
        await self._set_app_setting("default_bug_qa_hours", str(hours))
        self.cache.invalidate_all()

    async def _get_app_setting(self, key: str) -> Optional[str]:
        from app.database.db import get_session_factory, AppSettingORM
        from sqlalchemy import select
        factory = get_session_factory()
        async with factory() as session:
            row = (await session.execute(
                select(AppSettingORM).where(AppSettingORM.key == key)
            )).scalar_one_or_none()
        return row.value if row else None

    async def _set_app_setting(self, key: str, value: str) -> None:
        from app.database.db import get_session_factory, AppSettingORM
        from sqlalchemy import select
        factory = get_session_factory()
        async with factory() as session:
            existing = (await session.execute(
                select(AppSettingORM).where(AppSettingORM.key == key)
            )).scalar_one_or_none()
            if existing:
                existing.value = value
            else:
                session.add(AppSettingORM(key=key, value=value))
            await session.commit()

    async def get_qa_estimates(self, issue_keys: list[str]) -> dict[str, Optional[float]]:
        from app.database.db import get_session_factory, QaEstimateORM
        from sqlalchemy import select
        if not issue_keys:
            return {}
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(
                select(QaEstimateORM).where(QaEstimateORM.issue_key.in_(issue_keys))
            )).scalars().all()
        return {r.issue_key: r.hours for r in rows}

    async def set_qa_estimate(self, issue_key: str, hours: Optional[float]) -> None:
        """Set an override, or clear it (hours=None) to revert to the default."""
        from app.database.db import get_session_factory, QaEstimateORM
        from sqlalchemy import select, delete
        factory = get_session_factory()
        async with factory() as session:
            if hours is None:
                await session.execute(delete(QaEstimateORM).where(QaEstimateORM.issue_key == issue_key))
            else:
                existing = (await session.execute(
                    select(QaEstimateORM).where(QaEstimateORM.issue_key == issue_key)
                )).scalar_one_or_none()
                if existing:
                    existing.hours = hours
                else:
                    session.add(QaEstimateORM(issue_key=issue_key, hours=hours))
            await session.commit()
        self.cache.invalidate_all()

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
        mapping = get_field_mapping()
        member_meta = {m["id"]: m for m in mapping["jira"]["team_members"]}
        groups: dict[str, dict] = {}
        for member_id, member_name in self.team_members.items():
            groups[member_id] = {
                "member_id": member_id,
                "member_name": member_name,
                "member_role": member_meta.get(member_id, {}).get("role", "QA Engineer"),
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
            if issue.get("status") in self.jql.rft_statuses:
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
            {
                "version": k,
                "count": len(v),
                "issues": v,
                "total_qa_hours": round(sum(i.get("qa_estimate_hours") or 0 for i in v), 2),
            }
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
            if issue.get("status") in self.jql.rft_statuses:
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

    async def get_issue_transitions(self, issue_key: str) -> list[dict]:
        return await self.jira.get_transitions(issue_key)

    async def transition_issue(self, issue_key: str, transition_id: str) -> None:
        await self.jira.transition_issue(issue_key, transition_id)
        # The issue's status just changed under RFT/bugs/blockers JQL filters —
        # drop every cached view so the next load reflects reality instead of
        # showing a now-stale "Ready for Testing" row for this issue.
        self.cache.invalidate_all()

    async def reassign_qa_owner(self, issue_key: str, account_id: Optional[str]) -> None:
        """Reassign the QA Owner. Uses the dedicated custom field if field_mapping.yaml
        configures one; otherwise "QA Owner" is just the standard Jira assignee."""
        qa_owner_field = self.mapping["jira"]["fields"].get("qa_owner")
        if qa_owner_field:
            await self.jira.set_custom_user_field(issue_key, qa_owner_field, account_id)
        else:
            await self.jira.set_assignee(issue_key, account_id)
        self.cache.invalidate_all()

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
            stories_jql = (
                f'project = TMT0 AND issuetype = Story AND fixVersion = "{version}" '
                f'ORDER BY status ASC'
            )
            bugs_raw, stories_raw = await asyncio.gather(
                self.jira.search_issues(
                    jql,
                    fields=[
                        "summary", "status", "priority", "reporter", "assignee",
                        "created", "updated", "labels", "components",
                        "fixVersions", "parent", "customfield_10020",
                    ],
                    max_total=2000,
                ),
                self.jira.search_issues(
                    stories_jql,
                    fields=["summary", "status", "fixVersions", "parent"],
                    max_total=2000,
                ),
            )
            bugs = self.mapper.map_issues(bugs_raw)
            bugs = await self._apply_qa_estimates(bugs)

            by_status: dict[str, int] = defaultdict(int)
            by_priority: dict[str, int] = defaultdict(int)
            by_reporter: dict[str, int] = defaultdict(int)
            for b in bugs:
                by_status[b.get("status") or "Unknown"] += 1
                by_priority[b.get("priority") or "None"] += 1
                reporter_name = (b.get("reporter") or {}).get("display_name") or "Unknown"
                by_reporter[reporter_name] += 1

            story_by_status: dict[str, int] = defaultdict(int)
            stories_list = []
            for s in stories_raw:
                f = s.get("fields") or {}
                st = (f.get("status") or {}).get("name") or "Unknown"
                story_by_status[st] += 1
                stories_list.append({
                    "key":     s["key"],
                    "url":     f"{self.jira_base_url}/browse/{s['key']}",
                    "summary": f.get("summary", ""),
                    "status":  st,
                })

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
                    "stories_total": len(stories_raw),
                    "stories_done": story_by_status.get("Done", 0) + story_by_status.get("DONE", 0),
                    "stories_by_status": [
                        {"status": s, "count": c}
                        for s, c in sorted(story_by_status.items(), key=lambda x: -x[1])
                    ],
                    "stories": stories_list,
                },
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_member_work(self, member_id: str, days: int = 30, force_refresh: bool = False) -> list[dict]:
        """All issues assigned to OR created by a specific member in the last N days."""
        import hashlib
        cache_key = f"dashboard:member_work:{hashlib.md5(member_id.encode()).hexdigest()[:8]}:{days}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND '
                f'(assignee = "{member_id}" OR creator = "{member_id}") '
                f'AND updated >= "-{days}d" '
                f'ORDER BY updated DESC'
            )
            issues = await self.jira.search_issues(
                jql,
                fields=[
                    "summary", "status", "priority", "reporter", "assignee",
                    "created", "updated", "fixVersions", "parent",
                    "issuetype", "customfield_10020",
                ],
                max_total=300,
            )
            return self.mapper.map_issues(issues)

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    async def get_epics(self, force_refresh: bool = False) -> list[dict]:
        cache_key = "dashboard:epics"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            issues_raw = await self.jira.search_issues(
                "project = TMT0 AND issuetype = Epic AND created >= -365d ORDER BY created DESC",
                fields=["summary", "status"],
                max_total=2000,
            )
            return [
                {
                    "key": i["key"],
                    "name": (i.get("fields") or {}).get("summary", i["key"]),
                    "status": ((i.get("fields") or {}).get("status") or {}).get("name", ""),
                }
                for i in issues_raw
            ]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=3600)

    async def get_bugs_by_epic(self, epic_key: str, force_refresh: bool = False) -> dict:
        import hashlib
        cache_key = f"dashboard:bugs_by_epic:{hashlib.md5(epic_key.encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND issuetype = Bug AND parent = "{epic_key}" '
                f'ORDER BY created DESC'
            )
            stories_jql = (
                f'project = TMT0 AND issuetype = Story AND parent = "{epic_key}" '
                f'ORDER BY status ASC'
            )
            bugs_raw, stories_raw = await asyncio.gather(
                self.jira.search_issues(
                    jql,
                    fields=[
                        "summary", "status", "priority", "reporter", "assignee",
                        "created", "updated", "labels", "components",
                        "fixVersions", "parent", "customfield_10020",
                    ],
                    max_total=2000,
                ),
                self.jira.search_issues(
                    stories_jql,
                    fields=["summary", "status", "parent"],
                    max_total=2000,
                ),
            )
            bugs = self.mapper.map_issues(bugs_raw)
            bugs = await self._apply_qa_estimates(bugs)

            by_status: dict[str, int] = defaultdict(int)
            by_priority: dict[str, int] = defaultdict(int)
            by_reporter: dict[str, int] = defaultdict(int)
            for b in bugs:
                by_status[b.get("status") or "Unknown"] += 1
                by_priority[b.get("priority") or "None"] += 1
                reporter_name = (b.get("reporter") or {}).get("display_name") or "Unknown"
                by_reporter[reporter_name] += 1

            story_by_status: dict[str, int] = defaultdict(int)
            stories_list = []
            for s in stories_raw:
                f = s.get("fields") or {}
                st = (f.get("status") or {}).get("name") or "Unknown"
                story_by_status[st] += 1
                stories_list.append({
                    "key":     s["key"],
                    "url":     f"{self.jira_base_url}/browse/{s['key']}",
                    "summary": f.get("summary", ""),
                    "status":  st,
                })

            open_bugs = sum(1 for b in bugs if b.get("status_category") != "Done")
            high_critical = sum(1 for b in bugs if b.get("priority") in ("Highest", "Critical", "High"))
            priority_order = ["Highest", "Critical", "High", "Medium", "Low", "Lowest", "None"]

            return {
                "epic_key": epic_key,
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
                    "stories_total": len(stories_raw),
                    "stories_done": story_by_status.get("Done", 0) + story_by_status.get("DONE", 0),
                    "stories_by_status": [
                        {"status": s, "count": c}
                        for s, c in sorted(story_by_status.items(), key=lambda x: -x[1])
                    ],
                    "stories": stories_list,
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

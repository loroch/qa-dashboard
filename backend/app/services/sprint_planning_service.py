"""
Sprint Planning service — local sprint management layer on top of Jira.
Stores QA activities and RTF tracking in SQLite; reads sprint/story data from Jira.
"""
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, delete

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings
from app.database.db import get_session_factory, SprintQAActivityORM, SprintStoryTrackingORM

logger = logging.getLogger(__name__)

STORY_FIELDS = [
    "summary", "status", "assignee", "priority", "issuetype",
    "parent", "customfield_10016",   # story points
    "timeoriginalestimate", "timespent",
    "customfield_10020",  # sprint
    "customfield_10014",  # epic link
]


class SprintPlanningService:
    _board_id: int | None = None

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    # ── Sprint & story fetching ────────────────────────────────────

    async def get_sprints(self, force_refresh: bool = False) -> list[dict]:
        cache_key = "sprint_plan:sprints"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            try:
                if SprintPlanningService._board_id is None:
                    board_data = await self.jira.agile_get(
                        "/board", {"projectKeyOrId": "TMT0", "type": "scrum", "maxResults": 10}
                    )
                    boards = board_data.get("values", [])
                    if not boards:
                        return []
                    SprintPlanningService._board_id = boards[0]["id"]

                board_id = SprintPlanningService._board_id
                sprint_params = {"state": "active,future,closed", "maxResults": 50}

                # Step 1: probe the total so we can jump to the last page
                probe = await self.jira.agile_get(f"/board/{board_id}/sprint", {**sprint_params, "startAt": 0})
                total = probe.get("total", 0)
                is_last = probe.get("isLast", False)

                if total == 0:
                    return []

                # Step 2: if there are more sprints than one page, jump to the end
                if not is_last and total > 50:
                    # Fetch the last 50 (covers most recent sprints including any active/future)
                    start_at = max(0, total - 50)
                    last_page = await self.jira.agile_get(
                        f"/board/{board_id}/sprint",
                        {**sprint_params, "startAt": start_at},
                    )
                    raw_sprints = last_page.get("values", [])
                else:
                    raw_sprints = probe.get("values", [])

                def _fmt(s: dict) -> dict:
                    return {
                        "id": s["id"],
                        "name": s["name"],
                        "state": s.get("state", ""),
                        "start_date": s.get("startDate", ""),
                        "end_date": s.get("endDate", ""),
                        "complete_date": s.get("completeDate", ""),
                    }

                sprints = [_fmt(s) for s in raw_sprints]
                order = {"active": 0, "future": 1, "closed": 2}
                sprints.sort(key=lambda x: (order.get(x["state"], 3), x.get("start_date", "") or ""))

                # Prefer sprints in [now-90d, now+90d]; fall back to last 20 if none match
                now = datetime.now(timezone.utc)
                window_start = now - timedelta(days=90)
                window_end = now + timedelta(days=90)

                def in_window(sp: dict) -> bool:
                    if sp["state"] == "active":
                        return True
                    for key in ("start_date", "end_date", "complete_date"):
                        raw = sp.get(key)
                        if raw:
                            try:
                                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                                if window_start <= dt <= window_end:
                                    return True
                            except Exception:
                                pass
                    return False

                windowed = [s for s in sprints if in_window(s)]
                # Fall back to the 20 most recent when nothing matches the window
                return windowed if windowed else sprints[-20:]

            except Exception as e:
                logger.warning(f"Failed to fetch sprints: {e}")
                SprintPlanningService._board_id = None
                return []

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_sprint_bugs(self, sprint_id: int, force_refresh: bool = False) -> dict:
        cache_key = f"sprint_plan:bugs:{sprint_id}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND sprint = {sprint_id} '
                f'AND issuetype = Bug '
                f'AND status not in (Done, DONE, Removed) '
                f'ORDER BY priority ASC, created DESC'
            )
            raw = await self.jira.search_issues(jql, fields=STORY_FIELDS, max_total=500)
            bugs = []
            for i in raw:
                f = i.get("fields", {})
                parent_raw = f.get("parent") or {}
                parent_f = parent_raw.get("fields") or {}
                bugs.append({
                    "key": i["key"],
                    "url": f"{self.jira_base_url}/browse/{i['key']}",
                    "summary": f.get("summary", ""),
                    "status": (f.get("status") or {}).get("name", ""),
                    "assignee": (f.get("assignee") or {}).get("displayName", ""),
                    "priority": (f.get("priority") or {}).get("name", ""),
                    "issue_type": (f.get("issuetype") or {}).get("name", "Bug"),
                    "parent_key": parent_raw.get("key", ""),
                    "parent_summary": parent_f.get("summary", ""),
                    "parent_type": (parent_f.get("issuetype") or {}).get("name", ""),
                })
            return bugs

        bugs = await self.cache.get_or_fetch(cache_key, fetch, ttl=180)
        return {"bugs": bugs, "total": len(bugs)}

    async def get_sprint_stories(self, sprint_id: int, force_refresh: bool = False) -> dict:
        cache_key = f"sprint_plan:stories:{sprint_id}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND sprint = {sprint_id} '
                f'AND issuetype in (Story, Task) '
                f'ORDER BY priority ASC, created DESC'
            )
            raw = await self.jira.search_issues(jql, fields=STORY_FIELDS, max_total=200)
            stories = []
            for i in raw:
                f = i.get("fields", {})
                sp = f.get("customfield_10016") or 0
                orig_est = f.get("timeoriginalestimate") or 0
                time_spent = f.get("timespent") or 0
                est_hours = round(orig_est / 3600, 1) if orig_est else round(float(sp) * 8, 1) if sp else 0
                parent_raw = f.get("parent") or {}
                parent_f = parent_raw.get("fields") or {}
                stories.append({
                    "key": i["key"],
                    "url": f"{self.jira_base_url}/browse/{i['key']}",
                    "summary": f.get("summary", ""),
                    "status": (f.get("status") or {}).get("name", ""),
                    "assignee": (f.get("assignee") or {}).get("displayName", ""),
                    "priority": (f.get("priority") or {}).get("name", ""),
                    "issue_type": (f.get("issuetype") or {}).get("name", ""),
                    "story_points": float(sp) if sp else None,
                    "original_estimate_hours": est_hours,
                    "time_spent_hours": round(time_spent / 3600, 1),
                    "epic_key": f.get("customfield_10014") or parent_raw.get("key", "") or "",
                    "parent_key": parent_raw.get("key", ""),
                    "parent_summary": parent_f.get("summary", ""),
                    "parent_type": (parent_f.get("issuetype") or {}).get("name", ""),
                })
            return stories

        stories = await self.cache.get_or_fetch(cache_key, fetch, ttl=180)
        total_sp = sum(s.get("story_points") or 0 for s in stories)
        total_est = sum(s.get("original_estimate_hours") or 0 for s in stories)
        return {
            "stories": stories,
            "total_story_points": total_sp,
            "total_estimated_hours": total_est,
            "total_stories": len(stories),
        }

    # ── QA Activities CRUD ─────────────────────────────────────────

    async def get_activities(self, sprint_id: int) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintQAActivityORM)
                .where(SprintQAActivityORM.sprint_id == sprint_id)
                .order_by(SprintQAActivityORM.order_index)
            )
            return [self._activity_to_dict(r) for r in result.scalars().all()]

    async def add_activity(self, sprint_id: int, data: dict) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintQAActivityORM.order_index)
                .where(SprintQAActivityORM.sprint_id == sprint_id)
                .order_by(SprintQAActivityORM.order_index.desc())
                .limit(1)
            )
            last_order = result.scalar_one_or_none()
            row = SprintQAActivityORM(
                sprint_id=sprint_id,
                sprint_name=data.get("sprint_name", ""),
                story_key=data.get("story_key") or None,
                story_summary=data.get("story_summary") or None,
                activity_name=data["activity_name"],
                description=data.get("description") or None,
                estimation_hours=data.get("estimation_hours"),
                order_index=(last_order or 0) + 1,
                activity_type=data.get("activity_type", "qa_testing"),
                status=data.get("status", "planned"),
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._activity_to_dict(row)

    async def update_activity(self, activity_id: int, data: dict) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintQAActivityORM).where(SprintQAActivityORM.id == activity_id)
            )
            row = result.scalar_one_or_none()
            if not row:
                raise ValueError(f"Activity {activity_id} not found")
            for k in ["activity_name", "description", "estimation_hours", "activity_type", "status", "story_key", "story_summary"]:
                if k in data:
                    setattr(row, k, data[k])
            row.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(row)
            return self._activity_to_dict(row)

    async def delete_activity(self, activity_id: int) -> None:
        factory = get_session_factory()
        async with factory() as session:
            await session.execute(
                delete(SprintQAActivityORM).where(SprintQAActivityORM.id == activity_id)
            )
            await session.commit()

    async def reorder_activities(self, sprint_id: int, ordered_ids: list[int]) -> None:
        factory = get_session_factory()
        async with factory() as session:
            for idx, activity_id in enumerate(ordered_ids):
                result = await session.execute(
                    select(SprintQAActivityORM).where(SprintQAActivityORM.id == activity_id)
                )
                row = result.scalar_one_or_none()
                if row and row.sprint_id == sprint_id:
                    row.order_index = idx
            await session.commit()

    async def push_to_jira(self, activity_id: int) -> dict:
        """Create a Jira sub-task for the QA activity and return its key/URL."""
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintQAActivityORM).where(SprintQAActivityORM.id == activity_id)
            )
            row = result.scalar_one_or_none()
            if not row:
                raise ValueError(f"Activity {activity_id} not found")
            if not row.story_key:
                raise ValueError("Activity has no linked story — set a story key first")

        label = row.story_summary or row.story_key
        summary = f"QA Testing for {row.story_key}: {label}"[:250]
        payload = {
            "fields": {
                "project": {"key": "TMT0"},
                "issuetype": {"name": "Sub-task"},
                "parent": {"key": row.story_key},
                "summary": summary,
            }
        }
        if row.estimation_hours:
            payload["fields"]["timetracking"] = {
                "originalEstimate": f"{row.estimation_hours}h"
            }
        response = await self.jira.post("/issue", json=payload)
        jira_key = response.get("key", "")
        return {"jira_key": jira_key, "jira_url": f"{self.jira_base_url}/browse/{jira_key}"}

    # ── RTF Tracking CRUD ─────────────────────────────────────────

    async def get_tracking(self, sprint_id: int) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintStoryTrackingORM)
                .where(SprintStoryTrackingORM.sprint_id == sprint_id)
                .order_by(SprintStoryTrackingORM.story_key)
            )
            return [self._tracking_to_dict(r) for r in result.scalars().all()]

    async def upsert_tracking(self, sprint_id: int, story_key: str, data: dict) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(SprintStoryTrackingORM)
                .where(
                    SprintStoryTrackingORM.sprint_id == sprint_id,
                    SprintStoryTrackingORM.story_key == story_key.upper(),
                )
            )
            row = result.scalar_one_or_none()
            if not row:
                row = SprintStoryTrackingORM(
                    sprint_id=sprint_id,
                    story_key=story_key.upper(),
                    story_summary=data.get("story_summary", ""),
                )
                session.add(row)
            for k in ["story_summary", "planned_rft_date", "actual_rft_date", "delay_reason", "delay_notes"]:
                if k in data:
                    setattr(row, k, data[k])
            row.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(row)
            return self._tracking_to_dict(row)

    # ── Helpers ────────────────────────────────────────────────────

    def _activity_to_dict(self, row: SprintQAActivityORM) -> dict:
        return {
            "id": row.id,
            "sprint_id": row.sprint_id,
            "sprint_name": row.sprint_name or "",
            "story_key": row.story_key or "",
            "story_summary": row.story_summary or "",
            "activity_name": row.activity_name,
            "description": row.description or "",
            "estimation_hours": row.estimation_hours,
            "order_index": row.order_index,
            "activity_type": row.activity_type or "qa_testing",
            "status": row.status or "planned",
            "created_at": row.created_at.isoformat() if row.created_at else "",
            "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        }

    def _tracking_to_dict(self, row: SprintStoryTrackingORM) -> dict:
        return {
            "id": row.id,
            "sprint_id": row.sprint_id,
            "story_key": row.story_key,
            "story_summary": row.story_summary or "",
            "planned_rft_date": row.planned_rft_date or "",
            "actual_rft_date": row.actual_rft_date or "",
            "delay_reason": row.delay_reason or "",
            "delay_notes": row.delay_notes or "",
            "created_at": row.created_at.isoformat() if row.created_at else "",
            "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        }


_service: SprintPlanningService | None = None


def get_sprint_planning_service() -> SprintPlanningService:
    global _service
    if _service is None:
        _service = SprintPlanningService()
    return _service

"""
Zoho Desk business logic: aggregates ticket data for the dashboard.
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta

from app.zoho.client import get_zoho_client
from app.zoho.mapper import map_tickets
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

CACHE_KEY_TICKETS = "zoho:tickets"
CACHE_KEY_OPEN = "zoho:open"
CACHE_KEY_DEPARTMENTS = "zoho:departments"


class ZohoService:

    def __init__(self):
        self.client = get_zoho_client()
        self.cache = get_cache()
        settings = get_settings()
        self.desk_base_url = settings.zoho_desk_base_url

    async def _fetch_tickets(self, status: str | None = None) -> list[dict]:
        raw = await self.client.get_all_tickets(status=status)
        return map_tickets(raw, self.desk_base_url)

    async def get_all_tickets(self, force_refresh: bool = False) -> list[dict]:
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_TICKETS)
        return await self.cache.get_or_fetch(
            CACHE_KEY_TICKETS,
            lambda: self._fetch_tickets(),
        )

    async def get_open_tickets(self, force_refresh: bool = False) -> list[dict]:
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_OPEN)
        return await self.cache.get_or_fetch(
            CACHE_KEY_OPEN,
            lambda: self._fetch_tickets(status="Open"),
        )

    async def get_departments(self) -> list[dict]:
        return await self.cache.get_or_fetch(
            CACHE_KEY_DEPARTMENTS,
            lambda: self.client.get_departments(),
            ttl=3600,
        )

    async def get_dashboard_data(self, force_refresh: bool = False) -> dict:
        tickets = await self.get_all_tickets(force_refresh=force_refresh)

        # Group by department (project)
        by_dept: dict[str, list] = defaultdict(list)
        for t in tickets:
            dept = t.get("department_name") or "No Department"
            by_dept[dept].append(t)

        # Group by status
        by_status: dict[str, int] = defaultdict(int)
        for t in tickets:
            by_status[t.get("status", "Unknown")] += 1

        # Group by priority
        by_priority: dict[str, int] = defaultdict(int)
        for t in tickets:
            by_priority[t.get("priority", "None")] += 1

        # Group by assignee
        by_assignee: dict[str, list] = defaultdict(list)
        for t in tickets:
            name = t.get("assignee_name") or "Unassigned"
            by_assignee[name].append(t)

        # Overdue tickets
        overdue = [t for t in tickets if t.get("is_overdue") or t.get("aging_level") == "overdue"]
        critical = [t for t in tickets if t.get("aging_level") in ("critical", "overdue")]

        # Trend last 7 days
        trend = self._build_trend(tickets)

        # Recent tickets
        recent = sorted(tickets, key=lambda t: t.get("modified") or "", reverse=True)[:50]

        return {
            "summary": {
                "total_tickets": len(tickets),
                "open_tickets": by_status.get("Open", 0),
                "overdue_tickets": len(overdue),
                "critical_tickets": len(critical),
                "departments": len(by_dept),
                "unassigned": len(by_assignee.get("Unassigned", [])),
            },
            "by_department": [
                {
                    "department": dept,
                    "count": len(items),
                    "open": sum(1 for t in items if t.get("status") == "Open"),
                    "overdue": sum(1 for t in items if t.get("is_overdue")),
                    "tickets": items,
                }
                for dept, items in sorted(by_dept.items(), key=lambda x: len(x[1]), reverse=True)
            ],
            "by_status": [
                {"status": k, "count": v}
                for k, v in sorted(by_status.items(), key=lambda x: x[1], reverse=True)
            ],
            "by_priority": [
                {"priority": k, "count": v}
                for k, v in sorted(by_priority.items(), key=lambda x: x[1], reverse=True)
            ],
            "by_assignee": [
                {
                    "assignee": name,
                    "count": len(items),
                    "overdue": sum(1 for t in items if t.get("is_overdue")),
                }
                for name, items in sorted(by_assignee.items(), key=lambda x: len(x[1]), reverse=True)
            ],
            "overdue": overdue,
            "recent": recent,
            "trend": trend,
            "all_tickets": tickets,
        }

    def _build_trend(self, tickets: list[dict]) -> list[dict]:
        today = datetime.now(timezone.utc).date()
        days = [(today - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
        trend = {d: {"date": d, "created": 0, "modified": 0} for d in days}
        for t in tickets:
            created = (t.get("created") or "")[:10]
            if created in trend:
                trend[created]["created"] += 1
            modified = (t.get("modified") or "")[:10]
            if modified in trend:
                trend[modified]["modified"] += 1
        return list(trend.values())

    async def refresh(self):
        self.cache.invalidate(CACHE_KEY_TICKETS)
        self.cache.invalidate(CACHE_KEY_OPEN)
        await self.get_all_tickets()
        logger.info("Zoho Desk cache refreshed")


_service: ZohoService | None = None

def get_zoho_service() -> ZohoService:
    global _service
    if _service is None:
        _service = ZohoService()
    return _service

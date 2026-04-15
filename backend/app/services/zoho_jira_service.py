"""
Zoho–Jira cross-reference service.

For each Zoho Desk ticket that has a Bug ID (Jira key like TMT0-XXXXX),
this service fetches the Jira issue status, fix version, and parent,
and returns a unified joined report.
"""
import asyncio
import logging
from collections import defaultdict
from typing import Optional

from app.zoho.client import get_zoho_client
from app.zoho.mapper import map_tickets
from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

CACHE_KEY_LINKED = "zoho_jira:linked_report"
CACHE_KEY_BY_PROJECT = "zoho_jira:by_project"


class ZohoJiraService:

    def __init__(self):
        self.zoho = get_zoho_client()
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.desk_base_url = settings.zoho_desk_base_url
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    async def get_project_status_report(self, force_refresh: bool = False) -> list[dict]:
        """
        Returns ticket count grouped by Project Name + Status.
        """
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_BY_PROJECT)

        async def fetch():
            raw = await self.zoho.get_all_tickets(max_total=2000)
            tickets = map_tickets(raw, self.desk_base_url)

            # Group by project_name + status
            groups: dict[tuple, int] = defaultdict(int)
            for t in tickets:
                project = t.get("project_name") or "No Project"
                status = t.get("status") or "Unknown"
                groups[(project, status)] += 1

            # Build sorted result
            result = [
                {"project_name": proj, "status": stat, "count": cnt}
                for (proj, stat), cnt in groups.items()
            ]
            result.sort(key=lambda x: (x["project_name"], x["count"]), reverse=False)

            # Also build project totals
            project_totals: dict[str, dict] = defaultdict(lambda: {"total": 0, "statuses": {}})
            for row in result:
                p = row["project_name"]
                s = row["status"]
                project_totals[p]["total"] += row["count"]
                project_totals[p]["statuses"][s] = row["count"]

            return {
                "rows": result,
                "by_project": [
                    {
                        "project_name": p,
                        "total": v["total"],
                        "statuses": [
                            {"status": s, "count": c}
                            for s, c in sorted(v["statuses"].items(), key=lambda x: x[1], reverse=True)
                        ],
                    }
                    for p, v in sorted(project_totals.items(), key=lambda x: x[1]["total"], reverse=True)
                ],
            }

        return await self.cache.get_or_fetch(CACHE_KEY_BY_PROJECT, fetch, ttl=300)

    async def get_linked_report(self, force_refresh: bool = False) -> list[dict]:
        """
        For each Zoho ticket with a Bug ID, fetch Jira status + fix version + parent.
        Returns joined rows ready for the dashboard table.
        """
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_LINKED)

        async def fetch():
            # 1. Get all Zoho tickets
            raw = await self.zoho.get_all_tickets(max_total=2000)
            tickets = map_tickets(raw, self.desk_base_url)

            # 2. Split: tickets with and without Jira keys
            linked  = [t for t in tickets if t.get("jira_key")]
            unlinked = [t for t in tickets if not t.get("jira_key")]
            logger.info(f"Zoho-Jira: {len(linked)} linked, {len(unlinked)} unlinked")

            # 3. Deduplicate Jira keys
            jira_keys = list({t["jira_key"] for t in linked})
            logger.info(f"Zoho-Jira: fetching {len(jira_keys)} unique Jira issues")

            # 4. Fetch Jira issues in batches of 50
            jira_data: dict[str, dict] = {}
            batch_size = 50
            for i in range(0, len(jira_keys), batch_size):
                batch = jira_keys[i:i + batch_size]
                keys_jql = ", ".join(f'"{k}"' for k in batch)
                jql = f"issueKey in ({keys_jql})"
                try:
                    issues = await self.jira.search_issues(
                        jql,
                        fields=["summary", "status", "fixVersions", "parent",
                                "customfield_10014", "customfield_10011", "priority"],
                    )
                    for issue in issues:
                        key = issue.get("key", "")
                        fields = issue.get("fields", {})
                        fix_versions = [v.get("name") for v in fields.get("fixVersions", [])]
                        parent = fields.get("parent") or {}
                        epic_name = fields.get("customfield_10011")

                        jira_data[key] = {
                            "jira_key": key,
                            "jira_url": f"{self.jira_base_url}/browse/{key}",
                            "jira_summary": fields.get("summary", ""),
                            "jira_status": (fields.get("status") or {}).get("name", ""),
                            "jira_status_category": (fields.get("status") or {}).get("statusCategory", {}).get("name", ""),
                            "jira_priority": (fields.get("priority") or {}).get("name", ""),
                            "jira_fix_versions": fix_versions,
                            "jira_parent_key": parent.get("key"),
                            "jira_parent_summary": (parent.get("fields") or {}).get("summary", ""),
                            "jira_epic": epic_name,
                        }
                except Exception as e:
                    logger.error(f"Jira batch fetch error: {e}")

            # 5. Join Zoho tickets with Jira data
            def _zoho_row(ticket: dict, jira_key: str | None = None) -> dict:
                jira = jira_data.get(jira_key, {}) if jira_key else {}
                return {
                    # Zoho fields
                    "zoho_ticket_number": ticket["ticket_number"],
                    "zoho_id": ticket["id"],
                    "zoho_url": ticket["url"],
                    "zoho_subject": ticket["subject"],
                    "zoho_status": ticket["status"],
                    "zoho_priority": ticket["priority"],
                    "zoho_project_name": ticket.get("project_name") or "—",
                    "zoho_assignee": ticket.get("assignee_name") or "—",
                    "zoho_contact": ticket.get("contact_name") or "—",
                    "zoho_days_open": ticket["days_open"],
                    "zoho_aging_level": ticket["aging_level"],
                    "zoho_created": ticket["created"],
                    # Jira fields (empty for unlinked tickets)
                    "bug_id": ticket.get("bug_id") or "",
                    "jira_key": jira_key or "",
                    "jira_url": jira.get("jira_url", f"{self.jira_base_url}/browse/{jira_key}" if jira_key else ""),
                    "jira_found": bool(jira),
                    "jira_summary": jira.get("jira_summary", ""),
                    "jira_status": jira.get("jira_status", "Not found") if jira_key else "",
                    "jira_status_category": jira.get("jira_status_category", ""),
                    "jira_priority": jira.get("jira_priority", ""),
                    "jira_fix_versions": jira.get("jira_fix_versions", []),
                    "jira_parent_key": jira.get("jira_parent_key"),
                    "jira_parent_summary": jira.get("jira_parent_summary", ""),
                    "jira_epic": jira.get("jira_epic", ""),
                }

            result = []
            for ticket in linked:
                result.append(_zoho_row(ticket, ticket["jira_key"]))
            for ticket in unlinked:
                result.append(_zoho_row(ticket, None))

            return sorted(result, key=lambda x: x["zoho_ticket_number"], reverse=True)

        return await self.cache.get_or_fetch(CACHE_KEY_LINKED, fetch, ttl=300)


_service: ZohoJiraService | None = None

def get_zoho_jira_service() -> ZohoJiraService:
    global _service
    if _service is None:
        _service = ZohoJiraService()
    return _service

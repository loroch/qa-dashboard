"""
Maps raw Zoho Desk ticket fields to dashboard-friendly dicts.
"""
from datetime import datetime, timezone
from typing import Any


def parse_dt(dt_str: str | None) -> str | None:
    if not dt_str:
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.isoformat()
    except Exception:
        return dt_str


def days_since(dt_str: str | None) -> int:
    if not dt_str:
        return 0
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).days
    except Exception:
        return 0


def aging_level(days: int) -> str:
    if days >= 14:
        return "overdue"
    elif days >= 7:
        return "critical"
    elif days >= 3:
        return "warning"
    return "ok"


def _extract_custom_fields(ticket: dict) -> dict:
    """Extract custom fields using exact field names from this Zoho Desk instance."""
    cf = ticket.get("customFields") or {}

    # customFields can be a list of {label, value} or a flat dict
    if isinstance(cf, list):
        cf_dict = {item.get("label", ""): item.get("value") for item in cf}
    elif isinstance(cf, dict):
        cf_dict = cf
    else:
        cf_dict = {}

    # Use the "cf" flat dict — the list API returns fields here
    cf_flat = ticket.get("cf") or {}

    # Project Name — API name is cf_site_name
    project_name = (
        cf_flat.get("cf_site_name") or
        cf_dict.get("Project Name:") or
        cf_dict.get("Project Name") or
        None
    )

    # Bug ID — API name is cf_bug_id
    bug_id = (
        cf_flat.get("cf_bug_id") or
        cf_dict.get("Bug ID") or
        None
    )

    # Build Jira key if bug_id is a number
    jira_key = None
    if bug_id:
        bug_str = str(bug_id).strip()
        if bug_str.isdigit():
            jira_key = f"TMT0-{bug_str}"
        elif bug_str.upper().startswith("TMT"):
            jira_key = bug_str.upper()

    return {
        "project_name": project_name,
        "bug_id": str(bug_id).strip() if bug_id else None,
        "jira_key": jira_key,
        "raw_custom_fields": cf_dict,
    }


def map_ticket(ticket: dict, desk_base_url: str = "https://desk.zoho.com") -> dict:
    assignee = ticket.get("assignee") or {}
    contact = ticket.get("contact") or {}
    department = ticket.get("department") or {}

    created = ticket.get("createdTime")
    modified = ticket.get("modifiedTime")
    due_date = ticket.get("dueDate")

    days = days_since(modified or created)
    level = aging_level(days)

    ticket_id = ticket.get("id", "")
    ticket_number = ticket.get("ticketNumber", ticket_id)

    custom = _extract_custom_fields(ticket)

    return {
        "id": ticket_id,
        "ticket_number": f"#{ticket_number}",
        "url": ticket.get("webUrl") or f"{desk_base_url}/support/cityshob/ShowHomePage.do#Cases/dv/{ticket_id}",
        "subject": ticket.get("subject", ""),
        "status": ticket.get("status", ""),
        "priority": ticket.get("priority", ""),
        "channel": ticket.get("channel", ""),
        "classification": ticket.get("classification", ""),
        "assignee_id": assignee.get("id"),
        "assignee_name": assignee.get("name", "Unassigned"),
        "contact_name": contact.get("name", ""),
        "contact_email": contact.get("email", ""),
        "department_id": department.get("id"),
        "department_name": department.get("name", ""),
        "project_name": custom["project_name"],
        "bug_id": custom["bug_id"],
        "jira_key": custom["jira_key"],
        "created": parse_dt(created),
        "modified": parse_dt(modified),
        "due_date": parse_dt(due_date),
        "days_open": days,
        "aging_level": level,
        "is_overdue": ticket.get("isOverDue", False),
        "response_due_date": parse_dt(ticket.get("responseDueDate")),
        "tags": ticket.get("tags", []),
        "source": "zoho_desk",
    }


def map_tickets(tickets: list[dict], desk_base_url: str = "https://desk.zoho.com") -> list[dict]:
    return [map_ticket(t, desk_base_url) for t in tickets]

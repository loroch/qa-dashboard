"""
Field mapper: translates raw Jira issue fields to dashboard-friendly dicts.
All field ID lookups go through the config - nothing is hardcoded.
"""
from datetime import datetime, timezone
from typing import Any, Optional
from app.config import get_field_mapping


class FieldMapper:
    """Maps Jira issue fields using the field_mapping.yaml configuration."""

    def __init__(self):
        mapping = get_field_mapping()
        self.cfg = mapping["jira"]
        self.fields_cfg = self.cfg["fields"]
        self.team_map = {m["id"]: m["name"] for m in self.cfg["team_members"]}
        self.aging = self.cfg["aging"]
        from app.config import get_settings
        self.jira_base_url = get_settings().jira_base_url.rstrip("/")

    def _field(self, key: str) -> Optional[str]:
        return self.fields_cfg.get(key)

    def _get(self, fields: dict, key: str, default=None) -> Any:
        field_id = self._field(key)
        if field_id:
            return fields.get(field_id, default)
        return default

    def extract_user(self, user_obj: dict | None) -> dict | None:
        if not user_obj:
            return None
        account_id = user_obj.get("accountId", "")
        return {
            "id": account_id,
            "name": self.team_map.get(account_id, user_obj.get("displayName", "Unknown")),
            "display_name": user_obj.get("displayName", "Unknown"),
            "avatar": user_obj.get("avatarUrls", {}).get("48x48"),
            "is_team_member": account_id in self.team_map,
        }

    def extract_versions(self, fix_versions: list) -> list[dict]:
        return [
            {"id": v.get("id"), "name": v.get("name"), "released": v.get("released", False)}
            for v in (fix_versions or [])
        ]

    def extract_components(self, components: list) -> list[str]:
        return [c.get("name", "") for c in (components or [])]

    def parse_datetime(self, dt_str: str | None) -> datetime | None:
        if not dt_str:
            return None
        try:
            return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        except Exception:
            return None

    def days_in_status(self, status_changed_at: datetime | None) -> int:
        if not status_changed_at:
            return 0
        now = datetime.now(timezone.utc)
        if status_changed_at.tzinfo is None:
            status_changed_at = status_changed_at.replace(tzinfo=timezone.utc)
        return (now - status_changed_at).days

    def aging_level(self, days: int) -> str:
        if days >= self.aging["overdue_days"]:
            return "overdue"
        elif days >= self.aging["critical_days"]:
            return "critical"
        elif days >= self.aging["warning_days"]:
            return "warning"
        return "ok"

    def extract_sprint(self, sprint_field_value: Any) -> Optional[dict]:
        if not sprint_field_value:
            return None
        sprints = sprint_field_value if isinstance(sprint_field_value, list) else [sprint_field_value]
        for s in reversed(sprints):
            if isinstance(s, dict):
                return {"id": s.get("id"), "name": s.get("name"), "state": s.get("state")}
            if isinstance(s, str) and "name=" in s:
                name = s.split("name=")[1].split(",")[0]
                return {"id": None, "name": name, "state": None}
        return None

    def map_issue(self, issue: dict) -> dict:
        """Map a raw Jira issue to dashboard-friendly dict."""
        fields = issue.get("fields", {})

        assignee = self.extract_user(fields.get("assignee"))
        reporter = self.extract_user(fields.get("reporter"))

        # QA Owner: use qa_owner custom field if configured, else assignee
        qa_owner_field = self._field("qa_owner")
        if qa_owner_field and fields.get(qa_owner_field):
            qa_owner = self.extract_user(fields[qa_owner_field])
        else:
            qa_owner = assignee

        # Bundle/Module: use bundle_field if set, else Epic Link
        bundle = None
        bundle_field = self._field("bundle_field")
        epic_link_field = self._field("epic_link_field")
        epic_name_field = self._field("epic_name_field")

        if bundle_field and fields.get(bundle_field):
            bundle = str(fields[bundle_field])
        elif epic_link_field and fields.get(epic_link_field):
            bundle = fields.get(epic_link_field)
        elif fields.get("parent"):
            parent = fields["parent"]
            bundle = parent.get("key")

        epic_name = None
        if epic_name_field:
            epic_name = fields.get(epic_name_field)

        # Activity: use activity_field if configured, else labels
        activity = None
        activity_field = self._field("activity_field")
        if activity_field and fields.get(activity_field):
            val = fields[activity_field]
            activity = val.get("value") if isinstance(val, dict) else str(val)
        else:
            labels = fields.get("labels", [])
            activity = labels[0] if labels else None

        # Test count
        test_count = None
        test_count_field = self._field("test_count")
        if test_count_field:
            test_count = fields.get(test_count_field)

        # Story points
        sp_field = self._field("story_points") or "story_points"
        story_points = fields.get(sp_field) or fields.get("customfield_10016")

        # Sprint
        sprint_field = self._field("sprint_field") or "customfield_10020"
        sprint = self.extract_sprint(fields.get(sprint_field))

        # Status changed date (for aging) - from changelog or status timestamp
        status = fields.get("status", {})
        updated = self.parse_datetime(fields.get("updated"))
        created = self.parse_datetime(fields.get("created"))

        # Days in current status (approximated from updated if no changelog)
        days_in_current_status = self.days_in_status(updated) if updated else 0

        return {
            "key": issue.get("key"),
            "id": issue.get("id"),
            "url": f"{self.jira_base_url}/browse/{issue.get('key')}",
            "summary": fields.get("summary"),
            "status": status.get("name") if status else None,
            "status_category": status.get("statusCategory", {}).get("name") if status else None,
            "priority": fields.get("priority", {}).get("name") if fields.get("priority") else None,
            "issue_type": fields.get("issuetype", {}).get("name") if fields.get("issuetype") else None,
            "assignee": assignee,
            "reporter": reporter,
            "qa_owner": qa_owner,
            "created": created.isoformat() if created else None,
            "updated": updated.isoformat() if updated else None,
            "due_date": fields.get("duedate"),
            "fix_versions": self.extract_versions(fields.get("fixVersions", [])),
            "components": self.extract_components(fields.get("components", [])),
            "labels": fields.get("labels", []),
            "epic_link": bundle,
            "epic_name": epic_name,
            "bundle": bundle,
            "activity": activity,
            "sprint": sprint,
            "story_points": story_points,
            "test_count": test_count,
            "days_in_status": days_in_current_status,
            "aging_level": self.aging_level(days_in_current_status),
        }

    def map_issues(self, issues: list[dict]) -> list[dict]:
        return [self.map_issue(i) for i in issues]


_mapper: FieldMapper | None = None


def get_field_mapper() -> FieldMapper:
    global _mapper
    if _mapper is None:
        _mapper = FieldMapper()
    return _mapper


def reset_field_mapper():
    global _mapper
    _mapper = None

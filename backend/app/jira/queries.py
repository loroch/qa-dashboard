"""
JQL query builder for the QA Dashboard.
All queries are constructed here - no JQL strings scattered in business logic.
"""
from datetime import date, timedelta
from typing import Optional
from app.config import get_field_mapping


class JQLBuilder:
    """Builds JQL queries from field mapping config and filter parameters."""

    def __init__(self):
        mapping = get_field_mapping()
        jira_cfg = mapping["jira"]
        self.rft_status = jira_cfg["ready_for_testing_status"]
        self.team_ids = [m["id"] for m in jira_cfg["team_members"]]
        self.projects = jira_cfg.get("projects", [])

    def _project_clause(self, projects: list[str] | None = None) -> str:
        project_list = projects or self.projects
        if not project_list:
            return ""
        keys = ", ".join(project_list)
        return f"project in ({keys})"

    def _assignee_clause(self, member_ids: list[str] | None = None) -> str:
        ids = member_ids or self.team_ids
        return "assignee in (" + ", ".join(ids) + ")"

    def _creator_clause(self, member_ids: list[str] | None = None) -> str:
        ids = member_ids or self.team_ids
        return "creator in (" + ", ".join(ids) + ")"

    def _combine(self, clauses: list[str], operator: str = "AND") -> str:
        active = [c for c in clauses if c]
        return f" {operator} ".join(active)

    # ------------------------------------------------------------------
    # Core dashboard queries
    # ------------------------------------------------------------------

    def ready_for_testing(
        self,
        projects: list[str] | None = None,
        assignee_ids: list[str] | None = None,
    ) -> str:
        """All items in Ready for Testing, optionally filtered."""
        clauses = [
            self._project_clause(projects),
            f'status = "{self.rft_status}"',
            self._assignee_clause(assignee_ids),
        ]
        return self._combine(clauses) + " ORDER BY updated DESC"

    def bugs_last_30_days(
        self,
        creator_ids: list[str] | None = None,
        projects: list[str] | None = None,
    ) -> str:
        """Bugs created in last 30 days by QA team members."""
        clauses = [
            self._project_clause(projects),
            "issuetype = Bug",
            "created >= -30d",
            self._creator_clause(creator_ids),
        ]
        return self._combine(clauses) + " ORDER BY created DESC"

    def team_activity_last_7_days(
        self,
        member_ids: list[str] | None = None,
        projects: list[str] | None = None,
    ) -> str:
        """All items updated by team in last 7 days."""
        ids = member_ids or self.team_ids
        assignee_part = "assignee in (" + ", ".join(ids) + ")"
        updater_part = "updatedBy in (" + ", ".join(ids) + ")"
        clauses = [
            self._project_clause(projects),
            f"({assignee_part} OR {updater_part})",
            "updated >= -7d",
        ]
        return self._combine(clauses) + " ORDER BY updated DESC"

    def blockers(
        self,
        projects: list[str] | None = None,
        assignee_ids: list[str] | None = None,
    ) -> str:
        """Blocker-priority or blocker-labeled items for the team."""
        mapping = get_field_mapping()
        blocker_label = mapping["jira"].get("blocker_label", "blocker")
        critical_priorities = mapping["jira"]["priorities"]["critical"]
        priority_list = ", ".join(f'"{p}"' for p in critical_priorities)

        clauses = [
            self._project_clause(projects),
            f'(priority in ({priority_list}) OR labels = "{blocker_label}")',
            f'status != Done',
            self._assignee_clause(assignee_ids),
        ]
        return self._combine(clauses) + " ORDER BY priority ASC, updated DESC"

    def aging_in_status(
        self,
        status: str | None = None,
        min_days: int = 3,
        assignee_ids: list[str] | None = None,
        projects: list[str] | None = None,
    ) -> str:
        """Items stuck in a status for longer than min_days."""
        target_status = status or self.rft_status
        since = date.today() - timedelta(days=min_days)
        clauses = [
            self._project_clause(projects),
            f'status = "{target_status}"',
            f'statusCategory != Done',
            f'status changed to "{target_status}" before "{since.isoformat()}"',
            self._assignee_clause(assignee_ids),
        ]
        return self._combine(clauses) + " ORDER BY updated ASC"

    def trend_last_week(
        self,
        projects: list[str] | None = None,
        assignee_ids: list[str] | None = None,
    ) -> str:
        """Items created or updated in last 7 days for trend data."""
        clauses = [
            self._project_clause(projects),
            self._assignee_clause(assignee_ids),
            "updated >= -7d",
        ]
        return self._combine(clauses) + " ORDER BY updated DESC"

    def custom(
        self,
        base_jql: str,
        projects: list[str] | None = None,
        assignee_ids: list[str] | None = None,
        creator_ids: list[str] | None = None,
        status: str | None = None,
        priority: str | None = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        order_by: str = "updated DESC",
    ) -> str:
        """Build a custom filtered JQL from UI filter parameters."""
        clauses = [base_jql] if base_jql else []

        if projects:
            clauses.append(self._project_clause(projects))
        elif self.projects:
            clauses.append(self._project_clause())

        if assignee_ids:
            clauses.append("assignee in (" + ", ".join(assignee_ids) + ")")

        if creator_ids:
            clauses.append("creator in (" + ", ".join(creator_ids) + ")")

        if status:
            clauses.append(f'status = "{status}"')

        if priority:
            clauses.append(f'priority = "{priority}"')

        if date_from:
            clauses.append(f'created >= "{date_from}"')

        if date_to:
            clauses.append(f'created <= "{date_to}"')

        return self._combine(clauses) + f" ORDER BY {order_by}"


# Singleton
_builder: JQLBuilder | None = None


def get_jql_builder() -> JQLBuilder:
    global _builder
    if _builder is None:
        _builder = JQLBuilder()
    return _builder


def reset_jql_builder():
    """Call after reloading field mapping config."""
    global _builder
    _builder = None

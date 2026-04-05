"""
Pydantic response models for dashboard API endpoints.
"""
from typing import Any, Optional
from pydantic import BaseModel


class JiraUser(BaseModel):
    id: str
    name: str
    display_name: str
    avatar: Optional[str] = None
    is_team_member: bool = False


class JiraVersion(BaseModel):
    id: Optional[str] = None
    name: str
    released: bool = False


class SprintInfo(BaseModel):
    id: Optional[str] = None
    name: str
    state: Optional[str] = None


class JiraIssue(BaseModel):
    key: str
    id: str
    url: str
    summary: str
    status: Optional[str] = None
    status_category: Optional[str] = None
    priority: Optional[str] = None
    issue_type: Optional[str] = None
    assignee: Optional[JiraUser] = None
    reporter: Optional[JiraUser] = None
    qa_owner: Optional[JiraUser] = None
    created: Optional[str] = None
    updated: Optional[str] = None
    due_date: Optional[str] = None
    fix_versions: list[JiraVersion] = []
    components: list[str] = []
    labels: list[str] = []
    epic_link: Optional[str] = None
    epic_name: Optional[str] = None
    bundle: Optional[str] = None
    activity: Optional[str] = None
    sprint: Optional[SprintInfo] = None
    story_points: Optional[float] = None
    test_count: Optional[int] = None
    days_in_status: int = 0
    aging_level: str = "ok"  # ok | warning | critical | overdue


class MemberSummary(BaseModel):
    member_id: str
    member_name: str
    ready_for_testing_count: int = 0
    in_progress_count: int = 0
    blocked_count: int = 0
    total_assigned: int = 0
    overloaded: bool = False
    has_no_work: bool = False
    avg_days_in_status: float = 0.0
    versions: list[str] = []
    issues: list[JiraIssue] = []


class VersionSummary(BaseModel):
    version: str
    count: int
    issues: list[JiraIssue] = []


class ActivitySummary(BaseModel):
    activity: str
    count: int
    issues: list[JiraIssue] = []


class PrioritySummary(BaseModel):
    priority: str
    count: int


class AgingItem(BaseModel):
    issue: JiraIssue
    days_in_status: int
    aging_level: str


class TrendDay(BaseModel):
    date: str
    created: int = 0
    resolved: int = 0
    ready_for_testing: int = 0
    bugs: int = 0


class ActiveArea(BaseModel):
    area: str          # component, label, or epic
    area_type: str     # "component" | "label" | "epic"
    count: int
    issues: list[str] = []  # issue keys


class DashboardSummary(BaseModel):
    total_ready_for_testing: int = 0
    total_in_progress: int = 0
    total_blocked: int = 0
    total_bugs_30d: int = 0
    total_tests_written: int = 0
    overloaded_members: int = 0
    members_with_no_work: int = 0
    critical_items: int = 0
    overdue_items: int = 0
    cached_at: Optional[str] = None
    cache_age_seconds: Optional[int] = None


class DashboardData(BaseModel):
    summary: DashboardSummary
    ready_for_testing: list[JiraIssue] = []
    by_member: list[MemberSummary] = []
    by_version: list[VersionSummary] = []
    by_activity: list[ActivitySummary] = []
    by_priority: list[PrioritySummary] = []
    aging_report: list[AgingItem] = []
    blockers: list[JiraIssue] = []
    trend_data: list[TrendDay] = []
    active_areas: list[ActiveArea] = []
    bugs_30d: list[JiraIssue] = []
    recent_activity: list[JiraIssue] = []


class FilterParams(BaseModel):
    projects: Optional[list[str]] = None
    assignee_ids: Optional[list[str]] = None
    creator_ids: Optional[list[str]] = None
    version: Optional[str] = None
    activity: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None


class CacheStatus(BaseModel):
    cached: bool
    cached_at: Optional[str] = None
    age_seconds: Optional[int] = None
    ttl_seconds: int
    next_refresh: Optional[str] = None


class JiraConnectionStatus(BaseModel):
    ok: bool
    user: Optional[str] = None
    email: Optional[str] = None
    error: Optional[str] = None

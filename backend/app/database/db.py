"""
Async SQLite database setup with SQLAlchemy.
Used for changelog/audit trail storage.
Can be swapped to PostgreSQL by updating DATABASE_URL in .env.
"""
import json
import logging
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from datetime import datetime, timezone
from app.config import get_settings
import os

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class ChangelogEntryORM(Base):
    __tablename__ = "changelog"

    id = Column(Integer, primary_key=True, autoincrement=True)
    change_type = Column(String(50), nullable=False, index=True)
    component = Column(String(100), nullable=False, index=True)
    description = Column(Text, nullable=False)
    old_value = Column(Text, nullable=True)  # JSON serialized
    new_value = Column(Text, nullable=True)  # JSON serialized
    changed_by = Column(String(100), default="system")
    changed_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    version = Column(String(20), default="1.0.0")
    metadata_json = Column(Text, nullable=True)  # JSON serialized extra data


class BugDraftORM(Base):
    """In-progress bug reports saved locally before submitting to Jira."""
    __tablename__ = "bug_drafts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_name = Column(String(200), nullable=False, index=True)
    epic_key = Column(String(50), nullable=True, index=True)
    summary = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    steps_to_reproduce = Column(Text, nullable=True)
    actual_result = Column(Text, nullable=True)
    expected_result = Column(Text, nullable=True)
    severity = Column(String(50), nullable=True)
    priority = Column(String(50), nullable=True)
    environments = Column(Text, nullable=True)       # JSON array
    fix_version_id = Column(String(50), nullable=True)
    fix_version_name = Column(String(100), nullable=True)
    found_in_version_id = Column(String(50), nullable=True)
    found_in_version_name = Column(String(100), nullable=True)
    sprint_id = Column(Integer, nullable=True)
    status = Column(String(20), default="draft", index=True)  # draft | submitted
    jira_key = Column(String(50), nullable=True)
    jira_url = Column(Text, nullable=True)
    context_summary = Column(Text, nullable=True)   # AI summary of related Jira bugs
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class BugHistoryORM(Base):
    """Record of every bug successfully created through the Bug Reporter tool."""
    __tablename__ = "bug_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    jira_key = Column(String(50), nullable=False, index=True)
    jira_url = Column(Text, nullable=False)
    summary = Column(Text, nullable=False)
    product_name = Column(String(200), nullable=True)
    epic_key = Column(String(50), nullable=True)
    severity = Column(String(50), nullable=True)
    priority = Column(String(50), nullable=True)
    fix_version_name = Column(String(100), nullable=True)
    draft_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class KoneBugLinkORM(Base):
    """Maps a KONE (K-1) ticket key to the TMT0 Jira bug created from it."""
    __tablename__ = "kone_bug_links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    kone_key = Column(String(50), nullable=False, unique=True, index=True)
    jira_key = Column(String(50), nullable=False)
    jira_url = Column(Text, nullable=False)
    summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class QaEstimateORM(Base):
    """QA time estimate (hours) for a Jira issue — a dashboard-only concept,
    not backed by any Jira field. Absence of a row means "use the default"
    (configurable per issue type via AppSettingORM; 0.5h for Bugs out of the box)."""
    __tablename__ = "qa_estimates"

    issue_key = Column(String(50), primary_key=True)
    hours = Column(Float, nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class AppSettingORM(Base):
    """Generic dashboard-wide key/value settings (e.g. the default QA
    estimate hours applied to Bugs with no per-issue override)."""
    __tablename__ = "app_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class AutomationRunORM(Base):
    """One Playwright automation run against a Jira Test issue (Test Generator Phase 2)."""
    __tablename__ = "automation_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    jira_test_key = Column(String(50), nullable=False, index=True)
    story_key = Column(String(50), nullable=True, index=True)
    target_url = Column(Text, nullable=False)
    status = Column(String(20), default="pending", index=True)  # pending|running|passed|failed|error
    script_path = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    error_text = Column(Text, nullable=True)
    # accumulated stdout from the running/finished subprocess, appended to live
    # so the frontend can poll and show a console while status == "running"
    log_output = Column(Text, nullable=True)
    # path to the one screenshot captured on first step failure, if any (per-run
    # file, not shared — a shared filename across concurrent runs was a bug)
    screenshot_path = Column(Text, nullable=True)
    # what apply_jira_status actually did: "transitioned_to_done" | "commented_failure" | "skipped" | null
    jira_status_action = Column(String(30), nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class AutomationRunResultORM(Base):
    """A single step's outcome within an automation run."""
    __tablename__ = "automation_run_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, nullable=False, index=True)
    step_index = Column(Integer, nullable=False)
    description = Column(Text, nullable=True)
    status = Column(String(20), nullable=False)  # passed|failed
    screenshot_path = Column(Text, nullable=True)
    error_text = Column(Text, nullable=True)
    # JSON string {x, y, width, height} in page pixels — the failing element's
    # bounding box, when the script could identify one, for overlaying a marker
    # on the run's screenshot. Null when no specific element could be pinned down.
    element_box = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class AutomationBugCandidateORM(Base):
    """A candidate bug surfaced from a failed automation run — pending review
    before optionally being filed as a real Jira Bug via create_bug_service."""
    __tablename__ = "automation_bug_candidates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, nullable=False, index=True)
    jira_test_key = Column(String(50), nullable=False, index=True)
    story_key = Column(String(50), nullable=True)
    title = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    screenshot_path = Column(Text, nullable=True)
    status = Column(String(20), default="candidate", index=True)  # candidate|filed|dismissed
    jira_bug_key = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class SprintQAActivityORM(Base):
    """A QA activity planned for a Jira sprint — may be linked to a specific story."""
    __tablename__ = "sprint_qa_activities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sprint_id = Column(Integer, nullable=False, index=True)
    sprint_name = Column(String(200), nullable=True)
    story_key = Column(String(50), nullable=True, index=True)
    story_summary = Column(Text, nullable=True)
    activity_name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    estimation_hours = Column(Float, nullable=True)
    order_index = Column(Integer, default=0)
    activity_type = Column(String(50), default="qa_testing")  # qa_testing|regression|smoke_test|review|exploratory|other
    status = Column(String(30), default="planned")  # planned|in_progress|done|blocked
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class SprintStoryTrackingORM(Base):
    """Per-story RFT (Ready For Testing) tracking: planned vs actual dates and delay reasons."""
    __tablename__ = "sprint_story_tracking"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sprint_id = Column(Integer, nullable=False, index=True)
    story_key = Column(String(50), nullable=False, index=True)
    story_summary = Column(Text, nullable=True)
    planned_rft_date = Column(String(20), nullable=True)   # ISO date YYYY-MM-DD
    actual_rft_date = Column(String(20), nullable=True)    # ISO date YYYY-MM-DD
    delay_reason = Column(String(100), nullable=True)      # environment_issue|dependency_issue|capacity_overload|dev_delay|scope_change|missing_requirements|other
    delay_notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


# Engine and session factory
_engine = None
_session_factory = None


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        db_url = settings.database_url

        # Ensure data directory exists for SQLite
        if "sqlite" in db_url:
            db_path = db_url.split("///")[-1]
            if db_path and db_path != ":memory:":
                os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

        _engine = create_async_engine(
            db_url,
            echo=False,
            connect_args={"check_same_thread": False} if "sqlite" in db_url else {},
        )
    return _engine


def get_session_factory():
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def init_db():
    """Create all tables if they don't exist."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _add_missing_columns(conn)
    logger.info("Database initialized")


# create_all only creates missing TABLES, not missing COLUMNS on tables that
# already exist — this project has no migration tool, so new columns added to
# an existing ORM class need a one-line ALTER TABLE here. Safe to run every
# startup: SQLite's "duplicate column name" error on a column that already
# exists is caught and ignored.
_NEW_COLUMNS = [
    ("automation_runs", "log_output", "TEXT"),
    ("automation_runs", "screenshot_path", "TEXT"),
    ("automation_run_results", "element_box", "TEXT"),
]


async def _add_missing_columns(conn):
    for table, column, coltype in _NEW_COLUMNS:
        try:
            await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))
        except Exception:
            pass  # column already exists


async def get_db() -> AsyncSession:
    """FastAPI dependency for DB sessions."""
    factory = get_session_factory()
    async with factory() as session:
        yield session

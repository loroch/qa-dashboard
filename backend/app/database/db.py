"""
Async SQLite database setup with SQLAlchemy.
Used for changelog/audit trail storage.
Can be swapped to PostgreSQL by updating DATABASE_URL in .env.
"""
import json
import logging
from sqlalchemy import Column, Integer, String, Text, DateTime, text
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
    logger.info("Database initialized")


async def get_db() -> AsyncSession:
    """FastAPI dependency for DB sessions."""
    factory = get_session_factory()
    async with factory() as session:
        yield session

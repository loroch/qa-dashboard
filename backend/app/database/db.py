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

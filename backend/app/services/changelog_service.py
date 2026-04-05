"""
Changelog / audit trail service.
Every config change, widget change, and significant dashboard event
is recorded here for full traceability.
"""
import json
import logging
import math
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.db import ChangelogEntryORM, get_session_factory

logger = logging.getLogger(__name__)

DASHBOARD_VERSION = "1.0.0"


class ChangelogService:

    async def _get_session(self) -> AsyncSession:
        factory = get_session_factory()
        return factory()

    async def record(
        self,
        change_type: str,
        component: str,
        description: str,
        old_value: Any = None,
        new_value: Any = None,
        changed_by: str = "system",
        version: str = DASHBOARD_VERSION,
        metadata: dict | None = None,
    ) -> int:
        """Insert a new changelog entry. Returns the new entry ID."""
        factory = get_session_factory()
        async with factory() as session:
            entry = ChangelogEntryORM(
                change_type=change_type,
                component=component,
                description=description,
                old_value=json.dumps(old_value) if old_value is not None else None,
                new_value=json.dumps(new_value) if new_value is not None else None,
                changed_by=changed_by,
                changed_at=datetime.now(timezone.utc),
                version=version,
                metadata_json=json.dumps(metadata) if metadata else None,
            )
            session.add(entry)
            await session.commit()
            await session.refresh(entry)
            logger.info(f"Changelog [{change_type}] {component}: {description}")
            return entry.id

    async def get_entries(
        self,
        page: int = 1,
        page_size: int = 50,
        change_type: str | None = None,
        component: str | None = None,
        changed_by: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        version: str | None = None,
    ) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            query = select(ChangelogEntryORM)

            if change_type:
                query = query.where(ChangelogEntryORM.change_type == change_type)
            if component:
                query = query.where(ChangelogEntryORM.component.ilike(f"%{component}%"))
            if changed_by:
                query = query.where(ChangelogEntryORM.changed_by == changed_by)
            if version:
                query = query.where(ChangelogEntryORM.version == version)
            if date_from:
                query = query.where(ChangelogEntryORM.changed_at >= datetime.fromisoformat(date_from))
            if date_to:
                query = query.where(ChangelogEntryORM.changed_at <= datetime.fromisoformat(date_to))

            count_query = select(func.count()).select_from(query.subquery())
            total_result = await session.execute(count_query)
            total = total_result.scalar() or 0

            query = query.order_by(ChangelogEntryORM.changed_at.desc())
            query = query.offset((page - 1) * page_size).limit(page_size)

            result = await session.execute(query)
            rows = result.scalars().all()

            entries = []
            for row in rows:
                entries.append({
                    "id": row.id,
                    "change_type": row.change_type,
                    "component": row.component,
                    "description": row.description,
                    "old_value": json.loads(row.old_value) if row.old_value else None,
                    "new_value": json.loads(row.new_value) if row.new_value else None,
                    "changed_by": row.changed_by,
                    "changed_at": row.changed_at.isoformat() if row.changed_at else None,
                    "version": row.version,
                    "metadata": json.loads(row.metadata_json) if row.metadata_json else None,
                })

            return {
                "entries": entries,
                "total": total,
                "page": page,
                "page_size": page_size,
                "total_pages": math.ceil(total / page_size) if page_size else 1,
            }

    async def get_all_for_export(self) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(ChangelogEntryORM).order_by(ChangelogEntryORM.changed_at.desc())
            )
            rows = result.scalars().all()
            return [
                {
                    "id": r.id,
                    "change_type": r.change_type,
                    "component": r.component,
                    "description": r.description,
                    "old_value": r.old_value,
                    "new_value": r.new_value,
                    "changed_by": r.changed_by,
                    "changed_at": r.changed_at.isoformat() if r.changed_at else None,
                    "version": r.version,
                }
                for r in rows
            ]

    async def seed_initial_entries(self):
        """Seed the changelog with the initial project creation entry."""
        factory = get_session_factory()
        async with factory() as session:
            count_result = await session.execute(select(func.count()).select_from(ChangelogEntryORM))
            count = count_result.scalar() or 0
            if count == 0:
                await self.record(
                    change_type="design",
                    component="dashboard",
                    description="Initial QA Dashboard created",
                    new_value={"version": DASHBOARD_VERSION, "features": [
                        "Ready for Testing view",
                        "Team workload summary",
                        "Aging report",
                        "Bugs 30d report",
                        "Trend data",
                        "Changelog",
                        "Export to CSV/Excel",
                    ]},
                    version=DASHBOARD_VERSION,
                )
                logger.info("Changelog seeded with initial entry")


_service: ChangelogService | None = None


def get_changelog_service() -> ChangelogService:
    global _service
    if _service is None:
        _service = ChangelogService()
    return _service

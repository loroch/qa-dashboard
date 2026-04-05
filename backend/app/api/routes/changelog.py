"""
Changelog API routes.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Any

from app.services.changelog_service import get_changelog_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/changelog", tags=["changelog"])


class ChangelogCreateRequest(BaseModel):
    change_type: str        # config | query | widget | design | backend | jira
    component: str
    description: str
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None
    changed_by: str = "system"
    version: str = "1.0.0"
    metadata: Optional[dict] = None


@router.get("")
async def list_changelog(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    change_type: Optional[str] = Query(None),
    component: Optional[str] = Query(None),
    changed_by: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None, description="ISO datetime"),
    date_to: Optional[str] = Query(None),
    version: Optional[str] = Query(None),
):
    """Paginated changelog with optional filters."""
    try:
        svc = get_changelog_service()
        return await svc.get_entries(
            page=page,
            page_size=page_size,
            change_type=change_type,
            component=component,
            changed_by=changed_by,
            date_from=date_from,
            date_to=date_to,
            version=version,
        )
    except Exception as e:
        logger.error(f"Changelog list error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("")
async def create_changelog_entry(body: ChangelogCreateRequest):
    """Manually record a changelog entry (e.g., config changes from UI)."""
    try:
        svc = get_changelog_service()
        entry_id = await svc.record(
            change_type=body.change_type,
            component=body.component,
            description=body.description,
            old_value=body.old_value,
            new_value=body.new_value,
            changed_by=body.changed_by,
            version=body.version,
            metadata=body.metadata,
        )
        return {"id": entry_id, "status": "created"}
    except Exception as e:
        logger.error(f"Changelog create error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

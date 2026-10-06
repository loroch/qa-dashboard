"""
QA Activity Report API routes.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Query, HTTPException

from app.services.activity_service import get_activity_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/activity", tags=["activity"])


@router.get("/report")
async def get_activity_report(
    days:      int           = Query(7,    ge=1, le=365),
    version:   Optional[str] = Query(None),
    scope_key: Optional[str] = Query(None, description="Epic or Story key to scope to"),
    refresh:   bool          = Query(False),
):
    """QA activity report: status transitions, bugs opened/closed, stories, tests."""
    try:
        svc = get_activity_service()
        return await svc.get_activity_report(
            days=days,
            version=version or None,
            scope_key=scope_key or None,
            force_refresh=refresh,
        )
    except Exception as e:
        logger.error(f"Activity report error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

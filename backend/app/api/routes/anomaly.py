"""
Anomaly Detection API routes.

GET  /api/anomaly/tests-without-parent
     → Test cases linked to Stories but missing a parent field

POST /api/anomaly/assign-parent   { test_key, parent_key }
     → Set parent field on a Test issue in Jira

GET  /api/anomaly/incomplete-bugs?days=30
     → Bugs missing fix version / parent / sprint (8 / 30 / 60 day windows)

GET  /api/anomaly/duplicate-bugs?days=60
     → Potential duplicate bugs grouped by text-similarity clusters (30 / 60 / 90 day windows)
"""
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.anomaly_service import get_anomaly_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/anomaly", tags=["anomaly"])

VALID_INCOMPLETE_DAYS = {8, 30, 60}
VALID_DUPLICATE_DAYS = {30, 60, 90}
VALID_ACTIVITY_DAYS  = {1, 3, 7, 30}


# ── Request models ──────────────────────────────────────────────────────────

class AssignParentRequest(BaseModel):
    test_key: str
    parent_key: str


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/tests-without-parent")
async def get_tests_without_parent(refresh: bool = Query(False)):
    """Return Test issues that are linked to a Story but have no parent set."""
    try:
        svc = get_anomaly_service()
        return await svc.get_tests_without_parent(force_refresh=refresh)
    except Exception as exc:
        logger.error("get_tests_without_parent failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/assign-parent")
async def assign_parent(req: AssignParentRequest):
    """Set the parent field on a Test issue to the given parent key (Epic)."""
    try:
        svc = get_anomaly_service()
        return await svc.assign_parent(req.test_key, req.parent_key)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "assign_parent failed for test=%s parent=%s: %s",
            req.test_key, req.parent_key, exc, exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/incomplete-bugs")
async def get_incomplete_bugs(
    days: int = Query(30, description="Time window: 8, 30, or 60 days"),
    refresh: bool = Query(False),
):
    """Return bugs missing fix version, parent, or sprint in the given window."""
    if days not in VALID_INCOMPLETE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"'days' must be one of {sorted(VALID_INCOMPLETE_DAYS)}",
        )
    try:
        svc = get_anomaly_service()
        return await svc.get_incomplete_bugs(days, force_refresh=refresh)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_incomplete_bugs failed (days=%s): %s", days, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/duplicate-bugs")
async def get_duplicate_bugs(
    days: int = Query(60, description="Time window: 30, 60, or 90 days"),
    refresh: bool = Query(False),
):
    """Return clusters of potentially duplicate bugs based on summary similarity."""
    if days not in VALID_DUPLICATE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"'days' must be one of {sorted(VALID_DUPLICATE_DAYS)}",
        )
    try:
        svc = get_anomaly_service()
        return await svc.get_duplicate_bugs(days, force_refresh=refresh)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_duplicate_bugs failed (days=%s): %s", days, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/team-activity")
async def get_team_activity(
    days: int = Query(7, description="Time window: 1, 3, 7, or 30 days"),
    refresh: bool = Query(False),
):
    """Return status changes and comments made by QA team members within the window."""
    if days not in VALID_ACTIVITY_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"'days' must be one of {sorted(VALID_ACTIVITY_DAYS)}",
        )
    try:
        svc = get_anomaly_service()
        return await svc.get_team_activity(days, force_refresh=refresh)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_team_activity failed (days=%s): %s", days, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

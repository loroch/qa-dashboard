"""
Dashboard API routes.
All dashboard data endpoints live here.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Query, HTTPException

from app.services.dashboard_service import get_dashboard_service
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _build_filters(
    projects: Optional[str],
    assignee_ids: Optional[str],
    creator_ids: Optional[str],
    version: Optional[str],
    status: Optional[str],
    priority: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
) -> dict | None:
    f = {}
    if projects:
        f["projects"] = [p.strip() for p in projects.split(",")]
    if assignee_ids:
        f["assignee_ids"] = [a.strip() for a in assignee_ids.split(",")]
    if creator_ids:
        f["creator_ids"] = [c.strip() for c in creator_ids.split(",")]
    if version:
        f["version"] = version
    if status:
        f["status"] = status
    if priority:
        f["priority"] = priority
    if date_from:
        f["date_from"] = date_from
    if date_to:
        f["date_to"] = date_to
    return f if f else None


@router.get("/summary")
async def get_full_dashboard(
    refresh: bool = Query(False, description="Force cache refresh"),
    projects: Optional[str] = Query(None, description="Comma-separated project keys"),
    assignee_ids: Optional[str] = Query(None, description="Comma-separated Jira account IDs"),
    creator_ids: Optional[str] = Query(None),
    version: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None, description="ISO date YYYY-MM-DD"),
    date_to: Optional[str] = Query(None),
):
    """Full dashboard data: summary, RFT, by member, trends, aging, blockers."""
    try:
        filters = _build_filters(projects, assignee_ids, creator_ids, version, status, priority, date_from, date_to)
        svc = get_dashboard_service()
        data = await svc.get_full_dashboard(filters=filters, force_refresh=refresh)
        return data
    except Exception as e:
        logger.error(f"Dashboard summary error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ready-for-testing")
async def get_ready_for_testing(
    refresh: bool = Query(False),
    projects: Optional[str] = Query(None),
    assignee_ids: Optional[str] = Query(None),
):
    """All items in Ready for Testing status, assignable to QA team."""
    try:
        filters = _build_filters(projects, assignee_ids, None, None, None, None, None, None)
        svc = get_dashboard_service()
        return await svc.get_ready_for_testing(filters=filters, force_refresh=refresh)
    except Exception as e:
        logger.error(f"RFT error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs")
async def get_bugs(
    refresh: bool = Query(False),
    projects: Optional[str] = Query(None),
    creator_ids: Optional[str] = Query(None),
):
    """Bugs created in the last 30 days by QA team members."""
    try:
        filters = _build_filters(projects, None, creator_ids, None, None, None, None, None)
        svc = get_dashboard_service()
        return await svc.get_bugs(filters=filters, force_refresh=refresh)
    except Exception as e:
        logger.error(f"Bugs error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/blockers")
async def get_blockers(
    refresh: bool = Query(False),
    projects: Optional[str] = Query(None),
    assignee_ids: Optional[str] = Query(None),
):
    """Critical and blocker items assigned to QA team."""
    try:
        filters = _build_filters(projects, assignee_ids, None, None, None, None, None, None)
        svc = get_dashboard_service()
        return await svc.get_blockers(filters=filters, force_refresh=refresh)
    except Exception as e:
        logger.error(f"Blockers error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs-by-version")
async def get_bugs_by_version(
    version: str = Query(..., description="Fix version name"),
    statuses: Optional[str] = Query(None, description="Comma-separated statuses to filter"),
    refresh: bool = Query(False),
):
    """All bugs for a specific fix version with stats. Statuses filtered server-side."""
    try:
        svc = get_dashboard_service()
        data = await svc.get_bugs_by_version(version, force_refresh=refresh)
        if statuses:
            sl = [s.strip().lower() for s in statuses.split(",")]
            data = {**data, "bugs": [b for b in data["bugs"] if (b.get("status") or "").lower() in sl]}
        return data
    except Exception as e:
        logger.error(f"Bugs-by-version error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/refresh")
async def manual_refresh():
    """Trigger a full manual cache refresh."""
    try:
        svc = get_dashboard_service()
        await svc.refresh_all()
        return {"status": "ok", "message": "Dashboard data refreshed"}
    except Exception as e:
        logger.error(f"Manual refresh error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cache/status")
async def cache_status():
    """Current cache state and TTL info."""
    cache = get_cache()
    settings = get_settings()
    return {
        "ttl_seconds": settings.cache_ttl_seconds,
        "keys": cache.list_keys(),
    }

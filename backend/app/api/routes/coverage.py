"""
Test Coverage API routes.
"""
import logging
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.coverage_service import get_coverage_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage"])


class AssignTestRequest(BaseModel):
    test_key: str
    story_key: str
    fix_version: Optional[str] = None


@router.get("/versions")
async def get_versions(refresh: bool = Query(False)):
    """List all fix versions."""
    try:
        svc = get_coverage_service()
        return await svc.get_versions(force_refresh=refresh)
    except Exception as e:
        logger.error(f"Coverage versions error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-version")
async def get_by_version(
    version: str = Query(..., description="Fix version name e.g. K1-S-3.1.0"),
    refresh: bool = Query(False),
):
    """Stories and Epics with test case counts for a given fix version."""
    try:
        svc = get_coverage_service()
        return await svc.get_by_version(version, force_refresh=refresh)
    except Exception as e:
        logger.error(f"Coverage by-version error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/unlinked-tests")
async def get_unlinked_tests(refresh: bool = Query(False)):
    """Test cases that are not linked to any story."""
    try:
        svc = get_coverage_service()
        return await svc.get_unlinked_tests(force_refresh=refresh)
    except Exception as e:
        logger.error(f"Coverage unlinked tests error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/assign-test")
async def assign_test(body: AssignTestRequest):
    """Link a test case to a story and optionally set a fix version."""
    try:
        svc = get_coverage_service()
        result = await svc.assign_test(
            test_key=body.test_key,
            story_key=body.story_key,
            fix_version=body.fix_version,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("error"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Assign test error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-stories")
async def search_stories(q: str = Query(..., min_length=2)):
    """Search stories by text for the assign dialog."""
    try:
        svc = get_coverage_service()
        return await svc.search_stories(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

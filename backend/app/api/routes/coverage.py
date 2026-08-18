"""
Test Coverage API routes.
"""
import logging
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.coverage_service import get_coverage_service
from app.services.test_generator_service import TestGeneratorService
from app.jira.client import get_jira_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage"])


class AssignTestRequest(BaseModel):
    test_key: str
    story_key: str
    fix_version: Optional[str] = None


class GenerateStoryTestsRequest(BaseModel):
    story_key: str
    mode: str = "basic"   # "basic" (3-5) | "extended" (6-10)


class CreateStoryTestsRequest(BaseModel):
    story_key: str
    test_cases: list[dict]
    fix_version: str = ""


class TestTransitionRequest(BaseModel):
    test_key: str
    transition_id: str
    version: Optional[str] = None


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


@router.get("/regression-tests")
async def get_regression_tests(
    version: Optional[str] = Query(None, description="Fix version to scope regression tests"),
    refresh: bool = Query(False),
):
    """Test issues labeled REGRESSION_TEST, scoped to a fix version when provided."""
    try:
        svc = get_coverage_service()
        return await svc.get_regression_tests(version=version or None, force_refresh=refresh)
    except Exception as e:
        logger.error(f"Coverage regression tests error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-story-tests")
async def generate_story_tests(body: GenerateStoryTestsRequest):
    """AI-generate test cases for a story using Jira + Epic + Confluence + Figma context."""
    try:
        svc = TestGeneratorService()
        return await svc.generate_test_cases(
            story_key=body.story_key,
            mode=body.mode,
        )
    except Exception as e:
        logger.error(f"generate_story_tests error for {body.story_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/create-story-tests")
async def create_story_tests(body: CreateStoryTestsRequest):
    """Create AI-generated test cases in Jira and link them to the story."""
    try:
        svc = TestGeneratorService()
        created = await svc.create_test_cases(
            story_key=body.story_key,
            test_cases=body.test_cases,
            fix_version=body.fix_version,
        )
        # Invalidate coverage cache so the updated test count shows immediately
        coverage_svc = get_coverage_service()
        if body.fix_version:
            coverage_svc.cache.invalidate(f"coverage:version:{body.fix_version}")
        return {"created": created, "total": len(created), "ok": sum(1 for c in created if c.get("ok"))}
    except Exception as e:
        logger.error(f"create_story_tests error for {body.story_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/test-transitions/{test_key}")
async def get_test_transitions(test_key: str):
    """Get available Jira workflow transitions for a test issue."""
    try:
        jira = get_jira_client()
        data = await jira.get(f"/issue/{test_key}/transitions")
        transitions = [
            {
                "id":        t["id"],
                "name":      t["name"],
                "to_status": (t.get("to") or {}).get("name", ""),
            }
            for t in (data.get("transitions") or [])
        ]
        return {"transitions": transitions}
    except Exception as e:
        logger.error(f"get_test_transitions error for {test_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/test-transition")
async def perform_test_transition(body: TestTransitionRequest):
    """Perform a Jira workflow transition on a test issue."""
    try:
        jira = get_jira_client()
        await jira.post(
            f"/issue/{body.test_key}/transitions",
            {"transition": {"id": body.transition_id}},
        )
        # Invalidate the label-keyed cache for the version family
        svc = get_coverage_service()
        label = svc._regression_label(body.version)
        svc.cache.invalidate(f"coverage:regression_tests:{label}")
        return {"ok": True}
    except Exception as e:
        logger.error(f"perform_test_transition error for {body.test_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-stories")
async def search_stories(q: str = Query(..., min_length=2)):
    """Search stories by text for the assign dialog."""
    try:
        svc = get_coverage_service()
        return await svc.search_stories(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

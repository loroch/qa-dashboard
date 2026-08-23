"""
Test Coverage API routes.
"""
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import select

from app.services.coverage_service import get_coverage_service
from app.services.test_generator_service import TestGeneratorService
from app.jira.client import get_jira_client
from app.database.db import AiContentORM, get_session_factory

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
        # Invalidate the version-scoped regression cache
        svc = get_coverage_service()
        label = svc._regression_label(body.version)
        cache_key = f"coverage:regression_tests:{body.version or label}"
        svc.cache.invalidate(cache_key)
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


@router.get("/search-issues")
async def search_issues(q: str = Query(..., min_length=2)):
    """Search Epics and Stories by key or keyword (for the coverage search tab)."""
    try:
        svc = get_coverage_service()
        return await svc.search_epics_and_stories(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-issue")
async def get_by_issue(key: str = Query(..., min_length=2), refresh: bool = Query(False)):
    """Return test coverage for a specific Epic or Story key."""
    try:
        svc = get_coverage_service()
        return await svc.get_by_epic_or_story(key, force_refresh=refresh)
    except Exception as e:
        logger.error(f"Coverage by-issue error for {key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class TestPlanRequest(BaseModel):
    issue_key: str
    issue_summary: str
    issue_type: str = "Story"
    stories: list[dict] = []


class HandoverCriteriaRequest(BaseModel):
    issue_key: str
    issue_summary: str
    issue_type: str = "Story"
    stories: list[dict] = []


class JiraCommentRequest(BaseModel):
    issue_key: str
    comment_text: str


@router.post("/generate-test-plan")
async def generate_test_plan(body: TestPlanRequest):
    """AI-generate a macro-level test plan for an Epic or Story."""
    try:
        svc = get_coverage_service()
        return await svc.generate_test_plan(
            body.issue_key, body.issue_summary, body.issue_type, body.stories
        )
    except Exception as e:
        logger.error(f"generate_test_plan error for {body.issue_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-handover-criteria")
async def generate_handover_criteria(body: HandoverCriteriaRequest):
    """AI-generate handover meeting exit criteria for an Epic or Story."""
    try:
        svc = get_coverage_service()
        return await svc.generate_handover_criteria(
            body.issue_key, body.issue_summary, body.issue_type, body.stories
        )
    except Exception as e:
        logger.error(f"generate_handover_criteria error for {body.issue_key}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/add-jira-comment")
async def add_jira_comment(body: JiraCommentRequest):
    """Add a plain-text comment to a Jira issue."""
    try:
        svc = get_coverage_service()
        return await svc.add_jira_comment(body.issue_key, body.comment_text)
    except Exception as e:
        msg = str(e)
        status = 400 if "404" in msg or "does not exist" in msg or "permission" in msg.lower() else 500
        logger.error(f"add_jira_comment error for {body.issue_key}: {e}")
        raise HTTPException(status_code=status, detail=msg)


# ── AI Content persistence ─────────────────────────────────────────────────

class SaveAiContentRequest(BaseModel):
    issue_key: str
    content_type: str   # test_plan | handover_criteria
    content: dict


@router.get("/ai-content/{issue_key}")
async def get_ai_content(issue_key: str):
    """Return persisted AI content (test plan + handover criteria) for a Jira issue key."""
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(
            select(AiContentORM).where(AiContentORM.issue_key == issue_key)
        )
        rows = result.scalars().all()
    out = {}
    for row in rows:
        out[row.content_type] = {
            "content": json.loads(row.content),
            "generated_at": row.generated_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    return out


@router.post("/ai-content")
async def save_ai_content(body: SaveAiContentRequest):
    """Upsert AI-generated content for an issue key + type pair."""
    factory = get_session_factory()
    now = datetime.now(timezone.utc)
    async with factory() as session:
        result = await session.execute(
            select(AiContentORM).where(
                AiContentORM.issue_key == body.issue_key,
                AiContentORM.content_type == body.content_type,
            )
        )
        row = result.scalar_one_or_none()
        if row:
            row.content = json.dumps(body.content)
            row.generated_at = now
        else:
            session.add(AiContentORM(
                issue_key=body.issue_key,
                content_type=body.content_type,
                content=json.dumps(body.content),
                generated_at=now,
            ))
        await session.commit()
    return {"ok": True, "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ")}

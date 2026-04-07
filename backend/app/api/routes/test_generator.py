"""
Test Case Generator API routes.

GET  /api/test-generator/stories?version=<fix-version>
     → Stories in that fix version that have no test case links

POST /api/test-generator/generate   { story_key }
     → Call Claude to generate test cases for the story

POST /api/test-generator/create     { story_key, test_cases, fix_version }
     → Create Test issues in Jira and link them to the story
"""
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.test_generator_service import get_test_generator_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/test-generator", tags=["test-generator"])


# ── Request / Response models ──────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    story_key: str


class TestCaseItem(BaseModel):
    summary: str
    description: str = ""
    steps: list[str] = []
    expected: str = ""
    source: str = ""


class CreateRequest(BaseModel):
    story_key: str
    test_cases: list[TestCaseItem]
    fix_version: str = ""


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/versions")
async def get_fix_versions():
    """Return all fix versions from all visible Jira projects (unreleased first)."""
    try:
        svc = get_test_generator_service()
        return await svc.get_fix_versions()
    except Exception as exc:
        logger.error("get_fix_versions failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/stories")
async def get_stories_without_tests(
    version: str = Query(..., description="Fix version name, e.g. K1-S-3.1.0"),
):
    """Return all Stories in the fix version that have no test case links."""
    try:
        svc = get_test_generator_service()
        return await svc.get_stories_without_tests(version)
    except Exception as exc:
        logger.error("get_stories_without_tests failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/generate")
async def generate_test_cases(req: GenerateRequest):
    """Generate test cases for a story using Jira + Confluence context + Claude."""
    try:
        svc = get_test_generator_service()
        return await svc.generate_test_cases(req.story_key)
    except ValueError as exc:
        # e.g. missing API key
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error(
            "generate_test_cases failed for %s: %s", req.story_key, exc, exc_info=True
        )
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/create")
async def create_test_cases(req: CreateRequest):
    """Create approved test cases as Test issues in Jira, linked to the story."""
    try:
        svc = get_test_generator_service()
        results = await svc.create_test_cases(
            story_key=req.story_key,
            test_cases=[tc.model_dump() for tc in req.test_cases],
            fix_version=req.fix_version,
        )
        return {
            "story_key": req.story_key,
            "fix_version": req.fix_version,
            "created": results,
            "total": len(results),
            "success_count": sum(1 for r in results if r["ok"]),
            "failure_count": sum(1 for r in results if not r["ok"]),
        }
    except Exception as exc:
        logger.error("create_test_cases failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

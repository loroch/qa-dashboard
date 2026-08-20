"""
Test Case Generator API routes.

GET  /api/test-generator/versions
     → Fix versions from all Jira projects

GET  /api/test-generator/stories?version=<fix-version>
     → Stories in that fix version that have no test case links

GET  /api/test-generator/epics/search?q=<query>
     → Search Epics by key or summary

GET  /api/test-generator/epics/{epic_key}/children
     → Story/Task children of an Epic

POST /api/test-generator/context   { story_key, sources?, figma_url? }
     → Fetch story context (+ optional Confluence/Figma) and an AI summary (Step 2)

POST /api/test-generator/upload-context
     → Upload files/images, extract content for enriching test generation

POST /api/test-generator/generate   { story_key, extra_context?, sources?, figma_url? }
     → Call Claude to generate test cases for the story

POST /api/test-generator/create     { story_key, test_cases, fix_version }
     → Create Test issues in Jira and link them to the story
"""
import logging

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.services.test_generator_service import (
    ALLOWED_EXTENSIONS,
    get_test_generator_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/test-generator", tags=["test-generator"])

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per file
MAX_FILES = 5


# ── Request / Response models ──────────────────────────────────────────────────

class SourceToggles(BaseModel):
    jira: bool = True
    confluence: bool = True
    figma: bool = True


class StoryKeyRequest(BaseModel):
    story_key: str
    sources: SourceToggles = SourceToggles()
    figma_url: str = ""


class GenerateRequest(BaseModel):
    story_key: str
    extra_context: str = ""
    mode: str = "basic"   # "basic" (1-5) or "extended" (1-10)
    sources: SourceToggles = SourceToggles()
    figma_url: str = ""


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
    ai_summary: str = ""


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


@router.get("/epics/search")
async def search_epics(q: str = Query(..., min_length=2)):
    """Search Epics by key or summary."""
    try:
        svc = get_test_generator_service()
        return {"epics": await svc.search_epics(q)}
    except Exception as exc:
        logger.error("search_epics failed for %s: %s", q, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/epics/{epic_key}/children")
async def get_epic_children(epic_key: str):
    """Return Story/Task children of an Epic."""
    try:
        svc = get_test_generator_service()
        return {"children": await svc.get_epic_children(epic_key)}
    except Exception as exc:
        logger.error("get_epic_children failed for %s: %s", epic_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/context")
async def get_story_context(req: StoryKeyRequest):
    """Fetch story context + AI summary for Step 2 preview."""
    try:
        svc = get_test_generator_service()
        return await svc.get_story_context(
            req.story_key,
            sources=req.sources.model_dump(),
            figma_url=req.figma_url,
        )
    except Exception as exc:
        logger.error("get_story_context failed for %s: %s", req.story_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/upload-context")
async def upload_context_files(
    files: list[UploadFile] = File(...),
):
    """
    Upload files (text or images) to enrich test case generation context.
    Returns extracted text and a per-file summary.
    """
    if len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Maximum {MAX_FILES} files allowed.")

    files_data = []
    for f in files:
        ext = "." + f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"'{f.filename}' has unsupported type. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
            )
        data = await f.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail=f"'{f.filename}' exceeds 10 MB limit.")
        files_data.append({
            "name": f.filename,
            "content_type": f.content_type or "",
            "data": data,
        })

    try:
        svc = get_test_generator_service()
        extracted_text, summaries = await svc.process_files(files_data)
        return {
            "extracted_text": extracted_text,
            "files": summaries,
            "total_chars": len(extracted_text),
        }
    except Exception as exc:
        logger.error("upload_context_files failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/generate")
async def generate_test_cases(req: GenerateRequest):
    """Generate test cases for a story using Jira + Confluence + Figma context + Claude."""
    try:
        svc = get_test_generator_service()
        return await svc.generate_test_cases(
            req.story_key,
            req.extra_context,
            req.mode,
            sources=req.sources.model_dump(),
            figma_url=req.figma_url,
        )
    except ValueError as exc:
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
            ai_summary=req.ai_summary,
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

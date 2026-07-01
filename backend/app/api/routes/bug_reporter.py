"""
Bug Reporter API routes.

GET  /api/bug-reporter/meta
     → Epics (products), versions, sprints, priorities, severities, environments

POST /api/bug-reporter/product-context  { epic_key }
     → Fetch existing bugs for the epic, return AI summary of what bugs exist

POST /api/bug-reporter/upload-files     (multipart)
     → Upload logs / screenshots, extract text / describe images

POST /api/bug-reporter/generate         { epic_key, product_name, description, extra_context, context_summary }
     → Claude generates full Jira bug template

GET  /api/bug-reporter/drafts
     → List saved drafts

POST /api/bug-reporter/draft            { ...bug fields }
     → Save a draft to local DB

DELETE /api/bug-reporter/draft/{id}
     → Delete a draft

POST /api/bug-reporter/create           { ...confirmed bug fields, draft_id? }
     → Create the bug in Jira, write to history

GET  /api/bug-reporter/history
     → List bugs created through this tool
"""
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.services.bug_reporter_service import ALLOWED_EXTENSIONS, get_bug_reporter_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bug-reporter", tags=["bug-reporter"])

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_FILES = 10


# ── Request models ─────────────────────────────────────────────────────────────

class EpicKeyRequest(BaseModel):
    epic_key: str


class GenerateRequest(BaseModel):
    epic_key: str
    product_name: str
    description: str
    extra_context: str = ""
    context_summary: str = ""


class DraftRequest(BaseModel):
    product_name: str
    epic_key: str | None = None
    summary: str | None = None
    description: str | None = None
    steps_to_reproduce: str | None = None
    actual_result: str | None = None
    expected_result: str | None = None
    severity: str | None = None
    priority: str | None = None
    environments: list[str] = []
    fix_version_id: str | None = None
    fix_version_name: str | None = None
    found_in_version_id: str | None = None
    found_in_version_name: str | None = None
    sprint_id: int | None = None
    context_summary: str | None = None


class CreateBugRequest(BaseModel):
    product_name: str
    epic_key: str | None = None
    summary: str
    description: str = ""
    steps_to_reproduce: str = ""
    actual_result: str = ""
    expected_result: str = ""
    severity: str = "Medium"
    priority: str = "Medium"
    environments: list[str] = []
    fix_version_id: str | None = None
    fix_version_name: str | None = None
    found_in_version_id: str | None = None
    found_in_version_name: str | None = None
    sprint_id: int | None = None
    draft_id: int | None = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/meta")
async def get_meta():
    """Return products (epics), versions, sprints, priorities, severities."""
    try:
        svc = get_bug_reporter_service()
        return await svc.get_meta()
    except Exception as exc:
        logger.error("get_meta failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/product-context")
async def get_product_context(req: EpicKeyRequest):
    """Fetch existing bugs for an epic and return an AI summary of the product area."""
    try:
        svc = get_bug_reporter_service()
        return await svc.get_product_context(req.epic_key)
    except Exception as exc:
        logger.error("get_product_context failed for %s: %s", req.epic_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/upload-files")
async def upload_files(files: list[UploadFile] = File(...)):
    """Upload log files or screenshots to enrich bug template generation."""
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
        files_data.append({"name": f.filename, "content_type": f.content_type or "", "data": data})

    try:
        svc = get_bug_reporter_service()
        extracted_text, summaries = await svc.process_files(files_data)
        return {
            "extracted_text": extracted_text,
            "files": summaries,
            "total_chars": len(extracted_text),
        }
    except Exception as exc:
        logger.error("upload_files failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/generate")
async def generate_bug_template(req: GenerateRequest):
    """Generate a complete Jira bug template using Claude."""
    try:
        svc = get_bug_reporter_service()
        return await svc.generate_bug_template(
            epic_key=req.epic_key,
            product_name=req.product_name,
            description=req.description,
            extra_context=req.extra_context,
            context_summary=req.context_summary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("generate_bug_template failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/drafts")
async def get_drafts():
    """Return all saved bug drafts."""
    try:
        svc = get_bug_reporter_service()
        return await svc.get_drafts()
    except Exception as exc:
        logger.error("get_drafts failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/draft")
async def save_draft(req: DraftRequest):
    """Save a bug draft to the local database."""
    try:
        svc = get_bug_reporter_service()
        return await svc.save_draft(req.model_dump())
    except Exception as exc:
        logger.error("save_draft failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/draft/{draft_id}")
async def delete_draft(draft_id: int):
    """Delete a bug draft by ID."""
    try:
        svc = get_bug_reporter_service()
        deleted = await svc.delete_draft(draft_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Draft not found")
        return {"deleted": True, "id": draft_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("delete_draft failed for id=%s: %s", draft_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/create")
async def create_bug(req: CreateBugRequest):
    """Create the Jira bug from the confirmed template."""
    try:
        svc = get_bug_reporter_service()
        return await svc.create_jira_bug(req.model_dump())
    except Exception as exc:
        logger.error("create_bug failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/history")
async def get_history():
    """Return bugs previously created through the Bug Reporter."""
    try:
        svc = get_bug_reporter_service()
        return await svc.get_history()
    except Exception as exc:
        logger.error("get_history failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

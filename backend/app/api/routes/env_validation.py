"""
Validation Portal API routes.

GET  /api/validation/profile[?reveal=true]   effective environment profile (passwords masked unless reveal)
PUT  /api/validation/profile                 save edits (masked password = keep current)
POST /api/validation/profile/reset           back to the .env defaults
POST /api/validation/test/{target}           { profile? } → connection test (web|db|elastic|ssh|jira|figma|smtp|ai)
POST /api/validation/sql                     { sql, profile? } → read-only query preview
GET  /api/validation/issue/{key}             issue tree, AC, linked tests/bugs, Figma links, spec colors
POST /api/validation/issue/{key}/explain     plain-language explanation + recommended tests (?refresh=true)
POST /api/validation/runs                    { issue_key, options, profile? } → starts a run in the background
GET  /api/validation/runs                    recent runs
GET  /api/validation/runs/{id}               run status, live log, results, findings
GET  /api/validation/screenshots/{name}      probe screenshot
POST /api/validation/runs/{id}/bugs          { finding_id, summary, description, priority? } → real Jira Bug
GET  /api/validation/runs/{id}/report        HTML report (?findings=F1,F2)
POST /api/validation/runs/{id}/email         { to[], cc[], subject?, finding_ids?, note? } → send via SMTP
"""
import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from app.services.env_validation_service import get_env_validation_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/validation", tags=["validation"])

# Same pattern as automation.py: hold a reference so a running task isn't GC'd.
_background_tasks: set[asyncio.Task] = set()


def _fire(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


class ProfileBody(BaseModel):
    profile: dict | None = None


class SqlRequest(BaseModel):
    sql: str
    profile: dict | None = None


class RunRequest(BaseModel):
    issue_key: str
    options: dict = {}
    profile: dict | None = None


class BugRequest(BaseModel):
    finding_id: str
    summary: str
    description: str
    priority: str | None = None
    attach_screenshot: bool = True


class EmailRequest(BaseModel):
    to: list[str]
    cc: list[str] = []
    subject: str | None = None
    finding_ids: list[str] | None = None
    note: str = ""


@router.get("/profile")
async def get_profile(reveal: bool = False):
    return await get_env_validation_service().get_profile(reveal=reveal)


@router.put("/profile")
async def save_profile(profile: dict):
    return await get_env_validation_service().save_profile(profile)


@router.post("/profile/reset")
async def reset_profile():
    return await get_env_validation_service().reset_profile()


@router.post("/test/{target}")
async def test_connection(target: str, body: ProfileBody | None = None):
    return await get_env_validation_service().test_connection(target, body.profile if body else None)


@router.post("/sql")
async def run_sql(req: SqlRequest):
    try:
        return await get_env_validation_service().run_sql(req.sql, req.profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Query failed: {exc}")


@router.get("/issue/{key}")
async def load_issue(key: str):
    try:
        return await get_env_validation_service().load_issue(key)
    except Exception as exc:
        logger.error("load_issue %s failed: %s", key, exc, exc_info=True)
        raise HTTPException(status_code=404, detail=f"Could not load {key}: {exc}")


@router.post("/issue/{key}/explain")
async def explain_issue(key: str, refresh: bool = False):
    """Plain-language explanation + recommended test plan (cached; ?refresh=true regenerates)."""
    try:
        return await get_env_validation_service().explain_issue(key, refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("explain_issue %s failed: %s", key, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Could not explain {key}: {exc}")


@router.post("/runs")
async def create_run(req: RunRequest):
    svc = get_env_validation_service()
    run_id = await svc.create_run(req.issue_key, req.options, req.profile)
    _fire(svc.execute(run_id, req.profile))
    return await svc.get_run(run_id)


@router.get("/runs")
async def list_runs(limit: int = 30):
    return {"runs": await get_env_validation_service().list_runs(limit)}


@router.get("/runs/{run_id}")
async def get_run(run_id: int):
    run = await get_env_validation_service().get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.get("/screenshots/{name}")
async def get_screenshot(name: str):
    path = get_env_validation_service().screenshot_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    return FileResponse(path, media_type="image/png")


@router.post("/runs/{run_id}/bugs")
async def file_bug(run_id: int, req: BugRequest):
    try:
        return await get_env_validation_service().file_bug(
            run_id, req.finding_id, req.summary, req.description, req.priority, req.attach_screenshot)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("file_bug failed on run %s: %s", run_id, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Jira rejected the bug: {exc}")


@router.get("/runs/{run_id}/report", response_class=HTMLResponse)
async def report(run_id: int, findings: str | None = Query(None)):
    try:
        _, body = await get_env_validation_service().render_report(run_id, findings.split(",") if findings else None)
        return HTMLResponse(f"<!doctype html><html><head><meta charset='utf-8'><title>Validation report #{run_id}</title></head><body>{body}</body></html>")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/runs/{run_id}/email")
async def send_email(run_id: int, req: EmailRequest):
    try:
        return await get_env_validation_service().send_email(run_id, req.to, req.cc, req.subject, req.finding_ids, req.note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("send_email failed on run %s: %s", run_id, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Sending failed: {exc}")

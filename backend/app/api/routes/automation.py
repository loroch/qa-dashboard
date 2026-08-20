"""
Automation Runner API routes — Test Generator Phase 2.

POST /api/automation/runs                { jira_test_key, target_url, story_key? }
     -> creates a run and kicks off execution in the background, returns immediately
        (status "pending"/"running") — poll GET /runs/{id} for status + live log_output

GET  /api/automation/runs/{run_id}
     -> run status/summary, including log_output (live while running) and has_screenshot

GET  /api/automation/runs/{run_id}/results
     -> per-step pass/fail detail, including element_box for the frontend to overlay

GET  /api/automation/runs/{run_id}/screenshot
     -> the run's failure screenshot (PNG), if one was captured

GET  /api/automation/bug-candidates?status=candidate
     -> bug candidates surfaced from failed runs, pending review
"""
import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services.automation_runner_service import get_automation_runner_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/automation", tags=["automation"])

# Runs execute as fire-and-forget background tasks so the HTTP request returns
# immediately and the frontend can poll for live progress. asyncio.create_task
# doesn't keep its own strong reference — without holding one here, a task can
# be garbage-collected mid-run.
_background_tasks: set[asyncio.Task] = set()


def _fire(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


class CreateRunRequest(BaseModel):
    jira_test_key: str
    target_url: str
    story_key: str | None = None


class RunBatchRequest(BaseModel):
    target_url: str


@router.get("/story/{story_key}/tests")
async def get_tests_for_story(story_key: str):
    """Test issues already linked to this story/task — the persistent view,
    independent of whatever wizard session created them."""
    try:
        svc = get_automation_runner_service()
        return {"tests": await svc.get_tests_for_story(story_key)}
    except Exception as exc:
        logger.error("get_tests_for_story failed for %s: %s", story_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/story/{story_key}/runs")
async def get_latest_runs_for_story(story_key: str):
    """Most recent automation run per test for this story."""
    try:
        svc = get_automation_runner_service()
        return {"runs": await svc.get_latest_runs_for_story(story_key)}
    except Exception as exc:
        logger.error("get_latest_runs_for_story failed for %s: %s", story_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/story/{story_key}/run-batch")
async def run_batch(story_key: str, req: RunBatchRequest):
    """Kick off automation for every Test issue linked to this story, sequentially,
    in the background — returns immediately. Poll GET /story/{key}/runs to watch
    each test's run appear (as "pending") and progress to a terminal status."""
    try:
        svc = get_automation_runner_service()
        tests = await svc.get_tests_for_story(story_key)
        if not tests:
            return {"story_key": story_key, "started": False, "test_count": 0}
        _fire(svc.run_batch(story_key, req.target_url))
        return {"story_key": story_key, "started": True, "test_count": len(tests)}
    except Exception as exc:
        logger.error("run_batch failed for %s: %s", story_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/bug-candidates/{candidate_id}/file")
async def file_bug_candidate(candidate_id: int):
    """Create a real Jira Bug from a reviewed automation bug candidate."""
    try:
        svc = get_automation_runner_service()
        return await svc.file_bug_from_candidate(candidate_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("file_bug_candidate failed for %s: %s", candidate_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/runs")
async def create_and_run(req: CreateRunRequest):
    """Create an automation run and kick off execution in the background —
    returns immediately with status "pending". Poll GET /runs/{id} for
    status/log_output until it reaches a terminal status (passed/failed/error)."""
    try:
        svc = get_automation_runner_service()
        run_id = await svc.create_run(req.jira_test_key, req.target_url, req.story_key)
        _fire(svc.execute(run_id))
        return await svc.get_run(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("automation run failed for %s: %s", req.jira_test_key, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/runs/{run_id}")
async def get_run(run_id: int):
    svc = get_automation_runner_service()
    run = await svc.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.get("/runs/{run_id}/results")
async def get_run_results(run_id: int):
    svc = get_automation_runner_service()
    return {"steps": await svc.get_run_results(run_id)}


@router.get("/runs/{run_id}/screenshot")
async def get_run_screenshot(run_id: int):
    svc = get_automation_runner_service()
    path = await svc.get_screenshot_path(run_id)
    if not path:
        raise HTTPException(status_code=404, detail="No screenshot for this run")
    return FileResponse(path, media_type="image/png")


@router.get("/bug-candidates")
async def get_bug_candidates(status: str = Query("candidate"), story_key: str | None = Query(None)):
    svc = get_automation_runner_service()
    return {"candidates": await svc.get_bug_candidates(status, story_key)}

"""
Test Plans API routes.

GET  /api/test-plans/versions            Fix versions for TMT0 project
POST /api/test-plans/resolve-ids         Resolve numeric issue IDs → issue keys + details
POST /api/test-plans/create              Create Epic + link all tests
"""
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.services.test_plans_service import get_test_plans_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/test-plans", tags=["test-plans"])


class ResolveIdsRequest(BaseModel):
    issue_ids: list[str]   # numeric IDs or keys, e.g. ["48240", "TMT0-123"]


class ExecutionGroup(BaseModel):
    name:        str
    assignee_id: str | None = None
    test_keys:   list[str]


class CreateExecutionsRequest(BaseModel):
    epic_key:   str
    version:    str
    executions: list[ExecutionGroup]


class CreateTestPlanRequest(BaseModel):
    name:       str
    version:    str
    issue_keys: list[str]   # TMT0-XXXX keys


@router.get("/versions")
async def get_versions():
    """List all non-archived fix versions for project TMT0."""
    try:
        return await get_test_plans_service().get_versions()
    except Exception as exc:
        logger.error("test_plans.get_versions: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/resolve-ids")
async def resolve_ids(req: ResolveIdsRequest):
    """
    Resolve a list of numeric Jira issue IDs (or keys) to full issue details.
    Returns: {count, tests: [{id, key, summary, status, url}]}
    """
    if not req.issue_ids:
        raise HTTPException(status_code=422, detail="issue_ids must not be empty")
    try:
        svc   = get_test_plans_service()
        tests = await svc.resolve_issue_ids(req.issue_ids)
        return {"count": len(tests), "tests": tests}
    except Exception as exc:
        logger.error("test_plans.resolve_ids: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/create-executions")
async def create_executions(req: CreateExecutionsRequest):
    """
    Create one Task per execution group under the test plan Epic,
    assign to QA member, set fix version, link tests.
    """
    if not req.executions:
        raise HTTPException(status_code=422, detail="executions must not be empty")
    try:
        results = await get_test_plans_service().create_executions(
            epic_key   = req.epic_key,
            version    = req.version,
            executions = [e.model_dump() for e in req.executions],
        )
        any_failed = any(r.get("failed", 0) > 0 or r.get("task_key") is None for r in results)
        return JSONResponse(content={"results": results}, status_code=207 if any_failed else 201)
    except Exception as exc:
        logger.error("test_plans.create_executions: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/create")
async def create_test_plan(req: CreateTestPlanRequest):
    """
    Create a Jira Epic as the test plan container and link all specified
    Test issues to it via 'relates to'. Returns 201 on full success, 207 on partial failure.
    """
    if not req.name.strip():
        raise HTTPException(status_code=422, detail="Plan name must not be empty")
    if not req.issue_keys:
        raise HTTPException(status_code=422, detail="issue_keys must not be empty")

    try:
        result = await get_test_plans_service().create_test_plan(
            name       = req.name.strip(),
            version    = req.version.strip(),
            issue_keys = req.issue_keys,
        )
        status_code = 207 if result["failed"] > 0 else 201
        return JSONResponse(content=result, status_code=status_code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("test_plans.create: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

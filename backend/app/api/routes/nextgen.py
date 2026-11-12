"""
NextGen QA Hub routes (/api/nextgen).

GET  /snapshot                 last correlated snapshot (instant)       POST /refresh   rebuild in the background
GET  /status                   refresh progress
GET  /issue/{key}              ticket detail: Jira + merges + lab runs
GET  /env  POST /env/check     environment history / check now
GET  /settings  PUT /settings  POST /settings/test
GET  /notifications  POST /notifications/read[/{id}]
POST /ai/briefing  POST /ai/alt-tests  POST /ai/lab-script
GET  /slack                    GET|POST /slack/summary (AI digest)   POST /slack/summary/action (tick done)
GET  /lab/templates  GET /lab/runs  POST /lab/runs  GET /lab/runs/{id}  GET /lab/runs/{id}/shot/{n}
POST /lab/runs/{id}/explain    AI: why the run failed (bug / script / env / data) + fixed script / bug draft
"""
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services.nextgen_ai_service import get_nextgen_ai_service
from app.services.nextgen_hub_service import get_nextgen_hub_service
from app.services.nextgen_lab_service import DEFAULT_ROUTES, TEMPLATES, get_nextgen_lab_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/nextgen", tags=["nextgen"])
_background: set = set()


def _hub():
    return get_nextgen_hub_service()


async def _guard(coro, what: str):
    try:
        return await coro
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("%s failed: %s", what, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"{what} failed: {exc}")


@router.get("/snapshot")
async def snapshot():
    return {"snapshot": await _hub().snapshot(), "status": _hub().build_state}


@router.get("/status")
async def status():
    return _hub().build_state


@router.post("/refresh")
async def refresh():
    hub = _hub()
    if hub.build_state["running"]:
        return {"started": False, "status": hub.build_state}

    async def run():
        try:
            await hub.build_snapshot()
        except Exception as exc:
            logger.error("NextGen refresh failed: %s", exc, exc_info=True)
    task = asyncio.create_task(run())
    _background.add(task)
    task.add_done_callback(_background.discard)
    await asyncio.sleep(0.05)
    return {"started": True, "status": hub.build_state}


@router.get("/issue/{key}")
async def issue(key: str):
    return await _guard(_hub().issue_detail(key), "Issue detail")


@router.post("/ux/refresh")
async def ux_refresh():
    """Re-read the prototype's UX spec now (it is otherwise re-read on every hub refresh)."""
    hub = _hub()
    errors: dict = {}
    ux = await hub.refresh_ux(await hub.get_config(reveal=True), errors)
    if errors:
        raise HTTPException(status_code=502, detail=errors["ux"])
    snap = await hub.snapshot()
    if snap and ux:
        snap["ux"] = hub._correlate_ux(await hub.get_config(), ux, snap, {"ac_refs": snap.get("tests", {}).get("ac_refs")})
        await hub._put_setting("nextgen_last_snapshot", snap)
    return {"ux": (snap or {}).get("ux")}


@router.get("/env")
async def env_history(limit: int = 200):
    return {"history": await _hub().env_history(limit)}


@router.post("/env/check")
async def env_check():
    return await _guard(_hub().check_env(), "Environment check")


@router.get("/settings")
async def get_settings_():
    return await _hub().get_config()


@router.put("/settings")
async def put_settings(body: dict):
    return await _hub().save_config(body)


@router.post("/settings/test")
async def test_settings():
    return await _guard(get_nextgen_ai_service().test_connectors(), "Connector test")


@router.get("/notifications")
async def notifications(limit: int = 100, unread_only: bool = False):
    return await _hub().notifications(limit, unread_only)


@router.post("/notifications/read")
async def read_all():
    await _hub().mark_read()
    return {"ok": True}


@router.post("/notifications/read/{notification_id}")
async def read_one(notification_id: int):
    await _hub().mark_read(notification_id)
    return {"ok": True}


class AltTestsRequest(BaseModel):
    issue_key: Optional[str] = None
    domain: Optional[str] = None
    provider: str = "grok"
    extra: str = ""


@router.post("/ai/briefing")
async def briefing():
    return await _guard(get_nextgen_ai_service().briefing(), "Briefing")


@router.post("/ai/alt-tests")
async def alt_tests(req: AltTestsRequest):
    return await _guard(get_nextgen_ai_service().alt_tests(req.issue_key, req.domain, req.provider, req.extra),
                        "Alternative tests")


@router.post("/ai/lab-script")
async def lab_script(body: dict):
    if not body.get("issue_key"):
        raise HTTPException(status_code=400, detail="issue_key is required")
    return await _guard(get_nextgen_ai_service().lab_script(body["issue_key"]), "Script generation")


@router.get("/slack")
async def slack(days: Optional[int] = None):
    return await _guard(get_nextgen_ai_service().slack_feed(days), "Slack")


@router.get("/slack/summary")
async def slack_summary_last():
    return {"summary": await get_nextgen_ai_service().last_slack_summary()}


@router.post("/slack/summary")
async def slack_summary(body: dict):
    days = int(body.get("days") or 7)
    return await _guard(get_nextgen_ai_service().slack_summary(days), "Slack summary")


@router.post("/slack/summary/action")
async def slack_action(body: dict):
    if not body.get("task"):
        raise HTTPException(status_code=400, detail="task is required")
    return await get_nextgen_ai_service().mark_action(body["task"], bool(body.get("done")))


class LabRunRequest(BaseModel):
    name: str = "Lab run"
    script: str
    issue_key: Optional[str] = None
    kind: str = "script"
    routes: Optional[list[str]] = None


@router.get("/lab/templates")
async def lab_templates():
    return {"templates": [{"id": k, **v} for k, v in TEMPLATES.items()], "routes": DEFAULT_ROUTES}


@router.get("/lab/runs")
async def lab_runs(limit: int = 50):
    return {"runs": await get_nextgen_lab_service().list_runs(limit)}


@router.post("/lab/runs")
async def lab_run(req: LabRunRequest):
    if not req.script.strip():
        raise HTTPException(status_code=400, detail="The script is empty")
    cfg = await _hub().get_config(reveal=True)
    return await get_nextgen_lab_service().create_run(req.name, req.script, cfg, req.issue_key, req.kind, req.routes)


@router.get("/lab/runs/{run_id}")
async def lab_run_detail(run_id: int):
    run = await get_nextgen_lab_service().get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="No such run")
    return run


@router.post("/lab/runs/{run_id}/explain")
async def lab_explain(run_id: int, body: Optional[dict] = None):
    """AI explanation of a failed run (cached on the run; {"refresh": true} asks again)."""
    return await _guard(get_nextgen_ai_service().explain_failure(run_id, bool((body or {}).get("refresh"))),
                        "Failure explanation")


@router.get("/lab/runs/{run_id}/shot/{n}")
async def lab_shot(run_id: int, n: int):
    p = get_nextgen_lab_service().screenshot_path(run_id, n)
    if not p.exists():
        raise HTTPException(status_code=404, detail="No screenshot")
    return FileResponse(p, media_type="image/png")

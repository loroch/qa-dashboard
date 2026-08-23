"""Sprint Planning API routes."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from app.services.sprint_planning_service import get_sprint_planning_service

router = APIRouter(prefix="/api/sprint-planning", tags=["sprint-planning"])


class AddActivityRequest(BaseModel):
    activity_name: str
    activity_type: Optional[str] = "qa_testing"
    story_key: Optional[str] = None
    story_summary: Optional[str] = None
    sprint_name: Optional[str] = None
    description: Optional[str] = None
    estimation_hours: Optional[float] = None
    status: Optional[str] = "planned"


class UpdateActivityRequest(BaseModel):
    activity_name: Optional[str] = None
    activity_type: Optional[str] = None
    story_key: Optional[str] = None
    story_summary: Optional[str] = None
    description: Optional[str] = None
    estimation_hours: Optional[float] = None
    status: Optional[str] = None


class ReorderRequest(BaseModel):
    ordered_ids: List[int]


class UpsertTrackingRequest(BaseModel):
    story_summary: Optional[str] = None
    planned_rft_date: Optional[str] = None
    actual_rft_date: Optional[str] = None
    delay_reason: Optional[str] = None
    delay_notes: Optional[str] = None


@router.get("/sprints")
async def get_sprints(refresh: bool = Query(False)):
    svc = get_sprint_planning_service()
    try:
        return {"sprints": await svc.get_sprints(force_refresh=refresh)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sprint/{sprint_id}/bugs")
async def get_sprint_bugs(sprint_id: int, refresh: bool = Query(False)):
    svc = get_sprint_planning_service()
    try:
        return await svc.get_sprint_bugs(sprint_id, force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sprint/{sprint_id}/stories")
async def get_sprint_stories(sprint_id: int, refresh: bool = Query(False)):
    svc = get_sprint_planning_service()
    try:
        return await svc.get_sprint_stories(sprint_id, force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sprint/{sprint_id}/activities")
async def get_activities(sprint_id: int):
    svc = get_sprint_planning_service()
    try:
        return {"activities": await svc.get_activities(sprint_id)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sprint/{sprint_id}/activities")
async def add_activity(sprint_id: int, body: AddActivityRequest):
    svc = get_sprint_planning_service()
    try:
        activity = await svc.add_activity(sprint_id, body.model_dump())
        return {"activity": activity}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/activity/{activity_id}")
async def update_activity(activity_id: int, body: UpdateActivityRequest):
    svc = get_sprint_planning_service()
    try:
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        return {"activity": await svc.update_activity(activity_id, data)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/activity/{activity_id}")
async def delete_activity(activity_id: int):
    svc = get_sprint_planning_service()
    try:
        await svc.delete_activity(activity_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sprint/{sprint_id}/reorder")
async def reorder_activities(sprint_id: int, body: ReorderRequest):
    svc = get_sprint_planning_service()
    try:
        await svc.reorder_activities(sprint_id, body.ordered_ids)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/activity/{activity_id}/push-to-jira")
async def push_to_jira(activity_id: int):
    svc = get_sprint_planning_service()
    try:
        return await svc.push_to_jira(activity_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sprint/{sprint_id}/tracking")
async def get_tracking(sprint_id: int):
    svc = get_sprint_planning_service()
    try:
        return {"tracking": await svc.get_tracking(sprint_id)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/sprint/{sprint_id}/tracking/{story_key}")
async def upsert_tracking(sprint_id: int, story_key: str, body: UpsertTrackingRequest):
    svc = get_sprint_planning_service()
    try:
        data = {k: v for k, v in body.model_dump().items() if v is not None}
        return {"tracking": await svc.upsert_tracking(sprint_id, story_key, data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

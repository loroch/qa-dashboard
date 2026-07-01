"""Mexico QA Team dashboard routes."""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from app.services.mexico_qa_service import get_mexico_qa_service

router = APIRouter(prefix="/api/mexico-qa", tags=["mexico-qa"])


@router.get("/team")
async def get_team(refresh: bool = Query(False)):
    svc = get_mexico_qa_service()
    try:
        return {"members": await svc.get_team(force_refresh=refresh)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pinned-epics")
async def get_pinned_epics(refresh: bool = Query(False)):
    svc = get_mexico_qa_service()
    try:
        return {"epics": await svc.get_pinned_epics(force_refresh=refresh)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-epics")
async def search_epics(q: str = Query(..., min_length=1)):
    svc = get_mexico_qa_service()
    try:
        return {"epics": await svc.search_epics(q)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/epic-work")
async def get_epic_work(
    epic_key:   str          = Query(...),
    member_ids: str          = Query(..., description="Comma-separated account IDs"),
    refresh:    bool         = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        return await svc.get_epic_work(epic_key.upper(), ids, force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs")
async def get_bugs(
    days:       int          = Query(14),
    member_ids: str          = Query(..., description="Comma-separated account IDs"),
    refresh:    bool         = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        bugs = await svc.get_bugs_by_date(days, ids, force_refresh=refresh)
        return {"bugs": bugs, "total": len(bugs)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/assigned")
async def get_assigned(
    days:       int  = Query(14),
    member_ids: str  = Query(..., description="Comma-separated account IDs"),
    refresh:    bool = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        grouped = await svc.get_assigned_by_date(days, ids, force_refresh=refresh)
        return {"grouped": grouped}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

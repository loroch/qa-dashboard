"""Bug Triage / Priority Meeting API routes."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from app.services.bug_triage_service import get_bug_triage_service

router = APIRouter(prefix="/api/bug-triage", tags=["bug-triage"])


class UpdateFieldRequest(BaseModel):
    field: str          # priority | fix_version | assignee | sprint | parent
    value: Optional[str] = None


@router.get("/search-epics")
async def search_epics(q: str = Query(..., min_length=1)):
    svc = get_bug_triage_service()
    try:
        return {"epics": await svc.search_epics(q)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs")
async def get_bugs(
    epic_keys:   Optional[str] = Query(None, description="Comma-separated epic keys"),
    days:        Optional[int] = Query(None, description="Last N days (7, 14, 30)"),
    creators:    Optional[str] = Query(None, description="Comma-separated reporter accountIds"),
    fix_version: Optional[str] = Query(None, description="Fix version name"),
    refresh:     bool          = Query(False),
):
    svc = get_bug_triage_service()
    try:
        if epic_keys:
            keys = [k.strip().upper() for k in epic_keys.split(",") if k.strip()]
            if not keys:
                raise HTTPException(status_code=400, detail="No epic keys provided")
            bugs = await svc.get_bugs_by_epics(keys, force_refresh=refresh)
        elif fix_version:
            bugs = await svc.get_bugs_by_fix_version(fix_version, force_refresh=refresh)
        elif days:
            creator_list = [c.strip() for c in creators.split(",") if c.strip()] if creators else None
            bugs = await svc.get_bugs_by_date(days, creators=creator_list, force_refresh=refresh)
        else:
            raise HTTPException(status_code=400, detail="Provide epic_keys, fix_version, or days")
        return {"bugs": bugs, "total": len(bugs)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/creators")
async def get_creators(days: int = Query(30)):
    svc = get_bug_triage_service()
    try:
        return {"creators": await svc.get_creators(days)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/meta")
async def get_meta(refresh: bool = Query(False)):
    svc = get_bug_triage_service()
    try:
        return await svc.get_meta(force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-parents")
async def search_parents(q: str = Query(..., min_length=2)):
    svc = get_bug_triage_service()
    try:
        return {"results": await svc.search_parents(q)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{issue_key}")
async def update_field(issue_key: str, body: UpdateFieldRequest):
    svc = get_bug_triage_service()
    try:
        return await svc.update_field(issue_key.upper(), body.field, body.value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

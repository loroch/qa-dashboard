"""Investigation API routes — issue timeline via Jira changelog."""
from fastapi import APIRouter, HTTPException, Query

from app.services.investigation_service import get_investigation_service

router = APIRouter(prefix="/api/investigation", tags=["investigation"])


@router.get("/timeline")
async def get_timeline(
    keys:    str  = Query(..., description="Comma-separated issue keys, e.g. TMT0-123,TMT0-456"),
    refresh: bool = Query(False),
):
    svc = get_investigation_service()
    try:
        key_list = [k.strip().upper() for k in keys.split(",") if k.strip()]
        if not key_list:
            raise HTTPException(status_code=400, detail="No keys provided")
        data = await svc.get_timeline(key_list, force_refresh=refresh)
        return {"items": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search")
async def search_issues(
    q:     str = Query(..., description="Search text or issue key"),
    types: str = Query("", description="Comma-separated: Epic,Story,Bug — empty = all"),
):
    svc = get_investigation_service()
    try:
        type_list = [t.strip() for t in types.split(",") if t.strip()] if types else None
        results   = await svc.search_issues(q, types=type_list)
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/children")
async def get_children(
    parent:  str  = Query(..., description="Parent issue key, e.g. TMT0-123"),
    types:   str  = Query("Story", description="Comma-separated: Story,Bug"),
    refresh: bool = Query(False),
):
    svc = get_investigation_service()
    try:
        type_list = [t.strip() for t in types.split(",") if t.strip()] or ["Story"]
        if refresh:
            import hashlib
            type_slug = "_".join(sorted(type_list))
            svc.cache.invalidate(
                f"investigation:children:{hashlib.md5((parent.strip().upper() + type_slug).encode()).hexdigest()[:10]}"
            )
        children = await svc.get_children(parent.strip().upper(), type_list)
        return {"children": children, "parent": parent.strip().upper()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/epic-bugs")
async def get_epic_bugs(
    epic:    str  = Query(..., description="Epic key, e.g. TMT0-100"),
    refresh: bool = Query(False),
):
    svc = get_investigation_service()
    try:
        bugs = await svc.get_epic_bugs(epic.strip().upper(), force_refresh=refresh)
        return {"bugs": bugs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

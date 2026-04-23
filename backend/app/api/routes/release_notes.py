"""Release Notes API routes."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from app.services.release_notes_service import get_release_notes_service

router = APIRouter(prefix="/api/release-notes", tags=["release-notes"])


class UpdateReleaseNotesRequest(BaseModel):
    text: str


@router.get("")
async def get_release_notes(
    version:  Optional[str] = Query(None),
    epic_key: Optional[str] = Query(None),
    refresh:  bool          = Query(False),
):
    svc = get_release_notes_service()
    try:
        issues = await svc.get_issues(
            version=version,
            epic_key=epic_key,
            force_refresh=refresh,
        )
        return {"issues": issues, "total": len(issues)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{issue_key}")
async def update_release_notes(issue_key: str, body: UpdateReleaseNotesRequest):
    svc = get_release_notes_service()
    try:
        return await svc.update_release_notes(issue_key, body.text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

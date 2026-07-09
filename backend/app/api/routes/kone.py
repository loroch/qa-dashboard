"""
K-1 KONE service desk API routes.
"""
import logging
from typing import Optional, List
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel

from app.services.kone_service import get_kone_service
from app.services.create_bug_service import get_create_bug_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/kone", tags=["kone"])


@router.get("/tickets")
async def get_tickets(refresh: bool = Query(False)):
    """All open K-1 tickets."""
    svc = get_kone_service()
    tickets = await svc.get_tickets(force_refresh=refresh)
    return {"tickets": tickets, "total": len(tickets)}


@router.get("/by-cliente")
async def get_by_cliente(refresh: bool = Query(False)):
    """Tickets grouped by Cliente."""
    svc = get_kone_service()
    groups = await svc.get_by_cliente(force_refresh=refresh)
    return {"groups": groups}


@router.get("/ticket/{key}/detail")
async def get_ticket_detail(key: str):
    """Full K-1 ticket details including description and attachments."""
    try:
        svc = get_kone_service()
        return await svc.get_ticket_detail(key)
    except Exception as e:
        logger.error(f"KONE ticket detail error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bug-links")
async def get_bug_links():
    """Return all KONE key → TMT0 Jira bug mappings."""
    try:
        svc = get_kone_service()
        return await svc.get_bug_links()
    except Exception as e:
        logger.error(f"KONE bug links error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/create-bug/meta")
async def get_create_bug_meta():
    """Dropdown data for the Create Bug form (fix versions, epics, sprints, priorities)."""
    try:
        svc = get_create_bug_service()
        return await svc.get_meta()
    except Exception as e:
        logger.error(f"KONE create-bug meta error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class KoneCreateBugRequest(BaseModel):
    kone_key: str
    kone_url: str
    summary: str
    description: str = ""
    steps_to_reproduce: str = ""
    actual_result: str = ""
    expected_result: str = ""
    severity: str = "Medium"
    environments: List[str] = []
    found_in_version_id: Optional[str] = None
    epic_key: Optional[str] = None
    fix_version_id: Optional[str] = None
    priority_name: Optional[str] = None
    sprint_id: Optional[int] = None
    attachments: List[dict] = []  # [{href, name, content_type}] selected by user


@router.post("/create-bug")
async def create_kone_bug(body: KoneCreateBugRequest):
    """Create a TMT0 Jira bug from a K-1 KONE ticket."""
    try:
        svc = get_kone_service()
        result = await svc.create_jira_bug(
            kone_key=body.kone_key,
            kone_url=body.kone_url,
            summary=body.summary,
            description=body.description,
            steps_to_reproduce=body.steps_to_reproduce,
            actual_result=body.actual_result,
            expected_result=body.expected_result,
            severity=body.severity,
            environments=body.environments,
            found_in_version_id=body.found_in_version_id,
            epic_key=body.epic_key,
            fix_version_id=body.fix_version_id,
            priority_name=body.priority_name,
            sprint_id=body.sprint_id,
            attachment_ids=body.attachments,
        )
        return result
    except Exception as e:
        logger.error(f"KONE create-bug error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class AiRequest(BaseModel):
    summary: str
    description: str = ""


@router.post("/ai-generate-bug-fields")
async def ai_generate_bug_fields(body: AiRequest):
    """Use Claude AI to draft steps/actual/expected from KONE ticket info."""
    try:
        svc = get_kone_service()
        return await svc.ai_generate_bug_fields(body.summary, body.description)
    except Exception as e:
        logger.error(f"KONE AI generate error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

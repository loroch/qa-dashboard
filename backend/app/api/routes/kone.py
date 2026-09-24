"""
K-1 KONE service desk API routes.
"""
import logging
from typing import Optional, List
from fastapi import APIRouter, Query, HTTPException, Response
from pydantic import BaseModel

from app.services.kone_service import get_kone_service
from app.services.create_bug_service import get_create_bug_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/kone", tags=["kone"])


@router.get("/field-discovery")
async def kone_field_discovery():
    """List all fields available on the KONE Jira instance (for dev/admin use)."""
    from app.jira.kone_client import get_kone_client
    import httpx
    client = get_kone_client()._get_client()
    resp = await client.get(f"{get_kone_client().base_url}/rest/api/3/field")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])
    fields = resp.json()
    return [{"id": f["id"], "name": f["name"], "custom": f.get("custom", False)} for f in fields]


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


@router.get("/ticket/{key}/attachment/{attachment_id}")
async def get_ticket_attachment(key: str, attachment_id: str):
    """Proxy one KONE attachment's bytes (image preview / download) — the KONE Jira
    attachment URL needs server-side Basic auth, so the browser can't load it directly."""
    try:
        svc = get_kone_service()
        data, content_type, name = await svc.get_attachment_bytes(key, attachment_id)
        return Response(
            content=data,
            media_type=content_type,
            headers={"Content-Disposition": f'inline; filename="{name}"'},
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"KONE attachment proxy error: {e}", exc_info=True)
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
    assignee_id: Optional[str] = None
    label: Optional[str] = None
    attachments: List[dict] = []
    comment: Optional[str] = None


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
            assignee_id=body.assignee_id,
            label=body.label,
            attachment_ids=body.attachments,
            comment=body.comment,
        )
        return result
    except Exception as e:
        logger.error(f"KONE create-bug error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class KoneLinkBugRequest(BaseModel):
    kone_key: str
    jira_key: str


@router.post("/link-bug")
async def link_kone_bug(body: KoneLinkBugRequest):
    """Manually link an existing TMT0 Jira issue to a KONE ticket."""
    from app.jira.client import get_jira_client
    jira_key = body.jira_key.strip().upper()
    if not jira_key:
        raise HTTPException(status_code=422, detail="jira_key is required")
    try:
        jira = get_jira_client()
        issue = await jira.get_issue(jira_key, fields=["summary", "status", "fixVersions"])
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Jira issue {jira_key} not found: {e}")

    fields = issue.get("fields", {})
    summary = fields.get("summary", "")
    status = (fields.get("status") or {}).get("name", "")
    fix_versions = [v.get("name") for v in (fields.get("fixVersions") or []) if v.get("name")]
    jira_url = f"https://kabatone-ops-it.atlassian.net/browse/{jira_key}"

    svc = get_kone_service()
    await svc.save_bug_link(body.kone_key, jira_key, jira_url, summary)
    await svc.write_bug_id_to_kone(body.kone_key, jira_key)

    return {
        "kone_key": body.kone_key,
        "jira_key": jira_key,
        "jira_url": jira_url,
        "jira_status": status,
        "jira_fix_versions": fix_versions,
        "summary": summary,
    }


@router.post("/write-bug-id/{kone_key}")
async def write_single_bug_id(kone_key: str):
    """Write the linked TMT0 bug key into a single KONE ticket's Bug ID field."""
    svc = get_kone_service()
    try:
        bug_links = await svc.get_bug_links()
        link = bug_links.get(kone_key)
        if not link:
            raise HTTPException(status_code=404, detail=f"No bug link found for {kone_key}")
        jira_key = link.get("jira_key") if isinstance(link, dict) else str(link)
        if not jira_key:
            raise HTTPException(status_code=404, detail=f"No jira_key in link for {kone_key}")
        ok = await svc.write_bug_id_to_kone(kone_key, jira_key)
        if not ok:
            raise HTTPException(status_code=500, detail=f"Failed to write Bug ID to {kone_key}")
        return {"kone_key": kone_key, "jira_key": jira_key, "ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Write single bug ID error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/retro-sync-bug-ids")
async def retro_sync_bug_ids():
    """Write TMT0 bug keys back into all KONE tickets that are missing the Bug ID field."""
    svc = get_kone_service()
    try:
        result = await svc.retro_sync_bug_ids()
        return result
    except Exception as e:
        logger.error(f"Retro sync Bug IDs error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync-from-jira")
async def sync_from_jira():
    """Scan TMT0 bugs for a Ticket # field and link them back to KONE tickets in the DB."""
    svc = get_kone_service()
    try:
        result = await svc.sync_from_jira()
        return result
    except Exception as e:
        logger.error(f"Sync from Jira error: {e}", exc_info=True)
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

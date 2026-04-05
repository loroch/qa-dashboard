"""
Jira metadata routes - used for field discovery and connection testing.
"""
import logging
from fastapi import APIRouter, HTTPException

from app.jira.client import get_jira_client
from app.config import get_field_mapping, reload_field_mapping
from app.jira.queries import reset_jql_builder
from app.jira.field_mapper import reset_field_mapper

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jira", tags=["jira"])


@router.get("/status")
async def jira_connection_status():
    """Test Jira connection and return authenticated user info."""
    client = get_jira_client()
    return await client.test_connection()


@router.get("/fields")
async def list_jira_fields():
    """
    List all Jira fields with their IDs.
    Use this to discover custom field IDs for field_mapping.yaml.
    """
    try:
        client = get_jira_client()
        fields = await client.get_all_fields()
        return [
            {
                "id": f.get("id"),
                "name": f.get("name"),
                "type": f.get("schema", {}).get("type") if f.get("schema") else None,
                "custom": f.get("custom", False),
            }
            for f in sorted(fields, key=lambda x: x.get("name", ""))
        ]
    except Exception as e:
        logger.error(f"List fields error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects")
async def list_jira_projects():
    """List accessible Jira projects."""
    try:
        client = get_jira_client()
        projects = await client.get_projects()
        return [
            {"key": p.get("key"), "name": p.get("name"), "id": p.get("id")}
            for p in projects
        ]
    except Exception as e:
        logger.error(f"List projects error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config")
async def get_current_config():
    """Return current field mapping configuration (for debugging)."""
    try:
        mapping = get_field_mapping()
        # Mask the team member IDs partially for security
        cfg = dict(mapping)
        return cfg
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config/reload")
async def reload_config():
    """Reload field mapping config from disk without restarting."""
    try:
        mapping = reload_field_mapping()
        reset_jql_builder()
        reset_field_mapper()
        return {"status": "ok", "message": "Config reloaded successfully"}
    except Exception as e:
        logger.error(f"Config reload error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

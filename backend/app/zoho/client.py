"""
Zoho Desk async API client.
Handles OAuth2 token refresh automatically.
"""
import logging
import time
from typing import Any, Optional
import httpx
from app.config import get_settings

logger = logging.getLogger(__name__)


class ZohoDeskClient:
    """Async Zoho Desk REST API client with automatic token refresh."""

    def __init__(self):
        settings = get_settings()
        self.client_id = settings.zoho_client_id
        self.client_secret = settings.zoho_client_secret
        self.refresh_token = settings.zoho_refresh_token
        self.accounts_url = settings.zoho_accounts_url.rstrip("/")
        self.base_url = settings.zoho_desk_base_url.rstrip("/")
        self.portal = settings.zoho_desk_portal
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0
        self._client: Optional[httpx.AsyncClient] = None
        self._org_id: Optional[str] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=30)
        return self._client

    async def _ensure_token(self):
        """Refresh access token if expired."""
        if self._access_token and time.time() < self._token_expires_at - 60:
            return
        logger.info("Refreshing Zoho Desk access token...")
        client = await self._get_client()
        resp = await client.post(
            f"{self.accounts_url}/oauth/v2/token",
            data={
                "refresh_token": self.refresh_token,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "refresh_token",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if "access_token" not in data:
            raise ZohoDeskAuthError(f"Token refresh failed: {data}")
        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + data.get("expires_in", 3600)
        logger.info("Zoho Desk token refreshed successfully")

    async def _get_org_id(self) -> str:
        """Fetch and cache the org ID for the portal."""
        if self._org_id:
            return self._org_id
        data = await self.get("/api/v1/organizations")
        orgs = data.get("data", [])
        for org in orgs:
            if org.get("companyName", "").lower().replace(" ", "") in self.portal.lower():
                self._org_id = str(org["id"])
                logger.info(f"Zoho Desk org ID: {self._org_id} ({org.get('companyName')})")
                return self._org_id
        # Fallback: use first org
        if orgs:
            self._org_id = str(orgs[0]["id"])
            logger.info(f"Zoho Desk using first org ID: {self._org_id}")
            return self._org_id
        raise ZohoDeskError("No Zoho Desk organizations found")

    async def get(self, path: str, params: dict | None = None, include_org: bool = False) -> Any:
        await self._ensure_token()
        client = await self._get_client()
        headers = {
            "Authorization": f"Zoho-oauthtoken {self._access_token}",
            "Accept": "application/json",
        }
        if include_org:
            org_id = await self._get_org_id()
            headers["orgId"] = org_id

        url = f"{self.base_url}{path}"
        try:
            resp = await client.get(url, headers=headers, params=params or {})
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"Zoho Desk API error {e.response.status_code} for {path}: {e.response.text[:300]}")
            raise ZohoDeskAPIError(f"Zoho Desk {e.response.status_code}: {e.response.text[:200]}") from e
        except httpx.RequestError as e:
            raise ZohoDeskError(f"Cannot connect to Zoho Desk: {e}") from e

    async def get_tickets(
        self,
        limit: int = 100,
        from_index: int = 0,
        status: str | None = None,
        department_id: str | None = None,
        assignee_id: str | None = None,
        sort_by: str = "createdTime",
    ) -> list[dict]:
        """Fetch tickets with pagination support."""
        params = {
            "limit": min(limit, 100),
            "from": from_index,
            "sortBy": sort_by,
            "fields": "id,ticketNumber,subject,status,priority,channel,classification,"
                      "createdTime,modifiedTime,dueDate,responseDueDate,isOverDue,"
                      "assigneeId,contactId,departmentId,webUrl,"
                      "cf_bug_id,cf_site_name",
        }
        if status:
            params["status"] = status
        if department_id:
            params["departmentId"] = department_id
        if assignee_id:
            params["assigneeId"] = assignee_id

        data = await self.get("/api/v1/tickets", params=params, include_org=True)
        return data.get("data", [])

    async def get_all_tickets(self, max_total: int = 1000, **kwargs) -> list[dict]:
        """Fetch all tickets with auto-pagination."""
        all_tickets = []
        from_index = 0
        page_size = 100

        while len(all_tickets) < max_total:
            batch = await self.get_tickets(
                limit=min(page_size, max_total - len(all_tickets)),
                from_index=from_index,
                **kwargs,
            )
            all_tickets.extend(batch)
            if len(batch) < page_size:
                break
            from_index += page_size

        logger.info(f"Zoho Desk: fetched {len(all_tickets)} tickets")
        return all_tickets

    async def get_departments(self) -> list[dict]:
        data = await self.get("/api/v1/departments", include_org=True)
        return data.get("data", [])

    async def get_agents(self) -> list[dict]:
        data = await self.get("/api/v1/agents", include_org=True)
        return data.get("data", [])

    async def test_connection(self) -> dict:
        try:
            await self._ensure_token()
            orgs = await self.get("/api/v1/organizations")
            org_names = [o.get("companyName") for o in orgs.get("data", [])]
            return {"ok": True, "organizations": org_names}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()


class ZohoDeskError(Exception):
    pass

class ZohoDeskAPIError(ZohoDeskError):
    pass

class ZohoDeskAuthError(ZohoDeskError):
    pass


_client: ZohoDeskClient | None = None

def get_zoho_client() -> ZohoDeskClient:
    global _client
    if _client is None:
        _client = ZohoDeskClient()
    return _client

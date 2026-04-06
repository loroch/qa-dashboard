"""
Jira REST API v3 async client.
All Jira communication goes through this layer.
"""
import logging
from typing import Any, AsyncGenerator, Optional
import httpx
from app.config import get_settings

logger = logging.getLogger(__name__)


class JiraClient:
    """Async Jira REST API v3 client with automatic pagination."""

    def __init__(self):
        settings = get_settings()
        self.base_url = settings.jira_base_url.rstrip("/")
        self.auth = (settings.jira_user_email, settings.jira_api_token)
        self.timeout = settings.jira_request_timeout
        self.max_results = settings.jira_max_results
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                auth=self.auth,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                timeout=self.timeout,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def get(self, path: str, params: dict | None = None) -> Any:
        client = await self._get_client()
        url = f"{self.base_url}/rest/api/3{path}"
        try:
            response = await client.get(url, params=params or {})
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            logger.error(f"Jira API error {e.response.status_code} for {path}: {e.response.text[:500]}")
            raise JiraAPIError(f"Jira returned {e.response.status_code}: {e.response.text[:200]}") from e
        except httpx.RequestError as e:
            logger.error(f"Jira connection error for {path}: {e}")
            raise JiraConnectionError(f"Cannot connect to Jira: {e}") from e

    async def post(self, path: str, json: dict | None = None) -> Any:
        client = await self._get_client()
        url = f"{self.base_url}/rest/api/3{path}"
        try:
            response = await client.post(url, json=json or {})
            response.raise_for_status()
            if response.content:
                return response.json()
            return {}
        except httpx.HTTPStatusError as e:
            logger.error(f"Jira POST error {e.response.status_code} for {path}: {e.response.text[:500]}")
            raise JiraAPIError(f"Jira returned {e.response.status_code}: {e.response.text[:200]}") from e
        except httpx.RequestError as e:
            raise JiraConnectionError(f"Cannot connect to Jira: {e}") from e

    async def put(self, path: str, json: dict | None = None) -> Any:
        client = await self._get_client()
        url = f"{self.base_url}/rest/api/3{path}"
        try:
            response = await client.put(url, json=json or {})
            response.raise_for_status()
            if response.content:
                return response.json()
            return {}
        except httpx.HTTPStatusError as e:
            logger.error(f"Jira PUT error {e.response.status_code} for {path}: {e.response.text[:500]}")
            raise JiraAPIError(f"Jira returned {e.response.status_code}: {e.response.text[:200]}") from e
        except httpx.RequestError as e:
            raise JiraConnectionError(f"Cannot connect to Jira: {e}") from e

    async def search_issues(
        self,
        jql: str,
        fields: list[str] | None = None,
        max_total: int = 5000,
        max_results: int | None = None,
        start_at: int = 0,
    ) -> list[dict]:
        """Search Jira issues with automatic pagination."""
        # If max_results given, do single page fetch
        if max_results is not None:
            batch_size = min(max_results, self.max_results)
            params = {
                "jql": jql,
                "startAt": start_at,
                "maxResults": batch_size,
                "fields": ",".join(fields or []),
            }
            data = await self.get("/search/jql", params)
            return data.get("issues", [])

        all_issues: list[dict] = []
        start_at = 0
        default_fields = [
            "summary", "status", "assignee", "reporter", "created", "updated",
            "priority", "fixVersions", "components", "labels", "issuetype",
            "parent", "subtasks", "duedate", "resolutiondate", "comment",
            "customfield_10014",  # Epic Link
            "customfield_10011",  # Epic Name
            "customfield_10020",  # Sprint
            "customfield_10016",  # Story Points
            "story_points",
        ]
        fields_to_fetch = fields or default_fields

        while len(all_issues) < max_total:
            batch_size = min(self.max_results, max_total - len(all_issues))
            params = {
                "jql": jql,
                "startAt": start_at,
                "maxResults": batch_size,
                "fields": ",".join(fields_to_fetch),
            }
            data = await self.get("/search/jql", params)
            issues = data.get("issues", [])
            all_issues.extend(issues)

            total = data.get("total", 0)
            logger.debug(f"Fetched {len(all_issues)}/{total} issues for JQL: {jql[:80]}")

            if len(all_issues) >= total or not issues:
                break
            start_at += len(issues)

        return all_issues

    async def get_issue(self, issue_key: str, fields: list[str] | None = None) -> dict:
        params = {}
        if fields:
            params["fields"] = ",".join(fields)
        return await self.get(f"/issue/{issue_key}", params)

    async def get_all_fields(self) -> list[dict]:
        """Get all Jira fields - use to discover custom field IDs."""
        return await self.get("/field")

    async def get_user(self, account_id: str) -> dict:
        return await self.get(f"/user", {"accountId": account_id})

    async def get_projects(self) -> list[dict]:
        data = await self.get("/project/search", {"maxResults": 200})
        return data.get("values", [])

    async def get_issue_changelog(self, issue_key: str) -> dict:
        return await self.get(f"/issue/{issue_key}/changelog")

    async def test_connection(self) -> dict:
        """Verify credentials and connectivity."""
        try:
            data = await self.get("/myself")
            return {"ok": True, "user": data.get("displayName"), "email": data.get("emailAddress")}
        except Exception as e:
            return {"ok": False, "error": str(e)}


class JiraAPIError(Exception):
    """Jira returned a non-2xx HTTP response."""
    pass


class JiraConnectionError(Exception):
    """Could not connect to Jira."""
    pass


# Singleton
_client: JiraClient | None = None


def get_jira_client() -> JiraClient:
    global _client
    if _client is None:
        _client = JiraClient()
    return _client

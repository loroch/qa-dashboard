"""
Confluence Cloud REST API client.
Confluence lives on the SAME Atlassian site as Jira (base_url + /wiki),
authenticated with the same email/API-token pair — see backend/app/jira/client.py
for the sibling Jira client this mirrors.
"""
import logging
import re
from typing import Any, Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)


class ConfluenceClient:
    """Async Confluence Cloud REST API client (same auth/site as Jira)."""

    def __init__(self):
        settings = get_settings()
        self.base_url = settings.jira_base_url.rstrip("/")
        self.auth = (settings.jira_user_email, settings.jira_api_token)
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                auth=self.auth,
                headers={"Accept": "application/json"},
                timeout=20,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def get(self, path: str, params: dict | None = None) -> Any:
        client = await self._get_client()
        url = f"{self.base_url}/wiki/rest/api{path}"
        response = await client.get(url, params=params or {})
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _html_to_text(raw_html: str) -> str:
        text = re.sub(r"<[^>]+>", " ", raw_html or "")
        return re.sub(r"\s+", " ", text).strip()

    async def search_pages(self, query: str, limit: int = 3, preview_chars: int = 2500) -> list[dict]:
        """
        CQL text search for pages relevant to `query`. Returns plain-text-extracted
        results: [{title, text, page_id, space_key, url, char_count}].
        Never raises — returns [] on any failure so callers can degrade gracefully.
        """
        safe_query = re.sub(r'["\[\]]', '', query or "")[:60]
        if not safe_query.strip():
            return []
        try:
            data = await self.get(
                "/content/search",
                params={
                    "cql": f'text ~ "{safe_query}" AND type = page',
                    "limit": limit,
                    "expand": "body.storage",
                },
            )
        except Exception as exc:
            logger.warning("Confluence search failed: %s", exc)
            return []

        results = []
        for page in (data.get("results") or [])[:limit]:
            title = page.get("title", "")
            raw_html = page.get("body", {}).get("storage", {}).get("value", "")
            text = self._html_to_text(raw_html)[:preview_chars]
            page_id = page.get("id", "")
            space_key = (page.get("space") or {}).get("key", "")
            url = f"{self.base_url}/wiki/spaces/{space_key}/pages/{page_id}" if page_id else ""
            results.append({
                "title": title,
                "text": text,
                "page_id": page_id,
                "space_key": space_key,
                "url": url,
                "char_count": len(text),
            })
        return results


_client: Optional[ConfluenceClient] = None


def get_confluence_client() -> ConfluenceClient:
    global _client
    if _client is None:
        _client = ConfluenceClient()
    return _client

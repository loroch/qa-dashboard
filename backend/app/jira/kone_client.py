"""
Jira client for the K-1 service desk (kabatone-ops-it.atlassian.net).

The standard /rest/api/3/search (JQL) endpoint returns 410 Gone on this instance,
so we use a two-step approach:
  1. Fetch issue keys from the Service Desk queue API.
  2. Fetch each issue's full details from /rest/api/3/issue/{key} in parallel.
"""
import asyncio
import base64
import logging
from typing import Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

SD_ID    = 35   # Service desk ID for KONE / K-1
Q_OPEN   = 56   # "All open" queue
Q_K1     = 62   # "TICKETS K1" queue  (includes recently closed)

FETCH_CONCURRENCY = 20  # max parallel issue-detail requests


class KoneClient:
    """Async HTTP client for the KONE Jira Service Management instance."""

    def __init__(self):
        settings = get_settings()
        self.base_url = settings.kone_jira_base_url.rstrip("/")
        creds = f"{settings.kone_jira_email}:{settings.kone_jira_token}"
        token = base64.b64encode(creds.encode()).decode()
        self._headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
            "X-ExperimentalApi": "opt-in",
        }
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers=self._headers,
                timeout=30,
                follow_redirects=True,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ── Service Desk queue API ───────────────────────────────────────────

    async def get_queue_keys(self, queue_id: int = Q_OPEN, max_total: int = 1000) -> list[str]:
        """Return all issue keys from a service desk queue (paginated)."""
        client = self._get_client()
        keys: list[str] = []
        start = 0
        page_size = 50

        while len(keys) < max_total:
            url = f"{self.base_url}/rest/servicedeskapi/servicedesk/{SD_ID}/queue/{queue_id}/issue"
            resp = await client.get(url, params={"start": start, "limit": page_size})
            if resp.status_code != 200:
                logger.warning(f"KONE queue {queue_id} page error {resp.status_code}: {resp.text[:200]}")
                break
            data = resp.json()
            batch = data.get("values", [])
            if not batch:
                break
            keys.extend(item["key"] for item in batch)
            start += len(batch)
            if len(batch) < page_size:
                break

        return keys

    # ── Issue detail (REST API v3 — works fine) ──────────────────────────

    async def get_issue(self, key: str) -> Optional[dict]:
        """Fetch full issue details for a single key."""
        client = self._get_client()
        url = f"{self.base_url}/rest/api/3/issue/{key}"
        try:
            resp = await client.get(url)
            if resp.status_code == 200:
                return resp.json()
            logger.warning(f"KONE issue {key}: {resp.status_code}")
            return None
        except Exception as e:
            logger.warning(f"KONE issue {key} fetch error: {e}")
            return None

    async def get_issues_bulk(self, keys: list[str]) -> list[dict]:
        """Fetch many issues in parallel (semaphore-limited)."""
        sem = asyncio.Semaphore(FETCH_CONCURRENCY)

        async def _fetch(k: str) -> Optional[dict]:
            async with sem:
                return await self.get_issue(k)

        results = await asyncio.gather(*[_fetch(k) for k in keys])
        return [r for r in results if r]

    # ── Queues meta ──────────────────────────────────────────────────────

    async def get_queues(self) -> list[dict]:
        client = self._get_client()
        url = f"{self.base_url}/rest/servicedeskapi/servicedesk/{SD_ID}/queue"
        resp = await client.get(url)
        if resp.status_code == 200:
            return resp.json().get("values", [])
        return []


_client: Optional[KoneClient] = None


def get_kone_client() -> KoneClient:
    global _client
    if _client is None:
        _client = KoneClient()
    return _client

"""
Figma REST API client — text/layout/color context only.

Note: this client deliberately never calls Figma's image-render endpoint
(`/v1/images/{key}`) — that endpoint has a separate, much stricter rate-limit
tier (seen firsthand: a 429 with `Retry-After` in the multi-day range) that
image-heavy usage can exhaust. The file/nodes JSON endpoint used here is a
different, much more generous limit and gives everything a text-generation
prompt actually needs: text content and fill colors.
"""
import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse, parse_qs

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_FILE_KEY_RE = re.compile(r"figma\.com/(?:design|file)/([a-zA-Z0-9]+)")
_URL_RE = re.compile(r"https?://(?:www\.)?figma\.com/(?:design|file)/[A-Za-z0-9]+(?:/[\w%-]*)?(?:\?[^\s\)\]]+)?")


class FigmaClient:
    """Async Figma REST API client (personal access token auth)."""

    def __init__(self):
        settings = get_settings()
        self.token = settings.figma_api_token
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers={"X-Figma-Token": self.token},
                timeout=20,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @staticmethod
    def parse_url(url: str) -> tuple[Optional[str], Optional[str]]:
        """Extract (file_key, node_id) from a Figma URL. node_id uses ':' form (e.g. '1234:5678')."""
        match = _FILE_KEY_RE.search(url or "")
        file_key = match.group(1) if match else None

        node_id = None
        parsed = urlparse(url or "")
        qs = parse_qs(parsed.query)
        raw_node = (qs.get("node-id") or [None])[0]
        if raw_node:
            node_id = raw_node.replace("-", ":", 1)
        return file_key, node_id

    @staticmethod
    def extract_urls(*texts: str) -> list[str]:
        """Find Figma file/frame URLs already embedded in arbitrary text — e.g. a Jira
        story or epic description that references its design via a 'Figma ref:' link —
        so callers don't need the user to paste a URL that Jira already has. Dedups,
        preserves first-seen order (story text takes priority over epic text when both
        are passed, since the caller is expected to pass the more specific text first)."""
        urls: list[str] = []
        seen: set[str] = set()
        for text in texts:
            if not text:
                continue
            for m in _URL_RE.finditer(text):
                url = m.group(0).rstrip(".,;)")
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
        return urls

    @staticmethod
    def _walk(node: dict, texts: list[str], colors: set[str], depth: int = 0, max_depth: int = 30):
        if depth > max_depth or not isinstance(node, dict):
            return
        if node.get("type") == "TEXT" and node.get("characters"):
            texts.append(node["characters"])
        for fill in node.get("fills") or []:
            if fill.get("type") == "SOLID" and fill.get("color"):
                c = fill["color"]
                hex_color = "#{:02X}{:02X}{:02X}".format(
                    round(c.get("r", 0) * 255), round(c.get("g", 0) * 255), round(c.get("b", 0) * 255)
                )
                colors.add(hex_color)
        for child in node.get("children") or []:
            FigmaClient._walk(child, texts, colors, depth + 1, max_depth)

    async def get_node_context(self, url: str, max_chars: int = 3000) -> dict:
        """
        Given a Figma file/frame URL, return {title, text_summary, colors, url, has_content}.
        Raises ValueError if the URL has no parseable file key, or if no token is configured.
        """
        if not self.token:
            raise ValueError("FIGMA_API_TOKEN is not set. Add it to your .env file.")

        file_key, node_id = self.parse_url(url)
        if not file_key:
            raise ValueError(f"Could not find a Figma file key in that URL: {url}")

        client = await self._get_client()

        if node_id:
            resp = await client.get(
                f"https://api.figma.com/v1/files/{file_key}/nodes",
                params={"ids": node_id, "depth": 20},
            )
            resp.raise_for_status()
            data = resp.json()
            node_entry = (data.get("nodes") or {}).get(node_id)
            if not node_entry:
                raise ValueError(f"Node {node_id} not found in Figma file {file_key} (check sharing access)")
            doc = node_entry["document"]
            title = doc.get("name", "")
        else:
            # No node-id in the URL — fall back to the file's top-level page names only,
            # since a whole-file tree can be enormous (hundreds of pages/frames).
            resp = await client.get(f"https://api.figma.com/v1/files/{file_key}", params={"depth": 1})
            resp.raise_for_status()
            data = resp.json()
            doc = data.get("document", {})
            title = data.get("name", "")

        texts: list[str] = []
        colors: set[str] = set()
        self._walk(doc, texts, colors)

        text_summary = " | ".join(texts)[:max_chars]
        return {
            "title": title,
            "text_summary": text_summary,
            "colors": sorted(colors)[:20],
            "url": url,
            "has_content": bool(text_summary),
            "node_id": node_id,
            "file_key": file_key,
        }


_client: Optional[FigmaClient] = None


def get_figma_client() -> FigmaClient:
    global _client
    if _client is None:
        _client = FigmaClient()
    return _client

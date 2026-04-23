"""
Release Notes service.
Fetches bugs labelled FromHaim or Prod_Zoho and manages their Release Notes field.
"""
import logging
from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

RELEASE_NOTES_FIELD = "customfield_11060"
LABELS_FILTER = ["FromHaim", "Prod_Zoho"]


def _extract_text(adf) -> str:
    """Recursively extract plain text from an ADF document."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf
    if isinstance(adf, dict):
        if adf.get("type") == "text":
            return adf.get("text", "")
        parts = []
        for child in adf.get("content", []):
            t = _extract_text(child)
            if t:
                parts.append(t)
        return " ".join(parts)
    if isinstance(adf, list):
        return " ".join(_extract_text(i) for i in adf if _extract_text(i))
    return ""


def _plain_adf(text: str) -> dict:
    return {
        "version": 1,
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": text.strip() or " "}],
            }
        ],
    }


class ReleaseNotesService:

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    def _issue_url(self, key: str) -> str:
        return f"{self.jira_base_url}/browse/{key}"

    def _cache_key(self, version=None, epic_key=None) -> str:
        if version:
            import hashlib
            return f"release_notes:version:{hashlib.md5(version.encode()).hexdigest()[:8]}"
        if epic_key:
            import hashlib
            return f"release_notes:epic:{hashlib.md5(epic_key.encode()).hexdigest()[:8]}"
        return "release_notes:all"

    async def get_issues(
        self,
        version: str | None = None,
        epic_key: str | None = None,
        force_refresh: bool = False,
    ) -> list[dict]:
        cache_key = self._cache_key(version, epic_key)
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            labels_clause = "labels in (FromHaim, Prod_Zoho)"
            if version:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND fixVersion = "{version}" '
                    f'AND {labels_clause} ORDER BY created DESC'
                )
            elif epic_key:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND parent = "{epic_key}" '
                    f'AND {labels_clause} ORDER BY created DESC'
                )
            else:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND {labels_clause} '
                    f'ORDER BY created DESC'
                )

            issues_raw = await self.jira.search_issues(
                jql,
                fields=[
                    "summary", "status", "priority", "assignee",
                    "fixVersions", "parent", "labels",
                    "description", RELEASE_NOTES_FIELD,
                ],
                max_total=500,
            )

            results = []
            for issue in issues_raw:
                f = issue.get("fields", {})
                desc_text = _extract_text(f.get("description"))
                rn_text   = _extract_text(f.get(RELEASE_NOTES_FIELD))
                results.append({
                    "key":           issue["key"],
                    "url":           self._issue_url(issue["key"]),
                    "summary":       f.get("summary", ""),
                    "status":        (f.get("status") or {}).get("name", ""),
                    "priority":      (f.get("priority") or {}).get("name", ""),
                    "assignee":      ((f.get("assignee") or {}).get("displayName") or ""),
                    "fix_versions":  [v["name"] for v in (f.get("fixVersions") or [])],
                    "labels":        f.get("labels") or [],
                    "description":   desc_text,
                    "release_notes": rn_text,
                })
            return results

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def update_release_notes(self, issue_key: str, text: str) -> dict:
        await self.jira.put(
            f"/issue/{issue_key}",
            json={"fields": {RELEASE_NOTES_FIELD: _plain_adf(text)}},
        )
        # Bust all release notes caches
        for key in list(self.cache._store.keys()):
            if key.startswith("release_notes:"):
                self.cache.invalidate(key)
        return {"ok": True, "key": issue_key}


_service: ReleaseNotesService | None = None


def get_release_notes_service() -> ReleaseNotesService:
    global _service
    if _service is None:
        _service = ReleaseNotesService()
    return _service

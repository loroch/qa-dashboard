"""
Test Coverage service.
- Stories/Epics covered by Test Cases for a given Fix Version
- Unlinked Test Cases (no story link or no version)
- Assign a test case to a story / fix version via Jira REST API
"""
import asyncio
import logging
from collections import defaultdict

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

# All link type names that indicate a test case covers a story
TEST_LINK_TYPES = {"Test Case", "Has Test Case", "relates to"}

CACHE_KEY_VERSIONS  = "coverage:versions"
CACHE_KEY_UNLINKED  = "coverage:unlinked"


def _cache_key_version(version: str) -> str:
    return f"coverage:version:{version}"


class CoverageService:

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    # ── helpers ────────────────────────────────────────────────────────────

    def _issue_url(self, key: str) -> str:
        return f"{self.jira_base_url}/browse/{key}"

    async def _fetch_all(self, jql: str, fields: list[str], page_size: int = 100) -> list[dict]:
        """Paginate through all Jira results for a JQL query."""
        all_issues = []
        start = 0
        while True:
            print(f"[coverage] _fetch_all page start={start} jql={jql[:80]}")
            batch = await self.jira.search_issues(
                jql, fields=fields, max_results=page_size, start_at=start
            )
            all_issues.extend(batch)
            print(f"[coverage] _fetch_all got {len(batch)} items, total so far: {len(all_issues)}")
            if len(batch) < page_size:
                break
            start += page_size
        return all_issues

    # ── public API ─────────────────────────────────────────────────────────

    async def get_versions(self, force_refresh: bool = False) -> list[dict]:
        """Return all project versions sorted by release status then name."""
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_VERSIONS)

        async def fetch():
            data = await self.jira.get("/project/TMT0/versions")
            versions = []
            for v in data:
                versions.append({
                    "id":       v.get("id"),
                    "name":     v.get("name"),
                    "released": v.get("released", False),
                    "archived": v.get("archived", False),
                })
            # unreleased first, then released, skip archived
            versions = [v for v in versions if not v["archived"]]
            versions.sort(key=lambda v: (v["released"], v["name"]))
            return versions

        return await self.cache.get_or_fetch(CACHE_KEY_VERSIONS, fetch, ttl=3600)

    async def get_by_version(self, version: str, force_refresh: bool = False) -> dict:
        """
        Return all Stories in a fix version with their test case count,
        grouped by Epic.
        """
        cache_key = _cache_key_version(version)
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            # 1. Fetch all Stories in this version
            jql = (
                f'issuetype = Story AND fixVersion = "{version}" '
                f'ORDER BY parent ASC, key ASC'
            )
            stories_raw = await self._fetch_all(
                jql,
                fields=["summary", "status", "fixVersions", "parent",
                        "issuelinks", "customfield_10014", "customfield_10011"],
            )

            # 2. Collect epic keys to fetch summaries
            epic_keys = set()
            stories = []
            for issue in stories_raw:
                f = issue.get("fields", {})
                parent = f.get("parent") or {}
                epic_key = parent.get("key") or f.get("customfield_10014")

                # Count test case links — accept multiple link type names,
                # check both inward and outward sides
                links = f.get("issuelinks") or []
                tc_keys = []
                for lk in links:
                    if lk.get("type", {}).get("name") in TEST_LINK_TYPES:
                        for side in ("inwardIssue", "outwardIssue"):
                            linked = lk.get(side)
                            if linked:
                                tc_keys.append(linked["key"])

                stories.append({
                    "key":        issue["key"],
                    "url":        self._issue_url(issue["key"]),
                    "summary":    f.get("summary", ""),
                    "status":     (f.get("status") or {}).get("name", ""),
                    "epic_key":   epic_key,
                    "test_count": len(tc_keys),
                    "test_keys":  tc_keys,
                })
                if epic_key:
                    epic_keys.add(epic_key)

            # 3. Fetch epic summaries in batch
            epic_info: dict[str, dict] = {}
            if epic_keys:
                keys_jql = ", ".join(f'"{k}"' for k in epic_keys)
                epics_raw = await self._fetch_all(
                    f"issueKey in ({keys_jql})",
                    fields=["summary", "status"],
                )
                for e in epics_raw:
                    ef = e.get("fields", {})
                    epic_info[e["key"]] = {
                        "key":     e["key"],
                        "url":     self._issue_url(e["key"]),
                        "summary": ef.get("summary", ""),
                        "status":  (ef.get("status") or {}).get("name", ""),
                    }

            # 4. Group stories by epic
            by_epic: dict[str, dict] = {}
            for story in stories:
                ek = story["epic_key"] or "No Epic"
                if ek not in by_epic:
                    info = epic_info.get(ek, {})
                    by_epic[ek] = {
                        "epic_key":     ek,
                        "epic_url":     info.get("url", ""),
                        "epic_summary": info.get("summary", ek),
                        "epic_status":  info.get("status", ""),
                        "stories":      [],
                        "total_stories":    0,
                        "covered_stories":  0,
                        "total_tests":      0,
                    }
                by_epic[ek]["stories"].append(story)
                by_epic[ek]["total_stories"] += 1
                by_epic[ek]["total_tests"]   += story["test_count"]
                if story["test_count"] > 0:
                    by_epic[ek]["covered_stories"] += 1

            epics_list = sorted(
                by_epic.values(),
                key=lambda e: (-e["total_tests"], e["epic_key"]),
            )

            total_stories  = len(stories)
            covered        = sum(1 for s in stories if s["test_count"] > 0)
            total_tests    = sum(s["test_count"] for s in stories)

            return {
                "version": version,
                "summary": {
                    "total_stories":   total_stories,
                    "covered_stories": covered,
                    "uncovered_stories": total_stories - covered,
                    "total_tests": total_tests,
                    "coverage_pct": round(covered / total_stories * 100) if total_stories else 0,
                },
                "by_epic": epics_list,
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_unlinked_tests(self, force_refresh: bool = False) -> list[dict]:
        """
        Return all Test issues that are NOT linked to any Story via
        the 'Test Case' link type.
        """
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_UNLINKED)

        async def fetch():
            # Fetch unlinked tests using exact JQL verified in Jira
            jql = 'issuetype = Test AND created >= "-120d" AND text ~ "Test Case" AND text ~ "is tested by" AND parent IS EMPTY ORDER BY created DESC'
            logger.info(f"[coverage] Unlinked tests JQL: {jql}")
            print(f"[coverage] Unlinked tests JQL: {jql}")

            tests_raw = await self.jira.search_issues(
                jql,
                fields=["summary", "status", "fixVersions"],
                max_results=200,
                start_at=0,
            )
            logger.info(f"[coverage] Fetched {len(tests_raw)} unlinked test issues")
            print(f"[coverage] Fetched {len(tests_raw)} unlinked test issues")

            return [
                {
                    "key":      issue["key"],
                    "url":      self._issue_url(issue["key"]),
                    "summary":  issue.get("fields", {}).get("summary", ""),
                    "status":   (issue.get("fields", {}).get("status") or {}).get("name", ""),
                    "versions": [v["name"] for v in (issue.get("fields", {}).get("fixVersions") or [])],
                }
                for issue in tests_raw
            ]

        return await self.cache.get_or_fetch(CACHE_KEY_UNLINKED, fetch, ttl=300)

    async def assign_test(
        self,
        test_key: str,
        story_key: str,
        fix_version: str | None = None,
    ) -> dict:
        """
        Link a test case to a story and optionally set a fix version on it.
        """
        results = []

        # 1. Create "Test Case" issue link (outward from test → story)
        try:
            await self.jira.post(
                "/issueLink",
                json={
                    "type": {"name": "Test Case"},
                    "inwardIssue":  {"key": story_key},
                    "outwardIssue": {"key": test_key},
                },
            )
            results.append(f"Linked {test_key} → {story_key} (Test Case)")
        except Exception as e:
            return {"ok": False, "error": f"Link failed: {e}"}

        # 2. Set fix version if requested
        if fix_version:
            try:
                await self.jira.put(
                    f"/issue/{test_key}",
                    json={
                        "update": {
                            "fixVersions": [{"add": {"name": fix_version}}]
                        }
                    },
                )
                results.append(f"Set fixVersion={fix_version} on {test_key}")
            except Exception as e:
                results.append(f"Warning: could not set version: {e}")

        # 3. Invalidate caches
        self.cache.invalidate(CACHE_KEY_UNLINKED)
        if fix_version:
            self.cache.invalidate(_cache_key_version(fix_version))

        return {"ok": True, "actions": results}

    async def search_stories(self, query: str) -> list[dict]:
        """Quick story search for the assign dialog."""
        jql = f'issuetype = Story AND text ~ "{query}" ORDER BY updated DESC'
        issues = await self.jira.search_issues(
            jql,
            fields=["summary", "fixVersions", "parent"],
            max_results=20,
        )
        results = []
        for issue in issues:
            f = issue.get("fields", {})
            results.append({
                "key":      issue["key"],
                "url":      self._issue_url(issue["key"]),
                "summary":  f.get("summary", ""),
                "versions": [v["name"] for v in (f.get("fixVersions") or [])],
                "epic_key": (f.get("parent") or {}).get("key"),
            })
        return results


_service: CoverageService | None = None

def get_coverage_service() -> CoverageService:
    global _service
    if _service is None:
        _service = CoverageService()
    return _service

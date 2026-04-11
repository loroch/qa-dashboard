"""
Anomaly Detection service.

Surfaces Jira data quality issues:
1. Test cases linked to Stories but missing a parent field  → recommend Epic as parent
2. Bugs missing fix version / parent / sprint              → grouped by deficiency
3. Potential duplicate bugs                                → text-similarity clustering
"""
import asyncio
import difflib
import logging
import re
from collections import defaultdict

from app.config import get_settings
from app.jira.client import get_jira_client
from app.services.cache_service import get_cache

logger = logging.getLogger(__name__)

CACHE_KEY_TESTS_WITHOUT_PARENT = "anomaly:tests_without_parent"


def _cache_key_incomplete(days: int) -> str:
    return f"anomaly:incomplete_bugs:{days}"


def _cache_key_duplicates(days: int) -> str:
    return f"anomaly:duplicate_bugs:{days}"


class AnomalyService:

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    # ── helpers ────────────────────────────────────────────────────────────

    def _issue_url(self, key: str) -> str:
        return f"{self.jira_base_url}/browse/{key}"

    def _serialize_bug(self, issue: dict) -> dict:
        fields = issue.get("fields", {})
        return {
            "key": issue["key"],
            "url": self._issue_url(issue["key"]),
            "summary": fields.get("summary", ""),
            "status": (fields.get("status") or {}).get("name", ""),
            "priority": (fields.get("priority") or {}).get("name", ""),
        }

    # ── Section 1: Tests without parent ────────────────────────────────────

    async def get_tests_without_parent(self, force_refresh: bool = False) -> dict:
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_TESTS_WITHOUT_PARENT)

        async def fetch():
            return await self._fetch_tests_without_parent()

        return await self.cache.get_or_fetch(
            CACHE_KEY_TESTS_WITHOUT_PARENT, fetch, ttl=300
        )

    async def _fetch_tests_without_parent(self) -> dict:
        jql = "issuetype = Test AND parent is EMPTY ORDER BY created DESC"
        raw = await self.jira.search_issues(
            jql,
            fields=["summary", "status", "issuelinks"],
            max_total=5000,
        )

        # Collect linked story keys per test
        test_to_story: dict[str, str] = {}
        for issue in raw:
            fields = issue.get("fields", {})
            for link in fields.get("issuelinks", []):
                # A link has either inwardIssue or outwardIssue
                for side in ("inwardIssue", "outwardIssue"):
                    linked = link.get(side)
                    if linked:
                        linked_type = (
                            (linked.get("fields") or {})
                            .get("issuetype", {})
                            .get("name", "")
                        )
                        if linked_type == "Story":
                            test_to_story[issue["key"]] = linked["key"]
                            break
                if issue["key"] in test_to_story:
                    break

        # Fetch all unique linked stories in parallel
        unique_story_keys = list(set(test_to_story.values()))

        async def fetch_story(key: str) -> tuple[str, dict]:
            try:
                data = await self.jira.get(
                    f"/issue/{key}",
                    {"fields": "parent,summary,issuetype"},
                )
                return key, data
            except Exception as exc:
                logger.warning("Could not fetch story %s: %s", key, exc)
                return key, {}

        story_results = await asyncio.gather(*[fetch_story(k) for k in unique_story_keys])
        story_data: dict[str, dict] = {k: v for k, v in story_results}

        # Build result rows
        tests = []
        for issue in raw:
            key = issue["key"]
            fields = issue.get("fields", {})
            story_key = test_to_story.get(key, "")
            story_info = story_data.get(story_key, {})
            story_fields = (story_info.get("fields") or {})
            epic = story_fields.get("parent") or {}
            epic_fields = (epic.get("fields") or {})

            tests.append({
                "key": key,
                "url": self._issue_url(key),
                "summary": fields.get("summary", ""),
                "status": (fields.get("status") or {}).get("name", ""),
                "linked_story_key": story_key,
                "linked_story_summary": story_fields.get("summary", ""),
                "recommended_parent_key": epic.get("key", ""),
                "recommended_parent_summary": epic_fields.get("summary", ""),
            })

        return {"tests": tests, "total": len(tests)}

    async def assign_parent(self, test_key: str, parent_key: str) -> dict:
        await self.jira.put(
            f"/issue/{test_key}",
            json={"fields": {"parent": {"key": parent_key}}},
        )
        self.cache.invalidate(CACHE_KEY_TESTS_WITHOUT_PARENT)
        return {"ok": True, "message": f"Parent {parent_key} set on {test_key}"}

    # ── Section 2: Incomplete bugs ──────────────────────────────────────────

    async def get_incomplete_bugs(self, days: int, force_refresh: bool = False) -> dict:
        if force_refresh:
            self.cache.invalidate(_cache_key_incomplete(days))

        async def fetch():
            return await self._fetch_incomplete_bugs(days)

        return await self.cache.get_or_fetch(
            _cache_key_incomplete(days), fetch, ttl=300
        )

    async def _fetch_incomplete_bugs(self, days: int) -> dict:
        jql = f'issuetype = Bug AND created >= "-{days}d" ORDER BY created DESC'
        raw = await self.jira.search_issues(
            jql,
            fields=["summary", "status", "fixVersions", "parent", "customfield_10020", "priority"],
            max_total=5000,
        )

        no_fix_version: list[dict] = []
        no_parent: list[dict] = []
        no_sprint: list[dict] = []

        for issue in raw:
            fields = issue.get("fields", {})
            serialized = self._serialize_bug(issue)

            if not fields.get("fixVersions"):
                no_fix_version.append(serialized)
            if fields.get("parent") is None:
                no_parent.append(serialized)
            if not fields.get("customfield_10020"):
                no_sprint.append(serialized)

        return {
            "no_fix_version": no_fix_version,
            "no_parent": no_parent,
            "no_sprint": no_sprint,
            "total_bugs_fetched": len(raw),
        }

    # ── Section 3: Duplicate bug detection ─────────────────────────────────

    async def get_duplicate_bugs(self, days: int, force_refresh: bool = False) -> dict:
        if force_refresh:
            self.cache.invalidate(_cache_key_duplicates(days))

        async def fetch():
            return await self._fetch_duplicate_bugs(days)

        return await self.cache.get_or_fetch(
            _cache_key_duplicates(days), fetch, ttl=600
        )

    async def _fetch_duplicate_bugs(self, days: int) -> dict:
        jql = f'issuetype = Bug AND created >= "-{days}d" ORDER BY created DESC'
        raw = await self.jira.search_issues(
            jql,
            fields=["summary", "status", "priority", "created"],
            max_total=5000,
        )

        if not raw:
            return {"clusters": [], "total_clusters": 0}

        # Normalize summaries
        def normalize(s: str) -> str:
            return re.sub(r"[^\w\s]", "", s.lower()).strip()

        items = []
        for issue in raw:
            fields = issue.get("fields", {})
            items.append({
                "key": issue["key"],
                "url": self._issue_url(issue["key"]),
                "summary": fields.get("summary", ""),
                "norm": normalize(fields.get("summary", "")),
                "status": (fields.get("status") or {}).get("name", ""),
                "priority": (fields.get("priority") or {}).get("name", ""),
                "created": fields.get("created", ""),
            })

        n = len(items)
        # Find similar pairs (O(n²) — acceptable for ≤500 short strings)
        edges: list[tuple[int, int, float]] = []
        for i in range(n):
            for j in range(i + 1, n):
                ratio = difflib.SequenceMatcher(
                    None, items[i]["norm"], items[j]["norm"]
                ).ratio()
                if ratio > 0.6:
                    edges.append((i, j, ratio))

        if not edges:
            return {"clusters": [], "total_clusters": 0}

        # Union-Find clustering
        parent_map = list(range(n))

        def find(x: int) -> int:
            while parent_map[x] != x:
                parent_map[x] = parent_map[parent_map[x]]
                x = parent_map[x]
            return x

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent_map[ra] = rb

        # Track best similarity per cluster root
        best_score: dict[int, float] = defaultdict(float)
        for i, j, score in edges:
            union(i, j)
            root = find(i)
            best_score[root] = max(best_score[root], score)

        # Group indices by root
        groups: dict[int, list[int]] = defaultdict(list)
        for idx in range(n):
            root = find(idx)
            if any(find(i) == root or find(j) == root for i, j, _ in edges):
                groups[root].append(idx)

        # Build clusters (only groups with 2+ members that have edges)
        roots_with_edges: set[int] = set()
        for i, j, _ in edges:
            roots_with_edges.add(find(i))

        clusters = []
        for root, indices in groups.items():
            if root not in roots_with_edges or len(indices) < 2:
                continue
            max_sim = best_score.get(root, 0.0)
            cluster_bugs = []
            for idx in indices:
                bug = items[idx].copy()
                bug.pop("norm", None)
                cluster_bugs.append(bug)
            clusters.append({
                "bugs": cluster_bugs,
                "max_similarity": round(max_sim * 100),
            })

        # Sort clusters by similarity descending
        clusters.sort(key=lambda c: c["max_similarity"], reverse=True)

        return {"clusters": clusters, "total_clusters": len(clusters)}


# ── Singleton ───────────────────────────────────────────────────────────────

_service: AnomalyService | None = None


def get_anomaly_service() -> AnomalyService:
    global _service
    if _service is None:
        _service = AnomalyService()
    return _service

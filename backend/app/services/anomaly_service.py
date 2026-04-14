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
from datetime import datetime, timezone, timedelta

from app.config import get_settings, get_field_mapping
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
        parent = fields.get("parent") or {}
        parent_fields = parent.get("fields") or {}
        return {
            "key": issue["key"],
            "url": self._issue_url(issue["key"]),
            "summary": fields.get("summary", ""),
            "status": (fields.get("status") or {}).get("name", ""),
            "priority": (fields.get("priority") or {}).get("name", ""),
            "parent_key": parent.get("key", ""),
            "parent_summary": parent_fields.get("summary", ""),
            "labels": fields.get("labels") or [],
            "created": (fields.get("created") or "")[:10],  # YYYY-MM-DD
            "found_in_versions": [v.get("name", "") for v in (fields.get("versions") or [])],
            "components": [c.get("name", "") for c in (fields.get("components") or [])],
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
        jql = "project = TMT0 AND issuetype = Test AND parent is EMPTY ORDER BY created DESC"
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
        jql = f'project = TMT0 AND issuetype = Bug AND created >= "-{days}d" ORDER BY created DESC'
        raw = await self.jira.search_issues(
            jql,
            fields=["summary", "status", "fixVersions", "versions", "parent", "customfield_10020", "priority", "labels", "created", "components"],
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
        jql = f'project = TMT0 AND issuetype = Bug AND created >= "-{days}d" ORDER BY created DESC'
        raw = await self.jira.search_issues(
            jql,
            fields=["summary", "status", "priority", "created", "parent", "labels", "fixVersions"],
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
            parent = fields.get("parent") or {}
            parent_fields = parent.get("fields") or {}
            items.append({
                "key": issue["key"],
                "url": self._issue_url(issue["key"]),
                "summary": fields.get("summary", ""),
                "norm": normalize(fields.get("summary", "")),
                "status": (fields.get("status") or {}).get("name", ""),
                "priority": (fields.get("priority") or {}).get("name", ""),
                "created": (fields.get("created") or "")[:10],
                "parent_key": parent.get("key", ""),
                "parent_summary": parent_fields.get("summary", ""),
                "labels": fields.get("labels") or [],
                "fix_versions": [v.get("name", "") for v in (fields.get("fixVersions") or [])],
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

    # ── Section 4: Team Activity ────────────────────────────────────────────

    async def get_team_activity(self, days: int, force_refresh: bool = False) -> dict:
        cache_key = f"anomaly:team_activity:{days}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            return await self._fetch_team_activity(days)

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=180)

    async def _fetch_team_activity(self, days: int) -> dict:
        mapping = get_field_mapping()
        team_members = mapping["jira"]["team_members"]  # [{id, name, role}]
        team_ids = {m["id"] for m in team_members}
        member_by_id = {m["id"]: m for m in team_members}
        team_ids_jql = ", ".join(team_ids)

        # Cutoff timestamp
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_str = cutoff.strftime("%Y-%m-%dT%H:%M:%S%z")

        # Fetch recently updated TMT0 bugs (for status changes + comments)
        jql = f'project = TMT0 AND issuetype = Bug AND updated >= "-{days}d" ORDER BY updated DESC'
        raw, created_raw = await asyncio.gather(
            self.jira.search_issues(
                jql,
                fields=["summary", "status", "comment"],
                max_total=500,
            ),
            self.jira.search_issues(
                f'project = TMT0 AND issuetype = Bug AND created >= "-{days}d" AND creator in ({team_ids_jql}) ORDER BY created DESC',
                fields=["summary", "status", "priority", "creator", "created"],
                max_total=500,
            ),
        )

        if not raw and not created_raw:
            return self._empty_activity(team_members)

        # Fetch changelogs for all issues concurrently (max 20 at a time)
        sem = asyncio.Semaphore(20)

        async def fetch_changelog(key: str):
            async with sem:
                try:
                    data = await self.jira.get(f"/issue/{key}/changelog", {"maxResults": 100})
                    return key, data.get("values", [])
                except Exception as exc:
                    logger.warning("changelog fetch failed for %s: %s", key, exc)
                    return key, []

        issue_keys = [i["key"] for i in raw]
        changelog_results = await asyncio.gather(*[fetch_changelog(k) for k in issue_keys])
        changelog_by_key = {k: v for k, v in changelog_results}

        # Build issue summary lookup
        summary_by_key = {i["key"]: (i.get("fields") or {}).get("summary", "") for i in raw}

        # Initialise per-member buckets
        members_data: dict[str, dict] = {}
        for m in team_members:
            members_data[m["id"]] = {
                "account_id": m["id"],
                "name": m["name"],
                "role": m.get("role", ""),
                "status_changes": [],
                "comments": [],
                "bugs_opened": [],
            }

        # Extract status changes from changelogs
        for issue_key, changelog_entries in changelog_by_key.items():
            for entry in changelog_entries:
                author = entry.get("author") or {}
                author_id = author.get("accountId", "")
                if author_id not in team_ids:
                    continue

                created_str = entry.get("created", "")
                try:
                    entry_dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if entry_dt < cutoff:
                    continue

                for item in entry.get("items", []):
                    if item.get("field") == "status":
                        members_data[author_id]["status_changes"].append({
                            "issue_key": issue_key,
                            "issue_url": self._issue_url(issue_key),
                            "issue_summary": summary_by_key.get(issue_key, ""),
                            "from_status": item.get("fromString", ""),
                            "to_status": item.get("toString", ""),
                            "timestamp": created_str[:16].replace("T", " "),
                        })

        # Extract comments by team members
        for issue in raw:
            issue_key = issue["key"]
            fields = issue.get("fields") or {}
            comment_data = fields.get("comment") or {}
            for comment in comment_data.get("comments", []):
                author = comment.get("author") or {}
                author_id = author.get("accountId", "")
                if author_id not in team_ids:
                    continue

                created_str = comment.get("created", "")
                try:
                    entry_dt = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if entry_dt < cutoff:
                    continue

                # Extract plain text from Atlassian Document Format body
                body = comment.get("body") or {}
                text = self._extract_adf_text(body) if isinstance(body, dict) else str(body)

                members_data[author_id]["comments"].append({
                    "issue_key": issue_key,
                    "issue_url": self._issue_url(issue_key),
                    "issue_summary": summary_by_key.get(issue_key, ""),
                    "comment_preview": text[:300].strip(),
                    "timestamp": created_str[:16].replace("T", " "),
                })

        # Extract bugs opened (created) by team members
        for issue in created_raw:
            issue_key = issue["key"]
            fields = issue.get("fields") or {}
            creator = fields.get("creator") or {}
            creator_id = creator.get("accountId", "")
            if creator_id not in team_ids:
                continue
            created_str = (fields.get("created") or "")[:16].replace("T", " ")
            status = (fields.get("status") or {}).get("name", "")
            priority = (fields.get("priority") or {}).get("name", "")
            summary = fields.get("summary", "")
            members_data[creator_id]["bugs_opened"].append({
                "issue_key": issue_key,
                "issue_url": self._issue_url(issue_key),
                "issue_summary": summary,
                "status": status,
                "priority": priority,
                "timestamp": created_str,
            })

        # Sort each member's activity by timestamp descending
        for md in members_data.values():
            md["status_changes"].sort(key=lambda x: x["timestamp"], reverse=True)
            md["comments"].sort(key=lambda x: x["timestamp"], reverse=True)
            md["bugs_opened"].sort(key=lambda x: x["timestamp"], reverse=True)

        members = list(members_data.values())
        total = sum(len(m["status_changes"]) + len(m["comments"]) + len(m["bugs_opened"]) for m in members)

        return {
            "members": members,
            "total_activities": total,
            "days": days,
            "issues_scanned": len(raw),
        }

    def _empty_activity(self, team_members: list) -> dict:
        return {
            "members": [
                {"account_id": m["id"], "name": m["name"], "role": m.get("role", ""),
                 "status_changes": [], "comments": [], "bugs_opened": []}
                for m in team_members
            ],
            "total_activities": 0,
            "days": 0,
            "issues_scanned": 0,
        }

    def _extract_adf_text(self, node: dict, depth: int = 0) -> str:
        """Recursively extract plain text from Atlassian Document Format."""
        if depth > 10:
            return ""
        node_type = node.get("type", "")
        if node_type == "text":
            return node.get("text", "")
        parts = []
        for child in node.get("content", []):
            parts.append(self._extract_adf_text(child, depth + 1))
        sep = "\n" if node_type in ("paragraph", "bulletList", "listItem", "heading") else ""
        return sep.join(p for p in parts if p)


# ── Singleton ───────────────────────────────────────────────────────────────

_service: AnomalyService | None = None


def get_anomaly_service() -> AnomalyService:
    global _service
    if _service is None:
        _service = AnomalyService()
    return _service

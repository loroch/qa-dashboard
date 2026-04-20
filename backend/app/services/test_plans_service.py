"""
Test Plans Service.
Creates Jira regression test plan Epics and links all Test issues for a version.
"""
import asyncio
import logging
from typing import Optional

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache

logger = logging.getLogger(__name__)

CACHE_KEY_VERSIONS = "test_plans:versions"
LINK_BATCH_SIZE    = 20   # links per batch
LINK_BATCH_DELAY   = 2.0  # seconds to sleep between batches
LINK_CONCURRENCY   = 5    # parallel requests within a batch


class TestPlansService:

    def __init__(self):
        self.jira  = get_jira_client()
        self.cache = get_cache()

    # ── versions ──────────────────────────────────────────────────────────

    async def get_versions(self) -> list[dict]:
        """Return all non-archived fix versions for TMT0, unreleased first."""
        async def fetch():
            data = await self.jira.get("/project/TMT0/versions")
            versions = [
                {
                    "id":       v["id"],
                    "name":     v["name"],
                    "released": v.get("released", False),
                }
                for v in data
                if not v.get("archived", False) and v.get("name")
            ]
            versions.sort(key=lambda v: (v["released"], v["name"]))
            return versions

        return await self.cache.get_or_fetch(CACHE_KEY_VERSIONS, fetch, ttl=3600)

    # ── tests for version ─────────────────────────────────────────────────

    async def get_tests_for_version(self, version: str) -> list[dict]:
        """Return all Xray Test issues for the given fix version in TMT0."""
        cache_key = f"test_plans:tests:{version}"

        async def fetch():
            jql = (
                f'project = TMT0 AND issuetype = Test '
                f'AND fixVersion = "{version}" ORDER BY key ASC'
            )
            issues = await self.jira.search_issues(jql, fields=["summary", "status"])
            return [
                {
                    "id":      issue["id"],
                    "key":     issue["key"],
                    "summary": (issue.get("fields") or {}).get("summary", ""),
                    "status":  ((issue.get("fields") or {}).get("status") or {}).get("name", ""),
                    "url":     f"{self.jira.base_url}/browse/{issue['key']}",
                }
                for issue in issues
            ]

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=600)

    # ── resolve issue IDs → details ───────────────────────────────────────

    async def resolve_issue_ids(self, issue_ids: list[str]) -> list[dict]:
        """
        Accept a list of numeric IDs or keys, fetch each issue, return details.
        Skips IDs that fail (not found / wrong project).
        Uses JQL IN query for efficiency (batches of 100).
        """
        # Build JQL: issue in (48240, 42803, ...) or mix of keys and IDs
        BATCH = 100
        results = []

        for i in range(0, len(issue_ids), BATCH):
            batch = issue_ids[i:i + BATCH]
            id_list = ", ".join(batch)
            jql = f"issue in ({id_list}) ORDER BY key ASC"
            try:
                issues = await self.jira.search_issues(
                    jql,
                    fields=["summary", "status"],
                    max_total=len(batch) + 10,
                )
                for issue in issues:
                    results.append({
                        "id":      issue["id"],
                        "key":     issue["key"],
                        "summary": (issue.get("fields") or {}).get("summary", ""),
                        "status":  ((issue.get("fields") or {}).get("status") or {}).get("name", ""),
                        "url":     f"{self.jira.base_url}/browse/{issue['key']}",
                    })
            except Exception as exc:
                logger.warning("Failed to resolve batch %s…: %s", batch[:3], exc)

        return results

    # ── create test executions ───────────────────────────────────────────

    async def create_executions(
        self,
        epic_key: str,
        version: str,
        executions: list[dict],   # [{name, assignee_id, test_keys[]}]
    ) -> list[dict]:
        """
        For each execution group:
          1. Create a Task under the epic with assignee + fixVersion
          2. Link each test key to the task via 'Relates'
        Returns list of {name, task_key, task_url, total, linked, failed, failures}
        """
        # Create all tasks in parallel (up to 5 at once), then link tests per task
        task_sem = asyncio.Semaphore(5)

        async def create_one(ex: dict) -> dict:
            name        = ex["name"]
            assignee_id = ex.get("assignee_id")
            test_keys   = ex.get("test_keys", [])

            fields: dict = {
                "project":     {"key": "TMT0"},
                "issuetype":   {"name": "Task"},
                "summary":     name,
                "fixVersions": [{"name": version}],
                "parent":      {"key": epic_key},
            }
            if assignee_id:
                fields["assignee"] = {"accountId": assignee_id}

            async with task_sem:
                try:
                    resp     = await self.jira.post("/issue", {"fields": fields})
                    task_key = resp.get("key")
                    if not task_key:
                        raise ValueError("Jira did not return a key")
                except Exception as exc:
                    logger.error("Failed to create task '%s': %s", name, exc)
                    return {"name": name, "task_key": None, "task_url": None, "error": str(exc)}

            task_url = f"{self.jira.base_url}/browse/{task_key}"
            logger.info("Created execution task %s (%s, %d tests)", task_key, name, len(test_keys))

            # Link tests in batches
            link_sem = asyncio.Semaphore(LINK_CONCURRENCY)

            async def link_one(test_key: str):
                async with link_sem:
                    try:
                        await self.jira.post("/issueLink", {
                            "type":         {"name": "Relates"},
                            "inwardIssue":  {"key": task_key},
                            "outwardIssue": {"key": test_key},
                        })
                        return None
                    except Exception as exc:
                        return {"key": test_key, "error": str(exc)}

            failures = []
            batches  = [test_keys[i:i + LINK_BATCH_SIZE] for i in range(0, len(test_keys), LINK_BATCH_SIZE)]
            for idx, batch in enumerate(batches):
                batch_results = await asyncio.gather(*[link_one(k) for k in batch])
                failures.extend(r for r in batch_results if r is not None)
                if idx < len(batches) - 1:
                    await asyncio.sleep(LINK_BATCH_DELAY)

            return {
                "name":     name,
                "task_key": task_key,
                "task_url": task_url,
                "total":    len(test_keys),
                "linked":   len(test_keys) - len(failures),
                "failed":   len(failures),
                "failures": failures,
            }

        results = await asyncio.gather(*[create_one(ex) for ex in executions])
        return list(results)

    # ── create test plan ──────────────────────────────────────────────────

    async def create_test_plan(
        self,
        name: str,
        version: str,
        issue_keys: list[str],
    ) -> dict:
        """
        1. Create a TMT0 Epic as the test plan container.
        2. Concurrently link all Test issues to it via 'relates to'.
        Returns: {epic_key, epic_url, total, linked, failed, failures}
        """
        # 1. Create Epic
        result = await self.jira.post("/issue", {
            "fields": {
                "project":           {"key": "TMT0"},
                "issuetype":         {"name": "Epic"},
                "summary":           name,
                "customfield_10011": name,      # Epic Name field
                "fixVersions":       [{"name": version}],
            }
        })
        epic_key = result.get("key")
        if not epic_key:
            raise ValueError("Jira did not return a key for the created Epic")
        epic_url = f"{self.jira.base_url}/browse/{epic_key}"
        logger.info("Created test plan Epic %s for version %s", epic_key, version)

        # 2. Bulk-link in batches to avoid Jira rate limits (429)
        sem = asyncio.Semaphore(LINK_CONCURRENCY)

        async def link_one(test_key: str):
            async with sem:
                try:
                    await self.jira.post("/issueLink", {
                        "type":         {"name": "Relates"},
                        "inwardIssue":  {"key": epic_key},
                        "outwardIssue": {"key": test_key},
                    })
                    return None
                except Exception as exc:
                    logger.warning("Failed to link %s → %s: %s", test_key, epic_key, exc)
                    return {"key": test_key, "error": str(exc)}

        failures = []
        batches  = [issue_keys[i:i + LINK_BATCH_SIZE] for i in range(0, len(issue_keys), LINK_BATCH_SIZE)]
        for idx, batch in enumerate(batches):
            logger.info("Linking batch %d/%d (%d issues)…", idx + 1, len(batches), len(batch))
            batch_results = await asyncio.gather(*[link_one(k) for k in batch])
            failures.extend(r for r in batch_results if r is not None)
            if idx < len(batches) - 1:
                await asyncio.sleep(LINK_BATCH_DELAY)
        linked   = len(issue_keys) - len(failures)

        logger.info(
            "Test plan %s: linked=%d failed=%d total=%d",
            epic_key, linked, len(failures), len(issue_keys),
        )

        return {
            "epic_key": epic_key,
            "epic_url": epic_url,
            "total":    len(issue_keys),
            "linked":   linked,
            "failed":   len(failures),
            "failures": failures,
        }


# ── singleton ─────────────────────────────────────────────────────────────────
_service: Optional[TestPlansService] = None


def get_test_plans_service() -> TestPlansService:
    global _service
    if _service is None:
        _service = TestPlansService()
    return _service

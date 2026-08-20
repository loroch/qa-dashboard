"""
Test Coverage service.
- Stories/Epics covered by Test Cases for a given Fix Version
- Unlinked Test Cases (no story link or no version)
- Assign a test case to a story / fix version via Jira REST API
"""
import asyncio
import json
import logging
import re
from collections import defaultdict


def _parse_ai_json(text: str) -> dict:
    """Extract and parse JSON from AI output, tolerating markdown fences and trailing commas."""
    # Strip markdown code fences
    text = re.sub(r'^```(?:json)?\s*', '', text.strip(), flags=re.MULTILINE)
    text = re.sub(r'```\s*$', '', text.strip(), flags=re.MULTILINE)
    # Extract first top-level JSON object
    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        raise ValueError("No JSON object found in AI response")
    raw = match.group()
    # Remove trailing commas before } or ]
    raw = re.sub(r',\s*([}\]])', r'\1', raw)
    return json.loads(raw)

import anthropic

from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

# All link type names that indicate a test case covers a story
TEST_LINK_TYPES = {"Test Case", "Has Test Case", "Relates"}

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

    async def _fetch_all(self, jql: str, fields: list[str]) -> list[dict]:
        """Paginate through all Jira results for a JQL query.

        Delegates to JiraClient.search_issues' own pagination rather than
        looping with startAt here — /search/jql ignores startAt and only
        supports cursor (nextPageToken) pagination, which search_issues
        already handles correctly.
        """
        return await self.jira.search_issues(jql, fields=fields, max_total=5000)

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
                tc_cases: list[dict] = []   # [{key, status}]
                tc_statuses: dict[str, int] = {}
                for lk in links:
                    if lk.get("type", {}).get("name") in TEST_LINK_TYPES:
                        for side in ("inwardIssue", "outwardIssue"):
                            linked = lk.get(side)
                            if linked:
                                st = (
                                    (linked.get("fields") or {})
                                    .get("status", {})
                                    .get("name", "Unknown")
                                )
                                tc_cases.append({"key": linked["key"], "status": st})
                                tc_statuses[st] = tc_statuses.get(st, 0) + 1

                stories.append({
                    "key":          issue["key"],
                    "url":          self._issue_url(issue["key"]),
                    "summary":      f.get("summary", ""),
                    "status":       (f.get("status") or {}).get("name", ""),
                    "epic_key":     epic_key,
                    "test_count":   len(tc_cases),
                    "test_keys":    [t["key"] for t in tc_cases],
                    "test_cases":   tc_cases,
                    "test_statuses": tc_statuses,
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

    # Map version-name prefix (uppercase) → regression label in Jira
    _VERSION_LABEL_MAP: list[tuple[str, str]] = [
        ("K1-S",  "REGRESSION_TEST"),
        ("CI-MG", "REGRESSION_TEST_CI"),
        ("MG-CI", "REGRESSION_TEST_CI"),
    ]

    def _regression_label(self, version: str | None) -> str:
        """Return the Jira label to use for the regression suite of a given version."""
        if not version:
            return "REGRESSION_TEST"
        v = version.upper()
        for prefix, label in self._VERSION_LABEL_MAP:
            if v.startswith(prefix):
                return label
        return "REGRESSION_TEST"  # fallback

    async def get_regression_tests(self, version: str | None = None, force_refresh: bool = False) -> dict:
        """Return Test issues for the regression suite that matches the version family.

        Label mapping (by version prefix):
          K1-S-*   → REGRESSION_TEST
          CI-MG-*  → REGRESSION_TEST_CI
          MG-CI-*  → REGRESSION_TEST_CI
        No fixVersion filter — the label is the version-family identifier.
        """
        label = self._regression_label(version)
        cache_key = f"coverage:regression_tests:{version or label}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            if version:
                # Both conditions required: label (version family) + exact fixVersion
                jql = (
                    f'issuetype = Test AND labels = "{label}" AND fixVersion = "{version}" '
                    f'ORDER BY status ASC, key ASC'
                )
            else:
                jql = (
                    f'issuetype = Test AND labels = "{label}" '
                    f'ORDER BY status ASC, key ASC'
                )
            tests_raw = await self._fetch_all(
                jql,
                fields=["summary", "status", "labels"],
            )
            tests = []
            for issue in tests_raw:
                f = issue.get("fields", {})
                tests.append({
                    "key":     issue["key"],
                    "url":     self._issue_url(issue["key"]),
                    "summary": f.get("summary", ""),
                    "status":  (f.get("status") or {}).get("name", ""),
                    "labels":  f.get("labels") or [],
                })
            status_counts: dict[str, int] = {}
            for t in tests:
                st = t["status"]
                status_counts[st] = status_counts.get(st, 0) + 1
            return {
                "tests":         tests,
                "total":         len(tests),
                "status_counts": status_counts,
                "label":         label,
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

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

    async def search_epics_and_stories(self, query: str) -> list[dict]:
        """Search both Epics and Stories by key or keyword."""
        q_safe = query.replace('"', "").strip()

        def _fmt(i: dict) -> dict:
            f = i.get("fields", {})
            return {
                "key":     i["key"],
                "url":     self._issue_url(i["key"]),
                "summary": f.get("summary", ""),
                "type":    (f.get("issuetype") or {}).get("name", ""),
                "status":  (f.get("status") or {}).get("name", ""),
            }

        # Key-format: call get_issue directly — avoids JQL text-search issues with hyphens
        if "-" in q_safe:
            try:
                issue = await self.jira.get_issue(
                    q_safe.upper(), fields=["summary", "issuetype", "status"]
                )
                return [_fmt(issue)] if issue else []
            except Exception as e:
                logger.warning(f"search_epics_and_stories get_issue failed for {q_safe}: {e}")
                return []

        # Keyword search
        jql = (
            f'project = TMT0 AND issuetype in (Epic, Story, Task) '
            f'AND summary ~ "{q_safe}*" ORDER BY issuetype ASC, updated DESC'
        )
        try:
            issues = await self.jira.search_issues(
                jql, fields=["summary", "issuetype", "status"], max_results=15
            )
        except Exception as e:
            logger.warning(f"search_epics_and_stories JQL failed: {e}")
            return []
        return [_fmt(i) for i in issues]

    async def get_by_epic_or_story(self, issue_key: str, force_refresh: bool = False) -> dict:
        """Return test coverage for a specific Epic or Story."""
        key = issue_key.upper()
        cache_key = f"coverage:issue:{key}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            # 1. Resolve issue type + summary
            try:
                raw = await self.jira.get(f"/issue/{key}", {"fields": "issuetype,summary,status"})
                f = raw.get("fields", {})
                issue_type    = (f.get("issuetype") or {}).get("name", "Story")
                issue_summary = f.get("summary", "")
                issue_status  = (f.get("status") or {}).get("name", "")
            except Exception:
                issue_type = "Story"
                issue_summary = key
                issue_status = ""

            # 2. Fetch stories under this epic or just this story
            if issue_type == "Epic":
                jql = (
                    f'project = TMT0 AND issuetype = Story AND parent = "{key}" '
                    f'ORDER BY key ASC'
                )
            else:
                jql = f'issueKey = "{key}"'

            stories_raw = await self._fetch_all(
                jql,
                fields=["summary", "status", "parent", "issuelinks", "customfield_10014"],
            )

            # 3. Process stories (identical to get_by_version)
            epic_keys: set[str] = set()
            stories = []
            for issue in stories_raw:
                sf = issue.get("fields", {})
                parent = sf.get("parent") or {}
                epic_key = parent.get("key") or sf.get("customfield_10014") or None

                links = sf.get("issuelinks") or []
                tc_cases: list[dict] = []
                tc_statuses: dict[str, int] = {}
                for lk in links:
                    if lk.get("type", {}).get("name") in TEST_LINK_TYPES:
                        for side in ("inwardIssue", "outwardIssue"):
                            linked = lk.get(side)
                            if linked:
                                st = (linked.get("fields") or {}).get("status", {}).get("name", "Unknown")
                                tc_cases.append({"key": linked["key"], "status": st})
                                tc_statuses[st] = tc_statuses.get(st, 0) + 1

                stories.append({
                    "key":          issue["key"],
                    "url":          self._issue_url(issue["key"]),
                    "summary":      sf.get("summary", ""),
                    "status":       (sf.get("status") or {}).get("name", ""),
                    "epic_key":     epic_key,
                    "test_count":   len(tc_cases),
                    "test_keys":    [t["key"] for t in tc_cases],
                    "test_cases":   tc_cases,
                    "test_statuses": tc_statuses,
                })
                if epic_key:
                    epic_keys.add(epic_key)

            # 4. Resolve epic info
            epic_info: dict[str, dict] = {}
            if issue_type == "Epic":
                epic_info[key] = {
                    "key": key, "url": self._issue_url(key),
                    "summary": issue_summary, "status": issue_status,
                }
            elif epic_keys:
                keys_jql = ", ".join(f'"{k}"' for k in epic_keys)
                epics_raw = await self._fetch_all(f"issueKey in ({keys_jql})", fields=["summary", "status"])
                for e in epics_raw:
                    ef = e.get("fields", {})
                    epic_info[e["key"]] = {
                        "key": e["key"], "url": self._issue_url(e["key"]),
                        "summary": ef.get("summary", ""),
                        "status": (ef.get("status") or {}).get("name", ""),
                    }

            # 5. Group by epic (same shape as get_by_version)
            by_epic: dict[str, dict] = {}
            for story in stories:
                ek = story["epic_key"] or (key if issue_type == "Epic" else "No Epic")
                if ek not in by_epic:
                    info = epic_info.get(ek, {})
                    by_epic[ek] = {
                        "epic_key":        ek,
                        "epic_url":        info.get("url", ""),
                        "epic_summary":    info.get("summary", ek),
                        "epic_status":     info.get("status", ""),
                        "stories":         [],
                        "total_stories":   0,
                        "covered_stories": 0,
                        "total_tests":     0,
                    }
                by_epic[ek]["stories"].append(story)
                by_epic[ek]["total_stories"]   += 1
                by_epic[ek]["total_tests"]     += story["test_count"]
                if story["test_count"] > 0:
                    by_epic[ek]["covered_stories"] += 1

            epics_list = sorted(by_epic.values(), key=lambda e: (-e["total_tests"], e["epic_key"]))
            total_stories = len(stories)
            covered       = sum(1 for s in stories if s["test_count"] > 0)
            total_tests   = sum(s["test_count"] for s in stories)

            return {
                "issue_key":     key,
                "issue_type":    issue_type,
                "issue_summary": issue_summary,
                "summary": {
                    "total_stories":     total_stories,
                    "covered_stories":   covered,
                    "uncovered_stories": total_stories - covered,
                    "total_tests":       total_tests,
                    "coverage_pct":      round(covered / total_stories * 100) if total_stories else 0,
                },
                "by_epic": epics_list,
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    # ── AI Test Plan ───────────────────────────────────────────────────

    async def generate_test_plan(
        self, issue_key: str, issue_summary: str, issue_type: str, stories: list[dict]
    ) -> dict:
        """AI-generate a macro-level test plan for an Epic or Story using tool-use for valid JSON."""
        settings = get_settings()
        if not settings.anthropic_api_key:
            raise ValueError("Anthropic API key not configured")

        stories_text = "\n".join(
            f"  • {s.get('key','')}: {s.get('summary','')}" for s in stories[:25]
        )
        stories_section = ("Stories/Tasks in scope:\n" + stories_text) if stories_text else ""

        prompt = f"""You are a senior QA engineer creating a test plan document to present to R&D and Product.

Issue: {issue_key} ({issue_type})
Summary: {issue_summary}
{stories_section}

Call the generate_test_plan tool with a comprehensive, specific test plan for this feature.
Be concrete — each scenario must be actionable. For Performance, set applicable=false if not relevant."""

        tool_schema = {
            "name": "generate_test_plan",
            "description": "Output the structured QA test plan",
            "input_schema": {
                "type": "object",
                "required": ["executive_summary", "scope", "test_types", "test_flow", "coverage_areas", "risks", "estimated_test_cases"],
                "properties": {
                    "executive_summary": {"type": "string", "description": "2-3 sentence strategic overview"},
                    "scope": {
                        "type": "object",
                        "required": ["in_scope", "out_of_scope"],
                        "properties": {
                            "in_scope": {"type": "array", "items": {"type": "string"}},
                            "out_of_scope": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                    "test_types": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["type", "description", "scenarios"],
                            "properties": {
                                "type": {"type": "string"},
                                "description": {"type": "string"},
                                "applicable": {"type": "boolean"},
                                "scenarios": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                    "test_flow": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["step", "phase", "action", "validation"],
                            "properties": {
                                "step": {"type": "integer"},
                                "phase": {"type": "string"},
                                "action": {"type": "string"},
                                "validation": {"type": "string"},
                            },
                        },
                    },
                    "coverage_areas": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["area", "test_count_estimate", "priority", "tests"],
                            "properties": {
                                "area": {"type": "string"},
                                "test_count_estimate": {"type": "integer"},
                                "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                                "tests": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                    "risks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["risk", "mitigation"],
                            "properties": {
                                "risk": {"type": "string"},
                                "mitigation": {"type": "string"},
                            },
                        },
                    },
                    "estimated_test_cases": {"type": "integer"},
                },
            },
        }

        client = anthropic.AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            timeout=anthropic.Timeout(120.0, connect=10.0),
        )
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            tools=[tool_schema],
            tool_choice={"type": "tool", "name": "generate_test_plan"},
            messages=[{"role": "user", "content": prompt}],
        )
        for block in message.content:
            if block.type == "tool_use":
                return block.input
        raise ValueError("AI did not return tool output for test plan")

    # ── Handover Exit Criteria ─────────────────────────────────────────

    async def generate_handover_criteria(
        self, issue_key: str, issue_summary: str, issue_type: str, stories: list[dict]
    ) -> dict:
        """AI-generate handover meeting exit criteria using tool-use for valid JSON."""
        settings = get_settings()
        if not settings.anthropic_api_key:
            raise ValueError("Anthropic API key not configured")

        stories_text = "\n".join(
            f"  • {s.get('key','')}: {s.get('summary','')}" for s in stories[:20]
        )
        stories_section = ("Stories/Tasks:\n" + stories_text) if stories_text else ""

        prompt = f"""You are a QA Manager preparing a handover meeting with R&D.
The R&D team will demo this feature to you. Generate exit criteria — specific scenarios they MUST demonstrate.

Issue: {issue_key} ({issue_type})
Summary: {issue_summary}
{stories_section}

Call generate_handover_criteria with 4-7 criteria.
priority "must" = required for acceptance, "nice-to-have" = bonus.
Each step must be specific and actionable so R&D knows exactly what to demo."""

        tool_schema = {
            "name": "generate_handover_criteria",
            "description": "Output the structured handover exit criteria",
            "input_schema": {
                "type": "object",
                "required": ["intro", "criteria"],
                "properties": {
                    "intro": {"type": "string", "description": "Brief intro for the handover meeting"},
                    "criteria": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["id", "category", "title", "description", "steps", "priority"],
                            "properties": {
                                "id": {"type": "integer"},
                                "category": {"type": "string"},
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "steps": {"type": "array", "items": {"type": "string"}},
                                "priority": {"type": "string", "enum": ["must", "nice-to-have"]},
                            },
                        },
                    },
                },
            },
        }

        client = anthropic.AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            timeout=anthropic.Timeout(120.0, connect=10.0),
        )
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            tools=[tool_schema],
            tool_choice={"type": "tool", "name": "generate_handover_criteria"},
            messages=[{"role": "user", "content": prompt}],
        )
        for block in message.content:
            if block.type == "tool_use":
                return block.input
        raise ValueError("AI did not return tool output for handover criteria")

    # ── Jira Comment ───────────────────────────────────────────────────

    async def add_jira_comment(self, issue_key: str, comment_text: str) -> dict:
        """Add a plain-text comment to any Jira issue."""
        payload = {
            "body": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": line}],
                    }
                    for line in comment_text.split("\n")
                    if line.strip()
                ] or [{"type": "paragraph", "content": [{"type": "text", "text": comment_text}]}],
            }
        }
        result = await self.jira.post(f"/issue/{issue_key}/comment", json=payload)
        return {"ok": True, "comment_id": result.get("id", ""), "issue_key": issue_key}


_service: CoverageService | None = None

def get_coverage_service() -> CoverageService:
    global _service
    if _service is None:
        _service = CoverageService()
    return _service

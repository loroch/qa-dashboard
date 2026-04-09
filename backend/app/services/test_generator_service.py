"""
Test Case Generator Service.
Fetches Jira story + parent epic + Confluence context, then calls Claude
to generate structured test cases, and creates them in Jira.
"""
import asyncio
import base64
import json
import logging
import re
from typing import Optional

import anthropic
import httpx

from app.config import get_settings
from app.jira.client import get_jira_client

logger = logging.getLogger(__name__)

# File types we can handle
TEXT_TYPES = {"text/plain", "text/markdown", "text/csv", "application/json"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
ALLOWED_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp"}


class TestGeneratorService:

    def __init__(self):
        self.jira = get_jira_client()

    # ------------------------------------------------------------------
    # 1. Stories without tests
    # ------------------------------------------------------------------

    async def get_stories_without_tests(self, fix_version: str) -> list[dict]:
        """Return all Stories in the fix version that have no Test Case links."""
        jql = (
            f'fixVersion = "{fix_version}" AND issuetype = Story '
            f'ORDER BY key ASC'
        )
        issues = await self.jira.search_issues(
            jql,
            fields=[
                "summary", "status", "issuetype",
                "parent", "fixVersions", "issuelinks",
            ],
            max_results=200,
        )

        result = []
        for issue in issues:
            fields = issue.get("fields", {})
            links = fields.get("issuelinks") or []
            has_tests = any(
                "test" in (lnk.get("type", {}).get("name", "")).lower()
                for lnk in links
            )
            if not has_tests:
                parent = fields.get("parent") or {}
                parent_fields = parent.get("fields") or {}
                result.append({
                    "key": issue["key"],
                    "summary": fields.get("summary", ""),
                    "status": fields.get("status", {}).get("name", ""),
                    "parent_key": parent.get("key", ""),
                    "parent_summary": parent_fields.get("summary", ""),
                    "url": f"{get_settings().jira_base_url}/browse/{issue['key']}",
                })

        return result

    # ------------------------------------------------------------------
    # 1b. Fix versions
    # ------------------------------------------------------------------

    async def get_fix_versions(self) -> list[dict]:
        """Return all fix versions across all visible Jira projects, unreleased first."""
        data = await self.jira.get("/project/search", {"maxResults": 200})
        projects = data.get("values", []) if isinstance(data, dict) else data or []
        logger.info("get_fix_versions: found %d projects", len(projects))

        async def fetch_project_versions(project_key: str) -> list[dict]:
            try:
                result = await self.jira.get(f"/project/{project_key}/versions")
                return result if isinstance(result, list) else []
            except Exception as exc:
                logger.warning("Could not fetch versions for project %s: %s", project_key, exc)
                return []

        project_keys = [p.get("key") for p in projects if p.get("key")]
        all_results = await asyncio.gather(*[fetch_project_versions(k) for k in project_keys])

        versions: list[dict] = []
        seen: set[str] = set()

        for project_key, project_versions in zip(project_keys, all_results):
            for v in project_versions:
                name = v.get("name", "")
                if name and name not in seen:
                    seen.add(name)
                    versions.append({
                        "id": v.get("id"),
                        "name": name,
                        "released": v.get("released", False),
                        "archived": v.get("archived", False),
                        "project_key": project_key,
                    })

        logger.info("get_fix_versions: returning %d unique versions", len(versions))
        versions.sort(key=lambda v: (v["released"], v["name"]))
        return versions

    # ------------------------------------------------------------------
    # 2. Story context + AI summary (new Step 2)
    # ------------------------------------------------------------------

    async def get_story_context(self, story_key: str) -> dict:
        """Fetch story + epic + Confluence context and generate a simple AI summary."""
        settings = get_settings()

        # --- Story ---
        story = await self.jira.get_issue(
            story_key,
            fields=["summary", "description", "status", "parent", "fixVersions", "issuelinks"],
        )
        story_fields = story.get("fields", {})
        story_summary = story_fields.get("summary", "")
        story_description = self._extract_text(story_fields.get("description"))
        fix_versions = [v["name"] for v in (story_fields.get("fixVersions") or [])]
        story_status = story_fields.get("status", {}).get("name", "")

        sources_used = []
        sources_used.append({
            "type": "jira_story",
            "label": f"Jira Story: {story_key}",
            "title": story_summary,
            "preview": story_description[:400] if story_description else "(No description)",
            "has_content": bool(story_description),
            "url": f"{settings.jira_base_url}/browse/{story_key}",
        })

        # --- Parent Epic ---
        epic_details = None
        parent = story_fields.get("parent") or {}
        parent_key = parent.get("key", "")
        epic_context_for_prompt = ""
        if parent_key:
            try:
                epic = await self.jira.get_issue(parent_key, fields=["summary", "description"])
                epic_fields = epic.get("fields", {})
                epic_desc = self._extract_text(epic_fields.get("description"))
                epic_details = {
                    "key": parent_key,
                    "summary": epic_fields.get("summary", ""),
                    "description_preview": epic_desc[:400] if epic_desc else "(No description)",
                    "has_content": bool(epic_desc),
                    "url": f"{settings.jira_base_url}/browse/{parent_key}",
                }
                epic_context_for_prompt = (
                    f"Parent Epic {parent_key}: {epic_fields.get('summary', '')}\n{epic_desc}"
                )
                sources_used.append({
                    "type": "jira_epic",
                    "label": f"Parent Epic: {parent_key}",
                    "title": epic_fields.get("summary", ""),
                    "preview": epic_desc[:400] if epic_desc else "(No description)",
                    "has_content": bool(epic_desc),
                    "url": f"{settings.jira_base_url}/browse/{parent_key}",
                })
            except Exception as exc:
                logger.warning("Could not fetch epic %s: %s", parent_key, exc)

        # --- Confluence ---
        confluence_pages = []
        confluence_context_for_prompt = ""
        safe_query = re.sub(r'["\[\]]', '', story_summary)[:60]
        try:
            async with httpx.AsyncClient(
                auth=(settings.jira_user_email, settings.jira_api_token),
                timeout=20,
            ) as client:
                resp = await client.get(
                    f"{settings.jira_base_url}/wiki/rest/api/content/search",
                    params={
                        "cql": f'text ~ "{safe_query}" AND type = page',
                        "limit": 3,
                        "expand": "body.storage",
                    },
                )
                if resp.status_code == 200:
                    for page in (resp.json().get("results") or [])[:3]:
                        title = page.get("title", "")
                        raw_html = page.get("body", {}).get("storage", {}).get("value", "")
                        text = re.sub(r"<[^>]+>", " ", raw_html)
                        text = re.sub(r"\s+", " ", text).strip()
                        page_id = page.get("id", "")
                        space = page.get("space", {})
                        space_key = space.get("key", "")
                        page_url = (
                            f"{settings.jira_base_url}/wiki/spaces/{space_key}/pages/{page_id}"
                            if page_id else ""
                        )
                        confluence_pages.append({
                            "title": title,
                            "preview": text[:500],
                            "char_count": len(text),
                            "has_content": bool(text),
                            "url": page_url,
                        })
                        confluence_context_for_prompt += f"\n\nConfluence: {title}\n{text[:2000]}"
                        sources_used.append({
                            "type": "confluence",
                            "label": f"Confluence: {title}",
                            "title": title,
                            "preview": text[:400],
                            "has_content": bool(text),
                            "url": page_url,
                        })
        except Exception as exc:
            logger.warning("Confluence search failed: %s", exc)

        # --- AI Simple Summary ---
        ai_summary = ""
        if settings.anthropic_api_key:
            prompt_parts = [
                "You are a QA engineer reading a Jira story before writing test cases.",
                "Write a clear, simple explanation in plain English. Structure your answer in exactly 3 paragraphs:",
                "",
                "**Paragraph 1 — Story summary:** What is this story about? What should the user/system be able to do when it's done? Keep it simple and jargon-free.",
                "",
                "**Paragraph 2 — Epic context:** What is the bigger feature/epic this story belongs to? What is the overall goal of that epic?",
                "",
                "**Paragraph 3 — Story's role in the epic:** Which specific part or concept of the epic does this story implement? How does it contribute to the bigger picture?",
                "",
                "---",
                f"Story: {story_key} — {story_summary}",
                "",
                story_description or "(No description provided)",
            ]
            if epic_context_for_prompt:
                prompt_parts += ["", f"Epic: {epic_context_for_prompt[:1200]}"]
            else:
                prompt_parts += ["", "(No parent epic information available — skip Paragraph 2 and 3 if not applicable)"]

            try:
                client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
                message = await client.messages.create(
                    model="claude-sonnet-4-6",
                    max_tokens=800,
                    messages=[{"role": "user", "content": "\n".join(prompt_parts)}],
                )
                ai_summary = message.content[0].text.strip()
            except Exception as exc:
                logger.warning("AI summary generation failed: %s", exc)
                ai_summary = story_description[:400] if story_description else story_summary

        return {
            "story_key": story_key,
            "story_summary": story_summary,
            "story_status": story_status,
            "fix_versions": fix_versions,
            "ai_summary": ai_summary,
            "epic_details": epic_details,
            "confluence_pages": confluence_pages,
            "sources_used": sources_used,
        }

    # ------------------------------------------------------------------
    # 3. Process uploaded files → extracted text
    # ------------------------------------------------------------------

    async def process_files(self, files_data: list[dict]) -> tuple[str, list[dict]]:
        """
        Process uploaded files and return (combined_text, file_summaries).
        files_data: [{ name, content_type, data: bytes }]
        """
        settings = get_settings()
        parts = []
        summaries = []

        image_messages = []  # collect images for a single Claude vision call

        for f in files_data:
            name = f["name"]
            ctype = f.get("content_type", "")
            data: bytes = f["data"]

            # Text files
            if ctype in TEXT_TYPES or any(name.lower().endswith(ext) for ext in [".txt", ".md", ".csv", ".json"]):
                try:
                    text = data.decode("utf-8", errors="ignore").strip()
                    parts.append(f"### File: {name}\n{text[:3000]}")
                    summaries.append({"name": name, "type": "text", "chars": len(text), "ok": True})
                except Exception as exc:
                    summaries.append({"name": name, "type": "text", "ok": False, "error": str(exc)})

            # Images — collect for Claude vision
            elif ctype in IMAGE_TYPES or any(name.lower().endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".gif", ".webp"]):
                b64 = base64.standard_b64encode(data).decode("utf-8")
                media_type = ctype if ctype in IMAGE_TYPES else "image/png"
                image_messages.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": b64},
                })
                image_messages.append({
                    "type": "text",
                    "text": f"(Above image is: {name})",
                })
                summaries.append({"name": name, "type": "image", "ok": True})

            else:
                summaries.append({"name": name, "type": "unsupported", "ok": False, "error": "Unsupported file type"})

        # Describe images via Claude vision in one call
        if image_messages and settings.anthropic_api_key:
            try:
                client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
                image_messages.append({
                    "type": "text",
                    "text": (
                        "Describe the content of each image above in detail. "
                        "Focus on any UI flows, diagrams, requirements, or functional specifications visible. "
                        "This will be used as context for test case generation."
                    ),
                })
                message = await client.messages.create(
                    model="claude-sonnet-4-6",
                    max_tokens=2048,
                    messages=[{"role": "user", "content": image_messages}],
                )
                parts.append(f"### Image Content (extracted by AI)\n{message.content[0].text.strip()}")
            except Exception as exc:
                logger.warning("Image description failed: %s", exc)
                for s in summaries:
                    if s["type"] == "image":
                        s["ok"] = False
                        s["error"] = str(exc)

        combined = "\n\n".join(parts)
        return combined, summaries

    # ------------------------------------------------------------------
    # 4. Generate test cases (Jira + Confluence → Claude)
    # ------------------------------------------------------------------

    async def generate_test_cases(self, story_key: str, extra_context: str = "") -> dict:
        """Fetch context from Jira + Confluence, call Claude, return test cases."""
        settings = get_settings()

        # --- Story ---
        story = await self.jira.get_issue(
            story_key,
            fields=["summary", "description", "status", "parent", "fixVersions", "issuelinks"],
        )
        story_fields = story.get("fields", {})
        story_summary = story_fields.get("summary", "")
        story_description = self._extract_text(story_fields.get("description"))
        fix_versions = [v["name"] for v in (story_fields.get("fixVersions") or [])]

        # --- Parent Epic ---
        epic_context = ""
        parent = story_fields.get("parent") or {}
        parent_key = parent.get("key", "")
        if parent_key:
            try:
                epic = await self.jira.get_issue(parent_key, fields=["summary", "description"])
                epic_fields = epic.get("fields", {})
                epic_desc = self._extract_text(epic_fields.get("description"))
                epic_context = (
                    f"## Parent Epic: {parent_key} — {epic_fields.get('summary', '')}\n\n"
                    f"{epic_desc}"
                )
            except Exception as exc:
                logger.warning("Could not fetch epic %s: %s", parent_key, exc)

        # --- Confluence ---
        confluence_context = await self._search_confluence(story_summary)

        # --- Prompt → Claude ---
        prompt = self._build_prompt(
            story_key=story_key,
            story_summary=story_summary,
            story_description=story_description,
            epic_context=epic_context,
            confluence_context=confluence_context,
            extra_context=extra_context,
        )
        test_cases = await self._call_claude(prompt, settings.anthropic_api_key)

        return {
            "story_key": story_key,
            "story_summary": story_summary,
            "fix_versions": fix_versions,
            "parent_key": parent_key,
            "test_cases": test_cases,
        }

    # ------------------------------------------------------------------
    # 5. Create test cases in Jira
    # ------------------------------------------------------------------

    async def create_test_cases(
        self,
        story_key: str,
        test_cases: list[dict],
        fix_version: str,
        ai_summary: str = "",
    ) -> list[dict]:
        """Create Test issues in Jira and link them to the story."""
        settings = get_settings()
        project_key = story_key.split("-")[0]
        created = []

        for tc in test_cases:
            try:
                payload: dict = {
                    "fields": {
                        "project": {"key": project_key},
                        "summary": tc["summary"],
                        "issuetype": {"name": "Test"},
                        "description": self._to_adf(
                            description=tc.get("description", ""),
                            steps=tc.get("steps", []),
                            expected=tc.get("expected", ""),
                            source=tc.get("source", ""),
                        ),
                    }
                }
                if fix_version:
                    payload["fields"]["fixVersions"] = [{"name": fix_version}]

                result = await self.jira.post("/issue", payload)
                new_key = result.get("key")

                if new_key:
                    await self.jira.post("/issueLink", {
                        "type": {"name": "Test Case"},
                        "inwardIssue": {"key": new_key},
                        "outwardIssue": {"key": story_key},
                    })
                    # Add AI summary as a comment so testers understand the context
                    if ai_summary:
                        comment_text = (
                            f"📋 *Story Context & Testing Rationale*\n\n{ai_summary}\n\n"
                            f"_This comment was auto-generated by the QA Test Generator "
                            f"based on story {story_key} and its epic context._"
                        )
                        try:
                            await self.jira.post(f"/issue/{new_key}/comment", {
                                "body": self._to_adf_comment(comment_text)
                            })
                        except Exception as exc:
                            logger.warning("Could not add AI summary comment to %s: %s", new_key, exc)

                    created.append({
                        "key": new_key,
                        "summary": tc["summary"],
                        "url": f"{settings.jira_base_url}/browse/{new_key}",
                        "ok": True,
                    })
                else:
                    created.append({"key": None, "summary": tc["summary"], "ok": False, "error": "No key returned"})

            except Exception as exc:
                logger.error("Failed to create test '%s': %s", tc.get("summary"), exc)
                created.append({
                    "key": None,
                    "summary": tc.get("summary", ""),
                    "ok": False,
                    "error": str(exc),
                })

        return created

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _search_confluence(self, query: str) -> str:
        """Search Confluence for pages relevant to the story and return plain text."""
        settings = get_settings()
        safe_query = re.sub(r'["\[\]]', '', query)[:60]
        try:
            async with httpx.AsyncClient(
                auth=(settings.jira_user_email, settings.jira_api_token),
                timeout=20,
            ) as client:
                resp = await client.get(
                    f"{settings.jira_base_url}/wiki/rest/api/content/search",
                    params={
                        "cql": f'text ~ "{safe_query}" AND type = page',
                        "limit": 3,
                        "expand": "body.storage",
                    },
                )
                if resp.status_code != 200:
                    return ""

                parts = []
                for page in (resp.json().get("results") or [])[:2]:
                    title = page.get("title", "")
                    raw_html = page.get("body", {}).get("storage", {}).get("value", "")
                    text = re.sub(r"<[^>]+>", " ", raw_html)
                    text = re.sub(r"\s+", " ", text).strip()[:2500]
                    parts.append(f"### Confluence page: {title}\n{text}")

                return "\n\n".join(parts)

        except Exception as exc:
            logger.warning("Confluence search failed: %s", exc)
            return ""

    def _build_prompt(
        self,
        story_key: str,
        story_summary: str,
        story_description: str,
        epic_context: str,
        confluence_context: str,
        extra_context: str = "",
    ) -> str:
        lines = [
            "You are a senior QA engineer. Generate comprehensive test cases for the user story below.",
            "",
            f"## Story: {story_key} — {story_summary}",
            "",
            story_description or "(No description provided)",
        ]
        if epic_context:
            lines += ["", epic_context]
        if confluence_context:
            lines += ["", "## Relevant Confluence Documentation", confluence_context]
        if extra_context:
            lines += ["", "## Additional Context (from uploaded files)", extra_context]

        lines += [
            "",
            "## Instructions",
            "Generate 8–15 test cases that together give full story coverage.",
            "Include:",
            "  - All acceptance criteria / functional requirements (positive paths)",
            "  - At least 3–5 negative / edge-case scenarios",
            "  - Permission / access-control checks where relevant",
            "  - Performance or SLA criteria where explicitly stated",
            "",
            "For EACH test case output a JSON object with exactly these fields:",
            '  "summary"     : concise test case title (prefix TC-N:)',
            '  "description" : one sentence — what is being tested',
            '  "steps"       : array of step strings (plain text)',
            '  "expected"    : single string — the expected result',
            '  "source"      : quote the exact requirement, AC, or FR this covers',
            "",
            "Return ONLY a valid JSON array. No markdown fences, no explanation.",
        ]
        return "\n".join(lines)

    async def _call_claude(self, prompt: str, api_key: str) -> list[dict]:
        """Call Claude asynchronously and parse the JSON array response."""
        if not api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY is not set. Add it to your .env file."
            )

        client = anthropic.AsyncAnthropic(api_key=api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=8096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text.strip()

        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            raw = match.group(0)

        return json.loads(raw)

    def _extract_text(self, adf: Optional[dict]) -> str:
        """Recursively extract plain text from Atlassian Document Format."""
        if not adf:
            return ""
        if isinstance(adf, str):
            return adf
        texts: list[str] = []

        def walk(node):
            if isinstance(node, dict):
                if node.get("type") == "text":
                    texts.append(node.get("text", ""))
                for child in node.get("content") or []:
                    walk(child)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(adf)
        return " ".join(t for t in texts if t).strip()

    def _to_adf_comment(self, text: str) -> dict:
        """Build a simple ADF doc from plain text (supports *bold* and newlines)."""
        nodes = []
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            # Parse *italic* markers (Jira wiki style kept as plain text in ADF)
            nodes.append({"type": "paragraph", "content": [{"type": "text", "text": line}]})
        if not nodes:
            nodes = [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
        return {"version": 1, "type": "doc", "content": nodes}

    def _to_adf(
        self,
        description: str,
        steps: list[str],
        expected: str,
        source: str,
    ) -> dict:
        """Build an ADF document from test case fields."""

        def para(text: str, bold: bool = False) -> dict:
            content = {"type": "text", "text": text}
            if bold:
                content["marks"] = [{"type": "strong"}]
            return {"type": "paragraph", "content": [content]}

        nodes = []
        if description:
            nodes.append(para(description))
        if steps:
            nodes.append(para("Steps:", bold=True))
            for i, step in enumerate(steps, 1):
                nodes.append(para(f"{i}. {step}"))
        if expected:
            nodes.append(para("Expected Result:", bold=True))
            nodes.append(para(expected))
        if source:
            nodes.append(para("Source:", bold=True))
            nodes.append(para(source))

        if not nodes:
            nodes = [para("(No content)")]

        return {"version": 1, "type": "doc", "content": nodes}


# --- Singleton ---
_service: Optional[TestGeneratorService] = None


def get_test_generator_service() -> TestGeneratorService:
    global _service
    if _service is None:
        _service = TestGeneratorService()
    return _service

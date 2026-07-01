"""
Bug Reporter Service.

Orchestrates the full bug-creation workflow:
  1. Load product list (epics) + Jira metadata
  2. Fetch existing bugs for a product/epic, summarize them with Claude
     so the AI understands "what bugs already exist here"
  3. Accept user description + uploaded files (logs / screenshots)
  4. Generate a complete Jira bug template via Claude
  5. Persist drafts to SQLite and create the final Jira issue
"""
import asyncio
import base64
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

import anthropic

from app.config import get_settings
from app.database.db import BugDraftORM, BugHistoryORM, get_session_factory
from app.jira.client import get_jira_client
from sqlalchemy import select, update

logger = logging.getLogger(__name__)

TEXT_TYPES = {"text/plain", "text/markdown", "text/csv", "application/json", "text/log"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
ALLOWED_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".log", ".png", ".jpg", ".jpeg", ".gif", ".webp"}

SEVERITY_OPTIONS = ["Critical", "Highest", "High", "Medium", "Low"]


class BugReporterService:

    def __init__(self):
        self.jira = get_jira_client()
        self.settings = get_settings()

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    async def get_meta(self) -> dict:
        versions_task   = self._get_versions()
        epics_task      = self._get_epics()
        sprints_task    = self._get_active_sprints()
        priorities_task = self._get_priorities()
        envs_task       = self._get_environments()

        versions, epics, sprints, priorities, environments = await asyncio.gather(
            versions_task, epics_task, sprints_task, priorities_task, envs_task,
            return_exceptions=True,
        )

        def safe(r, default):
            return r if not isinstance(r, Exception) else default

        v = safe(versions, [])
        return {
            "fix_versions":       v,
            "found_in_versions":  v,
            "epics":              safe(epics, []),
            "sprints":            safe(sprints, []),
            "priorities":         safe(priorities, []),
            "severities":         SEVERITY_OPTIONS,
            "environments":       safe(environments, []),
        }

    async def _get_versions(self) -> list[dict]:
        data = await self.jira.get("/project/TMT0/versions")
        versions = [
            {"id": v["id"], "name": v["name"]}
            for v in data
            if not v.get("archived", False)
        ]
        versions.sort(key=lambda v: v["name"], reverse=True)
        return versions

    async def _get_epics(self) -> list[dict]:
        issues = await self.jira.search_issues(
            "project = TMT0 AND issuetype = Epic AND created >= -365d ORDER BY created DESC",
            fields=["summary", "status", "customfield_10011"],
            max_total=2000,
        )
        return [
            {
                "key":  i["key"],
                "name": (i.get("fields") or {}).get("customfield_10011")
                        or (i.get("fields") or {}).get("summary", i["key"]),
                "status": ((i.get("fields") or {}).get("status") or {}).get("name", ""),
            }
            for i in issues
        ]

    _board_id: int | None = None

    async def _get_active_sprints(self) -> list[dict]:
        try:
            if BugReporterService._board_id is None:
                board_data = await self.jira.agile_get("/board", {"projectKeyOrId": "TMT0", "type": "scrum", "maxResults": 10})
                boards = board_data.get("values", [])
                if not boards:
                    return []
                BugReporterService._board_id = boards[0]["id"]
            sprint_data = await self.jira.agile_get(
                f"/board/{BugReporterService._board_id}/sprint",
                {"state": "active,future", "maxResults": 20},
            )
            return [
                {"id": s["id"], "name": s["name"], "state": s.get("state", "")}
                for s in sprint_data.get("values", [])
                if s.get("state") in ("active", "future")
            ]
        except Exception as e:
            logger.warning("Could not fetch sprints: %s", e)
            return []

    async def _get_priorities(self) -> list[dict]:
        data = await self.jira.get("/priority")
        return [{"id": p["id"], "name": p["name"]} for p in data]

    async def _get_environments(self) -> list[str]:
        # Standard environment labels for TMT0
        return ["Production", "Staging", "Development", "QA", "Demo"]

    # ------------------------------------------------------------------
    # Product context — learn from existing bugs in this epic
    # ------------------------------------------------------------------

    async def get_product_context(self, epic_key: str) -> dict:
        """
        Fetch recent bugs under the given epic, summarise them with Claude.
        Returns a dict with ai_summary and a list of bugs found.
        """
        bugs = await self.jira.search_issues(
            f'project = TMT0 AND issuetype = Bug AND parent = "{epic_key}" ORDER BY created DESC',
            fields=["summary", "status", "description", "priority", "customfield_10597",
                    "customfield_10409", "customfield_10598", "customfield_10599"],
            max_total=50,
        )
        # Also fetch stories to give AI more context about the product area
        stories = await self.jira.search_issues(
            f'project = TMT0 AND issuetype in (Story, Task) AND parent = "{epic_key}" ORDER BY created DESC',
            fields=["summary", "status", "description"],
            max_total=20,
        )

        bug_summaries = []
        for b in bugs:
            f = b.get("fields") or {}
            bug_summaries.append({
                "key":     b["key"],
                "summary": f.get("summary", ""),
                "status":  (f.get("status") or {}).get("name", ""),
                "severity": ((f.get("customfield_10597") or {}).get("value") if f.get("customfield_10597") else None) or "",
                "url": f"{self.settings.jira_base_url}/browse/{b['key']}",
            })

        story_summaries = [
            {"key": s["key"], "summary": (s.get("fields") or {}).get("summary", "")}
            for s in stories
        ]

        ai_summary = await self._summarize_product_context(epic_key, bug_summaries, story_summaries)

        return {
            "epic_key":    epic_key,
            "bugs_found":  len(bug_summaries),
            "bugs":        bug_summaries[:20],
            "stories":     story_summaries[:10],
            "ai_summary":  ai_summary,
        }

    async def _summarize_product_context(
        self,
        epic_key: str,
        bugs: list[dict],
        stories: list[dict],
    ) -> str:
        if not self.settings.anthropic_api_key:
            return ""

        bugs_text = "\n".join(
            f"- [{b['key']}] {b['summary']} (Status: {b['status']}, Severity: {b['severity']})"
            for b in bugs
        ) or "(none)"
        stories_text = "\n".join(
            f"- [{s['key']}] {s['summary']}"
            for s in stories
        ) or "(none)"

        prompt = (
            f"You are a QA lead reviewing the Jira epic {epic_key}.\n\n"
            f"EXISTING BUGS:\n{bugs_text}\n\n"
            f"RELATED STORIES/TASKS:\n{stories_text}\n\n"
            "Write a brief 3-5 sentence summary of:\n"
            "1. What product/feature area this epic covers\n"
            "2. Common bug patterns or categories in this area\n"
            "3. What quality risks exist\n"
            "Keep it under 120 words. Be concrete, not generic."
        )

        client = anthropic.AsyncAnthropic(api_key=self.settings.anthropic_api_key)
        msg = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()

    # ------------------------------------------------------------------
    # File processing (logs + screenshots)
    # ------------------------------------------------------------------

    async def process_files(self, files_data: list[dict]) -> tuple[str, list[dict]]:
        """
        Process uploaded files. Returns (combined_extracted_text, per_file_summaries).
        Image files are described via Claude vision; text files are extracted directly.
        """
        if not files_data:
            return "", []

        parts: list[str] = []
        summaries: list[dict] = []

        for f in files_data:
            name = f["name"]
            ctype = f.get("content_type", "").lower()
            data = f["data"]
            ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""

            is_image = ctype in IMAGE_TYPES or ext in {".png", ".jpg", ".jpeg", ".gif", ".webp"}

            try:
                if is_image:
                    description = await self._describe_image(name, ctype or "image/png", data)
                    parts.append(f"[Screenshot: {name}]\n{description}")
                    summaries.append({"name": name, "type": "image", "ok": True, "chars": len(description)})
                else:
                    text = data.decode("utf-8", errors="replace")
                    text = text[:8000]  # cap per file
                    parts.append(f"[File: {name}]\n{text}")
                    summaries.append({"name": name, "type": "text", "ok": True, "chars": len(text)})
            except Exception as e:
                logger.warning("Could not process file %s: %s", name, e)
                summaries.append({"name": name, "type": "unknown", "ok": False, "error": str(e)})

        return "\n\n---\n\n".join(parts), summaries

    async def _describe_image(self, name: str, ctype: str, data: bytes) -> str:
        if not self.settings.anthropic_api_key:
            return f"(Image: {name} — AI description unavailable)"

        b64 = base64.standard_b64encode(data).decode()
        media_type = ctype if ctype in IMAGE_TYPES else "image/png"

        client = anthropic.AsyncAnthropic(api_key=self.settings.anthropic_api_key)
        msg = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": (
                        "This is a screenshot or log image for a bug report. "
                        "Describe what you see in 2-4 sentences focusing on any errors, "
                        "UI problems, or unexpected behavior visible."
                    )},
                ],
            }],
        )
        return msg.content[0].text.strip()

    # ------------------------------------------------------------------
    # Generate bug template
    # ------------------------------------------------------------------

    async def generate_bug_template(
        self,
        epic_key: str,
        product_name: str,
        description: str,
        extra_context: str,
        context_summary: str,
    ) -> dict:
        """
        Call Claude to generate a full Jira bug template from user description + context.
        Returns a dict with all bug fields pre-filled.
        """
        if not self.settings.anthropic_api_key:
            raise ValueError("Anthropic API key not configured")

        prompt = (
            "You are a senior QA engineer writing a Jira bug report.\n\n"
            f"PRODUCT AREA: {product_name} (Epic: {epic_key})\n\n"
            f"EXISTING BUG PATTERNS (learned from Jira):\n{context_summary or '(none available)'}\n\n"
            f"BUG DESCRIPTION PROVIDED BY REPORTER:\n{description or '(none)'}\n\n"
            + (f"ADDITIONAL CONTEXT (logs/screenshots):\n{extra_context}\n\n" if extra_context else "")
            + "Generate a complete Jira bug report. Return ONLY valid JSON with exactly these keys:\n"
            "{\n"
            '  "summary": "short one-line bug title (max 100 chars)",\n'
            '  "description": "clear description of the bug (2-4 sentences)",\n'
            '  "steps_to_reproduce": "numbered steps to reproduce",\n'
            '  "actual_result": "what actually happens",\n'
            '  "expected_result": "what should happen",\n'
            '  "severity": "one of: Critical, Highest, High, Medium, Low",\n'
            '  "priority": "one of: Highest, High, Medium, Low, Lowest",\n'
            '  "suggested_labels": ["label1", "label2"],\n'
            '  "environments": ["Production"],\n'
            '  "ai_confidence": "brief note on how confident the AI is and what info would improve the report"\n'
            "}"
        )

        client = anthropic.AsyncAnthropic(api_key=self.settings.anthropic_api_key)
        msg = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        match = re.search(r'\{.*\}', text, re.DOTALL)
        result = json.loads(match.group() if match else text)

        # Ensure all expected keys exist
        defaults = {
            "summary": "", "description": "", "steps_to_reproduce": "",
            "actual_result": "", "expected_result": "",
            "severity": "Medium", "priority": "Medium",
            "suggested_labels": [], "environments": ["Production"],
            "ai_confidence": "",
        }
        for k, v in defaults.items():
            result.setdefault(k, v)

        return result

    # ------------------------------------------------------------------
    # Draft CRUD
    # ------------------------------------------------------------------

    async def save_draft(self, data: dict) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            draft = BugDraftORM(
                product_name=data.get("product_name", ""),
                epic_key=data.get("epic_key"),
                summary=data.get("summary"),
                description=data.get("description"),
                steps_to_reproduce=data.get("steps_to_reproduce"),
                actual_result=data.get("actual_result"),
                expected_result=data.get("expected_result"),
                severity=data.get("severity"),
                priority=data.get("priority"),
                environments=json.dumps(data.get("environments") or []),
                fix_version_id=data.get("fix_version_id"),
                fix_version_name=data.get("fix_version_name"),
                found_in_version_id=data.get("found_in_version_id"),
                found_in_version_name=data.get("found_in_version_name"),
                sprint_id=data.get("sprint_id"),
                status="draft",
                context_summary=data.get("context_summary"),
            )
            session.add(draft)
            await session.commit()
            await session.refresh(draft)
            return self._draft_to_dict(draft)

    async def get_drafts(self) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(BugDraftORM).order_by(BugDraftORM.updated_at.desc()).limit(50)
            )
            return [self._draft_to_dict(d) for d in result.scalars().all()]

    async def delete_draft(self, draft_id: int) -> bool:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(select(BugDraftORM).where(BugDraftORM.id == draft_id))
            draft = result.scalar_one_or_none()
            if not draft:
                return False
            await session.delete(draft)
            await session.commit()
            return True

    def _draft_to_dict(self, d: BugDraftORM) -> dict:
        return {
            "id":                   d.id,
            "product_name":         d.product_name,
            "epic_key":             d.epic_key,
            "summary":              d.summary,
            "description":          d.description,
            "steps_to_reproduce":   d.steps_to_reproduce,
            "actual_result":        d.actual_result,
            "expected_result":      d.expected_result,
            "severity":             d.severity,
            "priority":             d.priority,
            "environments":         json.loads(d.environments or "[]"),
            "fix_version_id":       d.fix_version_id,
            "fix_version_name":     d.fix_version_name,
            "found_in_version_id":  d.found_in_version_id,
            "found_in_version_name": d.found_in_version_name,
            "sprint_id":            d.sprint_id,
            "status":               d.status,
            "jira_key":             d.jira_key,
            "jira_url":             d.jira_url,
            "context_summary":      d.context_summary,
            "created_at":           d.created_at.isoformat() if d.created_at else None,
            "updated_at":           d.updated_at.isoformat() if d.updated_at else None,
        }

    # ------------------------------------------------------------------
    # Create Jira bug from confirmed template
    # ------------------------------------------------------------------

    async def create_jira_bug(self, data: dict) -> dict:
        """
        Create a Jira bug from the confirmed template data.
        Saves result to bug_history and marks draft as submitted.
        """
        summary             = data.get("summary", "")
        description_text    = data.get("description", "")
        steps               = data.get("steps_to_reproduce", "")
        actual              = data.get("actual_result", "")
        expected            = data.get("expected_result", "")
        severity            = data.get("severity", "Medium")
        priority_name       = data.get("priority", "Medium")
        environments        = data.get("environments") or []
        epic_key            = data.get("epic_key")
        fix_version_id      = data.get("fix_version_id")
        fix_version_name    = data.get("fix_version_name")
        found_in_version_id = data.get("found_in_version_id")
        sprint_id           = data.get("sprint_id")
        draft_id            = data.get("draft_id")
        product_name        = data.get("product_name", "")

        fields: dict = {
            "project":             {"key": "TMT0"},
            "issuetype":           {"name": "Bug"},
            "summary":             summary,
            "description":         self._build_adf(description_text),
            "customfield_10409":   self._plain_adf(steps or " "),
            "customfield_10598":   self._plain_adf(actual or " "),
            "customfield_10599":   self._plain_adf(expected or " "),
            "customfield_10597":   {"value": severity or "Medium"},
            "customfield_10600":   environments or [],
        }

        if found_in_version_id:
            fields["customfield_10601"] = [{"id": found_in_version_id}]
        if epic_key:
            fields["parent"] = {"key": epic_key}
        if fix_version_id:
            fields["fixVersions"] = [{"id": fix_version_id}]
        elif fix_version_name:
            fields["fixVersions"] = [{"name": fix_version_name}]
        if priority_name:
            fields["priority"] = {"name": priority_name}
        if sprint_id:
            fields["customfield_10020"] = {"id": sprint_id}

        logger.info("Creating Jira bug via Bug Reporter: %s", summary[:60])
        created = await self.jira.post("/issue", {"fields": fields})
        issue_key = created.get("key")
        issue_url = f"{self.settings.jira_base_url}/browse/{issue_key}"

        # Save to history
        await self._save_history(
            jira_key=issue_key,
            jira_url=issue_url,
            summary=summary,
            product_name=product_name,
            epic_key=epic_key,
            severity=severity,
            priority=priority_name,
            fix_version_name=fix_version_name,
            draft_id=draft_id,
        )

        # Mark draft as submitted
        if draft_id:
            await self._mark_draft_submitted(draft_id, issue_key, issue_url)

        return {
            "key":         issue_key,
            "url":         issue_url,
            "id":          created.get("id"),
            "product_name": product_name,
            "epic_key":    epic_key,
        }

    async def _save_history(self, **kwargs) -> None:
        factory = get_session_factory()
        async with factory() as session:
            entry = BugHistoryORM(**kwargs)
            session.add(entry)
            await session.commit()

    async def _mark_draft_submitted(self, draft_id: int, jira_key: str, jira_url: str) -> None:
        factory = get_session_factory()
        async with factory() as session:
            await session.execute(
                update(BugDraftORM)
                .where(BugDraftORM.id == draft_id)
                .values(status="submitted", jira_key=jira_key, jira_url=jira_url,
                        updated_at=datetime.now(timezone.utc))
            )
            await session.commit()

    async def get_history(self, limit: int = 50) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            result = await session.execute(
                select(BugHistoryORM).order_by(BugHistoryORM.created_at.desc()).limit(limit)
            )
            return [
                {
                    "id":              h.id,
                    "jira_key":        h.jira_key,
                    "jira_url":        h.jira_url,
                    "summary":         h.summary,
                    "product_name":    h.product_name,
                    "epic_key":        h.epic_key,
                    "severity":        h.severity,
                    "priority":        h.priority,
                    "fix_version_name": h.fix_version_name,
                    "draft_id":        h.draft_id,
                    "created_at":      h.created_at.isoformat() if h.created_at else None,
                }
                for h in result.scalars().all()
            ]

    # ------------------------------------------------------------------
    # ADF helpers
    # ------------------------------------------------------------------

    def _plain_adf(self, text: str) -> dict:
        return {
            "version": 1, "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": text.strip() or " "}]}],
        }

    def _build_adf(self, description: str) -> dict:
        def paragraph(text: str) -> dict:
            if not text or not text.strip():
                return {"type": "paragraph", "content": []}
            return {"type": "paragraph", "content": [{"type": "text", "text": text.strip()}]}

        content = []
        if description and description.strip():
            for para in description.split("\n\n"):
                content.append(paragraph(para))

        if not content:
            content.append(paragraph("No description provided."))
        return {"version": 1, "type": "doc", "content": content}


# Singleton
_service: BugReporterService | None = None


def get_bug_reporter_service() -> BugReporterService:
    global _service
    if _service is None:
        _service = BugReporterService()
    return _service

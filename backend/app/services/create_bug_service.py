"""
Service for creating Jira bugs from Zoho Desk tickets.

Required TMT0 Bug fields (from /issue/createmeta):
  customfield_10409 — Reproduction Steps  (ADF)
  customfield_10597 — Severity            (option: Critical/Highest/High/Medium/Low)
  customfield_10598 — Actual Result       (ADF)
  customfield_10599 — Expected Result     (ADF)
  customfield_10600 — Environments        (array of strings / labels)
  customfield_10601 — Found In Version    (array of version objects {id})
  customfield_10434 — Zoho Desk Ticket    (plain string URL)

After creation:
  - Extract numeric part of Jira key (e.g. TMT0-41143 → 41143)
  - Write back to Zoho ticket's cf_bug_id field via PATCH
"""
import html
import json
import logging
import os
import re
import tempfile
from typing import Optional

import anthropic

from app.jira.client import get_jira_client
from app.zoho.client import get_zoho_client
from app.config import get_settings

logger = logging.getLogger(__name__)

TMT0_BOARD_ID = None  # auto-discovered on first call


def _strip_html(text: str) -> str:
    if not text:
        return ""
    text = html.unescape(text)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</(div|p|li|tr|td|th|h[1-6])>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

SEVERITY_OPTIONS = ["Critical", "Highest", "High", "Medium", "Low"]

# Zoho priority → (Jira severity, Jira priority)
PRIORITY_MAP = {
    "urgent":   ("Critical", "Highest"),
    "high":     ("High",     "High"),
    "medium":   ("Medium",   "Medium"),
    "low":      ("Low",      "Low"),
    "lowest":   ("Low",      "Lowest"),
}


def map_zoho_priority(zoho_priority: str) -> tuple[str, str]:
    """Return (severity, priority_name) from a Zoho priority string."""
    key = (zoho_priority or "").strip().lower()
    return PRIORITY_MAP.get(key, ("Medium", "Medium"))


class CreateBugService:

    def __init__(self):
        self.jira = get_jira_client()
        self.zoho = get_zoho_client()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    # ------------------------------------------------------------------
    # Metadata (dropdowns for the form)
    # ------------------------------------------------------------------

    async def get_meta(self) -> dict:
        import asyncio

        fix_versions_task = self._get_fix_versions()
        epics_task        = self._get_epics()
        sprints_task      = self._get_active_sprints()
        priorities_task   = self._get_priorities()
        assignees_task    = self._get_assignable_users()

        fix_versions, epics, sprints, priorities, assignees = await asyncio.gather(
            fix_versions_task, epics_task, sprints_task, priorities_task, assignees_task,
            return_exceptions=True,
        )

        def safe(result, default):
            return result if not isinstance(result, Exception) else default

        versions = safe(fix_versions, [])
        return {
            "fix_versions":      versions,
            "found_in_versions": versions,
            "epics":             safe(epics, []),
            "sprints":           safe(sprints, []),
            "priorities":        safe(priorities, []),
            "assignees":         safe(assignees, []),
            "severities":        SEVERITY_OPTIONS,
        }

    async def _get_assignable_users(self) -> list[dict]:
        try:
            data = await self.jira.get("/user/assignable/search", params={"project": "TMT0", "maxResults": 50})
            return [
                {"id": u.get("accountId"), "name": u.get("displayName"), "email": u.get("emailAddress", "")}
                for u in (data if isinstance(data, list) else [])
                if u.get("accountId") and u.get("displayName")
            ]
        except Exception as e:
            logger.warning(f"Could not fetch assignable users: {e}")
            return []

    async def _get_fix_versions(self) -> list[dict]:
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
            'project = TMT0 AND issuetype = Epic AND created >= -365d ORDER BY created DESC',
            fields=["summary", "status", "customfield_10011"],
            max_total=2000,
        )
        return [
            {
                "key":  i["key"],
                "name": (i.get("fields") or {}).get("customfield_10011")
                        or (i.get("fields") or {}).get("summary", i["key"]),
            }
            for i in issues
        ]

    async def _get_active_sprints(self) -> list[dict]:
        global TMT0_BOARD_ID
        try:
            if TMT0_BOARD_ID is None:
                board_data = await self.jira.agile_get("/board", {"projectKeyOrId": "TMT0", "type": "scrum", "maxResults": 10})
                boards = board_data.get("values", [])
                if boards:
                    TMT0_BOARD_ID = boards[0]["id"]
                else:
                    return []
            sprint_data = await self.jira.agile_get(
                f"/board/{TMT0_BOARD_ID}/sprint",
                {"state": "active,future", "maxResults": 20},
            )
            return [
                {"id": s["id"], "name": s["name"], "state": s.get("state", "")}
                for s in sprint_data.get("values", [])
                if s.get("state") in ("active", "future")
            ]
        except Exception as e:
            logger.warning(f"Could not fetch sprints: {e}")
            return []

    async def _get_priorities(self) -> list[dict]:
        data = await self.jira.get("/priority")
        return [{"id": p["id"], "name": p["name"]} for p in data]

    # ------------------------------------------------------------------
    # Zoho ticket detail (description + attachments)
    # ------------------------------------------------------------------

    async def get_zoho_ticket_detail(self, ticket_id: str) -> dict:
        raw = await self.zoho.get(f"/api/v1/tickets/{ticket_id}", include_org=True)
        description = _strip_html(raw.get("description") or raw.get("subject") or "")

        attachments = []
        try:
            att_data = await self.zoho.get(
                f"/api/v1/tickets/{ticket_id}/attachments",
                include_org=True,
            )
            for att in att_data.get("data", []):
                attachments.append({
                    "id":           att.get("id"),
                    "name":         att.get("name") or att.get("fileName", "attachment"),
                    "size":         att.get("size", 0),
                    "content_type": att.get("contentType") or "application/octet-stream",
                    "href":         att.get("href") or att.get("downloadUrl") or "",
                })
        except Exception as e:
            logger.warning(f"Could not fetch attachments for ticket {ticket_id}: {e}")

        zoho_priority = raw.get("priority") or ""
        severity, jira_priority = map_zoho_priority(zoho_priority)

        return {
            "id":                raw.get("id"),
            "ticket_number":     raw.get("ticketNumber"),
            "subject":           raw.get("subject", ""),
            "description":       description,
            "status":            raw.get("status", ""),
            "priority":          zoho_priority,
            "suggested_severity": severity,
            "suggested_priority": jira_priority,
            "url":               raw.get("webUrl", ""),
            "attachments":       attachments,
        }

    # ------------------------------------------------------------------
    # Create Jira bug
    # ------------------------------------------------------------------

    async def create_jira_bug(
        self,
        zoho_ticket_id: str,
        zoho_ticket_url: str,
        zoho_ticket_number: str,
        summary: str,
        description: str,
        steps_to_reproduce: str,
        actual_result: str,
        expected_result: str,
        severity: str,
        environments: list[str],
        found_in_version_id: Optional[str],
        epic_key: Optional[str],
        fix_version_id: Optional[str],
        fix_version_name: Optional[str],
        priority_name: Optional[str],
        sprint_id: Optional[int],
        attachment_ids: list[str],
    ) -> dict:
        adf = self._build_adf(description=description, zoho_url=zoho_ticket_url)

        fields: dict = {
            "project":   {"key": "TMT0"},
            "issuetype": {"name": "Bug"},
            "summary":   summary,
            "description": adf,
            # Required rich-text custom fields (need ADF)
            "customfield_10409": self._plain_adf(steps_to_reproduce or " "),
            "customfield_10598": self._plain_adf(actual_result or " "),
            "customfield_10599": self._plain_adf(expected_result or " "),
            # Other required fields
            "customfield_10597": {"value": severity or "Medium"},   # Severity
            "customfield_10600": environments or [],                 # Environments (labels)
            # Zoho Desk Ticket link — clickable hyperlink in Jira
            "customfield_10434": self._link_adf(f"#{zoho_ticket_number}", zoho_ticket_url),
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

        logger.info(f"Creating Jira bug for Zoho ticket {zoho_ticket_id}: {summary[:60]}")
        created = await self.jira.post("/issue", {"fields": fields})
        issue_key = created.get("key")           # e.g. TMT0-41143
        issue_url = f"{self.jira_base_url}/browse/{issue_key}"

        # Extract numeric part (e.g. "41143")
        bug_number = issue_key.split("-")[-1] if issue_key and "-" in issue_key else issue_key

        # Transfer selected attachments (download → temp file → Jira → delete)
        if attachment_ids and issue_key:
            await self._transfer_attachments(zoho_ticket_id, issue_key, attachment_ids)

        # Write bug number back to Zoho
        if bug_number and zoho_ticket_id:
            await self._write_bug_id_to_zoho(zoho_ticket_id, bug_number)

        return {
            "key":        issue_key,
            "url":        issue_url,
            "id":         created.get("id"),
            "bug_number": bug_number,
        }

    # ------------------------------------------------------------------
    # Write Jira bug number back to Zoho ticket
    # ------------------------------------------------------------------

    async def _write_bug_id_to_zoho(self, zoho_ticket_id: str, bug_number: str) -> None:
        try:
            await self.zoho.patch(
                f"/api/v1/tickets/{zoho_ticket_id}",
                json={"cf": {"cf_bug_id": bug_number}},
                include_org=True,
            )
            logger.info(f"Wrote bug_id={bug_number} to Zoho ticket {zoho_ticket_id}")
        except Exception as e:
            logger.warning(f"Could not write bug ID back to Zoho ticket {zoho_ticket_id}: {e}")

    # ------------------------------------------------------------------
    # ADF helpers
    # ------------------------------------------------------------------

    def _link_adf(self, label: str, url: str) -> dict:
        """ADF document with a single clickable hyperlink."""
        return {
            "version": 1,
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "text",
                    "text": label,
                    "marks": [{"type": "link", "attrs": {"href": url}}],
                }],
            }],
        }

    def _plain_adf(self, text: str) -> dict:
        """Wrap plain text in a minimal ADF document (single paragraph)."""
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

    def _build_adf(self, description: str, zoho_url: str) -> dict:
        """Build Atlassian Document Format body (description + Zoho link)."""

        def heading(text: str, level: int = 3) -> dict:
            return {
                "type": "heading",
                "attrs": {"level": level},
                "content": [{"type": "text", "text": text}],
            }

        def paragraph(text: str) -> dict:
            if not text or not text.strip():
                return {"type": "paragraph", "content": []}
            return {
                "type": "paragraph",
                "content": [{"type": "text", "text": text.strip()}],
            }

        def link_paragraph(label: str, url: str) -> dict:
            return {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": f"{label}: "},
                    {
                        "type": "text",
                        "text": url,
                        "marks": [{"type": "link", "attrs": {"href": url}}],
                    },
                ],
            }

        content = []
        if description and description.strip():
            content.append(heading("Description"))
            content.append(paragraph(description))

        if zoho_url:
            content.append(heading("Zoho Ticket"))
            content.append(link_paragraph("Source", zoho_url))

        if not content:
            content.append(paragraph("No description provided."))

        return {"version": 1, "type": "doc", "content": content}

    # ------------------------------------------------------------------
    # Attachment transfer (temp file → Jira → delete)
    # ------------------------------------------------------------------

    async def _transfer_attachments(
        self,
        zoho_ticket_id: str,
        jira_issue_key: str,
        attachment_ids: list[str],
    ) -> None:
        import httpx

        try:
            att_data = await self.zoho.get(
                f"/api/v1/tickets/{zoho_ticket_id}/attachments",
                include_org=True,
            )
            attachments = att_data.get("data", [])
        except Exception as e:
            logger.warning(f"Could not fetch attachment list: {e}")
            return

        selected = [
            a for a in attachments
            if str(a.get("id")) in [str(x) for x in attachment_ids]
        ]

        await self.zoho._ensure_token()

        for att in selected:
            href  = att.get("href") or att.get("downloadUrl") or ""
            name  = att.get("name") or att.get("fileName", "attachment")
            ctype = att.get("contentType") or "application/octet-stream"
            if not href:
                continue

            tmp_path = None
            try:
                # Download to a temp file. follow_redirects is required: Zoho's
                # attachment href commonly redirects to signed file storage.
                async with httpx.AsyncClient(timeout=60, follow_redirects=True) as dl:
                    resp = await dl.get(
                        href,
                        headers={"Authorization": f"Zoho-oauthtoken {self.zoho._access_token}"},
                    )
                    resp.raise_for_status()
                    data = resp.content

                # Write to temp file
                suffix = os.path.splitext(name)[-1] or ""
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                    tmp.write(data)
                    tmp_path = tmp.name

                # Upload to Jira
                with open(tmp_path, "rb") as f:
                    file_data = f.read()
                await self.jira.upload_attachment(jira_issue_key, name, ctype, file_data)
                logger.info(f"Uploaded attachment {name} ({len(data)} bytes) to {jira_issue_key}")

            except Exception as e:
                logger.warning(f"Failed to transfer attachment {name}: {e}")
            finally:
                # Always delete the temp file
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                        logger.debug(f"Deleted temp file {tmp_path}")
                    except Exception:
                        pass


    # ------------------------------------------------------------------
    # AI field generation
    # ------------------------------------------------------------------

    async def ai_generate_bug_fields(self, summary: str, description: str) -> dict:
        settings = get_settings()
        if not settings.anthropic_api_key:
            raise ValueError("Anthropic API key not configured")

        prompt = (
            "You are a senior QA engineer writing a professional Jira bug report.\n"
            "Based on the bug information below, do four things:\n"
            "1. Rewrite the summary to be clear, specific, and professional (max 120 chars). "
            "Use the pattern '[Component/Feature] - [What fails] [briefly how]'. "
            "Do NOT start with 'Bug:' or 'Issue:'.\n"
            "2. Write numbered steps to reproduce.\n"
            "3. Write the actual result (what currently happens).\n"
            "4. Write the expected result (what should happen).\n\n"
            f"Original Summary: {summary}\n\n"
            f"Description:\n{description or '(none)'}\n\n"
            "Return ONLY valid JSON with exactly these keys (no markdown, no extra text):\n"
            '{"summary": "enriched summary", '
            '"steps_to_reproduce": "numbered steps", '
            '"actual_result": "what actually happens", '
            '"expected_result": "what should happen"}'
        )

        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = message.content[0].text.strip()
        match = re.search(r'\{.*\}', text, re.DOTALL)
        return json.loads(match.group() if match else text)


# Singleton
_service: CreateBugService | None = None


def get_create_bug_service() -> CreateBugService:
    global _service
    if _service is None:
        _service = CreateBugService()
    return _service

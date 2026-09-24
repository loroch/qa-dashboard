"""
K-1 (KONE) service desk ticket service.
Fetches all open tickets from kabatone-ops-it.atlassian.net and formats them
for the dashboard.  Uses a two-step approach:
  1. Service Desk queue API → issue keys.
  2. REST API v3 /issue/{key} → full details (parallel, semaphore-limited).
"""
import base64
import logging
import os
import tempfile
from typing import Optional

import httpx

from app.jira.kone_client import get_kone_client, Q_OPEN
from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

CACHE_KEY_TICKETS   = "kone:tickets"
CACHE_TTL           = 600   # 10-minute cache


def _extract_field_text(val) -> str:
    """Recursively extract plain text from a Jira field value (ADF dict, string, or None)."""
    if val is None:
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, dict):
        texts: list[str] = []
        def _walk(node):
            if isinstance(node, dict):
                if node.get("type") == "text":
                    texts.append(node.get("text", ""))
                for v in node.values():
                    _walk(v)
            elif isinstance(node, list):
                for item in node:
                    _walk(item)
        _walk(val)
        return " ".join(t for t in texts if t).strip()
    return str(val).strip()

# ── Field IDs discovered from the live instance ─────────────────────────
F_CLIENTE       = "customfield_10110"   # Clientes (option-with-child): parent = region, child = site
F_CUENTA        = "customfield_10126"   # Cuenta (account): SYM, NATI, …
F_PRODUCTO      = "customfield_10132"   # Producto: K-Video, K-Safety, …
F_MODULO        = "customfield_10073"   # Módulos: Video, Events, …
F_SOURCE        = "customfield_10086"   # Source: Phone, Email, …
F_URGENCY       = "customfield_10114"   # Urgency (migrated): Critical, High, …
F_CLASSIF       = "customfield_10123"   # Classification: Externo / Interno
F_AFECTED_SVC   = "customfield_10072"   # Affected services: Producción, …
F_LANG          = "customfield_10040"   # Request language
F_ORGS          = "customfield_10002"   # Organizations (array)
F_SUPPORT_VAL   = "customfield_10226"   # Support Validation (option)
F_BUG_ID        = "customfield_10193"   # Bug ID (TMT0 key written back by QA dashboard)
JIRA_BASE        = "https://kabatone-ops-it.atlassian.net"


def _opt(field) -> str:
    """Safe extraction from Jira option fields."""
    if not field:
        return ""
    if isinstance(field, str):
        return field
    if isinstance(field, dict):
        return field.get("value") or field.get("name") or ""
    return ""


def _opt_child(field) -> str:
    """Get child value from option-with-child field (e.g. Clientes → site)."""
    if not field or not isinstance(field, dict):
        return ""
    child = field.get("child") or {}
    return child.get("value", "")


def _adf_to_text(adf, max_chars: int = 1200) -> str:
    """Extract plain text from an Atlassian Document Format (ADF) dict."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf[:max_chars]
    parts: list[str] = []

    def _walk(node):
        if not isinstance(node, dict):
            return
        if node.get("type") == "text":
            parts.append(node.get("text", ""))
        for child in node.get("content") or []:
            _walk(child)

    _walk(adf)
    return " ".join(p.strip() for p in parts if p.strip())[:max_chars]


def _arr_opt(field) -> list[str]:
    """Extract list of values from array option fields."""
    if not field or not isinstance(field, list):
        return []
    out = []
    for item in field:
        if isinstance(item, dict):
            v = item.get("value") or item.get("name") or ""
            if v:
                out.append(v)
        elif isinstance(item, str):
            out.append(item)
    return out


def _fmt_ticket(issue: dict) -> dict:
    f = issue.get("fields", {})
    key = issue["key"]

    assignee_raw = f.get("assignee") or {}
    reporter_raw = f.get("reporter") or {}
    status_raw   = f.get("status") or {}
    priority_raw = f.get("priority") or {}
    itype_raw    = f.get("issuetype") or {}

    # Dates
    created = f.get("created", "")
    updated = f.get("updated", "")

    # Days open (from created)
    days_open = 0
    if created:
        from datetime import datetime, timezone
        try:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            days_open = (datetime.now(timezone.utc) - dt).days
        except Exception:
            pass

    cliente_field = f.get(F_CLIENTE)
    cliente_parent = _opt(cliente_field)
    cliente_child  = _opt_child(cliente_field)

    return {
        "key":          key,
        "url":          f"{JIRA_BASE}/browse/{key}",
        "summary":      f.get("summary", ""),
        "status":       status_raw.get("name", ""),
        "status_category": (status_raw.get("statusCategory") or {}).get("key", ""),
        "type":         itype_raw.get("name", ""),
        "priority":     priority_raw.get("name", ""),
        "assignee":     assignee_raw.get("displayName", ""),
        "reporter":     reporter_raw.get("displayName", ""),
        "reporter_email": reporter_raw.get("emailAddress", ""),
        "cliente":      cliente_parent,          # e.g. "Chiapas"
        "cliente_site": cliente_child,           # e.g. "C5 Tonalá"
        "cuenta":       _opt(f.get(F_CUENTA)),   # e.g. "SYM", "NATI"
        "producto":     _opt(f.get(F_PRODUCTO)), # e.g. "K-Video"
        "modulo":       _opt(f.get(F_MODULO)),   # e.g. "Video"
        "source":       _opt(f.get(F_SOURCE)),   # e.g. "Phone message"
        "urgency":      _opt(f.get(F_URGENCY)),
        "classification": ", ".join(_arr_opt(f.get(F_CLASSIF))),  # "Externo"
        "affected_svc":      _opt(f.get(F_AFECTED_SVC)),
        "support_validation": _opt(f.get(F_SUPPORT_VAL)),
        "bug_id":       f.get(F_BUG_ID) or "",
        "created":      created,
        "updated":      updated,
        "days_open":    days_open,
    }


class KoneService:
    def __init__(self):
        self.client = get_kone_client()
        self.cache  = get_cache()

    async def get_tickets(self, force_refresh: bool = False) -> list[dict]:
        """Return all currently open K-1 tickets."""
        if force_refresh:
            self.cache.invalidate(CACHE_KEY_TICKETS)

        async def fetch():
            logger.info("KONE: fetching open ticket keys…")
            keys = await self.client.get_queue_keys(queue_id=Q_OPEN, max_total=2000)
            logger.info(f"KONE: {len(keys)} open keys found, fetching details…")
            raw = await self.client.get_issues_bulk(keys)
            tickets = [_fmt_ticket(i) for i in raw]
            logger.info(f"KONE: {len(tickets)} tickets formatted")
            return tickets

        return await self.cache.get_or_fetch(CACHE_KEY_TICKETS, fetch, ttl=CACHE_TTL)

    async def get_by_cliente(self, force_refresh: bool = False) -> list[dict]:
        """Return tickets grouped by Cliente (customer/project)."""
        tickets = await self.get_tickets(force_refresh=force_refresh)
        groups: dict[str, dict] = {}
        for t in tickets:
            cliente = t["cliente"] or "Unknown"
            if cliente not in groups:
                groups[cliente] = {"cliente": cliente, "total": 0, "statuses": {}, "cuentas": set()}
            g = groups[cliente]
            g["total"] += 1
            g["statuses"][t["status"]] = g["statuses"].get(t["status"], 0) + 1
            if t["cuenta"]:
                g["cuentas"].add(t["cuenta"])

        result = []
        for g in groups.values():
            result.append({
                **g,
                "statuses": [{"status": s, "count": c} for s, c in sorted(g["statuses"].items(), key=lambda x: -x[1])],
                "cuentas":  sorted(g["cuentas"]),
            })
        return sorted(result, key=lambda x: -x["total"])


    async def get_ticket_detail(self, key: str) -> dict:
        """Return full issue data + parsed attachments for one KONE ticket."""
        issue = await self.client.get_issue(key)
        if not issue:
            return {}
        f = issue.get("fields", {})

        attachments = []
        for att in f.get("attachment") or []:
            attachments.append({
                "id":           att.get("id", ""),
                "name":         att.get("filename", att.get("id", "")),
                "size":         att.get("size", 0),
                "content_type": att.get("mimeType", "application/octet-stream"),
                "href":         att.get("content", ""),
            })

        description = _adf_to_text(f.get("description"))

        return {
            "key":         key,
            "url":         f"{JIRA_BASE}/browse/{key}",
            "summary":     f.get("summary", ""),
            "description": description,
            "status":      (f.get("status") or {}).get("name", ""),
            "priority":    (f.get("priority") or {}).get("name", ""),
            "attachments": attachments,
        }

    async def get_bug_links(self) -> dict[str, dict]:
        """Return {kone_key: {jira_key, jira_url, jira_status, jira_fix_versions}}.
        The link itself comes from the local DB; status/fix version are pulled
        live from Jira in a single batched query so they stay current."""
        from app.database.db import get_session_factory, KoneBugLinkORM
        from sqlalchemy import select
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(select(KoneBugLinkORM))).scalars().all()

        links = {
            r.kone_key: {
                "jira_key": r.jira_key,
                "jira_url": r.jira_url,
                "jira_status": None,
                "jira_fix_versions": [],
            }
            for r in rows
        }

        jira_keys = sorted({r.jira_key for r in rows if r.jira_key})
        if jira_keys:
            try:
                jira = get_jira_client()
                jql = f"key in ({','.join(jira_keys)})"
                issues = await jira.search_issues(
                    jql, fields=["status", "fixVersions"], max_total=len(jira_keys) + 10
                )
                by_key = {}
                for issue in issues:
                    f = issue.get("fields", {})
                    by_key[issue.get("key")] = {
                        "status": (f.get("status") or {}).get("name", ""),
                        "fix_versions": [v.get("name") for v in (f.get("fixVersions") or []) if v.get("name")],
                    }
                for link in links.values():
                    info = by_key.get(link["jira_key"])
                    if info:
                        link["jira_status"] = info["status"]
                        link["jira_fix_versions"] = info["fix_versions"]
            except Exception as e:
                logger.warning(f"Could not enrich bug links with live Jira status: {e}")

        return links

    async def save_bug_link(self, kone_key: str, jira_key: str, jira_url: str, summary: str = "") -> None:
        """Persist the KONE → TMT0 mapping."""
        from app.database.db import get_session_factory, KoneBugLinkORM
        from sqlalchemy import select
        factory = get_session_factory()
        async with factory() as session:
            existing = (await session.execute(
                select(KoneBugLinkORM).where(KoneBugLinkORM.kone_key == kone_key)
            )).scalar_one_or_none()
            if existing:
                existing.jira_key = jira_key
                existing.jira_url = jira_url
                existing.summary = summary
            else:
                session.add(KoneBugLinkORM(
                    kone_key=kone_key,
                    jira_key=jira_key,
                    jira_url=jira_url,
                    summary=summary,
                ))
            await session.commit()

    # ── Sync: Jira → K1-Support ──────────────────────────────────────────────

    async def sync_from_jira(self) -> dict:
        """Scan all TMT0 bugs for the 'Ticket #' field (customfield_10407 — plain string)
        and upsert KONE-<number> → TMT0-XXXXX links in the local DB."""
        import re

        # Confirmed by field inspection: customfield_10407 = "Ticket #", plain string value
        TICKET_FIELD = "customfield_10407"
        jira = get_jira_client()

        # Fetch all TMT0 bugs where the Ticket # field is populated
        jql = (
            f'project = TMT0 AND issuetype = Bug AND cf[10407] is not EMPTY '
            f'ORDER BY created DESC'
        )
        try:
            raw = await jira.search_issues(
                jql, fields=["summary", TICKET_FIELD], max_total=1000
            )
        except Exception as e:
            raise RuntimeError(f"JQL query for Ticket # failed: {e}")

        created_count = updated_count = skipped_count = 0
        links_out: list[dict] = []
        existing_links = await self.get_bug_links()

        for issue in raw:
            ticket_val = (issue.get("fields", {}).get(TICKET_FIELD) or "").strip()
            if not ticket_val:
                skipped_count += 1
                continue

            # Field stores plain numbers like "3310" — construct KONE key
            m = re.search(r"(\d+)", ticket_val)
            if not m:
                skipped_count += 1
                continue

            kone_key  = f"KONE-{m.group(1)}"
            jira_key  = issue["key"]
            jira_base = get_settings().jira_base_url.rstrip("/")
            jira_url  = f"{jira_base}/browse/{jira_key}"
            summary  = issue.get("fields", {}).get("summary", "")

            is_new = kone_key not in existing_links
            await self.save_bug_link(kone_key, jira_key, jira_url, summary)

            if is_new:
                created_count += 1
            else:
                updated_count += 1

            links_out.append({"kone_key": kone_key, "jira_key": jira_key, "new": is_new})

        return {
            "total_scanned": len(raw),
            "created":       created_count,
            "updated":       updated_count,
            "skipped":       skipped_count,
            "ticket_field":  TICKET_FIELD,
            "links":         links_out,
        }

    async def create_jira_bug(
        self,
        kone_key: str,
        kone_url: str,
        summary: str,
        description: str,
        steps_to_reproduce: str,
        actual_result: str,
        expected_result: str,
        severity: str,
        environments: list,
        found_in_version_id: Optional[str],
        epic_key: Optional[str],
        fix_version_id: Optional[str],
        priority_name: Optional[str],
        sprint_id: Optional[int],
        attachment_ids: list,
        assignee_id: Optional[str] = None,
        label: Optional[str] = None,
        comment: Optional[str] = None,
    ) -> dict:
        from app.services.create_bug_service import get_create_bug_service
        svc = get_create_bug_service()

        adf = svc._build_adf(description=description, zoho_url=kone_url)

        fields: dict = {
            "project":   {"key": "TMT0"},
            "issuetype": {"name": "Bug"},
            "summary":   summary,
            "description": adf,
            "customfield_10409": svc._plain_adf(steps_to_reproduce or " "),
            "customfield_10598": svc._plain_adf(actual_result or " "),
            "customfield_10599": svc._plain_adf(expected_result or " "),
            "customfield_10597": {"value": severity or "Medium"},
            "customfield_10600": environments or [],
            "customfield_10434": svc._link_adf(kone_key, kone_url),
            "customfield_10407": kone_key,
        }

        if found_in_version_id:
            fields["customfield_10601"] = [{"id": found_in_version_id}]
        if epic_key:
            fields["parent"] = {"key": epic_key}
        if fix_version_id:
            fields["fixVersions"] = [{"id": fix_version_id}]
        if priority_name:
            fields["priority"] = {"name": priority_name}
        if sprint_id:
            fields["customfield_10020"] = {"id": sprint_id}
        if assignee_id:
            fields["assignee"] = {"id": assignee_id}
        if label:
            fields["labels"] = [label]

        jira = get_jira_client()
        settings = get_settings()
        created = await jira.post("/issue", {"fields": fields})
        issue_key = created.get("key")
        issue_url = f"{settings.jira_base_url.rstrip('/')}/browse/{issue_key}"

        # Transfer attachments from KONE → TMT0
        attachment_results: list[dict] = []
        if attachment_ids and issue_key:
            attachment_results = await self._transfer_kone_attachments(attachment_ids, issue_key)

        # Add the initial comment, if any
        comment_result = None
        if comment and comment.strip() and issue_key:
            try:
                await jira.post(f"/issue/{issue_key}/comment", {"body": svc._plain_adf(comment)})
                comment_result = {"success": True, "error": None}
            except Exception as e:
                logger.warning(f"Failed to add comment to {issue_key}: {e}")
                comment_result = {"success": False, "error": str(e)}

        # Persist link
        await self.save_bug_link(kone_key, issue_key, issue_url, summary)

        # Write the TMT0 bug key back to the KONE ticket's "Bug ID" field
        await self.write_bug_id_to_kone(kone_key, issue_key)

        return {
            "key": issue_key,
            "url": issue_url,
            "id":  created.get("id"),
            "attachment_results": attachment_results,
            "comment_result": comment_result,
        }

    async def write_bug_id_to_kone(self, kone_key: str, tmt0_key: str) -> bool:
        """Write the TMT0 bug key into the KONE ticket's Bug ID custom field (customfield_10193)."""
        from app.jira.kone_client import get_kone_client
        kone = get_kone_client()
        ok = await kone.update_issue(kone_key, {"customfield_10193": tmt0_key})
        if not ok:
            logger.warning(f"Could not write Bug ID '{tmt0_key}' to KONE ticket {kone_key}")
        return ok

    async def retro_sync_bug_ids(self) -> dict:
        """Write TMT0 bug keys back to KONE tickets that are missing the Bug ID field."""
        from app.jira.kone_client import get_kone_client
        import asyncio

        bug_links = await self.get_bug_links()
        kone = get_kone_client()

        updated_count = 0
        skipped_count = 0
        failed_count  = 0
        results: list[dict] = []

        # Fetch current Bug ID field for all linked KONE tickets in parallel
        kone_keys = list(bug_links.keys())

        async def check_and_update(kone_key: str) -> dict:
            nonlocal updated_count, skipped_count, failed_count
            link = bug_links[kone_key]
            jira_key = link.get("jira_key") if isinstance(link, dict) else str(link)
            if not jira_key:
                failed_count += 1
                return {"kone_key": kone_key, "jira_key": "", "result": "failed"}
            issue = await kone.get_issue(kone_key)
            if not issue:
                failed_count += 1
                return {"kone_key": kone_key, "jira_key": jira_key, "result": "not_found"}
            current = (issue.get("fields") or {}).get("customfield_10193") or ""
            if current.strip():
                skipped_count += 1
                return {"kone_key": kone_key, "jira_key": jira_key, "result": "already_set", "value": current}
            ok = await kone.update_issue(kone_key, {"customfield_10193": jira_key})
            if ok:
                updated_count += 1
                return {"kone_key": kone_key, "jira_key": jira_key, "result": "updated"}
            else:
                failed_count += 1
                return {"kone_key": kone_key, "jira_key": jira_key, "result": "failed"}

        sem = asyncio.Semaphore(5)
        async def limited(k):
            async with sem:
                return await check_and_update(k)

        results = await asyncio.gather(*[limited(k) for k in kone_keys])

        return {
            "total":   len(kone_keys),
            "updated": updated_count,
            "skipped": skipped_count,
            "failed":  failed_count,
            "details": [r for r in results if r["result"] in ("updated", "failed")],
        }

    async def _transfer_kone_attachments(self, attachment_ids: list, jira_issue_key: str) -> list[dict]:
        """Download attachments from KONE Jira and upload to TMT0. Returns per-file results."""
        settings = get_settings()
        creds = f"{settings.kone_jira_email}:{settings.kone_jira_token}"
        auth_header = f"Basic {base64.b64encode(creds.encode()).decode()}"

        jira = get_jira_client()
        results: list[dict] = []

        for att in attachment_ids:
            href = att.get("href", "")
            name = att.get("name", "attachment")
            ctype = att.get("content_type", "application/octet-stream")
            if not href:
                results.append({"name": name, "success": False, "error": "No download URL for this attachment"})
                continue
            tmp_path = None
            try:
                # Jira Cloud's attachment content URL responds with a redirect to
                # the actual file storage — without follow_redirects this silently
                # downloads the redirect body instead of the file.
                async with httpx.AsyncClient(timeout=60, follow_redirects=True) as dl:
                    resp = await dl.get(href, headers={"Authorization": auth_header})
                    resp.raise_for_status()
                    data = resp.content
                suffix = os.path.splitext(name)[-1] or ""
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                    tmp.write(data)
                    tmp_path = tmp.name
                with open(tmp_path, "rb") as f:
                    await jira.upload_attachment(jira_issue_key, name, ctype, f.read())
                logger.info(f"Uploaded KONE attachment {name} ({len(data)} bytes) to {jira_issue_key}")
                results.append({"name": name, "success": True, "error": None})
            except Exception as e:
                logger.warning(f"Failed to transfer KONE attachment {name}: {e}")
                results.append({"name": name, "success": False, "error": str(e)})
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass

        return results

    async def get_attachment_bytes(self, key: str, attachment_id: str) -> tuple[bytes, str, str]:
        """Fetch one attachment's raw bytes + content-type + filename for preview/proxy."""
        detail = await self.get_ticket_detail(key)
        att = next((a for a in detail.get("attachments", []) if str(a.get("id")) == str(attachment_id)), None)
        if not att or not att.get("href"):
            raise ValueError(f"Attachment {attachment_id} not found on {key}")

        settings = get_settings()
        creds = f"{settings.kone_jira_email}:{settings.kone_jira_token}"
        auth_header = f"Basic {base64.b64encode(creds.encode()).decode()}"

        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as dl:
            resp = await dl.get(att["href"], headers={"Authorization": auth_header})
            resp.raise_for_status()
            return resp.content, att.get("content_type", "application/octet-stream"), att.get("name", "attachment")

    async def ai_generate_bug_fields(self, summary: str, description: str) -> dict:
        from app.services.create_bug_service import get_create_bug_service
        svc = get_create_bug_service()
        return await svc.ai_generate_bug_fields(summary=summary, description=description)


_service: Optional[KoneService] = None


def get_kone_service() -> KoneService:
    global _service
    if _service is None:
        _service = KoneService()
    return _service

"""
K-1 (KONE) service desk ticket service.
Fetches all open tickets from kabatone-ops-it.atlassian.net and formats them
for the dashboard.  Uses a two-step approach:
  1. Service Desk queue API → issue keys.
  2. REST API v3 /issue/{key} → full details (parallel, semaphore-limited).
"""
import logging
from typing import Optional

from app.jira.kone_client import get_kone_client, Q_OPEN
from app.services.cache_service import get_cache

logger = logging.getLogger(__name__)

CACHE_KEY_TICKETS   = "kone:tickets"
CACHE_TTL           = 600   # 10-minute cache

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
        "affected_svc": _opt(f.get(F_AFECTED_SVC)),
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


_service: Optional[KoneService] = None


def get_kone_service() -> KoneService:
    global _service
    if _service is None:
        _service = KoneService()
    return _service

"""
Validation Portal — validate a Jira epic/story/bug/task against a live test
environment and turn what's found into Jira bugs or an emailed report.

Pipeline for one run (each check is optional, picked in the UI):
  jira     — hygiene of the issue tree (DONE with ToDo tests, missing AC, open children…)
  ui       — fixed (non-AI) Playwright probe: log in, click nav items, record every
             API call (status, duration, JSON body colors/counts), console errors,
             screenshot per step
  spec     — hex colors written in the Jira requirements vs colors the API returns
  figma    — text/colors of Figma frames linked from the issue tree (evidence)
  db       — read-only SQL queries against the environment's SQL Server
  elastic  — slow/failed BFF API calls and errors in the C-Insight log index
  tests    — kicks off the Automation tab's runner for linked Jira Test issues
  ai       — Claude maps every requirement to the evidence → verdicts + findings

The environment profile (URLs, users, passwords) is seeded from .env and stored
editable in app_settings; passwords are masked in API responses.
"""
import asyncio
import html
import json
import logging
import os
import re
import smtplib
import socket
import tempfile
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

import anthropic
import httpx
from sqlalchemy import select

from app.config import get_settings
from app.database.db import AiContentORM, AppSettingORM, ValidationRunORM, get_session_factory
from app.figma.client import get_figma_client
from app.jira.client import get_jira_client

logger = logging.getLogger(__name__)

PROFILE_KEY = "validation_env_profile"
EXPLAIN_CONTENT_TYPE = "validation_explain"
MASK = "••••••••"
SECRET_FIELDS = {("web", "password"), ("db", "password"), ("elastic", "password"),
                 ("elastic", "ssh_password"), ("smtp", "password")}
AI_MODEL = "claude-sonnet-5-5"
SCRATCH_DIR = Path(tempfile.gettempdir()) / "qa-dashboard-validation-runs"
SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
RESULT_MARKER = "RESULT_JSON:"
HEX_RE = re.compile(r"#[0-9A-Fa-f]{6}\b")
SQL_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|merge|exec|execute|create|grant|revoke|backup|restore|shutdown|dbcc|into)\b",
    re.IGNORECASE,
)
BFF_API_RE = re.compile(r"\[API\]\s+\[(\w+)\]\s+(\S+)\s+-\s+(\d{3})\s+\(([\d.]+)\s*ms\)")
# Keeps background automation batches alive (create_task holds no strong reference).
_background_tasks: set = set()
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

DEFAULT_CHECKS = {"jira": True, "ui": True, "spec": True, "figma": True, "db": True,
                  "elastic": True, "tests": False, "ai": True}

# Fixed (non-AI) UI probe. Config comes in via the PROBE_CONFIG env var (JSON).
UI_PROBE_SCRIPT = r"""
const { chromium } = require('playwright');

(async () => {
  const cfg = JSON.parse(process.env.PROBE_CONFIG);
  const out = { loggedIn: false, finalUrl: '', steps: [], requests: [], consoleErrors: [], error: null };
  const pending = new Map();
  const HEX = /#[0-9A-Fa-f]{6}\b/g;
  let browser;
  const log = (m) => console.log('[probe] ' + m);

  const isApi = (req) => ['xhr', 'fetch'].includes(req.resourceType());

  const waitApisSettled = async (page, maxMs) => {
    const start = Date.now();
    let quietSince = null;
    while (Date.now() - start < maxMs) {
      const n = [...pending.values()].filter(p => p.api).length;
      if (n === 0) {
        quietSince = quietSince || Date.now();
        if (Date.now() - quietSince > 2500) return { settled: true, waitedMs: Date.now() - start };
      } else quietSince = null;
      await page.waitForTimeout(500);
    }
    return { settled: false, waitedMs: Date.now() - start };
  };

  try {
    const launch = { headless: true };
    if (process.env.PW_CHANNEL) launch.channel = process.env.PW_CHANNEL;
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    let step = 'login';

    page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push({ step, text: m.text().slice(0, 400) }); });
    page.on('request', req => {
      pending.set(req, { start: Date.now(), api: isApi(req), step });
    });
    const finish = async (req, failure) => {
      const p = pending.get(req); pending.delete(req);
      if (!p || !p.api) return;
      const entry = {
        step: p.step, method: req.method(), url: req.url(), durationMs: Date.now() - p.start,
        status: null, failure: failure || null, postData: (req.postData() || '').slice(0, 600),
        colors: [], counts: {}, bytes: null, sample: null,
      };
      try {
        const resp = await req.response();
        if (resp) {
          entry.status = resp.status();
          const ct = (resp.headers()['content-type'] || '');
          if (ct.includes('json')) {
            const body = await resp.text();
            entry.bytes = body.length;
            if (body.length < 8000000) {
              entry.colors = [...new Set((body.match(HEX) || []).map(c => c.toUpperCase()))].slice(0, 40);
              try {
                const j = JSON.parse(body);
                if (Array.isArray(j)) entry.counts['(root)'] = j.length;
                else if (j && typeof j === 'object') {
                  for (const [k, v] of Object.entries(j)) {
                    if (Array.isArray(v)) entry.counts[k] = v.length;
                    else if (typeof v === 'number') entry.counts[k] = v;
                  }
                }
              } catch (e) {}
              entry.sample = body.slice(0, 1200);
            }
          }
        }
      } catch (e) {}
      out.requests.push(entry);
    };
    page.on('requestfinished', req => finish(req, null));
    page.on('requestfailed', req => finish(req, (req.failure() || {}).errorText || 'failed'));

    log('opening ' + cfg.url);
    await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => log('goto: ' + e.message));
    const email = page.locator('#email, input[type="email"], input[name="email"], input[formcontrolname="email"], input[placeholder*="mail" i]').first();
    const pwd = page.locator('#password, input[type="password"]').first();
    // The SPA can take a long time to bootstrap — wait for the form instead of
    // checking once (a bare count() right after goto skipped login on slow loads).
    await pwd.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    if (await email.count() && await pwd.count()) {
      log('logging in as ' + cfg.user);
      await email.fill(cfg.user || '');
      await pwd.fill(cfg.password || '');
      const submit = page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log in"), button:has-text("Login")').first();
      await Promise.all([
        page.waitForURL(u => !String(u).includes('/auth/login'), { timeout: 30000 }).catch(() => {}),
        submit.click().catch(e => log('submit: ' + e.message)),
      ]);
      await page.waitForTimeout(3000);
    }
    // URL alone isn't proof (the app can sit on "/" before redirecting to /auth/login):
    // logged in = not on the login route AND no visible password field.
    await page.waitForTimeout(1500);
    out.loggedIn = !page.url().includes('/auth/') && !(await pwd.isVisible().catch(() => false));
    log('logged in: ' + out.loggedIn + ' (' + page.url() + ')');
    const s0 = await waitApisSettled(page, 20000);
    const shot0 = cfg.shotPrefix + '_0.png';
    await page.screenshot({ path: shot0 }).catch(() => {});
    out.steps.push({ name: 'login', ok: out.loggedIn, url: page.url(), screenshot: shot0, ...s0 });

    let i = 1;
    for (const label of (cfg.navLabels || [])) {
      step = label;
      log('clicking "' + label + '"');
      const target = page.getByText(label, { exact: true }).first();
      let ok = true, err = null;
      try {
        await target.waitFor({ state: 'visible', timeout: 30000 });
        await target.click({ timeout: 15000 });
      } catch (e) {
        try { await page.locator('text=' + label).first().click({ timeout: 5000 }); }
        catch (e2) { ok = false; err = e2.message.split('\n')[0]; }
      }
      const s = ok ? await waitApisSettled(page, (cfg.maxWaitS || 90) * 1000) : { settled: false, waitedMs: 0 };
      log('"' + label + '" ' + (ok ? (s.settled ? 'settled' : 'still loading') + ' after ' + Math.round(s.waitedMs / 1000) + 's' : 'not found: ' + err));
      const shot = cfg.shotPrefix + '_' + i + '.png';
      await page.screenshot({ path: shot }).catch(() => {});
      out.steps.push({ name: label, ok, error: err, url: page.url(), screenshot: shot, ...s });
      i++;
    }

    for (const [req, p] of pending.entries()) {
      if (p.api) out.requests.push({ step: p.step, method: req.method(), url: req.url(), durationMs: Date.now() - p.start,
        status: null, failure: 'still pending at end of probe', postData: (req.postData() || '').slice(0, 600), colors: [], counts: {} });
    }
    out.finalUrl = page.url();
  } catch (e) {
    out.error = e.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log('RESULT_JSON:' + JSON.stringify(out));
  }
})();
"""


def _adf_text(node) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_adf_text(n) for n in node)
    if not isinstance(node, dict):
        return str(node)
    out = node.get("text", "")
    for child in node.get("content") or []:
        out += _adf_text(child)
    if node.get("type") in ("paragraph", "heading", "listItem", "tableRow", "hardBreak"):
        out += "\n"
    return out


def _plain_adf(text: str) -> dict:
    paragraphs = [p for p in text.split("\n")]
    return {
        "type": "doc", "version": 1,
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": p}]} if p.strip() else {"type": "paragraph", "content": []}
            for p in paragraphs
        ],
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)


class EnvValidationService:
    def __init__(self):
        self.jira = get_jira_client()
        self._ac_field_ids: Optional[list[str]] = None

    # ------------------------------------------------------------------
    # Environment profile
    # ------------------------------------------------------------------

    def _default_profile(self) -> dict:
        s = get_settings()
        return {
            "name": "Staging (Nati lab)",
            "web": {"url": s.validation_web_url, "user": s.validation_web_user,
                    "password": s.validation_web_password, "nav_labels": "MAP"},
            "db": {"server": s.validation_db_server, "port": s.validation_db_port,
                   "database": s.validation_db_name, "user": s.validation_db_user,
                   "password": s.validation_db_password},
            "elastic": {"url": s.validation_es_url, "index": s.validation_es_index,
                        "user": s.validation_es_user, "password": s.validation_es_password,
                        "ssh_host": s.validation_ssh_host, "ssh_user": s.validation_ssh_user,
                        "ssh_password": s.validation_ssh_password},
            "figma": {"email": s.validation_figma_email},
            "smtp": {"host": s.smtp_host, "port": s.smtp_port, "user": s.smtp_user,
                     "password": s.smtp_password, "from": s.smtp_from or s.smtp_user},
        }

    async def _stored_profile(self) -> Optional[dict]:
        factory = get_session_factory()
        async with factory() as session:
            row = await session.get(AppSettingORM, PROFILE_KEY)
            if row and row.value:
                try:
                    return json.loads(row.value)
                except ValueError:
                    return None
        return None

    async def get_profile(self, reveal: bool = False) -> dict:
        """Effective profile = .env defaults overlaid with whatever was saved in the UI."""
        profile = self._default_profile()
        stored = await self._stored_profile() or {}
        for section, values in stored.items():
            if isinstance(values, dict) and isinstance(profile.get(section), dict):
                profile[section].update({k: v for k, v in values.items() if v is not None})
            elif section == "name" and values:
                profile["name"] = values
        s = get_settings()
        profile["jira"] = {"base_url": s.jira_base_url, "email": s.jira_user_email,
                           "token_configured": bool(s.jira_api_token)}
        profile["figma"]["token_configured"] = bool(s.figma_api_token)
        profile["ai"] = {"configured": bool(s.anthropic_api_key), "model": AI_MODEL}
        if not reveal:
            for section, field in SECRET_FIELDS:
                if profile.get(section, {}).get(field):
                    profile[section][field] = MASK
        return profile

    async def _resolve(self, incoming: Optional[dict]) -> dict:
        """Merge an (unsaved) profile from the UI with stored secrets: masked
        password fields mean 'keep the current value'."""
        current = await self.get_profile(reveal=True)
        if not incoming:
            return current
        merged = json.loads(json.dumps(current))
        for section, values in incoming.items():
            if isinstance(values, dict) and isinstance(merged.get(section), dict):
                for k, v in values.items():
                    if (section, k) in SECRET_FIELDS and v == MASK:
                        continue
                    merged[section][k] = v
        return merged

    async def save_profile(self, incoming: dict) -> dict:
        merged = await self._resolve(incoming)
        for derived in ("jira", "ai"):
            merged.pop(derived, None)
        merged.get("figma", {}).pop("token_configured", None)
        factory = get_session_factory()
        async with factory() as session:
            row = await session.get(AppSettingORM, PROFILE_KEY)
            if row:
                row.value = json.dumps(merged)
            else:
                session.add(AppSettingORM(key=PROFILE_KEY, value=json.dumps(merged)))
            await session.commit()
        return await self.get_profile()

    async def reset_profile(self) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            row = await session.get(AppSettingORM, PROFILE_KEY)
            if row:
                await session.delete(row)
                await session.commit()
        return await self.get_profile()

    # ------------------------------------------------------------------
    # Connection tests
    # ------------------------------------------------------------------

    async def test_connection(self, target: str, incoming: Optional[dict] = None) -> dict:
        p = await self._resolve(incoming)
        started = time.monotonic()
        try:
            detail = await self._test(target, p)
            return {"target": target, "ok": True, "detail": detail,
                    "ms": round((time.monotonic() - started) * 1000)}
        except Exception as exc:
            return {"target": target, "ok": False, "detail": str(exc)[:500],
                    "ms": round((time.monotonic() - started) * 1000)}

    async def _test(self, target: str, p: dict) -> str:
        if target == "web":
            async with httpx.AsyncClient(verify=False, timeout=15, follow_redirects=True) as c:
                r = await c.get(p["web"]["url"].rstrip("/") + "/auth/login")
                r.raise_for_status()
                title = re.search(r"<title>(.*?)</title>", r.text, re.I | re.S)
                return f"HTTP {r.status_code} — {title.group(1).strip() if title else 'page loaded'}"
        if target == "db":
            rows = await asyncio.to_thread(self._sql, p["db"], "SELECT @@SERVERNAME, @@VERSION", 1)
            server, version = rows["rows"][0]
            return f"{server} — {str(version).splitlines()[0]}"
        if target == "elastic":
            async with self._es_client(p) as c:
                r = await c.get(p["elastic"]["url"].rstrip("/"))
                r.raise_for_status()
                info = r.json()
                idx = await c.get(p["elastic"]["url"].rstrip("/") + f"/_cat/indices/{p['elastic']['index']}",
                                  params={"format": "json", "h": "index"})
                n = len(idx.json()) if idx.status_code == 200 else 0
                return f"Elasticsearch {info.get('version', {}).get('number')} — cluster {info.get('cluster_name')}, {n} indices match {p['elastic']['index']}"
        if target == "ssh":
            host = p["elastic"].get("ssh_host")
            if not host:
                raise ValueError("No SSH host set")
            await asyncio.wait_for(asyncio.to_thread(socket.create_connection, (host, 22), 5), 8)
            return f"Port 22 open on {host} (credentials not verified — SSH login is not used by checks)"
        if target == "jira":
            me = await self.jira.get("/myself")
            return f"Connected as {me.get('displayName')} ({me.get('emailAddress')})"
        if target == "figma":
            token = get_settings().figma_api_token
            if not token:
                raise ValueError("FIGMA_API_TOKEN is not set in .env")
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get("https://api.figma.com/v1/me", headers={"X-Figma-Token": token})
                if r.status_code != 200:
                    try:
                        reason = r.json().get("err") or r.text
                    except ValueError:
                        reason = r.text
                    raise ValueError(f"Figma API {r.status_code}: {reason} — create a new token at figma.com → Settings → Security and set FIGMA_API_TOKEN")
                me = r.json()
                return f"API token OK — {me.get('handle')} ({me.get('email')})"
        if target == "smtp":
            sm = p["smtp"]
            if not sm.get("password"):
                raise ValueError("SMTP password is empty — fill it in to enable sending email")
            await asyncio.to_thread(self._smtp_login_only, sm)
            return f"Logged in to {sm['host']}:{sm['port']} as {sm['user']}"
        if target == "ai":
            if not get_settings().anthropic_api_key:
                raise ValueError("ANTHROPIC_API_KEY is not set in .env")
            return f"API key configured — model {AI_MODEL}"
        raise ValueError(f"Unknown target {target}")

    def _es_client(self, p: dict) -> httpx.AsyncClient:
        es = p["elastic"]
        auth = (es["user"], es["password"]) if es.get("user") else None
        return httpx.AsyncClient(verify=False, timeout=30, auth=auth)

    # ------------------------------------------------------------------
    # SQL (read-only)
    # ------------------------------------------------------------------

    @staticmethod
    def check_readonly_sql(sql: str) -> None:
        stripped = re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S).strip().rstrip(";").strip()
        if not re.match(r"^(select|with)\b", stripped, re.I):
            raise ValueError("Only SELECT / WITH queries are allowed")
        if ";" in stripped:
            raise ValueError("Only one statement per query")
        bad = SQL_FORBIDDEN.search(stripped)
        if bad:
            raise ValueError(f"Keyword '{bad.group(1)}' is not allowed (read-only)")

    @staticmethod
    def _sql(db: dict, sql: str, max_rows: int = 200) -> dict:
        import pymssql  # imported lazily so the app still starts without the driver
        conn = pymssql.connect(server=db["server"], port=int(db.get("port") or 1433), user=db["user"],
                               password=db["password"], database=db["database"],
                               login_timeout=10, timeout=120, charset="UTF-8")
        try:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [c[0] for c in (cur.description or [])]
            rows = cur.fetchmany(max_rows) if cols else []
            return {"columns": cols, "rows": [[v if isinstance(v, (int, float, str, type(None))) else str(v) for v in r] for r in rows],
                    "truncated": len(rows) == max_rows}
        finally:
            conn.close()

    async def run_sql(self, sql: str, incoming: Optional[dict] = None) -> dict:
        self.check_readonly_sql(sql)
        p = await self._resolve(incoming)
        started = time.monotonic()
        res = await asyncio.to_thread(self._sql, p["db"], sql)
        res["ms"] = round((time.monotonic() - started) * 1000)
        return res

    # ------------------------------------------------------------------
    # Issue loading
    # ------------------------------------------------------------------

    async def _acceptance_fields(self) -> list[str]:
        if self._ac_field_ids is None:
            try:
                fields = await self.jira.get_all_fields()
                self._ac_field_ids = [f["id"] for f in fields
                                      if re.search(r"acceptance criteria|technical notes", f.get("name", ""), re.I)]
            except Exception:
                self._ac_field_ids = []
        return self._ac_field_ids

    def _shape(self, issue: dict, ac_ids: list[str]) -> dict:
        f = issue.get("fields", {})
        ac = "\n".join(_adf_text(f.get(fid)).strip() for fid in ac_ids if f.get(fid)).strip()
        links = []
        for l in f.get("issuelinks") or []:
            o = l.get("outwardIssue") or l.get("inwardIssue")
            if o:
                of = o.get("fields", {})
                links.append({"type": l.get("type", {}).get("name"), "key": o["key"],
                              "summary": of.get("summary"), "status": (of.get("status") or {}).get("name"),
                              "issuetype": (of.get("issuetype") or {}).get("name")})
        return {
            "key": issue["key"], "summary": f.get("summary"),
            "issuetype": (f.get("issuetype") or {}).get("name"),
            "status": (f.get("status") or {}).get("name"),
            "fix_versions": [v["name"] for v in f.get("fixVersions") or []],
            "parent": (f.get("parent") or {}).get("key"),
            "description": _adf_text(f.get("description")).strip(),
            "acceptance_criteria": ac,
            "links": links,
            "subtasks": [{"key": s["key"], "summary": s["fields"].get("summary"),
                          "status": s["fields"].get("status", {}).get("name")} for s in f.get("subtasks") or []],
        }

    async def load_issue(self, key: str) -> dict:
        key = key.strip().upper()
        ac_ids = await self._acceptance_fields()
        fields = ["summary", "status", "issuetype", "description", "fixVersions", "issuelinks",
                  "subtasks", "parent", *ac_ids]
        root = self._shape(await self.jira.get_issue(key, fields=fields), ac_ids)
        tree = [root]
        children: list[dict] = []
        if root["issuetype"] == "Epic":
            res = await self.jira.post("/search/jql", {"jql": f'parent = {key} ORDER BY key', "fields": fields, "maxResults": 100})
            children = [self._shape(i, ac_ids) for i in res.get("issues", [])]
        sub_keys = [s["key"] for s in root["subtasks"]] + [s["key"] for c in children for s in c["subtasks"]]
        subtasks: list[dict] = []
        if sub_keys:
            for i in range(0, len(sub_keys), 50):
                chunk = ",".join(sub_keys[i:i + 50])
                res = await self.jira.post("/search/jql", {"jql": f"key in ({chunk})", "fields": fields, "maxResults": 50})
                subtasks += [self._shape(x, ac_ids) for x in res.get("issues", [])]
        tree += children + subtasks

        all_text = "\n".join(f"{t['summary']}\n{t['description']}\n{t['acceptance_criteria']}" for t in tree)
        figma_urls = get_figma_client().extract_urls(all_text)
        spec_colors: dict[str, list[str]] = {}
        for t in tree:
            for c in HEX_RE.findall(f"{t['description']}\n{t['acceptance_criteria']}"):
                spec_colors.setdefault(c.upper(), [])
                if t["key"] not in spec_colors[c.upper()]:
                    spec_colors[c.upper()].append(t["key"])
        tests = {l["key"]: l for t in tree for l in t["links"] if (l.get("issuetype") or "").lower() == "test"
                 or "test" in (l.get("type") or "").lower()}
        bugs = {l["key"]: l for t in tree for l in t["links"] if (l.get("issuetype") or "").lower() == "bug"}
        return {
            "root": root, "children": children, "subtasks": subtasks,
            "figma_urls": figma_urls, "spec_colors": spec_colors,
            "linked_tests": list(tests.values()), "linked_bugs": list(bugs.values()),
            "stats": {
                "children": len(children), "subtasks": len(subtasks),
                "with_ac": sum(1 for t in tree if t["acceptance_criteria"]),
                "tests": len(tests), "bugs": len(bugs),
            },
            "jira_url": f"{get_settings().jira_base_url}/browse/{key}",
        }

    # ------------------------------------------------------------------
    # Explain + recommended test plan
    # ------------------------------------------------------------------

    async def _db_schema_hint(self, tree: list[dict], profile: dict) -> tuple[dict, str]:
        """Real tables whose names match words from the issue tree, so the AI's
        suggested SQL uses existing schema.table names. Returns (catalog, hint):
        catalog maps lower(table) -> list of "schema.table" for every table in the DB."""
        words = re.findall(r"[A-Za-z]{4,}", " ".join(t["summary"] or "" for t in tree))
        stop = {"with", "from", "that", "this", "when", "should", "table", "field", "fields", "data", "view",
                "align", "phase", "update", "create", "about", "list", "show", "user", "users", "test", "tests"}
        terms = list(dict.fromkeys(w.lower().rstrip("s") for w in words if w.lower() not in stop))[:12]
        try:
            all_tables = await asyncio.to_thread(
                self._sql, profile["db"],
                "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES", 5000)
        except Exception as exc:
            logger.info("schema hint skipped (DB unreachable): %s", exc)
            return {}, ""
        catalog: dict[str, list[str]] = {}
        for schema, name in all_tables["rows"]:
            catalog.setdefault(name.lower(), []).append(f"{schema}.{name}")
        hits = [(s, n) for s, n in all_tables["rows"] if any(t in n.lower() for t in terms)][:20]
        if ("C4IData", "EventsData") not in hits and "event" in terms:
            hits.insert(0, ("C4IData", "EventsData"))
        if not hits:
            return catalog, ""
        names = ",".join(f"'{s}.{n}'" for s, n in hits)
        cols = await asyncio.to_thread(
            self._sql, profile["db"],
            f"SELECT TABLE_SCHEMA + '.' + TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_SCHEMA + '.' + TABLE_NAME IN ({names}) ORDER BY 1, ORDINAL_POSITION", 3000)
        by_table: dict[str, list[str]] = {}
        for full, col in cols["rows"]:
            by_table.setdefault(full, []).append(col)
        hint = "\n".join(f"{t}: {', '.join(c[:30])}" for t, c in by_table.items())
        return catalog, hint

    @staticmethod
    def _fix_queries(queries: list[dict], catalog: dict) -> tuple[list[dict], list[dict]]:
        """Correct schema prefixes against the real catalog; drop queries that use
        tables which don't exist (or aren't read-only)."""
        kept, dropped = [], []
        ref = re.compile(r"\b(?:from|join)\s+(\[?\w+\]?)\.(\[?\w+\]?)", re.I)
        for q in queries:
            sql = q.get("sql") or ""
            problem = None
            for schema, table in set(ref.findall(sql)):
                s, t = schema.strip("[]"), table.strip("[]")
                options = catalog.get(t.lower(), [])
                if f"{s}.{t}".lower() in (o.lower() for o in options):
                    continue
                if len(options) == 1:
                    sql = re.sub(rf"{re.escape(schema)}\.{re.escape(table)}\b", options[0], sql)
                else:
                    problem = f"table {s}.{t} not found" if not options else f"{t} exists in several schemas: {', '.join(options)}"
                    break
            if not problem:
                try:
                    EnvValidationService.check_readonly_sql(sql)
                except ValueError as exc:
                    problem = str(exc)
            if problem:
                dropped.append({**q, "reason": problem})
            else:
                kept.append({**q, "sql": sql})
        return kept, dropped

    async def explain_issue(self, key: str, refresh: bool = False) -> dict:
        """Plain-language explanation of the issue + a recommended test plan, each
        test mapped to the portal check that can automate it. Cached in ai_content."""
        key = key.strip().upper()
        factory = get_session_factory()
        if not refresh:
            async with factory() as session:
                row = (await session.execute(select(AiContentORM).where(
                    AiContentORM.issue_key == key, AiContentORM.content_type == EXPLAIN_CONTENT_TYPE
                ).order_by(AiContentORM.id.desc()))).scalars().first()
                if row:
                    data = json.loads(row.content)
                    data["generated_at"] = row.generated_at.isoformat() if row.generated_at else None
                    data["cached"] = True
                    return data

        s = get_settings()
        if not s.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is not set")
        issue = await self.load_issue(key)
        tree = [issue["root"]] + issue["children"] + issue["subtasks"]
        text = "\n\n".join(
            f"### {t['key']} [{t['issuetype']}] {t['summary']} ({t['status']})\n"
            + (f"Acceptance criteria:\n{t['acceptance_criteria'][:3000]}\n" if t["acceptance_criteria"] else "")
            + (f"Description:\n{t['description'][:2500]}" if t["description"] else "")
            for t in tree
        )[:30000]
        linked = "\n".join(f"- {l['key']} [{l.get('issuetype')}] {l.get('summary')} ({l.get('status')})"
                           for l in issue["linked_tests"] + issue["linked_bugs"])[:5000]
        profile = await self.get_profile(reveal=True)
        catalog, schema_hint = await self._db_schema_hint(tree, profile)
        prompt = f"""You are a senior QA engineer on the K1 public-safety command platform (Angular web client
"Shahar/CityShob" + Node BFF + C-Insight backend, SQL Server DB "Vulcan" schema C4IData, Elasticsearch logs).
Test environment: {profile['web']['url']} (left menu items: EVENTS, MAP, CAMERAS, Settings).

JIRA ITEM {key} and its children/subtasks:
{text}

Already linked tests / bugs:
{linked or '(none)'}

Write for a QA tester who has never seen this item.
1. "explanation": what it is and why it matters, in simple words (3-6 sentences, no jargon). For a Bug: what is
   broken, where, and how it shows to the user.
2. "how_it_works": 3-6 short bullets on the expected behaviour (what the user does → what should happen).
3. "key_points": the concrete requirements/values to verify (numbers, colors, limits, permissions).
4. "risks": 2-5 areas most likely to break or regress.
5. "tests": 5-10 recommended tests ordered by priority. Each: title, priority (P1|P2|P3), type
   (ui|api|db|logs|design|manual), steps (short list), expected, and "check": which portal check can automate it
   — one of jira|ui|spec|figma|db|elastic|ai|manual — and why.
6. "suggested_settings" for the portal: "nav_labels" (menu items to click, from the list above, comma separated),
   "db_queries" (0-3 read-only SELECTs that verify data behind this item, each {{"name","sql"}}; use ONLY the
   real tables/columns listed below, with their exact schema prefix), "elastic_keywords" (API paths or log phrases
   to count).

REAL DATABASE TABLES related to this item (schema.table: columns):
{schema_hint or 'C4IData.EventsData: EventID, State, Severity, EventType, EventCreationTime, LastModificationTime, IsDeleted'}
Return ONLY JSON with exactly these keys: explanation, how_it_works, key_points, risks, tests, suggested_settings."""
        client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key)
        msg = await client.messages.create(model=AI_MODEL, max_tokens=8000,
                                           messages=[{"role": "user", "content": prompt}])
        out = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        start, end = out.find("{"), out.rfind("}")
        if start < 0:
            raise RuntimeError("AI returned no JSON")
        data = json.loads(out[start:end + 1])
        if catalog:
            settings_ = data.setdefault("suggested_settings", {})
            settings_["db_queries"], data["dropped_queries"] = self._fix_queries(settings_.get("db_queries") or [], catalog)
        data["issue_key"] = key
        data["issue_summary"] = issue["root"]["summary"]
        data["issue_type"] = issue["root"]["issuetype"]
        async with factory() as session:
            row = AiContentORM(issue_key=key, content_type=EXPLAIN_CONTENT_TYPE, content=json.dumps(data))
            session.add(row)
            await session.commit()
            await session.refresh(row)
            data["generated_at"] = row.generated_at.isoformat() if row.generated_at else None
        data["cached"] = False
        return data

    # ------------------------------------------------------------------
    # Runs
    # ------------------------------------------------------------------

    async def create_run(self, issue_key: str, options: dict, incoming_profile: Optional[dict]) -> int:
        profile = await self._resolve(incoming_profile)
        snapshot = json.loads(json.dumps(profile))
        for section, field in SECRET_FIELDS:
            if snapshot.get(section, {}).get(field):
                snapshot[section][field] = MASK
        factory = get_session_factory()
        async with factory() as session:
            run = ValidationRunORM(issue_key=issue_key.strip().upper(), status="pending",
                                   options=json.dumps(options), env_snapshot=json.dumps(snapshot),
                                   log_output="", results="{}", findings="[]")
            session.add(run)
            await session.commit()
            await session.refresh(run)
            return run.id

    async def _log(self, run_id: int, line: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(ValidationRunORM, run_id)
            run.log_output = (run.log_output or "") + f"[{stamp}] {line}\n"
            await session.commit()

    async def _update(self, run_id: int, **fields) -> None:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(ValidationRunORM, run_id)
            for k, v in fields.items():
                setattr(run, k, json.dumps(v) if k in ("results", "findings") else v)
            await session.commit()

    async def execute(self, run_id: int, incoming_profile: Optional[dict]) -> None:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(ValidationRunORM, run_id)
            issue_key, options = run.issue_key, json.loads(run.options or "{}")
        checks = {**DEFAULT_CHECKS, **(options.get("checks") or {})}
        profile = await self._resolve(incoming_profile)
        results: dict = {}
        findings: list[dict] = []

        def add(check: str, severity: str, title: str, detail: str = "", evidence: str = "",
                related_key: Optional[str] = None, screenshot: Optional[str] = None):
            findings.append({"id": f"F{len(findings) + 1}", "check": check, "severity": severity,
                             "title": title, "detail": detail, "evidence": evidence,
                             "related_key": related_key or issue_key, "screenshot": screenshot,
                             "bug_key": None})

        try:
            await self._update(run_id, status="running")
            await self._log(run_id, f"Loading {issue_key} from Jira…")
            issue = await self.load_issue(issue_key)
            root = issue["root"]
            await self._update(run_id, issue_type=root["issuetype"], issue_summary=root["summary"])
            results["issue"] = issue
            await self._log(run_id, f"{root['issuetype']} '{root['summary']}' — {issue['stats']['children']} children, "
                                    f"{issue['stats']['subtasks']} subtasks, {issue['stats']['tests']} linked tests")

            steps = [
                ("jira", self._check_jira), ("ui", self._check_ui), ("spec", self._check_spec),
                ("figma", self._check_figma), ("db", self._check_db), ("elastic", self._check_elastic),
                ("tests", self._check_tests), ("ai", self._check_ai),
            ]
            for name, fn in steps:
                if not checks.get(name):
                    continue
                if name == "ai":
                    results["_existing_findings"] = [f"[{f['check']}] {f['title']}" for f in findings]
                await self._log(run_id, f"▶ {name}")
                try:
                    results[name] = await fn(run_id, issue, profile, options, results, add)
                except Exception as exc:
                    logger.warning("validation check %s failed on run %s: %s", name, run_id, exc, exc_info=True)
                    results[name] = {"error": str(exc)}
                    await self._log(run_id, f"✖ {name} failed: {exc}")
                    add(name, "info", f"Check '{name}' could not run", str(exc))
                results.pop("_existing_findings", None)
                await self._update(run_id, results=results, findings=findings)

            findings.sort(key=lambda f: SEVERITY_ORDER.get(f["severity"], 9))
            for i, f in enumerate(findings, 1):
                f["id"] = f"F{i}"
            await self._update(run_id, status="done", results=results, findings=findings, finished_at=_now())
            await self._log(run_id, f"Done — {len(findings)} findings")
        except Exception as exc:
            logger.error("validation run %s errored: %s", run_id, exc, exc_info=True)
            await self._update(run_id, status="error", error_text=str(exc), results=results,
                               findings=findings, finished_at=_now())
            await self._log(run_id, f"✖ Run failed: {exc}")

    # ------------------------------------------------------------------
    # Checks
    # ------------------------------------------------------------------

    async def _check_jira(self, run_id, issue, profile, options, results, add) -> dict:
        root = issue["root"]
        done_states = {"done", "closed", "resolved", "removed", "handoffok", "released"}
        is_done = (root["status"] or "").lower() in done_states
        tree = [root] + issue["children"]
        open_children = [c for c in issue["children"] if (c["status"] or "").lower() not in done_states]
        todo_tests = [t for t in issue["linked_tests"] if (t["status"] or "").lower() in ("todo", "to do", "open")]
        no_ac = [c for c in tree if c["issuetype"] in ("Story",) and not c["acceptance_criteria"]]
        no_fix = [c for c in tree if c["issuetype"] in ("Epic", "Story", "Bug", "Task") and not c["fix_versions"]
                  and (c["status"] or "").lower() != "removed"]
        open_bugs = [b for b in issue["linked_bugs"] if (b["status"] or "").lower() not in done_states]
        if is_done and todo_tests:
            add("jira", "medium", f"{root['key']} is {root['status']} but {len(todo_tests)} linked test cases are still ToDo",
                "Test cases were never executed/updated although the item is closed.",
                ", ".join(t["key"] for t in todo_tests[:30]))
        if is_done and open_children:
            add("jira", "medium", f"{root['key']} is {root['status']} with {len(open_children)} open children",
                evidence=", ".join(f"{c['key']} ({c['status']})" for c in open_children[:30]))
        if no_ac:
            add("jira", "low", f"{len(no_ac)} stories have no acceptance criteria",
                evidence=", ".join(c["key"] for c in no_ac))
        if no_fix:
            add("jira", "low", f"{len(no_fix)} issues have no fix version", evidence=", ".join(c["key"] for c in no_fix))
        if open_bugs:
            add("jira", "info", f"{len(open_bugs)} linked bugs are still open",
                evidence=", ".join(f"{b['key']} ({b['status']})" for b in open_bugs))
        await self._log(run_id, f"jira: {len(todo_tests)} ToDo tests, {len(open_children)} open children, {len(no_ac)} stories without AC")
        return {"todo_tests": [t["key"] for t in todo_tests], "open_children": [c["key"] for c in open_children],
                "stories_without_ac": [c["key"] for c in no_ac], "no_fix_version": [c["key"] for c in no_fix],
                "open_bugs": [b["key"] for b in open_bugs]}

    async def _check_ui(self, run_id, issue, profile, options, results, add) -> dict:
        ui = options.get("ui") or {}
        web = profile["web"]
        nav_raw = ui.get("nav_labels") if ui.get("nav_labels") is not None else web.get("nav_labels", "")
        nav = [n.strip() for n in (nav_raw.split(",") if isinstance(nav_raw, str) else nav_raw) if n and n.strip()]
        slow_ms = int(ui.get("slow_ms") or 3000)
        script = SCRATCH_DIR / "_ui_probe.js"
        script.write_text(UI_PROBE_SCRIPT, encoding="utf-8")
        cfg = {"url": web["url"], "user": web["user"], "password": web["password"], "navLabels": nav,
               "maxWaitS": int(ui.get("max_wait_s") or 90), "shotPrefix": str(SCRATCH_DIR / f"run_{run_id}")}
        env = {**os.environ, "PROBE_CONFIG": json.dumps(cfg)}
        timeout = 120 + cfg["maxWaitS"] * (len(nav) + 1)
        # The RESULT_JSON line carries every API call of the probe — far above
        # asyncio's default 64 KB readline limit.
        proc = await asyncio.create_subprocess_exec("node", str(script), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, env=env,
                                                    limit=256 * 1024 * 1024)
        lines: list[str] = []

        async def pump():
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="ignore").rstrip()
                lines.append(line)
                if line.startswith("[probe]"):
                    await self._log(run_id, "ui: " + line[8:])
        try:
            await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"UI probe timed out after {timeout}s")
        text = "\n".join(lines)
        pos = text.rfind(RESULT_MARKER)
        if pos < 0:
            raise RuntimeError("UI probe produced no result: " + text[-800:])
        probe, _ = json.JSONDecoder().raw_decode(text[pos + len(RESULT_MARKER):].strip())

        for st in probe.get("steps", []):
            st["screenshot_name"] = Path(st["screenshot"]).name if st.get("screenshot") else None
            st.pop("screenshot", None)
        if probe.get("error"):
            add("ui", "high", "UI probe error", probe["error"])
        if not probe.get("loggedIn"):
            add("ui", "critical", f"Could not log in to {web['url']} as {web['user']}",
                screenshot=(probe.get("steps") or [{}])[0].get("screenshot_name"))
        for st in probe.get("steps", [])[1:]:
            if not st.get("ok"):
                add("ui", "high", f"Navigation item '{st['name']}' not found / not clickable", st.get("error") or "",
                    screenshot=st.get("screenshot_name"))
            elif not st.get("settled"):
                add("ui", "high", f"'{st['name']}' still loading after {round(st.get('waitedMs', 0) / 1000)}s",
                    "API calls were still pending when the probe stopped waiting.", screenshot=st.get("screenshot_name"))

        reqs = probe.get("requests", [])
        for r in reqs:
            r["path"] = re.sub(r"^https?://[^/]+", "", r["url"]).split("?")[0]
        api = [r for r in reqs if "/api/" in r["url"]]
        slow = sorted([r for r in api if (r.get("durationMs") or 0) >= slow_ms], key=lambda r: -r["durationMs"])
        failed = [r for r in reqs if r.get("failure") or (r.get("status") or 0) >= 400]
        shot_for = {st["name"]: st.get("screenshot_name") for st in probe.get("steps", [])}
        for r in slow[:10]:
            counts = ", ".join(f"{k}={v}" for k, v in (r.get("counts") or {}).items())
            add("ui", "high" if r["durationMs"] >= 10000 else "medium",
                f"Slow API: {r['method']} {r['path']} took {r['durationMs'] / 1000:.1f}s",
                f"Threshold {slow_ms} ms. Step: {r['step']}. Status {r.get('status')}. {counts}",
                f"Request body: {r.get('postData') or '-'}", screenshot=shot_for.get(r["step"]))
        seen_fail = set()
        for r in failed:
            sig = (r["path"], r.get("status"), r.get("failure"))
            if sig in seen_fail:
                continue
            seen_fail.add(sig)
            add("ui", "medium" if "/api/" in r["url"] else "low",
                f"Failed request: {r['method']} {r['path']} → {r.get('status') or r.get('failure')}",
                f"Full URL: {r['url'][:300]}", screenshot=shot_for.get(r["step"]))
        errs = probe.get("consoleErrors", [])
        if errs:
            uniq = list(dict.fromkeys(e["text"] for e in errs))
            add("ui", "low", f"{len(errs)} browser console errors", evidence="\n".join(uniq[:15]))
        await self._log(run_id, f"ui: {len(api)} API calls, {len(slow)} slow (≥{slow_ms} ms), {len(failed)} failed, {len(errs)} console errors")
        return {"logged_in": probe.get("loggedIn"), "final_url": probe.get("finalUrl"), "steps": probe.get("steps", []),
                "requests": sorted(api, key=lambda r: -(r.get("durationMs") or 0)),
                "failed": failed, "console_errors": errs[:100], "slow_ms": slow_ms, "nav_labels": nav}

    async def _check_spec(self, run_id, issue, profile, options, results, add) -> dict:
        spec = issue["spec_colors"]
        ui = results.get("ui") or {}
        api_colors: dict[str, list[str]] = {}
        for r in ui.get("requests", []):
            for c in r.get("colors") or []:
                api_colors.setdefault(c, [])
                if r["path"] not in api_colors[c]:
                    api_colors[c].append(r["path"])
        if not spec:
            await self._log(run_id, "spec: no hex colors written in the requirements — nothing to compare")
            return {"spec_colors": {}, "api_colors": api_colors, "missing": [], "note": "No hex colors in requirements"}
        if not ui.get("requests"):
            await self._log(run_id, "spec: needs the UI check's API responses — skipped")
            return {"spec_colors": spec, "api_colors": {}, "missing": [], "note": "Run the UI check to compare"}
        # A color appearing in some unrelated endpoint is not a match: compare against
        # the endpoint that returns the most of the required colors (the "palette" endpoint).
        per_path: dict[str, set] = {}
        for r in ui.get("requests", []):
            per_path.setdefault(r["path"], set()).update(r.get("colors") or [])
        best_path, best = max(per_path.items(), key=lambda kv: len(kv[1] & set(spec)), default=(None, set()))
        reference = best if len(best & set(spec)) >= 2 else set(api_colors)
        missing = [c for c in spec if c not in reference]
        extra = sorted(reference - set(spec)) if best_path and reference is best else []
        where = f"in {best_path}" if reference is best else "by any API"
        for c in missing:
            add("spec", "medium", f"Required color {c} is not returned {where}",
                f"Specified in {', '.join(spec[c])}."
                + (f" {best_path} returns instead: {', '.join(extra)}." if extra else ""),
                related_key=spec[c][0])
        await self._log(run_id, f"spec: {len(spec)} required colors, {len(missing)} missing {where}")
        return {"spec_colors": spec, "api_colors": api_colors, "missing": missing,
                "reference_endpoint": best_path if reference is best else None, "unexpected": extra}

    async def _check_figma(self, run_id, issue, profile, options, results, add) -> dict:
        urls = list(dict.fromkeys((options.get("figma") or {}).get("urls") or [])) or issue["figma_urls"]
        if not urls:
            await self._log(run_id, "figma: no Figma links in the issue tree")
            return {"frames": [], "note": "No Figma links found in the issue tree"}
        client = get_figma_client()
        frames = []
        for u in urls[:6]:
            try:
                ctx = await client.get_node_context(u, max_chars=2000)
                frames.append(ctx)
            except Exception as exc:
                frames.append({"url": u, "error": str(exc)[:300]})
        await self._log(run_id, f"figma: read {sum(1 for f in frames if not f.get('error'))}/{len(frames)} frames")
        return {"frames": frames}

    async def _check_db(self, run_id, issue, profile, options, results, add) -> dict:
        queries = [q for q in (options.get("db") or {}).get("queries") or [] if (q.get("sql") or "").strip()]
        if not queries:
            await self._log(run_id, "db: no queries configured")
            return {"queries": [], "note": "No queries configured"}
        out = []
        for q in queries:
            name = q.get("name") or q["sql"][:40]
            try:
                self.check_readonly_sql(q["sql"])
                started = time.monotonic()
                res = await asyncio.to_thread(self._sql, profile["db"], q["sql"])
                res.update(name=name, sql=q["sql"], ms=round((time.monotonic() - started) * 1000))
                out.append(res)
                await self._log(run_id, f"db: '{name}' → {len(res['rows'])} rows")
            except Exception as exc:
                out.append({"name": name, "sql": q["sql"], "error": str(exc)[:400]})
                add("db", "info", f"DB query '{name}' failed", str(exc)[:400])
        return {"queries": out}

    async def _check_elastic(self, run_id, issue, profile, options, results, add) -> dict:
        es_opts = options.get("elastic") or {}
        minutes = int(es_opts.get("minutes") or 60)
        slow_ms = int(es_opts.get("slow_ms") or 3000)
        keywords = [k.strip() for k in (es_opts.get("keywords") or []) if k and k.strip()]
        base = profile["elastic"]["url"].rstrip("/") + f"/{profile['elastic']['index']}/_search"
        window = {"range": {"@timestamp": {"gte": f"now-{minutes}m"}}}
        async with self._es_client(profile) as c:
            api_resp = await c.post(base, json={"size": 5000, "_source": ["@timestamp", "message"],
                                                "query": {"bool": {"must": [{"match_phrase": {"message": "[API]"}}, window]}},
                                                "sort": [{"@timestamp": "desc"}]})
            api_resp.raise_for_status()
            err_resp = await c.post(base, json={"size": 200, "_source": ["@timestamp", "message", "service"],
                                                "track_total_hits": True,
                                                "query": {"bool": {"must": [window, {"query_string": {"query": "message:(error OR exception OR fatal OR unhandled)"}}],
                                                                   "must_not": [{"match_phrase": {"message": "[API]"}}]}},
                                                "sort": [{"@timestamp": "desc"}]})
            err_resp.raise_for_status()
            kw_hits = []
            for kw in keywords[:10]:
                r = await c.post(base, json={"size": 5, "track_total_hits": True, "_source": ["@timestamp", "message"],
                                             "query": {"bool": {"must": [window, {"match_phrase": {"message": kw}}]}},
                                             "sort": [{"@timestamp": "desc"}]})
                if r.status_code == 200:
                    j = r.json()
                    kw_hits.append({"keyword": kw, "total": j["hits"]["total"]["value"],
                                    "latest": [h["_source"].get("message", "")[:300] for h in j["hits"]["hits"]]})

        stats: dict[str, dict] = {}
        for h in api_resp.json()["hits"]["hits"]:
            m = BFF_API_RE.search(h["_source"].get("message", ""))
            if not m:
                continue
            method, url, status, ms = m.group(1), m.group(2).split("?")[0], int(m.group(3)), float(m.group(4))
            s = stats.setdefault(f"{method} {url}", {"endpoint": f"{method} {url}", "count": 0, "errors": 0, "durations": []})
            s["count"] += 1
            s["durations"].append(ms)
            if status >= 500:
                s["errors"] += 1
        endpoints = []
        for s in stats.values():
            d = sorted(s.pop("durations"))
            s.update(avg_ms=round(sum(d) / len(d)), p95_ms=round(d[min(len(d) - 1, int(len(d) * 0.95))]), max_ms=round(d[-1]))
            endpoints.append(s)
        endpoints.sort(key=lambda s: -s["max_ms"])
        for s in [e for e in endpoints if e["p95_ms"] >= slow_ms][:8]:
            add("elastic", "high" if s["p95_ms"] >= 10000 else "medium",
                f"BFF logs: {s['endpoint']} p95 {s['p95_ms'] / 1000:.1f}s (max {s['max_ms'] / 1000:.1f}s)",
                f"{s['count']} calls in the last {minutes} min, avg {s['avg_ms']} ms.")
        for s in [e for e in endpoints if e["errors"]][:8]:
            add("elastic", "medium", f"BFF logs: {s['endpoint']} returned 5xx {s['errors']}× in the last {minutes} min")
        ej = err_resp.json()
        groups: dict[str, dict] = {}
        for h in ej["hits"]["hits"]:
            msg = re.sub(r"\x1b\[[0-9;]*m", "", h["_source"].get("message", ""))
            sig = re.sub(r"\d+", "#", msg)[:140]
            g = groups.setdefault(sig, {"sample": msg[:500], "count": 0, "latest": h["_source"].get("@timestamp")})
            g["count"] += 1
        error_groups = sorted(groups.values(), key=lambda g: -g["count"])[:15]
        total_err = ej["hits"]["total"]["value"]
        if total_err:
            add("elastic", "low", f"{total_err} error/exception log lines in the last {minutes} min",
                evidence="\n".join(f"{g['count']}× {g['sample'][:200]}" for g in error_groups[:6]))
        await self._log(run_id, f"elastic: {sum(e['count'] for e in endpoints)} BFF API log lines, {len(endpoints)} endpoints, {total_err} error lines")
        return {"minutes": minutes, "slow_ms": slow_ms, "endpoints": endpoints[:60], "error_total": total_err,
                "error_groups": error_groups, "keywords": kw_hits}

    async def _check_tests(self, run_id, issue, profile, options, results, add) -> dict:
        from app.services.automation_runner_service import get_automation_runner_service
        svc = get_automation_runner_service()
        stories = [issue["root"]] + issue["children"]
        started = []
        target = profile["web"]["url"]
        for s in stories:
            tests = await svc.get_tests_for_story(s["key"])
            if tests:
                started.append({"story": s["key"], "tests": len(tests)})
                task = asyncio.create_task(svc.run_batch(s["key"], target))
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)
        await self._log(run_id, f"tests: started automation for {sum(x['tests'] for x in started)} tests on {len(started)} items")
        return {"started": started, "note": "Runs continue in the background — results appear in the Automation tab"}

    async def _check_ai(self, run_id, issue, profile, options, results, add) -> dict:
        s = get_settings()
        if not s.anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        tree = [issue["root"]] + issue["children"] + issue["subtasks"]
        reqs_text = "\n\n".join(
            f"### {t['key']} [{t['issuetype']}] {t['summary']} ({t['status']})\n"
            + (f"Acceptance criteria:\n{t['acceptance_criteria'][:3000]}\n" if t["acceptance_criteria"] else "")
            + (f"Description:\n{t['description'][:1500]}" if t["description"] else "")
            for t in tree
        )[:30000]
        ui = results.get("ui") or {}
        evidence = {
            "environment": profile["web"]["url"],
            "ui": {
                "logged_in": ui.get("logged_in"), "steps": ui.get("steps"),
                "api_calls": [{k: r.get(k) for k in ("step", "method", "path", "status", "durationMs", "counts", "postData", "failure")}
                              for r in (ui.get("requests") or [])[:60]],
                "api_samples": {r["path"]: (r.get("sample") or "")[:600] for r in (ui.get("requests") or [])[:15]},
                "console_errors": (ui.get("console_errors") or [])[:15],
            } if ui else None,
            "spec_colors": results.get("spec"),
            "figma": [{k: f.get(k) for k in ("title", "colors", "text_summary", "error")} for f in (results.get("figma") or {}).get("frames", [])],
            "db": [{"name": q.get("name"), "columns": q.get("columns"), "rows": (q.get("rows") or [])[:40], "error": q.get("error")}
                   for q in (results.get("db") or {}).get("queries", [])],
            "elastic": {k: (results.get("elastic") or {}).get(k) for k in ("minutes", "endpoints", "error_total", "error_groups", "keywords")}
            if results.get("elastic") else None,
            "jira_hygiene": results.get("jira"),
        }
        prompt = f"""You are a senior QA engineer validating a delivered feature on a live test environment.

REQUIREMENTS (Jira {issue['root']['key']} and its children/subtasks):
{reqs_text}

EVIDENCE collected automatically from the environment (JSON):
{json.dumps(evidence, ensure_ascii=False, default=str)[:60000]}

Task: for each concrete, testable requirement (use the requirement numbers/ids where they exist), decide a verdict
based ONLY on the evidence: "pass" (evidence shows it works), "fail" (evidence contradicts it), "partial", or
"not_verified" (evidence doesn't cover it — say what manual/extra check is needed). Quote numbers from the evidence
(durations, counts, colors, DB rows vs API counts). Compare DB counts with API response counts when both exist.
Then list concrete defects as findings, written so each can be filed as a Jira bug (clear title, steps/evidence,
expected vs actual). Do not invent evidence. Do not repeat a finding twice.

These findings were ALREADY reported by rule-based checks — do NOT report them again (you may still cite them as
evidence in requirement verdicts):
{json.dumps(results.get("_existing_findings") or [], ensure_ascii=False)}

Return ONLY JSON:
{{"overall": "pass|fail|partial", "summary": "3-5 sentences",
 "requirements": [{{"id": "1.2", "source_key": "TMT0-…", "requirement": "short", "verdict": "pass|fail|partial|not_verified", "evidence": "…"}}],
 "findings": [{{"severity": "critical|high|medium|low", "title": "…", "detail": "expected vs actual + repro", "evidence": "numbers", "related_key": "TMT0-…"}}]}}"""
        await self._log(run_id, f"ai: asking {AI_MODEL} to map {len(tree)} issues' requirements to the evidence…")
        client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key)
        msg = await client.messages.create(model=AI_MODEL, max_tokens=12000,
                                           messages=[{"role": "user", "content": prompt}])
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        start, end = text.find("{"), text.rfind("}")
        data = json.loads(text[start:end + 1]) if start >= 0 else {}
        for f in data.get("findings") or []:
            add("ai", (f.get("severity") or "medium").lower(), f.get("title") or "AI finding", f.get("detail") or "",
                f.get("evidence") or "", f.get("related_key"))
        reqs = data.get("requirements") or []
        tally = {v: sum(1 for r in reqs if r.get("verdict") == v) for v in ("pass", "fail", "partial", "not_verified")}
        await self._log(run_id, f"ai: {len(reqs)} requirements — {tally}")
        return {"overall": data.get("overall"), "summary": data.get("summary"), "requirements": reqs, "tally": tally}

    # ------------------------------------------------------------------
    # Run queries
    # ------------------------------------------------------------------

    @staticmethod
    def _run_dict(r: ValidationRunORM, full: bool = True) -> dict:
        d = {"id": r.id, "issue_key": r.issue_key, "issue_type": r.issue_type, "issue_summary": r.issue_summary,
             "status": r.status, "error": r.error_text,
             "created_at": r.created_at.isoformat() if r.created_at else None,
             "finished_at": r.finished_at.isoformat() if r.finished_at else None}
        findings = json.loads(r.findings or "[]")
        d["finding_counts"] = {sev: sum(1 for f in findings if f["severity"] == sev) for sev in SEVERITY_ORDER}
        if full:
            d.update(options=json.loads(r.options or "{}"), env=json.loads(r.env_snapshot or "{}"),
                     log_output=r.log_output, results=json.loads(r.results or "{}"), findings=findings)
        return d

    async def mark_interrupted_runs(self) -> None:
        """Runs live in-process; after a restart anything still 'running' is dead."""
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(select(ValidationRunORM).where(
                ValidationRunORM.status.in_(["pending", "running"])))).scalars().all()
            for r in rows:
                r.status = "error"
                r.error_text = "Interrupted by a server restart"
                r.finished_at = _now()
            await session.commit()

    async def get_run(self, run_id: int) -> Optional[dict]:
        factory = get_session_factory()
        async with factory() as session:
            r = await session.get(ValidationRunORM, run_id)
            return self._run_dict(r) if r else None

    async def list_runs(self, limit: int = 30) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(select(ValidationRunORM).order_by(ValidationRunORM.id.desc()).limit(limit))).scalars().all()
            return [self._run_dict(r, full=False) for r in rows]

    def screenshot_path(self, name: str) -> Optional[Path]:
        if not re.fullmatch(r"run_\d+_\d+\.png", name or ""):
            return None
        p = SCRATCH_DIR / name
        return p if p.exists() else None

    # ------------------------------------------------------------------
    # Bugs
    # ------------------------------------------------------------------

    async def file_bug(self, run_id: int, finding_id: str, summary: str, description: str,
                       priority: Optional[str] = None, attach_screenshot: bool = True) -> dict:
        settings = get_settings()
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(ValidationRunORM, run_id)
            if not run:
                raise ValueError("Run not found")
            findings = json.loads(run.findings or "[]")
            finding = next((f for f in findings if f["id"] == finding_id), None)
            if not finding:
                raise ValueError(f"No finding {finding_id} on run {run_id}")
            if finding.get("bug_key"):
                return {"key": finding["bug_key"], "url": f"{settings.jira_base_url}/browse/{finding['bug_key']}", "already_filed": True}
            results = json.loads(run.results or "{}")
            root = (results.get("issue") or {}).get("root") or {}

        project_key = run.issue_key.split("-")[0]
        fields = {"project": {"key": project_key}, "summary": summary[:250], "issuetype": {"name": "Bug"},
                  "description": _plain_adf(description)}
        if root.get("fix_versions"):
            fields["fixVersions"] = [{"name": v} for v in root["fix_versions"]]
        if priority:
            fields["priority"] = {"name": priority}
        try:
            created = await self.jira.post("/issue", {"fields": fields})
        except Exception as exc:
            logger.warning("bug create with fixVersions/priority failed (%s) — retrying minimal", exc)
            fields.pop("fixVersions", None)
            fields.pop("priority", None)
            created = await self.jira.post("/issue", {"fields": fields})
        key = created.get("key")
        if not key:
            raise ValueError("Jira did not return a key for the new bug")
        for link_to in dict.fromkeys([finding.get("related_key"), run.issue_key]):
            if not link_to:
                continue
            try:
                await self.jira.post("/issueLink", {"type": {"name": "Relates"}, "inwardIssue": {"key": key},
                                                    "outwardIssue": {"key": link_to}})
            except Exception as exc:
                logger.warning("could not link %s to %s: %s", key, link_to, exc)
        if attach_screenshot and finding.get("screenshot"):
            p = self.screenshot_path(finding["screenshot"])
            if p:
                try:
                    await self.jira.upload_attachment(key, p.name, "image/png", p.read_bytes())
                except Exception as exc:
                    logger.warning("could not attach screenshot to %s: %s", key, exc)

        async with factory() as session:
            run = await session.get(ValidationRunORM, run_id)
            findings = json.loads(run.findings or "[]")
            for f in findings:
                if f["id"] == finding_id:
                    f["bug_key"] = key
            run.findings = json.dumps(findings)
            await session.commit()
        return {"key": key, "url": f"{settings.jira_base_url}/browse/{key}", "already_filed": False}

    # ------------------------------------------------------------------
    # Report + email
    # ------------------------------------------------------------------

    async def render_report(self, run_id: int, finding_ids: Optional[list[str]] = None, note: str = "") -> tuple[str, str]:
        run = await self.get_run(run_id)
        if not run:
            raise ValueError("Run not found")
        jira_base = get_settings().jira_base_url
        findings = [f for f in run["findings"] if not finding_ids or f["id"] in finding_ids]
        ai = (run["results"] or {}).get("ai") or {}
        sev_color = {"critical": "#b91c1c", "high": "#c2410c", "medium": "#a16207", "low": "#15803d", "info": "#475569"}
        e = html.escape
        rows = "".join(
            f"<tr><td style='padding:6px;border-bottom:1px solid #e5e7eb;color:{sev_color.get(f['severity'], '#000')};font-weight:600'>{e(f['severity'].upper())}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #e5e7eb'><b>{e(f['title'])}</b><br><span style='color:#475569'>{e(f.get('detail') or '')}</span>"
            + (f"<br><code style='font-size:11px;color:#334155'>{e((f.get('evidence') or '')[:400])}</code>" if f.get("evidence") else "")
            + "</td>"
            f"<td style='padding:6px;border-bottom:1px solid #e5e7eb'>{e(f['check'])}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #e5e7eb'>"
            + (f"<a href='{jira_base}/browse/{e(f['bug_key'])}'>{e(f['bug_key'])}</a>" if f.get("bug_key") else "—")
            + "</td></tr>"
            for f in findings
        )
        req_rows = "".join(
            f"<tr><td style='padding:4px 6px'>{e(str(r.get('id') or ''))}</td><td style='padding:4px 6px'>{e(r.get('requirement') or '')}</td>"
            f"<td style='padding:4px 6px;font-weight:600'>{e((r.get('verdict') or '').replace('_', ' '))}</td>"
            f"<td style='padding:4px 6px;color:#475569'>{e(r.get('evidence') or '')}</td></tr>"
            for r in ai.get("requirements") or []
        )
        subject = f"[QA Validation] {run['issue_key']} {run['issue_summary'] or ''} — {len(findings)} findings"
        body = f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#0f172a">
<h2 style="margin:0 0 4px">Validation report — <a href="{jira_base}/browse/{e(run['issue_key'])}">{e(run['issue_key'])}</a></h2>
<div style="color:#475569">{e(run['issue_summary'] or '')} · {e(run['issue_type'] or '')} · environment {e((run['env'].get('web') or {}).get('url', ''))} · run #{run['id']} ({e(run['created_at'] or '')})</div>
{f'<p style="white-space:pre-wrap">{e(note)}</p>' if note else ''}
{f'<h3>Summary</h3><p>{e(ai.get("summary") or "")}</p>' if ai.get("summary") else ''}
<h3>Findings ({len(findings)})</h3>
<table style="border-collapse:collapse;width:100%"><tr style="background:#f1f5f9;text-align:left"><th style="padding:6px">Severity</th><th style="padding:6px">Finding</th><th style="padding:6px">Check</th><th style="padding:6px">Bug</th></tr>{rows}</table>
{f'<h3>Requirements</h3><table style="border-collapse:collapse;width:100%"><tr style="background:#f1f5f9;text-align:left"><th>Id</th><th>Requirement</th><th>Verdict</th><th>Evidence</th></tr>{req_rows}</table>' if req_rows else ''}
<p style="color:#94a3b8;font-size:11px">Generated by the QA Dashboard Validation Portal.</p></div>"""
        return subject, body

    def _smtp_login_only(self, sm: dict) -> None:
        with smtplib.SMTP(sm["host"], int(sm["port"]), timeout=20) as srv:
            srv.starttls()
            srv.login(sm["user"], sm["password"])

    async def send_email(self, run_id: int, to: list[str], cc: list[str], subject: Optional[str],
                         finding_ids: Optional[list[str]], note: str = "") -> dict:
        p = await self.get_profile(reveal=True)
        sm = p["smtp"]
        if not sm.get("password"):
            raise ValueError("SMTP is not configured (no password) — use 'Open in mail app' or download the report")
        default_subject, body = await self.render_report(run_id, finding_ids, note)
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject or default_subject
        msg["From"] = sm.get("from") or sm["user"]
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg.attach(MIMEText(body, "html", "utf-8"))

        def _send():
            with smtplib.SMTP(sm["host"], int(sm["port"]), timeout=30) as srv:
                srv.starttls()
                srv.login(sm["user"], sm["password"])
                srv.sendmail(msg["From"], to + cc, msg.as_string())
        await asyncio.to_thread(_send)
        return {"sent": True, "to": to, "cc": cc, "subject": msg["Subject"]}


_service: Optional[EnvValidationService] = None


def get_env_validation_service() -> EnvValidationService:
    global _service
    if _service is None:
        _service = EnvValidationService()
    return _service

"""
NextGen QA Hub — AI and Slack connectors.

  briefing         Claude reads the hub snapshot and writes the QA status, risks and next steps
  alt_tests        a second opinion on testing: Grok (xAI) by default, Claude as fallback, proposes
                   manual and automation tests for a ticket or a domain that the existing suites miss
  lab_script       Claude drafts a Playwright Lab script that validates a ticket on the environment
  slack_feed       recent messages from the NextGen channels, with ticket keys and alert words flagged
  slack_summary    Claude compiles those channels (threads included) into decisions, action items
                   (QA ones flagged and notified), QA insights and open questions, each linked to its message
"""
import asyncio
import fnmatch
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import anthropic
import httpx

from app.config import get_settings
from app.services.env_validation_service import AI_MODEL
from app.services.nextgen_hub_service import KEY_RE, SNAPSHOT_KEY, env_up, get_nextgen_hub_service
from app.services.nextgen_lab_service import DEFAULT_ROUTES

logger = logging.getLogger(__name__)

SLACK_SUMMARY_KEY = "nextgen_slack_summary"
ALERT_RE = re.compile(r"\b(bug|broken|blocker|blocked|fails?|failing|failed|down|crash\w*|regression|urgent|"
                      r"hotfix|rollback|outage|error|deploy\w*|release\w*)\b", re.I)

TEST_SCHEMA = {
    "type": "object",
    "properties": {
        "analysis": {"type": "string"},
        "gaps": {"type": "array", "items": {"type": "string"}},
        "manual_tests": {"type": "array", "items": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "priority": {"type": "string", "enum": ["P0", "P1", "P2"]},
                           "type": {"type": "string"}, "preconditions": {"type": "string"},
                           "steps": {"type": "array", "items": {"type": "string"}}, "expected": {"type": "string"}},
            "required": ["title", "priority", "type", "preconditions", "steps", "expected"], "additionalProperties": False}},
        "automation_tests": {"type": "array", "items": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "priority": {"type": "string", "enum": ["P0", "P1", "P2"]},
                           "level": {"type": "string", "enum": ["unit", "contract", "api-e2e", "ui-e2e", "load", "chaos"]},
                           "where": {"type": "string"}, "sketch": {"type": "string"}},
            "required": ["title", "priority", "level", "where", "sketch"], "additionalProperties": False}},
    },
    "required": ["analysis", "gaps", "manual_tests", "automation_tests"],
    "additionalProperties": False,
}


async def _claude(prompt, schema: dict, max_tokens: int = 12000) -> dict:
    """prompt: a string, or a list of content blocks (text + images)."""
    s = get_settings()
    if not s.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY is not set")
    client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key)
    msg = await client.messages.create(model=AI_MODEL, max_tokens=max_tokens,
                                       output_config={"format": {"type": "json_schema", "schema": schema}},
                                       messages=[{"role": "user", "content": prompt}])
    if msg.stop_reason == "refusal":
        raise RuntimeError("The model declined this request")
    if msg.stop_reason == "max_tokens":
        raise RuntimeError("The answer was cut off (max_tokens)")
    return json.loads(next((b.text for b in msg.content if getattr(b, "type", "") == "text"), "{}"))


def _json_from_text(text: str) -> dict:
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    return json.loads(t[start:end + 1] if start >= 0 else t)


async def _grok(cfg: dict, prompt: str, schema: dict) -> dict:
    g = cfg["grok"]
    if not g.get("api_key"):
        raise ValueError("No xAI (Grok) API key in the hub settings")
    body = {
        "model": g.get("model") or "grok-4",
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": "You are a senior QA engineer giving an independent second opinion. "
                                          "Answer with one JSON object only, matching this JSON schema: "
                                          + json.dumps(schema)},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    async with httpx.AsyncClient(timeout=240) as c:
        r = await c.post(f"{(g.get('base_url') or 'https://api.x.ai/v1').rstrip('/')}/chat/completions",
                         headers={"Authorization": f"Bearer {g['api_key']}"}, json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"xAI returned {r.status_code}: {r.text[:300]}")
    content = r.json()["choices"][0]["message"]["content"]
    return _json_from_text(content)


class NextGenAIService:
    def __init__(self):
        self.hub = get_nextgen_hub_service()
        self._slack_users: dict[str, str] = {}

    # ------------------------------------------------------------------
    async def briefing(self) -> dict:
        snap = await self.hub.snapshot()
        if not snap:
            raise ValueError("No snapshot yet — refresh the hub first")
        ux = snap.get("ux") or {}
        compact = {
            "ux_spec": {"release": ux.get("release"), "acs": ux.get("ac_count"), "acs_named_in_tests": ux.get("acs_tested"),
                        "epics": [{"epic": e["epic"], "key": e["epic_key"], "title": e["title"], "jira": e.get("jira"),
                                   "stories": len(e["stories"]), "acs": e["acs"], "acs_tested": e["acs_tested"]}
                                  for e in ux.get("epics", [])]},
            "summary": snap["summary"], "env": {k: snap["env"].get(k) for k in ("url", "version", "healthy", "ready", "login")},
            "domains": snap["domains"], "releases": [r for r in snap["releases"] if r["total"] and r["version"] != "K1-NG-Backlog1.0"][:25],
            "top_epics": snap["epics"][:25], "tests": {k: snap["tests"].get(k) for k in ("ui", "api", "plan", "python")},
            "ci_jobs": snap["tests"].get("ci"), "rule_based_recommendations": snap["recommendations"],
            "open_bugs": [{k: r[k] for k in ("key", "summary", "status", "domain", "priority")}
                          for r in snap["issues"] if r["type"] == "Bug" and r["category"] != "done"][:80],
            "recent_merges": [{k: c[k] for k in ("date", "subject", "keys", "deployed")} for c in snap["recent_changes"][:60]],
        }
        prompt = f"""You are the QA lead for K1-NG, a public-safety command platform rebuilt from scratch, mostly by AI
agents (Claude/Codex) with human gates. Code and tests are written together by the agents, so the QA risk is
in what the agents did NOT think of, what is merged but not deployed or validated, and gaps between Jira and code.

Hub data (JSON): Jira project {snap['project']}, GitLab monorepo, dev environment {snap['env']['url']}:
{json.dumps(compact, default=str)[:90000]}

Write a QA status briefing for the QA manager: a one-line headline, a short status paragraph, the state of each
important domain, the top risks (with evidence from the data), and concrete next steps for manual testers and for
automation. Use the real numbers. Do not repeat the rule-based recommendations word for word — build on them."""
        schema = {
            "type": "object",
            "properties": {
                "headline": {"type": "string"}, "status": {"type": "string"},
                "domains": {"type": "array", "items": {"type": "object", "properties": {
                    "domain": {"type": "string"}, "state": {"type": "string"},
                    "risk": {"type": "string", "enum": ["high", "medium", "low"]}},
                    "required": ["domain", "state", "risk"], "additionalProperties": False}},
                "risks": {"type": "array", "items": {"type": "object", "properties": {
                    "title": {"type": "string"}, "evidence": {"type": "string"},
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]}},
                    "required": ["title", "evidence", "severity"], "additionalProperties": False}},
                "manual_next_steps": {"type": "array", "items": {"type": "string"}},
                "automation_next_steps": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["headline", "status", "domains", "risks", "manual_next_steps", "automation_next_steps"],
            "additionalProperties": False,
        }
        data = await _claude(prompt, schema)
        data["generated_at"] = datetime.now(timezone.utc).isoformat()
        snap["briefing"] = data
        await self.hub._put_setting(SNAPSHOT_KEY, snap)
        return data

    # ------------------------------------------------------------------
    async def alt_tests(self, issue_key: Optional[str], domain: Optional[str], provider: str = "grok",
                        extra: str = "") -> dict:
        cfg = await self.hub.get_config(reveal=True)
        snap = await self.hub.snapshot() or {}
        subject, dom = "", domain
        if issue_key:
            d = await self.hub.issue_detail(issue_key)
            dom = dom or (d.get("row") or {}).get("domain")
            subject = (f"TICKET {d['key']} ({d['type']}, status {d['status']}): {d['summary']}\n"
                       f"Description:\n{d['description'][:6000]}\n"
                       f"Linked: {json.dumps(d['links'])[:1500]}\n"
                       f"Code changes: {json.dumps(d['changes'][:20])[:3000]}")
            ux = self.hub.ux_context(d["key"])
            if ux:
                subject += ("\n\nUX REFERENCE (the agreed UI/UX spec from the K1 prototype and Figma — acceptance "
                            "criteria and the states every surface must handle; test against these):\n" + ux[:12000])
        elif domain:
            bugs = [f"{r['key']} {r['summary']} [{r['status']}]" for r in snap.get("issues", [])
                    if r["domain"] == domain and r["type"] == "Bug"][:60]
            stories = [f"{r['key']} {r['summary']} [{r['status']}]" for r in snap.get("issues", [])
                       if r["domain"] == domain and r["type"] in ("Story", "Task") and r["code_state"] != "none"][:80]
            drow = next((x for x in snap.get("domains", []) if x["domain"] == domain), {})
            subject = (f"DOMAIN {domain}. Risk data: {json.dumps(drow)}\nDelivered stories/tasks:\n" + "\n".join(stories)
                       + "\nBugs found so far:\n" + "\n".join(bugs))
        else:
            raise ValueError("Give a ticket key or a domain")
        existing = (snap.get("test_titles") or {}).get(dom or "", [])[:300]
        prompt = f"""Product: K1-NG, a public-safety command platform (operators watch live/recorded video from VMS
systems such as Milestone XProtect, manage cameras, PTZ, bookmarks, tours, users/roles/permissions, multi-tenant
organisations; NestJS API + Angular web; PostgreSQL with row-level security). It was built mostly by AI agents
that wrote their own tests, so the tests tend to confirm the happy path the agent designed.

{subject}

Automated tests that ALREADY exist for this area (titles; ui = Playwright UI e2e, api = API e2e):
{chr(10).join(existing) if existing else '(none found)'}
{('Extra context from the QA manager: ' + extra) if extra else ''}

As an independent tester, find what is NOT covered: negative paths, permissions and tenant isolation, concurrency
(two operators), failure of external systems (VMS offline, slow network), data edge cases, localisation/RTL,
accessibility, performance under load, upgrade/migration, security. Give an analysis, the coverage gaps, 6-12
manual tests (exploratory/acceptance, real steps a tester can follow on the dev environment) and 6-12 automation
tests with the level (unit, contract, api-e2e, ui-e2e, load, chaos), where they belong in the repo
(platform/tools/e2e/ui/specs/<area>, platform/tools/e2e/api/suites, libs/<scope>/<layer>) and a short sketch.
Do not repeat tests that already exist."""
        used = provider
        if provider == "grok" and cfg["grok"].get("api_key"):
            data = await _grok(cfg, prompt, TEST_SCHEMA)
        else:
            used = "claude"
            data = await _claude(prompt, TEST_SCHEMA)
        data["provider"] = used
        data["subject"] = issue_key or domain
        data["existing_tests_considered"] = len(existing)
        return data

    # ------------------------------------------------------------------
    async def lab_script(self, issue_key: str) -> dict:
        d = await self.hub.issue_detail(issue_key)
        ux = self.hub.ux_context(d["key"])
        ux_block = (f"\nUX REFERENCE — the agreed acceptance criteria and surface states (one step per AC you can check "
                    f"in the UI, named with its AC id):\n{ux[:10000]}\n") if ux else ""
        prompt = f"""Write the BODY of a Playwright script that validates this ticket on the K1-NG dev environment.

TICKET {d['key']} ({d['type']}): {d['summary']}
{d['description'][:6000]}
{ux_block}
The body runs inside an async function. Available (do not import anything, do not launch a browser):
  page, context            Playwright page/context, already open
  login()                  signs in with the QA account (call it first)
  open(route)              navigate to CFG.url + route and wait until the page has rendered
  step(name, async fn)     a named, timed, screenshotted step — throws on failure, so wrap optional checks in try/catch
  expect.visible(selector), expect.text(words), expect.ok(condition, message)
  log(...)                 console line
  CFG.url                  environment base URL (no trailing slash); main routes: {', '.join(DEFAULT_ROUTES)}

Rules: Angular SPA that keeps server-sent-event streams open, so NEVER wait for 'networkidle' (it never
happens) — navigate with open(route), then wait for the specific element you need; prefer getByRole/getByText/getByLabel over CSS;
one step per acceptance criterion; read-only checks unless the ticket is about creating something — then create
data named 'QA-HUB <timestamp>' and clean it up in a final step. Keep it under 120 lines."""
        schema = {"type": "object", "properties": {"script": {"type": "string"}, "explanation": {"type": "string"},
                                                   "manual_checks": {"type": "array", "items": {"type": "string"}}},
                  "required": ["script", "explanation", "manual_checks"], "additionalProperties": False}
        data = await _claude(prompt, schema, max_tokens=8000)
        data["issue_key"] = d["key"]
        data["name"] = f"{d['key']} — {d['summary'][:80]}"
        return data

    # ------------------------------------------------------------------
    async def explain_failure(self, run_id: int, refresh: bool = False) -> dict:
        """Why a lab run failed: product bug, script problem, environment or test data — with the evidence,
        a corrected script when the script is at fault, and a bug draft when the product is."""
        from app.services.nextgen_lab_service import get_nextgen_lab_service
        lab = get_nextgen_lab_service()
        run = await lab.get_run(run_id)
        if not run:
            raise ValueError(f"No lab run #{run_id}")
        if run["status"] in ("pending", "running"):
            raise ValueError("The run is still in progress")
        res = run.get("result") or {}
        if res.get("explanation") and not refresh:
            return res["explanation"]
        if run["status"] == "passed":
            raise ValueError("This run passed — nothing to explain")

        steps = res.get("steps") or []
        failed = next((s for s in steps if not s.get("ok")), None)
        step_lines = "\n".join(f"  {'OK  ' if s.get('ok') else 'FAIL'} {s.get('name')} ({s.get('ms')} ms) {s.get('url', '')}"
                               for s in steps) or "  (no step completed)"
        ticket = ""
        if run.get("issue_key"):
            try:
                d = await self.hub.issue_detail(run["issue_key"])
                ticket = (f"\nTICKET {d['key']} ({d['type']}, {d.get('status', '')}): {d['summary']}\n"
                          f"{(d.get('description') or '')[:4000]}\n")
                ux = self.hub.ux_context(d["key"])
                if ux:
                    ticket += f"\nUX REFERENCE (agreed acceptance criteria):\n{ux[:5000]}\n"
                code = d.get("code_state") or (d.get("row") or {}).get("code_state")
                if code:
                    ticket += f"Code state of the ticket: {code} (is the change deployed on the environment?)\n"
            except Exception as exc:  # the explanation is still useful without the ticket
                ticket = f"\n(ticket {run['issue_key']} could not be read: {exc})\n"

        log_tail = (run.get("log") or "")[-6000:]
        prompt_text = f"""A Playwright run against the K1-NG dev environment ({run.get('env_url')}) failed. Explain why to a QA engineer.

RUN #{run['id']} "{run['name']}" — status {run['status']}
{ticket}
STEPS:
{step_lines}

FAILED STEP: {(failed or {}).get('name', '(none — the script failed outside a step)')}
ERROR: {(failed or {}).get('detail') or (failed or {}).get('error') or res.get('error') or '(none)'}
PAGE AT FAILURE: {(failed or {}).get('url', '')}  title: {(failed or {}).get('title', '')}

ACCESSIBILITY OUTLINE OF THE PAGE AT FAILURE (what the user could actually see/click):
{((failed or {}).get('outline') or '(not captured)')[:10000]}

FAILED API CALLS (status method path):
{chr(10).join(sorted(set(res.get('failedRequests') or []))[:60]) or '(none)'}

BROWSER CONSOLE ERRORS:
{chr(10).join(sorted(set(res.get('console') or []))[:40]) or '(none)'}

SCRIPT:
{run.get('script', '')[:12000]}

LOG (tail):
{log_tail}

Harness facts: login(), open(route) (waits for the rendered shell, never networkidle — the app keeps SSE streams
open), step(), expect.visible/text/ok with 15 s default timeouts; locator.waitFor timing out usually means the
element the script looked for is not on the page — compare the selector with the outline and screenshot.

Decide the most likely verdict:
- product_bug: the app misbehaves vs the ticket/UX spec (wrong data, 4xx/5xx from the API on a valid action, broken page)
- not_deployed: the feature the script checks is not on the environment yet (ticket code not deployed)
- script_issue: the app looks fine but the script used a wrong selector/route/text/timing or a wrong assumption
- environment: environment down/slow, auth/session, certificate, infrastructure
- test_data: missing or unexpected data or permissions for the QA account
- unclear: the evidence is not enough — say what to look at
Base every claim on the evidence above (quote the selector, the outline line, the API call). If the script is at fault,
return a corrected FULL script body in fixed_script (same harness API, keep the passing steps); otherwise fixed_script is "".
If it is a product bug, fill bug with a ready-to-file draft; otherwise leave its fields empty."""
        content: list = [{"type": "text", "text": prompt_text}]
        if failed and failed.get("shot"):
            p = lab.screenshot_path(run_id, failed["shot"])
            if p.exists():
                import base64
                content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                               "data": base64.b64encode(p.read_bytes()).decode()}})
                content.insert(1, {"type": "text", "text": "Screenshot of the page when the step failed."})

        schema = {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["product_bug", "not_deployed", "script_issue", "environment",
                                                       "test_data", "unclear"]},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "summary": {"type": "string"},
                "what_happened": {"type": "string"},
                "evidence": {"type": "array", "items": {"type": "string"}},
                "root_cause": {"type": "string"},
                "next_steps": {"type": "array", "items": {"type": "string"}},
                "fixed_script": {"type": "string"},
                "fix_explanation": {"type": "string"},
                "bug": {"type": "object", "properties": {
                    "title": {"type": "string"}, "steps": {"type": "array", "items": {"type": "string"}},
                    "expected": {"type": "string"}, "actual": {"type": "string"}, "severity": {"type": "string"}},
                    "required": ["title", "steps", "expected", "actual", "severity"], "additionalProperties": False},
            },
            "required": ["verdict", "confidence", "summary", "what_happened", "evidence", "root_cause", "next_steps",
                         "fixed_script", "fix_explanation", "bug"],
            "additionalProperties": False,
        }
        data = await _claude(content, schema, max_tokens=12000)
        data["failed_step"] = (failed or {}).get("name")
        data["generated_at"] = datetime.now(timezone.utc).isoformat()
        data["model"] = AI_MODEL
        await lab.save_explanation(run_id, data)
        return data

    # ------------------------------------------------------------------
    async def slack_feed(self, days: Optional[int] = None, threads: bool = False) -> dict:
        """Messages of every channel matching the configured names/patterns ("next-gen*").
        A private channel is visible only after the bot is invited, so channels that match but
        cannot be read, and missing scopes, are reported as setup hints rather than errors."""
        cfg = await self.hub.get_config(reveal=True)
        sl = cfg["slack"]
        # A user token (xoxp-) reads with that person's own access: every private channel they are in.
        # A bot token (xoxb-) sees private channels only after /invite.
        token = sl.get("user_token") or sl.get("token")
        as_user = bool(sl.get("user_token"))
        if not token:
            return {"configured": False, "channels": []}
        days = days or int(sl.get("days") or 3)
        patterns = [c.strip().lstrip("#").lower() for c in (sl.get("channels") or "").split(",") if c.strip()]
        headers = {"Authorization": f"Bearer {token}"}
        oldest = str((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
        hints = []
        async with httpx.AsyncClient(base_url="https://slack.com/api", headers=headers, timeout=30) as c:
            auth = (await c.post("/auth.test")).json()
            if not auth.get("ok"):
                raise RuntimeError(f"Slack {'user' if as_user else 'bot'} token rejected: {auth.get('error')}")
            workspace = (auth.get("url") or "").rstrip("/")
            channels, cursor, scopes = [], None, ""
            while True:
                resp = await c.get("/conversations.list", params={"types": "public_channel,private_channel",
                                                                  "limit": 1000, "exclude_archived": "true",
                                                                  **({"cursor": cursor} if cursor else {})})
                scopes = resp.headers.get("x-oauth-scopes", scopes)
                r = resp.json()
                if not r.get("ok"):
                    raise RuntimeError(f"Slack: {r.get('error')} (scopes needed: channels:read, groups:read, "
                                       "channels:history, groups:history, users:read)")
                channels += r.get("channels", [])
                cursor = (r.get("response_metadata") or {}).get("next_cursor")
                if not cursor:
                    break
            who = "your user token" if as_user else "the bot token"
            if "users:read" not in scopes:
                hints.append(f"{who[0].upper() + who[1:]} has no users:read scope, so authors show as Slack user IDs — add it and reinstall the app.")

            def matches(ch):
                name = ch["name"].lower()
                return any(fnmatch.fnmatch(name, p) or ch["id"].lower() == p for p in patterns)
            selected = [ch for ch in channels if matches(ch)]
            bot = auth.get("user") or "bot"
            for p in patterns:
                if "*" not in p and not any(ch["name"].lower() == p or ch["id"].lower() == p for ch in channels):
                    hints.append(f"#{p} is not visible to {who}" + ("" if as_user else f" — if it is private, run /invite @{bot} in it."))

            # public channels: the bot can join on its own when it has channels:join
            for ch in selected:
                if not ch.get("is_member") and not ch.get("is_private") and not as_user and "channels:join" in scopes:
                    j = (await c.post("/conversations.join", data={"channel": ch["id"]})).json()
                    ch["is_member"] = bool(j.get("ok"))
            not_member = [ch["name"] for ch in selected if not ch.get("is_member")]
            if not as_user:
                hints.append(f"The bot sees private channels only after /invite @{bot} (visible now: "
                             f"{', '.join('#' + ch['name'] for ch in selected) or 'none'}). To read every next-gen "
                             "channel you are in without inviting it, add a Slack user token in Settings.")
                if any(not ch.get("is_private") for ch in selected if ch["name"] in not_member) and "channels:join" not in scopes:
                    hints.append("Add the channels:join scope so the bot joins the public next-gen channels by itself "
                                 f"({', '.join('#' + n for n in not_member)}), or /invite @{bot} there.")
            out = []
            for ch in sorted(selected, key=lambda x: x["name"]):
                if not ch.get("is_member"):
                    out.append({"name": ch["name"], "id": ch["id"], "messages": [], "private": ch.get("is_private"),
                                "error": ("you are not a member of this channel" if as_user else
                                          f"the bot is not a member — /invite @{bot} in #{ch['name']}")})
                    continue
                h = (await c.get("/conversations.history", params={"channel": ch["id"], "oldest": oldest, "limit": 300})).json()
                if not h.get("ok"):
                    out.append({"name": ch["name"], "id": ch["id"], "error": h.get("error"), "messages": []})
                    continue
                msgs = []
                for m in h.get("messages", []):
                    if m.get("subtype") in ("channel_join", "channel_leave", "channel_purpose", "channel_topic"):
                        continue
                    msg = await self._slack_msg(c, m, workspace, ch["id"])
                    if threads and m.get("reply_count") and len([x for x in msgs if x["thread"]]) < 40:
                        rr = (await c.get("/conversations.replies", params={"channel": ch["id"], "ts": m["ts"], "limit": 100})).json()
                        msg["thread"] = [await self._slack_msg(c, x, workspace, ch["id"]) for x in rr.get("messages", [])[1:]]
                    msgs.append(msg)
                out.append({"name": ch["name"], "id": ch["id"], "messages": msgs, "private": ch.get("is_private")})
        return {"configured": True, "days": days, "workspace": workspace, "bot": auth.get("user"), "as_user": as_user,
                "patterns": patterns, "channels": out, "hints": hints, "not_member": not_member}

    async def _slack_msg(self, c: httpx.AsyncClient, m: dict, workspace: str, channel_id: str) -> dict:
        text = m.get("text") or ""
        for f in m.get("files") or []:
            text += f"\n[file: {f.get('name') or f.get('title')}]"
        return {"ts": m["ts"], "at": datetime.fromtimestamp(float(m["ts"]), timezone.utc).isoformat(),
                "user": await self._slack_user(c, m.get("user") or m.get("bot_id") or ""),
                "text": text[:3000], "replies": m.get("reply_count", 0), "thread": [],
                "link": f"{workspace}/archives/{channel_id}/p{m['ts'].replace('.', '')}" if workspace else None,
                "keys": sorted({f"{a}-{b}" for a, b in KEY_RE.findall(text)}),
                "alerts": sorted({w.lower() for w in ALERT_RE.findall(text)})}

    async def _slack_user(self, c: httpx.AsyncClient, uid: str) -> str:
        if not uid:
            return "?"
        if uid not in self._slack_users:
            try:
                r = (await c.get("/users.info", params={"user": uid})).json()
                u = r.get("user") or {}
                self._slack_users[uid] = (u.get("profile") or {}).get("display_name") or u.get("real_name") or uid
            except Exception:
                self._slack_users[uid] = uid
        return self._slack_users[uid]

    async def slack_summary(self, days: int = 7, notify: bool = True) -> dict:
        """Compile every matched channel (threads included) into one QA-oriented digest."""
        feed = await self.slack_feed(days=days, threads=True)
        if not feed.get("configured"):
            raise ValueError("Slack is not connected — add a bot token in Settings")
        refs: dict[str, dict] = {}
        lines = []
        for ch in feed["channels"]:
            if not ch["messages"]:
                continue
            lines.append(f"\n## #{ch['name']}")
            for m in sorted(ch["messages"], key=lambda x: x["ts"]):
                rid = f"M{len(refs) + 1}"
                refs[rid] = {"channel": ch["name"], "link": m["link"], "at": m["at"], "user": m["user"]}
                lines.append(f"[{rid}] {m['at'][:16]} {m['user']}: {m['text']}")
                for t in m["thread"]:
                    tid = f"M{len(refs) + 1}"
                    refs[tid] = {"channel": ch["name"], "link": t["link"], "at": t["at"], "user": t["user"]}
                    lines.append(f"    [{tid}] ↳ {t['at'][:16]} {t['user']}: {t['text']}")
        if not refs:
            raise ValueError("No messages to summarize — the bot sees no messages in the matched channels "
                             "(invite it to the private next-gen channels).")
        snap = await self.hub.snapshot() or {}
        open_bugs = [f"{r['key']} {r['summary']}" for r in snap.get("issues", [])
                     if r["type"] == "Bug" and r["category"] != "done"][:60]
        prompt = f"""You are the QA manager's assistant for K1-NG (public-safety command platform rebuilt mostly by AI agents).
Below are the last {days} days of the NextGen Slack channels ({', '.join('#' + c['name'] for c in feed['channels'] if c['messages'])}),
threads included. Each message has an id like [M12].

{chr(10).join(lines)[:150000]}

Open K1NG bugs for cross-reference:
{chr(10).join(open_bugs)}

Compile it into one digest so the QA manager does not have to read the channels:
- headline + overview (what happened, what the team is working on, the mood/blockers)
- a short summary per channel
- decisions taken
- action items: who has to do what (owner = the person named or responsible, '' if unclear), due date if stated,
  and mark qa_related=true for anything QA should do, verify, test, or be aware of (deployments to test,
  bugs reported, environment changes, release readiness, test data, regressions, test-plan requests)
- qa_insights: bugs mentioned, risks, environment/deployment changes, release news, test needs — with ticket keys
- open questions nobody answered
Every item cites the message ids it comes from in `refs` (e.g. ["M12","M14"]). Use only what the messages say."""
        ref_list = {"type": "array", "items": {"type": "string"}}
        schema = {
            "type": "object",
            "properties": {
                "headline": {"type": "string"}, "overview": {"type": "string"},
                "channels": {"type": "array", "items": {"type": "object", "properties": {
                    "channel": {"type": "string"}, "summary": {"type": "string"}},
                    "required": ["channel", "summary"], "additionalProperties": False}},
                "decisions": {"type": "array", "items": {"type": "object", "properties": {
                    "text": {"type": "string"}, "refs": ref_list}, "required": ["text", "refs"], "additionalProperties": False}},
                "action_items": {"type": "array", "items": {"type": "object", "properties": {
                    "task": {"type": "string"}, "owner": {"type": "string"}, "due": {"type": "string"},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    "qa_related": {"type": "boolean"}, "refs": ref_list},
                    "required": ["task", "owner", "due", "priority", "qa_related", "refs"], "additionalProperties": False}},
                "qa_insights": {"type": "array", "items": {"type": "object", "properties": {
                    "title": {"type": "string"}, "detail": {"type": "string"},
                    "kind": {"type": "string", "enum": ["bug", "risk", "environment", "release", "test", "other"]},
                    "tickets": {"type": "array", "items": {"type": "string"}}, "refs": ref_list},
                    "required": ["title", "detail", "kind", "tickets", "refs"], "additionalProperties": False}},
                "open_questions": {"type": "array", "items": {"type": "object", "properties": {
                    "question": {"type": "string"}, "refs": ref_list}, "required": ["question", "refs"], "additionalProperties": False}},
            },
            "required": ["headline", "overview", "channels", "decisions", "action_items", "qa_insights", "open_questions"],
            "additionalProperties": False,
        }
        data = await _claude(prompt, schema, max_tokens=16000)

        def resolve(items):
            for it in items:
                it["sources"] = [{"ref": r, **refs[r]} for r in it.get("refs", []) if r in refs]
        for k in ("decisions", "action_items", "qa_insights", "open_questions"):
            resolve(data.get(k, []))
        data.update(generated_at=datetime.now(timezone.utc).isoformat(), days=days,
                    messages=len(refs), channels_read=[c["name"] for c in feed["channels"] if c["messages"]])
        previous = await self.hub._get_setting(SLACK_SUMMARY_KEY) or {}
        done = set(previous.get("done", []))
        data["done"] = sorted(done)
        await self.hub._put_setting(SLACK_SUMMARY_KEY, data)
        if notify:
            seen = set(await self.hub._get_setting("nextgen_slack_actions_seen") or [])
            for it in data["action_items"]:
                ident = re.sub(r"\W+", " ", it["task"].lower()).strip()[:120]
                if it["qa_related"] and ident not in seen:
                    src = (it["sources"] or [{}])[0]
                    await self.hub.notify("warning" if it["priority"] == "high" else "info", "slack",
                                          f"QA action from #{src.get('channel', 'slack')}: {it['task'][:160]}",
                                          f"owner {it['owner'] or '—'} · due {it['due'] or '—'} · {it['priority']}",
                                          src.get("link") or "")
                    seen.add(ident)
            await self.hub._put_setting("nextgen_slack_actions_seen", sorted(seen)[-2000:])
        return data

    async def last_slack_summary(self) -> Optional[dict]:
        return await self.hub._get_setting(SLACK_SUMMARY_KEY)

    async def mark_action(self, task: str, done: bool) -> dict:
        data = await self.last_slack_summary() or {}
        marks = set(data.get("done", []))
        (marks.add if done else marks.discard)(task)
        data["done"] = sorted(marks)
        await self.hub._put_setting(SLACK_SUMMARY_KEY, data)
        return data

    async def auto_slack_summary(self, every_hours: int = 6) -> None:
        last = await self.last_slack_summary()
        if last and last.get("generated_at"):
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last["generated_at"])
            if age < timedelta(hours=every_hours):
                return
        try:
            await self.slack_summary(days=int(((await self.hub.get_config())["slack"].get("days") or 3)))
        except ValueError:
            pass  # nothing to read yet

    async def slack_scan(self) -> None:
        """Background: notify on new alert messages since the last scan."""
        feed = await self.slack_feed(days=1)
        if not feed.get("configured"):
            return
        seen = set(await self.hub._get_setting("nextgen_slack_seen") or [])
        fresh = set()
        for ch in feed["channels"]:
            for m in ch.get("messages", []):
                ident = f"{ch.get('id')}:{m['ts']}"
                fresh.add(ident)
                if ident not in seen and seen and (m["alerts"] or m["keys"]):
                    await self.hub.notify("warning" if m["alerts"] else "info", "slack",
                                          f"#{ch['name']} — {m['user']}: {m['text'][:140]}",
                                          f"alerts: {', '.join(m['alerts']) or '-'} · tickets: {', '.join(m['keys']) or '-'}")
        await self.hub._put_setting("nextgen_slack_seen", sorted(seen | fresh)[-3000:])

    # ------------------------------------------------------------------
    async def test_connectors(self) -> dict:
        cfg = await self.hub.get_config(reveal=True)
        out = {}
        t0 = time.perf_counter()
        env = await self.hub.check_env(cfg, persist=False)
        out["environment"] = {"ok": env_up(env),
                              "detail": f"version {(env.get('version') or {}).get('version')} sha "
                                        f"{((env.get('version') or {}).get('gitSha') or '')[:8]}" if env.get("version") else env.get("error")}
        out["qa_account"] = ({"ok": None, "detail": "no QA account configured"} if env.get("login") is None else
                             {"ok": env["login"].get("ok"), "detail": json.dumps(env["login"])[:300]})
        try:
            repo = self.hub._repo_dir(cfg)
            from app.services.nextgen_hub_service import _git
            head = await asyncio.to_thread(_git, repo, "log", "-1", "--format=%h %aI %s", "origin/main")
            out["repository"] = {"ok": True, "detail": f"{repo}: {head.strip()[:120]}"}
        except Exception as exc:
            out["repository"] = {"ok": False, "detail": str(exc)[:300]}
        try:
            from app.jira.client import get_jira_client
            p = await get_jira_client().get(f"/project/{cfg['jira']['project']}")
            out["jira"] = {"ok": True, "detail": f"{p.get('key')} — {p.get('name')}"}
        except Exception as exc:
            out["jira"] = {"ok": False, "detail": str(exc)[:300]}
        slack_token = cfg["slack"].get("user_token") or cfg["slack"].get("token")
        if slack_token:
            kind = "user token" if cfg["slack"].get("user_token") else "bot"
            try:
                async with httpx.AsyncClient(timeout=20) as c:
                    r = (await c.post("https://slack.com/api/auth.test", headers={"Authorization": f"Bearer {slack_token}"})).json()
                out["slack"] = {"ok": r.get("ok"), "detail": f"{r.get('team')} as {r.get('user')} ({kind})" if r.get("ok") else r.get("error")}
            except Exception as exc:
                out["slack"] = {"ok": False, "detail": str(exc)[:200]}
        else:
            out["slack"] = {"ok": None, "detail": "no Slack token"}
        if cfg["grok"].get("api_key"):
            try:
                async with httpx.AsyncClient(timeout=30) as c:
                    r = await c.get(f"{cfg['grok']['base_url'].rstrip('/')}/models", headers={"Authorization": f"Bearer {cfg['grok']['api_key']}"})
                ids = [m.get("id") for m in (r.json().get("data") or [])] if r.status_code == 200 else []
                out["grok"] = {"ok": r.status_code == 200, "detail": ", ".join(ids[:8]) if ids else r.text[:200]}
            except Exception as exc:
                out["grok"] = {"ok": False, "detail": str(exc)[:200]}
        else:
            out["grok"] = {"ok": None, "detail": "no xAI API key — Claude is used for alternative tests"}
        s = get_settings()
        out["claude"] = {"ok": bool(s.anthropic_api_key), "detail": AI_MODEL if s.anthropic_api_key else "ANTHROPIC_API_KEY missing"}
        out["figma"] = {"ok": bool(s.figma_api_token), "detail": "token set" if s.figma_api_token else "FIGMA_API_TOKEN missing"}
        out["took_ms"] = round((time.perf_counter() - t0) * 1000)
        return out


_service: Optional[NextGenAIService] = None


def get_nextgen_ai_service() -> NextGenAIService:
    global _service
    if _service is None:
        _service = NextGenAIService()
    return _service

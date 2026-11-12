"""
NextGen Playwright Lab — run Playwright scripts against the NextGen environment from inside the hub.

A run is the user's script body wrapped in a fixed harness that gives it:
  page, context      a fresh Chromium page (HTTPS errors ignored — the lab env uses an internal CA)
  login(user?, pw?)  signs in through /sign-in with the hub's QA account
  open(route)        navigates and waits for the rendered page (never 'networkidle': SSE streams stay open)
  step(name, fn)     a named step: timed, screenshotted, recorded pass/fail (a failure throws)
  expect.visible(selector) / expect.text(words) / expect.ok(cond, msg)
  log(...)           a line in the live console
  CFG                { url, user, routes }
Console errors and every failed (>=400) XHR/fetch are recorded for the whole run.

The harness prints one RESULT_JSON line at the end; the node process runs in a thread
(Windows' Proactor loop has trouble with asyncio subprocess pipes — same as the Validation Portal).
"""
import asyncio
import json
import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import select

from app.database.db import NextGenLabRunORM, get_session_factory

logger = logging.getLogger(__name__)

LAB_DIR = Path(__file__).parent.parent.parent / "data" / "nextgen_lab"
RESULT_MARKER = "RESULT_JSON:"
DEFAULT_ROUTES = ["/overview", "/activity", "/users", "/roles", "/organizations", "/sessions", "/features",
                  "/password-policy", "/settings", "/video"]

HARNESS = r"""
const { chromium } = require('playwright');
const CFG = JSON.parse(process.env.LAB_CONFIG);
const out = { steps: [], console: [], failedRequests: [], passed: false, error: null };
const log = (...a) => console.log('[lab]', ...a);
(async () => {
  let browser;
  try { browser = await chromium.launch(CFG.channel ? { channel: CFG.channel } : {}); }
  catch (e) { log('bundled Chromium unavailable, using installed Chrome'); browser = await chromium.launch({ channel: 'chrome' }); }
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') out.console.push(m.text().slice(0, 300)); });
  page.on('response', r => {
    const t = r.request().resourceType();
    if ((t === 'xhr' || t === 'fetch') && r.status() >= 400)
      out.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().replace(CFG.url, '')}`.slice(0, 250));
  });
  let shots = 0;
  async function snap() { const p = `${CFG.shotPrefix}_${++shots}.png`; await page.screenshot({ path: p }).catch(() => {}); return shots; }
  async function step(name, fn) {
    const t0 = Date.now(); log('step:', name);
    try {
      await fn();
      out.steps.push({ name, ok: true, ms: Date.now() - t0, shot: await snap(), url: page.url() });
      log(`  ok (${Date.now() - t0} ms)`);
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0].slice(0, 600);
      out.steps.push({ name, ok: false, ms: Date.now() - t0, error: msg, shot: await snap(), url: page.url() });
      log('  FAILED:', msg);
      throw e;
    }
  }
  // K1-NG keeps server-sent-event streams open (flags, users, camera status), so the network
  // never goes idle: wait for the rendered shell instead of 'networkidle'.
  async function open(route, ms = 30000) {
    await page.goto(CFG.url + route, { waitUntil: 'domcontentloaded', timeout: ms });
    await page.locator('main, [role=main], router-outlet + *').first().waitFor({ state: 'attached', timeout: ms }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('mat-progress-spinner, mat-spinner, .mat-mdc-progress-spinner, [aria-busy=true]'),
      null, { timeout: ms }).catch(() => {});
    await page.waitForTimeout(600);
  }
  async function login(user = CFG.user, password = CFG.password) {
    if (!user || !password) throw new Error('No QA account configured in the hub settings');
    await page.goto(CFG.url + '/sign-in', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[type=password]').first().waitFor({ state: 'visible', timeout: 60000 });
    await page.locator('input[autocomplete=username], input[type=email]').first().fill(user);
    await page.locator('input[type=password]').first().fill(password);
    // click and wait together: waiting after a bare click can resolve before the request starts
    await Promise.all([
      page.waitForURL(u => !String(u).includes('/sign-in'), { timeout: 30000 }),
      page.locator('button[type=submit]').first().click(),
    ]);
    await page.waitForTimeout(1000);
  }
  const expect = {
    async visible(selector, ms = 15000) { await page.locator(selector).first().waitFor({ state: 'visible', timeout: ms }); },
    async text(words, ms = 15000) { await page.getByText(words, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }); },
    ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); },
  };
  try {
    /*__USER_SCRIPT__*/
    out.passed = out.steps.length > 0 && out.steps.every(s => s.ok);
  } catch (e) {
    out.error = String((e && e.message) || e).split('\n')[0].slice(0, 1000);
  } finally {
    await browser.close().catch(() => {});
    console.log('RESULT_JSON:' + JSON.stringify(out));
  }
})().catch(e => { console.log('RESULT_JSON:' + JSON.stringify({ ...out, error: String(e.message || e) })); });
"""

TEMPLATES = {
    "smoke": {
        "name": "Smoke — sign in and open every main page",
        "script": """// Sign in, open every main page, record console errors and failed API calls.
await step('Sign in', () => login());
for (const route of CFG.routes) {
  try {
    await step(`Open ${route}`, async () => {
      await open(route);
      expect.ok(!page.url().includes('/sign-in'), 'bounced back to sign-in');
      const text = (await page.locator('body').innerText()).trim();
      expect.ok(text.length > 40, 'the page rendered (almost) nothing');
      expect.ok(!/something went wrong|unexpected error|not found/i.test(text), 'the page shows an error');
    });
  } catch (e) { /* the failed step is recorded; keep going */ }
}
""",
    },
    "login": {
        "name": "Sign-in only",
        "script": """await step('Sign in', () => login());
await step('Shell is shown', () => expect.visible('nav, mat-sidenav, [role=navigation]'));
""",
    },
    "blank": {
        "name": "Blank script",
        "script": """await step('Sign in', () => login());
await step('Open the video wall', async () => {
  await open('/video');
  await expect.visible('body');
});
""",
    },
}


def _node_path() -> str:
    root_modules = Path(__file__).parent.parent.parent.parent / "node_modules"
    parts = [str(root_modules)]
    if os.environ.get("NODE_PATH"):
        parts.append(os.environ["NODE_PATH"])
    return os.pathsep.join(parts)


def _iso(d):
    return d.isoformat() if d else None


class NextGenLabService:
    def __init__(self):
        self.live: dict[int, list[str]] = {}
        self._tasks: set = set()

    async def create_run(self, name: str, script: str, cfg: dict, issue_key: Optional[str] = None,
                         kind: str = "script", routes: Optional[list[str]] = None) -> dict:
        async with get_session_factory()() as session:
            row = NextGenLabRunORM(name=name[:200] or "Lab run", issue_key=(issue_key or "").upper() or None,
                                   kind=kind, env_url=cfg["env"]["url"], script=script, status="pending")
            session.add(row)
            await session.commit()
            run_id = row.id
        self.live[run_id] = []
        task = asyncio.create_task(self._execute(run_id, script, cfg, routes or DEFAULT_ROUTES))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return await self.get_run(run_id)

    async def _set(self, run_id: int, **values) -> None:
        async with get_session_factory()() as session:
            row = await session.get(NextGenLabRunORM, run_id)
            for k, v in values.items():
                setattr(row, k, v)
            await session.commit()

    async def _execute(self, run_id: int, script: str, cfg: dict, routes: list[str]) -> None:
        LAB_DIR.mkdir(parents=True, exist_ok=True)
        js = LAB_DIR / f"run_{run_id}.js"
        js.write_text(HARNESS.replace("/*__USER_SCRIPT__*/", script), encoding="utf-8")
        lab_cfg = {"url": cfg["env"]["url"].rstrip("/"), "user": cfg["env"].get("user") or "",
                   "password": cfg["env"].get("password") or "", "routes": routes,
                   "shotPrefix": str(LAB_DIR / f"run_{run_id}"), "channel": os.environ.get("PW_CHANNEL") or None}
        env = {**os.environ, "LAB_CONFIG": json.dumps(lab_cfg), "NODE_PATH": _node_path()}
        node = shutil.which("node") or "node"
        lines = self.live.setdefault(run_id, [])
        await self._set(run_id, status="running")

        def _blocking() -> int:
            proc = subprocess.Popen([node, str(js)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                for raw in iter(proc.stdout.readline, b""):
                    lines.append(raw.decode("utf-8", "ignore").rstrip())
                return proc.wait(timeout=900)
            except subprocess.TimeoutExpired:
                proc.kill()
                lines.append("[lab] killed after 15 minutes")
                return -1

        try:
            code = await asyncio.to_thread(_blocking)
            text = "\n".join(lines)
            result = None
            idx = text.rfind(RESULT_MARKER)
            if idx >= 0:
                try:
                    result, _ = json.JSONDecoder().raw_decode(text[idx + len(RESULT_MARKER):])
                except ValueError:
                    result = None
            log = "\n".join(l for l in lines if not l.startswith(RESULT_MARKER))
            if result is None:
                status = "error"
                result = {"error": f"The script reported no result (exit code {code})", "steps": []}
            else:
                status = "passed" if result.get("passed") else "failed"
            await self._set(run_id, status=status, log_output=log[-200_000:], result_json=json.dumps(result),
                            finished_at=datetime.now(timezone.utc))
            if status != "passed":
                from app.services.nextgen_hub_service import get_nextgen_hub_service
                run = await self.get_run(run_id)
                failed = next((s for s in result.get("steps", []) if not s.get("ok")), None)
                await get_nextgen_hub_service().notify(
                    "warning", "lab", f"Lab run #{run_id} {status}: {run['name']}",
                    (failed or {}).get("error") or result.get("error") or "", run.get("issue_key") or "")
        except Exception as exc:
            logger.error("Lab run %s crashed: %s", run_id, exc, exc_info=True)
            await self._set(run_id, status="error", log_output="\n".join(lines)[-200_000:],
                            result_json=json.dumps({"error": str(exc), "steps": []}),
                            finished_at=datetime.now(timezone.utc))
        finally:
            self.live.pop(run_id, None)

    async def mark_interrupted(self) -> None:
        """A restart kills the node processes; their rows would otherwise stay 'running' forever."""
        async with get_session_factory()() as session:
            rows = (await session.execute(select(NextGenLabRunORM).where(
                NextGenLabRunORM.status.in_(("pending", "running"))))).scalars().all()
            for r in rows:
                r.status = "error"
                r.result_json = json.dumps({"error": "Interrupted by a server restart", "steps": []})
            await session.commit()

    async def get_run(self, run_id: int) -> Optional[dict]:
        async with get_session_factory()() as session:
            r = await session.get(NextGenLabRunORM, run_id)
        if not r:
            return None
        live = self.live.get(run_id)
        return {"id": r.id, "name": r.name, "issue_key": r.issue_key, "kind": r.kind, "env_url": r.env_url,
                "script": r.script, "status": r.status,
                "log": "\n".join(live) if live is not None else (r.log_output or ""),
                "result": json.loads(r.result_json) if r.result_json else None,
                "created_at": _iso(r.created_at), "finished_at": _iso(r.finished_at)}

    async def list_runs(self, limit: int = 50) -> list[dict]:
        async with get_session_factory()() as session:
            rows = (await session.execute(select(NextGenLabRunORM).order_by(NextGenLabRunORM.id.desc()).limit(limit))).scalars().all()
        out = []
        for r in rows:
            res = json.loads(r.result_json) if r.result_json else {}
            steps = res.get("steps") or []
            out.append({"id": r.id, "name": r.name, "issue_key": r.issue_key, "kind": r.kind, "status": r.status,
                        "steps": len(steps), "failed_steps": sum(1 for s in steps if not s.get("ok")),
                        "created_at": _iso(r.created_at), "finished_at": _iso(r.finished_at)})
        return out

    @staticmethod
    def screenshot_path(run_id: int, n: int) -> Path:
        return LAB_DIR / f"run_{run_id}_{int(n)}.png"


_service: Optional[NextGenLabService] = None


def get_nextgen_lab_service() -> NextGenLabService:
    global _service
    if _service is None:
        _service = NextGenLabService()
    return _service

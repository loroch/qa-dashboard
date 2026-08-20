"""
Automation Runner Service — Test Generator Phase 2.

Pipeline per run: fetch the Jira Test issue's steps -> run a fixed (non-AI)
reconnaissance pass against the target app to discover its login form and
page structure -> ask Claude to draft a Playwright script for those specific
steps -> execute it as a subprocess -> record pass/fail per step -> update
Jira (per the user's explicit call: pass chains transitions to Done since
this workflow has no direct one-step transition there; fail leaves the
status untouched and posts a comment instead, since this Jira workflow has
no "Failed" status for Test issues) -> on failure, save a bug candidate for
review (not auto-filed as a real Jira Bug).

AI-drafted scripts are inherently best-effort per run, not a hand-maintained
stable suite — see the design note in the approved plan.
"""
import asyncio
import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import anthropic
from sqlalchemy import select

from app.config import get_settings
from app.database.db import (
    AutomationBugCandidateORM,
    AutomationRunORM,
    AutomationRunResultORM,
    get_session_factory,
)
from app.jira.client import get_jira_client

logger = logging.getLogger(__name__)

SCRATCH_DIR = Path(tempfile.gettempdir()) / "qa-dashboard-automation-runs"
SCRATCH_DIR.mkdir(parents=True, exist_ok=True)

RESULT_MARKER = "RESULT_JSON:"


def _extract_text(adf) -> str:
    """Recursively extract plain text from an ADF document (same pattern as
    test_generator_service._extract_text / release_notes_service._extract_text)."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf
    if isinstance(adf, dict):
        if adf.get("type") == "text":
            return adf.get("text", "")
        return " ".join(t for t in (_extract_text(c) for c in adf.get("content", [])) if t)
    if isinstance(adf, list):
        return " ".join(t for t in (_extract_text(i) for i in adf) if t)
    return ""


# Fixed (non-AI) reconnaissance script: navigate, attempt login if a login
# form is present, dump a compact summary of the resulting page's structure.
RECON_SCRIPT = r"""
const { chromium } = require('playwright');

(async () => {
  const targetUrl = process.argv[2];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const out = { url: targetUrl, title: '', loggedIn: false, loginAttempted: false, elements: [], error: null };

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const emailField = page.locator('#email, input[type="email"], input[name="email"]').first();
    const passwordField = page.locator('#password, input[type="password"], input[name="password"]').first();
    if (await emailField.count() && await passwordField.count() && process.env.WEBCLIENT_USER) {
      out.loginAttempted = true;
      await emailField.fill(process.env.WEBCLIENT_USER);
      await passwordField.fill(process.env.WEBCLIENT_PASSWORD || '');
      const submitBtn = page.locator('button[type="submit"]').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
        submitBtn.click(),
      ]);
      await page.waitForTimeout(2000);
      out.loggedIn = true;
    }

    out.title = await page.title();
    out.url = page.url();

    out.elements = await page.evaluate(() => {
      const sel = 'button, a, input, textarea, select, [role="button"], h1, h2, h3, label';
      return Array.from(document.querySelectorAll(sel)).slice(0, 150).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        id: el.id || null,
        name: el.getAttribute('name') || null,
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
      })).filter(e => e.text || e.id || e.name);
    });
  } catch (e) {
    out.error = e.message;
  } finally {
    await browser.close();
    console.log('RECON_JSON:' + JSON.stringify(out));
  }
})();
"""


class AutomationRunnerService:
    def __init__(self):
        self.jira = get_jira_client()

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------

    async def create_run(self, jira_test_key: str, target_url: str, story_key: Optional[str] = None) -> int:
        factory = get_session_factory()
        async with factory() as session:
            run = AutomationRunORM(
                jira_test_key=jira_test_key, story_key=story_key,
                target_url=target_url, status="pending",
            )
            session.add(run)
            await session.commit()
            await session.refresh(run)
            return run.id

    async def get_run(self, run_id: int) -> Optional[dict]:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(AutomationRunORM, run_id)
            if not run:
                return None
            return self._run_to_dict(run)

    async def get_screenshot_path(self, run_id: int) -> Optional[str]:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(AutomationRunORM, run_id)
            return run.screenshot_path if run else None

    async def get_run_results(self, run_id: int) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(
                select(AutomationRunResultORM).where(AutomationRunResultORM.run_id == run_id)
                .order_by(AutomationRunResultORM.step_index)
            )).scalars().all()
            return [
                {
                    "step_index": r.step_index, "description": r.description,
                    "status": r.status, "screenshot_path": r.screenshot_path,
                    "error_text": r.error_text,
                    "element_box": json.loads(r.element_box) if r.element_box else None,
                }
                for r in rows
            ]

    # ------------------------------------------------------------------
    # Story-centric views (persistent "Automation" tab)
    # ------------------------------------------------------------------

    async def get_tests_for_story(self, story_key: str) -> list[dict]:
        """Test issues already linked to a story/task via the "Test Case" link
        (the same link type test_generator_service.create_test_cases creates)."""
        settings = get_settings()
        issue = await self.jira.get_issue(story_key, fields=["issuelinks"])
        links = issue.get("fields", {}).get("issuelinks") or []

        test_keys = []
        for link in links:
            link_type = (link.get("type") or {}).get("name", "")
            if "test" not in link_type.lower():
                continue
            other = link.get("inwardIssue") or link.get("outwardIssue")
            if other and other.get("key"):
                test_keys.append(other["key"])

        if not test_keys:
            return []

        keys_clause = ", ".join(f'"{k}"' for k in test_keys)
        jql = f'key in ({keys_clause}) AND issuetype = Test ORDER BY key ASC'
        tests = await self.jira.search_issues(jql, fields=["summary", "status"], max_total=len(test_keys))
        return [
            {
                "key": t["key"],
                "url": f"{settings.jira_base_url}/browse/{t['key']}",
                "summary": t.get("fields", {}).get("summary", ""),
                "status": (t.get("fields", {}).get("status") or {}).get("name", ""),
            }
            for t in tests
        ]

    async def get_latest_runs_for_story(self, story_key: str) -> dict:
        """Most recent automation run per Test issue for this story — the
        persistent view (survives leaving/reopening the page, unlike the
        in-session wizard state)."""
        factory = get_session_factory()
        async with factory() as session:
            rows = (await session.execute(
                select(AutomationRunORM)
                .where(AutomationRunORM.story_key == story_key)
                .order_by(AutomationRunORM.created_at.desc())
            )).scalars().all()

        latest_by_test: dict[str, AutomationRunORM] = {}
        for run in rows:
            if run.jira_test_key not in latest_by_test:
                latest_by_test[run.jira_test_key] = run
        return {key: self._run_to_dict(run) for key, run in latest_by_test.items()}

    async def run_batch(self, story_key: str, target_url: str) -> list[dict]:
        """Run automation for every Test issue currently linked to a story,
        sequentially (concurrent headless Chromium instances are resource-heavy
        and this keeps failures easy to attribute). All run rows are created
        upfront (status "pending") before any execution starts, so polling
        GET /story/{key}/runs shows the full queue immediately rather than
        tests appearing one at a time as their turn comes up."""
        tests = await self.get_tests_for_story(story_key)
        queued = [(test["key"], await self.create_run(test["key"], target_url, story_key)) for test in tests]
        results = []
        for jira_test_key, run_id in queued:
            result = await self.execute(run_id)
            results.append({"jira_test_key": jira_test_key, **result})
        return results

    @staticmethod
    def _run_to_dict(run: AutomationRunORM) -> dict:
        return {
            "id": run.id, "jira_test_key": run.jira_test_key, "story_key": run.story_key,
            "target_url": run.target_url, "status": run.status, "summary": run.summary,
            "error_text": run.error_text, "jira_status_action": run.jira_status_action,
            "log_output": run.log_output, "has_screenshot": bool(run.screenshot_path),
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        }

    async def _update_run(self, run_id: int, **fields):
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(AutomationRunORM, run_id)
            for k, v in fields.items():
                setattr(run, k, v)
            await session.commit()

    # ------------------------------------------------------------------
    # Full pipeline
    # ------------------------------------------------------------------

    async def execute(self, run_id: int) -> dict:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(AutomationRunORM, run_id)
            if not run:
                raise ValueError(f"No automation run with id {run_id}")
            jira_test_key, target_url, story_key = run.jira_test_key, run.target_url, run.story_key

        await self._update_run(run_id, status="running", started_at=datetime.now(timezone.utc), log_output="")

        try:
            await self._append_log(run_id, f"Fetching Jira Test {jira_test_key}...")
            test_issue = await self.jira.get_issue(jira_test_key, fields=["summary", "description"])
            fields = test_issue.get("fields", {})
            steps_text = _extract_text(fields.get("description")) or fields.get("summary", "")

            await self._append_log(run_id, f"Running reconnaissance against {target_url} ...")
            recon = await self._run_recon(target_url)
            await self._append_log(
                run_id,
                f"Reconnaissance done — loginAttempted={recon.get('loginAttempted')}, "
                f"resulting title={recon.get('title')!r}, url={recon.get('url')!r}",
            )

            await self._append_log(run_id, "Drafting Playwright script with Claude...")
            screenshot_path = SCRATCH_DIR / f"run_{run_id}_screenshot.png"
            script = await self._draft_script(
                jira_test_key, fields.get("summary", ""), steps_text, target_url, recon, screenshot_path,
            )
            await self._append_log(run_id, f"Script drafted ({len(script)} chars). Executing...")

            script_path = SCRATCH_DIR / f"run_{run_id}.js"
            script_path.write_text(script, encoding="utf-8")
            await self._update_run(run_id, script_path=str(script_path))

            result = await self._execute_script(script_path, run_id)

            if screenshot_path.exists():
                await self._update_run(run_id, screenshot_path=str(screenshot_path))

            factory = get_session_factory()
            async with factory() as session:
                for i, step in enumerate(result.get("steps", [])):
                    box = step.get("box")
                    session.add(AutomationRunResultORM(
                        run_id=run_id, step_index=i,
                        description=step.get("description", ""),
                        status="passed" if step.get("passed") else "failed",
                        error_text=step.get("error"),
                        element_box=json.dumps(box) if box else None,
                    ))
                await session.commit()

            passed = bool(result.get("passed"))
            await self._append_log(run_id, f"Done. {result.get('summary', '')}")
            await self._update_run(
                run_id,
                status="passed" if passed else "failed",
                summary=result.get("summary", ""),
                error_text=result.get("error"),
                finished_at=datetime.now(timezone.utc),
            )

            jira_action = await self._apply_jira_status(jira_test_key, passed, result)
            await self._update_run(run_id, jira_status_action=jira_action)

            if not passed:
                await self._create_bug_candidate(run_id, jira_test_key, story_key, fields.get("summary", ""), result)

            return {"run_id": run_id, "status": "passed" if passed else "failed", "jira_status_action": jira_action}

        except Exception as exc:
            logger.error("Automation run %s errored: %s", run_id, exc, exc_info=True)
            await self._update_run(
                run_id, status="error", error_text=str(exc),
                finished_at=datetime.now(timezone.utc),
            )
            return {"run_id": run_id, "status": "error", "error": str(exc)}

    # ------------------------------------------------------------------
    # Steps
    # ------------------------------------------------------------------

    async def _run_recon(self, target_url: str) -> dict:
        recon_path = SCRATCH_DIR / "_recon.js"
        recon_path.write_text(RECON_SCRIPT, encoding="utf-8")

        proc = await asyncio.create_subprocess_exec(
            "node", str(recon_path), target_url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=self._script_env(),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
        text = stdout.decode("utf-8", errors="ignore")
        match = re.search(r"RECON_JSON:(\{.*\})\s*$", text, re.DOTALL)
        if not match:
            logger.warning("Recon produced no RECON_JSON line. stderr: %s", stderr.decode("utf-8", errors="ignore")[:1000])
            return {"url": target_url, "title": "", "loggedIn": False, "elements": [], "error": "recon_failed"}
        return json.loads(match.group(1))

    async def _draft_script(
        self, jira_test_key: str, summary: str, steps_text: str, target_url: str, recon: dict, screenshot_path: Path,
    ) -> str:
        settings = get_settings()
        if not settings.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is not set. Add it to your .env file.")

        elements_json = json.dumps(recon.get("elements", [])[:80])
        prompt = f"""You are a senior QA automation engineer. Write a complete, self-contained Node.js Playwright script
that automates the test case below against the real running application.

## Test case: {jira_test_key} — {summary}
{steps_text}

## Target URL
{target_url}

## Live reconnaissance of the target page (already fetched for you)
- Resulting title after navigation{"  + login attempt" if recon.get("loginAttempted") else ""}: {recon.get("title")}
- Resulting URL: {recon.get("url")}
- Login form was {"found and a login was attempted" if recon.get("loginAttempted") else "not detected — no login needed or form not found"}
- Visible interactive elements (tag/type/id/name/text), truncated: {elements_json}

## Hard requirements for the script you write
1. `const {{ chromium }} = require('playwright');` — headless chromium, `ignoreHTTPSErrors: true`.
2. Read credentials ONLY from `process.env.WEBCLIENT_USER` / `process.env.WEBCLIENT_PASSWORD` — never hardcode a value you see above.
3. Reuse the exact login selectors already confirmed above (e.g. `#email`, `#password`, `button[type="submit"]`) if a login was attempted — don't guess new ones. This app is an Angular SPA: the login form does NOT exist in the DOM at `domcontentloaded` — it only renders after Angular finishes bootstrapping. The reconnaissance pass above only succeeded because it used `waitUntil: 'networkidle'` for the initial `page.goto()`; use the SAME `networkidle` wait (not `domcontentloaded`, not a fixed timeout) for your initial navigation, or your login check will run before the form exists and every subsequent step will cascade-fail even though the app is working fine.
   After clicking submit, do NOT call `await submitBtn.click()` followed by a separate `await page.waitForLoadState('networkidle')` — this is a confirmed race condition (reproduced directly): if no request has fired yet at the exact instant `waitForLoadState` is called, it can resolve instantly, before the async login request even starts, making you check the URL while still on the login page even though the login is genuinely still in flight and would have succeeded moments later. Instead, start waiting and click together, e.g.:
   ```
   await Promise.all([
     page.waitForURL(url => !url.toString().includes('/auth/login'), {{ timeout: 15000 }}),
     submitBtn.click(),
   ]);
   ```
   (adjust the URL predicate to whatever "logged in" looks like for this app). Only fall back to checking `page.url()` after that `Promise.all` resolves or times out.
4. If a login was required, the app redirects post-login to a generic dashboard of "workspace" cards — it does NOT resume the originally requested deep link on its own, and a raw `page.goto({target_url})` re-navigation after login has repeatedly landed back on that same dashboard instead of the real target. The workspace cards render asynchronously — searching for them immediately after login fails with 0 matches even though they appear moments later, so wait BEFORE searching, not after. Use EXACTLY this code, right after login:
   ```
   console.log('Waiting 10 seconds for the dashboard to finish rendering workspace cards...');
   await page.waitForTimeout(10000);
   console.log('Looking for the Events workspace card...');
   const cardLinks = page.locator('a.fulllink[href*="/workspaces/"]');
   const cardCount = await cardLinks.count();
   let wentToEvents = false;
   for (let i = 0; i < cardCount; i++) {{
     const link = cardLinks.nth(i);
     const card = link.locator('xpath=ancestor::div[contains(@class,"app-workspace-card")][1]');
     const cardText = await card.innerText().catch(() => '');
     if (cardText.includes('אירועים') || cardText.toLowerCase().includes('event')) {{
       console.log('Found Events workspace card, clicking it. Card text:', cardText);
       // The <a> itself is often not the visually-clickable box (it's sized via a
       // ::before pseudo-element) — Playwright's visibility check on the raw <a>
       // can fail even though the card is genuinely visible and clickable. Click
       // the card container, with force:true as a fallback, instead of the link.
       await card.scrollIntoViewIfNeeded();
       await card.click({{ force: true }}).catch(() => link.click({{ force: true }}));
       await page.waitForLoadState('networkidle');
       wentToEvents = true;
       break;
     }}
   }}
   if (!wentToEvents) {{
     console.log('Events workspace card not found among', cardCount, 'workspace cards — falling back to direct URL navigation.');
     await page.goto({json.dumps(target_url)}, {{ waitUntil: 'networkidle' }});
   }}
   ```
   Once on the Events page (whether via the card click or the URL fallback), wait another `await page.waitForTimeout(10000)` before looking for any table/row content — the destination page's own data needs this same settling time to populate, even though `networkidle` has already fired.
   IMPORTANT — this app's address bar is NOT a reliable signal of what's actually rendered, and generic class-fragment selectors (`[class*="table"]`, `button[class*="toggle"]`) have repeatedly matched the WRONG element on the dashboard (e.g. a workspace-card container mistaken for the real data table, or the sidebar-collapse button mistaken for a feature toggle) rather than failing cleanly. Prefer asserting on something only the real target page has — specific visible header/column text, a heading matching the page's own title — over generic class-name fragments. Never decide a step passed just because *some* element matched a loose selector; confirm it's plausibly the right one (right general area of the page, right visible text nearby) before trusting it.
5. Use `console.log(...)` liberally before/after each meaningful action (navigation, login, each step) describing what you're about to do and what you found — these lines are streamed live to a QA engineer watching the run, so make them human-readable progress notes, not debug noise.
6. Break the test case's steps into discrete checks. For each one, attempt it and record `{{description, passed, error, box}}` in a `steps` array — a step that can't be verified (e.g. a UI element doesn't exist) is `passed: false` with a clear `error`, NOT a thrown exception that kills the whole run. `box` is `null` UNLESS you located a specific element for that check — in that case call `await element.scrollIntoViewIfNeeded()` then `const box = await element.boundingBox()` and set `box: box` (an object with `x, y, width, height`, page-viewport pixels). When checking computed styles (background, border, font) on a table header, operate on the actual `<th>`/`[role="columnheader"]` element itself — not an inner text-wrapping `<span>`/`<div>` inside it, which commonly reports transparent background / no border even when the real header cell has both. Prefer `el.closest('th, [role="columnheader"]') || el` before reading `getComputedStyle`. NEVER read a computed style via `page.evaluate((el) => {{...}}, someLocator)` — passing a Locator as the second argument to `page.evaluate` makes Playwright try to serialize the Locator object itself and throws `Attempting to serialize unexpected value at position "_frame._platform.boxedStackPrefixes"`. This applies equally to `page.evaluateHandle(fn, someLocator)` — same failure, same fix. Always call `.evaluate()` / `.evaluateHandle()` directly ON the locator instead: `await someLocator.evaluate((el) => {{ const style = window.getComputedStyle(el); return style.textAlign; }})` — this resolves the element internally and passes only the DOM node into the callback.
7. On the FIRST step failure only, immediately after computing that step's `box` (if any) and with NO further scrolling or navigation in between, take a single non-fullPage screenshot: `await page.screenshot({{ path: {json.dumps(screenshot_path.as_posix())} }})` — non-fullPage is required so the image's pixel coordinates match `box` exactly (a fullPage stitched screenshot would not). Do this only once for the whole run.
8. Wrap the ENTIRE script body in a top-level try/catch/finally. In `finally`, ALWAYS print exactly one line to stdout, starting at the beginning of the line with `{RESULT_MARKER}`, followed by a single JSON object: `{{"passed": bool, "summary": "one sentence", "error": string|null, "steps": [{{"description": str, "passed": bool, "error": str|null, "box": object|null}}, ...]}}`. `passed` is true only if every step passed. This line MUST be printed even if setup/navigation itself throws.
9. Always close the browser in `finally`, even on error.
10. No explanation, no markdown fences — output ONLY the raw JavaScript source code of the script."""

        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-6", max_tokens=16384,
            messages=[{"role": "user", "content": prompt}],
        )
        if message.stop_reason == "max_tokens":
            logger.warning("Draft script for %s hit the max_tokens cap — likely truncated", jira_test_key)
        script = message.content[0].text.strip()
        # Strip markdown fences if the model added them despite instruction 8
        script = re.sub(r"^```(?:javascript|js)?\n", "", script)
        script = re.sub(r"\n```$", "", script)
        return script

    async def _execute_script(self, script_path: Path, run_id: int) -> dict:
        """Runs the script, streaming its combined stdout+stderr into log_output
        line-by-line as it happens (rather than waiting for the whole process to
        finish) so a concurrent GET /runs/{id} can show a live console."""
        proc = await asyncio.create_subprocess_exec(
            "node", str(script_path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env=self._script_env(),
        )
        lines: list[str] = []

        async def _stream():
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="ignore").rstrip("\n")
                lines.append(line)
                await self._append_log(run_id, line)

        try:
            await asyncio.wait_for(_stream(), timeout=90)
            await proc.wait()
        except asyncio.TimeoutError:
            proc.kill()
            await self._append_log(run_id, "[error] script timed out after 90s")
            return {"passed": False, "summary": "Script timed out after 90s", "error": "timeout", "steps": []}

        text = "\n".join(lines)
        marker_pos = text.rfind(RESULT_MARKER)
        if marker_pos == -1:
            logger.warning("Automation run %s produced no %s line. output: %s", run_id, RESULT_MARKER, text[-2000:])
            return {"passed": False, "summary": "Script did not report a result", "error": text[-2000:] or "no RESULT_JSON line", "steps": []}
        try:
            # raw_decode parses just the JSON value and ignores anything the script
            # printed after it (e.g. a "Browser closed" log line in its `finally`
            # block) — a plain regex anchored to end-of-string broke on exactly
            # that, reporting "no result" even though a valid RESULT_JSON was there.
            result, _ = json.JSONDecoder().raw_decode(text[marker_pos + len(RESULT_MARKER):].strip())
            return result
        except json.JSONDecodeError as exc:
            return {"passed": False, "summary": "Could not parse script result", "error": str(exc), "steps": []}

    async def _append_log(self, run_id: int, line: str) -> None:
        factory = get_session_factory()
        async with factory() as session:
            run = await session.get(AutomationRunORM, run_id)
            if run is None:
                return
            run.log_output = (run.log_output or "") + line + "\n"
            await session.commit()

    @staticmethod
    def _script_env() -> dict:
        return os.environ.copy()

    # ------------------------------------------------------------------
    # Jira status update (per user's explicit decision — no Failed status exists)
    # ------------------------------------------------------------------

    async def _apply_jira_status(self, jira_test_key: str, passed: bool, result: dict) -> str:
        if passed:
            return await self._chain_transition_to_done(jira_test_key)

        comment_text = (
            f"🤖 *Automation run failed*\n\n{result.get('summary', '')}\n\n"
            + "\n".join(
                f"- {'✅' if s.get('passed') else '❌'} {s.get('description', '')}"
                + (f" — {s['error']}" if s.get("error") else "")
                for s in result.get("steps", [])
            )
        )
        try:
            await self.jira.post(f"/issue/{jira_test_key}/comment", {
                "body": self._plain_adf_comment(comment_text)
            })
            return "commented_failure"
        except Exception as exc:
            logger.warning("Could not post failure comment to %s: %s", jira_test_key, exc)
            return "skipped"

    async def _chain_transition_to_done(self, jira_test_key: str) -> str:
        """No single transition goes straight to Done from ToDo in this workflow
        (confirmed by inspecting real transitions) — walk toward it one hop at a
        time, matching on the transition's TARGET status name, not its own name
        (one real transition here is oddly named "f" but targets "In Progress")."""
        for _ in range(4):  # generous hop cap; bail rather than loop forever
            issue = await self.jira.get_issue(jira_test_key, fields=["status"])
            current = issue["fields"]["status"]["name"]
            if current.strip().lower() in ("done", "closed"):
                return "transitioned_to_done"

            transitions = await self.jira.get_transitions(jira_test_key)
            target = next(
                (t for t in transitions if t["to_status"].strip().lower() in ("done", "closed")), None
            )
            if not target:
                target = next(
                    (t for t in transitions if t["to_status"].strip().lower() == "in progress"), None
                )
            if not target:
                logger.warning("No transition path toward Done found for %s from status '%s'", jira_test_key, current)
                return "no_path_to_done"

            await self.jira.transition_issue(jira_test_key, target["id"])

        return "hop_limit_reached"

    @staticmethod
    def _plain_adf_comment(text: str) -> dict:
        nodes = [{"type": "paragraph", "content": [{"type": "text", "text": line}]} for line in text.split("\n") if line.strip()]
        return {"version": 1, "type": "doc", "content": nodes or [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}

    # ------------------------------------------------------------------
    # Bug candidate (review-only — not auto-filed as a real Jira Bug)
    # ------------------------------------------------------------------

    async def _create_bug_candidate(self, run_id: int, jira_test_key: str, story_key: Optional[str], test_summary: str, result: dict):
        failed_steps = [s for s in result.get("steps", []) if not s.get("passed")]
        description = result.get("summary", "") + "\n\n" + "\n".join(
            f"- {s.get('description', '')}: {s.get('error', '(no error detail)')}" for s in failed_steps
        )
        factory = get_session_factory()
        async with factory() as session:
            session.add(AutomationBugCandidateORM(
                run_id=run_id, jira_test_key=jira_test_key, story_key=story_key,
                title=f"Automation failure: {test_summary}",
                description=description, status="candidate",
            ))
            await session.commit()

    async def get_bug_candidates(self, status: str = "candidate", story_key: Optional[str] = None) -> list[dict]:
        factory = get_session_factory()
        async with factory() as session:
            query = select(AutomationBugCandidateORM).where(AutomationBugCandidateORM.status == status)
            if story_key:
                query = query.where(AutomationBugCandidateORM.story_key == story_key)
            rows = (await session.execute(
                query.order_by(AutomationBugCandidateORM.created_at.desc())
            )).scalars().all()
            return [
                {
                    "id": r.id, "run_id": r.run_id, "jira_test_key": r.jira_test_key,
                    "story_key": r.story_key, "title": r.title, "description": r.description,
                    "status": r.status, "jira_bug_key": r.jira_bug_key,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]

    async def file_bug_from_candidate(self, candidate_id: int) -> dict:
        """Create a real Jira Bug from a reviewed candidate, linked to the story
        (if known) via the same 'Relates' link type test_plans_service uses."""
        settings = get_settings()
        factory = get_session_factory()
        async with factory() as session:
            candidate = await session.get(AutomationBugCandidateORM, candidate_id)
            if not candidate:
                raise ValueError(f"No bug candidate with id {candidate_id}")
            if candidate.status == "filed":
                return {"key": candidate.jira_bug_key, "url": f"{settings.jira_base_url}/browse/{candidate.jira_bug_key}", "already_filed": True}

            project_key = candidate.jira_test_key.split("-")[0]
            payload = {
                "fields": {
                    "project": {"key": project_key},
                    "summary": candidate.title,
                    "issuetype": {"name": "Bug"},
                    "description": self._plain_adf_comment(
                        candidate.description
                        + f"\n\nFound by automation run against Test issue {candidate.jira_test_key}."
                    ),
                }
            }
            result = await self.jira.post("/issue", payload)
            new_key = result.get("key")
            if not new_key:
                raise ValueError("Jira did not return a key for the created bug")

            if candidate.story_key:
                try:
                    await self.jira.post("/issueLink", {
                        "type": {"name": "Relates"},
                        "inwardIssue": {"key": new_key},
                        "outwardIssue": {"key": candidate.story_key},
                    })
                except Exception as exc:
                    logger.warning("Could not link new bug %s to story %s: %s", new_key, candidate.story_key, exc)

            candidate.status = "filed"
            candidate.jira_bug_key = new_key
            await session.commit()

            return {"key": new_key, "url": f"{settings.jira_base_url}/browse/{new_key}", "already_filed": False}


_service: Optional[AutomationRunnerService] = None


def get_automation_runner_service() -> AutomationRunnerService:
    global _service
    if _service is None:
        _service = AutomationRunnerService()
    return _service

"""
NextGen QA Hub — one QA view of K1-NG built from four sources:

  repo   the K1-NG GitLab monorepo: every MR merged to main (first-parent log), the ticket keys in
         its branch / subject, the files it changed, and the test inventory (UI + API e2e, unit,
         contract, connector tests, the UI coverage plan, CI gates)
  jira   project K1NG (old KNG-n keys redirect to K1NG and are resolved once, then cached)
  env    the dev environment: /api/version (deployed git SHA), /healthz, /readyz, optional sign-in
  lab    embedded Playwright runs against the environment (nextgen_lab_service)

Correlation per ticket: Jira status → merged to main? → in the deployed SHA? → validated by a
passing lab run? Domains (Video, Identity, …) get churn, test share, open bugs and a risk score.
"""
import asyncio
import base64
import json
import logging
import os
import re
import subprocess
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
from sqlalchemy import select

from app.config import get_settings
from app.database.db import (
    AppSettingORM, NextGenEnvSnapshotORM, NextGenLabRunORM, NextGenNotificationORM, get_session_factory,
)
from app.jira.client import get_jira_client

logger = logging.getLogger(__name__)

SETTINGS_KEY = "nextgen_settings"
SNAPSHOT_KEY = "nextgen_last_snapshot"
KEYMAP_KEY = "nextgen_key_map"
MASK = "••••••••"
SECRET_FIELDS = [("env", "password"), ("repo", "token"), ("slack", "token"), ("slack", "user_token"), ("grok", "api_key")]
KEY_RE = re.compile(r"\b(K1NG|KNG)-(\d+)\b")
MERGE_RE = re.compile(r"Merge branch '([^']+)' into")
DATA_DIR = Path(__file__).parent.parent.parent / "data"

# Path prefix → domain. First match wins, so the specific rules come before the broad ones.
DOMAIN_RULES = [
    # Version bumps, lockfiles and change fragments ride on almost every MR — bookkeeping, not product
    ("Build & tooling", ("platform/package.json", "platform/pnpm-", "platform/version.json", "platform/nx.json",
                         "platform/tsconfig", "platform/eslint", "platform/jest", "platform/tools/version/",
                         "platform/tools/fixtures/", "platform/tools/http/", "platform/tools/lib/",
                         "platform/.husky/", "platform/.agents/", "platform/.claude/", "platform/.codex/",
                         "platform/.cursor/", "platform/.gemini/", "platform/.opencode/", "platform/.vscode/",
                         ".changes/", ".gitignore", ".gitattributes", ".claude/", ".mcp.json", ".figma-ref/",
                         "worktree-runtime.toml")),
    ("Identity & Access", ("platform/libs/identity/", "platform/libs/tenancy/", "platform/libs/web/session",
                           "pages/users", "pages/user-", "pages/roles", "pages/role-", "pages/sessions",
                           "pages/organisation", "pages/sign-in", "pages/federation", "pages/password-policy",
                           "pages/change-credential", "platform/tools/federation/")),
    ("Video", ("platform/libs/video/", "pages/video", "pages/vms-", "pages/camera-", "pages/tree-",
               "pages/watermark", "pages/settings/video", "connectors/milestone", "connectors/mock-vms",
               "platform/tools/conformance/")),
    ("Integrations", ("platform/libs/integrations/", "platform/apps/integration", "pages/integrations",
                      "connectors/", "platform/tools/chaos/")),
    ("Feature flags", ("platform/libs/flags/", "pages/features")),
    ("Audit", ("platform/libs/audit/", "pages/audit")),
    ("Data & migrations", ("platform/migrations/", "platform/tools/database/", "platform/tools/atlas/",
                           "platform/tools/invariants/")),
    ("Platform & DevOps", ("infra/", ".gitlab", "platform/deploy/", "deploy/", "scripts/", "platform/tools/ci/",
                           "platform/tools/docker/", "tools/load/", "platform/tools/load/")),
    ("Web shell", ("platform/apps/web/", "platform/libs/web/")),
    ("API core", ("platform/apps/api/", "platform/libs/kit/", "platform/libs/shared/")),
    ("Docs & architecture", ("docs/", "architecture/", "AGENTS.md", "CLAUDE.md", "DESIGN-SYSTEM.md")),
]
# UI e2e spec folder → domain
UI_AREA_DOMAIN = {
    "admin": "Identity & Access", "auth-shell": "Identity & Access", "session": "Identity & Access",
    "platform-admin": "Identity & Access", "wall": "Video", "tours": "Video", "bookmarks": "Video",
    "saved-views": "Video", "settings": "Video", "playback": "Video", "ptz": "Video", "pane": "Video",
    "export-snapshot": "Video", "sweeps": "Web shell", "harness": "E2E harness",
}
API_SUITE_DOMAIN = [("auth", "Identity & Access"), ("identity", "Identity & Access"),
                    ("permission", "Identity & Access"), ("flags", "Feature flags"), ("video", "Video"),
                    ("integration", "Integrations"), ("concurrency", "API core"), ("operational", "API core")]
# Ticket text → domain, for tickets with no commits (most bugs)
KEYWORD_DOMAIN = [
    ("Video", r"\b(video|camera|cameras|ptz|vms|milestone|xprotect|playback|bookmark|tour|wall|stream|snapshot|watermark|tree)\b"),
    ("Identity & Access", r"\b(user|users|role|roles|permission|login|sign[- ]?in|session|password|mfa|keycloak|ldap|organi[sz]ation|tenant)\b"),
    ("Integrations", r"\b(connector|integration|gateway|kafka|outbox|worker)\b"),
    ("Feature flags", r"\b(flag|flags|unleash)\b"),
    ("Audit", r"\baudit\b"),
    ("Platform & DevOps", r"\b(ci|pipeline|deploy|k8s|k3s|argocd|jenkins|helm|docker|loki|prometheus|grafana|minio|infra)\b"),
    ("Data & migrations", r"\b(migration|schema|database|postgres|rls)\b"),
]
TEST_FILE_RE = re.compile(r"(\.spec\.(ts|mjs|js)$|\.test\.(ts|mjs|js)$|\.contract\.ts$|/tests?/test_[^/]*\.py$|/tools/e2e/|/conformance/)")
UI_TEST_RE = re.compile(r"^\s*test(\.(only|skip|fixme|fail))?\(\s*(['\"`])(.*?)\3", re.M)
UI_TEST_COUNT_RE = re.compile(r"^\s*test(\.(only|skip|fixme|fail))?\(", re.M)
UI_TAG_RE = re.compile(r"@UI-([A-Z]+)-(\d+)")
API_TEST_RE = re.compile(r"w\.test\(\s*(['\"`])(.*?)\1", re.S)
UNIT_TEST_RE = re.compile(r"^\s*(it|test)(\.each\(.*?\))?\(", re.M)
PY_TEST_RE = re.compile(r"^\s*(async\s+)?def test_", re.M)
AC_RE = re.compile(r"\bAC-\d+(?:\.\d+)+\b")


def _note_acs(refs: dict, text: str) -> None:
    """AC numbers repeat across epics (AC-3.1.1 is a roles criterion in U&P and a fields one in the UX
    spec), so keep the ticket keys each file names: a spec AC counts only next to its own story/epic key."""
    acs = AC_RE.findall(text)
    if acs:
        keys = {f"{a}-{b}" for a, b in KEY_RE.findall(text)}
        for ac in acs:
            refs[ac].update(keys)


NON_PRODUCT = {"Docs & architecture", "Agent records", "Build & tooling", "E2E harness"}
# Domains a user reaches through the UI/API, where thin e2e coverage is a real risk
E2E_DOMAINS = {"Video", "Identity & Access", "Integrations", "Feature flags", "Audit", "Web shell"}


def domain_of(path: str) -> str:
    p = path.replace("\\", "/")
    m = re.search(r"tools/e2e/ui/specs/([^/]+)/", p)
    if m:
        return UI_AREA_DOMAIN.get(m.group(1), "Web shell")
    if "tools/e2e/api/suites/" in p:
        name = p.rsplit("/", 1)[-1]
        return next((d for k, d in API_SUITE_DOMAIN if k in name), "API core")
    if "tools/e2e/" in p:
        return "E2E harness"
    if p.startswith(".k1/"):
        return "Agent records"
    for domain, prefixes in DOMAIN_RULES:
        if any(x in p if x.startswith("pages/") else p.startswith(x) for x in prefixes):
            return domain
    return "Other"


def domain_of_text(text: str) -> str:
    t = (text or "").lower()
    for domain, pattern in KEYWORD_DOMAIN:
        if re.search(pattern, t):
            return domain
    return "Other"


def env_up(env: dict) -> bool:
    """Healthy, and not reported unready (readiness may be unknown when /readyz is mis-routed)."""
    return bool(env.get("healthy")) and env.get("ready") is not False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None


def _dt(s: Optional[str]) -> Optional[datetime]:
    """Git (+02:00) and Jira (.000+0200) timestamps → aware datetime."""
    if not s:
        return None
    s = re.sub(r"\.\d+", "", s.replace("Z", "+00:00"))
    s = re.sub(r"([+-]\d\d)(\d\d)$", r"\1:\2", s)
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ----------------------------------------------------------------------
# git helpers (blocking — always called through asyncio.to_thread)
# ----------------------------------------------------------------------

def _git(repo: Path, *args: str, token: str = "", timeout: int = 120) -> str:
    cmd = ["git"]
    if token:
        basic = base64.b64encode(f"oauth2:{token}".encode()).decode()
        cmd += ["-c", f"http.extraHeader=Authorization: Basic {basic}"]
    cmd += ["-C", str(repo), *args]
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    r = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "ignore").strip()[:400] or f"git {args[0]} failed")
    return r.stdout.decode("utf-8", "ignore")


def _count(pattern: re.Pattern, text: str) -> int:
    return len(pattern.findall(text))


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _walk(root: Path, suffixes: tuple[str, ...]):
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "dist", ".nx", "__pycache__", ".venv")]
        for f in filenames:
            if f.endswith(suffixes):
                yield Path(dirpath) / f


class NextGenHubService:
    def __init__(self):
        self._snapshot: Optional[dict] = None
        self._build_lock = asyncio.Lock()
        self.build_state = {"running": False, "started_at": None, "finished_at": None, "error": None, "step": None}

    # ------------------------------------------------------------------
    # Settings (stored in app_settings; .env only seeds them)
    # ------------------------------------------------------------------

    def _defaults(self) -> dict:
        s = get_settings()
        return {
            "env": {"url": s.nextgen_env_url, "user": s.nextgen_env_user, "password": s.nextgen_env_password},
            "repo": {"path": s.nextgen_repo_path, "url": s.nextgen_repo_url, "token": s.nextgen_gitlab_token,
                     "main_branch": "main", "deploy_branch": "develop"},
            "jira": {"project": s.nextgen_jira_project},
            "slack": {"token": s.slack_bot_token, "user_token": "", "channels": s.nextgen_slack_channels, "days": 3},
            "grok": {"api_key": s.xai_api_key, "model": s.xai_model, "base_url": s.xai_base_url},
            # The prototype that publishes the epic-by-epic UX spec, and the Figma file of its pages
            "ux": {"url": "https://k1-platform.kabatone.app/?ng=0.1", "figma_file_key": "QDgQIZWrjhbLmWMooY02Nh"},
            "poll_minutes": s.nextgen_poll_minutes,
        }

    async def _get_setting(self, key: str):
        async with get_session_factory()() as session:
            row = await session.get(AppSettingORM, key)
            if row and row.value:
                try:
                    return json.loads(row.value)
                except ValueError:
                    return None
        return None

    async def _put_setting(self, key: str, value) -> None:
        async with get_session_factory()() as session:
            row = await session.get(AppSettingORM, key)
            if row:
                row.value = json.dumps(value, default=str)
            else:
                session.add(AppSettingORM(key=key, value=json.dumps(value, default=str)))
            await session.commit()

    async def get_config(self, reveal: bool = False) -> dict:
        cfg = self._defaults()
        stored = await self._get_setting(SETTINGS_KEY) or {}
        for section, values in stored.items():
            if isinstance(values, dict) and isinstance(cfg.get(section), dict):
                cfg[section].update({k: v for k, v in values.items() if v is not None})
            elif section in cfg and not isinstance(cfg[section], dict):
                cfg[section] = values
        if (cfg["slack"].get("channels") or "").strip() == "next-gen*":   # old default missed #nextgen-*
            cfg["slack"]["channels"] = self._defaults()["slack"]["channels"]
        s = get_settings()
        cfg["derived"] = {"jira_base_url": s.jira_base_url, "claude_configured": bool(s.anthropic_api_key),
                          "figma_configured": bool(s.figma_api_token)}
        if not reveal:
            for section, field in SECRET_FIELDS:
                if cfg.get(section, {}).get(field):
                    cfg[section][field] = MASK
        return cfg

    async def save_config(self, incoming: dict) -> dict:
        current = await self.get_config(reveal=True)
        current.pop("derived", None)
        for section, values in (incoming or {}).items():
            if section == "derived":
                continue
            if isinstance(values, dict) and isinstance(current.get(section), dict):
                for k, v in values.items():
                    if (section, k) in SECRET_FIELDS and v == MASK:
                        continue
                    current[section][k] = v
            elif section in current:
                current[section] = values
        await self._put_setting(SETTINGS_KEY, current)
        return await self.get_config()

    # ------------------------------------------------------------------
    # Repository
    # ------------------------------------------------------------------

    def _repo_dir(self, cfg: dict) -> Path:
        # A configured path that does not exist here (e.g. a Windows path inside the Docker image)
        # falls back to the clone the hub keeps in data/.
        p = (cfg["repo"].get("path") or "").strip()
        return Path(p) if p and Path(p).exists() else DATA_DIR / "k1-nextgen"

    def _ensure_repo(self, cfg: dict) -> Path:
        repo = self._repo_dir(cfg)
        token = cfg["repo"].get("token") or ""
        if (repo / ".git").exists():
            try:
                _git(repo, "fetch", "--quiet", "--prune", "origin", token=token, timeout=240)
            except Exception as exc:  # offline or no credentials: analyse what is there
                logger.warning("NextGen repo fetch failed: %s", exc)
            return repo
        if not token:
            raise RuntimeError(f"No K1-NG clone at {repo} and no GitLab token to clone it — set the repo path "
                               "or a GitLab token (read_repository) in Settings")
        repo.parent.mkdir(parents=True, exist_ok=True)
        basic = base64.b64encode(f"oauth2:{token}".encode()).decode()
        r = subprocess.run(["git", "-c", f"http.extraHeader=Authorization: Basic {basic}", "clone", "--quiet",
                            cfg["repo"]["url"], str(repo)], capture_output=True, timeout=900,
                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"})
        if r.returncode != 0:
            raise RuntimeError("git clone failed: " + r.stderr.decode("utf-8", "ignore")[:300])
        return repo

    def analyze_repo(self, cfg: dict, deployed_sha: Optional[str]) -> dict:
        """Blocking. MR-level history of main + the test inventory."""
        repo = self._ensure_repo(cfg)
        main_ref = f"origin/{cfg['repo'].get('main_branch') or 'main'}"
        deploy_ref = f"origin/{cfg['repo'].get('deploy_branch') or 'develop'}"
        heads = {}
        for name, ref in (("main", main_ref), ("deploy_branch", deploy_ref)):
            try:
                heads[name] = _git(repo, "log", "-1", "--format=%H%x1f%aI%x1f%s", ref).strip().split("\x1f")
            except Exception:
                heads[name] = None

        deployed: set[str] = set()
        deployed_known = False
        behind = None
        if deployed_sha:
            try:
                deployed = set(_git(repo, "rev-list", deployed_sha, timeout=180).split())
                deployed_known = True
                behind = int(_git(repo, "rev-list", "--count", f"{deployed_sha}..{main_ref}").strip() or 0)
            except Exception as exc:
                logger.warning("Deployed SHA %s not in the clone: %s", deployed_sha, exc)

        # One record per change on main's first-parent line (an MR merge or a direct commit),
        # with the files it changed relative to the previous main.
        raw = _git(repo, "log", main_ref, "--first-parent", "-m", "--name-only", "--since=2026-01-01",
                   "--pretty=format:%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1d", timeout=300)
        changes = []
        for chunk in raw.split("\x1e"):
            if not chunk.strip():
                continue
            head, _, files_part = chunk.partition("\x1d")
            parts = head.split("\x1f")
            if len(parts) < 5:
                continue
            sha, date, author, subject, body = parts[:5]
            files = [f.strip() for f in files_part.splitlines() if f.strip()]
            branch = (MERGE_RE.search(subject) or [None, None])[1]
            keys = sorted({f"{a}-{b}" for a, b in KEY_RE.findall(f"{subject}\n{body}\n{branch or ''}")})
            changes.append({
                "sha": sha, "date": date, "author": author, "subject": subject[:200], "branch": branch,
                "keys": keys, "files": len(files), "test_files": [f for f in files if TEST_FILE_RE.search("/" + f)][:40],
                "domains": dict(Counter(domain_of(f) for f in files if not f.startswith(".k1/"))),
                "deployed": (sha in deployed) if deployed_known else None,
            })

        return {
            "path": str(repo), "fetched_at": _iso(_now()), "heads": heads, "deployed_sha": deployed_sha,
            "deployed_known": deployed_known, "main_ahead_of_deployed": behind,
            "changes": changes, "tests": self._test_inventory(repo),
        }

    def _test_inventory(self, repo: Path) -> dict:
        plat = repo / "platform"
        # UI e2e (Playwright)
        ui_areas: dict[str, dict] = {}
        titles: dict[str, list[str]] = defaultdict(list)
        tags_by_area: dict[str, set] = defaultdict(set)
        ac_refs: dict[str, set] = defaultdict(set)   # AC id → ticket keys named in the same test file
        for f in _walk(plat / "tools/e2e/ui/specs", (".spec.mjs", ".spec.ts", ".spec.js")):
            text = _read(f)
            area = f.relative_to(plat / "tools/e2e/ui/specs").parts[0]
            a = ui_areas.setdefault(area, {"area": area, "domain": UI_AREA_DOMAIN.get(area, "Web shell"),
                                           "files": 0, "tests": 0, "skipped": 0})
            a["files"] += 1
            a["tests"] += _count(UI_TEST_COUNT_RE, text)
            _note_acs(ac_refs, text)
            a["skipped"] += len(re.findall(r"^\s*test\.(skip|fixme)\(", text, re.M))
            for _, _, _, title in UI_TEST_RE.findall(text):
                titles[a["domain"]].append(f"[ui:{area}] {title}")
            for prefix, num in UI_TAG_RE.findall(text):
                tags_by_area[prefix].add(num)

        # API e2e
        api_suites = []
        for f in sorted(_walk(plat / "tools/e2e/api/suites", (".mjs",))):
            text = _read(f)
            names = [m[1] for m in API_TEST_RE.findall(text)]
            _note_acs(ac_refs, text)
            dom = domain_of(str(f.relative_to(repo)))
            api_suites.append({"suite": f.name, "domain": dom, "cases": len(names)})
            titles[dom].extend(f"[api:{f.stem}] {n}" for n in names)

        # Unit / use-case / contract (jest)
        unit: dict[str, dict] = {}
        contract_files = 0
        for base in (plat / "libs", plat / "apps"):
            for f in _walk(base, (".spec.ts", ".contract.ts")):
                rel = f.relative_to(plat).as_posix()
                if f.name.endswith(".contract.ts"):
                    contract_files += 1
                    continue
                parts = rel.split("/")
                project = "/".join(parts[:3]) if parts[0] == "libs" and len(parts) > 3 and parts[2] not in ("src",) else "/".join(parts[:2])
                u = unit.setdefault(project, {"project": project, "domain": domain_of("platform/" + rel),
                                              "files": 0, "cases": 0, "layer": parts[2] if parts[0] == "libs" and len(parts) > 3 else "app"})
                u["files"] += 1
                text = _read(f)
                u["cases"] += _count(UNIT_TEST_RE, text)
                _note_acs(ac_refs, text)

        # Python connector tests
        py = []
        for conn in ("milestone-xprotect", "mock-vms"):
            n_files = n_cases = 0
            for f in _walk(repo / "connectors" / conn, (".py",)):
                if f.name.startswith("test_"):
                    n_files += 1
                    n_cases += _count(PY_TEST_RE, _read(f))
            py.append({"connector": conn, "files": n_files, "cases": n_cases})

        # UI coverage plan (docs/e2e-ui-coverage-plan.md): totals + case ids per area vs tags in specs
        plan_text = _read(repo / "docs/e2e-ui-coverage-plan.md")
        plan = {"total": None, "writable_now": None, "need_player": None, "need_harness": None, "manual": None, "areas": []}
        m = re.search(r"\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*", plan_text)
        if m:
            plan.update(writable_now=int(m[1]), need_harness=int(m[2]), need_player=int(m[3]), manual=int(m[4]), total=int(m[5]))
        plan_ids: dict[str, set] = defaultdict(set)
        for prefix, num in re.findall(r"^\|\s*UI-([A-Z]+)-(\d+)", plan_text, re.M):
            plan_ids[prefix].add(num)
        for prefix in sorted(plan_ids):
            covered = len(plan_ids[prefix] & tags_by_area.get(prefix, set()))
            plan["areas"].append({"area": prefix, "planned": len(plan_ids[prefix]), "automated": covered})

        # CI jobs, placeholders flagged
        ci_jobs = []
        for f in [repo / ".gitlab-ci.yml", *sorted((repo / ".gitlab/ci").glob("*.yml"))]:
            for job in re.findall(r"^([a-z][\w:-]*):\s*$", _read(f), re.M):
                if job in ("stages", "include", "workflow", "default", "variables"):
                    continue
                ci_jobs.append({"job": job, "file": f.name, "placeholder": job.startswith("placeholder")})

        return {
            "ui": {"areas": sorted(ui_areas.values(), key=lambda a: -a["tests"]),
                   "files": sum(a["files"] for a in ui_areas.values()),
                   "tests": sum(a["tests"] for a in ui_areas.values()),
                   "skipped": sum(a["skipped"] for a in ui_areas.values())},
            "api": {"suites": api_suites, "cases": sum(s["cases"] for s in api_suites)},
            "unit": {"projects": sorted(unit.values(), key=lambda u: -u["cases"]),
                     "files": sum(u["files"] for u in unit.values()), "cases": sum(u["cases"] for u in unit.values()),
                     "contract_files": contract_files},
            "python": py, "plan": plan, "ci": ci_jobs, "ac_refs": {k: sorted(v) for k, v in ac_refs.items()},
            "titles": {d: t[:400] for d, t in titles.items()},
        }

    # ------------------------------------------------------------------
    # Jira
    # ------------------------------------------------------------------

    async def fetch_jira(self, cfg: dict) -> dict:
        jira = get_jira_client()
        project = cfg["jira"].get("project") or "K1NG"
        fields = ["summary", "status", "issuetype", "fixVersions", "parent", "labels", "components", "created",
                  "updated", "resolutiondate", "assignee", "priority"]
        issues, versions = await asyncio.gather(
            jira.search_issues(f"project = {project} ORDER BY updated DESC", fields=fields, max_total=8000),
            jira.get(f"/project/{project}/versions"),
        )
        rows = []
        for i in issues:
            f = i.get("fields") or {}
            st = f.get("status") or {}
            rows.append({
                "key": i["key"], "summary": f.get("summary") or "",
                "type": (f.get("issuetype") or {}).get("name"),
                "status": st.get("name"), "category": (st.get("statusCategory") or {}).get("key"),  # new|indeterminate|done
                "versions": [v["name"] for v in f.get("fixVersions") or []],
                "parent": (f.get("parent") or {}).get("key"),
                "parent_summary": ((f.get("parent") or {}).get("fields") or {}).get("summary"),
                "labels": f.get("labels") or [], "components": [c["name"] for c in f.get("components") or []],
                "created": f.get("created"), "updated": f.get("updated"), "resolved": f.get("resolutiondate"),
                "assignee": (f.get("assignee") or {}).get("displayName"),
                "priority": (f.get("priority") or {}).get("name"),
            })
        return {"project": project, "issues": rows,
                "versions": [{"name": v["name"], "released": v.get("released"), "release_date": v.get("releaseDate"),
                              "archived": v.get("archived")} for v in versions or []]}

    async def resolve_keys(self, old_keys: set[str]) -> dict:
        """KNG-n → K1NG-m. Jira redirects moved keys; resolved once and cached forever."""
        keymap = await self._get_setting(KEYMAP_KEY) or {}
        todo = [k for k in old_keys if k not in keymap]
        if todo:
            jira = get_jira_client()
            sem = asyncio.Semaphore(8)

            async def one(k):
                async with sem:
                    try:
                        d = await jira.get(f"/issue/{k}", {"fields": "summary"})
                        keymap[k] = d.get("key") or None
                    except Exception:
                        keymap[k] = None
            await asyncio.gather(*(one(k) for k in todo[:1500]))
            await self._put_setting(KEYMAP_KEY, keymap)
        return keymap

    # ------------------------------------------------------------------
    # Environment
    # ------------------------------------------------------------------

    async def check_env(self, cfg: Optional[dict] = None, persist: bool = True) -> dict:
        cfg = cfg or await self.get_config(reveal=True)
        url = (cfg["env"].get("url") or "").rstrip("/")
        out = {"url": url, "checked_at": _iso(_now()), "endpoints": {}, "version": None, "healthy": False,
               "ready": False, "ready_checks": [], "login": None, "error": None}
        if not url:
            out["error"] = "No environment URL configured"
            return out
        async with httpx.AsyncClient(verify=False, timeout=20, follow_redirects=True) as c:
            for path in ("/api/version", "/healthz", "/readyz"):
                t0 = time.perf_counter()
                try:
                    r = await c.get(url + path)
                    body = r.json() if "json" in r.headers.get("content-type", "") else None
                    out["endpoints"][path] = {"status": r.status_code, "ms": round((time.perf_counter() - t0) * 1000)}
                    if path == "/api/version" and body:
                        out["version"] = body
                    elif path == "/healthz":
                        out["healthy"] = r.status_code == 200 and (body or {}).get("status") == "ok"
                        out["uptime_s"] = (body or {}).get("uptimeSeconds")
                    elif path == "/readyz":
                        if body is None:  # answered by the web app, not the API: readiness unknown, not "down"
                            out["ready"] = None
                            out["ready_note"] = "/readyz returned the web page instead of the API's JSON (ingress routing)"
                        else:
                            out["ready"] = bool(body.get("ready"))
                            out["ready_checks"] = body.get("checks") or []
                except Exception as exc:
                    out["endpoints"][path] = {"status": None, "ms": round((time.perf_counter() - t0) * 1000),
                                              "error": str(exc)[:200]}
                    out["error"] = out["error"] or f"{path}: {exc}"
            user, pw = cfg["env"].get("user"), cfg["env"].get("password")
            if user and pw:
                t0 = time.perf_counter()
                try:
                    r = await c.post(url + "/api/auth/sign-in", json={"email": user, "password": pw, "device": "qa-hub"})
                    login = {"status": r.status_code, "ms": round((time.perf_counter() - t0) * 1000), "ok": r.status_code in (200, 201)}
                    if login["ok"]:
                        token = r.json().get("accessToken")
                        me = await c.get(url + "/api/auth/me", headers={"Authorization": f"Bearer {token}"})
                        if me.status_code == 200:
                            mj = me.json()
                            login["roles"] = [x.get("name") if isinstance(x, dict) else x for x in mj.get("roles") or []][:20]
                            login["must_change_credential"] = r.json().get("mustChangeCredential")
                    else:
                        login["detail"] = (r.json() if "json" in r.headers.get("content-type", "") else {}).get("detail")
                    out["login"] = login
                except Exception as exc:
                    out["login"] = {"ok": False, "error": str(exc)[:200]}
        if persist:
            await self._record_env(out)
        return out

    async def _record_env(self, out: dict) -> None:
        v = out.get("version") or {}
        async with get_session_factory()() as session:
            prev = (await session.execute(select(NextGenEnvSnapshotORM).order_by(NextGenEnvSnapshotORM.id.desc()).limit(1))).scalar_one_or_none()
            session.add(NextGenEnvSnapshotORM(
                env_url=out["url"], git_sha=v.get("gitSha"), version=v.get("version"), release=v.get("release"),
                built_at=v.get("builtAt"), healthy=int(out["healthy"]),
                ready=None if out["ready"] is None else int(out["ready"]),
                login_ok=None if out.get("login") is None else int(bool(out["login"].get("ok"))),
                details=json.dumps({k: out.get(k) for k in ("endpoints", "ready_checks", "ready_note", "login", "error", "uptime_s")}, default=str),
            ))
            await session.commit()
        # Notifications on change
        if prev:
            up_now = env_up(out)
            up_before = bool(prev.healthy) and prev.ready != 0
            if up_before and not up_now:
                await self.notify("critical", "env", f"NextGen environment is DOWN ({out['url']})",
                                  out.get("error") or "healthz/readyz failed", out["url"])
            elif up_now and not up_before:
                await self.notify("info", "env", "NextGen environment is back up", out["url"], out["url"])
            if v.get("gitSha") and prev.git_sha and v["gitSha"] != prev.git_sha:
                await self.notify("info", "deploy", f"New deployment: {prev.git_sha[:8]} → {v['gitSha'][:8]}",
                                  f"Version {v.get('version')} (release {v.get('release')}), built {v.get('builtAt')}",
                                  out["url"])
            if out.get("login") and prev.login_ok == 1 and not out["login"].get("ok"):
                await self.notify("warning", "env", "QA account can no longer sign in to NextGen",
                                  json.dumps(out["login"])[:300], out["url"])

    async def env_history(self, limit: int = 200) -> list[dict]:
        async with get_session_factory()() as session:
            rows = (await session.execute(select(NextGenEnvSnapshotORM).order_by(NextGenEnvSnapshotORM.id.desc()).limit(limit))).scalars().all()
        return [{"id": r.id, "checked_at": _iso(r.checked_at), "git_sha": r.git_sha, "version": r.version,
                 "release": r.release, "built_at": r.built_at, "healthy": bool(r.healthy),
                 "ready": None if r.ready is None else bool(r.ready),
                 "login_ok": None if r.login_ok is None else bool(r.login_ok),
                 "details": json.loads(r.details) if r.details else None} for r in rows]

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------

    async def notify(self, level: str, category: str, title: str, detail: str = "", link: str = "") -> None:
        async with get_session_factory()() as session:
            session.add(NextGenNotificationORM(level=level, category=category, title=title[:500],
                                               detail=(detail or "")[:4000], link=link or None))
            await session.commit()

    async def notifications(self, limit: int = 100, unread_only: bool = False) -> dict:
        async with get_session_factory()() as session:
            q = select(NextGenNotificationORM).order_by(NextGenNotificationORM.id.desc()).limit(limit)
            if unread_only:
                q = q.where(NextGenNotificationORM.read == 0)
            rows = (await session.execute(q)).scalars().all()
            unread = len((await session.execute(select(NextGenNotificationORM.id).where(NextGenNotificationORM.read == 0))).all())
        return {"unread": unread, "items": [{"id": r.id, "created_at": _iso(r.created_at), "level": r.level,
                                             "category": r.category, "title": r.title, "detail": r.detail,
                                             "link": r.link, "read": bool(r.read)} for r in rows]}

    async def mark_read(self, notification_id: Optional[int] = None) -> None:
        async with get_session_factory()() as session:
            q = select(NextGenNotificationORM).where(NextGenNotificationORM.read == 0)
            if notification_id:
                q = q.where(NextGenNotificationORM.id == notification_id)
            for r in (await session.execute(q)).scalars().all():
                r.read = 1
            await session.commit()

    # ------------------------------------------------------------------
    # Snapshot: correlate everything
    # ------------------------------------------------------------------

    async def snapshot(self) -> Optional[dict]:
        if self._snapshot is None:
            self._snapshot = await self._get_setting(SNAPSHOT_KEY)
        return self._snapshot

    async def build_snapshot(self) -> dict:
        if self._build_lock.locked():
            raise RuntimeError("A refresh is already running")
        async with self._build_lock:
            self.build_state.update(running=True, started_at=_iso(_now()), error=None, step="environment")
            try:
                snap = await self._build()
                self.build_state.update(finished_at=_iso(_now()), step=None)
                return snap
            except Exception as exc:
                self.build_state.update(error=str(exc), step=None)
                raise
            finally:
                self.build_state["running"] = False

    async def _build(self) -> dict:
        cfg = await self.get_config(reveal=True)
        previous = await self.snapshot()
        errors = {}

        env = await self.check_env(cfg)
        deployed_sha = (env.get("version") or {}).get("gitSha")

        self.build_state["step"] = "repository"
        try:
            repo = await asyncio.to_thread(self.analyze_repo, cfg, deployed_sha)
        except Exception as exc:
            logger.error("NextGen repo analysis failed: %s", exc, exc_info=True)
            repo, errors["repo"] = None, str(exc)

        self.build_state["step"] = "jira"
        try:
            jira = await self.fetch_jira(cfg)
        except Exception as exc:
            logger.error("NextGen Jira fetch failed: %s", exc, exc_info=True)
            jira, errors["jira"] = {"project": cfg["jira"].get("project"), "issues": [], "versions": []}, str(exc)

        self.build_state["step"] = "UX reference"
        ux = await self.refresh_ux(cfg, errors)

        self.build_state["step"] = "linking tickets"
        keymap = {}
        if repo:
            old = {k for c in repo["changes"] for k in c["keys"] if k.startswith("KNG-")}
            keymap = await self.resolve_keys(old)

        lab = await self._lab_by_issue()
        snap = self._correlate(cfg, env, repo, jira, keymap, lab)
        snap["ux"] = self._correlate_ux(cfg, ux, snap, (repo or {}).get("tests") or {})
        snap["errors"] = errors
        await self._diff_and_notify(previous, snap)
        self._snapshot = snap
        await self._put_setting(SNAPSHOT_KEY, snap)
        return snap

    # ------------------------------------------------------------------
    # UX reference (prototype spec: epics → stories → acceptance criteria, Figma pages, states)
    # ------------------------------------------------------------------

    async def refresh_ux(self, cfg: dict, errors: Optional[dict] = None) -> Optional[dict]:
        from app.services.nextgen_ux_service import UX_KEY, fetch_reference
        stored = await self._get_setting(UX_KEY)
        url = (cfg.get("ux") or {}).get("url")
        if not url:
            return stored
        try:
            ux = await fetch_reference(url)
        except Exception as exc:
            logger.warning("UX reference fetch failed: %s", exc)
            if errors is not None:
                errors["ux"] = f"UX reference: {exc}"
            return stored
        if stored and (stored.get("release"), stored.get("spec_generated_at")) != (ux["release"], ux["spec_generated_at"]):
            old_acs = {a["id"] for e in stored["epics"] for s in e["stories"] for a in s["acs"]}
            new_acs = [a["id"] for e in ux["epics"] for s in e["stories"] for a in s["acs"] if a["id"] not in old_acs]
            await self.notify("info", "ux", f"UX spec updated: {ux['release']} ({ux['spec_generated_at'][:10]})",
                              f"{len(ux['epics'])} epics, {ux['story_count']} stories, {ux['ac_count']} acceptance criteria"
                              + (f"; new: {', '.join(new_acs[:20])}" if new_acs else ""), url)
        await self._put_setting(UX_KEY, ux)
        return ux

    @staticmethod
    def _correlate_ux(cfg: dict, ux: Optional[dict], snap: dict, tests: dict) -> Optional[dict]:
        if not ux:
            return None
        figma_key = (cfg.get("ux") or {}).get("figma_file_key")
        issues = {r["key"]: r for r in snap["issues"]}
        refs = tests.get("ac_refs") or {}
        refs = refs if isinstance(refs, dict) else {}

        def is_tested(ac_id, story_key, epic_key):
            return bool(set(refs.get(ac_id) or []) & {story_key, epic_key})

        def figma(node):
            return f"https://www.figma.com/design/{figma_key}/NextGen?node-id={node.replace(':', '-')}" if figma_key and node else None

        def jira(key):
            r = issues.get(key or "")
            return {"status": r["status"], "category": r["category"], "code_state": r["code_state"]} if r else None
        epics = []
        for e in ux["epics"]:
            stories = []
            for s in e["stories"]:
                acs = [{**a, "tested": is_tested(a["id"], s["key"], e["epic_key"])} for a in s["acs"]]
                stories.append({**s, "acs": acs, "jira": jira(s["key"]),
                                "acs_tested": sum(1 for a in acs if a["tested"])})
                if s["key"] in issues:  # mark the ticket row so lists and the drawer show the spec link
                    issues[s["key"]]["ux"] = {"epic": e["epic"], "story": s["id"], "acs": len(acs)}
            if e["epic_key"] in issues:
                issues[e["epic_key"]]["ux"] = {"epic": e["epic"], "story": None, "acs": sum(len(s["acs"]) for s in stories)}
            epics.append({**e, "figma_url": figma(e["figma_page_id"]), "jira": jira(e["epic_key"]),
                          "design_task": jira(e["design_task_key"]), "stories": stories,
                          "acs": sum(len(s["acs"]) for s in stories),
                          "acs_tested": sum(s["acs_tested"] for s in stories)})
        return {**{k: ux.get(k) for k in ("source_url", "release", "spec_generated_at", "fetched_at", "story_count", "ac_count")},
                "figma_file_url": f"https://www.figma.com/design/{figma_key}/NextGen" if figma_key else None,
                "acs_tested": sum(e["acs_tested"] for e in epics),
                "stories_with_code": sum(1 for e in epics for s in e["stories"] if (s["jira"] or {}).get("code_state", "none") != "none"),
                "epics": epics}

    def ux_context(self, key: str) -> str:
        """The spec text for a ticket (its story, or every story of its epic), for AI prompts."""
        ux = (self._snapshot or {}).get("ux")
        if not ux:
            return ""
        key = key.upper()
        row = next((r for r in (self._snapshot or {}).get("issues", []) if r["key"] == key), None)
        parent = (row or {}).get("parent")
        lines = []
        for e in ux["epics"]:
            stories = [s for s in e["stories"] if s["key"] == key] or (
                e["stories"] if key in (e["epic_key"], e["design_task_key"]) or parent == e["epic_key"] else [])
            if not stories:
                continue
            lines.append(f"{e['epic']} ({e['epic_key']}): {e['title']}")
            for s in stories:
                lines.append(f"  {s['id']} ({s['key']}) {s['title']}")
                lines += [f"    {a['id']} [{a['kind']}] {a['text']}" for a in s["acs"]]
            for surf in (e.get("extra") or {}).get("surfaces") or []:
                lines.append(f"  Surface '{surf.get('name')}' states: " + "; ".join(
                    f"{st}: {(surf.get('details') or {}).get(st, '')}" for st in surf.get("states") or []))
            for note in (e.get("extra") or {}).get("fpdStates") or []:
                lines.append(f"  {note.get('story')} {note.get('name')}: {note.get('text')}")
        return "\n".join(lines)

    async def _lab_by_issue(self) -> dict:
        async with get_session_factory()() as session:
            rows = (await session.execute(select(NextGenLabRunORM).where(NextGenLabRunORM.issue_key.isnot(None))
                                          .order_by(NextGenLabRunORM.id.desc()))).scalars().all()
        out: dict[str, dict] = {}
        for r in rows:
            out.setdefault(r.issue_key.upper(), {"id": r.id, "status": r.status, "at": _iso(r.finished_at or r.created_at)})
        return out

    def _correlate(self, cfg, env, repo, jira, keymap, lab) -> dict:
        now = _now()
        issues = {i["key"]: i for i in jira["issues"]}
        code: dict[str, dict] = defaultdict(lambda: {"changes": [], "test_files": set(), "domains": Counter()})
        changes = (repo or {}).get("changes") or []
        unlinked = 0
        for ch in changes:
            keys = {keymap.get(k) or k for k in ch["keys"]} if ch["keys"] else set()
            if not keys:
                unlinked += 1
            for k in keys:
                c = code[k]
                c["changes"].append({"sha": ch["sha"][:10], "date": ch["date"], "subject": ch["subject"],
                                     "deployed": ch["deployed"], "branch": ch["branch"]})
                c["test_files"].update(ch["test_files"])
                c["domains"].update(ch["domains"])

        # --- per ticket
        rows = []
        for key, i in issues.items():
            c = code.get(key)
            dep = [x["deployed"] for x in c["changes"]] if c else []
            if not c:
                code_state = "none"
            elif dep and all(d is True for d in dep):
                code_state = "deployed"
            elif any(d is True for d in dep):
                code_state = "partly deployed"
            elif any(d is None for d in dep):
                code_state = "merged"
            else:
                code_state = "merged, not deployed"
            domains = c["domains"] if c else Counter()
            top_domain = next((d for d, _ in domains.most_common() if d not in NON_PRODUCT), None)
            domain = top_domain or domain_of_text(f"{i['summary']} {i.get('parent_summary') or ''} {' '.join(i['labels'] + i['components'])}")
            v = lab.get(key)
            last_change = _dt(max((x["date"] for x in c["changes"]), default=None)) if c else None
            recent = bool(last_change and (now - last_change).days <= 30)
            gaps = []
            if i["type"] not in ("Epic",):
                if i["category"] == "done" and not c and i["type"] in ("Story", "Bug"):
                    gaps.append("Done in Jira, no code found")
                if c and i["category"] != "done":
                    gaps.append("Code merged, Jira not Done")
                if code_state == "merged, not deployed":
                    gaps.append("Merged, not deployed")
                if c and not c["test_files"] and i["type"] in ("Story", "Bug", "Task"):
                    gaps.append("No test changes")
                # only recent deliveries: older work was accepted before the hub existed
                if recent and code_state in ("deployed", "partly deployed") and not (v and v["status"] == "passed"):
                    gaps.append("Deployed, not validated in env")
            rows.append({
                **{k: i[k] for k in ("key", "summary", "type", "status", "category", "versions", "parent",
                                     "parent_summary", "assignee", "priority", "updated", "created", "resolved")},
                "domain": domain, "code_state": code_state, "changes": len(c["changes"]) if c else 0,
                "last_change": max((x["date"] for x in c["changes"]), default=None) if c else None,
                "test_files": len(c["test_files"]) if c else 0,
                "validation": v, "gaps": gaps,
            })

        # Code under ticket keys we cannot see in Jira (other projects / deleted)
        orphan_keys = sorted(k for k in code if k not in issues)

        # --- releases (fix versions)
        releases = []
        by_version = defaultdict(list)
        for r in rows:
            for vname in r["versions"] or ["(no fix version)"]:
                by_version[vname].append(r)
        vmeta = {v["name"]: v for v in jira["versions"]}
        for vname, items in by_version.items():
            m = vmeta.get(vname, {})
            releases.append({
                "version": vname, "released": m.get("released"), "release_date": m.get("release_date"),
                "total": len(items), "done": sum(1 for x in items if x["category"] == "done"),
                "in_progress": sum(1 for x in items if x["category"] == "indeterminate"),
                "todo": sum(1 for x in items if x["category"] == "new"),
                "with_code": sum(1 for x in items if x["code_state"] != "none"),
                "deployed": sum(1 for x in items if x["code_state"] in ("deployed", "partly deployed")),
                "validated": sum(1 for x in items if x["validation"] and x["validation"]["status"] == "passed"),
                "open_bugs": sum(1 for x in items if x["type"] == "Bug" and x["category"] != "done"),
            })
        order = {v["name"]: n for n, v in enumerate(jira["versions"])}
        releases.sort(key=lambda r: (order.get(r["version"], 10_000), r["version"]))

        # --- epics
        children = defaultdict(list)
        for r in rows:
            if r["parent"]:
                children[r["parent"]].append(r)
        epics = []
        for r in rows:
            if r["type"] != "Epic":
                continue
            ch = children.get(r["key"], [])
            epics.append({"key": r["key"], "summary": r["summary"], "status": r["status"], "category": r["category"],
                          "domain": Counter(x["domain"] for x in ch).most_common(1)[0][0] if ch else r["domain"],
                          "children": len(ch), "done": sum(1 for x in ch if x["category"] == "done"),
                          "with_code": sum(1 for x in ch if x["code_state"] != "none"),
                          "deployed": sum(1 for x in ch if x["code_state"] in ("deployed", "partly deployed")),
                          "open_bugs": sum(1 for x in ch if x["type"] == "Bug" and x["category"] != "done")})
        epics.sort(key=lambda e: (-e["children"], e["key"]))

        # --- domains
        tests = (repo or {}).get("tests") or {}
        dom: dict[str, dict] = {}

        def D(name):
            return dom.setdefault(name, {"domain": name, "changes_30d": 0, "changes_14d": 0, "test_changes_30d": 0,
                                         "files_30d": 0, "ui_tests": 0, "api_cases": 0, "unit_cases": 0,
                                         "open_bugs": 0, "open_issues": 0, "undeployed": 0, "not_validated": 0})
        for ch in changes:
            d_ch = _dt(ch["date"])
            if not d_ch:
                continue
            age = (now - d_ch).days
            if age > 30:
                continue
            for d, n in ch["domains"].items():
                if d in NON_PRODUCT:
                    continue
                x = D(d)
                x["changes_30d"] += 1
                x["files_30d"] += n
                if age <= 14:
                    x["changes_14d"] += 1
                if ch["test_files"]:
                    x["test_changes_30d"] += 1
        for a in tests.get("ui", {}).get("areas", []):
            D(a["domain"])["ui_tests"] += a["tests"]
        for s in tests.get("api", {}).get("suites", []):
            D(s["domain"])["api_cases"] += s["cases"]
        for u in tests.get("unit", {}).get("projects", []):
            D(u["domain"])["unit_cases"] += u["cases"]
        for r in rows:
            if r["category"] != "done" and r["type"] != "Epic":
                x = D(r["domain"])
                x["open_issues"] += 1
                if r["type"] == "Bug":
                    x["open_bugs"] += 1
            if r["code_state"] == "merged, not deployed":
                D(r["domain"])["undeployed"] += 1
            if "Deployed, not validated in env" in r["gaps"]:
                D(r["domain"])["not_validated"] += 1
        for x in dom.values():
            x["test_share"] = round(x["test_changes_30d"] / x["changes_30d"], 2) if x["changes_30d"] else None
            reasons, score = [], 0.0
            if x["open_bugs"]:
                score += min(35, x["open_bugs"] * 5)
                reasons.append(f"{x['open_bugs']} open bugs")
            if x["changes_14d"] >= 10:
                score += min(20, x["changes_14d"])
                reasons.append(f"high churn: {x['changes_14d']} merges in 14 days")
            if x["changes_30d"] >= 3 and (x["test_share"] or 0) < 0.4:
                score += 20
                reasons.append(f"only {round((x['test_share'] or 0) * 100)}% of recent merges touched tests")
            automated = x["ui_tests"] + x["api_cases"]
            if x["domain"] in E2E_DOMAINS and x["open_issues"] >= 5 and automated < 20:
                score += 15
                reasons.append(f"thin e2e coverage ({automated} UI/API e2e tests)")
            if x["undeployed"]:
                score += min(10, x["undeployed"] * 2)
                reasons.append(f"{x['undeployed']} tickets merged but not on the environment")
            if x["not_validated"]:
                score += min(10, x["not_validated"])
                reasons.append(f"{x['not_validated']} deployed tickets not validated in env")
            if x["domain"] == "Other":  # unclassified tickets: listed, not ranked
                score, reasons = 0, ["tickets the hub could not place in a domain"]
            x["risk"] = min(100, round(score))
            x["risk_level"] = "high" if x["risk"] >= 50 else "medium" if x["risk"] >= 25 else "low"
            x["reasons"] = reasons
        domains = sorted(dom.values(), key=lambda x: -x["risk"])

        # --- headline numbers
        open_rows = [r for r in rows if r["category"] != "done" and r["type"] != "Epic"]
        gap_counts = Counter(g for r in rows for g in r["gaps"])
        ci = tests.get("ci") or []
        placeholders = [j["job"] for j in ci if j["placeholder"]]
        plan = tests.get("plan") or {}
        summary = {
            "issues": len(rows), "open": len(open_rows),
            "done": sum(1 for r in rows if r["category"] == "done"),
            "in_progress": sum(1 for r in rows if r["category"] == "indeterminate"),
            "open_bugs": sum(1 for r in open_rows if r["type"] == "Bug"),
            "bugs_created_7d": sum(1 for r in rows if r["type"] == "Bug" and _dt(r["created"]) and
                                   (now - _dt(r["created"])).days < 7),
            "tickets_with_code": sum(1 for r in rows if r["code_state"] != "none"),
            "merged_not_deployed": gap_counts.get("Merged, not deployed", 0),
            "deployed_not_validated": gap_counts.get("Deployed, not validated in env", 0),
            "code_not_done": gap_counts.get("Code merged, Jira not Done", 0),
            "no_test_changes": gap_counts.get("No test changes", 0),
            "changes_30d": sum(1 for c in changes if _dt(c["date"]) and (now - _dt(c["date"])).days <= 30),
            "unlinked_changes": unlinked, "orphan_keys": len(orphan_keys),
            "ui_tests": tests.get("ui", {}).get("tests"), "api_cases": tests.get("api", {}).get("cases"),
            "unit_cases": tests.get("unit", {}).get("cases"),
            "plan_total": plan.get("total"),
            "plan_automated": sum(a["automated"] for a in plan.get("areas", [])) or None,
            "ci_placeholders": placeholders,
            "env_up": env_up(env),
            "main_ahead_of_deployed": (repo or {}).get("main_ahead_of_deployed"),
        }

        snap = {
            "generated_at": _iso(now), "project": jira["project"], "env": env,
            "repo": {k: (repo or {}).get(k) for k in ("path", "fetched_at", "heads", "deployed_sha", "deployed_known",
                                                     "main_ahead_of_deployed")},
            "recent_changes": [{**c, "keys": [keymap.get(k) or k for k in c["keys"]]} for c in changes[:150]],
            "tests": {k: v for k, v in tests.items() if k != "titles"},
            "test_titles": tests.get("titles") or {},
            "issues": rows, "releases": releases, "epics": epics, "domains": domains,
            "orphan_keys": orphan_keys[:200], "summary": summary,
        }
        snap["recommendations"] = self._recommend(snap)
        return snap

    @staticmethod
    def _recommend(snap: dict) -> list[dict]:
        s, rec = snap["summary"], []

        def add(level, area, text):
            rec.append({"level": level, "area": area, "text": text})

        if not s["env_up"]:
            add("high", "Environment", "The NextGen environment is not healthy/ready — validation results are unreliable until it is back.")
        if s.get("main_ahead_of_deployed"):
            add("medium", "Environment", f"main is {s['main_ahead_of_deployed']} commits ahead of what is deployed — "
                                         f"{s['merged_not_deployed']} tickets are merged but cannot be validated yet.")
        if s["ci_placeholders"]:
            add("high", "CI", f"CI still has placeholder gates ({', '.join(s['ci_placeholders'])}): no e2e, coverage or "
                              "dependency check blocks a merge. Run the API and UI e2e suites nightly against k1-ng-dev.")
        if s["deployed_not_validated"]:
            add("medium", "Validation", f"{s['deployed_not_validated']} tickets deployed in the last 30 days have no passing "
                                        "lab run — start with the open bugs and stories in the riskiest domain.")
        if s["code_not_done"]:
            add("low", "Jira hygiene", f"{s['code_not_done']} tickets have merged code but are not Done in Jira "
                                       "(the GitLab→Jira transition is not automated yet).")
        if s["no_test_changes"]:
            add("medium", "Testing", f"{s['no_test_changes']} tickets changed code without changing any test.")
        plan_total, automated = s.get("plan_total"), s.get("plan_automated")
        if plan_total and automated is not None and automated < plan_total:
            add("medium", "UI coverage", f"{automated} of {plan_total} planned UI cases are automated "
                                         f"({round(automated / plan_total * 100)}%). The remainder needs the player stand-in or stays manual.")
        for d in snap["domains"][:3]:
            if d["risk_level"] == "high" and d["domain"] != "Other":
                add("high", d["domain"], f"Highest QA risk: {'; '.join(d['reasons'])}. Focus exploratory testing and "
                                         "ask the AI advisor for alternative tests here.")
        if s["unlinked_changes"]:
            add("low", "Traceability", f"{s['unlinked_changes']} merges on main carry no ticket key — they cannot be "
                                       "traced to a requirement.")
        if s["bugs_created_7d"] >= 10:
            add("medium", "Bugs", f"{s['bugs_created_7d']} bugs opened in the last 7 days.")
        return rec

    async def _diff_and_notify(self, prev: Optional[dict], snap: dict) -> None:
        if not prev:
            return
        prev_bugs = {r["key"] for r in prev.get("issues", []) if r["type"] == "Bug"}
        new_bugs = [r for r in snap["issues"] if r["type"] == "Bug" and r["key"] not in prev_bugs]
        base = get_settings().jira_base_url
        for b in new_bugs[:15]:
            await self.notify("warning", "jira", f"New bug {b['key']}: {b['summary'][:120]}",
                              f"Domain {b['domain']} · status {b['status']}", f"{base}/browse/{b['key']}")
        prev_risk = {d["domain"]: d["risk_level"] for d in prev.get("domains", [])}
        for d in snap["domains"]:
            if d["risk_level"] == "high" and prev_risk.get(d["domain"]) != "high":
                await self.notify("warning", "repo", f"{d['domain']} moved to HIGH QA risk", "; ".join(d["reasons"]))
        prev_heads = (prev.get("repo") or {}).get("heads") or {}
        heads = (snap.get("repo") or {}).get("heads") or {}
        if prev_heads.get("main") and heads.get("main") and prev_heads["main"][0] != heads["main"][0]:
            since = _dt(prev_heads["main"][1])
            fresh = [c for c in snap["recent_changes"] if since and _dt(c["date"]) and _dt(c["date"]) > since]
            if fresh:
                keys = sorted({k for c in fresh for k in c["keys"]})
                await self.notify("info", "repo", f"{len(fresh)} new merges on main", ", ".join(keys[:30]) or "no ticket keys")

    # ------------------------------------------------------------------
    # Issue detail
    # ------------------------------------------------------------------

    async def issue_detail(self, key: str) -> dict:
        from app.services.env_validation_service import _adf_text
        key = key.upper()
        jira = get_jira_client()
        data = await jira.get(f"/issue/{key}", {"fields": "summary,description,status,issuetype,fixVersions,parent,"
                                                          "labels,components,priority,assignee,issuelinks,created,updated"})
        f = data.get("fields") or {}
        snap = await self.snapshot() or {}
        row = next((r for r in snap.get("issues", []) if r["key"] == data["key"]), None)
        changes = [c for c in snap.get("recent_changes", []) if data["key"] in c["keys"]]
        async with get_session_factory()() as session:
            runs = (await session.execute(select(NextGenLabRunORM).where(NextGenLabRunORM.issue_key == data["key"])
                                          .order_by(NextGenLabRunORM.id.desc()).limit(20))).scalars().all()
        return {
            "key": data["key"], "summary": f.get("summary"), "status": (f.get("status") or {}).get("name"),
            "type": (f.get("issuetype") or {}).get("name"), "description": _adf_text(f.get("description"))[:8000],
            "versions": [v["name"] for v in f.get("fixVersions") or []],
            "parent": (f.get("parent") or {}).get("key"), "priority": (f.get("priority") or {}).get("name"),
            "assignee": (f.get("assignee") or {}).get("displayName"),
            "links": [{"type": (l.get("type") or {}).get("name"),
                       "key": (l.get("outwardIssue") or l.get("inwardIssue") or {}).get("key"),
                       "summary": ((l.get("outwardIssue") or l.get("inwardIssue") or {}).get("fields") or {}).get("summary")}
                      for l in f.get("issuelinks") or []],
            "row": row, "changes": changes,
            "lab_runs": [{"id": r.id, "name": r.name, "status": r.status, "created_at": _iso(r.created_at)} for r in runs],
            "url": f"{get_settings().jira_base_url}/browse/{data['key']}",
        }


_service: Optional[NextGenHubService] = None


def get_nextgen_hub_service() -> NextGenHubService:
    global _service
    if _service is None:
        _service = NextGenHubService()
    return _service

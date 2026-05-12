"""
Release Notes service.
Fetches bugs labelled FromHaim or Prod_Zoho and manages their Release Notes field.
"""
import logging
from app.jira.client import get_jira_client
from app.services.cache_service import get_cache
from app.config import get_settings

logger = logging.getLogger(__name__)

RELEASE_NOTES_FIELD = "customfield_11060"
LABELS_FILTER = ["FromHaim", "Prod_Zoho"]


def _extract_text(adf) -> str:
    """Recursively extract plain text from an ADF document."""
    if not adf:
        return ""
    if isinstance(adf, str):
        return adf
    if isinstance(adf, dict):
        if adf.get("type") == "text":
            return adf.get("text", "")
        parts = []
        for child in adf.get("content", []):
            t = _extract_text(child)
            if t:
                parts.append(t)
        return " ".join(parts)
    if isinstance(adf, list):
        return " ".join(_extract_text(i) for i in adf if _extract_text(i))
    return ""


def _plain_adf(text: str) -> dict:
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


class ReleaseNotesService:

    def __init__(self):
        self.jira = get_jira_client()
        self.cache = get_cache()
        settings = get_settings()
        self.jira_base_url = settings.jira_base_url.rstrip("/")

    def _issue_url(self, key: str) -> str:
        return f"{self.jira_base_url}/browse/{key}"

    def _cache_key(self, version=None, epic_key=None) -> str:
        if version:
            import hashlib
            return f"release_notes:version:{hashlib.md5(version.encode()).hexdigest()[:8]}"
        if epic_key:
            import hashlib
            return f"release_notes:epic:{hashlib.md5(epic_key.encode()).hexdigest()[:8]}"
        return "release_notes:all"

    async def get_issues(
        self,
        version: str | None = None,
        epic_key: str | None = None,
        force_refresh: bool = False,
    ) -> list[dict]:
        cache_key = self._cache_key(version, epic_key)
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            labels_clause = "labels in (FromHaim, Prod_Zoho)"
            if version:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND fixVersion = "{version}" '
                    f'AND {labels_clause} ORDER BY created DESC'
                )
            elif epic_key:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND parent = "{epic_key}" '
                    f'AND {labels_clause} ORDER BY created DESC'
                )
            else:
                jql = (
                    f'project = TMT0 AND issuetype = Bug AND {labels_clause} '
                    f'ORDER BY created DESC'
                )

            issues_raw = await self.jira.search_issues(
                jql,
                fields=[
                    "summary", "status", "priority", "assignee",
                    "fixVersions", "parent", "labels",
                    "description", RELEASE_NOTES_FIELD,
                    "customfield_10014",  # Epic Link key
                ],
                max_total=500,
            )

            results = []
            for issue in issues_raw:
                f           = issue.get("fields", {})
                desc_text   = _extract_text(f.get("description"))
                rn_text     = _extract_text(f.get(RELEASE_NOTES_FIELD))
                parent_raw  = f.get("parent") or {}
                parent_f    = parent_raw.get("fields") or {}
                parent_key  = parent_raw.get("key", "")
                parent_sum  = parent_f.get("summary", "")
                parent_type = (parent_f.get("issuetype") or {}).get("name", "")
                epic_link   = f.get("customfield_10014") or ""  # raw epic key string

                if parent_type == "Epic":
                    epic_key, epic_summary = parent_key, parent_sum
                    story_key, story_summary = "", ""
                elif parent_type == "Story":
                    story_key, story_summary = parent_key, parent_sum
                    epic_key, epic_summary = epic_link, ""
                else:
                    epic_key, epic_summary = epic_link, ""
                    story_key, story_summary = "", ""

                results.append({
                    "key":           issue["key"],
                    "url":           self._issue_url(issue["key"]),
                    "summary":       f.get("summary", ""),
                    "status":        (f.get("status") or {}).get("name", ""),
                    "priority":      (f.get("priority") or {}).get("name", ""),
                    "assignee":      ((f.get("assignee") or {}).get("displayName") or ""),
                    "fix_versions":  [v["name"] for v in (f.get("fixVersions") or [])],
                    "labels":        f.get("labels") or [],
                    "description":   desc_text,
                    "release_notes": rn_text,
                    "parent_key":    parent_key,
                    "parent_summary": parent_sum,
                    "parent_type":   parent_type,
                    "epic_key":      epic_key,
                    "epic_summary":  epic_summary,
                    "story_key":     story_key,
                    "story_summary": story_summary,
                })
            return results

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def get_report_data(self, version: str, force_refresh: bool = False) -> dict:
        import hashlib
        cache_key = f"release_notes:report:{hashlib.md5(version.encode()).hexdigest()[:8]}"
        if force_refresh:
            self.cache.invalidate(cache_key)

        async def fetch():
            jql = (
                f'project = TMT0 AND fixVersion = "{version}" '
                f'AND issuetype in (Epic, Story, Bug) ORDER BY issuetype DESC, created DESC'
            )
            issues_raw = await self.jira.search_issues(
                jql,
                fields=[
                    "summary", "status", "issuetype", "priority", "assignee",
                    "fixVersions", "parent", "labels", RELEASE_NOTES_FIELD,
                ],
                max_total=1000,
            )

            epics   = {}   # key → epic dict
            stories = {}   # key → story dict
            bugs    = []   # list of bug dicts

            for issue in issues_raw:
                f      = issue.get("fields", {})
                key    = issue["key"]
                itype  = (f.get("issuetype") or {}).get("name", "Bug")
                status = (f.get("status") or {}).get("name", "")
                parent_raw = f.get("parent") or {}
                parent_key = parent_raw.get("key", "")

                base = {
                    "key":     key,
                    "url":     self._issue_url(key),
                    "summary": f.get("summary", ""),
                    "status":  status,
                    "type":    itype,
                    "priority": (f.get("priority") or {}).get("name", ""),
                    "assignee": ((f.get("assignee") or {}).get("displayName") or ""),
                    "labels":   f.get("labels") or [],
                    "parent_key": parent_key,
                }

                if itype == "Epic":
                    epics[key] = {**base, "stories": [], "bugs": []}
                elif itype == "Story":
                    stories[key] = {**base, "bugs": []}
                else:
                    rn = _extract_text(f.get(RELEASE_NOTES_FIELD))
                    if rn.strip():
                        bugs.append({**base, "release_notes": rn})

            # Collect parent keys that are missing from our sets
            # (stories/epics that don't have fixVersion set won't appear in the JQL)
            missing = set()
            for bug in bugs:
                pk = bug["parent_key"]
                if pk and pk not in stories and pk not in epics:
                    missing.add(pk)
            for story in stories.values():
                pk = story["parent_key"]
                if pk and pk not in epics:
                    missing.add(pk)

            if missing:
                keys_clause = ",".join(missing)
                extra_raw = await self.jira.search_issues(
                    f'key in ({keys_clause})',
                    fields=[
                        "summary", "status", "issuetype", "priority",
                        "assignee", "labels", "parent",
                    ],
                    max_total=len(missing) + 10,
                )
                for issue in extra_raw:
                    f      = issue.get("fields", {})
                    key    = issue["key"]
                    itype  = (f.get("issuetype") or {}).get("name", "")
                    status = (f.get("status") or {}).get("name", "")
                    parent_raw = f.get("parent") or {}
                    parent_key = parent_raw.get("key", "")
                    base = {
                        "key":      key,
                        "url":      self._issue_url(key),
                        "summary":  f.get("summary", ""),
                        "status":   status,
                        "type":     itype,
                        "priority": (f.get("priority") or {}).get("name", ""),
                        "assignee": ((f.get("assignee") or {}).get("displayName") or ""),
                        "labels":   f.get("labels") or [],
                        "parent_key": parent_key,
                    }
                    if itype == "Epic":
                        epics[key] = {**base, "stories": [], "bugs": []}
                    elif itype == "Story":
                        stories[key] = {**base, "bugs": []}

                # Second pass: collect any still-missing epic parents of newly added stories
                missing2 = set()
                for story in stories.values():
                    pk = story["parent_key"]
                    if pk and pk not in epics:
                        missing2.add(pk)
                if missing2:
                    extra2 = await self.jira.search_issues(
                        f'key in ({",".join(missing2)})',
                        fields=["summary", "status", "issuetype", "priority", "assignee", "labels", "parent"],
                        max_total=len(missing2) + 10,
                    )
                    for issue in extra2:
                        f   = issue.get("fields", {})
                        key = issue["key"]
                        if (f.get("issuetype") or {}).get("name", "") == "Epic":
                            parent_raw = f.get("parent") or {}
                            base = {
                                "key": key, "url": self._issue_url(key),
                                "summary": f.get("summary", ""),
                                "status": (f.get("status") or {}).get("name", ""),
                                "type": "Epic",
                                "priority": (f.get("priority") or {}).get("name", ""),
                                "assignee": ((f.get("assignee") or {}).get("displayName") or ""),
                                "labels": f.get("labels") or [],
                                "parent_key": parent_raw.get("key", ""),
                            }
                            epics[key] = {**base, "stories": [], "bugs": []}

            # Wire bugs → stories → epics
            orphan_bugs = []
            for bug in bugs:
                pk = bug["parent_key"]
                if pk in stories:
                    stories[pk]["bugs"].append(bug)
                elif pk in epics:
                    epics[pk]["bugs"].append(bug)
                else:
                    orphan_bugs.append(bug)

            orphan_stories = []
            for sk, story in stories.items():
                pk = story["parent_key"]
                if pk in epics:
                    epics[pk]["stories"].append(story)
                else:
                    orphan_stories.append(story)

            return {
                "version": version,
                "epics":   list(epics.values()),
                "orphan_stories": orphan_stories,
                "orphan_bugs":    orphan_bugs,
            }

        return await self.cache.get_or_fetch(cache_key, fetch, ttl=300)

    async def update_release_notes(self, issue_key: str, text: str) -> dict:
        await self.jira.put(
            f"/issue/{issue_key}",
            json={"fields": {RELEASE_NOTES_FIELD: _plain_adf(text)}},
        )
        # Bust all release notes caches
        for key in list(self.cache._store.keys()):
            if key.startswith("release_notes:"):
                self.cache.invalidate(key)
        return {"ok": True, "key": issue_key}


_service: ReleaseNotesService | None = None


def get_release_notes_service() -> ReleaseNotesService:
    global _service
    if _service is None:
        _service = ReleaseNotesService()
    return _service

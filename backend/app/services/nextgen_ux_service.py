"""
NextGen UX reference — the epic-by-epic UI/UX spec published with the K1 platform prototype
(https://k1-platform.kabatone.app/?ng=0.1).

The prototype ships the spec as a JavaScript data object (release, epics → stories → acceptance
criteria, Figma page ids, surfaces with the states to design, responsive and RTL notes). The hub
downloads the bundle and READS that object literal as data with a small parser below — the
prototype's code is never executed.
"""
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_URL = "https://k1-platform.kabatone.app/?ng=0.1"
UX_KEY = "nextgen_ux_reference"


class _LiteralParser:
    """Parses the JS object-literal subset a bundler emits for static data: objects with bare or
    quoted keys, arrays, '…' "…" and `…` strings, numbers, null, true/false, !0/!1, void 0.
    Anything else (a function, an identifier) raises — the data is never evaluated."""

    def __init__(self, src: str, pos: int):
        self.s, self.i = src, pos

    def _ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t\r\n":
            self.i += 1

    def value(self) -> Any:
        self._ws()
        c = self.s[self.i]
        if c == "{":
            return self._object()
        if c == "[":
            return self._array()
        if c in "'\"`":
            return self._string()
        if self.s.startswith("!0", self.i):
            self.i += 2
            return True
        if self.s.startswith("!1", self.i):
            self.i += 2
            return False
        for word, val in (("null", None), ("true", True), ("false", False), ("void 0", None)):
            if self.s.startswith(word, self.i):
                self.i += len(word)
                return val
        m = re.compile(r"-?\d+(\.\d+)?([eE][-+]?\d+)?").match(self.s, self.i)
        if m:
            self.i = m.end()
            return float(m.group()) if any(ch in m.group() for ch in ".eE") else int(m.group())
        raise ValueError(f"not a data literal at {self.i}: {self.s[self.i:self.i + 40]!r}")

    def _string(self) -> str:
        q = self.s[self.i]
        self.i += 1
        out = []
        while True:
            c = self.s[self.i]
            if c == "\\":
                nxt = self.s[self.i + 1]
                out.append({"n": "\n", "t": "\t", "r": "\r"}.get(nxt, nxt))
                if nxt == "u":
                    out[-1] = chr(int(self.s[self.i + 2:self.i + 6], 16))
                    self.i += 4
                self.i += 2
                continue
            if c == q:
                self.i += 1
                return "".join(out)
            if q == "`" and c == "$" and self.s[self.i + 1] == "{":
                raise ValueError("template expression in data")
            out.append(c)
            self.i += 1

    def _key(self) -> str:
        self._ws()
        if self.s[self.i] in "'\"`":
            return self._string()
        m = re.compile(r"[A-Za-z_$][\w$]*").match(self.s, self.i)
        if not m:
            raise ValueError(f"bad key at {self.i}")
        self.i = m.end()
        return m.group()

    def _object(self) -> dict:
        self.i += 1
        out = {}
        while True:
            self._ws()
            if self.s[self.i] == "}":
                self.i += 1
                return out
            k = self._key()
            self._ws()
            if self.s[self.i] != ":":
                raise ValueError(f"expected ':' at {self.i}")
            self.i += 1
            out[k] = self.value()
            self._ws()
            if self.s[self.i] == ",":
                self.i += 1

    def _array(self) -> list:
        self.i += 1
        out = []
        while True:
            self._ws()
            if self.s[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self._ws()
            if self.s[self.i] == ",":
                self.i += 1


def parse_spec_module(js: str) -> dict:
    """Find the spec object (the literal that has release + epics) and parse it."""
    for m in re.finditer(r"(?:var|let|const)\s+[\w$]+\s*=\s*\{\s*release\s*:", js):
        start = js.index("{", m.start())
        return _LiteralParser(js, start).value()
    raise ValueError("No UX spec object (release + epics) found in the module")


def _text(md: Optional[str]) -> str:
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md or "").strip()


def normalise(spec: dict, source_url: str) -> dict:
    epics = []
    for e in spec.get("epics") or []:
        stories = []
        for s in e.get("stories") or []:
            stories.append({"key": s.get("key"), "id": s.get("id"), "title": s.get("title"),
                            "design_work": s.get("designWork"), "note": _text(s.get("note")),
                            "acs": [{"id": a.get("id"), "text": a.get("text"), "kind": a.get("kind")} for a in s.get("acs") or []]})
        epics.append({
            "epic": e.get("epic"), "title": e.get("title"), "epic_key": e.get("epicKey"),
            "design_task_key": e.get("designTaskKey"), "figma_page_id": e.get("figmaPageId"),
            "stories": stories,
            # everything else the spec carries (surfaces, states, responsive/RTL notes…) kept as-is
            "extra": {k: v for k, v in e.items() if k not in ("epic", "title", "epicKey", "designTaskKey", "figmaPageId", "stories")},
        })
    return {"source_url": source_url, "release": spec.get("release"), "spec_generated_at": spec.get("generatedAt"),
            "fetched_at": datetime.now(timezone.utc).isoformat(), "epics": epics,
            "story_count": sum(len(e["stories"]) for e in epics),
            "ac_count": sum(len(s["acs"]) for e in epics for s in e["stories"])}


async def fetch_reference(url: str = DEFAULT_URL) -> dict:
    """index.html → entry bundle → the chunk that holds the spec → parsed data."""
    base = re.match(r"https?://[^/]+", url).group()
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
        html = (await c.get(url)).text
        entry = re.search(r'src="(/assets/index-[^"]+\.js)"', html)
        if not entry:
            raise RuntimeError("Could not find the prototype's entry bundle")
        main = (await c.get(base + entry.group(1))).text
        candidates = sorted(set(re.findall(r"assets/(tour-[\w-]+\.js)", main)))
        if not candidates:  # the chunk may only be referenced from another chunk
            for chunk in sorted(set(re.findall(r"assets/((?:NgEdition|screens)-[\w-]+\.js)", main))):
                body = (await c.get(f"{base}/assets/{chunk}")).text
                candidates += re.findall(r"(tour-[\w-]+\.js)", body)
        for chunk in dict.fromkeys(candidates):
            js = (await c.get(f"{base}/assets/{chunk}")).text
            if "release:" in js and "epics:" in js:
                data = normalise(parse_spec_module(js), url)
                data["chunk"] = chunk
                return data
    raise RuntimeError("The prototype bundle no longer contains the UX spec module")

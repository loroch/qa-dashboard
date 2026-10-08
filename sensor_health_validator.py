"""
Sensor Health Validator — BI vs Elasticsearch vs Units log
==========================================================
Cross-checks the sensor health status shown in C-Insight BI (/sensors)
against the SensorHealthExport documents in Elasticsearch and the real
status printed by the Units service log (C4I.Applications.ServiceHost_Units.log).

Per sensor it reports the status from each source and flags:
  LOG≠ES     latest status in the Units log differs from current ES state
  ES≠BI      current ES state differs from what BI shows
  BUCKET     BI statusBucket doesn't match BI status (e.g. Failed → "unknown")
  TYPE       sensor type differs between sources
  MISSING    on-dashboard sensor missing from BI, or BI sensor missing in ES
  EVENTS     status transitions in the log with no matching ES Change doc (and vice versa)
Then splits everything by sensor type × status for each source.

Run (from a Windows box that can reach the app server's admin share):
    python sensor_health_validator.py
    python sensor_health_validator.py --html report.html --json report.json
    python sensor_health_validator.py --log \\\\192.168.35.109\\c$\\C-Insight\\Application\\LOGS\\DEV1-APP1\\C4I.Applications.ServiceHost_Units.log

If the share isn't mapped, set SHV_USER / SHV_PASSWORD (e.g. int.local\\c4isrv)
and the script runs `net use` for you. Credentials are never stored in this file.

Requires: requests
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import requests

# ── Defaults (DEV1) ───────────────────────────────────────────────────────────

DEFAULT_BI  = "http://192.168.35.123:3000"
DEFAULT_ES  = "http://192.168.35.102:9200"
DEFAULT_LOG = r"\\192.168.35.109\c$\C-Insight\Application\LOGS\DEV1-APP1\C4I.Applications.ServiceHost_Units.log"

INDEX_PREFIX = "detections_genericdetection_sensorhealthstatus_"
P = "AdditionalParameters._parameters"

# Canonical type key → display label. Keys are lowercase SensorType values.
TYPE_LABELS = {
    "camera":                "CCTV (Fix)",
    "ptzcamera":             "CCTV (PTZ)",
    "lpr":                   "LPR",
    "facerecognition":       "Face Recognition",
    "videoanalytics":        "Video Analytics",
    "avlsensor":             "AVL",
    "tlssensor":             "TLS",
}
# BI unitTypeId → canonical type key
UNIT_TYPE_IDS = {1: "camera", 2: "ptzcamera", 7: "lpr"}
# Expected BI statusBucket for each status
EXPECTED_BUCKET = {"workingproperly": "ok", "malfunction": "warn", "failed": "err", "unknown": "unknown"}
STATUS_ORDER = ["workingproperly", "malfunction", "failed", "unknown"]
STATUS_LABELS = {"workingproperly": "WorkingProperly", "malfunction": "Malfunction",
                 "failed": "Failed", "unknown": "Unknown", None: "—"}

# Grace period: a log change this recent may not have reached ES/BI yet
IN_FLIGHT = timedelta(seconds=90)
# Max skew when matching a log transition to an ES Change doc
EVENT_MATCH = timedelta(seconds=60)


def norm(s):
    return str(s).strip().lower() if s not in (None, "") else None


def type_label(key):
    return TYPE_LABELS.get(key, key or "—")


def parse_time(s):
    s = s.rstrip("Z")
    if "." in s:
        head, frac = s.split(".", 1)
        s = f"{head}.{frac[:6]}"
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


# ── BI ────────────────────────────────────────────────────────────────────────

def fetch_bi(base):
    health = requests.get(f"{base}/api/v1/sensors/health", timeout=20).json()
    counts = requests.get(f"{base}/api/v1/sensors/counts", timeout=20).json()
    sensors = {}
    for d in health:
        sensors[d["sensorId"]] = {
            "name":   d.get("name"),
            "type":   UNIT_TYPE_IDS.get(d.get("unitTypeId"), norm(d.get("unitTypeLabel"))),
            "typeLabel": d.get("unitTypeLabel"),
            "status": norm(d.get("status")),
            "bucket": d.get("statusBucket"),
            "lastSeen": d.get("lastSeen"),
            "isStale": d.get("isStale"),
            "fr": d.get("hasFaceRecognition"),
            "va": d.get("hasVideoAnalytics"),
        }
    return sensors, counts


# ── Elasticsearch ─────────────────────────────────────────────────────────────

def es_search(es, index, body):
    r = requests.post(f"{es}/{index}/_search?ignore_unavailable=true", json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_es(es, since_utc):
    """Rebuild current state per sensor from the latest Snapshot cycle + later Change docs."""
    now = datetime.now(timezone.utc)
    months = {now.strftime("%Y-%m"), (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m"),
              since_utc.strftime("%Y-%m")}
    index = ",".join(INDEX_PREFIX + m for m in sorted(months))

    last_snap = es_search(es, index, {
        "size": 1, "sort": [{"Time": "desc"}],
        "query": {"term": {f"{P}.RecordKind": "snapshot"}},
    })["hits"]["hits"]
    if not last_snap:
        raise RuntimeError("No Snapshot documents found in ES")
    cycle = last_snap[0]["_source"]["AdditionalParameters"]["_parameters"]["CycleId"]
    snap_time = parse_time(last_snap[0]["_source"]["Time"])

    snap_docs = es_search(es, index, {
        "size": 5000, "query": {"term": {f"{P}.CycleId": cycle}},
    })["hits"]["hits"]

    # Change docs since the earlier of (snapshot, log start) — for state and event matching
    change_from = min(snap_time, since_utc) - timedelta(minutes=1)
    changes = es_search(es, index, {
        "size": 10000, "sort": [{"Time": "asc"}],
        "query": {"bool": {"filter": [
            {"term": {f"{P}.RecordKind": "change"}},
            {"range": {"Time": {"gte": change_from.isoformat()}}},
        ]}},
    })["hits"]["hits"]

    # Raw DashboardEngine docs (no RecordKind; HealthState isn't mapped) — used for clock calibration
    raw = es_search(es, index, {
        "size": 2000, "sort": [{"Time": "desc"}],
        "query": {"bool": {"must_not": [{"exists": {"field": f"{P}.RecordKind"}}],
                           "filter": [{"range": {"Time": {"gte": change_from.isoformat()}}}]}},
    })["hits"]["hits"]

    state = {}
    for h in snap_docs:
        s = h["_source"]; p = s["AdditionalParameters"]["_parameters"]
        state[s["SensorId"]] = {
            "name": p.get("UnitName"), "type": norm(p.get("SensorType")),
            "family": p.get("Family"), "onDashboard": norm(p.get("OnDashboard")) == "true",
            "status": norm(p.get("Status")), "received": norm(p.get("ReceivedStatus")),
            "dashboard": norm(p.get("DashboardStatus")), "description": p.get("Description"),
            "since": p.get("StatusSince"), "time": s["Time"], "kind": "Snapshot",
        }

    events = defaultdict(list)
    for h in changes:
        s = h["_source"]; p = s["AdditionalParameters"]["_parameters"]
        t = parse_time(s["Time"]); sid = s["SensorId"]
        events[sid].append((t, norm(p.get("Status")), p.get("Description")))
        if t <= snap_time:
            continue
        cur = state.setdefault(sid, {"name": p.get("UnitName"), "type": norm(p.get("SensorType")),
                                     "family": p.get("Family"),
                                     "onDashboard": norm(p.get("OnDashboard")) == "true"})
        cur.update({"status": norm(p.get("Status")), "received": norm(p.get("ReceivedStatus")),
                    "dashboard": norm(p.get("DashboardStatus")), "description": p.get("Description"),
                    "since": p.get("StatusSince"), "time": s["Time"], "kind": "Change"})

    raw_times = [(h["_source"]["SensorId"], parse_time(h["_source"]["Time"])) for h in raw]
    return {"cycle": cycle, "snapTime": snap_time, "snapCount": len(snap_docs),
            "state": state, "events": events, "raw": raw_times}


# ── Units log ─────────────────────────────────────────────────────────────────

LINE_RE     = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) \[\s*\d+\] \[-\] (\S+) (\w+) (.*)$")
PUBLISH_RE  = re.compile(r"Publishing statuses of type slim type (Slim\w+DTO)")
BLOCK_RE    = re.compile(r"^Name : (.*) \| ID : (\d+) \| Type : (\w+) \| HealthState : (\w+)")
ENQUEUE_RE  = re.compile(r"Enqueue - Type:[\w.]*\.(Slim\w+DTO) \| Statues:\[(.*)\]")
UPDATE_RE   = re.compile(r"Sensor ID: (\d+) \| Name: (.*?) \| Type Id: (\d+) \| Status Update: HealthStatus:(\w+) --> HealthStatus:(\w+)")
CAMCHG_RE   = re.compile(r"\*\* Status Changed \*\* - Camera (\d+) Name (.*?): Current: .*?; Update: IsAccessible=(\w+), IsRecording=(\w+), IsKnownStatus=(\w+)")
COMPUTE_RE  = re.compile(r'Computing Health State with description "(.*?)" for unit id (\d+)')
NOCHANGE_RE = re.compile(r"Sensor status didn't change for Unit Ids - ([\d, ]+)")
UNKNOWN_RE  = re.compile(r"Camera with physical id ([0-9a-f-]{36}) not found in cache or database")
EXPORT_RE   = re.compile(r"Sensor health export snapshot (\S+): published (\d+) of (\d+) documents")
ONCHG_RE    = re.compile(r"OnSensorHealthChange for unit id (\d+)")

DTO_TYPES = {"SlimCameraDTO": "camera", "SlimLprDTO": "lpr"}


class LogUnavailable(Exception):
    """The Units log path can't be opened (share not mapped / wrong credentials / wrong path)."""


def connect_share(path, user, pwd):
    """`net use` the \\\\host\\share part of a UNC path. Returns (ok, message)."""
    if not path.startswith("\\\\"):
        return os.path.exists(path), "local path"
    share = "\\".join(path.split("\\")[:4])  # \\host\c$
    r = subprocess.run(["net", "use", share, f"/user:{user}", pwd],
                       capture_output=True, text=True, check=False)
    msg = (r.stdout + r.stderr).strip()
    return os.path.exists(path), msg or f"connected to {share}"


def ensure_share(path):
    if os.path.exists(path):
        return
    user, pwd = os.environ.get("SHV_USER"), os.environ.get("SHV_PASSWORD")
    if user and pwd:
        connect_share(path, user, pwd)
    if not os.path.exists(path):
        raise LogUnavailable(path)


def parse_log(path):
    ensure_share(path)
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()

    events = defaultdict(list)        # sid -> [(ts_local, status, source, name, type)]
    detail = {}                       # sid -> latest camera flags / LPR description
    confirmed = {}                    # sid -> last "didn't change" ts
    onchange = []                     # (sid, ts_local) for clock calibration
    unknown_cams = set()
    exports = []
    first = last = None
    pending_publish = None            # (ts, dto) while reading the multiline block

    for line in lines:
        m = LINE_RE.match(line)
        if not m:
            b = BLOCK_RE.match(line.strip())
            if b and pending_publish:
                ts, dto = pending_publish
                name, sid, typ, st = b.groups()
                events[int(sid)].append((ts, norm(st), "publish", name, norm(typ)))
            continue
        pending_publish = None
        ts = datetime.strptime(m.group(1)[:26], "%Y-%m-%d %H:%M:%S.%f")
        first = first or ts; last = ts
        msg = m.group(4)

        if (x := PUBLISH_RE.search(msg)):
            pending_publish = (ts, x.group(1))
        elif (x := ENQUEUE_RE.search(msg)):
            for part in x.group(2).split("|"):
                if ":" in part:
                    sid, st = part.strip().split(":", 1)
                    events[int(sid)].append((ts, norm(st), "enqueue", None, DTO_TYPES.get(x.group(1))))
        elif (x := UPDATE_RE.search(msg)):
            sid, name, _tid, _old, new = x.groups()
            events[int(sid)].append((ts, norm(new), "update", name, None))
        elif (x := CAMCHG_RE.search(msg)):
            sid, name, acc, rec, known = x.groups()
            detail[int(sid)] = {"name": name, "IsAccessible": acc, "IsRecording": rec,
                                "IsKnownStatus": known, "at": ts}
        elif (x := COMPUTE_RE.search(msg)):
            detail.setdefault(int(x.group(2)), {})["description"] = x.group(1)
        elif (x := NOCHANGE_RE.search(msg)):
            for sid in re.findall(r"\d+", x.group(1)):
                confirmed[int(sid)] = ts
        elif (x := UNKNOWN_RE.search(msg)):
            unknown_cams.add(x.group(1))
        elif (x := EXPORT_RE.search(msg)):
            exports.append({"cycle": x.group(1), "published": int(x.group(2)), "total": int(x.group(3))})
        elif (x := ONCHG_RE.search(msg)):
            onchange.append((int(x.group(1)), ts))

    return {"events": events, "detail": detail, "confirmed": confirmed, "onchange": onchange,
            "unknownCams": sorted(unknown_cams), "exports": exports,
            "first": first, "last": last, "lines": len(lines)}


def calibrate_offset(log, es_raw, fallback_hours):
    """Log timestamps are server-local; ES is UTC. Match OnSensorHealthChange lines to raw ES docs."""
    votes = Counter()
    raw_by_sid = defaultdict(list)
    for sid, t in es_raw:
        raw_by_sid[sid].append(t.replace(tzinfo=None))
    for sid, ts in log["onchange"][-200:]:
        for t in raw_by_sid.get(sid, []):
            diff = (ts - t).total_seconds()
            hours = round(diff / 1800) / 2  # half-hour zones
            if abs(diff - hours * 3600) < 2:
                votes[hours] += 1
    if votes:
        return timedelta(hours=votes.most_common(1)[0][0]), "auto"
    return timedelta(hours=fallback_hours), "fallback"


# ── Comparison ────────────────────────────────────────────────────────────────

def compare(bi, es, log, offset):
    now = datetime.now(timezone.utc)
    to_utc = lambda ts: (ts - offset).replace(tzinfo=timezone.utc)
    log_start = to_utc(log["first"])

    ids = set(bi) | set(log["events"]) | {sid for sid, s in es["state"].items() if s.get("onDashboard")}
    rows = []
    for sid in sorted(ids):
        b, e = bi.get(sid), es["state"].get(sid)
        ev = log["events"].get(sid, [])
        last_ev = ev[-1] if ev else None
        name = (b or {}).get("name") or (e or {}).get("name") or (last_ev[3] if last_ev else None)
        log_type = next((x[4] for x in reversed(ev) if x[2] == "publish" and x[4]), None)
        typ = (e or {}).get("type") or (b or {}).get("type") or log_type

        row = {
            "id": sid, "name": name, "type": typ, "typeLabel": type_label(typ),
            "bi": b and b["status"], "biBucket": b and b["bucket"],
            "es": e and e.get("status"), "esDescription": e and e.get("description"),
            "esKind": e and e.get("kind"), "esTime": e and e.get("time"),
            "esOnDashboard": e and e.get("onDashboard"),
            "log": last_ev and last_ev[1],
            "logTime": last_ev and to_utc(last_ev[0]).isoformat(),
            "logChanges": len({(x[0], x[1]) for x in ev if x[2] == "publish"}) or len(ev),
            "logDetail": log["detail"].get(sid),
            "issues": [],
        }
        issues = row["issues"]
        in_flight = last_ev and now - to_utc(last_ev[0]) < IN_FLIGHT

        if row["log"] and row["es"] and row["log"] != row["es"]:
            issues.append(("LOG≠ES", f"log={STATUS_LABELS.get(row['log'], row['log'])} "
                                     f"es={STATUS_LABELS.get(row['es'], row['es'])}"
                                     + (" (log change <90s ago, may be in flight)" if in_flight else "")))
        if b and e and row["bi"] != row["es"]:
            issues.append(("ES≠BI", f"es={STATUS_LABELS.get(row['es'], row['es'])} "
                                    f"bi={STATUS_LABELS.get(row['bi'], row['bi'])}"))
        if b and row["bi"] in EXPECTED_BUCKET and row["biBucket"] != EXPECTED_BUCKET[row["bi"]]:
            issues.append(("BUCKET", f"BI status {STATUS_LABELS[row['bi']]} shown as bucket "
                                     f"'{row['biBucket']}', expected '{EXPECTED_BUCKET[row['bi']]}'"))
        types = {k: v for k, v in (("es", (e or {}).get("type")), ("bi", (b or {}).get("type")),
                                   ("log", log_type)) if v}
        # Enqueue lines only carry the Slim DTO (camera vs LPR) — compare those by family only
        family = lambda t: "camera" if t in ("camera", "ptzcamera") else t
        log_coarse = next((x[4] for x in reversed(ev) if x[2] == "enqueue" and x[4]), None)
        if len(set(types.values())) > 1 or (log_coarse and typ and family(typ) != log_coarse):
            types.setdefault("log", log_coarse)
            issues.append(("TYPE", ", ".join(f"{k}={v}" for k, v in types.items())))
        if e and e.get("onDashboard") and not b and e.get("type") in UNIT_TYPE_IDS.values():
            issues.append(("MISSING", "on dashboard in ES but not returned by BI"))
        if b and not e:
            issues.append(("MISSING", "shown in BI but not in latest ES snapshot"))

        # Event-level: every log transition inside the window should have an ES Change doc
        log_trans = []
        prev = None
        for ts, st, src, *_ in ev:
            if src in ("publish", "update") or (src == "enqueue" and not any(x[2] == "publish" for x in ev)):
                if st != prev:
                    log_trans.append((to_utc(ts), st)); prev = st
        es_trans = [(t, st) for t, st, _ in es["events"].get(sid, []) if t >= log_start]
        missing_in_es = [f"{t:%H:%M:%S}Z {STATUS_LABELS.get(st, st)}" for t, st in log_trans
                         if now - t > IN_FLIGHT
                         and not any(st == s2 and abs(t - t2) <= EVENT_MATCH for t2, s2 in es_trans)]
        missing_in_log = [f"{t:%H:%M:%S}Z {STATUS_LABELS.get(st, st)}" for t, st in es_trans
                          if not any(st == s2 and abs(t - t2) <= EVENT_MATCH for t2, s2 in log_trans)]
        if missing_in_es:
            issues.append(("EVENTS", f"{len(missing_in_es)} log transition(s) with no ES Change: "
                                     + ", ".join(missing_in_es[:5]) + (" …" if len(missing_in_es) > 5 else "")))
        if missing_in_log:
            issues.append(("EVENTS", f"{len(missing_in_log)} ES Change doc(s) not seen in log: "
                                     + ", ".join(missing_in_log[:5]) + (" …" if len(missing_in_log) > 5 else "")))
        row["logTransitions"], row["esTransitions"] = len(log_trans), len(es_trans)
        rows.append(row)
    return rows


def type_matrix(rows, bi_counts, es):
    """sensor type × status counts per source."""
    m = defaultdict(lambda: {src: Counter() for src in ("bi", "es", "log")})
    for r in rows:
        for src in ("bi", "es", "log"):
            if r[src]:
                m[r["typeLabel"]][src][r[src]] += 1
    # ES non-dashboard sensors (servers, TLS, VA…) — shown separately so nothing is hidden
    other = defaultdict(Counter)
    shown = {r["id"] for r in rows}
    for sid, s in es["state"].items():
        if sid not in shown:
            other[type_label(s.get("type"))][s.get("status")] += 1
    bi_card = Counter()
    for t in bi_counts:
        bi_card["LPR"] += t.get("lpr", 0); bi_card["CCTV (Fix)"] += t.get("cctvFix", 0)
        bi_card["CCTV (PTZ)"] += t.get("cctvPtz", 0); bi_card["Face Recognition"] += t.get("fr", 0)
        bi_card["Video Analytics"] += t.get("va", 0)
    return m, other, bi_card


# ── Output ────────────────────────────────────────────────────────────────────

def fmt_counts(c):
    return " ".join(f"{STATUS_LABELS.get(s, s)}:{c[s]}" for s in STATUS_ORDER + sorted(set(c) - set(STATUS_ORDER), key=str) if c.get(s)) or "—"


def print_report(meta, rows, matrix, other, bi_card):
    print(f"\nSensor Health Validator — {meta['generated']}")
    print(f"  BI   {meta['bi']}")
    print(f"  ES   {meta['es']}  (snapshot {meta['cycle']}, {meta['snapCount']} docs)")
    print(f"  LOG  {meta['logFrom']} → {meta['logTo']} UTC  ({meta['logLines']} lines, "
          f"clock offset {meta['offset']} {meta['offsetSource']})")

    print("\n── Status by sensor type (on-dashboard sensors) " + "─" * 30)
    print(f"{'Type':<18}{'BI card':>8}  {'BI':<34}{'ES':<34}{'LOG (changed in window)'}")
    for t in sorted(matrix):
        src = matrix[t]
        flag = "" if sum(src["bi"].values()) == bi_card.get(t, sum(src["bi"].values())) else "  ⚠ card≠list"
        print(f"{t:<18}{bi_card.get(t, '-'):>8}  {fmt_counts(src['bi']):<34}{fmt_counts(src['es']):<34}"
              f"{fmt_counts(src['log'])}{flag}")
    for t in sorted(set(bi_card) - set(matrix)):
        if bi_card[t]:
            print(f"{t:<18}{bi_card[t]:>8}  ⚠ BI card counts sensors that the health list doesn't return")

    if other:
        print("\n── Other sensors in ES snapshot (not on BI dashboard) " + "─" * 24)
        for t in sorted(other):
            print(f"  {t:<24}{fmt_counts(other[t])}")

    print("\n── Per sensor " + "─" * 64)
    by_type = defaultdict(list)
    for r in rows:
        by_type[r["typeLabel"]].append(r)
    for t in sorted(by_type):
        print(f"\n[{t}]")
        print(f"  {'ID':<7}{'Name':<38}{'BI':<17}{'ES':<17}{'LOG':<17}Result")
        for r in by_type[t]:
            res = "OK" if not r["issues"] else "; ".join(k for k, _ in r["issues"])
            print(f"  {r['id']:<7}{(r['name'] or '')[:36]:<38}{STATUS_LABELS.get(r['bi'], r['bi']):<17}"
                  f"{STATUS_LABELS.get(r['es'], r['es']):<17}"
                  f"{(STATUS_LABELS.get(r['log'], r['log']) if r['log'] else 'no change'):<17}{res}")
            for k, msg in r["issues"]:
                print(f"         ↳ {k}: {msg}")

    print("\n── Log observations " + "─" * 58)
    print(f"  VMS cameras unknown to Units (not in cache/DB): {len(meta['unknownCams'])}")
    for g in meta["unknownCams"][:20]:
        print(f"    {g}")
    if meta["exports"]:
        bad = [x for x in meta["exports"] if x["published"] != x["total"]]
        last = meta["exports"][-1]
        print(f"  Export snapshots in log: {len(meta['exports'])} (last {last['cycle']}: "
              f"{last['published']}/{last['total']}), incomplete: {len(bad)}")

    n_bad = sum(1 for r in rows if r["issues"])
    print(f"\nResult: {len(rows) - n_bad}/{len(rows)} sensors consistent, {n_bad} with findings.\n")


def write_html(path, meta, rows, matrix, other, bi_card):
    e = html.escape
    st = lambda s: f'<span class="st {s or "none"}">{e(STATUS_LABELS.get(s, s or "—"))}</span>'

    def counts_cell(c):
        return " ".join(f'<span class="st {s}">{e(STATUS_LABELS.get(s, str(s)))} {c[s]}</span>'
                        for s in STATUS_ORDER + sorted(set(c) - set(STATUS_ORDER), key=str) if c.get(s)) or "—"

    type_rows = "".join(
        f"<tr><td>{e(t)}</td><td class=num>{bi_card.get(t, '–')}</td><td>{counts_cell(matrix[t]['bi'])}</td>"
        f"<td>{counts_cell(matrix[t]['es'])}</td><td>{counts_cell(matrix[t]['log'])}</td></tr>"
        for t in sorted(matrix))
    other_rows = "".join(f"<tr><td>{e(t)}</td><td>{counts_cell(other[t])}</td></tr>" for t in sorted(other))

    by_type = defaultdict(list)
    for r in rows:
        by_type[r["typeLabel"]].append(r)
    sections = []
    for t in sorted(by_type):
        trs = []
        for r in by_type[t]:
            issues = "".join(f'<div class="issue"><b>{e(k)}</b> {e(m)}</div>' for k, m in r["issues"]) \
                     or '<span class="ok">consistent</span>'
            d = r["logDetail"] or {}
            extra = ", ".join(f"{k}={v}" for k, v in d.items() if k not in ("name", "at"))
            trs.append(
                f"<tr class='{'bad' if r['issues'] else ''}'><td class=num>{r['id']}</td><td>{e(r['name'] or '')}</td>"
                f"<td>{st(r['bi'])}<div class=sub>bucket: {e(str(r['biBucket']))}</div></td>"
                f"<td>{st(r['es'])}<div class=sub>{e(r['esDescription'] or '')}</div></td>"
                f"<td>{st(r['log']) if r['log'] else '<span class=sub>no change in window</span>'}"
                f"<div class=sub>{e(extra)}</div></td>"
                f"<td class=num>{r['logTransitions']}/{r['esTransitions']}</td><td>{issues}</td></tr>")
        sections.append(f"<h3>{e(t)}</h3><table><thead><tr><th>ID</th><th>Name</th><th>BI</th><th>ES</th>"
                        f"<th>Units log (latest)</th><th>Transitions log/ES</th><th>Findings</th></tr></thead>"
                        f"<tbody>{''.join(trs)}</tbody></table>")

    n_bad = sum(1 for r in rows if r["issues"])
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Sensor Health Validator</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#8b949e;--ok:#3fb950;--warn:#d29922;--err:#f85149;--unk:#8b949e}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:1300px;margin:auto}} h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:16px;margin:28px 0 8px}}
h3{{font-size:14px;margin:20px 0 6px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}}
.meta{{color:var(--mut);font-size:12px}} .meta code{{color:var(--fg)}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:6px}}
th,td{{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}}
th{{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}}
.num{{font-variant-numeric:tabular-nums;white-space:nowrap}} .sub{{color:var(--mut);font-size:11px}}
.st{{display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;margin:1px 2px 1px 0;border:1px solid}}
.workingproperly{{color:var(--ok);border-color:#3fb95055}} .malfunction{{color:var(--warn);border-color:#d2992255}}
.failed{{color:var(--err);border-color:#f8514955}} .unknown,.none{{color:var(--unk);border-color:#8b949e55}}
tr.bad{{background:#f851490d}} .issue{{font-size:12px}} .issue b{{color:var(--warn)}} .ok{{color:var(--ok);font-size:12px}}
.summary{{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}} .tile{{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 14px}}
.tile b{{display:block;font-size:22px}}
</style></head><body><main>
<h1>Sensor Health Validator</h1>
<div class="meta">Generated {e(meta['generated'])} · BI <code>{e(meta['bi'])}</code> · ES <code>{e(meta['es'])}</code>
 (snapshot {e(meta['cycle'])}) · Units log {e(meta['logFrom'])} → {e(meta['logTo'])} UTC, offset {e(meta['offset'])} ({e(meta['offsetSource'])})</div>
<div class="summary"><div class="tile"><b>{len(rows)}</b>sensors compared</div>
<div class="tile"><b style="color:var(--ok)">{len(rows) - n_bad}</b>consistent</div>
<div class="tile"><b style="color:var(--err)">{n_bad}</b>with findings</div>
<div class="tile"><b>{len(meta['unknownCams'])}</b>VMS cameras unknown to Units</div></div>
<h2>Status by sensor type</h2><div class="wrap"><table><thead><tr><th>Type</th><th>BI card</th><th>BI list</th><th>ES (current)</th>
<th>Units log (changed in window)</th></tr></thead><tbody>{type_rows}</tbody></table></div>
<h2>Per sensor</h2><div class="wrap">{''.join(sections)}</div>
<h2>Other sensors in ES snapshot (not on BI dashboard)</h2><div class="wrap"><table><tbody>{other_rows}</tbody></table></div>
</main></body></html>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bi", default=DEFAULT_BI)
    ap.add_argument("--es", default=DEFAULT_ES)
    ap.add_argument("--log", default=DEFAULT_LOG)
    ap.add_argument("--log-utc-offset", type=float, default=3,
                    help="hours the log clock is ahead of UTC, used only if auto-calibration fails")
    ap.add_argument("--html", help="write an HTML report to this path")
    ap.add_argument("--json", help="write raw results as JSON to this path")
    args = ap.parse_args()

    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    try:
        meta, rows, matrix, other, bi_card = run_validation(args.bi, args.es, args.log, args.log_utc_offset)
    except LogUnavailable as ex:
        sys.exit(f"Cannot open Units log: {ex}\nMap the share first (net use) or set SHV_USER / SHV_PASSWORD.")

    print_report(meta, rows, matrix, other, bi_card)
    if args.html:
        write_html(args.html, meta, rows, matrix, other, bi_card)
        print(f"HTML report: {os.path.abspath(args.html)}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(to_json(meta, rows, matrix, other, bi_card), f, indent=2, default=str)
        print(f"JSON: {os.path.abspath(args.json)}")
    sys.exit(1 if any(r["issues"] for r in rows) else 0)


def run_validation(bi_url=DEFAULT_BI, es_url=DEFAULT_ES, log_path=DEFAULT_LOG, utc_offset=3.0):
    """Fetch all three sources and compare. Raises LogUnavailable if the log can't be opened."""
    log = parse_log(log_path)
    bi, bi_counts = fetch_bi(bi_url)
    offset_guess = timedelta(hours=utc_offset)
    es = fetch_es(es_url, (log["first"] - offset_guess).replace(tzinfo=timezone.utc))
    offset, offset_src = calibrate_offset(log, es["raw"], utc_offset)

    rows = compare(bi, es, log, offset)
    matrix, other, bi_card = type_matrix(rows, bi_counts, es)
    to_utc = lambda ts: (ts - offset).strftime("%Y-%m-%d %H:%M:%S")
    meta = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "bi": bi_url, "es": es_url, "log": log_path,
        "cycle": es["cycle"], "snapCount": es["snapCount"],
        "logFrom": to_utc(log["first"]), "logTo": to_utc(log["last"]), "logLines": log["lines"],
        "offset": f"UTC{offset.total_seconds() / 3600:+g}h", "offsetSource": offset_src,
        "unknownCams": log["unknownCams"], "exports": log["exports"],
    }
    return meta, rows, matrix, other, bi_card


def to_json(meta, rows, matrix, other, bi_card):
    sensors = []
    for r in rows:
        r = dict(r)
        r["issues"] = [{"kind": k, "message": m} for k, m in r["issues"]]
        if r["logDetail"] and "at" in r["logDetail"]:
            r["logDetail"] = {**r["logDetail"], "at": str(r["logDetail"]["at"])}
        sensors.append(r)
    return {
        "meta": meta, "sensors": sensors,
        "byType": {t: {k: dict(v) for k, v in s.items()} for t, s in matrix.items()},
        "other": {t: {str(k): v for k, v in c.items()} for t, c in other.items()},
        "biCard": dict(bi_card),
        "summary": {"total": len(rows), "withFindings": sum(1 for r in rows if r["issues"]),
                    "byKind": dict(Counter(k for r in rows for k, _ in r["issues"]))},
    }


if __name__ == "__main__":
    main()

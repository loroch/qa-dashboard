"""
BI tab — event analytics from the environment chosen in the Validation Portal
profile (same SQL Server + Elasticsearch settings).

Vulcan (SQL Server), for events created in [from, to):
  volume / state / severity / source / type / hour of day / creators,
  enrichment (files/images, detections, cameras, dispatch),
  updates per event + which fields change   (VulcanAuditDB.C4IData.EventsData_Audit),
  end-to-end times: create → first update / close, create → dispatch → arrived → done
                                            (EventsToResources + CityData.DispatchAudit),
  data-quality checks.
Elasticsearch, clipped to what the indices retain:
  log volume per service/day, levels, error components + top messages,
  BFF API latency per endpoint, C-Insight operation timings, nginx status codes,
  detections per day / type / with files.
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

import anthropic

from app.config import get_settings
from app.database.db import AppSettingORM, get_session_factory
from app.services.env_validation_service import AI_MODEL, BFF_API_RE, get_env_validation_service

logger = logging.getLogger(__name__)

LAST_REPORT_KEY = "bi_last_report"
OP_DURATION_RE = re.compile(r"(?:^|\]\s*)([A-Za-z][\w .\[\]/:<>-]{2,90}?):\s*duration = ([\d.]+) seconds")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _pct(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    v = sorted(values)
    return round(v[min(len(v) - 1, int(round((len(v) - 1) * p)))], 1)


def _sec_stats(values: list[float]) -> dict:
    vals = [x for x in values if x is not None]
    return {"count": len(vals), "avg": round(sum(vals) / len(vals), 1) if vals else None,
            "p50": _pct(vals, 0.5), "p90": _pct(vals, 0.9), "max": round(max(vals), 1) if vals else None}


class BIService:
    def __init__(self):
        self.env = get_env_validation_service()

    # ------------------------------------------------------------------
    # SQL helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _query(db: dict, sql: str, params: Optional[dict] = None, max_rows: int = 5000) -> list[dict]:
        import pymssql
        conn = pymssql.connect(server=db["server"], port=int(db.get("port") or 1433), user=db["user"],
                               password=db["password"], database=db["database"],
                               login_timeout=10, timeout=300, charset="UTF-8", as_dict=True)
        try:
            cur = conn.cursor()
            cur.execute(sql, params or {})
            rows = cur.fetchmany(max_rows) if cur.description else []
            return [{k: (v.isoformat() if hasattr(v, "isoformat") else float(v) if isinstance(v, Decimal) else v)
                     for k, v in r.items()} for r in rows]
        finally:
            conn.close()

    async def databases(self, incoming: Optional[dict] = None) -> list[str]:
        p = await self.env._resolve(incoming)
        rows = await asyncio.to_thread(self._query, p["db"], "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")
        return [r["name"] for r in rows]

    # ------------------------------------------------------------------
    # Report
    # ------------------------------------------------------------------

    async def report(self, date_from: datetime, date_to: datetime, sources: dict, database: Optional[str],
                     audit_database: Optional[str], detections_index: Optional[str],
                     incoming: Optional[dict] = None) -> dict:
        p = await self.env._resolve(incoming)
        started = time.monotonic()
        out: dict = {
            "range": {"from": date_from.isoformat(), "to": date_to.isoformat(),
                      "days": round((date_to - date_from).total_seconds() / 86400, 1)},
            "environment": {"name": p.get("name"), "web": p["web"]["url"], "db_server": p["db"]["server"],
                            "database": database or p["db"]["database"], "audit_database": audit_database or "VulcanAuditDB",
                            "elastic": p["elastic"]["url"], "log_index": p["elastic"]["index"],
                            "detections_index": detections_index or "detections_*"},
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        tasks = {}
        if sources.get("db", True):
            db = {**p["db"], "database": database or p["db"]["database"]}
            tasks["db"] = self._db_report(db, audit_database or "VulcanAuditDB", date_from, date_to)
        if sources.get("elastic", True):
            tasks["elastic"] = self._es_report(p, date_from, date_to, detections_index or "detections_*")
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for name, res in zip(tasks.keys(), results):
            if isinstance(res, Exception):
                logger.warning("BI %s section failed: %s", name, res, exc_info=res)
                out[name] = {"error": str(res)[:500]}
            else:
                out[name] = res
        out["took_ms"] = round((time.monotonic() - started) * 1000)
        await self._save_last(out)
        return out

    async def _save_last(self, report: dict) -> None:
        factory = get_session_factory()
        async with factory() as session:
            row = await session.get(AppSettingORM, LAST_REPORT_KEY)
            value = json.dumps(report, default=str)
            if row:
                row.value = value
            else:
                session.add(AppSettingORM(key=LAST_REPORT_KEY, value=value))
            await session.commit()

    async def last_report(self) -> Optional[dict]:
        factory = get_session_factory()
        async with factory() as session:
            row = await session.get(AppSettingORM, LAST_REPORT_KEY)
            return json.loads(row.value) if row and row.value else None

    # ------------------------------------------------------------------
    # Vulcan
    # ------------------------------------------------------------------

    async def _db_report(self, db: dict, audit_db: str, f: datetime, t: datetime) -> dict:
        if not re.fullmatch(r"\w+", audit_db):
            raise ValueError("Invalid audit database name")
        A = f"[{audit_db}].C4IData.EventsData_Audit"
        prm = {"f": f.replace(tzinfo=None), "t": t.replace(tzinfo=None)}
        W = "e.IsDeleted = 0 AND e.EventCreationTime >= %(f)s AND e.EventCreationTime < %(t)s"
        q = {
            "kpi": f"""SELECT COUNT(*) AS created,
                    SUM(CASE WHEN e.State = 4 THEN 1 ELSE 0 END) AS closed,
                    SUM(CASE WHEN e.State <> 4 THEN 1 ELSE 0 END) AS still_open,
                    SUM(CASE WHEN e.IsFalseAlarm = 1 THEN 1 ELSE 0 END) AS false_alarms,
                    SUM(CASE WHEN e.SourceType IN (1, 2) THEN 1 ELSE 0 END) AS manual,
                    SUM(CASE WHEN e.IsSeverityOverridden = 1 THEN 1 ELSE 0 END) AS severity_overridden
                FROM C4IData.EventsData e WHERE {W}""",
            "created_daily": f"""SELECT CAST(e.EventCreationTime AS date) AS day, COUNT(*) AS n
                FROM C4IData.EventsData e WHERE {W} GROUP BY CAST(e.EventCreationTime AS date)""",
            "closed_daily": """SELECT CAST(e.EventClosedTime AS date) AS day, COUNT(*) AS n FROM C4IData.EventsData e
                WHERE e.IsDeleted = 0 AND e.EventClosedTime >= %(f)s AND e.EventClosedTime < %(t)s
                GROUP BY CAST(e.EventClosedTime AS date)""",
            "updates_daily": f"""SELECT CAST(a.ADT_Date AS date) AS day, COUNT(*) AS n FROM {A} a
                WHERE a.ADT_Type = 'U' AND a.ADT_Date >= %(f)s AND a.ADT_Date < %(t)s GROUP BY CAST(a.ADT_Date AS date)""",
            "dispatch_daily": f"""SELECT CAST(e.EventCreationTime AS date) AS day, COUNT(DISTINCT r.EventId) AS n
                FROM C4IData.EventsToResources r JOIN C4IData.EventsData e ON e.EventID = r.EventId WHERE {W}
                GROUP BY CAST(e.EventCreationTime AS date)""",
            "by_severity": f"""SELECT e.Severity AS id, COUNT(*) AS n, SUM(CASE WHEN e.State = 4 THEN 1 ELSE 0 END) AS closed
                FROM C4IData.EventsData e WHERE {W} GROUP BY e.Severity""",
            "close_times": f"""SELECT e.Severity AS severity, DATEDIFF(second, e.EventCreationTime, e.EventClosedTime) AS s
                FROM C4IData.EventsData e WHERE {W} AND e.EventClosedTime IS NOT NULL""",
            "by_source": f"SELECT e.SourceType AS id, COUNT(*) AS n FROM C4IData.EventsData e WHERE {W} GROUP BY e.SourceType",
            "by_state": f"SELECT e.State AS id, COUNT(*) AS n FROM C4IData.EventsData e WHERE {W} GROUP BY e.State",
            "by_type": f"""SELECT TOP 12 e.EventType AS id, MAX(ISNULL(et.EventTypeName, CONCAT('Type ', e.EventType))) AS name,
                    COUNT(*) AS n, SUM(CASE WHEN e.State = 4 THEN 1 ELSE 0 END) AS closed
                FROM C4IData.EventsData e LEFT JOIN Configuration.EventTypes et ON et.EventTypeId = e.EventType
                WHERE {W} GROUP BY e.EventType ORDER BY n DESC""",
            "by_hour": f"""SELECT DATEPART(hour, e.EventCreationTime) AS hour, COUNT(*) AS n
                FROM C4IData.EventsData e WHERE {W} GROUP BY DATEPART(hour, e.EventCreationTime)""",
            "by_weekday": f"""SELECT DATEPART(weekday, e.EventCreationTime) AS wd, COUNT(*) AS n
                FROM C4IData.EventsData e WHERE {W} GROUP BY DATEPART(weekday, e.EventCreationTime)""",
            "top_creators": f"""SELECT TOP 10 e.CreatedByUserID AS id,
                    MAX(COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName))), ''), u.Username, CONCAT('User ', e.CreatedByUserID))) AS name,
                    COUNT(*) AS n
                FROM C4IData.EventsData e LEFT JOIN TenantManagement.Users u ON u.UserId = e.CreatedByUserID
                WHERE {W} GROUP BY e.CreatedByUserID ORDER BY n DESC""",
            "enrichment": f"""SELECT
                    (SELECT COUNT(DISTINCT x.EventID) FROM C4IData.EventsToFileLinks x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS with_files,
                    (SELECT COUNT(*) FROM C4IData.EventsToFileLinks x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS files,
                    (SELECT COUNT(DISTINCT x.EventID) FROM C4IData.EventsToDetections x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS with_detections,
                    (SELECT COUNT(*) FROM C4IData.EventsToDetections x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS detections,
                    (SELECT COUNT(DISTINCT x.EventID) FROM C4IData.EventsToCameras x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS with_cameras,
                    (SELECT COUNT(DISTINCT x.EventID) FROM C4IData.EventsToObjects x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS with_objects,
                    (SELECT COUNT(DISTINCT x.EventId) FROM C4IData.EventsToResources x JOIN C4IData.EventsData e ON e.EventID = x.EventId WHERE {W}) AS with_dispatch,
                    (SELECT COUNT(*) FROM CityData.DispatchUnitRequest x JOIN C4IData.EventsData e ON e.EventID = x.EventId WHERE {W}) AS dispatch_requests,
                    (SELECT COUNT(DISTINCT x.EventID) FROM C4IData.EventsToEvents x JOIN C4IData.EventsData e ON e.EventID = x.EventID WHERE {W}) AS with_linked_events""",
            "updates_per_event": f"""SELECT e.EventID AS id, e.Severity AS severity, e.EventType AS type, COUNT(a.ADT_ID) AS n
                FROM C4IData.EventsData e LEFT JOIN {A} a ON a.EventID = e.EventID AND a.ADT_Type = 'U' AND a.ADT_Date >= %(f)s
                WHERE {W} GROUP BY e.EventID, e.Severity, e.EventType""",
            "changed_fields": f"""SELECT
                    SUM(CASE WHEN State IS NOT NULL THEN 1 ELSE 0 END) AS State,
                    SUM(CASE WHEN OwnerID IS NOT NULL THEN 1 ELSE 0 END) AS Owner,
                    SUM(CASE WHEN Severity IS NOT NULL THEN 1 ELSE 0 END) AS Severity,
                    SUM(CASE WHEN ManualSeverity IS NOT NULL THEN 1 ELSE 0 END) AS ManualSeverity,
                    SUM(CASE WHEN Priority IS NOT NULL THEN 1 ELSE 0 END) AS Priority,
                    SUM(CASE WHEN EventType IS NOT NULL THEN 1 ELSE 0 END) AS EventType,
                    SUM(CASE WHEN Description IS NOT NULL THEN 1 ELSE 0 END) AS Description,
                    SUM(CASE WHEN Comment IS NOT NULL THEN 1 ELSE 0 END) AS Comment,
                    SUM(CASE WHEN StreetAddress IS NOT NULL THEN 1 ELSE 0 END) AS Address,
                    SUM(CASE WHEN Location IS NOT NULL THEN 1 ELSE 0 END) AS Location,
                    SUM(CASE WHEN Status IS NOT NULL THEN 1 ELSE 0 END) AS Status,
                    SUM(CASE WHEN SLA IS NOT NULL THEN 1 ELSE 0 END) AS SLA,
                    SUM(CASE WHEN EventClosedTime IS NOT NULL THEN 1 ELSE 0 END) AS Closed,
                    SUM(CASE WHEN IsFalseAlarm IS NOT NULL THEN 1 ELSE 0 END) AS FalseAlarm,
                    SUM(CASE WHEN ClosingReason IS NOT NULL THEN 1 ELSE 0 END) AS ClosingReason
                FROM {A} WHERE ADT_Type = 'U' AND ADT_Date >= %(f)s AND ADT_Date < %(t)s""",
            "first_update": f"""SELECT DATEDIFF(second, e.EventCreationTime, fu.first_u) AS s FROM C4IData.EventsData e
                CROSS APPLY (SELECT MIN(a.ADT_Date) AS first_u FROM {A} a WHERE a.EventID = e.EventID AND a.ADT_Type = 'U') fu
                WHERE {W} AND fu.first_u IS NOT NULL""",
            "dispatch_steps": f"""SELECT a.Value AS step, CAST(a.DispatchId AS nvarchar(64)) AS dispatch_id,
                    MIN(DATEDIFF(second, e.EventCreationTime, a.Time)) AS s
                FROM C4IData.EventsToResources r JOIN C4IData.EventsData e ON e.EventID = r.EventId
                JOIN CityData.DispatchAudit a ON CAST(a.DispatchId AS nvarchar(64)) = CAST(r.DispatchId AS nvarchar(64)) AND a.Action = 0
                WHERE {W} AND r.DispatchId IS NOT NULL GROUP BY a.Value, CAST(a.DispatchId AS nvarchar(64))""",
            "quality": f"""SELECT
                    SUM(CASE WHEN e.State = 4 AND e.EventClosedTime IS NULL THEN 1 ELSE 0 END) AS closed_without_close_time,
                    SUM(CASE WHEN e.State <> 4 AND e.EventClosedTime IS NOT NULL THEN 1 ELSE 0 END) AS close_time_but_not_closed,
                    SUM(CASE WHEN e.EventClosedTime < e.EventCreationTime THEN 1 ELSE 0 END) AS closed_before_created,
                    SUM(CASE WHEN e.State = 4 AND e.ClosingReason IS NULL THEN 1 ELSE 0 END) AS closed_without_reason,
                    SUM(CASE WHEN e.LastModificationTime < e.EventCreationTime THEN 1 ELSE 0 END) AS modified_before_created,
                    SUM(CASE WHEN e.Severity IS NULL OR e.Severity NOT BETWEEN 1 AND 5 THEN 1 ELSE 0 END) AS invalid_severity,
                    SUM(CASE WHEN e.State <> 4 AND e.EventCreationTime < DATEADD(day, -7, GETUTCDATE()) THEN 1 ELSE 0 END) AS open_older_than_7d
                FROM C4IData.EventsData e WHERE {W}""",
            "lookup_source": "SELECT * FROM Configuration.EventsSourceTypes",
            "lookup_state": "SELECT * FROM Configuration.EventsStatesTypes",
            "lookup_severity": "SELECT * FROM Configuration.EventSeverties",
        }

        async def run(name, sql):
            t0 = time.monotonic()
            try:
                rows = await asyncio.to_thread(self._query, db, sql, prm, 200000)
                return name, rows, round((time.monotonic() - t0) * 1000), None
            except Exception as exc:
                return name, [], round((time.monotonic() - t0) * 1000), str(exc)[:300]

        # a few connections at a time — gentle on the shared lab SQL Server
        sem = asyncio.Semaphore(4)

        async def limited(name, sql):
            async with sem:
                return await run(name, sql)
        raw = await asyncio.gather(*(limited(n, s) for n, s in q.items()))
        R = {n: rows for n, rows, _, _ in raw}
        timings = {n: ms for n, _, ms, _ in raw}
        errors = {n: e for n, _, _, e in raw if e}

        def lookup(rows):
            out = {}
            for r in rows:
                vals = list(r.values())
                if len(vals) >= 2:
                    out[vals[0]] = vals[1]
            return out
        src_names, state_names, sev_names = (lookup(R["lookup_source"]), lookup(R["lookup_state"]),
                                             lookup(R["lookup_severity"]))
        sev_names = sev_names or {1: "Critical", 2: "High", 3: "Medium", 4: "Low", 5: "Very Low"}

        kpi = (R["kpi"] or [{}])[0]
        created = kpi.get("created") or 0
        enr = (R["enrichment"] or [{}])[0]

        days, d = [], f.date()
        while d < t.date() or (d == t.date() and t.time() > datetime.min.time()):
            days.append(d.isoformat())
            d += timedelta(days=1)
        series = {k: {str(r["day"])[:10]: r["n"] for r in R[k]} for k in ("created_daily", "closed_daily", "updates_daily", "dispatch_daily")}
        daily = [{"day": day, "created": series["created_daily"].get(day, 0), "closed": series["closed_daily"].get(day, 0),
                  "updates": series["updates_daily"].get(day, 0), "dispatched": series["dispatch_daily"].get(day, 0)} for day in days]

        close_by_sev: dict = {}
        for r in R["close_times"]:
            close_by_sev.setdefault(r["severity"], []).append(r["s"])
        all_close = [r["s"] for r in R["close_times"]]
        severity = [{"id": r["id"], "name": sev_names.get(r["id"], str(r["id"])), "count": r["n"], "closed": r["closed"],
                     "close_time": _sec_stats(close_by_sev.get(r["id"], []))}
                    for r in sorted(R["by_severity"], key=lambda r: (r["id"] is None, r["id"]))]

        upe = R["updates_per_event"]
        counts = [r["n"] for r in upe]
        buckets = [("0", lambda n: n == 0), ("1", lambda n: n == 1), ("2", lambda n: n == 2), ("3–5", lambda n: 3 <= n <= 5),
                   ("6–10", lambda n: 6 <= n <= 10), ("11–20", lambda n: 11 <= n <= 20), (">20", lambda n: n > 20)]
        cf = (R["changed_fields"] or [{}])[0]

        steps: dict = {}
        for r in R["dispatch_steps"]:
            steps.setdefault(r["step"], []).append(r["s"])
        step_order = ["Dispatch", "AcceptedDispatch", "OnRoute", "Arrived", "OnScene", "Done", "Rejected", "Undispatched"]
        funnel = [{"step": s, **_sec_stats(v)} for s, v in sorted(steps.items(), key=lambda kv: step_order.index(kv[0]) if kv[0] in step_order else 99)]
        # Arrived recorded before Dispatch for the same dispatch = clock / ordering problem
        per_dispatch: dict = {}
        for r in R["dispatch_steps"]:
            per_dispatch.setdefault(r["dispatch_id"], {})[r["step"]] = r["s"]
        arrived_before_dispatch = sum(1 for v in per_dispatch.values()
                                      if "Arrived" in v and "Dispatch" in v and v["Arrived"] < v["Dispatch"])
        quality = dict((R["quality"] or [{}])[0])
        quality["dispatch_arrived_before_dispatched"] = arrived_before_dispatch
        quality["negative_close_durations"] = sum(1 for s in all_close if s is not None and s < 0)

        wd_names = {1: "Sun", 2: "Mon", 3: "Tue", 4: "Wed", 5: "Thu", 6: "Fri", 7: "Sat"}
        return {
            "kpi": {**kpi, "created": created,
                    "with_files": enr.get("with_files"), "files": enr.get("files"),
                    "with_detections": enr.get("with_detections"), "detections": enr.get("detections"),
                    "with_cameras": enr.get("with_cameras"), "with_objects": enr.get("with_objects"),
                    "with_dispatch": enr.get("with_dispatch"), "dispatch_requests": enr.get("dispatch_requests"),
                    "with_linked_events": enr.get("with_linked_events"),
                    "updates": sum(counts), "avg_updates_per_event": round(sum(counts) / len(counts), 2) if counts else None,
                    "max_updates_per_event": max(counts) if counts else None,
                    "never_updated": sum(1 for n in counts if n == 0)},
            "daily": daily,
            "severity": severity,
            "source": [{"id": r["id"], "name": src_names.get(r["id"], str(r["id"])), "count": r["n"]} for r in sorted(R["by_source"], key=lambda r: -r["n"])],
            "state": [{"id": r["id"], "name": state_names.get(r["id"], str(r["id"])), "count": r["n"]} for r in sorted(R["by_state"], key=lambda r: r["id"] if r["id"] is not None else 99)],
            "types": [{"id": r["id"], "name": r["name"], "count": r["n"], "closed": r["closed"]} for r in R["by_type"]],
            "hours": [{"hour": h, "count": next((r["n"] for r in R["by_hour"] if r["hour"] == h), 0)} for h in range(24)],
            "weekdays": [{"day": wd_names[i], "count": next((r["n"] for r in R["by_weekday"] if r["wd"] == i), 0)} for i in range(1, 8)],
            "creators": [{"id": r["id"], "name": r["name"], "count": r["n"]} for r in R["top_creators"]],
            "updates": {
                "distribution": [{"bucket": b, "events": sum(1 for n in counts if fn(n))} for b, fn in buckets],
                "changed_fields": sorted(({"field": k, "count": v or 0} for k, v in cf.items()), key=lambda x: -x["count"]),
                "most_updated": [{"id": r["id"], "updates": r["n"], "severity": sev_names.get(r["severity"], r["severity"]), "type": r["type"]}
                                 for r in sorted(upe, key=lambda r: -r["n"])[:10]],
            },
            "times": {
                "create_to_close": _sec_stats(all_close),
                "create_to_first_update": _sec_stats([r["s"] for r in R["first_update"]]),
                "dispatch_funnel": funnel,
            },
            "quality": quality,
            "timings_ms": timings,
            "errors": errors,
        }

    # ------------------------------------------------------------------
    # Elasticsearch
    # ------------------------------------------------------------------

    async def _es_report(self, p: dict, f: datetime, t: datetime, det_index: str) -> dict:
        base = p["elastic"]["url"].rstrip("/")
        log_idx = p["elastic"]["index"]
        rng = {"range": {"@timestamp": {"gte": f.isoformat(), "lt": t.isoformat()}}}
        out: dict = {"errors": {}}
        async with self.env._es_client(p) as c:
            async def search(index, body, name):
                try:
                    r = await c.post(f"{base}/{index}/_search", json=body, timeout=120)
                    r.raise_for_status()
                    return r.json()
                except Exception as exc:
                    out["errors"][name] = str(exc)[:300]
                    return None

            overview = await search(log_idx, {"size": 0, "track_total_hits": True, "query": rng, "aggs": {
                "first": {"min": {"field": "@timestamp"}}, "last": {"max": {"field": "@timestamp"}},
                "daily": {"date_histogram": {"field": "@timestamp", "calendar_interval": "day"},
                          "aggs": {"svc": {"terms": {"field": "service.name", "size": 10}},
                                   "err": {"filter": {"terms": {"log.level": ["error", "fatal", "critical"]}}}}},
                "svc": {"terms": {"field": "service.name", "size": 10},
                        "aggs": {"lvl": {"terms": {"field": "log.level", "size": 10}}}},
                "err_loggers": {"filter": {"terms": {"log.level": ["error", "fatal", "critical"]}},
                                "aggs": {"by": {"terms": {"field": "loggername", "size": 15}},
                                         "files": {"terms": {"field": "log.file.path", "size": 15}}}},
                "warn_loggers": {"filter": {"term": {"log.level": "warning"}},
                                 "aggs": {"by": {"terms": {"field": "loggername", "size": 10}}}},
                "web_status": {"filter": {"term": {"service.name": "web"}},
                               "aggs": {"codes": {"terms": {"field": "http.response.status_code", "size": 20}},
                                        "bad": {"filter": {"range": {"http.response.status_code": {"gte": 400}}},
                                                "aggs": {"urls": {"terms": {"field": "url.original", "size": 10}}}}}},
            }}, "overview")
            if overview:
                a = overview["aggregations"]
                out["coverage"] = {"first": a["first"].get("value_as_string"), "last": a["last"].get("value_as_string"),
                                   "lines": overview["hits"]["total"]["value"]}
                out["daily"] = [{"day": b["key_as_string"][:10], "total": b["doc_count"], "errors": b["err"]["doc_count"],
                                 **{s["key"]: s["doc_count"] for s in b["svc"]["buckets"]}} for b in a["daily"]["buckets"]]
                out["services"] = [{"service": b["key"], "lines": b["doc_count"],
                                    "levels": {l["key"]: l["doc_count"] for l in b["lvl"]["buckets"]}} for b in a["svc"]["buckets"]]
                out["error_components"] = [{"logger": b["key"], "errors": b["doc_count"]} for b in a["err_loggers"]["by"]["buckets"]]
                out["error_files"] = [{"file": re.sub(r"^.*[\\/]Logs[\\/]", "", b["key"]), "errors": b["doc_count"]}
                                      for b in a["err_loggers"]["files"]["buckets"]]
                out["warning_components"] = [{"logger": b["key"], "warnings": b["doc_count"]} for b in a["warn_loggers"]["by"]["buckets"]]
                out["web"] = {"status_codes": [{"code": b["key"], "count": b["doc_count"]} for b in a["web_status"]["codes"]["buckets"]],
                              "bad_urls": [{"url": b["key"][:160], "count": b["doc_count"]} for b in a["web_status"]["bad"]["urls"]["buckets"]]}

            err_docs = await search(log_idx, {"size": 400, "_source": ["@timestamp", "message", "loggername"],
                                              "query": {"bool": {"must": [rng, {"terms": {"log.level": ["error", "fatal", "critical"]}}]}},
                                              "sort": [{"@timestamp": "desc"}]}, "error_messages")
            if err_docs:
                groups: dict = {}
                for h in err_docs["hits"]["hits"]:
                    s = h["_source"]
                    msg = ANSI_RE.sub("", s.get("message") or "").strip()
                    sig = (s.get("loggername"), re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27,}|\b\d+\b", "#", msg)[:120])
                    g = groups.setdefault(sig, {"logger": s.get("loggername"), "sample": msg[:400], "count": 0, "latest": s.get("@timestamp")})
                    g["count"] += 1
                out["top_errors"] = sorted(groups.values(), key=lambda g: -g["count"])[:15]

            # BFF API latency — page through the [API] lines (bounded)
            api_lines, after = [], None
            for _ in range(10):
                body = {"size": 10000, "_source": ["@timestamp", "message"], "sort": [{"@timestamp": "desc"}, {"_doc": "asc"}],
                        "query": {"bool": {"must": [rng, {"match_phrase": {"message": "[API]"}}]}}}
                if after:
                    body["search_after"] = after
                res = await search(log_idx, body, "bff_api")
                hits = (res or {}).get("hits", {}).get("hits", [])
                api_lines += hits
                if len(hits) < 10000:
                    break
                after = hits[-1]["sort"]
            ep: dict = {}
            api_daily: dict = {}
            for h in api_lines:
                m = BFF_API_RE.search(h["_source"].get("message", ""))
                if not m:
                    continue
                method, path, status, ms = m.group(1), m.group(2).split("?")[0], int(m.group(3)), float(m.group(4))
                path = re.sub(r"/\d+(?=/|$)", "/{id}", path)
                e = ep.setdefault(f"{method} {path}", {"endpoint": f"{method} {path}", "calls": 0, "errors_5xx": 0, "errors_4xx": 0, "ms": []})
                e["calls"] += 1
                e["ms"].append(ms)
                e["errors_5xx"] += status >= 500
                e["errors_4xx"] += 400 <= status < 500
                day = h["_source"]["@timestamp"][:10]
                dd = api_daily.setdefault(day, {"day": day, "calls": 0, "ms": []})
                dd["calls"] += 1
                dd["ms"].append(ms)
            endpoints = []
            for e in ep.values():
                ms = e.pop("ms")
                e.update(avg_ms=round(sum(ms) / len(ms)), p95_ms=_pct(ms, 0.95), max_ms=round(max(ms)))
                endpoints.append(e)
            out["bff"] = {
                "lines_analyzed": len(api_lines), "capped": len(api_lines) >= 100000,
                "endpoints": sorted(endpoints, key=lambda e: -e["calls"])[:40],
                "slowest": sorted(endpoints, key=lambda e: -(e["p95_ms"] or 0))[:12],
                "event_endpoints": sorted([e for e in endpoints if "event" in e["endpoint"].lower()], key=lambda e: -e["calls"])[:15],
                "daily": [{"day": d["day"], "calls": d["calls"], "avg_ms": round(sum(d["ms"]) / len(d["ms"])), "p95_ms": _pct(d["ms"], 0.95)}
                          for d in sorted(api_daily.values(), key=lambda d: d["day"])],
            }

            ops_res = await search(log_idx, {"size": 10000, "_source": ["message", "loggername"], "sort": [{"@timestamp": "desc"}],
                                             "query": {"bool": {"must": [rng, {"match_phrase": {"message": "duration ="}},
                                                                         {"term": {"service.name": "cinsight"}}]}}}, "cinsight_ops")
            ops: dict = {}
            for h in (ops_res or {}).get("hits", {}).get("hits", []):
                m = OP_DURATION_RE.search(h["_source"].get("message", ""))
                if not m:
                    continue
                name = re.sub(r"\[user = [^\]]*\]|\b\d+\b", "#", m.group(1)).strip()[:90]
                o = ops.setdefault(name, {"operation": name, "logger": h["_source"].get("loggername"), "s": []})
                o["s"].append(float(m.group(2)))
            op_list = []
            for o in ops.values():
                s = o.pop("s")
                o.update(calls=len(s), avg_s=round(sum(s) / len(s), 3), p95_s=_pct(s, 0.95), max_s=round(max(s), 3))
                op_list.append(o)
            out["cinsight_ops"] = {"lines_analyzed": len((ops_res or {}).get("hits", {}).get("hits", [])),
                                   "slowest": sorted(op_list, key=lambda o: -(o["p95_s"] or 0))[:15],
                                   "busiest": sorted(op_list, key=lambda o: -o["calls"])[:15]}

            det = await search(det_index, {"size": 0, "track_total_hits": True,
                                           "query": {"range": {"Time": {"gte": f.isoformat(), "lt": t.isoformat()}}},
                                           "aggs": {"daily": {"date_histogram": {"field": "Time", "calendar_interval": "day"}},
                                                    "types": {"terms": {"field": "GenericDetectionTypeId", "size": 15}},
                                                    "sensors": {"cardinality": {"field": "SensorId"}},
                                                    "with_files": {"filter": {"exists": {"field": "Files"}}}}}, "detections")
            if det:
                a = det["aggregations"]
                out["detections"] = {"total": det["hits"]["total"]["value"], "with_files": a["with_files"]["doc_count"],
                                     "sensors": a["sensors"]["value"],
                                     "daily": [{"day": b["key_as_string"][:10], "count": b["doc_count"]} for b in a["daily"]["buckets"]],
                                     "types": [{"type": b["key"], "count": b["doc_count"]} for b in a["types"]["buckets"]]}
        return out

    # ------------------------------------------------------------------
    # AI insights
    # ------------------------------------------------------------------

    async def insights(self, report: dict) -> dict:
        s = get_settings()
        if not s.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is not set")
        compact = json.loads(json.dumps(report, default=str))
        compact.pop("insights", None)  # regenerate from the data, not from earlier insights
        for k in ("timings_ms",):
            (compact.get("db") or {}).pop(k, None)
        prompt = f"""You are a BI analyst + QA lead for the K1 public-safety command platform (events created by
operators or automatic integrations — SAP/PBX, TLS, patrol — enriched with detections, files/images and cameras,
dispatched to units; backend logs in Elasticsearch). Times are in seconds, dates in UTC.

DATA (JSON) for {report['range']['from'][:10]} → {report['range']['to'][:10]} on {report['environment']['web']}:
{json.dumps(compact, ensure_ascii=False)[:70000]}

Write concise, numeric insights for a QA manager. Use real numbers from the data, percentages where useful,
compare severities / sources / days, and call out anything odd (spikes, flat days, impossible timings, data
quality issues, slow endpoints, error-heavy components, low enrichment, Elastic retention gaps).
Give 5-8 highlights (key facts), the anomalies you see, and 3-6 concrete QA / product recommendations.
"""
        # Structured outputs guarantee schema-valid JSON (free-text JSON kept breaking on
        # quotes from log messages / SQL names; forced tool_choice is a 400 on this model).
        schema = {
            "type": "object",
            "properties": {
                "headline": {"type": "string"},
                "highlights": {"type": "array", "items": {"type": "string"}},
                "anomalies": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}, "detail": {"type": "string"},
                                   "severity": {"type": "string", "enum": ["high", "medium", "low"]}},
                    "required": ["title", "detail", "severity"], "additionalProperties": False}},
                "recommendations": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["headline", "highlights", "anomalies", "recommendations"],
            "additionalProperties": False,
        }
        client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key)
        msg = await client.messages.create(model=AI_MODEL, max_tokens=16000,
                                           output_config={"format": {"type": "json_schema", "schema": schema}},
                                           messages=[{"role": "user", "content": prompt}])
        if msg.stop_reason == "refusal":
            raise RuntimeError("The model declined to analyse this data")
        if msg.stop_reason == "max_tokens":
            raise RuntimeError("Insights were cut off (max_tokens) — try a shorter period")
        text = next((b.text for b in msg.content if getattr(b, "type", "") == "text"), "")
        data = json.loads(text)
        # keep the insights with the stored report so reopening the tab shows them
        last = await self.last_report()
        if last and last.get("generated_at") == report.get("generated_at"):
            last["insights"] = data
            await self._save_last(last)
        return data


_service: Optional[BIService] = None


def get_bi_service() -> BIService:
    global _service
    if _service is None:
        _service = BIService()
    return _service

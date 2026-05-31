"""
Sensor Health Report — All Sites
=================================
Runs Report 1 (last 24h) and Report 2 (last 30 days) against every
data center's Elasticsearch instance and prints a summary per site.

Run:  python sensor_health_report.py
      python sensor_health_report.py --site morelia   (single site)
      python sensor_health_report.py --json
"""

import warnings, json, sys
from datetime import datetime, timezone
from collections import defaultdict

warnings.filterwarnings("ignore", category=DeprecationWarning)

try:
    from elasticsearch import Elasticsearch
except ImportError:
    print("ERROR: pip install \"elasticsearch>=7,<8\"")
    sys.exit(1)

# ── Data centers ──────────────────────────────────────────────────────────────

DATA_CENTERS = {
    "6BAAA0A8-6428-44EA-A4A3-E3C3336A8D68": {"name": "MORELIA",         "ip": "10.21.69.59"},
    "18C0B9E0-C34B-4281-9E15-E46BEA97113A": {"name": "PATZCUARO",       "ip": "10.21.144.58"},
    "91D40213-84E1-4C21-9B85-08608FD27268": {"name": "URUAPAN",         "ip": "10.21.126.58"},
    "B85E5F7F-41EB-427A-8C09-85E42058502E": {"name": "LA_PIEDAD",       "ip": "10.21.138.58"},
    "A6B31CD0-231D-46D4-8851-4C56027F7CEA": {"name": "JIQUILPAN",       "ip": "10.21.129.58"},
    "E20F2C8D-26FE-47C7-B4C6-EDA6EE128C61": {"name": "APATZINGAN",      "ip": "10.21.141.58"},
    "03033164-8422-4309-BB43-D084053114BB": {"name": "ZITACUARO",       "ip": "10.21.132.58"},
    "5996FB17-0435-44D9-802E-05E2A452B073": {"name": "HUETAMO",         "ip": "10.21.150.58"},
    "FF1598C3-6F47-4810-B005-F98D101FF5ED": {"name": "COALCOMAN",       "ip": "10.21.153.58"},
    "659F1446-7B9B-48B3-B984-BFE157C3330C": {"name": "ZAMORA",          "ip": "10.21.123.58"},
    "EFCF17D7-AA2C-4C7F-9809-E459C716BD8E": {"name": "LAZARO_CARDENAS", "ip": "10.21.120.58"},
}

ES_PORT   = 9200
INDEX_ALL = "detections_genericdetection_sensorhealthstatus_*"

STATUS_MAP = {
    "working properly": "WorkingProperly",
    "workingproperly":  "WorkingProperly",
    "ok":               "WorkingProperly",
    "active":           "WorkingProperly",
    "failed":           "Failed",
    "no_communication": "Failed",
    "not_recording":    "Not Recording",
    "warning":          "Warning",
    "offline":          "Offline",
}

def normalise(raw):
    if not raw:
        return "Unknown"
    key = raw.strip().lower().split(",")[0].strip()
    return STATUS_MAP.get(key, raw.strip())

# ── ES helpers ────────────────────────────────────────────────────────────────

def connect_es(ip):
    try:
        es = Elasticsearch(f"http://{ip}:{ES_PORT}",
                           request_timeout=60, max_retries=2, retry_on_timeout=True)
        if es.ping():
            return es
    except Exception:
        pass
    return None


def fetch_latest_per_sensor(es, hours, label):
    """
    Scroll docs sorted Time desc within the hour window.
    Keep the first (=latest) doc per UnitID.
    Early-stop after 5 consecutive pages with no new sensors.
    """
    query = {
        "_source": ["UnitID", "SensorId", "Time",
                    "AdditionalParameters._parameters.SensorType",
                    "AdditionalParameters._parameters.Status",
                    "OriginalSensorStates"],
        "query": {"range": {"Time": {"gte": f"now-{hours}h", "lte": "now"}}},
        "sort":  [{"Time": {"order": "desc"}}]
    }

    seen        = {}
    empty_pages = 0
    pages_read  = 0

    try:
        page  = es.search(index=INDEX_ALL, body=query, size=10000, scroll="3m")
    except Exception as exc:
        print(f"    [!] Query failed: {exc}")
        return []

    sid   = page["_scroll_id"]
    hits  = page["hits"]["hits"]
    total = page["hits"]["total"]["value"] \
            if isinstance(page["hits"]["total"], dict) else page["hits"]["total"]
    print(f"    {label}: {total:,} total docs, scanning ...")

    while hits:
        pages_read += 1
        new_count = 0
        for h in hits:
            src = h["_source"]
            uid = src.get("UnitID") or src.get("SensorId")
            if uid is not None and uid not in seen:
                seen[uid] = src
                new_count += 1

        empty_pages = 0 if new_count else empty_pages + 1
        if empty_pages >= 5:
            break

        try:
            page = es.scroll(scroll_id=sid, scroll="3m")
            sid  = page["_scroll_id"]
            hits = page["hits"]["hits"]
        except Exception:
            break

    try:
        es.clear_scroll(scroll_id=sid)
    except Exception:
        pass

    print(f"    → {len(seen):,} unique sensors ({pages_read} pages)")
    return list(seen.values())

# ── Extract + summarise ───────────────────────────────────────────────────────

def extract(doc):
    params      = doc.get("AdditionalParameters", {}).get("_parameters", {})
    sensor_type = (params.get("SensorType") or "Unknown").strip()
    raw_status  = (params.get("Status") or "").strip()
    if not raw_status:
        states     = doc.get("OriginalSensorStates") or []
        raw_status = states[0] if states else "Unknown"
    return sensor_type, normalise(raw_status)


def build_summary(docs):
    groups = defaultdict(int)
    for doc in docs:
        st, status = extract(doc)
        groups[(st, status)] += 1
    return groups

# ── Render ────────────────────────────────────────────────────────────────────

def render_site_table(site_name, g1, g2):
    w     = 65
    sep   = "=" * w
    thin  = "-" * w
    lines = [
        "",
        sep,
        f"  SITE: {site_name}",
        f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC",
        sep,
        f"  {'Sensor Type':<22} {'Status':<28} {'24h':>6}  {'30d':>6}",
        thin,
    ]

    all_keys = sorted(set(g1.keys()) | set(g2.keys()))
    total_24h = total_30d = 0
    for (st, status) in all_keys:
        c1 = g1.get((st, status), 0)
        c2 = g2.get((st, status), 0)
        total_24h += c1
        total_30d += c2
        lines.append(f"  {st:<22} {status:<28} {c1:>6}  {c2:>6}")

    lines += [thin, f"  {'TOTAL unique sensors':<50} {total_24h:>6}  {total_30d:>6}"]
    return "\n".join(lines)


def render_json_all(results):
    return {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "sites": [
            {
                "site": r["name"],
                "ip":   r["ip"],
                "status": r["status"],
                "report_1_24h":  [{"sensor_type": st, "status": s, "sensors": c}
                                   for (st, s), c in sorted(r.get("g1", {}).items())],
                "report_2_30d":  [{"sensor_type": st, "status": s, "sensors": c}
                                   for (st, s), c in sorted(r.get("g2", {}).items())],
            }
            for r in results
        ]
    }

# ── Zabbix sender ─────────────────────────────────────────────────────────────

ZABBIX_SERVER  = "10.21.144.248"   # from your zabbix_agentd.conf
ZABBIX_HOST    = "MOR-MAINT-SRV"      # Zabbix host that owns these items
ZABBIX_SENDER  = r"C:\Program Files\Zabbix Agent\zabbix_sender.exe"

def send_to_zabbix(results):
    """
    Build a zabbix_sender input file and push all metrics.
    Key format:  sensor.health[SITE,type,status,period]
    Summary key: sensor.health.total[SITE,period]
    Reachability:sensor.health.reachable[SITE]   (1=OK, 0=unreachable)
    """
    import subprocess, tempfile, os

    lines = []
    ts    = int(datetime.now(timezone.utc).timestamp())

    for r in results:
        site   = r["name"]
        status = r["status"]

        # reachability
        lines.append(f'{ZABBIX_HOST} sensor.health.reachable[{site}] {ts} {"1" if status == "OK" else "0"}')

        if status != "OK":
            continue

        for (sensor_type, s), count in r["g1"].items():
            key = f"sensor.health[{site},{sensor_type},{s},24h]"
            lines.append(f"{ZABBIX_HOST} {key} {ts} {count}")

        for (sensor_type, s), count in r["g2"].items():
            key = f"sensor.health[{site},{sensor_type},{s},30d]"
            lines.append(f"{ZABBIX_HOST} {key} {ts} {count}")

        total_24h = sum(r["g1"].values())
        total_30d = sum(r["g2"].values())
        lines.append(f"{ZABBIX_HOST} sensor.health.total[{site},24h] {ts} {total_24h}")
        lines.append(f"{ZABBIX_HOST} sensor.health.total[{site},30d] {ts} {total_30d}")

        # failed counts per site (useful for triggers)
        failed_24h = sum(c for (_, s), c in r["g1"].items() if s == "Failed")
        failed_30d = sum(c for (_, s), c in r["g2"].items() if s == "Failed")
        lines.append(f"{ZABBIX_HOST} sensor.health.failed[{site},24h] {ts} {failed_24h}")
        lines.append(f"{ZABBIX_HOST} sensor.health.failed[{site},30d] {ts} {failed_30d}")

    # heartbeat — lets you alert if script stops running
    lines.append(f"{ZABBIX_HOST} sensor.health.last_run {ts} {ts}")

    # Write temp file and call zabbix_sender
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("\n".join(lines))
        tmp = f.name

    try:
        cmd = [ZABBIX_SENDER, "-z", ZABBIX_SERVER, "-p", "10051", "-i", tmp]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        print(f"[Zabbix] Sent {len(lines)} metrics → {result.stdout.strip()}")
        if result.returncode != 0:
            print(f"[Zabbix] WARN: {result.stderr.strip()}")
    except Exception as exc:
        print(f"[Zabbix] ERROR: {exc}")
    finally:
        os.unlink(tmp)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    as_json     = "--json" in sys.argv
    send_zbx    = "--send" in sys.argv
    site_filter = None
    if "--site" in sys.argv:
        idx = sys.argv.index("--site")
        if idx + 1 < len(sys.argv):
            site_filter = sys.argv[idx + 1].upper()

    # In --send mode all diagnostics go to stderr so stdout stays clean
    import builtins
    _real_print = builtins.print
    if send_zbx:
        builtins.print = lambda *a, **k: _real_print(*a, **{**k, "file": sys.stderr})

    if not send_zbx:
        print(f"\n[*] Sensor Health Report — All Sites")
        print(f"    {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")

    results = []

    for dc in DATA_CENTERS.values():
        name = dc["name"]
        ip   = dc["ip"]

        if site_filter and site_filter not in name.upper():
            continue

        if not send_zbx:
            print(f"\n[>] {name}  ({ip})")
        es = connect_es(ip)

        if es is None:
            if not send_zbx:
                print(f"    [UNREACHABLE]")
            results.append({"name": name, "ip": ip, "status": "UNREACHABLE"})
            continue

        docs_24h = fetch_latest_per_sensor(es, hours=24,  label="24h ")
        g1       = build_summary(docs_24h)
        docs_30d = fetch_latest_per_sensor(es, hours=720, label="30d ")
        g2       = build_summary(docs_30d)

        results.append({"name": name, "ip": ip, "status": "OK", "g1": g1, "g2": g2})

        if not as_json and not send_zbx:
            print(render_site_table(name, g1, g2))

    if send_zbx:
        send_to_zabbix(results)
    elif as_json:
        print(json.dumps(render_json_all(results), indent=2, ensure_ascii=False))
    else:
        print(f"\n{'=' * 65}")
        print("  SITE SUMMARY")
        print(f"{'=' * 65}")
        for r in results:
            total_24h = sum(r.get("g1", {}).values())
            total_30d = sum(r.get("g2", {}).values())
            status    = r["status"]
            if status == "OK":
                print(f"  {r['name']:<20} 24h={total_24h:>5}  30d={total_30d:>5}")
            else:
                print(f"  {r['name']:<20} [{status}]")
        print()

if __name__ == "__main__":
    main()

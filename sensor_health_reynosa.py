"""
Sensor Health Report — Reynosa Sites (Per-Site ES)
====================================================
Each site has its own Elasticsearch instance. Script connects to each,
scrolls latest sensor docs, and summarises by SensorType + Status.

Run:  python sensor_health_reynosa.py
      python sensor_health_reynosa.py --send
      python sensor_health_reynosa.py --site TAMPICO
      python sensor_health_reynosa.py --json
      python sensor_health_reynosa.py --site TAMPICO --cache-write
"""

import warnings, json, sys, subprocess, tempfile, os
from datetime import datetime, timezone
from collections import defaultdict

warnings.filterwarnings("ignore", category=DeprecationWarning)

try:
    from elasticsearch import Elasticsearch
except ImportError:
    print("ERROR: pip install \"elasticsearch>=7,<8\"")
    sys.exit(1)

SITES = {
    "REYNOSA":   "172.15.6.20",
    "VICTORIA":  "172.15.14.19",
    "TAMPICO":   "172.15.18.19",
    "MANTE":     "172.15.22.19",
    "LAREDO":    "172.15.2.19",
    "MATAMOROS": "172.15.10.19",
}

ES_PORT   = 9200
INDEX_ALL = "detections_genericdetection_sensorhealthstatus_*"

ZABBIX_SERVER = "172.15.6.33"
ZABBIX_HOST   = "REY-MAINT-SRV"
ZABBIX_SENDER = r"C:\Program Files\Zabbix Agent\zabbix_sender.exe"

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


def connect_es(ip):
    try:
        es = Elasticsearch(f"http://{ip}:{ES_PORT}",
                           request_timeout=60, max_retries=2, retry_on_timeout=True)
        if es.ping():
            return es
    except Exception:
        pass
    return None


def fetch_latest_per_sensor(es, hours, label, quiet=False):
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
        page = es.search(index=INDEX_ALL, body=query, size=10000, scroll="3m")
    except Exception as exc:
        if not quiet:
            print(f"    [!] Query failed: {exc}")
        return []

    sid   = page["_scroll_id"]
    hits  = page["hits"]["hits"]
    total = page["hits"]["total"]["value"] \
            if isinstance(page["hits"]["total"], dict) else page["hits"]["total"]
    if not quiet:
        print(f"    {label}: {total:,} total docs, scanning ...")

    while hits:
        pages_read += 1
        new_count  = 0
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

    if not quiet:
        print(f"    -> {len(seen):,} unique sensors ({pages_read} pages)")
    return list(seen.values())


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


def render_site_table(name, g1, g2):
    w    = 65
    sep  = "=" * w
    thin = "-" * w
    lines = [
        "",
        sep,
        f"  SITE: {name}",
        f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC",
        sep,
        f"  {'Sensor Type':<22} {'Status':<28} {'24h':>6}  {'30d':>6}",
        thin,
    ]
    all_keys  = sorted(set(g1.keys()) | set(g2.keys()))
    total_24h = total_30d = 0
    for (st, status) in all_keys:
        c1 = g1.get((st, status), 0)
        c2 = g2.get((st, status), 0)
        total_24h += c1
        total_30d += c2
        lines.append(f"  {st:<22} {status:<28} {c1:>6}  {c2:>6}")
    lines += [thin, f"  {'TOTAL unique sensors':<50} {total_24h:>6}  {total_30d:>6}"]
    return "\n".join(lines)


def send_to_zabbix(results):
    lines = []
    ts    = int(datetime.now(timezone.utc).timestamp())

    for r in results:
        site   = r["name"]
        status = r["status"]
        lines.append(f'{ZABBIX_HOST} sensor.health.reachable[{site}] {ts} {"1" if status == "OK" else "0"}')
        if status != "OK":
            continue
        for (st, s), count in r["g1"].items():
            lines.append(f"{ZABBIX_HOST} sensor.health[{site},{st},{s},24h] {ts} {count}")
        for (st, s), count in r["g2"].items():
            lines.append(f"{ZABBIX_HOST} sensor.health[{site},{st},{s},30d] {ts} {count}")
        lines.append(f"{ZABBIX_HOST} sensor.health.total[{site},24h] {ts} {sum(r['g1'].values())}")
        lines.append(f"{ZABBIX_HOST} sensor.health.total[{site},30d] {ts} {sum(r['g2'].values())}")
        failed_24h = sum(c for (_, s), c in r["g1"].items() if s == "Failed")
        failed_30d = sum(c for (_, s), c in r["g2"].items() if s == "Failed")
        lines.append(f"{ZABBIX_HOST} sensor.health.failed[{site},24h] {ts} {failed_24h}")
        lines.append(f"{ZABBIX_HOST} sensor.health.failed[{site},30d] {ts} {failed_30d}")

    lines.append(f"{ZABBIX_HOST} sensor.health.last_run {ts} {ts}")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("\n".join(lines))
        tmp = f.name

    try:
        cmd    = [ZABBIX_SENDER, "-z", ZABBIX_SERVER, "-p", "10051", "-i", tmp]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        print(f"[Zabbix] Sent {len(lines)} metrics -> {result.stdout.strip()}")
        if result.returncode != 0:
            print(f"[Zabbix] WARN: {result.stderr.strip()}")
    except Exception as exc:
        print(f"[Zabbix] ERROR: {exc}")
    finally:
        os.unlink(tmp)


def summarise_by_status(groups):
    totals = defaultdict(int)
    for (_, status), count in groups.items():
        totals[status] += count
    return dict(totals)


def build_site_json(r):
    if r["status"] != "OK":
        return json.dumps({"status": r["status"], "reachable": 0})

    s24 = summarise_by_status(r["g1"])
    s30 = summarise_by_status(r["g2"])

    return json.dumps({
        "status":    "OK",
        "reachable": 1,
        "24h": {
            "total":            sum(s24.values()),
            "working_properly": s24.get("WorkingProperly", 0),
            "failed":           s24.get("Failed", 0),
            "warning":          s24.get("Warning", 0),
            "not_recording":    s24.get("Not Recording", 0),
            "offline":          s24.get("Offline", 0),
            "unknown":          s24.get("Unknown", 0),
        },
        "30d": {
            "total":            sum(s30.values()),
            "working_properly": s30.get("WorkingProperly", 0),
            "failed":           s30.get("Failed", 0),
            "warning":          s30.get("Warning", 0),
            "not_recording":    s30.get("Not Recording", 0),
            "offline":          s30.get("Offline", 0),
            "unknown":          s30.get("Unknown", 0),
        },
    })


def out(s):
    """Write directly to stdout and flush — used for JSON output in silent modes."""
    sys.stdout.write(s + "\n")
    sys.stdout.flush()


def main():
    as_json     = "--json"        in sys.argv
    send_zbx    = "--send"        in sys.argv
    zbx_json    = "--zabbix-json" in sys.argv
    cache_write = "--cache-write" in sys.argv
    site_filter = None
    if "--site" in sys.argv:
        idx = sys.argv.index("--site")
        if idx + 1 < len(sys.argv):
            site_filter = sys.argv[idx + 1].strip('"\'').upper()

    quiet = send_zbx or zbx_json or cache_write

    # Suppress ES library warnings when output must be pure JSON
    if zbx_json or cache_write:
        sys.stderr = open(os.devnull, "w")

    if not quiet:
        print(f"\n[*] Sensor Health Report -- Reynosa Sites")
        print(f"    {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")

    results = []

    for name, ip in SITES.items():
        if site_filter and site_filter != name:
            continue

        if ip == "TODO":
            if not quiet:
                print(f"\n[>] {name}  -- IP not configured, skipping")
            results.append({"name": name, "status": "UNCONFIGURED"})
            continue

        if not quiet:
            print(f"\n[>] {name}  ({ip})")

        es = connect_es(ip)
        if es is None:
            if not quiet:
                print(f"    [UNREACHABLE]")
            results.append({"name": name, "ip": ip, "status": "UNREACHABLE"})
            if zbx_json:
                out(json.dumps({"status": "UNREACHABLE", "reachable": 0}))
            continue

        docs_24h = fetch_latest_per_sensor(es, hours=24,  label="24h ", quiet=quiet)
        g1       = build_summary(docs_24h)
        docs_30d = fetch_latest_per_sensor(es, hours=720, label="30d ", quiet=quiet)
        g2       = build_summary(docs_30d)

        results.append({"name": name, "ip": ip, "status": "OK", "g1": g1, "g2": g2})

        if zbx_json:
            out(build_site_json(results[-1]))
            return

        if cache_write:
            cache_dir  = r"C:\ProgramData\ZabbixCache"
            os.makedirs(cache_dir, exist_ok=True)
            cache_file = os.path.join(cache_dir, f"{name}.json")
            with open(cache_file, "w") as f:
                f.write(build_site_json(results[-1]))
            return

        if not as_json and not send_zbx:
            print(render_site_table(name, g1, g2))

    if zbx_json and not results:
        out(json.dumps({"status": "NO_MATCH", "reachable": 0}))
        return

    if send_zbx:
        send_to_zabbix(results)
    elif as_json:
        print(json.dumps({
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "sites": [
                {
                    "site": r["name"],
                    "status": r["status"],
                    "report_1_24h": [{"sensor_type": st, "status": s, "sensors": c}
                                     for (st, s), c in sorted(r.get("g1", {}).items())],
                    "report_2_30d": [{"sensor_type": st, "status": s, "sensors": c}
                                     for (st, s), c in sorted(r.get("g2", {}).items())],
                }
                for r in results
            ]
        }, indent=2, ensure_ascii=False))
    else:
        print(f"\n{'=' * 65}")
        print("  SITE SUMMARY")
        print(f"{'=' * 65}")
        for r in results:
            if r["status"] == "OK":
                print(f"  {r['name']:<12} 24h={sum(r['g1'].values()):>5}  30d={sum(r['g2'].values()):>5}")
            else:
                print(f"  {r['name']:<12} [{r['status']}]")
        print()


if __name__ == "__main__":
    main()

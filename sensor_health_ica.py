"""
Sensor Health Report — ICA Sites (Single ES, Multi-Tenant)
===========================================================
ES: ICA-ES-SRV01  10.0.12.115:9200
Agent machine: ICA-MAINT-SRV  10.0.12.108

Run:  python sensor_health_ica.py              (print all sites)
      python sensor_health_ica.py --send        (push to Zabbix, diagnostics to stderr)
      python sensor_health_ica.py --json
      python sensor_health_ica.py --discover    (dump first doc — verify TENANT_FIELD)
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

# ── Config ─────────────────────────────────────────────────────────────────────

ES_NODE      = "http://10.0.12.115:9200"
INDEX_ALL    = "detections_genericdetection_sensorhealthstatus_*"
TENANT_FIELD = "DataCenterId"   # confirmed from ES doc inspection

# Fill in UUIDs from the ICA config.json (same format as Reynosa tenants dict)
TENANTS = {
    # "UUID-HERE": "SITE_NAME",
    # "UUID-HERE": "SITE_NAME",
    # TODO: paste from ICA config.json → tenants section
}

ZABBIX_SERVER = "YOUR_ZABBIX_SERVER_IP"   # Zabbix server for the ICA deployment
ZABBIX_HOST   = "ICA-MAINT-SRV"           # host in Zabbix that owns these Trapper items
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

# ── ES helpers ─────────────────────────────────────────────────────────────────

def connect_es():
    try:
        es = Elasticsearch(ES_NODE, request_timeout=60, max_retries=2, retry_on_timeout=True)
        if es.ping():
            return es
    except Exception:
        pass
    return None


def discover(es):
    """Print a sample document to verify TENANT_FIELD and UUID format."""
    try:
        result = es.search(index=INDEX_ALL, body={"size": 1}, timeout="10s")
        hits   = result["hits"]["hits"]
        if hits:
            print(json.dumps(hits[0]["_source"], indent=2, ensure_ascii=False))
        else:
            print("No documents found in the index pattern.")
    except Exception as e:
        print(f"Error: {e}")


def fetch_all_tenants(es, hours, label):
    """
    Single scroll over all docs in the time window.
    Returns {TENANT_UUID_UPPER: {unit_id: doc}} — latest doc per sensor per tenant.
    Early-stop after 5 consecutive pages with no new sensors anywhere.
    """
    query = {
        "_source": [TENANT_FIELD, "UnitID", "SensorId", "Time",
                    "AdditionalParameters._parameters.SensorType",
                    "AdditionalParameters._parameters.Status",
                    "OriginalSensorStates"],
        "query": {"range": {"Time": {"gte": f"now-{hours}h", "lte": "now"}}},
        "sort":  [{"Time": {"order": "desc"}}]
    }

    seen        = defaultdict(dict)
    empty_pages = 0
    pages_read  = 0

    try:
        page = es.search(index=INDEX_ALL, body=query, size=10000, scroll="3m")
    except Exception as exc:
        print(f"  [!] Query failed: {exc}")
        return {}

    sid   = page["_scroll_id"]
    hits  = page["hits"]["hits"]
    total = page["hits"]["total"]["value"] \
            if isinstance(page["hits"]["total"], dict) else page["hits"]["total"]
    print(f"  {label}: {total:,} total docs, scanning ...")

    while hits:
        pages_read += 1
        new_count  = 0
        for h in hits:
            src    = h["_source"]
            tenant = str(src.get(TENANT_FIELD) or "UNKNOWN").upper()
            uid    = src.get("UnitID") or src.get("SensorId")
            if uid is not None and uid not in seen[tenant]:
                seen[tenant][uid] = src
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

    total_unique = sum(len(v) for v in seen.values())
    print(f"  → {total_unique:,} unique sensors across {len(seen)} tenants ({pages_read} pages)")
    return dict(seen)


# ── Summarise ──────────────────────────────────────────────────────────────────

def normalise(raw):
    if not raw:
        return "Unknown"
    key = raw.strip().lower().split(",")[0].strip()
    return STATUS_MAP.get(key, raw.strip())


def extract(doc):
    params      = doc.get("AdditionalParameters", {}).get("_parameters", {})
    sensor_type = (params.get("SensorType") or "Unknown").strip()
    raw_status  = (params.get("Status") or "").strip()
    if not raw_status:
        states     = doc.get("OriginalSensorStates") or []
        raw_status = states[0] if states else "Unknown"
    return sensor_type, normalise(raw_status)


def build_summary(docs_by_uid):
    groups = defaultdict(int)
    for doc in docs_by_uid.values():
        st, status = extract(doc)
        groups[(st, status)] += 1
    return groups


# ── Render ─────────────────────────────────────────────────────────────────────

def render_site_table(site_name, g1, g2):
    w    = 65
    sep  = "=" * w
    thin = "-" * w
    lines = [
        "",
        sep,
        f"  SITE: {site_name}",
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


# ── Zabbix sender ──────────────────────────────────────────────────────────────

def send_to_zabbix(results):
    lines = []
    ts    = int(datetime.now(timezone.utc).timestamp())

    for r in results:
        site = r["name"]
        lines.append(f'{ZABBIX_HOST} sensor.health.reachable[{site}] {ts} 1')

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
        print(f"[Zabbix] Sent {len(lines)} metrics → {result.stdout.strip()}")
        if result.returncode != 0:
            print(f"[Zabbix] WARN: {result.stderr.strip()}")
    except Exception as exc:
        print(f"[Zabbix] ERROR: {exc}")
    finally:
        os.unlink(tmp)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    as_json       = "--json"     in sys.argv
    send_zbx      = "--send"     in sys.argv
    discover_mode = "--discover" in sys.argv

    import builtins
    _real_print = builtins.print
    if send_zbx:
        builtins.print = lambda *a, **k: _real_print(*a, **{**k, "file": sys.stderr})

    es = connect_es()
    if es is None:
        print(f"ERROR: Cannot connect to {ES_NODE}", file=sys.stderr)
        sys.exit(1)

    if discover_mode:
        discover(es)
        return

    if not TENANTS:
        print("ERROR: TENANTS dict is empty — fill in UUIDs from the ICA config.json")
        sys.exit(1)

    if not send_zbx:
        print(f"\n[*] Sensor Health Report — ICA Sites")
        print(f"    {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
        print(f"    ES: {ES_NODE}\n")

    print("  Fetching 24h ...")
    by_tenant_24h = fetch_all_tenants(es, hours=24,  label="24h")
    print("  Fetching 30d ...")
    by_tenant_30d = fetch_all_tenants(es, hours=720, label="30d")

    results = []
    for uuid, name in TENANTS.items():
        key      = uuid.upper()
        docs_24h = by_tenant_24h.get(key, {})
        docs_30d = by_tenant_30d.get(key, {})
        g1 = build_summary(docs_24h)
        g2 = build_summary(docs_30d)
        results.append({"name": name, "status": "OK", "g1": g1, "g2": g2})
        if not as_json and not send_zbx:
            print(render_site_table(name, g1, g2))

    if send_zbx:
        send_to_zabbix(results)
    elif as_json:
        print(json.dumps({
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "sites": [
                {
                    "site": r["name"],
                    "report_1_24h": [{"sensor_type": st, "status": s, "sensors": c}
                                     for (st, s), c in sorted(r["g1"].items())],
                    "report_2_30d": [{"sensor_type": st, "status": s, "sensors": c}
                                     for (st, s), c in sorted(r["g2"].items())],
                }
                for r in results
            ]
        }, indent=2, ensure_ascii=False))
    else:
        print(f"\n{'=' * 65}")
        print("  SITE SUMMARY")
        print(f"{'=' * 65}")
        for r in results:
            print(f"  {r['name']:<12} 24h={sum(r['g1'].values()):>5}  30d={sum(r['g2'].values()):>5}")
        print()


if __name__ == "__main__":
    main()

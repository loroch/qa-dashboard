"""
Fast cache reader for Zabbix UserParameter.
Returns cached JSON instantly (< 1s), then launches background update.
No Timeout=30 needed — always completes within the default 3s timeout.

UserParameter calls:  python sensor_health_read.py REYNOSA
"""
import sys, os, subprocess

CACHE_DIR = r"C:\ProgramData\ZabbixCache"
SCRIPT    = r"C:\Program Files\Zabbix Agent\scripts\sensor_health_reynosa.py"
PYTHON    = r"C:\Program Files\Python312\python.exe"

site = sys.argv[1].upper() if len(sys.argv) > 1 else "UNKNOWN"

# Launch background update — does not block
subprocess.Popen(
    [PYTHON, SCRIPT, "--site", site, "--cache-write"],
    creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS | CREATE_NO_WINDOW
    close_fds=True
)

# Return last cached result (or PENDING on first run)
cache_file = os.path.join(CACHE_DIR, f"{site}.json")
if os.path.exists(cache_file):
    with open(cache_file) as f:
        print(f.read().strip())
else:
    print('{"status":"PENDING","reachable":0}')

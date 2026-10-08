"""
Sensor Health Validator — web UI
================================
Small web app around sensor_health_validator.py: open the page, press
"Run comparison", and see BI vs Elasticsearch vs Units log per sensor type.
Every run is saved so earlier results can be reopened.

Run:
    python sensor_health_web.py              # http://localhost:8090
    python sensor_health_web.py --port 8095

Runs on Windows (reads the Units log over the \\\\host\\c$ admin share).
Requires: fastapi, uvicorn, requests
"""

import argparse
import json
import os
import re
import threading
from datetime import datetime

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import sensor_health_validator as shv

HERE     = os.path.dirname(os.path.abspath(__file__))
UI_FILE  = os.path.join(HERE, "sensor_health_web", "index.html")
RUNS_DIR = os.path.join(os.path.expanduser("~"), "Documents", "SensorHealthReports", "runs")
os.makedirs(RUNS_DIR, exist_ok=True)

app = FastAPI(title="Sensor Health Validator")
_run_lock = threading.Lock()


class RunRequest(BaseModel):
    bi: str = shv.DEFAULT_BI
    es: str = shv.DEFAULT_ES
    log: str = shv.DEFAULT_LOG
    utcOffset: float = 3.0


class ConnectRequest(BaseModel):
    log: str = shv.DEFAULT_LOG
    user: str
    password: str


@app.get("/")
def index():
    return FileResponse(UI_FILE)


@app.get("/api/config")
def config():
    return {"bi": shv.DEFAULT_BI, "es": shv.DEFAULT_ES, "log": shv.DEFAULT_LOG, "utcOffset": 3.0,
            "logReachable": os.path.exists(shv.DEFAULT_LOG)}


@app.post("/api/run")
def run(req: RunRequest):
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(409, "A comparison is already running")
    try:
        try:
            result = shv.to_json(*shv.run_validation(req.bi, req.es, req.log, req.utcOffset))
        except shv.LogUnavailable:
            raise HTTPException(424, {"code": "log_unavailable",
                                      "message": f"Cannot open the Units log at {req.log}"})
        except Exception as ex:  # BI / ES unreachable, bad response …
            raise HTTPException(502, {"code": "source_error", "message": f"{type(ex).__name__}: {ex}"})
        run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        result["id"] = run_id
        with open(os.path.join(RUNS_DIR, f"{run_id}.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, default=str)
        return result
    finally:
        _run_lock.release()


@app.post("/api/connect")
def connect(req: ConnectRequest):
    ok, msg = shv.connect_share(req.log, req.user, req.password)
    if not ok:
        raise HTTPException(401, {"code": "connect_failed", "message": msg or "Could not open the share"})
    return {"ok": True, "message": msg}


@app.get("/api/runs")
def runs(limit: int = 50):
    out = []
    for name in sorted(os.listdir(RUNS_DIR), reverse=True)[:limit]:
        try:
            with open(os.path.join(RUNS_DIR, name), encoding="utf-8") as f:
                d = json.load(f)
            out.append({"id": d["id"], "generated": d["meta"]["generated"], **d["summary"]})
        except (OSError, ValueError, KeyError):
            continue
    return out


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    if not re.fullmatch(r"\d{8}_\d{6}", run_id):
        raise HTTPException(400, "bad run id")
    path = os.path.join(RUNS_DIR, f"{run_id}.json")
    if not os.path.exists(path):
        raise HTTPException(404, "run not found")
    return FileResponse(path, media_type="application/json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8090)
    a = ap.parse_args()
    print(f"Sensor Health Validator UI → http://localhost:{a.port}")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")

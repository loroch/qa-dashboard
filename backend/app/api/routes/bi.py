"""
BI API routes — event analytics on the Validation Portal environment.

GET  /api/bi/databases            databases on the profile's SQL Server
GET  /api/bi/last                 last generated report (instant reopen)
POST /api/bi/report               { range: 7d|30d|custom, from?, to?, sources{db,elastic}, database?,
                                    audit_database?, detections_index?, profile? }
POST /api/bi/insights             { report } → AI headline / highlights / anomalies / recommendations
"""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.bi_service import get_bi_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bi", tags=["bi"])


class ReportRequest(BaseModel):
    range: str = "7d"
    date_from: str | None = None
    date_to: str | None = None
    sources: dict = {"db": True, "elastic": True}
    database: str | None = None
    audit_database: str | None = None
    detections_index: str | None = None
    profile: dict | None = None


class InsightsRequest(BaseModel):
    report: dict


def _window(req: ReportRequest) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    if req.range == "custom":
        if not req.date_from or not req.date_to:
            raise HTTPException(status_code=400, detail="Custom range needs from and to dates")
        f = datetime.fromisoformat(req.date_from).replace(tzinfo=timezone.utc)
        t = datetime.fromisoformat(req.date_to).replace(tzinfo=timezone.utc)
        if len(req.date_to) <= 10:  # a plain date means "through the end of that day"
            t += timedelta(days=1)
        if t <= f:
            raise HTTPException(status_code=400, detail="'to' must be after 'from'")
        return f, t
    days = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}.get(req.range)
    if not days:
        raise HTTPException(status_code=400, detail=f"Unknown range {req.range}")
    return now - timedelta(days=days), now


@router.get("/databases")
async def databases():
    try:
        return {"databases": await get_bi_service().databases()}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not list databases: {exc}")


@router.get("/last")
async def last_report():
    return {"report": await get_bi_service().last_report()}


@router.post("/report")
async def report(req: ReportRequest):
    f, t = _window(req)
    try:
        return await get_bi_service().report(f, t, req.sources, req.database, req.audit_database,
                                             req.detections_index, req.profile)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("BI report failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Report failed: {exc}")


@router.post("/insights")
async def insights(req: InsightsRequest):
    try:
        return await get_bi_service().insights(req.report)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("BI insights failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Insights failed: {exc}")

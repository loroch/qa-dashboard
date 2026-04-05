"""
Export API routes - CSV and Excel downloads.
"""
import logging
from typing import Optional
from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import Response

from app.services.dashboard_service import get_dashboard_service
from app.services.changelog_service import get_changelog_service
from app.services.export_service import (
    issues_to_csv, issues_to_excel, changelog_to_excel
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/ready-for-testing/csv")
async def export_rft_csv(
    projects: Optional[str] = Query(None),
    assignee_ids: Optional[str] = Query(None),
):
    """Export Ready for Testing items as CSV."""
    try:
        filters = {}
        if projects:
            filters["projects"] = projects.split(",")
        if assignee_ids:
            filters["assignee_ids"] = assignee_ids.split(",")

        svc = get_dashboard_service()
        issues = await svc.get_ready_for_testing(filters=filters or None)
        csv_bytes = issues_to_csv(issues)
        return Response(
            content=csv_bytes,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=ready_for_testing.csv"},
        )
    except Exception as e:
        logger.error(f"Export RFT CSV error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ready-for-testing/excel")
async def export_rft_excel(
    projects: Optional[str] = Query(None),
    assignee_ids: Optional[str] = Query(None),
):
    """Export Ready for Testing items as Excel (.xlsx)."""
    try:
        filters = {}
        if projects:
            filters["projects"] = projects.split(",")
        if assignee_ids:
            filters["assignee_ids"] = assignee_ids.split(",")

        svc = get_dashboard_service()
        issues = await svc.get_ready_for_testing(filters=filters or None)
        xlsx_bytes = issues_to_excel(issues, sheet_name="Ready for Testing")
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=ready_for_testing.xlsx"},
        )
    except Exception as e:
        logger.error(f"Export RFT Excel error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs/csv")
async def export_bugs_csv():
    """Export 30-day bugs as CSV."""
    try:
        svc = get_dashboard_service()
        issues = await svc.get_bugs()
        csv_bytes = issues_to_csv(issues)
        return Response(
            content=csv_bytes,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=bugs_30d.csv"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs/excel")
async def export_bugs_excel():
    """Export 30-day bugs as Excel."""
    try:
        svc = get_dashboard_service()
        issues = await svc.get_bugs()
        xlsx_bytes = issues_to_excel(issues, sheet_name="Bugs 30d")
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=bugs_30d.xlsx"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/changelog/csv")
async def export_changelog_csv():
    """Export full changelog as CSV."""
    try:
        svc = get_changelog_service()
        entries = await svc.get_all_for_export()
        import csv, io
        if not entries:
            return Response(content=b"", media_type="text/csv")
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=list(entries[0].keys()))
        writer.writeheader()
        writer.writerows(entries)
        return Response(
            content=output.getvalue().encode("utf-8-sig"),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=changelog.csv"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/changelog/excel")
async def export_changelog_excel():
    """Export full changelog as Excel."""
    try:
        svc = get_changelog_service()
        entries = await svc.get_all_for_export()
        xlsx_bytes = changelog_to_excel(entries)
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=changelog.xlsx"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

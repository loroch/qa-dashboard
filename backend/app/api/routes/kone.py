"""
K-1 KONE service desk API routes.
"""
import logging
from fastapi import APIRouter, Query

from app.services.kone_service import get_kone_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/kone", tags=["kone"])


@router.get("/tickets")
async def get_tickets(refresh: bool = Query(False)):
    """All open K-1 tickets."""
    svc = get_kone_service()
    tickets = await svc.get_tickets(force_refresh=refresh)
    return {"tickets": tickets, "total": len(tickets)}


@router.get("/by-cliente")
async def get_by_cliente(refresh: bool = Query(False)):
    """Tickets grouped by Cliente."""
    svc = get_kone_service()
    groups = await svc.get_by_cliente(force_refresh=refresh)
    return {"groups": groups}

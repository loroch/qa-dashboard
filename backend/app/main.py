"""
QA Manager Dashboard - FastAPI Application Entry Point
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.config import get_settings
from app.database.db import init_db
from app.services.changelog_service import get_changelog_service
from app.services.dashboard_service import get_dashboard_service
from app.api.routes import dashboard, changelog, export, jira_meta, zoho, coverage, test_generator, anomaly, test_plans

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    settings = get_settings()
    logger.info(f"Starting QA Dashboard (env={settings.environment})")

    # Initialize database
    await init_db()

    # Seed initial changelog
    changelog_svc = get_changelog_service()
    await changelog_svc.seed_initial_entries()

    # Background refresh scheduler
    refresh_hours = settings.background_refresh_hours
    scheduler.add_job(
        _background_refresh,
        trigger=IntervalTrigger(hours=refresh_hours),
        id="full_refresh",
        replace_existing=True,
        max_instances=1,
    )
    scheduler.start()
    logger.info(f"Scheduler started: full refresh every {refresh_hours}h")

    yield

    # Cleanup
    scheduler.shutdown(wait=False)
    from app.jira.client import get_jira_client
    await get_jira_client().close()
    from app.zoho.client import get_zoho_client
    await get_zoho_client().close()
    logger.info("QA Dashboard shut down")


async def _background_refresh():
    """Called by APScheduler every N hours."""
    svc = get_dashboard_service()
    await svc.refresh_all()


# -----------------------------------------------------------------------
# App factory
# -----------------------------------------------------------------------

settings = get_settings()

app = FastAPI(
    title="QA Manager Dashboard",
    description="Production-ready QA management dashboard powered by Jira",
    version="1.0.0",
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gzip compression
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Routes
app.include_router(dashboard.router)
app.include_router(changelog.router)
app.include_router(export.router)
app.include_router(jira_meta.router)
app.include_router(zoho.router)
app.include_router(coverage.router)
app.include_router(test_generator.router)
app.include_router(anomaly.router)
app.include_router(test_plans.router)


@app.get("/health")
async def health():
    """Health check endpoint for container orchestration."""
    return {"status": "ok", "service": "qa-dashboard-api"}


@app.get("/")
async def root():
    return {"message": "QA Dashboard API", "docs": "/docs"}

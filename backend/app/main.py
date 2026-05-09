"""
Thermal Routing API — FastAPI Application Entry Point.

A shade-optimized walking router for Davis, CA that uses real-time
sun position, building/tree shadow projections, and heat index
to find the coolest path between two points.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan handler.
    - On startup: pre-load the Skyfield ephemeris and optionally the walking graph.
    - On shutdown: clean up resources.
    """
    logger.info("🌡️  Thermal Routing API starting up …")
    logger.info("   Davis, CA: %.4f°N, %.4f°W", settings.davis_lat, abs(settings.davis_lon))
    logger.info("   Default heat index: %.0f°F", settings.default_heat_index)

    # Pre-load the Skyfield ephemeris (downloads ~17MB on first run)
    from app.services.sun_position import get_sun_position

    sun = get_sun_position()
    logger.info(
        "   Current sun: azimuth=%.1f° altitude=%.1f° daytime=%s",
        sun.azimuth,
        sun.altitude,
        sun.is_daytime,
    )

    # Optionally pre-load the walking graph (takes ~15-30s)
    # Uncomment below to warm the cache on startup:
    # from app.services.routing import get_walking_graph
    # get_walking_graph()

    yield

    logger.info("🌡️  Thermal Routing API shutting down.")


app = FastAPI(
    title="Thermal Routing API",
    description=(
        "Shade-optimized walking routes for Davis, CA. "
        "Uses real-time sun position, building & tree shadow projections, "
        "and heat index to find the coolest path."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Include routers ──────────────────────────────────────────────────────────
from app.routers.route import router as route_router
from app.routers.analytics import router as analytics_router

app.include_router(route_router)
app.include_router(analytics_router)


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/", tags=["health"])
async def root():
    """Health check endpoint."""
    from app.services.sun_position import get_sun_position

    sun = get_sun_position()
    return {
        "service": "Thermal Routing API",
        "status": "healthy",
        "location": "Davis, CA",
        "sun": {
            "azimuth": round(sun.azimuth, 1),
            "altitude": round(sun.altitude, 1),
            "is_daytime": sun.is_daytime,
        },
    }


@app.get("/sun", tags=["debug"])
async def sun_position():
    """Debug endpoint — current sun position for Davis, CA."""
    from app.services.sun_position import get_sun_position

    sun = get_sun_position()
    return {
        "azimuth": round(sun.azimuth, 2),
        "altitude": round(sun.altitude, 2),
        "is_daytime": sun.is_daytime,
        "utc_time": sun.utc_time.isoformat(),
    }

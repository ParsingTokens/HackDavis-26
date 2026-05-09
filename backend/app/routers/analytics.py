"""
GET /analytics — Compute a 'Heat Equity' score for a neighborhood.

Query Parameters:
    neighborhood : str   — Name of the neighborhood (e.g. "Downtown Davis")
    north, south, east, west : float — Optional bounding box override
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.config import settings
from app.services.sun_position import get_sun_position
from app.services.shadow_engine import compute_shadow_polygons
from app.services.analytics import compute_heat_equity

logger = logging.getLogger(__name__)

router = APIRouter(tags=["analytics"])


@router.get("/analytics")
async def get_analytics(
    neighborhood: str = Query(
        "Downtown Davis", description="Neighborhood name within Davis, CA"
    ),
    north: float | None = Query(None, description="Bounding box north latitude"),
    south: float | None = Query(None, description="Bounding box south latitude"),
    east: float | None = Query(None, description="Bounding box east longitude"),
    west: float | None = Query(None, description="Bounding box west longitude"),
) -> dict[str, Any]:
    """
    Compute a **Heat Equity** score for a Davis neighborhood.

    The score represents the percentage of street area currently
    covered by shadow from buildings and trees. Higher scores
    indicate more equitable shade coverage.

    Returns the score, classification (Poor/Fair/Good/Excellent),
    and per-street breakdown.
    """
    try:
        # 1. Get sun position
        sun = get_sun_position()

        # 2. Load features & compute shadows
        # Re-use the same loading mechanism as the route endpoint
        from app.routers.route import _load_geo_features

        buildings, trees = _load_geo_features()
        shadow_result = compute_shadow_polygons(buildings, trees, sun)

        # 3. Determine bounding box
        bbox = None
        if all(v is not None for v in [north, south, east, west]):
            bbox = (north, south, east, west)

        # 4. Compute Heat Equity
        result = compute_heat_equity(
            neighborhood=neighborhood,
            shadow_result=shadow_result,
            bbox=bbox,
        )

        return {
            "status": "ok",
            "neighborhood": result.neighborhood,
            "heat_equity": {
                "score": result.score,
                "classification": result.classification,
                "total_street_length_m": result.total_street_length_m,
                "shaded_street_length_m": result.shaded_street_length_m,
                "num_streets_analyzed": result.num_streets,
            },
            "sun": {
                "azimuth": round(sun.azimuth, 1),
                "altitude": round(sun.altitude, 1),
                "is_daytime": sun.is_daytime,
                "utc_time": sun.utc_time.isoformat(),
            },
            "street_details": result.street_details[:50],  # Limit response size
        }

    except Exception as e:
        logger.exception("Analytics computation failed")
        raise HTTPException(
            status_code=500,
            detail=f"Analytics computation error: {str(e)}",
        )

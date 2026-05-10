"""
GET /route — Compute the shade-optimized 'Coolest Path' between two points.

Query Parameters:
    start_lat, start_lon : float  — Starting point coordinates
    end_lat, end_lon     : float  — Ending point coordinates
    user_sensitivity     : float  — Shade preference 0.0–1.0 (default 0.8)
    heat_index           : float  — Current heat index in °F (optional)
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.config import settings
from app.services.sun_position import get_sun_position
from app.services.shadow_engine import compute_shadow_polygons
from app.services.routing import compute_coolest_route

logger = logging.getLogger(__name__)

router = APIRouter(tags=["routing"])


def _load_geo_features() -> tuple[list[dict], list[dict]]:
    """
    Load building and tree features for shadow computation.

    For the hackathon MVP, this loads data from the PostGIS database.
    Falls back to an in-memory cache if the DB is unavailable.
    """
    # We'll use a lazy in-memory cache populated on first call.
    # In production, query PostGIS; for now, use OSMnx directly.
    if not hasattr(_load_geo_features, "_buildings"):
        try:
            import osmnx as ox
            import geopandas as gpd
            from shapely.geometry import MultiPolygon

            logger.info("Loading building/tree features from OSM (first request, will be cached)…")

            # Buildings
            bldg_gdf = ox.features_from_place(
                settings.place_name, tags={"building": True}
            )
            bldg_gdf = bldg_gdf[bldg_gdf.geometry.type.isin(["Polygon", "MultiPolygon"])]

            buildings = []
            for _, row in bldg_gdf.iterrows():
                geom = row.geometry
                if isinstance(geom, MultiPolygon):
                    for poly in geom.geoms:
                        buildings.append({"geometry": poly, "height": 8.0})
                else:
                    # Estimate height
                    h = 8.0
                    raw = row.get("height")
                    if raw:
                        try:
                            h = float(str(raw).replace("m", "").strip())
                        except (ValueError, TypeError):
                            pass
                    levels = row.get("building:levels")
                    if levels and h == 8.0:
                        try:
                            h = float(str(levels).strip()) * 3.0
                        except (ValueError, TypeError):
                            pass
                    buildings.append({"geometry": geom, "height": h})

            _load_geo_features._buildings = buildings
            logger.info("Cached %d building features.", len(buildings))

            # Trees
            try:
                tree_gdf = ox.features_from_place(
                    settings.place_name, tags={"natural": ["tree", "tree_row"]}
                )
                tree_gdf = tree_gdf[tree_gdf.geometry.type == "Point"]
                trees = [
                    {"geometry": row.geometry, "height": 8.0, "canopy_radius": 4.0}
                    for _, row in tree_gdf.iterrows()
                ]
            except Exception:
                trees = []

            _load_geo_features._trees = trees
            logger.info("Cached %d tree features.", len(trees))

        except Exception as e:
            logger.error("Failed to load geo features: %s", e)
            _load_geo_features._buildings = []
            _load_geo_features._trees = []

    return _load_geo_features._buildings, _load_geo_features._trees


@router.get("/route")
async def get_route(
    start_lat: float = Query(..., description="Start latitude", ge=-90, le=90),
    start_lon: float = Query(..., description="Start longitude", ge=-180, le=180),
    end_lat: float = Query(..., description="End latitude", ge=-90, le=90),
    end_lon: float = Query(..., description="End longitude", ge=-180, le=180),
    user_sensitivity: float = Query(
        0.8, description="Shade preference (0.0 = shortest, 1.0 = max shade)", ge=0.0, le=1.0
    ),
    heat_index: float | None = Query(
        None, description="Current heat index in °F (defaults to configured value)"
    ),
) -> dict[str, Any]:
    """
    Compute the **Coolest Path** — a shade-optimized walking route.

    Returns a GeoJSON FeatureCollection of the route with metadata
    including total distance, shade percentage, and estimated sun
    exposure time.
    """
    hi = heat_index if heat_index is not None else settings.default_heat_index

    try:
        # 1. Get sun position
        sun = get_sun_position()

        if not sun.is_daytime:
            # Night time — just return shortest path with note
            logger.info("Sun below horizon; returning shortest path.")

        # 2. Load features & compute shadows
        buildings, trees = _load_geo_features()
        shadow_result = compute_shadow_polygons(buildings, trees, sun)

        # 3. Compute route
        result = compute_coolest_route(
            start=(start_lat, start_lon),
            end=(end_lat, end_lon),
            user_sensitivity=user_sensitivity,
            heat_index=hi,
            shadow_result=shadow_result,
        )

        return {
            "status": "ok",
            "route": result.geojson,
            "metadata": {
                "total_distance_m": result.total_distance_m,
                "shade_percentage": result.shade_percentage,
                "exposure_minutes": result.exposure_minutes,
                "sun_azimuth": result.sun.azimuth,
                "sun_altitude": result.sun.altitude,
                "is_daytime": result.sun.is_daytime,
                "heat_index": hi,
                "user_sensitivity": user_sensitivity,
                "computation_time_s": result.computation_time_s,
            },
        }

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Route computation failed")
        raise HTTPException(status_code=500, detail=f"Route computation error: {str(e)}")

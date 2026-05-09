"""
Ingest OpenStreetMap building footprints and tree locations for Davis, CA
into the PostGIS database.

Usage:
    cd backend
    python -m app.scripts.ingest_osm
"""

from __future__ import annotations

import asyncio
import logging
import sys

import geopandas as gpd
import osmnx as ox
from shapely.geometry import MultiPolygon, Polygon, Point
from sqlalchemy import text

from app.config import settings
from app.database import engine, init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── Height estimation helpers ─────────────────────────────────────────────────

_DEFAULT_HEIGHTS: dict[str, float] = {
    "commercial": 12.0,
    "retail": 10.0,
    "industrial": 12.0,
    "office": 15.0,
    "apartments": 12.0,
    "residential": 6.0,
    "house": 6.0,
    "detached": 6.0,
    "yes": 8.0,
}

METERS_PER_LEVEL = 3.0


def _estimate_building_height(row) -> float:
    """Estimate building height from OSM tags, falling back to defaults."""
    # Direct height tag
    raw_height = row.get("height")
    if raw_height is not None:
        try:
            return float(str(raw_height).replace("m", "").strip())
        except (ValueError, TypeError):
            pass

    # building:levels tag
    levels = row.get("building:levels")
    if levels is not None:
        try:
            return float(str(levels).strip()) * METERS_PER_LEVEL
        except (ValueError, TypeError):
            pass

    # Fallback by building type
    btype = row.get("building", "yes")
    if isinstance(btype, str):
        return _DEFAULT_HEIGHTS.get(btype.lower(), 8.0)
    return 8.0


# ── Ingestion functions ──────────────────────────────────────────────────────

def _download_buildings() -> gpd.GeoDataFrame:
    """Download building footprints for Davis, CA from OpenStreetMap."""
    logger.info("Downloading building footprints for %s …", settings.place_name)
    gdf = ox.features_from_place(settings.place_name, tags={"building": True})

    # Keep only polygon geometries
    gdf = gdf[gdf.geometry.type.isin(["Polygon", "MultiPolygon"])].copy()

    # Flatten MultiPolygons
    rows = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        if isinstance(geom, MultiPolygon):
            for poly in geom.geoms:
                rows.append({**row.to_dict(), "geometry": poly})
        else:
            rows.append(row.to_dict())
    gdf = gpd.GeoDataFrame(rows, crs="EPSG:4326")

    # Estimate heights
    gdf["est_height"] = gdf.apply(_estimate_building_height, axis=1)

    logger.info("Downloaded %d building polygons.", len(gdf))
    return gdf


def _download_trees() -> gpd.GeoDataFrame:
    """Download tree locations for Davis, CA from OpenStreetMap."""
    logger.info("Downloading tree data for %s …", settings.place_name)
    try:
        gdf = ox.features_from_place(
            settings.place_name,
            tags={"natural": ["tree", "tree_row"]},
        )
    except ox._errors.InsufficientResponseError:
        logger.warning("No tree data found in OSM. Creating empty GeoDataFrame.")
        return gpd.GeoDataFrame(columns=["geometry", "species", "height"], crs="EPSG:4326")

    # Keep only points (individual trees)
    gdf_points = gdf[gdf.geometry.type == "Point"].copy()

    logger.info("Downloaded %d tree points.", len(gdf_points))
    return gdf_points


async def _insert_buildings(gdf: gpd.GeoDataFrame) -> int:
    """Bulk-insert building footprints into PostGIS."""
    if gdf.empty:
        return 0

    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE TABLE buildings RESTART IDENTITY CASCADE"))

        count = 0
        for _, row in gdf.iterrows():
            geom: Polygon = row.geometry
            osm_id = int(row.name[1]) if isinstance(row.name, tuple) else None
            name = row.get("name")
            building_type = row.get("building", "yes")
            height = row.get("est_height", 8.0)

            await conn.execute(
                text(
                    """
                    INSERT INTO buildings (osm_id, name, building_type, height, geometry)
                    VALUES (:osm_id, :name, :btype, :height, ST_GeomFromText(:wkt, 4326))
                    """
                ),
                {
                    "osm_id": osm_id,
                    "name": str(name) if name else None,
                    "btype": str(building_type) if building_type else "yes",
                    "height": float(height),
                    "wkt": geom.wkt,
                },
            )
            count += 1

        logger.info("Inserted %d buildings.", count)
        return count


async def _insert_trees(gdf: gpd.GeoDataFrame) -> int:
    """Bulk-insert tree locations into PostGIS."""
    if gdf.empty:
        return 0

    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE TABLE trees RESTART IDENTITY CASCADE"))

        count = 0
        for _, row in gdf.iterrows():
            geom: Point = row.geometry
            osm_id = int(row.name[1]) if isinstance(row.name, tuple) else None
            species = row.get("species") or row.get("leaf_type")

            # Parse height from tags
            raw_height = row.get("height")
            try:
                height = float(str(raw_height).replace("m", "").strip()) if raw_height else 8.0
            except (ValueError, TypeError):
                height = 8.0

            # Parse canopy spread
            raw_crown = row.get("diameter_crown") or row.get("crown_diameter")
            try:
                canopy_radius = float(str(raw_crown).replace("m", "").strip()) / 2.0 if raw_crown else 4.0
            except (ValueError, TypeError):
                canopy_radius = 4.0

            await conn.execute(
                text(
                    """
                    INSERT INTO trees (osm_id, species, height, canopy_radius, geometry)
                    VALUES (:osm_id, :species, :height, :canopy_radius, ST_GeomFromText(:wkt, 4326))
                    """
                ),
                {
                    "osm_id": osm_id,
                    "species": str(species) if species else None,
                    "height": height,
                    "canopy_radius": canopy_radius,
                    "wkt": geom.wkt,
                },
            )
            count += 1

        logger.info("Inserted %d trees.", count)
        return count


async def main() -> None:
    """Run the full ingestion pipeline."""
    logger.info("=== OSM Data Ingestion for Thermal Routing ===")

    # 1. Init database & tables
    await init_db()
    logger.info("Database initialized.")

    # 2. Download data
    buildings_gdf = _download_buildings()
    trees_gdf = _download_trees()

    # 3. Insert into PostGIS
    b_count = await _insert_buildings(buildings_gdf)
    t_count = await _insert_trees(trees_gdf)

    logger.info("=== Ingestion complete: %d buildings, %d trees ===", b_count, t_count)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

"""
Shadow Engine — 2D ray-casting to compute shadow polygons
projected by buildings and trees onto the street plane.

Given the sun's azimuth and altitude, each vertical structure
(building or tree) casts a shadow in the opposite direction of the sun.
The shadow length is proportional to the structure's height divided by
the tangent of the solar altitude.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.ops import unary_union
from shapely import affinity

from app.services.sun_position import SunPosition

logger = logging.getLogger(__name__)

# At high latitudes / low sun angles the shadow length can become
# extremely long. We cap it to keep geometry reasonable.
MAX_SHADOW_LENGTH_M = 200.0

# Approximate meters-per-degree at Davis latitude (38.5°N)
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(38.5449))


@dataclass(frozen=True)
class ShadowResult:
    """Result of shadow computation."""

    shadow_union: Polygon | MultiPolygon | None
    num_building_shadows: int
    num_tree_shadows: int
    sun: SunPosition


def _shadow_vector_degrees(azimuth: float, altitude: float, height: float) -> tuple[float, float]:
    """
    Compute the 2D shadow displacement vector in degrees (lon, lat).

    The shadow falls *opposite* the sun direction. Its length is
    ``height / tan(altitude)``.

    Returns (dx_lon, dy_lat) in decimal degrees.
    """
    if altitude <= 0:
        # Sun below horizon — no meaningful shadow direction
        return (0.0, 0.0)

    shadow_length_m = height / math.tan(math.radians(altitude))
    shadow_length_m = min(shadow_length_m, MAX_SHADOW_LENGTH_M)

    # Shadow azimuth = sun azimuth + 180° (opposite direction)
    shadow_az_rad = math.radians((azimuth + 180.0) % 360.0)

    # Azimuth is clockwise from North:
    #   North → dy positive, East → dx positive
    dx_m = shadow_length_m * math.sin(shadow_az_rad)
    dy_m = shadow_length_m * math.cos(shadow_az_rad)

    # Convert meters → degrees
    dx_deg = dx_m / M_PER_DEG_LON
    dy_deg = dy_m / M_PER_DEG_LAT

    return (dx_deg, dy_deg)


def _project_building_shadow(
    footprint: Polygon,
    sun: SunPosition,
    height: float,
) -> Polygon | None:
    """
    Project a building's footprint into a 2D shadow polygon.

    Strategy: translate every vertex of the footprint by the shadow vector,
    then take the convex hull of the original + translated vertices.
    """
    if not sun.is_daytime or sun.altitude < 1.0:
        return None

    dx, dy = _shadow_vector_degrees(sun.azimuth, sun.altitude, height)
    if dx == 0.0 and dy == 0.0:
        return None

    # Translate the footprint
    shadow_footprint = affinity.translate(footprint, xoff=dx, yoff=dy)

    # Combine original + shadow → convex hull
    combined = unary_union([footprint, shadow_footprint])
    shadow_poly = combined.convex_hull

    if shadow_poly.is_empty or not shadow_poly.is_valid:
        return None

    return shadow_poly


def _project_tree_shadow(
    center: Point,
    sun: SunPosition,
    height: float,
    canopy_radius: float,
) -> Polygon | None:
    """
    Project a tree's canopy into a 2D shadow ellipse (approximated as circle).

    The shadow center is displaced from the tree trunk by the shadow vector,
    and the shadow radius equals the canopy radius.
    """
    if not sun.is_daytime or sun.altitude < 1.0:
        return None

    dx, dy = _shadow_vector_degrees(sun.azimuth, sun.altitude, height)
    if dx == 0.0 and dy == 0.0:
        return None

    # Shadow center is displaced from the tree
    shadow_cx = center.x + dx
    shadow_cy = center.y + dy

    # Canopy radius in degrees
    r_deg = canopy_radius / M_PER_DEG_LAT  # approximate

    shadow_circle = Point(shadow_cx, shadow_cy).buffer(r_deg, resolution=16)

    if shadow_circle.is_empty:
        return None

    return shadow_circle


def compute_shadow_polygons(
    buildings: list[dict],
    trees: list[dict],
    sun: SunPosition,
) -> ShadowResult:
    """
    Compute the union of all shadow polygons from buildings and trees.

    Parameters
    ----------
    buildings : list[dict]
        Each dict must have keys: ``geometry`` (shapely Polygon), ``height`` (float).
    trees : list[dict]
        Each dict must have keys: ``geometry`` (shapely Point),
        ``height`` (float), ``canopy_radius`` (float).
    sun : SunPosition
        Current sun position.

    Returns
    -------
    ShadowResult
        Contains the unioned shadow geometry and counts.
    """
    if not sun.is_daytime:
        logger.info("Sun is below horizon — no shadows.")
        return ShadowResult(shadow_union=None, num_building_shadows=0, num_tree_shadows=0, sun=sun)

    shadows: list[Polygon] = []

    # ── Building shadows ──────────────────────────────────────────────────
    b_count = 0
    for b in buildings:
        poly = _project_building_shadow(b["geometry"], sun, b["height"])
        if poly is not None:
            shadows.append(poly)
            b_count += 1

    # ── Tree shadows ──────────────────────────────────────────────────────
    t_count = 0
    for t in trees:
        poly = _project_tree_shadow(t["geometry"], sun, t["height"], t["canopy_radius"])
        if poly is not None:
            shadows.append(poly)
            t_count += 1

    logger.info(
        "Computed %d building shadows + %d tree shadows = %d total",
        b_count,
        t_count,
        len(shadows),
    )

    if not shadows:
        return ShadowResult(shadow_union=None, num_building_shadows=b_count, num_tree_shadows=t_count, sun=sun)

    # Union all shadow polygons
    shadow_union = unary_union(shadows)

    return ShadowResult(
        shadow_union=shadow_union,
        num_building_shadows=b_count,
        num_tree_shadows=t_count,
        sun=sun,
    )

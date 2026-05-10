"""
Thermal Routing Service — computes the 'coolest path' between two points
in Davis, CA by weighting street-graph edges based on sun exposure.

Edge weight formula:
    weight = distance × (1 + sensitivity × exposure × heat_index / 100)

Where:
    - distance: edge length in meters
    - sensitivity: user preference 0.0 (ignore shade) → 1.0 (max shade)
    - exposure: fraction of the edge NOT in shadow (0.0 = fully shaded, 1.0 = fully exposed)
    - heat_index: current heat index in °F
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import networkx as nx
import numpy as np
import osmnx as ox
from shapely.geometry import LineString, mapping, shape
from shapely.ops import unary_union

from app.config import settings
from app.services.shadow_engine import ShadowResult
from app.services.sun_position import SunPosition

logger = logging.getLogger(__name__)

# ── Graph cache ───────────────────────────────────────────────────────────────

_graph_cache: nx.MultiDiGraph | None = None


def get_walking_graph() -> nx.MultiDiGraph:
    """
    Download (or return cached) the Davis, CA walking network.
    The graph is projected to UTM for meter-based edge lengths.
    """
    global _graph_cache
    if _graph_cache is not None:
        return _graph_cache

    logger.info("Downloading walking network for %s …", settings.place_name)
    t0 = time.time()

    G = ox.graph_from_place(settings.place_name, network_type="walk")
    G = ox.project_graph(G)  # project to UTM (meters)

    # Pre-compute edge geometries
    G = ox.utils_graph.get_undirected(G)

    logger.info(
        "Walking graph loaded: %d nodes, %d edges (%.1fs)",
        G.number_of_nodes(),
        G.number_of_edges(),
        time.time() - t0,
    )

    _graph_cache = G
    return G


@dataclass
class RouteResult:
    """Result from the routing computation."""

    geojson: dict[str, Any]
    total_distance_m: float
    shade_percentage: float
    exposure_minutes: float
    sun: SunPosition
    computation_time_s: float


def _compute_edge_exposure(
    edge_data: dict,
    shadow_union,
    graph_crs: Any,
) -> float:
    """
    Compute the exposure fraction (0–1) for a single edge.
    0 = fully shaded, 1 = fully exposed.
    """
    geom = edge_data.get("geometry")
    if geom is None:
        # No geometry → assume fully exposed
        return 1.0

    if shadow_union is None:
        return 1.0

    edge_length = geom.length
    if edge_length == 0:
        return 1.0

    # How much of the edge intersects the shadow?
    try:
        shaded_part = geom.intersection(shadow_union)
        shaded_length = shaded_part.length
    except Exception:
        return 1.0

    shade_fraction = min(shaded_length / edge_length, 1.0)
    return 1.0 - shade_fraction


def compute_coolest_route(
    start: tuple[float, float],
    end: tuple[float, float],
    user_sensitivity: float,
    heat_index: float,
    shadow_result: ShadowResult,
) -> RouteResult:
    """
    Find the shade-optimized route between two lat/lon points.

    Parameters
    ----------
    start : (lat, lon)
    end : (lat, lon)
    user_sensitivity : float 0.0–1.0
    heat_index : float (°F)
    shadow_result : ShadowResult from the shadow engine

    Returns
    -------
    RouteResult
    """
    t0 = time.time()

    G = get_walking_graph()
    crs = G.graph.get("crs")

    # ── Project shadow polygons to the same CRS as the graph ──────────────
    shadow_projected = None
    if shadow_result.shadow_union is not None:
        import pyproj
        from shapely.ops import transform

        transformer = pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        try:
            shadow_projected = transform(transformer.transform, shadow_result.shadow_union)
        except Exception as e:
            logger.warning("Failed to project shadows: %s", e)

    # ── Assign thermal weights to edges ───────────────────────────────────
    for u, v, key, data in G.edges(keys=True, data=True):
        distance = data.get("length", 0.0)
        exposure = _compute_edge_exposure(data, shadow_projected, crs)

        # Weight formula
        thermal_weight = distance * (
            1.0 + user_sensitivity * exposure * heat_index / 100.0
        )
        data["thermal_weight"] = thermal_weight
        data["exposure"] = exposure

    # ── Find nearest nodes to start/end ───────────────────────────────────
    start_node = ox.nearest_nodes(G, X=start[1], Y=start[0])
    end_node = ox.nearest_nodes(G, X=end[1], Y=end[0])

    # ── Shortest path by thermal weight ───────────────────────────────────
    try:
        route_nodes = nx.shortest_path(G, start_node, end_node, weight="thermal_weight")
    except nx.NetworkXNoPath:
        raise ValueError(f"No walking path found between {start} and {end}")

    # ── Build GeoJSON from route ──────────────────────────────────────────
    edge_geometries = []
    total_distance = 0.0
    total_shaded_length = 0.0

    for i in range(len(route_nodes) - 1):
        u, v = route_nodes[i], route_nodes[i + 1]
        # Get the edge with lowest thermal weight
        edge = min(G[u][v].values(), key=lambda d: d.get("thermal_weight", float("inf")))

        dist = edge.get("length", 0.0)
        total_distance += dist

        exposure = edge.get("exposure", 1.0)
        total_shaded_length += dist * (1.0 - exposure)

        geom = edge.get("geometry")
        if geom is not None:
            edge_geometries.append(geom)
        else:
            # Create a straight line between nodes
            u_data = G.nodes[u]
            v_data = G.nodes[v]
            edge_geometries.append(
                LineString([(u_data["x"], u_data["y"]), (v_data["x"], v_data["y"])])
            )

    # Unproject geometries back to lat/lon for GeoJSON
    import pyproj
    from shapely.ops import transform

    transformer_inv = pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    features = []
    for geom in edge_geometries:
        try:
            geom_4326 = transform(transformer_inv.transform, geom)
            # Swap to GeoJSON convention (lon, lat) — transform already does this
            features.append(
                {
                    "type": "Feature",
                    "geometry": mapping(geom_4326),
                    "properties": {},
                }
            )
        except Exception:
            pass

    # Overall shade percentage
    shade_pct = (total_shaded_length / total_distance * 100.0) if total_distance > 0 else 0.0

    # Rough exposure time: assume walking speed ~1.4 m/s
    walking_speed = 1.4  # m/s
    exposed_distance = total_distance - total_shaded_length
    exposure_minutes = (exposed_distance / walking_speed) / 60.0

    geojson = {
        "type": "FeatureCollection",
        "features": features,
        "properties": {
            "total_distance_m": round(total_distance, 1),
            "shade_percentage": round(shade_pct, 1),
            "exposure_minutes": round(exposure_minutes, 1),
            "sun_azimuth": round(shadow_result.sun.azimuth, 1),
            "sun_altitude": round(shadow_result.sun.altitude, 1),
            "heat_index": heat_index,
            "user_sensitivity": user_sensitivity,
        },
    }

    return RouteResult(
        geojson=geojson,
        total_distance_m=total_distance,
        shade_percentage=shade_pct,
        exposure_minutes=exposure_minutes,
        sun=shadow_result.sun,
        computation_time_s=round(time.time() - t0, 3),
    )

"""
Heat Equity Analytics Service.

Computes a 'Heat Equity' score for a neighborhood in Davis, CA
based on the ratio of shaded street area to total street area.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import osmnx as ox
from shapely.geometry import box
from shapely.ops import unary_union

from app.config import settings
from app.services.shadow_engine import ShadowResult

logger = logging.getLogger(__name__)

# Street width assumed for area calculations (meters)
DEFAULT_STREET_WIDTH_M = 8.0

# Score classification thresholds (percentage shaded)
_CLASSIFICATIONS = [
    (75, "Excellent"),
    (50, "Good"),
    (25, "Fair"),
    (0, "Poor"),
]


@dataclass
class HeatEquityResult:
    """Result of Heat Equity analysis for a neighborhood."""

    neighborhood: str
    score: float  # 0–100
    classification: str
    total_street_length_m: float
    shaded_street_length_m: float
    num_streets: int
    street_details: list[dict[str, Any]]


def classify_score(score: float) -> str:
    """Classify a Heat Equity score into a human-readable label."""
    for threshold, label in _CLASSIFICATIONS:
        if score >= threshold:
            return label
    return "Poor"


def compute_heat_equity(
    neighborhood: str,
    shadow_result: ShadowResult,
    bbox: tuple[float, float, float, float] | None = None,
) -> HeatEquityResult:
    """
    Compute the Heat Equity score for a neighborhood.

    Parameters
    ----------
    neighborhood : str
        Name of the neighborhood (used for labeling; bbox takes precedence for geometry).
    shadow_result : ShadowResult
        Current shadow polygons.
    bbox : (north, south, east, west), optional
        Bounding box in lat/lon. If not provided, geocodes the neighborhood name
        within Davis, CA.

    Returns
    -------
    HeatEquityResult
    """
    # ── Get the street network for the area ───────────────────────────────
    if bbox is not None:
        north, south, east, west = bbox
        G = ox.graph_from_bbox(north, south, east, west, network_type="walk")
    else:
        try:
            query = f"{neighborhood}, Davis, California, USA"
            G = ox.graph_from_place(query, network_type="walk")
        except Exception:
            # Fallback: small area around Davis center
            G = ox.graph_from_point(
                (settings.davis_lat, settings.davis_lon),
                dist=500,
                network_type="walk",
            )

    G = ox.project_graph(G)
    crs = G.graph.get("crs")

    # ── Project shadow polygons to graph CRS ──────────────────────────────
    shadow_projected = None
    if shadow_result.shadow_union is not None:
        import pyproj
        from shapely.ops import transform

        transformer = pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        try:
            shadow_projected = transform(transformer.transform, shadow_result.shadow_union)
        except Exception as e:
            logger.warning("Failed to project shadows for analytics: %s", e)

    # ── Compute shade coverage per street ─────────────────────────────────
    edges = ox.graph_to_gdfs(G, nodes=False)
    street_details: list[dict[str, Any]] = []
    total_length = 0.0
    total_shaded = 0.0

    for _, row in edges.iterrows():
        geom = row.geometry
        length = geom.length
        total_length += length

        if shadow_projected is not None and not shadow_projected.is_empty:
            try:
                shaded_part = geom.intersection(shadow_projected)
                shaded_length = shaded_part.length
            except Exception:
                shaded_length = 0.0
        else:
            shaded_length = 0.0

        total_shaded += shaded_length
        shade_pct = (shaded_length / length * 100) if length > 0 else 0.0

        street_name = row.get("name", "Unknown")
        if isinstance(street_name, list):
            street_name = street_name[0] if street_name else "Unknown"

        street_details.append(
            {
                "name": str(street_name),
                "length_m": round(length, 1),
                "shaded_length_m": round(shaded_length, 1),
                "shade_percentage": round(shade_pct, 1),
            }
        )

    # ── Compute overall score ─────────────────────────────────────────────
    score = (total_shaded / total_length * 100) if total_length > 0 else 0.0
    classification = classify_score(score)

    logger.info(
        "Heat Equity for '%s': %.1f%% (%s) — %d streets, %.0fm total",
        neighborhood,
        score,
        classification,
        len(street_details),
        total_length,
    )

    return HeatEquityResult(
        neighborhood=neighborhood,
        score=round(score, 1),
        classification=classification,
        total_street_length_m=round(total_length, 1),
        shaded_street_length_m=round(total_shaded, 1),
        num_streets=len(street_details),
        street_details=sorted(street_details, key=lambda d: d["shade_percentage"]),
    )

"""
Sun position service using the Skyfield astronomical library.

Calculates the exact solar azimuth and altitude for Davis, CA
at any given UTC time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from skyfield.api import Loader, Topos, utc

from app.config import settings

logger = logging.getLogger(__name__)

# ── Skyfield setup (cached ephemeris) ─────────────────────────────────────────

_loader = Loader(str(settings.data_dir), verbose=False)
_ephemeris = _loader("de421.bsp")
_sun = _ephemeris["sun"]
_earth = _ephemeris["earth"]
_ts = _loader.timescale()

# Davis, CA observer location
_davis = Topos(
    latitude_degrees=settings.davis_lat,
    longitude_degrees=settings.davis_lon,
)


@dataclass(frozen=True)
class SunPosition:
    """Solar position result."""

    azimuth: float  # degrees, 0 = North, clockwise
    altitude: float  # degrees above horizon (negative = below)
    is_daytime: bool  # True when sun is above the horizon
    utc_time: datetime


def get_sun_position(utc_time: datetime | None = None) -> SunPosition:
    """
    Calculate the solar azimuth and altitude for Davis, CA.

    Parameters
    ----------
    utc_time : datetime, optional
        The UTC time to compute the position for.
        Defaults to the current UTC time.

    Returns
    -------
    SunPosition
        Dataclass with azimuth (0-360°), altitude (-90 to +90°),
        is_daytime flag, and the UTC time used.
    """
    if utc_time is None:
        utc_time = datetime.now(timezone.utc)

    # Ensure timezone-aware
    if utc_time.tzinfo is None:
        utc_time = utc_time.replace(tzinfo=timezone.utc)

    # Build Skyfield time
    t = _ts.from_datetime(utc_time.astimezone(utc))

    # Apparent position of the sun from Davis
    observer = _earth + _davis
    astrometric = observer.at(t).observe(_sun)
    apparent = astrometric.apparent()

    alt, az, _ = apparent.altaz()

    position = SunPosition(
        azimuth=float(az.degrees),
        altitude=float(alt.degrees),
        is_daytime=bool(alt.degrees > 0),
        utc_time=utc_time,
    )

    logger.debug(
        "Sun position at %s: az=%.1f° alt=%.1f° daytime=%s",
        utc_time.isoformat(),
        position.azimuth,
        position.altitude,
        position.is_daytime,
    )

    return position

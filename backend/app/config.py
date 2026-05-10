"""
Application configuration loaded from environment variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the backend directory
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)


@dataclass(frozen=True)
class Settings:
    """Immutable application settings sourced from environment variables."""

    # ── Database ──────────────────────────────────────────────────────────
    database_url: str = field(
        default_factory=lambda: os.getenv(
            "DATABASE_URL",
            "postgresql+asyncpg://thermal:thermal_secret@localhost:5432/thermal_routing",
        )
    )

    # ── Davis, CA coordinates ─────────────────────────────────────────────
    davis_lat: float = field(
        default_factory=lambda: float(os.getenv("DAVIS_LAT", "38.5449"))
    )
    davis_lon: float = field(
        default_factory=lambda: float(os.getenv("DAVIS_LON", "-121.7405"))
    )

    # ── Heat index default (°F) ──────────────────────────────────────────
    default_heat_index: float = field(
        default_factory=lambda: float(os.getenv("DEFAULT_HEAT_INDEX", "90.0"))
    )

    # ── Place name used for OSMnx queries ─────────────────────────────────
    place_name: str = "Davis, California, USA"

    # ── Data directory for cached files (ephemeris, graph, etc.) ──────────
    data_dir: Path = field(
        default_factory=lambda: Path(__file__).resolve().parent.parent / "data"
    )

    def __post_init__(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()

"""
SQLAlchemy ORM models for buildings and trees with PostGIS geometry columns.
"""

from __future__ import annotations

from geoalchemy2 import Geometry
from sqlalchemy import BigInteger, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Building(Base):
    """OpenStreetMap building footprint stored as a PostGIS polygon."""

    __tablename__ = "buildings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    osm_id: Mapped[int] = mapped_column(BigInteger, nullable=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    building_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    height: Mapped[float] = mapped_column(Float, default=8.0, doc="Estimated height in meters")
    geometry = mapped_column(
        Geometry(geometry_type="POLYGON", srid=4326),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Building osm_id={self.osm_id} height={self.height}m>"


class Tree(Base):
    """OpenStreetMap tree location stored as a PostGIS point."""

    __tablename__ = "trees"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    osm_id: Mapped[int] = mapped_column(BigInteger, nullable=True, index=True)
    species: Mapped[str | None] = mapped_column(String(255), nullable=True)
    height: Mapped[float] = mapped_column(Float, default=8.0, doc="Estimated height in meters")
    canopy_radius: Mapped[float] = mapped_column(
        Float, default=4.0, doc="Canopy radius in meters"
    )
    geometry = mapped_column(
        Geometry(geometry_type="POINT", srid=4326),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Tree osm_id={self.osm_id} height={self.height}m radius={self.canopy_radius}m>"

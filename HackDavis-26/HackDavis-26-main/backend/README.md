# 🌡️ Thermal Routing Backend

A FastAPI-powered shade-optimized walking router for **Davis, CA** that uses real-time sun position, building/tree shadow projections, and heat index to find the **coolest path** between two points.

## Tech Stack

| Technology | Purpose |
|---|---|
| **FastAPI** | Async web framework |
| **PostGIS** | Geospatial database for buildings & trees |
| **OSMnx** | OpenStreetMap graph modeling |
| **Skyfield** | Astronomical sun position calculations |
| **Shapely** | 2D shadow polygon geometry |
| **NetworkX** | Weighted graph routing |

## Quick Start

### 1. Start PostGIS (Docker)

```bash
cd backend
docker compose up -d
```

### 2. Install Python Dependencies

```bash
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

### 3. Ingest OSM Data

```bash
python -m app.scripts.ingest_osm
```

### 4. Run the Server

```bash
uvicorn app.main:app --reload --port 8000
```

### 5. Open API Docs

Navigate to [http://localhost:8000/docs](http://localhost:8000/docs)

## API Endpoints

### `GET /route`

Compute the shade-optimized **Coolest Path**.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `start_lat` | float | *required* | Starting latitude |
| `start_lon` | float | *required* | Starting longitude |
| `end_lat` | float | *required* | Ending latitude |
| `end_lon` | float | *required* | Ending longitude |
| `user_sensitivity` | float | 0.8 | Shade preference (0.0–1.0) |
| `heat_index` | float | 90.0 | Heat index in °F |

**Response:** GeoJSON FeatureCollection with route geometry + metadata.

### `GET /analytics`

Compute **Heat Equity** score for a neighborhood.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `neighborhood` | string | "Downtown Davis" | Neighborhood name |
| `north/south/east/west` | float | *optional* | Bounding box override |

**Response:** Heat Equity score (0–100), classification, per-street breakdown.

### `GET /sun`

Debug endpoint — current sun position for Davis, CA.

### `GET /`

Health check with current sun status.

## How It Works

1. **Sun Position** — Skyfield calculates solar azimuth & altitude for Davis at the current UTC time.
2. **Shadow Engine** — Ray-casting projects 2D shadow polygons from buildings and trees onto the street plane.
3. **Weighted Routing** — Edge weights incorporate distance, sun exposure fraction, and heat index.
4. **Coolest Path** — Dijkstra's algorithm finds the path minimizing thermal exposure.

### Weight Formula

```
weight = distance × (1 + sensitivity × exposure × heat_index / 100)
```

Where `exposure` = fraction of the edge **not** covered by shadow (0 = fully shaded, 1 = fully exposed).

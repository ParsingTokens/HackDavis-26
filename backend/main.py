from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import pickle
import osmnx as ox
from shapely.geometry import Point, LineString
from pydantic import BaseModel
import os
import json
from datetime import datetime, timedelta, timezone
from skyfield.api import load
import geopandas as gpd
from shapely.strtree import STRtree
from shapely.affinity import translate
from shapely.ops import unary_union
import math
import requests
import time as _time

DAVIS_LAT = 38.5397
DAVIS_LON = -121.7495
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class CommunitySpot(BaseModel):
    id: str = None
    lat: float
    lon: float
    type: str
    street: str = "Unknown Street"
    date_added: str = None
    upvotes: int = 0

app = FastAPI(title="Canopy Thermal & Safety Navigation")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Global State
G = None
trees_df = None
tree_sindex = None
buildings_df = None
building_sindex = None
lights_df = None
lights_sindex = None

ts = load.timescale()
planets = load('de421.bsp')
earth, sun = planets['earth'], planets['sun']
from skyfield.toposlib import wgs84
observer = earth + wgs84.latlon(DAVIS_LAT, DAVIS_LON)

# WEATHER CACHE: avoid hammering Open-Meteo on every request
_weather_cache = {"data": None, "fetched_at": 0}

def load_data():
    global G, trees_df, tree_sindex, buildings_df, building_sindex, lights_df, lights_sindex
    try:
        with open(os.path.join(BASE_DIR, "davis_graph.pkl"), "rb") as f:
            G = pickle.load(f)
        print(f"  Graph loaded: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

        trees_path = os.path.join(BASE_DIR, "trees.geojson")
        if os.path.exists(trees_path):
            trees_df = gpd.read_file(trees_path)
            tree_sindex = STRtree(trees_df.geometry.values)
            print(f"  Trees loaded: {len(trees_df)} trees")

        buildings_path = os.path.join(BASE_DIR, "buildings_slim.geojson")
        if os.path.exists(buildings_path):
            buildings_df = gpd.read_file(buildings_path)
            building_sindex = STRtree(buildings_df.geometry.values)
            print(f"  Buildings loaded: {len(buildings_df)} buildings")

        lights_path = os.path.join(BASE_DIR, "lights.geojson")
        if os.path.exists(lights_path):
            lights_df = gpd.read_file(lights_path)
            lights_sindex = STRtree(lights_df.geometry.values)
            print(f"  Lights loaded: {len(lights_df)} lampposts")

        print("All data loaded successfully.")
    except Exception as e:
        print(f"Data load error: {e}")

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    astrometric = observer.at(t).observe(sun)
    alt, az, _ = astrometric.apparent().altaz()
    uv = max(0, 11 * math.sin(math.radians(alt.degrees))) if alt.degrees > 0 else 0
    return alt.degrees, az.degrees, round(uv, 1)

def get_weather_data(hours_offset=0):
    """Cached weather fetch — only hits Open-Meteo once per 5 minutes."""
    global _weather_cache
    now = _time.time()
    if _weather_cache["data"] is None or (now - _weather_cache["fetched_at"]) > 300:
        try:
            url = f"https://api.open-meteo.com/v1/forecast?latitude={DAVIS_LAT}&longitude={DAVIS_LON}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&forecast_days=2"
            res = requests.get(url, timeout=5)
            _weather_cache = {"data": res.json(), "fetched_at": now}
        except Exception:
            if _weather_cache["data"] is None:
                return {"temperature_2m": 82, "wind_speed_10m": 4, "wind_direction_10m": 225}

    data = _weather_cache["data"]
    if hours_offset == 0:
        return data.get('current', {})

    target_idx = datetime.now().hour + int(hours_offset)
    hourly = data.get('hourly', {})
    return {
        "temperature_2m": hourly.get('temperature_2m', [80]*48)[min(target_idx, 47)],
        "wind_speed_10m": hourly.get('wind_speed_10m', [5]*48)[min(target_idx, 47)],
        "wind_direction_10m": hourly.get('wind_direction_10m', [180]*48)[min(target_idx, 47)]
    }

graph_cache = {}

def get_weighted_graph(hours_offset=0):
    """O(E) edge weighting with optimized spatial queries."""
    offset_key = round(hours_offset, 1)
    if offset_key in graph_cache:
        return graph_cache[offset_key]

    t0 = _time.time()
    alt, az, uv = get_solar_pos(hours_offset)
    weather = get_weather_data(hours_offset)
    wind_speed = weather.get("wind_speed_10m", 5)
    wind_cooling = max(0.4, 1.0 - (wind_speed * 0.03))
    is_night = alt <= 0

    G_copy = G.copy()

    # Pre-compute shadow direction once (not per-edge)
    if not is_night:
        shadow_angle_rad = math.radians((az + 180) % 360)
        sin_shadow = math.sin(shadow_angle_rad)
        cos_shadow = math.cos(shadow_angle_rad)

    for u, v, k, data in G_copy.edges(keys=True, data=True):
        length = data.get('length', 1.0)

        if is_night:
            # NIGHT: penalize unlit segments
            darkness = 40.0
            if lights_sindex:
                mid_x = (G_copy.nodes[u]['x'] + G_copy.nodes[v]['x']) / 2
                mid_y = (G_copy.nodes[u]['y'] + G_copy.nodes[v]['y']) / 2
                midpoint = Point(mid_x, mid_y)
                nearby = lights_sindex.query(midpoint.buffer(0.0004))
                if len(nearby) > 0:
                    darkness = max(0, 40.0 - len(nearby) * 6.0)
            data['weight'] = length * (1.0 + darkness)
            data['exposure_ratio'] = 0
            continue

        # DAY: check building cut-through (centroid only, fast)
        mid_x = (G_copy.nodes[u]['x'] + G_copy.nodes[v]['x']) / 2
        mid_y = (G_copy.nodes[u]['y'] + G_copy.nodes[v]['y']) / 2
        midpoint = Point(mid_x, mid_y)

        if building_sindex and len(building_sindex.query(midpoint.buffer(0.00008))) > 0:
            data['weight'] = length * 0.05
            data['exposure_ratio'] = 0
            continue

        # DAY: fast shade estimation using midpoint proximity to trees
        exposure = 1.0
        if tree_sindex:
            nearby_trees = tree_sindex.query(midpoint.buffer(0.0004))
            if len(nearby_trees) > 0:
                # Simplified: count how many tree shadows cover the midpoint
                shaded = 0
                for idx in nearby_trees[:8]:  # cap at 8 nearest for speed
                    tree_pt = trees_df.geometry.values[idx]
                    h = 8
                    try: h = trees_df.iloc[idx].get('height_m', 8)
                    except: pass
                    shadow_len = h / math.tan(math.radians(max(5, alt)))
                    dx = shadow_len * sin_shadow * 0.000009
                    dy = shadow_len * cos_shadow * 0.000009
                    # Check if midpoint is within shadow cone
                    sx = tree_pt.x + dx
                    sy = tree_pt.y + dy
                    dist_to_shadow = math.sqrt((mid_x - sx)**2 + (mid_y - sy)**2)
                    if dist_to_shadow < 0.00015:
                        shaded += 1
                if shaded > 0:
                    exposure = max(0.1, 1.0 - (shaded / max(1, len(nearby_trees[:8]))))

        data['exposure_ratio'] = round(exposure, 2)
        data['weight'] = length * (1.0 + exposure * 50.0 * wind_cooling)

    graph_cache[offset_key] = G_copy
    print(f"  Weighted graph for offset {offset_key} in {_time.time()-t0:.2f}s")
    return G_copy

def build_geojson(graph, path, r_type, color):
    coords = []
    total_len = 0
    total_exp = 0
    instructions = []
    curr_street = None
    dist_on_street = 0

    for u, v in zip(path[:-1], path[1:]):
        edge = graph.get_edge_data(u, v)[0]
        geom = edge.get('geometry')
        if not geom:
            geom = LineString([Point(graph.nodes[u]['x'], graph.nodes[u]['y']), Point(graph.nodes[v]['x'], graph.nodes[v]['y'])])
        c = list(geom.coords)
        if not coords: coords.extend(c)
        else: coords.extend(c[1:])
        l = edge.get('length', 0)
        total_len += l
        total_exp += edge.get('exposure_ratio', 1.0) * l
        name = edge.get('name', 'Pathway')
        if isinstance(name, list): name = name[0]
        if name != curr_street:
            if curr_street: instructions.append(f"Follow {name} for {int(dist_on_street)}m")
            curr_street = name
            dist_on_street = l
        else: dist_on_street += l

    instructions.append(f"Arrive via {curr_street}")
    return {
        "type": "Feature",
        "properties": {
            "type": r_type,
            "time_mins": max(1, int(total_len / 80)),
            "exposure": round(total_exp / total_len, 2) if total_len > 0 else 1.0,
            "color": color,
            "instructions": instructions
        },
        "geometry": {"type": "LineString", "coordinates": coords}
    }

@app.get("/route")
def get_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float, time_offset: float = 0):
    if G is None: return {"error": "Data loading..."}
    G_weighted = get_weighted_graph(time_offset)
    try:
        orig = ox.distance.nearest_nodes(G_weighted, start_lon, start_lat)
        dest = ox.distance.nearest_nodes(G_weighted, end_lon, end_lat)
        f_path = nx.shortest_path(G_weighted, orig, dest, weight='length')
        f_feat = build_geojson(G_weighted, f_path, 'fastest', '#f59e0b')
        c_path = nx.shortest_path(G_weighted, orig, dest, weight='weight')
        c_feat = build_geojson(G_weighted, c_path, 'comfort', '#0ea5e9')
        alt, az, uv = get_solar_pos(time_offset)
        weather = get_weather_data(time_offset)
        return {
            "features": [f_feat, c_feat],
            "weather": {"temp": weather.get('temperature_2m', 80), "wind_speed": weather.get('wind_speed_10m', 5), "wind_dir": weather.get('wind_direction_10m', 225)},
            "sun": {"alt": alt, "az": az, "uv": uv}
        }
    except Exception as e:
        return {"error": str(e)}

@app.get("/sun_position")
def sun_pos(hours_offset: float = 0):
    alt, az, uv = get_solar_pos(hours_offset)
    return {"altitude": alt, "azimuth": az, "uv_index": uv}

@app.get("/weather")
def weather_api(hours_offset: float = 0):
    w = get_weather_data(hours_offset)
    return {"temp": w.get('temperature_2m'), "wind_speed": w.get('wind_speed_10m'), "wind_dir": w.get('wind_direction_10m')}

@app.get("/lights")
def lights_api():
    path = os.path.join(BASE_DIR, "lights.geojson")
    if os.path.exists(path):
        with open(path, "r") as f: return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.get("/trees")
def trees_api():
    path = os.path.join(BASE_DIR, "trees.geojson")
    if os.path.exists(path):
        with open(path, "r") as f: return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.get("/buildings")
def buildings_api():
    path = os.path.join(BASE_DIR, "buildings_slim.geojson")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f: return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.get("/pois")
def pois_api():
    path = os.path.join(BASE_DIR, "ucd_pois.json")
    if os.path.exists(path):
        with open(path, "r") as f: return json.load(f)
    return []

@app.post("/report_spot")
def report_api(spot: CommunitySpot):
    return {"status": "success"}

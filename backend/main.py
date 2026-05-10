from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import pickle
import osmnx as ox
from shapely.geometry import Point, LineString, Polygon
from pydantic import BaseModel
import os
import json
from datetime import datetime, timedelta, timezone
from skyfield.api import load
import geopandas as gpd
from shapely.strtree import STRtree
import math
import requests

# Set Davis coordinates
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

app = FastAPI(title="Canopy Thermal Navigation Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global State
G = None
trees_df = None
tree_sindex = None
buildings_df = None
building_sindex = None
ts = load.timescale()
planets = load('de421.bsp')
earth, sun = planets['earth'], planets['sun']
from skyfield.toposlib import wgs84
observer = earth + wgs84.latlon(DAVIS_LAT, DAVIS_LON)

def load_data():
    global G, trees_df, tree_sindex, buildings_df, building_sindex
    try:
        with open(os.path.join(BASE_DIR, "davis_graph.pkl"), "rb") as f:
            G = pickle.load(f)
        
        trees_path = os.path.join(BASE_DIR, "trees.geojson")
        if os.path.exists(trees_path):
            trees_df = gpd.read_file(trees_path)
            tree_sindex = STRtree(trees_df.geometry.values)
        
        buildings_path = os.path.join(BASE_DIR, "buildings_slim.geojson")
        if os.path.exists(buildings_path):
            buildings_df = gpd.read_file(buildings_path)
            building_sindex = STRtree(buildings_df.geometry.values)
            
        print(f"Core data loaded successfully.")
    except Exception as e:
        print(f"Data load error: {e}")

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    astrometric = observer.at(t).observe(sun)
    alt, az, _ = astrometric.apparent().altaz()
    
    uv = 0
    if alt.degrees > 0:
        uv = max(0, 11 * math.sin(math.radians(alt.degrees)))
    return alt.degrees, az.degrees, round(uv, 1)

def get_shadow_offset(height, solar_alt, solar_az):
    if solar_alt <= 0: return 0, 0
    shadow_length = height / math.tan(math.radians(max(1, solar_alt)))
    shadow_angle = math.radians((solar_az + 180) % 360)
    dx = shadow_length * math.sin(shadow_angle) * 0.000009
    dy = shadow_length * math.cos(shadow_angle) * 0.000009
    return dx, dy

def get_weather_data(hours_offset=0):
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={DAVIS_LAT}&longitude={DAVIS_LON}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&forecast_days=2"
        res = requests.get(url, timeout=5)
        data = res.json()
        
        if hours_offset == 0:
            return data.get('current', {})
        
        now = datetime.now()
        target_idx = now.hour + int(hours_offset)
        hourly = data.get('hourly', {})
        
        return {
            "temperature_2m": hourly.get('temperature_2m', [80]*48)[target_idx],
            "wind_speed_10m": hourly.get('wind_speed_10m', [5]*48)[target_idx],
            "wind_direction_10m": hourly.get('wind_direction_10m', [180]*48)[target_idx]
        }
    except Exception:
        return {"temperature_2m": 82, "wind_speed_10m": 4, "wind_direction_10m": 225}

def calculate_convective_cooling(wind_speed):
    return max(0.4, 1.0 - (wind_speed * 0.03))

graph_cache = {}

def get_weighted_graph(hours_offset=0):
    offset_key = round(hours_offset, 1)
    if offset_key in graph_cache: return graph_cache[offset_key]
    
    alt, az, uv = get_solar_pos(hours_offset)
    weather = get_weather_data(hours_offset)
    wind_cooling = calculate_convective_cooling(weather.get("wind_speed_10m", 5))
    
    G_copy = G.copy()
    is_night = alt <= 0
    
    for u, v, k, data in G_copy.edges(keys=True, data=True):
        length = data.get('length', 1.0)
        
        if is_night:
            data['weight'] = length
            data['exposure_ratio'] = 0
            continue
            
        geom = data.get('geometry')
        if not geom:
            geom = LineString([Point(G_copy.nodes[u]['x'], G_copy.nodes[u]['y']), Point(G_copy.nodes[v]['x'], G_copy.nodes[v]['y'])])
        
        # 1. Hall / Building Cut-through Check (Huge Bonus during day)
        is_indoor = False
        if building_sindex:
            nearby_b_idx = building_sindex.query(geom.centroid.buffer(0.0001))
            if len(nearby_b_idx) > 0:
                is_indoor = True
        
        if is_indoor:
            # Halls are 95% faster in thermal terms (AC bonus)
            data['weight'] = length * 0.05 
            data['exposure_ratio'] = 0
            continue
            
        # 2. Shade Check
        exposure = 1.0
        if tree_sindex:
            nearby_t_idx = tree_sindex.query(geom.buffer(0.0003))
            if len(nearby_t_idx) > 0:
                shadow_polys = []
                for idx in nearby_t_idx:
                    tree = trees_df.iloc[idx]
                    h = tree.get('height_m', 8)
                    dx, dy = get_shadow_offset(h, alt, az)
                    canopy = tree.geometry.buffer(0.00006)
                    from shapely.affinity import translate
                    shadow = translate(canopy, xoff=dx, yoff=dy).union(canopy).convex_hull
                    shadow_polys.append(shadow)
                
                if shadow_polys:
                    from shapely.ops import unary_union
                    unified_shadow = unary_union(shadow_polys)
                    shaded_len = geom.intersection(unified_shadow).length
                    exposure = max(0.0, 1.0 - (shaded_len / geom.length)) if geom.length > 0 else 1.0
        
        data['exposure_ratio'] = round(exposure, 2)
        
        # Thermal Penalty: Increased significantly (50x) to ensure path divergence
        thermal_penalty = (exposure * 50.0) * wind_cooling
        data['weight'] = length * (1.0 + thermal_penalty)
        
    graph_cache[offset_key] = G_copy
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
        
        # 1. EFFICIENT (Shortest Distance)
        f_path = nx.shortest_path(G_weighted, orig, dest, weight='length')
        f_feat = build_geojson(G_weighted, f_path, 'fastest', '#f59e0b')
        
        # 2. COOLER (Shortest Thermal Weight)
        c_path = nx.shortest_path(G_weighted, orig, dest, weight='weight')
        c_feat = build_geojson(G_weighted, c_path, 'coolest', '#0ea5e9')
        
        # Environment metadata
        alt, az, uv = get_solar_pos(time_offset)
        weather = get_weather_data(time_offset)
        
        # Sunlight Saved check
        saved = 0
        f_e = f_feat['properties']['exposure']
        c_e = c_feat['properties']['exposure']
        if f_e > 0: saved = int(max(0, (1.0 - (c_e / f_e)) * 100))

        return {
            "features": [f_feat, c_feat],
            "weather": {
                "temp": weather.get('temperature_2m', 80),
                "wind_speed": weather.get('wind_speed_10m', 5),
                "wind_dir": weather.get('wind_direction_10m', 225)
            },
            "sun": {"alt": alt, "az": az, "uv": uv},
            "sunlight_saved": saved
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

@app.get("/trees")
def trees_api():
    if os.path.exists("trees.geojson"):
        with open("trees.geojson", "r") as f: return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.get("/buildings")
def buildings_api():
    path = os.path.join(BASE_DIR, "buildings_slim.geojson")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f: return json.load(f)
    return {"type": "FeatureCollection", "features": []}

@app.get("/community_spots")
def spots_api():
    if os.path.exists("community_spots.json"):
        with open("community_spots.json", "r") as f: return json.load(f)
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

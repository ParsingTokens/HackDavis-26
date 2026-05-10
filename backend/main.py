from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import pickle
import osmnx as ox
from shapely.geometry import Point, LineString
from shapely.affinity import translate
from shapely.ops import unary_union
from pydantic import BaseModel
import os, json, math, requests, time as _time
from datetime import datetime, timedelta, timezone
from skyfield.api import load
import geopandas as gpd
from shapely.strtree import STRtree

DAVIS_LAT, DAVIS_LON = 38.5397, -121.7495
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

G = None
trees_df = None
tree_sindex = None
building_sindex = None

ts = load.timescale()
planets = load('de421.bsp')
earth, sun_body = planets['earth'], planets['sun']
from skyfield.toposlib import wgs84
observer = earth + wgs84.latlon(DAVIS_LAT, DAVIS_LON)

_edge_geom = {}
_edge_is_indoor = {}
_edge_tree_idx = {}

# MEMORY CACHE - INSTANT SWITCHING
_graph_cache = {}
_weather_data_full = None

def load_data():
    global G, trees_df, tree_sindex, building_sindex
    try:
        with open(os.path.join(BASE_DIR, "davis_graph.pkl"), "rb") as f:
            G = pickle.load(f)
        tp = os.path.join(BASE_DIR, "trees.geojson")
        if os.path.exists(tp):
            trees_df = gpd.read_file(tp)
            tree_sindex = STRtree(trees_df.geometry.values)
        bp = os.path.join(BASE_DIR, "buildings_slim.geojson")
        if os.path.exists(bp):
            bdf = gpd.read_file(bp)
            building_sindex = STRtree(bdf.geometry.values)
        _precompute()
    except Exception as e: print(f"Error: {e}")

def _precompute():
    for u, v, k, data in G.edges(keys=True, data=True):
        eid = (u, v, k)
        geom = data.get('geometry') or LineString([Point(G.nodes[u]['x'], G.nodes[u]['y']), Point(G.nodes[v]['x'], G.nodes[v]['y'])])
        _edge_geom[eid] = geom
        _edge_is_indoor[eid] = building_sindex and len(building_sindex.query(geom.centroid.buffer(0.0001))) > 0
        _edge_tree_idx[eid] = list(tree_sindex.query(geom.buffer(0.0003))) if tree_sindex else []

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    astrometric = observer.at(t).observe(sun_body)
    alt, az, _ = astrometric.apparent().altaz()
    return alt.degrees, az.degrees, round(max(0, 11 * math.sin(math.radians(alt.degrees))), 1) if alt.degrees > 0 else 0

def _shadow_offset(h, alt, az):
    if alt <= 0: return 0, 0
    shadow_len = h / math.tan(math.radians(max(0.1, alt)))
    angle = math.radians((az + 180) % 360)
    return shadow_len * math.sin(angle) * 0.000009, shadow_len * math.cos(angle) * 0.000009

def fetch_all_weather():
    global _weather_data_full
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={DAVIS_LAT}&longitude={DAVIS_LON}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&forecast_days=2"
        _weather_data_full = requests.get(url, timeout=5).json()
    except: pass

fetch_all_weather()

def get_weather(off):
    if not _weather_data_full: return {"temp": 80, "wind_speed": 5, "wind_dir": 225}
    if off == 0:
        c = _weather_data_full.get('current', {})
        return {"temp": c.get("temperature_2m", 80), "wind_speed": c.get("wind_speed_10m", 5), "wind_dir": c.get("wind_direction_10m", 225)}
    idx = (datetime.now().hour + int(off)) % 48
    h = _weather_data_full.get('hourly', {})
    return {"temp": h.get('temperature_2m', [80]*48)[idx], "wind_speed": h.get('wind_speed_10m', [5]*48)[idx], "wind_dir": h.get('wind_direction_10m', [225]*48)[idx]}

@app.get("/route")
def route_api(start_lat: float, start_lon: float, end_lat: float, end_lon: float, time_offset: float = 0):
    key = round(time_offset * 2) / 2
    if key not in _graph_cache:
        alt, az, _ = get_solar_pos(time_offset)
        w = get_weather(time_offset)
        wf = max(0.2, 1.0 - (w["wind_speed"] * 0.05))
        night = alt <= 0
        Gc = G.copy()
        for u, v, k, data in Gc.edges(keys=True, data=True):
            eid = (u, v, k); length = data.get('length', 1.0)
            if night: data['weight'] = length; data['exposure_ratio'] = 0; continue
            if _edge_is_indoor.get(eid): data['weight'] = length * 0.01; data['exposure_ratio'] = 0; continue
            exp = 1.0; tidx = _edge_tree_idx.get(eid, [])
            if tidx:
                geom = _edge_geom[eid]; shadows = []
                for i in tidx:
                    tree = trees_df.iloc[i]; dx, dy = _shadow_offset(tree.get('height_m', 8), alt, az)
                    c = tree.geometry.buffer(0.00006); shadows.append(translate(c, xoff=dx, yoff=dy).union(c).convex_hull)
                if shadows:
                    s = unary_union(shadows)
                    exp = max(0.0, 1.0 - geom.intersection(s).length / geom.length) if geom.length > 0 else 1.0
            data['exposure_ratio'] = round(exp, 2); data['weight'] = length * (1.0 + exp * 100.0 * wf)
        _graph_cache[key] = Gc
    
    Gw = _graph_cache[key]
    try:
        o = ox.distance.nearest_nodes(Gw, start_lon, start_lat)
        d = ox.distance.nearest_nodes(Gw, end_lon, end_lat)
        fp = nx.shortest_path(Gw, o, d, weight='length')
        cp = nx.shortest_path(Gw, o, d, weight='weight')
        
        def build(path, rtype, color):
            coords, tl, te = [], 0, 0; instr, cs, ds = [], None, 0
            for u, v in zip(path[:-1], path[1:]):
                e = Gw.get_edge_data(u, v)[0]
                g = e.get('geometry') or LineString([Point(Gw.nodes[u]['x'], Gw.nodes[u]['y']), Point(Gw.nodes[v]['x'], Gw.nodes[v]['y'])])
                coords.extend(list(g.coords) if not coords else list(g.coords)[1:])
                l = e.get('length', 0); tl += l; te += e.get('exposure_ratio', 1) * l
                n = e.get('name', 'Pathway'); n = n[0] if isinstance(n, list) else n
                if n != cs:
                    if cs: instr.append(f"Follow {n} for {int(ds)}m")
                    cs, ds = n, l
                else: ds += l
            instr.append(f"Arrive via {cs}")
            return {"type":"Feature","properties":{"type":rtype,"time_mins":max(1,int(tl/80)),"exposure":round(te/tl,2) if tl>0 else 1,"color":color,"instructions":instr},"geometry":{"type":"LineString","coordinates":coords}}
        
        ff, cf = build(fp, 'fastest', '#f59e0b'), build(cp, 'coolest', '#0ea5e9')
        alt, az, uv = get_solar_pos(time_offset)
        return {"features": [ff, cf], "weather": get_weather(time_offset), "sun": {"alt": alt, "az": az, "uv": uv}}
    except Exception as e: return {"error": str(e)}

@app.get("/sun_position")
def sun_api(hours_offset: float = 0):
    alt, az, uv = get_solar_pos(hours_offset)
    return {"altitude": alt, "azimuth": az, "uv_index": uv}

@app.get("/weather")
def weather_api(hours_offset: float = 0): return get_weather(hours_offset)
@app.get("/trees")
def trees_api(): return json.load(open(os.path.join(BASE_DIR, "trees.geojson")))
@app.get("/buildings")
def buildings_api(): return json.load(open(os.path.join(BASE_DIR, "buildings_slim.geojson"), encoding="utf-8"))
@app.get("/pois")
def pois_api(): return json.load(open(os.path.join(BASE_DIR, "ucd_pois.json")))
@app.get("/community_spots")
def spots_api(): return json.load(open(os.path.join(BASE_DIR, "community_spots.json")))
@app.post("/report_spot")
def report_api(): return {"status": "ok"}

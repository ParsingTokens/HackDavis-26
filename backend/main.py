from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import pickle
import osmnx as ox
from shapely.geometry import Point, LineString
import os, json, math, requests, time as _time
from datetime import datetime, timedelta, timezone
from skyfield.api import load
import geopandas as gpd
from shapely.strtree import STRtree
from scipy.spatial import cKDTree

DAVIS_LAT, DAVIS_LON = 38.5397, -121.7495
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="Canopy")
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

_edge_cx = []
_edge_cy = []
_edge_ids = []
_edge_lengths = []
_edge_is_indoor = []
_edge_tree_lookups = []
_trees_list = []
_kdtree = None
_node_ids = []

_graph_cache = {}
_weather_cache = {}
_weather_cache_time = 0

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
    except Exception as e:
        print(f"Load error: {e}")

def _precompute():
    global _edge_cx, _edge_cy, _edge_ids, _edge_lengths, _edge_is_indoor, _edge_tree_lookups, _trees_list, _kdtree, _node_ids
    _edge_cx, _edge_cy, _edge_ids, _edge_lengths, _edge_is_indoor, _edge_tree_lookups = [], [], [], [], [], []
    
    # Precompute fast tree array to avoid slow pandas lookups
    _trees_list = []
    if trees_df is not None:
        for i in range(len(trees_df)):
            t = trees_df.iloc[i]
            _trees_list.append({
                'h': t.get('height_m', 8),
                'cx': t.geometry.centroid.x,
                'cy': t.geometry.centroid.y
            })

    for u, v, k, data in G.edges(keys=True, data=True):
        eid = (u, v, k)
        geom = data.get('geometry')
        if not geom:
            geom = LineString([Point(G.nodes[u]['x'], G.nodes[u]['y']), Point(G.nodes[v]['x'], G.nodes[v]['y'])])
        
        c = geom.centroid
        _edge_cx.append(c.x)
        _edge_cy.append(c.y)
        _edge_ids.append(eid)
        _edge_lengths.append(data.get('length', 1.0))
        
        indoor = False
        if building_sindex and len(building_sindex.query(c.buffer(0.0001))) > 0: indoor = True
        _edge_is_indoor.append(indoor)
        _edge_tree_lookups.append(list(tree_sindex.query(geom.buffer(0.0003))) if tree_sindex else [])

    # Fast KDTree for nearest node queries
    node_coords = []
    _node_ids = []
    for node, data in G.nodes(data=True):
        node_coords.append((data['x'], data['y']))
        _node_ids.append(node)
    _kdtree = cKDTree(node_coords)

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    astrometric = observer.at(t).observe(sun_body)
    alt, az, _ = astrometric.apparent().altaz()
    uv = max(0, 11 * math.sin(math.radians(alt.degrees))) if alt.degrees > 0 else 0
    return alt.degrees, az.degrees, round(uv, 1)

def _shadow_offset(h, alt, az):
    if alt <= 0: return 0, 0
    sl = h / math.tan(math.radians(max(0.5, alt)))
    a = math.radians((az + 180) % 360)
    return sl * math.sin(a) * 0.000009, sl * math.cos(a) * 0.000009

def _fetch_weather():
    global _weather_cache, _weather_cache_time
    now = _time.time()
    if _weather_cache and now - _weather_cache_time < 300: return _weather_cache
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={DAVIS_LAT}&longitude={DAVIS_LON}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&forecast_days=2"
        data = requests.get(url, timeout=5).json()
        _weather_cache, _weather_cache_time = data, now
        return data
    except Exception: return _weather_cache or {}

def get_weather(hours_offset=0):
    data = _fetch_weather()
    if hours_offset == 0:
        c = data.get('current', {})
        return {"temp": c.get("temperature_2m", 80), "wind_speed": c.get("wind_speed_10m", 5), "wind_dir": c.get("wind_direction_10m", 225)}
    idx = (datetime.now().hour + int(hours_offset)) % 48
    h = data.get('hourly', {})
    return {"temp": h.get('temperature_2m', [80]*48)[idx], "wind_speed": h.get('wind_speed_10m', [5]*48)[idx], "wind_dir": h.get('wind_direction_10m', [225]*48)[idx]}

def get_weighted_graph(hours_offset=0):
    key = round(hours_offset * 2) / 2
    if key in _graph_cache: return _graph_cache[key]
    alt, az, _ = get_solar_pos(hours_offset)
    w = get_weather(hours_offset)
    wind_factor = max(0.4, 1.0 - (w["wind_speed"] * 0.03))
    night = alt <= 0
    
    weights, exposures = {}, {}
    for i in range(len(_edge_ids)):
        eid, length = _edge_ids[i], _edge_lengths[i]
        if night: weights[eid], exposures[eid] = length, 0; continue
        if _edge_is_indoor[i]: weights[eid], exposures[eid] = length * 0.05, 0; continue # Huge indoor bonus (95% reduction)
        
        exp = 1.0
        tidx = _edge_tree_lookups[i]
        if tidx:
            cx, cy = _edge_cx[i], _edge_cy[i]
            shadow_hit = False
            for ti in tidx:
                t = _trees_list[ti]
                dx, dy = _shadow_offset(t['h'], alt, az)
                # Fast distance check avoiding shapely Point creation
                if math.hypot(cx - (t['cx'] + dx), cy - (t['cy'] + dy)) < 0.0001:
                    shadow_hit = True; break
            exp = 0.15 if shadow_hit else 1.0
        exposures[eid] = exp
        
        # Reduced penalty from 25x to 8x. Still prioritizes shade but prevents dumb U-turns
        # Distance efficiency matters more now.
        weights[eid] = length * (1.0 + exp * 8.0 * wind_factor)
        
    # Apply dynamically as a dictionary lookup to avoid G.copy() cost
    # Actually, G.copy() is fast enough if run once per time_offset, and caching prevents re-computation.
    G_c = G.copy()
    for eid, weight in weights.items():
        G_c.edges[eid]['weight'] = weight
        G_c.edges[eid]['exposure_ratio'] = exposures[eid]
    _graph_cache[key] = G_c
    return G_c

@app.get("/route")
def route_api(start_lat: float, start_lon: float, end_lat: float, end_lon: float, time_offset: float = 0):
    if not G or _kdtree is None: return {"error": "Loading..."}
    t0 = _time.time()
    Gw = get_weighted_graph(time_offset)
    try:
        # Fast KDTree lookup
        _, o_idx = _kdtree.query((start_lon, start_lat))
        _, d_idx = _kdtree.query((end_lon, end_lat))
        o, d = _node_ids[o_idx], _node_ids[d_idx]
        
        fp = nx.shortest_path(Gw, o, d, weight='length'); cp = nx.shortest_path(Gw, o, d, weight='weight')
        def build_gj(path, rtype, color):
            coords, tl, te = [], 0, 0
            for u, v in zip(path[:-1], path[1:]):
                e = Gw.get_edge_data(u, v)[0]
                g = e.get('geometry') or LineString([Point(Gw.nodes[u]['x'], Gw.nodes[u]['y']), Point(Gw.nodes[v]['x'], Gw.nodes[v]['y'])])
                coords.extend(list(g.coords) if not coords else list(g.coords)[1:])
                l = e.get('length', 0); tl += l; te += e.get('exposure_ratio', 1) * l
            return {"type": "Feature", "properties": {"type": rtype, "time_mins": max(1, int(tl/80)), "exposure": round(te/tl, 2) if tl>0 else 1, "color": color}, "geometry": {"type": "LineString", "coordinates": coords}}
        
        res = {"features": [build_gj(fp, 'fastest', '#f59e0b'), build_gj(cp, 'coolest', '#0ea5e9')], "weather": get_weather(time_offset), "sun": get_solar_pos(time_offset), "perf_ms": int((_time.time()-t0)*1000)}
        return res
    except Exception as e: return {"error": str(e)}

@app.get("/sun_position")
def sun_api(hours_offset: float = 0):
    a, az, uv = get_solar_pos(hours_offset); return {"altitude": a, "azimuth": az, "uv_index": uv}

@app.get("/weather")
def weather_api(hours_offset: float = 0): return get_weather(hours_offset)

@app.get("/trees")
def trees_api():
    p = os.path.join(BASE_DIR, "trees.geojson")
    return json.load(open(p)) if os.path.exists(p) else {"type":"FeatureCollection","features":[]}

@app.get("/buildings")
def buildings_api():
    p = os.path.join(BASE_DIR, "buildings_slim.geojson")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {"type":"FeatureCollection","features":[]}

@app.get("/pois")
def pois_api():
    p = os.path.join(BASE_DIR, "ucd_pois.json")
    return json.load(open(p)) if os.path.exists(p) else []

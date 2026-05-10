from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import networkx as nx
import pickle
import osmnx as ox
from shapely.geometry import Point, LineString
from pydantic import BaseModel
import os, json, math, requests, time as _time
from datetime import datetime, timedelta, timezone
from skyfield.api import load
import geopandas as gpd
from shapely.strtree import STRtree

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

# Pre-computed per-edge data
_edge_geom = {}
_edge_is_indoor = {}
_edge_tree_count = {}   # just the COUNT of nearby trees — no polygon ops needed
_edge_length = {}

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
        print(f"Graph: {len(G.nodes)} nodes, {len(G.edges)} edges")
        _precompute()
    except Exception as e:
        print(f"Load error: {e}")

def _precompute():
    """One-time precompute. Only stores counts — no polygon ops at runtime."""
    t0 = _time.time()
    ic = 0
    for u, v, k, data in G.edges(keys=True, data=True):
        eid = (u, v, k)
        geom = data.get('geometry')
        if not geom:
            geom = LineString([Point(G.nodes[u]['x'], G.nodes[u]['y']),
                               Point(G.nodes[v]['x'], G.nodes[v]['y'])])
        _edge_geom[eid] = geom
        _edge_length[eid] = data.get('length', geom.length * 111000)

        indoor = False
        if building_sindex and len(building_sindex.query(geom.centroid.buffer(0.0001))) > 0:
            indoor = True
            ic += 1
        _edge_is_indoor[eid] = indoor

        # Just count nearby trees — this is all we need for the heuristic
        tc = len(tree_sindex.query(geom.buffer(0.0003))) if tree_sindex else 0
        _edge_tree_count[eid] = tc
    print(f"Precompute: {_time.time()-t0:.1f}s, {ic} indoor, {sum(1 for v in _edge_tree_count.values() if v>0)} shaded edges")

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    alt, az, _ = observer.at(t).observe(sun_body).apparent().altaz()
    uv = max(0, 11 * math.sin(math.radians(alt.degrees))) if alt.degrees > 0 else 0
    return alt.degrees, az.degrees, round(uv, 1)

def _fetch_weather_raw():
    global _weather_cache, _weather_cache_time
    now = _time.time()
    if _weather_cache and now - _weather_cache_time < 300:
        return _weather_cache
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={DAVIS_LAT}&longitude={DAVIS_LON}&current=temperature_2m,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&forecast_days=2"
        data = requests.get(url, timeout=5).json()
        _weather_cache = data
        _weather_cache_time = now
        return data
    except:
        return _weather_cache or {}

def get_weather(hours_offset=0):
    data = _fetch_weather_raw()
    if hours_offset == 0:
        c = data.get('current', {})
        return {"temperature_2m": c.get("temperature_2m", 80), "wind_speed_10m": c.get("wind_speed_10m", 5), "wind_direction_10m": c.get("wind_direction_10m", 225)}
    idx = min(47, max(0, datetime.now().hour + int(hours_offset)))
    h = data.get('hourly', {})
    return {"temperature_2m": h.get('temperature_2m', [80]*48)[idx], "wind_speed_10m": h.get('wind_speed_10m', [5]*48)[idx], "wind_direction_10m": h.get('wind_direction_10m', [225]*48)[idx]}

def get_weighted_graph(hours_offset=0):
    """O(E) pure arithmetic — no shapely ops at runtime."""
    key = round(hours_offset * 2) / 2
    if key in _graph_cache: return _graph_cache[key]
    alt, az, _ = get_solar_pos(hours_offset)
    w = get_weather(hours_offset)
    wf = max(0.4, 1.0 - w["wind_speed_10m"] * 0.03)
    night = alt <= 0

    # Sun altitude affects how much shade trees cast
    # Low sun = long shadows = more shade coverage
    # High sun = short shadows = less shade
    shade_effectiveness = (1.0 - alt / 90.0) if not night else 0

    G_c = G.copy()
    for u, v, k, data in G_c.edges(keys=True, data=True):
        eid = (u, v, k)
        length = _edge_length.get(eid, data.get('length', 1.0))
        if night:
            data['weight'] = length; data['exposure_ratio'] = 0; continue
        if _edge_is_indoor.get(eid):
            data['weight'] = length * 0.05; data['exposure_ratio'] = 0; continue

        # Fast shade heuristic: more nearby trees = less exposure
        # Each tree reduces exposure by ~15%, capped at 85% reduction
        tc = _edge_tree_count.get(eid, 0)
        shade = min(0.85, tc * 0.15 * shade_effectiveness)
        exp = 1.0 - shade

        data['exposure_ratio'] = round(exp, 2)
        data['weight'] = length * (1.0 + exp * 50.0 * wf)

    _graph_cache[key] = G_c
    return G_c

def _build_gj(graph, path, rtype, color):
    coords, tl, te = [], 0, 0
    instr, cs, ds = [], None, 0
    for u, v in zip(path[:-1], path[1:]):
        e = graph.get_edge_data(u, v)[0]
        g = e.get('geometry') or LineString([Point(graph.nodes[u]['x'], graph.nodes[u]['y']), Point(graph.nodes[v]['x'], graph.nodes[v]['y'])])
        c = list(g.coords)
        coords.extend(c if not coords else c[1:])
        l = e.get('length', 0); tl += l; te += e.get('exposure_ratio', 1) * l
        n = e.get('name', 'Pathway')
        if isinstance(n, list): n = n[0]
        if n != cs:
            if cs: instr.append(f"Follow {n} for {int(ds)}m")
            cs, ds = n, l
        else: ds += l
    instr.append(f"Arrive via {cs}")
    return {"type": "Feature", "properties": {"type": rtype, "time_mins": max(1, int(tl/80)), "exposure": round(te/tl,2) if tl>0 else 1, "color": color, "instructions": instr}, "geometry": {"type": "LineString", "coordinates": coords}}

@app.get("/route")
def route_api(start_lat: float, start_lon: float, end_lat: float, end_lon: float, time_offset: float = 0):
    if not G: return {"error": "Loading..."}
    Gw = get_weighted_graph(time_offset)
    try:
        o = ox.distance.nearest_nodes(Gw, start_lon, start_lat)
        d = ox.distance.nearest_nodes(Gw, end_lon, end_lat)
        fp = nx.shortest_path(Gw, o, d, weight='length')
        cp = nx.shortest_path(Gw, o, d, weight='weight')
        ff, cf = _build_gj(Gw, fp, 'fastest', '#f59e0b'), _build_gj(Gw, cp, 'coolest', '#0ea5e9')
        alt, az, uv = get_solar_pos(time_offset)
        w = get_weather(time_offset)
        fe, ce = ff['properties']['exposure'], cf['properties']['exposure']
        saved = int(max(0, (1-ce/fe)*100)) if fe > 0 else 0
        return {"features": [ff, cf], "weather": {"temp": w["temperature_2m"], "wind_speed": w["wind_speed_10m"], "wind_dir": w["wind_direction_10m"]}, "sun": {"alt": alt, "az": az}, "sunlight_saved": saved}
    except Exception as e:
        return {"error": str(e)}

@app.get("/sun_position")
def sun_api(hours_offset: float = 0):
    a, az, uv = get_solar_pos(hours_offset)
    return {"altitude": a, "azimuth": az, "uv_index": uv}

@app.get("/weather")
def weather_api(hours_offset: float = 0):
    w = get_weather(hours_offset)
    return {"temp": w["temperature_2m"], "wind_speed": w["wind_speed_10m"], "wind_dir": w["wind_direction_10m"]}

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

@app.get("/community_spots")
def spots_api():
    p = os.path.join(BASE_DIR, "community_spots.json")
    return json.load(open(p)) if os.path.exists(p) else {"type":"FeatureCollection","features":[]}

@app.post("/report_spot")
def report_api():
    return {"status": "ok"}

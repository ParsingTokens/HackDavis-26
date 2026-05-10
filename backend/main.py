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
import math

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class CommunitySpot(BaseModel):
    id: str = None
    lat: float
    lon: float
    type: str 
    street: str = "Unknown Street"
    date_added: str = None
    upvotes: int = 0

app = FastAPI(title="Canopy AI-Powered Thermal Navigation")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load graph and spatial data
G = None
trees_df = None
tree_sindex = None
ts = load.timescale()
planets = load('de421.bsp')
earth, sun = planets['earth'], planets['sun']
from skyfield.toposlib import wgs84
observer = earth + wgs84.latlon(38.5449, -121.7405)

def load_data():
    global G, trees_df, tree_sindex
    try:
        with open(os.path.join(BASE_DIR, "davis_graph.pkl"), "rb") as f:
            G = pickle.load(f)
        # Load trees for dynamic shade
        trees_df = gpd.read_file(os.path.join(BASE_DIR, "trees.geojson"))
        tree_sindex = STRtree(trees_df.geometry.values)
        print(f"Data loaded: {len(G.nodes)} nodes, {len(trees_df)} trees.")
    except Exception as e:
        print("Error loading data:", e)

load_data()

def get_solar_pos(hours_offset=0):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_offset)
    t = ts.from_datetime(dt)
    astrometric = observer.at(t).observe(sun)
    alt, az, _ = astrometric.apparent().altaz()
    
    # Simple UV calculation based on solar altitude
    # UV index is max ~11-12 at noon in summer.
    uv = 0
    if alt.degrees > 0:
        uv = max(0, 12 * math.sin(math.radians(alt.degrees)))
    
    return alt.degrees, az.degrees, round(uv, 1)

def get_shadow_offset(height, solar_alt, solar_az):
    if solar_alt <= 0: return 0, 0
    shadow_length = height / math.tan(math.radians(solar_alt))
    shadow_angle = math.radians((solar_az + 180) % 360)
    dx = shadow_length * math.sin(shadow_angle) * 0.000009
    dy = shadow_length * math.cos(shadow_angle) * 0.000009
    return dx, dy

# CACHE FOR WEIGHTED GRAPHS
graph_cache = {}

def get_weighted_graph(hours_offset=0):
    offset_key = round(hours_offset, 1)
    if offset_key in graph_cache:
        return graph_cache[offset_key]
    
    print(f"Calculating dynamic weights for offset {offset_key}...")
    alt, az, uv = get_solar_pos(hours_offset)
    is_night = alt <= 0
    
    G_copy = G.copy()
    for u, v, k, data in G_copy.edges(keys=True, data=True):
        length = data.get('length', 1.0)
        is_hall = data.get('is_hall', False)
        
        if is_night:
            data['weight'] = length
            data['exposure_ratio'] = 0
            continue
            
        if is_hall:
            data['weight'] = length * 0.05 # AC Bonus
            data['exposure_ratio'] = 0
            continue
            
        # Shade calculation (Optimized)
        geom = data.get('geometry')
        if not geom:
            geom = LineString([Point(G_copy.nodes[u]['x'], G_copy.nodes[u]['y']), Point(G_copy.nodes[v]['x'], G_copy.nodes[v]['y'])])
        
        # Buffer check for nearby trees
        nearby_indices = tree_sindex.query(geom.buffer(0.0003))
        if len(nearby_indices) == 0:
            data['exposure_ratio'] = 1.0
            data['weight'] = length * 21.0
            continue
            
        nearby_trees = trees_df.iloc[nearby_indices]
        shadow_polys = []
        for _, tree in nearby_trees.iterrows():
            h = tree.get('height_m', 8)
            dx, dy = get_shadow_offset(h, alt, az)
            canopy = tree.geometry.buffer(0.00005)
            from shapely.affinity import translate
            shadow = translate(canopy, xoff=dx, yoff=dy)
            shadow_polys.append(shadow.union(canopy).convex_hull)
            
        if shadow_polys:
            if len(shadow_polys) == 1:
                unified_shadow = shadow_polys[0]
            else:
                from shapely.ops import unary_union
                unified_shadow = unary_union(shadow_polys)
            shaded_part = geom.intersection(unified_shadow)
            exposure = 1.0 - (shaded_part.length / geom.length) if geom.length > 0 else 1.0
            data['exposure_ratio'] = max(0.0, min(1.0, exposure))
        else:
            data['exposure_ratio'] = 1.0
            
        heat_penalty = 20.0
        data['weight'] = length * (1 + (data['exposure_ratio'] * heat_penalty))
    
    graph_cache[offset_key] = G_copy
    return G_copy

def build_geojson_from_path(graph, path, route_type, color):
    lines = []
    total_length = 0
    total_exposure = 0
    for u, v in zip(path[:-1], path[1:]):
        edge_data = graph.get_edge_data(u, v)[0]
        geom = edge_data.get('geometry')
        if not geom:
            geom = LineString([Point(graph.nodes[u]['x'], graph.nodes[u]['y']), Point(graph.nodes[v]['x'], graph.nodes[v]['y'])])
        coords = list(geom.coords)
        if not lines: lines.extend(coords)
        else: lines.extend(coords[1:])
        length = edge_data.get('length', 0)
        total_length += length
        total_exposure += edge_data.get('exposure_ratio', 0) * length
    avg_exposure = total_exposure / total_length if total_length > 0 else 0
    time_mins = max(1, int(total_length / 80))
    instructions = []
    current_street = None
    distance_on_street = 0
    for u, v in zip(path[:-1], path[1:]):
        edge_data = graph.get_edge_data(u, v)[0]
        name = edge_data.get('name', 'Unknown Pathway')
        if isinstance(name, list): name = name[0]
        length = edge_data.get('length', 0)
        if name != current_street:
            if current_street is not None: instructions.append(f"Head along {current_street} for {int(distance_on_street)}m")
            current_street = name
            distance_on_street = length
        else: distance_on_street += length
    if current_street is not None: instructions.append(f"Head along {current_street} for {int(distance_on_street)}m")
    return {
        "type": "Feature",
        "properties": {
            "type": route_type, "time_mins": time_mins, "exposure_ratio": round(avg_exposure, 2), "color": color, "instructions": instructions
        },
        "geometry": {"type": "LineString", "coordinates": lines}
    }

@app.get("/route")
def get_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float, time_offset: float = 0):
    if G is None: return {"error": "Graph not loaded"}
    
    current_G = get_weighted_graph(time_offset)
    
    try:
        orig = ox.distance.nearest_nodes(current_G, start_lon, start_lat)
        dest = ox.distance.nearest_nodes(current_G, end_lon, end_lat)
    except Exception as e: return {"error": f"Nearest nodes failed: {e}"}
    
    try:
        fastest_path = nx.shortest_path(current_G, orig, dest, weight='length')
        fastest_feature = build_geojson_from_path(current_G, fastest_path, 'fastest', '#ffb74d')
    except: fastest_feature = None
    
    try:
        coolest_path = nx.shortest_path(current_G, orig, dest, weight='weight')
        coolest_feature = build_geojson_from_path(current_G, coolest_path, 'coolest', '#4dd0e1')
    except: coolest_feature = None
    
    sunlight_saved = 0
    if fastest_feature and coolest_feature:
        f_exp = fastest_feature['properties'].get('exposure_ratio', 1.0)
        c_exp = coolest_feature['properties'].get('exposure_ratio', 1.0)
        if f_exp > 0:
            sunlight_saved = int(max(0, (1.0 - (c_exp / f_exp)) * 100))
        elif c_exp == 0 and f_exp == 0:
            sunlight_saved = 0
    
    alt, az, uv = get_solar_pos(time_offset)
    
    return {
        "type": "FeatureCollection",
        "features": [f for f in [fastest_feature, coolest_feature] if f],
        "sunlight_saved": max(0, sunlight_saved),
        "uv_index": uv
    }

@app.get("/sun_position")
def get_sun_position(hours_offset: float = 0):
    alt, az, uv = get_solar_pos(hours_offset)
    return {"altitude": round(alt, 1), "azimuth": round(az, 1), "uv_index": uv}

@app.get("/trees")
def get_trees():
    try:
        with open(os.path.join(BASE_DIR, "trees.geojson"), "r") as f: return json.load(f)
    except: return {"type": "FeatureCollection", "features": []}

@app.get("/community_spots")
def get_community_spots():
    try:
        with open(os.path.join(BASE_DIR, "community_spots.json"), "r") as f: return json.load(f)
    except: return {"type": "FeatureCollection", "features": []}

@app.get("/buildings")
def get_buildings():
    try:
        # Buildings can be large, so we might want to simplify or limit in production
        with open(os.path.join(BASE_DIR, "buildings.geojson"), "r") as f: return json.load(f)
    except: return {"type": "FeatureCollection", "features": []}

@app.get("/pois")
def get_pois():
    try:
        with open(os.path.join(BASE_DIR, "ucd_pois.json"), "r") as f: return json.load(f)
    except: return []

@app.post("/report_spot")
def report_spot(spot: CommunitySpot):
    street_name = "Unknown Street"
    if G is not None:
        try:
            nearest_edge = ox.distance.nearest_edges(G, spot.lon, spot.lat)
            edge_data = G.get_edge_data(nearest_edge[0], nearest_edge[1])[0]
            street_name = edge_data.get('name', 'Unknown Street')
            if isinstance(street_name, list): street_name = street_name[0]
        except: pass
    spot_id = str(int(datetime.now().timestamp() * 1000))
    feature = {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [spot.lon, spot.lat]},
        "properties": {"id": spot_id, "type": spot.type, "street": street_name, "date_added": datetime.now().strftime("%Y-%m-%d %H:%M"), "upvotes": 0}
    }
    spots_data = {"type": "FeatureCollection", "features": []}
    if os.path.exists("community_spots.json"):
        with open("community_spots.json", "r") as f: spots_data = json.load(f)
    spots_data["features"].append(feature)
    with open("community_spots.json", "w") as f: json.dump(spots_data, f)
    return {"status": "success", "spot": feature}

@app.post("/upvote_spot")
def upvote_spot(spot_id: str):
    if not os.path.exists("community_spots.json"): return {"error": "No spots found"}
    with open("community_spots.json", "r") as f: data = json.load(f)
    for feature in data["features"]:
        if feature["properties"]["id"] == spot_id:
            feature["properties"]["upvotes"] += 1
            with open("community_spots.json", "w") as f: json.dump(data, f)
            return {"status": "success"}
    return {"error": "Spot not found"}

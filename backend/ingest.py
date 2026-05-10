import osmnx as ox
import networkx as nx
from skyfield.api import load
from datetime import datetime, timezone
import math
from shapely.geometry import Point, LineString, Polygon
import json
import pickle
import os
import geopandas as gpd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def build_routing_graph():
    places = ["Davis, California, USA", "University of California, Davis"]
    print(f"Fetching walk network for {places}...")
    G = ox.graph_from_place(places, network_type="walk")
    
    print("Fetching building footprints...")
    buildings = ox.features_from_place(places, tags={'building': True})
    buildings = buildings[buildings.geometry.type.isin(['Polygon', 'MultiPolygon'])]
    
    print("Saving buildings.geojson...")
    buildings.to_file(os.path.join(BASE_DIR, "buildings.geojson"), driver='GeoJSON')

    print("Tagging hall edges using spatial join...")
    edge_list = []
    for u, v, k, data in G.edges(keys=True, data=True):
        geom = data.get('geometry')
        if not geom:
            geom = LineString([Point(G.nodes[u]['x'], G.nodes[u]['y']), Point(G.nodes[v]['x'], G.nodes[v]['y'])])
        edge_list.append({'u': u, 'v': v, 'k': k, 'geometry': geom.centroid})
    
    edges_gdf = gpd.GeoDataFrame(edge_list, crs="EPSG:4326")
    halls = gpd.sjoin(edges_gdf, buildings, how='inner', predicate='within')
    hall_keys = set(zip(halls.u, halls.v, halls.k))
    
    for u, v, k, data in G.edges(keys=True, data=True):
        data['is_hall'] = (u, v, k) in hall_keys

    print("Saving graph...")
    with open(os.path.join(BASE_DIR, 'davis_graph.pkl'), 'wb') as f:
        pickle.dump(G, f)
    print("Done!")

if __name__ == "__main__":
    build_routing_graph()

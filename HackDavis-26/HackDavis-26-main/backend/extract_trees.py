import osmnx as ox
import json
from shapely.geometry import Point

print("Fetching trees for 3D rendering...")
trees = ox.features_from_place("Davis, California, USA", tags={'natural': 'tree'})
features = []
for idx, row in trees.iterrows():
    geom = row.geometry
    if isinstance(geom, Point):
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [geom.x, geom.y]
            },
            "properties": {"height": 8}
        })

collection = {"type": "FeatureCollection", "features": features}
with open("trees.geojson", "w") as f:
    json.dump(collection, f)
print("Trees saved.")

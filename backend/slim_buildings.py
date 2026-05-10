"""
Slim down the buildings GeoJSON to only the fields needed for 3D rendering.
This reduces the file from ~41MB to <3MB.
"""
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(BASE_DIR, "buildings.geojson")
dst = os.path.join(BASE_DIR, "buildings_slim.geojson")

print("Loading buildings.geojson...")
with open(src, encoding="utf-8") as f:
    data = json.load(f)

print(f"Total features: {len(data['features'])}")

slim_features = []
for feat in data["features"]:
    props = feat.get("properties", {}) or {}
    geom = feat.get("geometry")
    if not geom:
        continue

    # Determine elevation
    height = None
    if props.get("height"):
        try:
            height = float(props["height"])
        except (ValueError, TypeError):
            pass
    if height is None and props.get("building:levels"):
        try:
            height = float(props["building:levels"]) * 3.5
        except (ValueError, TypeError):
            pass
    if height is None:
        height = 10.0  # default height for all buildings

    slim_features.append({
        "type": "Feature",
        "geometry": geom,
        "properties": {
            "height": height,
            "name": props.get("name", ""),
            "building": props.get("building", "yes")
        }
    })

slim = {"type": "FeatureCollection", "features": slim_features}

print(f"Slim features: {len(slim_features)}")
with open(dst, "w", encoding="utf-8") as f:
    json.dump(slim, f, separators=(",", ":"))

size_mb = os.path.getsize(dst) / (1024 * 1024)
print(f"Saved to buildings_slim.geojson — {size_mb:.1f} MB")

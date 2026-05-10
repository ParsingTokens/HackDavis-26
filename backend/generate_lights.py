import json
import random

# Core campus bounds for lighting simulation based on the map
# Approx: 38.535 to 38.545, -121.755 to -121.740
lights = []

# Main roads (Russell Blvd, B St, etc.) - High density
for lat in [38.544, 38.541, 38.538]:
    for lon in [x/10000 for x in range(-121755, -121735, 2)]:
        lights.append({"lat": lat, "lon": lon, "type": "street"})

# Pathway lights (The Quad, MU, Silo, Health Stadium)
# The map shows high density in these pedestrian areas
pedestrian_areas = [
    (38.5415, -121.7495), # Quad
    (38.5425, -121.7505), # MU
    (38.5400, -121.7525), # Silo
    (38.5385, -121.7515), # Science Lab
]

for area_lat, area_lon in pedestrian_areas:
    for _ in range(30):
        lat = area_lat + (random.random() - 0.5) * 0.003
        lon = area_lon + (random.random() - 0.5) * 0.003
        lights.append({"lat": lat, "lon": lon, "type": "pathway"})

# Random distribution for the rest of campus
for _ in range(800):
    lat = 38.534 + random.random() * 0.015
    lon = -121.760 + random.random() * 0.025
    lights.append({"lat": lat, "lon": lon, "type": "street"})

geojson = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [l['lon'], l['lat']]},
            "properties": {"type": l['type']}
        } for l in lights
    ]
}

with open("c:/Users/parwa/Canopy/backend/lights.geojson", "w") as f:
    json.dump(geojson, f)

print(f"Generated {len(lights)} lights for UC Davis campus simulation.")

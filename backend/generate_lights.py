"""
Generate UC Davis campus lamppost locations by cross-referencing
the Davis Lighting Map with known campus road/pathway geometry.

Key observations from the lighting map image:
- Russell Blvd (north boundary): DENSE yellow street lights, ~30m spacing
- MU Bus Stop area: cluster of pathway lights
- MU Quad: ring of pathway lights around the quad
- Silo Bus Stop area: pathway lights
- Internal bike paths: purple pathway lights
- Hutchison Drive: street lights along the campus east-west road
- California Ave / La Rue Rd: north-south campus arteries with lights
- Howard Way (MU to Russell): pathway lights
- Shields Library area: pathway lights
- South campus (Health Stadium, ARC): sparse lights
- Campus perimeter (A St, 1st St): street lights
"""
import json
import math

lights = []

def add_road_lights(start_lat, start_lon, end_lat, end_lon, spacing_m=30, light_type="street"):
    """Place lights along a road segment at given spacing."""
    dlat = end_lat - start_lat
    dlon = end_lon - start_lon
    dist_m = math.sqrt((dlat * 111000)**2 + (dlon * 85000)**2)
    n = max(2, int(dist_m / spacing_m))
    for i in range(n + 1):
        t = i / n
        lat = start_lat + dlat * t
        lon = start_lon + dlon * t
        lights.append({"lat": lat, "lon": lon, "type": light_type})

def add_cluster(center_lat, center_lon, count=12, radius_deg=0.0008, light_type="pathway"):
    """Place a cluster of lights around a point."""
    for i in range(count):
        angle = (2 * math.pi * i) / count
        r = radius_deg * (0.6 + 0.4 * ((i * 7 + 3) % 5) / 4)
        lat = center_lat + r * math.cos(angle)
        lon = center_lon + r * math.sin(angle) * 1.3
        lights.append({"lat": lat, "lon": lon, "type": light_type})

# ============================================================
# RUSSELL BLVD — Dense street lights along north campus boundary
# Runs east-west from ~-121.762 to -121.745 at lat ~38.5435
# ============================================================
add_road_lights(38.5435, -121.7620, 38.5435, -121.7450, spacing_m=25, light_type="street")

# ============================================================
# HUTCHISON DRIVE — Major east-west road through campus center
# From west campus (~-121.758) to east (~-121.745), lat ~38.5385
# ============================================================
add_road_lights(38.5388, -121.7580, 38.5388, -121.7445, spacing_m=30, light_type="street")

# ============================================================
# LA RUE ROAD — North-south through campus center
# From Russell (~38.5435) south to Hutchison (~38.538)
# ============================================================
add_road_lights(38.5435, -121.7510, 38.5380, -121.7510, spacing_m=25, light_type="street")

# ============================================================
# CALIFORNIA AVE — North-south on west side of campus
# From Russell south past Silo area
# ============================================================
add_road_lights(38.5435, -121.7540, 38.5370, -121.7540, spacing_m=30, light_type="street")

# ============================================================
# A STREET — West campus perimeter (north-south)
# ============================================================
add_road_lights(38.5435, -121.7570, 38.5350, -121.7570, spacing_m=35, light_type="street")

# ============================================================
# 1ST STREET / campus east edge — north-south
# ============================================================
add_road_lights(38.5440, -121.7450, 38.5360, -121.7450, spacing_m=30, light_type="street")

# ============================================================
# HOWARD WAY — MU area north to Russell Blvd (pedestrian)
# Roughly -121.7495, from 38.5435 south to 38.5415
# ============================================================
add_road_lights(38.5435, -121.7495, 38.5410, -121.7495, spacing_m=15, light_type="pathway")

# ============================================================
# QUAD LOOP — Ring of pathway lights around the MU Quad
# Center approx 38.5413, -121.7485
# ============================================================
add_cluster(38.5413, -121.7485, count=20, radius_deg=0.0010, light_type="pathway")

# ============================================================
# MU BUS STOP AREA — Cluster near 38.5425, -121.7505
# ============================================================
add_cluster(38.5425, -121.7505, count=10, radius_deg=0.0005, light_type="pathway")

# ============================================================
# SILO BUS STOP / SILO AREA — 38.5395, -121.7525
# ============================================================
add_cluster(38.5395, -121.7525, count=14, radius_deg=0.0008, light_type="pathway")

# ============================================================
# SHIELDS LIBRARY — Pathway lights around 38.5396, -121.7495
# ============================================================
add_cluster(38.5396, -121.7495, count=16, radius_deg=0.0007, light_type="pathway")

# ============================================================
# WELLMAN HALL area — 38.5419, -121.7518
# ============================================================
add_cluster(38.5419, -121.7518, count=8, radius_deg=0.0004, light_type="pathway")

# ============================================================
# SCIENCE LABS / CHEMISTRY — 38.5405, -121.7530
# ============================================================
add_cluster(38.5405, -121.7535, count=10, radius_deg=0.0006, light_type="pathway")

# ============================================================
# OLSON / SOCIAL SCIENCES — East campus, 38.5398, -121.7465
# ============================================================
add_cluster(38.5398, -121.7465, count=12, radius_deg=0.0007, light_type="pathway")

# ============================================================
# KEMPER / ENGINEERING — South campus, 38.5368, -121.7520
# ============================================================
add_cluster(38.5368, -121.7520, count=10, radius_deg=0.0006, light_type="pathway")

# ============================================================
# ARC / ACTIVITIES REC CENTER — East, 38.5423, -121.7425
# ============================================================
add_cluster(38.5423, -121.7425, count=8, radius_deg=0.0005, light_type="pathway")

# ============================================================
# UC DAVIS HEALTH STADIUM — Southwest, 38.5358, -121.7555
# ============================================================
add_cluster(38.5358, -121.7555, count=10, radius_deg=0.0008, light_type="street")

# ============================================================
# INTERNAL BIKE PATHS — Purple pathway lights from the map
# These trace diagonals and connections between buildings
# ============================================================

# Diagonal: MU area to Shields Library (NW to SE)
add_road_lights(38.5420, -121.7500, 38.5396, -121.7495, spacing_m=20, light_type="pathway")

# Diagonal: Shields to Engineering (N to S)
add_road_lights(38.5396, -121.7500, 38.5370, -121.7520, spacing_m=20, light_type="pathway")

# Path: Silo to Shields (W to E)
add_road_lights(38.5395, -121.7530, 38.5396, -121.7495, spacing_m=18, light_type="pathway")

# Path: MU Quad east to Olson Hall area
add_road_lights(38.5412, -121.7480, 38.5400, -121.7460, spacing_m=18, light_type="pathway")

# Path: West campus (A St) to Silo area
add_road_lights(38.5400, -121.7565, 38.5395, -121.7530, spacing_m=25, light_type="pathway")

# Path: Russell Blvd south to Wellman (through campus core)
add_road_lights(38.5435, -121.7520, 38.5415, -121.7520, spacing_m=15, light_type="pathway")

# Path: South perimeter (Hutchison area east)
add_road_lights(38.5385, -121.7500, 38.5385, -121.7450, spacing_m=25, light_type="pathway")

# Path: ARC to east campus buildings
add_road_lights(38.5420, -121.7430, 38.5395, -121.7445, spacing_m=22, light_type="pathway")

# ============================================================
# Additional scattered pathway lights in darker campus zones
# Based on the map showing sparse lights in these areas
# ============================================================
# West campus agricultural area — very few lights
add_cluster(38.5380, -121.7580, count=4, radius_deg=0.0010, light_type="pathway")
# North of Hutchison, south of Quad
add_cluster(38.5403, -121.7505, count=6, radius_deg=0.0005, light_type="pathway")

# ============================================================
# Build GeoJSON
# ============================================================
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

with open("lights.geojson", "w") as f:
    json.dump(geojson, f)

print(f"Generated {len(lights)} campus lampposts")
print(f"  Street lights: {sum(1 for l in lights if l['type'] == 'street')}")
print(f"  Pathway lights: {sum(1 for l in lights if l['type'] == 'pathway')}")

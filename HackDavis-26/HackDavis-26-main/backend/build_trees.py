import pandas as pd
import requests
import json
import urllib3
import time
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def fetch_geometries():
    csv_path = "c:/Users/parwa/Canopy/UC_Davis_Public_Tree_Database.csv"
    print(f"Reading CSV from {csv_path}...")
    df = pd.read_csv(csv_path)
    object_ids = df['OBJECTID'].tolist()
    
    # Use FeatureServer which provides geometry
    url = "https://gis.ucdavis.edu/server/rest/services/UC_Davis_Tree_Database_2020B/FeatureServer/0/query"
    
    features = []
    chunk_size = 500
    
    print(f"Fetching geometry for {len(object_ids)} trees in chunks of {chunk_size}...")
    
    for i in range(0, len(object_ids), chunk_size):
        chunk = object_ids[i:i+chunk_size]
        ids_str = ",".join(map(str, chunk))
        params = {
            "where": f"OBJECTID IN ({ids_str})",
            "outFields": "OBJECTID",
            "outSR": "4326",
            "f": "geojson",
            "returnGeometry": "true"
        }
        try:
            r = requests.get(url, params=params, verify=False, timeout=10)
            data = r.json()
            feats = data.get('features', [])
            features.extend(feats)
            if i % 2500 == 0:
                print(f"Fetched {len(features)} features so far...")
        except Exception as e:
            print(f"Failed chunk {i}", e)
        time.sleep(0.05)
        
    print(f"Total features fetched: {len(features)}")
    
    geom_map = {}
    for f in features:
        props = f.get('properties', {})
        # ArcGIS properties often have varying case
        obj_id = props.get('OBJECTID')
        if obj_id is None:
            obj_id = props.get('objectid')
        if obj_id is None:
            obj_id = props.get('ObjectID')
            
        if obj_id is not None:
            geom_map[int(obj_id)] = f.get('geometry')
        
    print(f"Geometry map size: {len(geom_map)}")
    
    final_features = []
    for _, row in df.iterrows():
        obj_id = int(row['OBJECTID'])
        geom = geom_map.get(obj_id)
        if geom:
            height_str = str(row['Height_ft'])
            height_m = 5
            if "16 - 33" in height_str: height_m = 7
            elif "34 - 50" in height_str: height_m = 12
            elif "51 - 66" in height_str: height_m = 18
            elif "> 66" in height_str: height_m = 25
            
            final_features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "species": str(row['SpecificEpithet']),
                    "common": str(row['CommonName']),
                    "height_m": height_m
                }
            })
            
    geojson = {"type": "FeatureCollection", "features": final_features}
    with open("trees.geojson", "w") as f:
        json.dump(geojson, f)
    print(f"Successfully saved {len(final_features)} fully attributed trees to trees.geojson!")

if __name__ == "__main__":
    fetch_geometries()

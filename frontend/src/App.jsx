import React, { useState, useEffect, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, IconLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';

const INITIAL_VIEW_STATE = {
  longitude: -121.7490,
  latitude: 38.5410,
  zoom: 16.5,
  pitch: 45,
  bearing: 0
};

const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const TREE_COLORS = {
  'Oak': [34, 100, 34],
  'Pine': [20, 80, 20],
  'Maple': [180, 160, 40],
  'Cedar': [60, 90, 50],
  'Palm': [120, 200, 100],
  'default': [80, 160, 80]
};

const getTreeColor = (name) => {
  if (!name) return TREE_COLORS.default;
  for (const key in TREE_COLORS) {
    if (name.toLowerCase().includes(key.toLowerCase())) return TREE_COLORS[key];
  }
  return TREE_COLORS.default;
};

const generateSquigglyRays = (sunAzimuth) => {
  const rays = [];
  for (let i = 0; i < 1200; i++) {
    // Coverage for entire Davis area
    const lat = 38.52 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.07;
    const path = [];
    const segments = 12;
    let currZ = 250 + Math.random() * 200;
    let currLon = lon;
    let currLat = lat;
    for (let j = 0; j < segments; j++) {
      path.push([currLon, currLat, currZ]);
      currZ -= 30;
      currLon += 0.00015 + (Math.random() - 0.5) * 0.0003;
      currLat -= 0.00015 + (Math.random() - 0.5) * 0.0003;
    }
    const startOffset = Math.random() * 8000;
    const timestamps = path.map((_, idx) => startOffset + (idx * 600));
    rays.push({ path, timestamps });
  }
  return rays;
};

const TREE_ICON_SVG = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="35" r="30" fill="#2e7d32"/><circle cx="35" cy="55" r="25" fill="#388e3c"/><circle cx="65" cy="55" r="25" fill="#43a047"/><rect x="44" y="70" width="12" height="25" fill="#5d4037"/></svg>')}`;

function SearchInput({ placeholder, value, onChange, onSelect }) {
  const [results, setResults] = useState([]);
  const [pois, setPois] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  useEffect(() => {
    fetch('http://localhost:8000/pois').then(res => res.json()).then(data => setPois(Array.isArray(data) ? data : [])).catch(e => setPois([]));
  }, []);
  useEffect(() => {
    if (value.length > 1 && showDropdown) {
      const localMatches = pois.filter(p => p.name.toLowerCase().includes(value.toLowerCase()));
      const delayDebounceFn = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${value}, Davis, CA`)
          .then(res => res.json())
          .then(data => {
            const apiResults = data.map(r => ({ name: r.display_name.split(',')[0], lat: parseFloat(r.lat), lon: parseFloat(r.lon) }));
            setResults([...localMatches, ...apiResults].slice(0, 5));
          })
          .catch(e => setResults(localMatches));
      }, 500);
      return () => clearTimeout(delayDebounceFn);
    } else if (showDropdown) {
      setResults(pois.slice(0, 5));
    }
  }, [value, showDropdown, pois]);
  return (
    <div className="search-input-wrapper">
      <span>📍</span>
      <input type="text" placeholder={placeholder} value={value} onFocus={() => setShowDropdown(true)} onChange={(e) => { onChange(e.target.value); setShowDropdown(true); }} />
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item" onClick={() => { onChange(r.name); onSelect(r.lat, r.lon); setShowDropdown(false); }}>{r.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [uiState, setUiState] = useState('search');
  const [theme, setTheme] = useState('dark');
  const [activeTab, setActiveTab] = useState('current');
  const [timeOffset, setTimeOffset] = useState(0);
  
  const [startQuery, setStartQuery] = useState('');
  const [startCoords, setStartCoords] = useState(null);
  const [endQuery, setEndQuery] = useState('');
  const [endCoords, setEndCoords] = useState(null);
  
  const [routeData, setRouteData] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [activeRoute, setActiveRoute] = useState('coolest');
  
  const [treesData, setTreesData] = useState(null);
  const [buildingsData, setBuildingsData] = useState(null);
  const [communitySpots, setCommunitySpots] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sunPosition, setSunPosition] = useState({ altitude: 63, azimuth: 222, uv_index: 0 });
  const [raysData, setRaysData] = useState([]);
  const [time, setTime] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState(null);
  const [isReporting, setIsReporting] = useState(false);
  const [reportType, setReportType] = useState('shade');

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(res => res.json()).then(data => setTreesData(data));
    fetch('http://localhost:8000/buildings').then(res => res.json()).then(data => setBuildingsData(data));
    loadCommunitySpots();
    fetch('https://api.open-meteo.com/v1/forecast?latitude=38.5449&longitude=-121.7405&current=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit').then(res => res.json()).then(data => setWeather(data.current));
    updateSunPosition();
    const animate = () => { setTime(t => (t + 15) % 8000); requestAnimationFrame(animate); };
    const reqId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(reqId);
  }, []);

  const updateSunPosition = (offset = 0) => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${offset}`)
      .then(res => res.json())
      .then(data => {
         setSunPosition(data);
         setRaysData(generateSquigglyRays(data.azimuth));
      });
  };

  const handleTimeChange = (e) => {
    const val = parseInt(e.target.value);
    setTimeOffset(val);
    updateSunPosition(val);
  };

  const loadCommunitySpots = () => {
    fetch('http://localhost:8000/community_spots').then(res => res.json()).then(data => setCommunitySpots(data));
  };

  const handleSearch = () => {
    if (!startCoords || !endCoords) return;
    setRouteData(null);
    setRouteError(null);
    setRouteLoading(true);
    setUiState('preview');
    fetch(`http://localhost:8000/route?start_lat=${startCoords.lat}&start_lon=${startCoords.lon}&end_lat=${endCoords.lat}&end_lon=${endCoords.lon}&time_offset=${timeOffset}`)
      .then(res => res.json())
      .then(data => {
        setRouteLoading(false);
        if (data.error) {
          setRouteError(data.error);
        } else if (!data.features || data.features.length === 0) {
          setRouteError('No route found between those locations.');
        } else {
          setRouteData(data);
          setActiveRoute('coolest');
        }
      })
      .catch(err => {
        setRouteLoading(false);
        setRouteError(`Connection error: ${err.message}`);
      });
  };

  const layers = [];

  // --- 3D BUILDINGS (rendered first so routes appear on top) ---
  if (buildingsData?.features) {
    layers.push(new GeoJsonLayer({
      id: 'buildings-3d',
      data: buildingsData,
      extruded: true,
      wireframe: false,
      getElevation: d => {
        const h = d.properties?.height;
        if (h && !isNaN(h)) return parseFloat(h);
        if (d.properties?.['building:levels']) return parseInt(d.properties['building:levels']) * 3.5;
        return 10;
      },
      getFillColor: theme === 'dark'
        ? [45, 55, 72, 200]
        : [230, 228, 220, 200],
      getLineColor: theme === 'dark'
        ? [80, 100, 130, 160]
        : [180, 175, 165, 200],
      lineWidthMinPixels: 1,
      pickable: false,
      material: {
        ambient: 0.35,
        diffuse: 0.6,
        shininess: 16,
        specularColor: [60, 64, 70]
      }
    }));
  }

  // --- ROUTE LAYERS (rendered after buildings so they appear on top) ---
  if (routeData?.features && (uiState === 'preview' || uiState === 'nav')) {
    routeData.features.forEach(feature => {
      const isSelected = activeRoute === feature.properties.type;
      const isNav = uiState === 'nav';
      
      if (isNav && !isSelected) return;

      // Glow layer underneath
      layers.push(new GeoJsonLayer({
        id: `route-glow-${feature.properties.type}`,
        data: feature,
        lineWidthUnits: 'pixels',
        getLineColor: feature.properties.type === 'coolest'
          ? [0, 255, 255, isSelected ? 50 : 20]
          : [255, 140, 0, isSelected ? 50 : 20],
        getLineWidth: isSelected ? 28 : 14,
        pickable: false,
        parameters: { depthTest: false }
      }));

      // Main line
      layers.push(new GeoJsonLayer({
        id: `route-layer-${feature.properties.type}`,
        data: feature,
        lineWidthUnits: 'pixels',
        getLineColor: feature.properties.type === 'coolest'
          ? [0, 230, 255, isSelected ? 255 : 140]
          : [255, 140, 0, isSelected ? 255 : 140],
        getLineWidth: isSelected ? 10 : 5,
        pickable: true,
        parameters: { depthTest: false },
        updateTriggers: {
          getLineColor: [activeRoute],
          getLineWidth: [activeRoute]
        }
      }));
    });
  }
  
  if (treesData?.features) {
    // Tree Trunks
    layers.push(new ColumnLayer({
      id: 'tree-trunks',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: [60, 40, 20, 255],
      radius: 0.25,
      extruded: true,
      getElevation: 3,
      pickable: false
    }));

    // Tree Canopy - Bottom Tier
    layers.push(new ColumnLayer({
      id: 'tree-canopy-bottom',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: d => [...getTreeColor(d.properties.common), 180],
      radius: 3.5,
      diskResolution: 12,
      extruded: true,
      getElevation: d => (d.properties.height_m || 8) * 0.7,
      pickable: true
    }));

    // Tree Canopy - Top Tier (creates a tapered/pointed look)
    layers.push(new ColumnLayer({
      id: 'tree-canopy-top',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: d => [...getTreeColor(d.properties.common), 220],
      radius: 1.8,
      diskResolution: 12,
      extruded: true,
      getElevation: d => d.properties.height_m || 8,
      pickable: false
    }));
  }

  // (buildings layer is rendered early above - this block intentionally removed)
  if (communitySpots?.features) {
    layers.push(new IconLayer({
      id: 'community-spots',
      data: communitySpots.features,
      pickable: true,
      iconAtlas: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/icon-atlas.png',
      iconMapping: { marker: {x: 0, y: 0, width: 128, height: 128, anchorY: 128, mask: true} },
      getIcon: d => 'marker',
      sizeScale: 12,
      getPosition: d => d.geometry.coordinates,
      getColor: d => d.properties.type === 'shade' ? [33, 150, 243] : [255, 193, 7],
    }));
  }
  if (sunPosition.altitude > 0) {
    layers.push(new TripsLayer({
      id: 'sun-rays',
      data: raysData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: [255, 235, 59, 80], 
      opacity: 0.3,
      widthMinPixels: 2,
      trailLength: 2000,
      currentTime: time
    }));
  }

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Canopy</h1>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="theme-toggle">
            {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
        </div>
        
        <div className="tab-container">
          <button className={`tab-btn ${activeTab === 'current' ? 'active' : ''}`} onClick={() => { setActiveTab('current'); setTimeOffset(0); updateSunPosition(0); }}>Real-time</button>
          <button className={`tab-btn ${activeTab === 'future' ? 'active' : ''}`} onClick={() => setActiveTab('future')}>Future Paths</button>
        </div>

        <div className="sidebar-content">
          {activeTab === 'future' && (
            <div className="future-control">
              <label>Time Prediction: +{timeOffset}h</label>
              <input type="range" min="0" max="12" step="1" value={timeOffset} onChange={handleTimeChange} className="time-slider" />
              <div className="prediction-info">
                <span>{sunPosition.altitude > 0 ? "☀️ Sun Predicted" : "🌙 Night Predicted"}</span>
              </div>
            </div>
          )}

          {uiState === 'search' && (
            <>
              <h3>Where to?</h3>
              <SearchInput placeholder="Start Location" value={startQuery} onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({lat, lon})} />
              <SearchInput placeholder="Destination" value={endQuery} onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({lat, lon})} />
              <button className="action-btn" onClick={handleSearch} style={{marginTop: 10}}>Calculate Routes</button>
            </>
          )}

          {uiState === 'preview' && (
            <>
              <div className="route-selection">
                <h3>{routeLoading ? 'Calculating routes...' : routeError ? 'Route Error' : 'Routes found'}</h3>
                {routeError && <div style={{color:'#ff6b6b',fontSize:'0.85rem',margin:'8px 0'}}>{routeError}</div>}
                {routeLoading && <div style={{textAlign:'center',padding:'20px',opacity:0.7}}>⏳ Finding best paths...</div>}
                {!routeLoading && !routeError && routeData && (
                  <>
                    <div className={`route-card ${activeRoute === 'coolest' ? 'active' : ''}`} onClick={() => setActiveRoute('coolest')}>
                      <div className="header">
                        <span>{sunPosition.altitude > 0 ? "Coolest Path ❄️" : "Standard Path 👣"}</span>
                        {routeData?.sunlight_saved > 0 && sunPosition.altitude > 0 && (
                          <span className="badge">☀️ -{routeData.sunlight_saved}% sun</span>
                        )}
                      </div>
                      <div className="time">
                        {routeData.features.find(f => f.properties.type === 'coolest')?.properties?.time_mins ?? '?'} min
                      </div>
                      <div className="subtext">{sunPosition.altitude > 0 ? "Includes AC Hallways & Shade" : "Optimal night path"}</div>
                      {routeData?.uv_index > 0 && <div className="uv-info">UV Index: {routeData.uv_index}</div>}
                    </div>
                    <div className={`route-card ${activeRoute === 'fastest' ? 'active' : ''}`} onClick={() => setActiveRoute('fastest')}>
                      <div className="header"><span>Fastest Path 🔥</span></div>
                      <div className="time" style={{color: '#e65100'}}>
                        {routeData.features.find(f => f.properties.type === 'fastest')?.properties?.time_mins ?? '?'} min
                      </div>
                      <div className="subtext">Shortest physical distance</div>
                      {routeData?.uv_index > 8 && <div className="uv-warning">⚠️ High UV Exposure</div>}
                    </div>
                  </>
                )}
              </div>
              {!routeLoading && routeData && (
                <button className="action-btn" onClick={() => setUiState('nav')}>Start Navigation</button>
              )}
              <button className="action-btn secondary" onClick={() => setUiState('search')}>Back to Search</button>
            </>
          )}

          {uiState === 'nav' && (
            <>
              <div className="nav-header">
                <h3>Navigation</h3>
                <button className="action-btn secondary" onClick={() => setUiState('search')}>End Path</button>
              </div>
              <div className="instructions-list">
                {routeData?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, idx) => (
                  <div key={idx} className="instruction-item"><span className="icon">👣</span><span>{inst}</span></div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="map-container">
        <div className="community-panel">
          {isReporting ? (
            <div><p className="panel-msg">Click on map!</p><button className="action-btn danger" onClick={() => setIsReporting(false)}>Cancel</button></div>
          ) : (
            <div><p className="panel-title">Add Shade/Rest Spot</p>
              <select value={reportType} onChange={e => setReportType(e.target.value)} className="report-select"><option value="shade">Shade Spot</option><option value="resting">Resting Place</option></select>
              <button className="action-btn" onClick={() => setIsReporting(true)}>Drop Pin</button>
            </div>
          )}
        </div>

        {selectedSpot && (
          <div className="spot-popup">
            <div className="header"><h3>{selectedSpot.properties.type === 'shade' ? 'Cool Shade ❄️' : 'Resting Spot 🪑'}</h3><button onClick={() => setSelectedSpot(null)}>×</button></div>
            <div className="body">
              <p className="street">📍 {selectedSpot.properties.street || 'Near Pathway'}</p>
              <div className="footer"><span className="votes">{selectedSpot.properties.upvotes || 0} verifications</span><button className="verify-btn" onClick={(e) => { e.stopPropagation(); fetch(`http://localhost:8000/upvote_spot?spot_id=${selectedSpot.properties.id}`, { method: 'POST' }).then(() => loadCommunitySpots()); }}>👍 Verify</button></div>
            </div>
          </div>
        )}

        <div className="weather-container">
          <div className="weather-card"><span className="label">Conditions</span><span className="value">🌡️ {weather ? `${weather.temperature_2m}°F` : '--'}</span></div>
          <div className="weather-card"><span className="label">Solar Flux</span><span className="value">☀️ Alt: {sunPosition.altitude}° | UV: {sunPosition.uv_index}</span></div>
        </div>

        <DeckGL initialViewState={INITIAL_VIEW_STATE} controller={true} layers={layers} onClick={(info) => { if(isReporting && info.coordinate) { fetch('http://localhost:8000/report_spot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: info.coordinate[1], lon: info.coordinate[0], type: reportType }) }).then(() => { setIsReporting(false); loadCommunitySpots(); }); } else if(info.object && info.layer.id === 'community-spots') setSelectedSpot(info.object); else setSelectedSpot(null); }} getCursor={({isDragging}) => isReporting ? 'crosshair' : (isDragging ? 'grabbing' : 'grab')}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}
export default App;

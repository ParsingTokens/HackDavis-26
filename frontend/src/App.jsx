import React, { useState, useEffect, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, IconLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';

const INITIAL_VIEW_STATE = {
  longitude: -121.7495,
  latitude: 38.5397,
  zoom: 16,
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

const generateSquigglyRays = (sunAzimuth, sunAlt) => {
  const rays = [];
  const rayCount = 800;
  for (let i = 0; i < rayCount; i++) {
    const lat = 38.52 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.07;
    const path = [];
    const segments = 15;
    let currZ = 300 + Math.random() * 100;
    let currLon = lon;
    let currLat = lat;
    
    // Angle based on sun alt
    const dropRate = 25 * (sunAlt / 90 + 0.5);
    const driftX = 0.0001 * Math.sin(sunAzimuth * Math.PI / 180);
    const driftY = 0.0001 * Math.cos(sunAzimuth * Math.PI / 180);

    for (let j = 0; j < segments; j++) {
      path.push([currLon, currLat, currZ]);
      currZ -= dropRate;
      currLon += driftX + (Math.random() - 0.5) * 0.0001;
      currLat += driftY + (Math.random() - 0.5) * 0.0001;
    }
    const startOffset = Math.random() * 8000;
    const timestamps = path.map((_, idx) => startOffset + (idx * 500));
    rays.push({ path, timestamps });
  }
  return rays;
};

const generateWindRays = (windDir) => {
  const rays = [];
  const rayCount = 400;
  const angleRad = (windDir - 180) * Math.PI / 180;
  const dx = 0.0004 * Math.sin(angleRad);
  const dy = 0.0004 * Math.cos(angleRad);

  for (let i = 0; i < rayCount; i++) {
    const lat = 38.52 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.07;
    const path = [];
    const segments = 10;
    let currLon = lon;
    let currLat = lat;
    let currZ = 10 + Math.random() * 50;

    for (let j = 0; j < segments; j++) {
      path.push([currLon, currLat, currZ]);
      currLon += dx;
      currLat += dy;
    }
    const startOffset = Math.random() * 5000;
    const timestamps = path.map((_, idx) => startOffset + (idx * 300));
    rays.push({ path, timestamps });
  }
  return rays;
};

function SearchInput({ placeholder, value, onChange, onSelect, isDeparture = false }) {
  const [results, setResults] = useState([]);
  const [pois, setPois] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  
  useEffect(() => {
    fetch('http://localhost:8000/pois').then(res => res.json()).then(data => setPois(Array.isArray(data) ? data : [])).catch(e => setPois([]));
  }, []);

  const handleCurrentLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        onChange("Current Location");
        onSelect(latitude, longitude);
      });
    }
  };

  useEffect(() => {
    if (value.length > 1 && showDropdown && value !== "Current Location") {
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
      <input 
        type="text" 
        placeholder={placeholder} 
        value={value} 
        onFocus={() => setShowDropdown(true)} 
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        onChange={(e) => { 
          onChange(e.target.value); 
          if (!showDropdown) setShowDropdown(true); 
        }} 
      />
      {isDeparture && (
        <button className="current-loc-btn" onClick={handleCurrentLocation} title="Use Current Location">Nearby</button>
      )}
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item" onMouseDown={(e) => { 
              e.preventDefault(); // Prevent onBlur from firing before onClick
              onChange(r.name); 
              onSelect(r.lat, r.lon); 
              setShowDropdown(false); 
            }}>{r.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [uiState, setUiState] = useState('search');
  const [theme, setTheme] = useState('dark');
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
  const [windRays, setWindRays] = useState([]);
  const [time, setTime] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState(null);
  const [isReporting, setIsReporting] = useState(false);
  const [reportType, setReportType] = useState('shade');
  const [showThankYou, setShowThankYou] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(res => res.json()).then(data => setTreesData(data));
    fetch('http://localhost:8000/buildings').then(res => res.json()).then(data => setBuildingsData(data));
    loadCommunitySpots();
    fetch('http://localhost:8000/sun_position').then(res => res.json()).then(data => setSunPosition(data));
    
    const animate = () => { setTime(t => (t + 15) % 8000); requestAnimationFrame(animate); };
    const reqId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(reqId);
  }, []);

  useEffect(() => {
    updateEnvironment(timeOffset);
  }, [timeOffset]);

  const updateEnvironment = (offset) => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${offset}`)
      .then(res => res.json())
      .then(data => {
        setSunPosition(data);
        setRaysData(generateSquigglyRays(data.azimuth, data.altitude));
      });
    
    // Simulate fetching wind from backend based on the new logic
    // We'll just generate rays based on a simulated or fetched direction
    setWindRays(generateWindRays(225)); // Example SW wind
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
        if (data.error) setRouteError(data.error);
        else if (!data.features || data.features.length === 0) setRouteError('No route found.');
        else {
          setRouteData(data);
          setActiveRoute('coolest');
          setWeather({ temperature_2m: 85, wind: data.wind }); 
          // Update rays with real backend sun data
          setSunPosition({ altitude: data.uv_index > 0 ? 30 : -10, ...data }); // Use backend UV as proxy for alt if needed
          setWindRays(generateWindRays(data.wind.direction));
        }
      })
      .catch(err => {
        setRouteLoading(false);
        setRouteError(`Connection error: ${err.message}`);
      });
  };

  const handleSuggest = () => {
    setIsReporting(true);
  };

  const layers = [];

  // --- 3D BUILDINGS ---
  if (buildingsData?.features) {
    layers.push(new GeoJsonLayer({
      id: 'buildings-3d',
      data: buildingsData,
      extruded: true,
      wireframe: false,
      getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [30, 41, 59, 220] : [241, 245, 249, 220],
      getLineColor: [100, 116, 139, 50],
      pickable: true,
      material: { ambient: 0.4, diffuse: 0.6, shininess: 20 }
    }));
  }

  // --- TREES (PUFFY) ---
  if (treesData?.features) {
    // Trunks
    layers.push(new ColumnLayer({
      id: 'tree-trunks',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: [88, 64, 44],
      radius: 0.2,
      extruded: true,
      getElevation: 4
    }));

    // Puffy Canopy (Tier 1)
    layers.push(new ColumnLayer({
      id: 'tree-canopy-1',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: d => [...getTreeColor(d.properties.common), 140],
      radius: 4,
      diskResolution: 20,
      extruded: true,
      getElevation: d => (d.properties.height_m || 8) * 0.6,
      offset: [0, 0, 3],
      material: { ambient: 0.5, diffuse: 0.5 }
    }));

    // Puffy Canopy (Tier 2)
    layers.push(new ColumnLayer({
      id: 'tree-canopy-2',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: d => [...getTreeColor(d.properties.common), 180],
      radius: 3.2,
      diskResolution: 16,
      extruded: true,
      getElevation: d => (d.properties.height_m || 8) * 0.9,
      offset: [0, 0, 5]
    }));
  }

  // --- ROUTES ---
  if (routeData?.features && (uiState === 'preview' || uiState === 'nav')) {
    routeData.features.forEach(feature => {
      const isSelected = activeRoute === feature.properties.type;
      if (uiState === 'nav' && !isSelected) return;

      layers.push(new GeoJsonLayer({
        id: `route-layer-${feature.properties.type}`,
        data: feature,
        lineWidthUnits: 'pixels',
        getLineColor: feature.properties.type === 'coolest' ? [14, 165, 233, isSelected ? 255 : 100] : [245, 158, 11, isSelected ? 255 : 100],
        getLineWidth: isSelected ? 8 : 4,
        parameters: { depthTest: false }
      }));
    });
  }

  // --- RAYS (SUN & WIND) ---
  if (sunPosition.altitude > 0) {
    layers.push(new TripsLayer({
      id: 'sun-rays',
      data: raysData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: [255, 245, 158, 40],
      widthMinPixels: 1,
      trailLength: 2000,
      currentTime: time,
      parameters: { depthTest: false }
    }));
  }

  layers.push(new TripsLayer({
    id: 'wind-rays',
    data: windRays,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: [255, 255, 255, 80],
    widthMinPixels: 2,
    trailLength: 1500,
    currentTime: time,
    parameters: { depthTest: false }
  }));

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Canopy</h1>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="theme-toggle">
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>

        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="Start Location" value={startQuery} onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({lat, lon})} isDeparture={true} />
              <SearchInput placeholder="Destination" value={endQuery} onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({lat, lon})} />
            </div>
            {uiState === 'search' && (
              <button className="action-btn" onClick={handleSearch}>Plan Route</button>
            )}
          </div>

          {(uiState === 'preview' || uiState === 'nav') && (
            <div className="ui-section">
              <span className="section-title">Schedule</span>
              <div className="time-controls">
                <label style={{fontSize: '0.8rem', fontWeight: 600}}>Departure Time: {timeOffset === 0 ? "Now" : `+${timeOffset}h`}</label>
                <input type="range" min="0" max="12" step="0.25" value={timeOffset} onChange={(e) => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
              </div>
              
              {routeData?.recommendation && !routeData.recommendation.is_now && (
                <div className="recommendation-banner">
                  Optimization Tip: Leaving in {routeData.recommendation.offset_minutes} mins offers better thermal protection.
                </div>
              )}
            </div>
          )}

          {uiState === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Routes</span>
              {routeLoading ? <div>Calculating...</div> : routeError ? <div className="thank-you-msg" style={{color: 'red'}}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'coolest' ? "Coolest Path" : "Fastest Path"}</span>
                      {f.properties.type === 'coolest' && <span className="badge">Best Protection</span>}
                    </div>
                    <div className="time" style={{color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)'}}>{f.properties.time_mins} min</div>
                  </div>
                ))
              )}
              {!routeLoading && routeData && <button className="action-btn" onClick={() => setUiState('nav')}>Start Walk</button>}
              <button className="action-btn secondary" onClick={() => setUiState('search')}>Reset</button>
            </div>
          )}

          {uiState === 'nav' && (
            <div className="ui-section">
              <span className="section-title">Directions</span>
              <div className="instructions-list">
                {routeData?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, idx) => (
                  <div key={idx} className="instruction-item">{inst}</div>
                ))}
              </div>
              <button className="action-btn secondary" onClick={() => setUiState('search')}>End Session</button>
            </div>
          )}

          <div className="community-section">
            <h4>Community Contributions</h4>
            {showThankYou ? (
              <div className="thank-you-msg">Thank you! Your peers will review your suggestion soon.</div>
            ) : isReporting ? (
              <button className="suggest-btn" style={{borderColor: 'var(--danger)', color: 'var(--danger)'}} onClick={() => setIsReporting(false)}>Cancel Suggestion</button>
            ) : (
              <button className="suggest-btn" onClick={handleSuggest}>Suggest Shade/Rest Spot</button>
            )}
          </div>
        </div>
      </div>

      <div className="map-container">
        <div className="weather-container">
          <div className="weather-card">
            <span className="label">Temperature</span>
            <span className="value">{weather?.temperature_2m || 85}°F</span>
          </div>
          <div className="weather-card">
            <span className="label">Wind</span>
            <span className="value">{weather?.wind?.speed || 5} km/h {weather?.wind?.direction || 'SW'}</span>
          </div>
        </div>

        <DeckGL 
          initialViewState={INITIAL_VIEW_STATE} 
          controller={true} 
          layers={layers} 
          getCursor={({isDragging}) => isReporting ? 'crosshair' : (isDragging ? 'grabbing' : 'grab')}
          onClick={(info, event) => { 
            // If clicking a UI element or already processing, ignore
            if (event.target.closest('.sidebar') || event.target.closest('.weather-container')) return;

            if(isReporting && info.coordinate) { 
              fetch('http://localhost:8000/report_spot', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ lat: info.coordinate[1], lon: info.coordinate[0], type: reportType }) 
              }).then(() => { 
                setIsReporting(false); 
                setShowThankYou(true);
                loadCommunitySpots();
                setTimeout(() => setShowThankYou(false), 5000);
              }); 
            } else if(info.object && info.layer.id === 'community-spots') setSelectedSpot(info.object); 
            else setSelectedSpot(null); 
          }}
        >
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}

export default App;

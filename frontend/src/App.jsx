import React, { useState, useEffect, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, IconLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport } from '@deck.gl/core';

const INITIAL_VIEW_STATE = {
  longitude: -121.7495,
  latitude: 38.5397,
  zoom: 16.2,
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
  const rayCount = 400; 
  const clampedAlt = Math.max(0, sunAlt);
  if (clampedAlt === 0) return [];

  for (let i = 0; i < rayCount; i++) {
    const lat = 38.52 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.07;
    const path = [];
    const segments = 12;
    let currZ = 250 + Math.random() * 150;
    let currLon = lon;
    let currLat = lat;
    
    const dropRate = 20 * (clampedAlt / 90 + 0.8);
    const driftX = 0.0002 * Math.sin(sunAzimuth * Math.PI / 180);
    const driftY = 0.0002 * Math.cos(sunAzimuth * Math.PI / 180);

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
  const rayCount = 200;
  const angleRad = (windDir - 180) * Math.PI / 180;
  const dx = 0.0006 * Math.sin(angleRad);
  const dy = 0.0006 * Math.cos(angleRad);

  for (let i = 0; i < rayCount; i++) {
    const lat = 38.50 + Math.random() * 0.1;
    const lon = -121.80 + Math.random() * 0.11;
    const path = [];
    const segments = 10;
    let currLon = lon;
    let currLat = lat;
    let currZ = 5 + Math.random() * 40;

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
        <button className="current-loc-btn" onClick={handleCurrentLocation}>Current</button>
      )}
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item" onMouseDown={(e) => { 
              e.preventDefault();
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
  const mapRef = useRef();
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
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
  const [showThankYou, setShowThankYou] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(res => res.json()).then(data => setTreesData(data)).catch(e => console.error(e));
    fetch('http://localhost:8000/buildings').then(res => res.json()).then(data => setBuildingsData(data)).catch(e => console.error(e));
    loadCommunitySpots();
    
    const animate = () => { setTime(t => (t + 15) % 8000); requestAnimationFrame(animate); };
    const reqId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(reqId);
  }, []);

  // Update theme based on sun altitude
  useEffect(() => {
    const isDay = sunPosition.altitude > 0;
    setTheme(isDay ? 'light' : 'dark');
  }, [sunPosition.altitude]);

  // Handle environment update on time slider change
  useEffect(() => {
    updateEnvironment(timeOffset);
    if (startCoords && endCoords && (uiState === 'preview' || uiState === 'nav')) {
       handleSearch();
    }
  }, [timeOffset]);

  const updateEnvironment = (offset) => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${offset}`)
      .then(res => res.json())
      .then(data => {
        setSunPosition(data);
        setRaysData(generateSquigglyRays(data.azimuth, data.altitude));
      })
      .catch(() => {
        setRaysData([]);
      });
    
    const currentWindDir = weather?.wind_direction_10m || 225;
    setWindRays(generateWindRays(currentWindDir));
  };

  const loadCommunitySpots = () => {
    fetch('http://localhost:8000/community_spots').then(res => res.json()).then(data => setCommunitySpots(data)).catch(e => console.error(e));
  };

  const handleSearch = () => {
    if (!startCoords || !endCoords) return;
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
          setWeather(data.weather);
          setWindRays(generateWindRays(data.weather.wind_direction_10m));
          
          // Fit bounds
          if (data.features.length > 0) {
            const allCoords = data.features.flatMap(f => f.geometry.coordinates);
            if (allCoords.length > 0) {
              const lons = allCoords.map(c => c[0]);
              const lats = allCoords.map(c => c[1]);
              const minLon = Math.min(...lons), maxLon = Math.max(...lons);
              const minLat = Math.min(...lats), maxLat = Math.max(...lats);
              
              setViewState(prev => ({
                ...prev,
                longitude: (minLon + maxLon) / 2,
                latitude: (minLat + maxLat) / 2,
                zoom: 15, // Simplified zoom for now
                transitionDuration: 1000
              }));
            }
          }
        }
      })
      .catch(err => {
        setRouteLoading(false);
        setRouteError(`Connection error: ${err.message}`);
      });
  };

  const layers = [];

  if (buildingsData?.features) {
    layers.push(new GeoJsonLayer({
      id: 'buildings-3d',
      data: buildingsData,
      extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [45, 55, 72, 220] : [230, 228, 220, 220],
      material: { ambient: 0.4, diffuse: 0.6, shininess: 15 }
    }));
  }

  if (treesData?.features) {
    layers.push(new ColumnLayer({
      id: 'tree-trunks',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: [88, 64, 44],
      radius: 0.2,
      extruded: true,
      getElevation: 4
    }));

    layers.push(new ColumnLayer({
      id: 'tree-canopy-puffy',
      data: treesData.features,
      getPosition: d => d.geometry.coordinates,
      getFillColor: d => [...getTreeColor(d.properties.common), 150],
      radius: 4.5,
      diskResolution: 12,
      extruded: true,
      getElevation: d => (d.properties.height_m || 8) * 0.7,
      offset: [0, 0, 4]
    }));
  }

  if (routeData?.features && (uiState === 'preview' || uiState === 'nav')) {
    routeData.features.forEach(feature => {
      const isSelected = activeRoute === feature.properties.type;
      if (uiState === 'nav' && !isSelected) return;

      layers.push(new GeoJsonLayer({
        id: `route-layer-${feature.properties.type}`,
        data: feature,
        lineWidthUnits: 'pixels',
        getLineColor: feature.properties.type === 'coolest' ? [14, 165, 233, isSelected ? 255 : 120] : [245, 158, 11, isSelected ? 255 : 120],
        getLineWidth: isSelected ? 12 : 6,
        parameters: { depthTest: false }
      }));
    });
  }

  if (sunPosition.altitude > 0) {
    layers.push(new TripsLayer({
      id: 'sun-rays',
      data: raysData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: [255, 255, 255, 25],
      widthMinPixels: 0.8,
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
    getColor: [255, 255, 255, 60],
    widthMinPixels: 1.5,
    trailLength: 1500,
    currentTime: time,
    parameters: { depthTest: false }
  }));

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Canopy</h1>
          <div className="theme-indicator" style={{fontSize: '0.8rem', fontWeight: 600, padding: '4px 8px', borderRadius: '4px', background: theme === 'dark' ? '#1e293b' : '#f1f5f9', color: theme === 'dark' ? '#cbd5e1' : '#475569'}}>
            {theme === 'dark' ? 'Night' : 'Day'}
          </div>
        </div>

        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Prediction Timeline</span>
            <div className="time-controls">
              <label style={{fontSize: '0.85rem', fontWeight: 700}}>
                {timeOffset === 0 ? "Starting ASAP" : `Leaving in +${timeOffset}h`}
              </label>
              <input type="range" min="0" max="24" step="1" value={timeOffset} onChange={(e) => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
              <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '4px'}}>
                <span>Now</span>
                <span>+12h</span>
                <span>+24h</span>
              </div>
            </div>
          </div>

          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From" value={startQuery} onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({lat, lon})} isDeparture={true} />
              <SearchInput placeholder="To" value={endQuery} onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({lat, lon})} />
            </div>
            {uiState === 'search' && (
              <button className="action-btn" onClick={handleSearch}>Find Routes</button>
            )}
          </div>

          {uiState === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Select Route</span>
              {routeLoading ? <div className="thank-you-msg">Calculating...</div> : routeError ? <div style={{color:'red', fontSize:'0.8rem'}}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'coolest' ? "Cooler" : "Efficient"}</span>
                      {f.properties.type === 'coolest' && <span className="badge">Optimal</span>}
                    </div>
                    <div className="time" style={{color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)'}}>{f.properties.time_mins} min</div>
                  </div>
                ))
              )}
              {routeData?.recommendation && !routeData.recommendation.is_now && (
                <div className="recommendation-banner">
                  Better conditions in {routeData.recommendation.offset_minutes} mins.
                </div>
              )}
              {!routeLoading && routeData && <button className="action-btn" onClick={() => setUiState('nav')}>Start Walking</button>}
              <button className="action-btn secondary" onClick={() => { setUiState('search'); setRouteData(null); }}>Reset</button>
            </div>
          )}

          {uiState === 'nav' && (
            <div className="ui-section">
              <span className="section-title">Instructions</span>
              <div className="instructions-list">
                {routeData?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, idx) => (
                  <div key={idx} className="instruction-item">{inst}</div>
                ))}
              </div>
              <button className="action-btn secondary" onClick={() => setUiState('search')}>End</button>
            </div>
          )}

          <div className="community-section">
            {showThankYou ? (
              <div className="thank-you-msg">Thank you for your suggestion!</div>
            ) : isReporting ? (
              <button className="suggest-btn" style={{color: 'var(--danger)'}} onClick={() => setIsReporting(false)}>Cancel</button>
            ) : (
              <button className="suggest-btn" onClick={() => setIsReporting(true)}>Suggest Shade Spot</button>
            )}
          </div>
        </div>
      </div>

      <div className="map-container">
        <div className="weather-container">
          <div className="weather-card">
            <span className="label">Temp</span>
            <span className="value">{weather?.temperature_2m || '--'}°F</span>
          </div>
          <div className="weather-card">
            <span className="label">Wind</span>
            <span className="value">{weather?.wind_speed_10m || '--'} km/h</span>
          </div>
        </div>

        <DeckGL 
          initialViewState={viewState}
          onViewStateChange={({viewState}) => setViewState(viewState)}
          controller={true} 
          layers={layers} 
          getCursor={({isDragging}) => isReporting ? 'crosshair' : (isDragging ? 'grabbing' : 'grab')}
          onClick={(info, event) => { 
            if (event.target.closest('.sidebar') || event.target.closest('.weather-container')) return;
            if(isReporting && info.coordinate) { 
              fetch('http://localhost:8000/report_spot', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ lat: info.coordinate[1], lon: info.coordinate[0], type: 'shade' }) 
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
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} ref={mapRef} />
        </DeckGL>
      </div>
    </>
  );
}

export default App;

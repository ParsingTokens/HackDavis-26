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
  bearing: 0,
  transitionDuration: 1000
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

const formatTime = (offset) => {
  const dt = new Date();
  dt.setMinutes(dt.getMinutes() + (offset * 60));
  return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const generateSquigglyRays = (sunAzimuth, sunAlt) => {
  const rays = [];
  const rayCount = 400; 
  if (sunAlt <= 0) return []; 
  
  for (let i = 0; i < rayCount; i++) {
    const lat = 38.52 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.07;
    const path = [];
    const segments = 12;
    let currZ = 200 + Math.random() * 150;
    let currLon = lon;
    let currLat = lat;
    
    const dropRate = 20 * (sunAlt / 90 + 0.5);
    const driftX = 0.00015 * Math.sin(sunAzimuth * Math.PI / 180);
    const driftY = 0.00015 * Math.cos(sunAzimuth * Math.PI / 180);

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
  const dx = 0.0005 * Math.sin(angleRad);
  const dy = 0.0005 * Math.cos(angleRad);

  for (let i = 0; i < rayCount; i++) {
    const lat = 38.51 + Math.random() * 0.08;
    const lon = -121.79 + Math.random() * 0.09;
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
      <input type="text" placeholder={placeholder} value={value} onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 200)} onChange={(e) => { onChange(e.target.value); if (!showDropdown) setShowDropdown(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={handleCurrentLocation}>Nearby</button>}
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item" onMouseDown={(e) => { e.preventDefault(); onChange(r.name); onSelect(r.lat, r.lon); setShowDropdown(false); }}>{r.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
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
  const [sunPosition, setSunPosition] = useState({ altitude: -20, azimuth: 0, uv_index: 0 });
  const [raysData, setRaysData] = useState([]);
  const [windRays, setWindRays] = useState([]);
  const [time, setTime] = useState(0);
  const [isReporting, setIsReporting] = useState(false);
  const [showThankYou, setShowThankYou] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(res => res.json()).then(data => setTreesData(data));
    fetch('http://localhost:8000/buildings').then(res => res.json()).then(data => setBuildingsData(data));
    loadCommunitySpots();
    const animate = () => { setTime(t => (t + 15) % 8000); requestAnimationFrame(animate); };
    const reqId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(reqId);
  }, []);

  // Update theme and rays when sun position changes
  useEffect(() => {
    const isDay = sunPosition.altitude > 0;
    setTheme(isDay ? 'light' : 'dark');
    setRaysData(generateSquigglyRays(sunPosition.azimuth, sunPosition.altitude));
  }, [sunPosition]);

  // Recalculate environment on slider change
  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOffset}`)
      .then(res => res.json())
      .then(data => setSunPosition(data));
    
    // Fetch forecast for weather card
    fetch(`http://localhost:8000/route?start_lat=38.54&start_lon=-121.74&end_lat=38.54&end_lon=-121.74&time_offset=${timeOffset}`)
      .then(res => res.json())
      .then(data => {
        if (data.weather) {
          setWeather(data.weather);
          setWindRays(generateWindRays(data.weather.wind_dir));
        }
      });

    if (startCoords && endCoords) {
      handleSearch();
    }
  }, [timeOffset]);

  const loadCommunitySpots = () => {
    fetch('http://localhost:8000/community_spots').then(res => res.json()).then(data => setCommunitySpots(data));
  };

  const fitRouteBounds = (features) => {
    if (!features || features.length === 0) return;
    const allCoords = features.flatMap(f => f.geometry.coordinates);
    const minLon = Math.min(...allCoords.map(c => c[0]));
    const maxLon = Math.max(...allCoords.map(c => c[0]));
    const minLat = Math.min(...allCoords.map(c => c[1]));
    const maxLat = Math.max(...allCoords.map(c => c[1]));

    const viewport = new WebMercatorViewport(viewState);
    const { longitude, latitude, zoom } = viewport.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 80 }
    );
    setViewState({ ...viewState, longitude, latitude, zoom: zoom - 0.2, transitionDuration: 1000 });
  };

  const handleSearch = () => {
    if (!startCoords || !endCoords) return;
    setRouteLoading(true);
    fetch(`http://localhost:8000/route?start_lat=${startCoords.lat}&start_lon=${startCoords.lon}&end_lat=${endCoords.lat}&end_lon=${endCoords.lon}&time_offset=${timeOffset}`)
      .then(res => res.json())
      .then(data => {
        setRouteLoading(false);
        if (data.error) setRouteError(data.error);
        else if (data.features) {
          setRouteData(data);
          setActiveRoute('coolest');
          setWeather(data.weather);
          setWindRays(generateWindRays(data.weather.wind_dir));
          if (uiState === 'search') {
            setUiState('preview');
            fitRouteBounds(data.features);
          }
        }
      })
      .catch(err => {
        setRouteLoading(false);
        setRouteError(`Failed to fetch route. Is backend running?`);
      });
  };

  const layers = [
    buildingsData && new GeoJsonLayer({
      id: 'buildings-3d',
      data: buildingsData,
      extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [45, 55, 72, 220] : [240, 240, 235, 230],
      getLineColor: theme === 'dark' ? [100, 116, 139, 40] : [180, 180, 170, 80],
      material: { 
        ambient: theme === 'light' ? 0.6 : 0.4, 
        diffuse: theme === 'light' ? 0.8 : 0.6, 
        shininess: 20 
      }
    }),
    treesData && [
      new ColumnLayer({
        id: 'tree-trunks',
        data: treesData.features,
        getPosition: d => d.geometry.coordinates,
        getFillColor: [88, 64, 44],
        radius: 0.2,
        extruded: true,
        getElevation: 4
      }),
      new ColumnLayer({
        id: 'tree-canopy-puffy',
        data: treesData.features,
        getPosition: d => d.geometry.coordinates,
        getFillColor: d => [...getTreeColor(d.properties.common), 150],
        radius: 4.5,
        diskResolution: 16,
        extruded: true,
        getElevation: d => (d.properties.height_m || 8) * 0.7,
        offset: [0, 0, 4],
        material: { 
            ambient: theme === 'light' ? 0.6 : 0.4, 
            diffuse: 0.7 
        }
      })
    ],
    routeData && routeData.features.map(feature => {
      const isSelected = activeRoute === feature.properties.type;
      if (uiState === 'nav' && !isSelected) return null;
      return new GeoJsonLayer({
        id: `route-layer-${feature.properties.type}`,
        data: feature,
        lineWidthUnits: 'pixels',
        getLineColor: feature.properties.type === 'coolest' ? [14, 165, 233, isSelected ? 255 : 120] : [245, 158, 11, isSelected ? 255 : 120],
        getLineWidth: isSelected ? 10 : 5,
        parameters: { depthTest: false }
      });
    }),
    sunPosition.altitude > 0 && new TripsLayer({
      id: 'sun-rays',
      data: raysData,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: [255, 255, 255, 30],
      widthMinPixels: 0.5,
      trailLength: 2000,
      currentTime: time,
      parameters: { depthTest: false }
    }),
    new TripsLayer({
      id: 'wind-rays',
      data: windRays,
      getPath: d => d.path,
      getTimestamps: d => d.timestamps,
      getColor: [255, 255, 255, 60],
      widthMinPixels: 1.5,
      trailLength: 1500,
      currentTime: time,
      parameters: { depthTest: false }
    })
  ].flat().filter(Boolean);

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Canopy</h1>
        </div>

        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Schedule</span>
            <div className="time-controls">
              <label style={{fontSize: '0.85rem', fontWeight: 800}}>
                {theme === 'light' ? "☀️ Day" : "🌙 Night"} — {formatTime(timeOffset)}
              </label>
              <input type="range" min="0" max="24" step="0.25" value={timeOffset} onChange={(e) => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
            </div>
          </div>

          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From..." value={startQuery} onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({lat, lon})} isDeparture={true} />
              <SearchInput placeholder="To..." value={endQuery} onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({lat, lon})} />
            </div>
            {uiState === 'search' && (
              <button className="action-btn" onClick={handleSearch} disabled={!startCoords || !endCoords}>Calculate Route</button>
            )}
          </div>

          {uiState === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Results</span>
              {routeLoading ? <div className="thank-you-msg">Optimizing...</div> : routeError ? <div style={{color:'red', fontSize:'0.8rem'}}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'coolest' ? "Cooler Route" : "Efficient Route"}</span>
                      {f.properties.type === 'coolest' && <span className="badge">Cooler</span>}
                    </div>
                    <div className="time" style={{color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)'}}>{f.properties.time_mins} min</div>
                  </div>
                ))
              )}
              {routeData?.recommendation && !routeData.recommendation.is_now && (
                <div className="recommendation-banner">Optimization Tip: {routeData.recommendation.label} for better protection.</div>
              )}
              {!routeLoading && routeData && <button className="action-btn" onClick={() => setUiState('nav')}>Start Walking</button>}
              <button className="action-btn secondary" onClick={() => { setUiState('search'); setRouteData(null); }}>Reset All</button>
            </div>
          )}

          {uiState === 'nav' && (
            <div className="ui-section">
              <span className="section-title">Steps</span>
              <div className="instructions-list">
                {routeData?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, idx) => (
                  <div key={idx} className="instruction-item">{inst}</div>
                ))}
              </div>
              <button className="action-btn secondary" onClick={() => setUiState('search')}>Exit</button>
            </div>
          )}

          <div className="community-section">
            {showThankYou ? (
              <div className="thank-you-msg">Thank you! Your contribution helps the community.</div>
            ) : isReporting ? (
              <button className="suggest-btn" style={{color: 'var(--danger)'}} onClick={() => setIsReporting(false)}>Cancel Suggestion</button>
            ) : (
              <button className="suggest-btn" onClick={() => setIsReporting(true)}>Suggest Shade Spot</button>
            )}
          </div>
        </div>
      </div>

      <div className="map-container">
        <div className="weather-container">
          <div className="weather-card">
            <span className="label">Temp Forecast</span>
            <span className="value">{weather?.temp ? `${Math.round(weather.temp)}°F` : '--'}</span>
          </div>
          <div className="weather-card">
            <span className="label">Wind Forecast</span>
            <span className="value">{weather?.wind_speed ? `${weather.wind_speed} km/h` : '--'}</span>
          </div>
        </div>

        <DeckGL 
          viewState={viewState}
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
                setIsReporting(false); setShowThankYou(true); loadCommunitySpots(); setTimeout(() => setShowThankYou(false), 5000);
              }); 
            } else if(info.object && info.layer.id === 'community-spots') setSelectedSpot(info.object); 
          }}
        >
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}

export default App;

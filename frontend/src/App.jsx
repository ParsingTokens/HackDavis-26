import React, { useState, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport } from '@deck.gl/core';

const INITIAL_VIEW_STATE = {
  longitude: -121.7495,
  latitude: 38.5397,
  zoom: 16,
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
  'default': [80, 160, 80]
};

const getTreeColor = (name) => {
  if (!name) return TREE_COLORS.default;
  for (const key in TREE_COLORS) {
    if (name.toLowerCase().includes(key.toLowerCase())) return TREE_COLORS[key];
  }
  return TREE_COLORS.default;
};

const generateSunRays = (az, alt) => {
  if (alt <= 0) return [];
  const rays = [];
  const count = 400;
  for (let i = 0; i < count; i++) {
    const lat = 38.51 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.06;
    const path = [];
    let currZ = 200 + Math.random() * 150;
    const drop = 22 * (alt / 90 + 0.5);
    const dx = 0.00016 * Math.sin(az * Math.PI / 180);
    const dy = 0.00016 * Math.cos(az * Math.PI / 180);
    for (let j = 0; j < 12; j++) {
      path.push([lon + dx*j, lat + dy*j, currZ - drop*j]);
    }
    const offset = Math.random() * 15000;
    rays.push({ path, timestamps: path.map((_, idx) => offset + idx * 500) });
  }
  return rays;
};

const generateWindRays = (dir) => {
  if (!dir) return [];
  const rays = [];
  const count = 300;
  const rad = (dir - 180) * Math.PI / 180;
  const dx = 0.001 * Math.sin(rad);
  const dy = 0.001 * Math.cos(rad);
  for (let i = 0; i < count; i++) {
    const lat = 38.50 + Math.random() * 0.08;
    const lon = -121.79 + Math.random() * 0.08;
    const path = [];
    let z = 10 + Math.random() * 60;
    for (let j = 0; j < 10; j++) {
      path.push([lon + dx*j, lat + dy*j, z]);
    }
    const offset = Math.random() * 10000;
    rays.push({ path, timestamps: path.map((_, idx) => offset + idx * 400) });
  }
  return rays;
};

function SearchInput({ placeholder, value, onChange, onSelect, isDeparture = false }) {
  const [results, setResults] = useState([]);
  const [pois, setPois] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  
  useEffect(() => {
    fetch('http://localhost:8000/pois').then(res => res.json()).then(data => setPois(Array.isArray(data) ? data : [])).catch(() => setPois([]));
  }, []);

  const handleLoc = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        onChange("Current Location");
        onSelect(latitude, longitude);
      }, (err) => console.error(err), { enableHighAccuracy: true });
    }
  };

  useEffect(() => {
    if (value.length > 1 && showDropdown && value !== "Current Location") {
      const localMatches = pois.filter(p => p.name.toLowerCase().includes(value.toLowerCase()));
      const delay = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${value}, UC Davis, Davis, CA`)
          .then(res => res.json())
          .then(data => {
            const apiRes = data.map(r => ({ name: r.display_name.split(',')[0], lat: parseFloat(r.lat), lon: parseFloat(r.lon) }));
            setResults([...localMatches, ...apiRes].slice(0, 8));
          })
          .catch(() => setResults(localMatches));
      }, 400);
      return () => clearTimeout(delay);
    }
  }, [value, showDropdown, pois]);

  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value} onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 200)} onChange={(e) => { onChange(e.target.value); setShowDropdown(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={handleLoc}>Nearby</button>}
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
  const [timeOffset, setTimeOffset] = useState(0);
  const [theme, setTheme] = useState('dark');
  
  const [startQuery, setStartQuery] = useState('');
  const [startCoords, setStartCoords] = useState(null);
  const [endQuery, setEndQuery] = useState('');
  const [endCoords, setEndCoords] = useState(null);
  
  const [routeData, setRouteData] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [activeRoute, setActiveRoute] = useState('comfort');
  
  const [treesData, setTreesData] = useState(null);
  const [buildingsData, setBuildingsData] = useState(null);
  const [lightsData, setLightsData] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sunPos, setSunPos] = useState({ altitude: -20, azimuth: 0, uv: 0 });
  const [time, setTime] = useState(0);

  const debounceTimer = useRef(null);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(res => res.json()).then(data => setTreesData(data));
    fetch('http://localhost:8000/buildings').then(res => res.json()).then(data => setBuildingsData(data));
    fetch('http://localhost:8000/lights').then(res => res.json()).then(data => setLightsData(data));
    const animate = () => { setTime(t => (t + 15) % 20000); requestAnimationFrame(animate); };
    const reqId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(reqId);
  }, []);

  const handleSearch = (immediate = true) => {
    if (!startCoords || !endCoords) return;
    
    const triggerSearch = () => {
      setRouteLoading(true);
      setRouteError(null);
      fetch(`http://localhost:8000/route?start_lat=${startCoords.lat}&start_lon=${startCoords.lon}&end_lat=${endCoords.lat}&end_lon=${endCoords.lon}&time_offset=${timeOffset}`)
        .then(res => res.json())
        .then(data => {
          setRouteLoading(false);
          if (data.error) setRouteError(data.error);
          else {
            setRouteData(data);
            setActiveRoute('comfort');
            setWeather(data.weather);
            if (uiState === 'search' || uiState === 'preview') {
              setUiState('preview');
              const coords = data.features.flatMap(f => f.geometry.coordinates);
              if (coords.length > 0) {
                const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
                const vp = new WebMercatorViewport(viewState);
                const { longitude, latitude, zoom } = vp.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80 });
                setViewState({ ...viewState, longitude, latitude, zoom: zoom - 0.1 });
              }
            }
          }
        })
        .catch(() => { setRouteLoading(false); setRouteError("Calculation failed."); });
    };

    if (immediate) triggerSearch();
    else {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(triggerSearch, 600);
    }
  };

  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOffset}`).then(res => res.json()).then(data => {
      setSunPos({ altitude: data.altitude, azimuth: data.azimuth, uv: data.uv_index });
      setTheme(data.altitude > 0 ? 'light' : 'dark');
    });
    fetch(`http://localhost:8000/weather?hours_offset=${timeOffset}`).then(res => res.json()).then(data => setWeather(data));
    if (startCoords && endCoords) handleSearch(false);
  }, [timeOffset]);

  useEffect(() => {
    if (startCoords && endCoords) handleSearch(true);
  }, [startCoords, endCoords]);

  const sunRays = useMemo(() => generateSunRays(sunPos.azimuth, sunPos.altitude), [sunPos]);
  const windRays = useMemo(() => generateWindRays(weather?.wind_dir), [weather]);

  const isNight = sunPos.altitude <= 0;

  const layers = [
    buildingsData && new GeoJsonLayer({
      id: 'buildings', data: buildingsData, extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: isNight ? [45, 55, 72, 220] : [100, 116, 139, 210],
      getLineColor: [80, 100, 120, 80],
      material: { ambient: 0.5, diffuse: 0.5, shininess: 20 }
    }),
    treesData && [
      new ColumnLayer({
        id: 'trunks', data: treesData.features, getPosition: d => d.geometry.coordinates,
        getFillColor: [88, 64, 44], radius: 0.2, extruded: true, 
        getElevation: isNight ? 2 : 4 // Shrink trunks at night
      }),
      new ColumnLayer({
        id: 'canopy', data: treesData.features, getPosition: d => d.geometry.coordinates,
        getFillColor: d => [...getTreeColor(d.properties.common), 150],
        radius: isNight ? 2.5 : 4.5, // Shrink canopy at night
        extruded: true, 
        getElevation: d => ((d.properties.height_m || 8) * 0.7) * (isNight ? 0.6 : 1.0), 
        offset: [0, 0, isNight ? 2 : 4]
      })
    ],
    lightsData && isNight && [
      new ColumnLayer({
        id: 'lamp-posts', data: lightsData.features, getPosition: d => d.geometry.coordinates,
        getFillColor: [40, 40, 40], radius: 0.15, extruded: true, getElevation: 5
      }),
      new ColumnLayer({
        id: 'lamp-glow', data: lightsData.features, getPosition: d => d.geometry.coordinates,
        getFillColor: [255, 255, 180, 200], radius: 0.4, extruded: true, getElevation: 0.6, offset: [0, 0, 5]
      })
    ],
    routeData && routeData.features.map(f => {
      const active = activeRoute === f.properties.type;
      if (uiState === 'nav' && !active) return null;
      return new GeoJsonLayer({
        id: `route-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'comfort' ? [14, 165, 233, active ? 255 : 120] : [245, 158, 11, active ? 255 : 120],
        getLineWidth: active ? 10 : 5, parameters: { depthTest: false }
      });
    }),
    !isNight && new TripsLayer({
      id: 'sun-rays', data: sunRays, getPath: d => d.path, getTimestamps: d => d.timestamps,
      getColor: [255, 255, 255, 30], widthMinPixels: 1.2, trailLength: 4000, currentTime: time, parameters: { depthTest: false }
    }),
    new TripsLayer({
      id: 'wind-rays', data: windRays, getPath: d => d.path, getTimestamps: d => d.timestamps,
      getColor: !isNight ? [255, 255, 255, 140] : [255, 255, 255, 60], 
      widthMinPixels: 2, trailLength: 1500, currentTime: time, parameters: { depthTest: false }
    })
  ].flat().filter(Boolean);

  const getClock = (off) => {
    const d = new Date(); d.setHours(d.getHours() + off);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const resetAll = () => {
    setUiState('search'); setRouteData(null); setRouteLoading(false); setRouteError(null);
    setStartQuery(''); setStartCoords(null); setEndQuery(''); setEndCoords(null); setTimeOffset(0);
  };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header"><h1>Canopy</h1></div>
        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Schedule</span>
            <div className="time-controls">
              <label style={{fontSize: '0.8rem', fontWeight: 700}}>
                {isNight ? "🌙 Safety Mode (Lit Paths)" : "☀️ Comfort Mode (Shaded Paths)"}
                <span style={{float: 'right', color: 'var(--primary-accent)'}}>{getClock(timeOffset)}</span>
              </label>
              <input type="range" min="0" max="24" step="0.5" value={timeOffset} onChange={(e) => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
            </div>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From Hall/Building" value={startQuery} onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({lat, lon})} isDeparture={true} />
              <SearchInput placeholder="To Hall/Building" value={endQuery} onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({lat, lon})} />
            </div>
            {(uiState === 'search' || uiState === 'preview') && (
              <button className="action-btn" onClick={() => handleSearch(true)} disabled={routeLoading}>
                {routeLoading ? "Calculating..." : "Go"}
              </button>
            )}
          </div>
          {uiState === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Path Options</span>
              {routeLoading ? <div className="thank-you-msg">{isNight ? "Calculating Safest Route..." : "Calculating Coolest Route..."}</div> : routeError ? <div style={{color:'red', fontSize:'0.8rem'}}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'comfort' ? "Comfort Path" : "Efficient"}</span>
                      {f.properties.type === 'comfort' && <span className="badge">{isNight ? "Safest" : "Coolest"}</span>}
                    </div>
                    <div className="time" style={{color: f.properties.type === 'comfort' ? 'var(--cool-blue)' : 'var(--warm-orange)'}}>{f.properties.time_mins} min</div>
                  </div>
                ))
              )}
              {!routeLoading && routeData && <button className="action-btn" onClick={() => setUiState('nav')}>Start Walking</button>}
              <button className="action-btn secondary" onClick={resetAll}>Reset</button>
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
              <button className="action-btn secondary" onClick={() => setUiState('search')}>Exit Navigation</button>
            </div>
          )}
        </div>
      </div>
      <div className="map-container">
        <div className="weather-container">
          <div className="weather-card"><span className="label">Forecast Temp</span><span className="value">{weather?.temp ? `${Math.round(weather.temp)}°F` : '--'}</span></div>
          <div className="weather-card"><span className="label">Forecast Wind</span><span className="value">{weather?.wind_speed ? `${weather.wind_speed} km/h` : '--'}</span></div>
        </div>
        <DeckGL viewState={viewState} onViewStateChange={({viewState}) => setViewState(viewState)} controller={true} layers={layers} 
          getCursor={({isDragging}) => isDragging ? 'grabbing' : 'grab'}
        >
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}
export default App;

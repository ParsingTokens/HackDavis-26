import React, { useState, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers';
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

const getTreeColor = (name) => {
  if (!name) return [60, 130, 60];
  const n = name.toLowerCase();
  if (n.includes('oak')) return [34, 100, 34];
  if (n.includes('pine') || n.includes('cedar')) return [20, 85, 25];
  if (n.includes('maple')) return [70, 130, 40];
  if (n.includes('elm')) return [50, 110, 50];
  return [55, 125, 55];
};

// Sun rays: golden-yellow streaks that fall at the solar angle
const generateSunRays = (az, alt) => {
  if (alt <= 0) return [];
  const rays = [];
  for (let i = 0; i < 500; i++) {
    const lat = 38.52 + Math.random() * 0.04;
    const lon = -121.77 + Math.random() * 0.04;
    const path = [];
    const startZ = 300 + Math.random() * 200;
    const dropRate = 20 + (alt / 90) * 30;
    const dx = 0.00012 * Math.sin(az * Math.PI / 180);
    const dy = 0.00012 * Math.cos(az * Math.PI / 180);
    for (let j = 0; j < 16; j++) {
      path.push([lon + dx * j, lat + dy * j, startZ - dropRate * j]);
    }
    const offset = Math.random() * 20000;
    rays.push({ path, timestamps: path.map((_, idx) => offset + idx * 400) });
  }
  return rays;
};

// Wind rays: horizontal streaks at ground level
const generateWindRays = (dir) => {
  if (dir === undefined || dir === null) return [];
  const rays = [];
  const rad = (dir - 180) * Math.PI / 180;
  const dx = 0.0008 * Math.sin(rad);
  const dy = 0.0008 * Math.cos(rad);
  for (let i = 0; i < 350; i++) {
    const lat = 38.51 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.06;
    const path = [];
    const z = 3 + Math.random() * 40;
    for (let j = 0; j < 10; j++) {
      path.push([lon + dx * j, lat + dy * j, z + Math.sin(j * 0.5) * 3]);
    }
    const offset = Math.random() * 12000;
    rays.push({ path, timestamps: path.map((_, idx) => offset + idx * 350) });
  }
  return rays;
};

function SearchInput({ placeholder, value, onChange, onSelect, isDeparture = false }) {
  const [results, setResults] = useState([]);
  const [pois, setPois] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8000/pois').then(r => r.json()).then(d => setPois(Array.isArray(d) ? d : [])).catch(() => setPois([]));
  }, []);

  const handleLoc = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((pos) => {
        onChange("Current Location");
        onSelect(pos.coords.latitude, pos.coords.longitude);
      }, () => {}, { enableHighAccuracy: true });
    }
  };

  useEffect(() => {
    if (value.length > 1 && showDropdown && value !== "Current Location") {
      const localMatches = pois.filter(p => p.name.toLowerCase().includes(value.toLowerCase()));
      const delay = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${value}, UC Davis, Davis, CA`)
          .then(r => r.json())
          .then(data => {
            const apiRes = data.map(r => ({ name: r.display_name.split(',')[0], lat: +r.lat, lon: +r.lon }));
            setResults([...localMatches, ...apiRes].slice(0, 8));
          })
          .catch(() => setResults(localMatches));
      }, 400);
      return () => clearTimeout(delay);
    }
  }, [value, showDropdown, pois]);

  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value}
        onFocus={() => setShowDropdown(true)}
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        onChange={(e) => { onChange(e.target.value); setShowDropdown(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={handleLoc}>Nearby</button>}
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item"
              onMouseDown={(e) => { e.preventDefault(); onChange(r.name); onSelect(r.lat, r.lon); setShowDropdown(false); }}>
              {r.name}
            </div>
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

  const debounceRef = useRef(null);

  // Load static data once
  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(setTreesData).catch(() => {});
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBuildingsData).catch(() => {});
    fetch('http://localhost:8000/lights').then(r => r.json()).then(d => {
      console.log('Lights loaded:', d?.features?.length || 0);
      setLightsData(d);
    }).catch(() => {});
    const animate = () => { setTime(t => (t + 18) % 25000); requestAnimationFrame(animate); };
    const id = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(id);
  }, []);

  // Route calculation
  const doSearch = () => {
    if (!startCoords || !endCoords) return;
    setRouteLoading(true);
    setRouteError(null);
    fetch(`http://localhost:8000/route?start_lat=${startCoords.lat}&start_lon=${startCoords.lon}&end_lat=${endCoords.lat}&end_lon=${endCoords.lon}&time_offset=${timeOffset}`)
      .then(r => r.json())
      .then(data => {
        setRouteLoading(false);
        if (data.error) { setRouteError(data.error); return; }
        setRouteData(data);
        setActiveRoute('comfort');
        setWeather(data.weather);
        if (uiState === 'search' || uiState === 'preview') {
          setUiState('preview');
          const coords = data.features.flatMap(f => f.geometry.coordinates);
          if (coords.length > 0) {
            const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
            const vp = new WebMercatorViewport(viewState);
            const { longitude, latitude, zoom } = vp.fitBounds(
              [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
              { padding: 80 }
            );
            setViewState(prev => ({ ...prev, longitude, latitude, zoom: zoom - 0.1 }));
          }
        }
      })
      .catch(() => { setRouteLoading(false); setRouteError("Connection error."); });
  };

  // Sync environment on slider change + debounced recalc
  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOffset}`).then(r => r.json()).then(d => {
      setSunPos({ altitude: d.altitude, azimuth: d.azimuth, uv: d.uv_index });
      setTheme(d.altitude > 0 ? 'light' : 'dark');
    }).catch(() => {});
    fetch(`http://localhost:8000/weather?hours_offset=${timeOffset}`).then(r => r.json()).then(setWeather).catch(() => {});
    if (startCoords && endCoords) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(doSearch, 800);
    }
  }, [timeOffset]);

  // Immediate search on coord selection
  useEffect(() => {
    if (startCoords && endCoords) doSearch();
  }, [startCoords, endCoords]);

  const sunRays = useMemo(() => generateSunRays(sunPos.azimuth, sunPos.altitude), [sunPos]);
  const windRays = useMemo(() => generateWindRays(weather?.wind_dir), [weather]);
  const isNight = sunPos.altitude <= 0;

  // === 3D LAYERS ===
  const layers = useMemo(() => {
    const l = [];

    // Buildings
    if (buildingsData) l.push(new GeoJsonLayer({
      id: 'buildings', data: buildingsData, extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: isNight ? [40, 50, 65, 220] : [180, 175, 165, 210],
      getLineColor: [80, 90, 100, 50],
      material: { ambient: 0.6, diffuse: 0.4, shininess: 20 }
    }));

    // Trees: multi-tier "broccoli" shape (3 stacked spheroid layers)
    if (treesData) {
      const features = treesData.features;
      // Trunk (thin cylinder)
      l.push(new ColumnLayer({
        id: 'tree-trunk', data: features,
        getPosition: d => d.geometry.coordinates,
        getFillColor: [75, 55, 35],
        radius: isNight ? 0.15 : 0.25,
        extruded: true,
        getElevation: isNight ? 2 : 4
      }));
      // Bottom canopy tier (widest, darkest)
      l.push(new ColumnLayer({
        id: 'canopy-bottom', data: features,
        diskResolution: 12,
        getPosition: d => d.geometry.coordinates,
        getFillColor: d => { const c = getTreeColor(d.properties?.common); return [c[0]-10, c[1]-15, c[2]-5, 180]; },
        radius: isNight ? 2.5 : 5.0,
        extruded: true,
        getElevation: d => ((d.properties?.height_m || 8) * 0.35) * (isNight ? 0.5 : 1.0),
        offset: [0, 0, isNight ? 2 : 4]
      }));
      // Middle canopy tier (medium)
      l.push(new ColumnLayer({
        id: 'canopy-mid', data: features,
        diskResolution: 12,
        getPosition: d => d.geometry.coordinates,
        getFillColor: d => { const c = getTreeColor(d.properties?.common); return [...c, 170]; },
        radius: isNight ? 1.8 : 3.8,
        extruded: true,
        getElevation: d => ((d.properties?.height_m || 8) * 0.25) * (isNight ? 0.5 : 1.0),
        offset: [0, 0, isNight ? 3.5 : 6.5]
      }));
      // Top canopy tier (smallest, lightest — the "crown")
      l.push(new ColumnLayer({
        id: 'canopy-top', data: features,
        diskResolution: 12,
        getPosition: d => d.geometry.coordinates,
        getFillColor: d => { const c = getTreeColor(d.properties?.common); return [c[0]+20, c[1]+25, c[2]+10, 160]; },
        radius: isNight ? 1.0 : 2.2,
        extruded: true,
        getElevation: d => ((d.properties?.height_m || 8) * 0.18) * (isNight ? 0.5 : 1.0),
        offset: [0, 0, isNight ? 4.5 : 8.5]
      }));
    }

    // Lampposts (only at night)
    if (lightsData && isNight) {
      const feats = lightsData.features;
      // Pole
      l.push(new ColumnLayer({
        id: 'lamp-pole', data: feats,
        getPosition: d => d.geometry.coordinates,
        getFillColor: [60, 60, 60],
        radius: 0.12,
        extruded: true,
        getElevation: 6
      }));
      // Lamp head (warm glow)
      l.push(new ColumnLayer({
        id: 'lamp-head', data: feats,
        getPosition: d => d.geometry.coordinates,
        getFillColor: [255, 240, 150, 230],
        radius: 0.35,
        extruded: true,
        getElevation: 0.8,
        offset: [0, 0, 6]
      }));
      // Light pool on ground (glow circle)
      l.push(new ScatterplotLayer({
        id: 'lamp-glow', data: feats,
        getPosition: d => d.geometry.coordinates,
        getFillColor: [255, 240, 160, 40],
        getRadius: 8,
        radiusUnits: 'meters',
        parameters: { depthTest: false }
      }));
    }

    // Routes
    if (routeData) {
      routeData.features.forEach(f => {
        const active = activeRoute === f.properties.type;
        if (uiState === 'nav' && !active) return;
        l.push(new GeoJsonLayer({
          id: `route-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
          getLineColor: f.properties.type === 'comfort'
            ? [14, 165, 233, active ? 255 : 120]
            : [245, 158, 11, active ? 255 : 120],
          getLineWidth: active ? 10 : 5,
          parameters: { depthTest: false }
        }));
      });
    }

    // Sun rays (day only) — warm golden
    if (!isNight && sunRays.length > 0) {
      l.push(new TripsLayer({
        id: 'sun-rays', data: sunRays,
        getPath: d => d.path, getTimestamps: d => d.timestamps,
        getColor: [255, 220, 100, 60],
        widthMinPixels: 2,
        trailLength: 5000,
        currentTime: time,
        parameters: { depthTest: false }
      }));
    }

    // Wind rays (always) — white streaks
    if (windRays.length > 0) {
      l.push(new TripsLayer({
        id: 'wind-rays', data: windRays,
        getPath: d => d.path, getTimestamps: d => d.timestamps,
        getColor: isNight ? [200, 200, 255, 50] : [255, 255, 255, 100],
        widthMinPixels: 1.5,
        trailLength: 2000,
        currentTime: time,
        parameters: { depthTest: false }
      }));
    }

    return l;
  }, [buildingsData, treesData, lightsData, routeData, activeRoute, uiState, isNight, sunRays, windRays, time]);

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
              <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                {isNight ? "🌙 Safety Mode (Lit Paths)" : "☀️ Comfort Mode (Shaded Paths)"}
                <span style={{ float: 'right', color: 'var(--primary-accent)' }}>{getClock(timeOffset)}</span>
              </label>
              <input type="range" min="0" max="24" step="0.5" value={timeOffset}
                onChange={(e) => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
            </div>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From Hall/Building" value={startQuery}
                onChange={setStartQuery} onSelect={(lat, lon) => setStartCoords({ lat, lon })} isDeparture={true} />
              <SearchInput placeholder="To Hall/Building" value={endQuery}
                onChange={setEndQuery} onSelect={(lat, lon) => setEndCoords({ lat, lon })} />
            </div>
            {(uiState === 'search' || uiState === 'preview') && (
              <button className="action-btn" onClick={doSearch} disabled={routeLoading}>
                {routeLoading ? "Calculating..." : "Go"}
              </button>
            )}
          </div>
          {uiState === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Path Options</span>
              {routeError ? <div style={{ color: 'red', fontSize: '0.8rem' }}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type}
                    className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`}
                    onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'comfort' ? "Comfort Path" : "Efficient"}</span>
                      {f.properties.type === 'comfort' && <span className="badge">{isNight ? "Safest" : "Coolest"}</span>}
                    </div>
                    <div className="time" style={{ color: f.properties.type === 'comfort' ? 'var(--cool-blue)' : 'var(--warm-orange)' }}>
                      {f.properties.time_mins} min
                    </div>
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
        <DeckGL viewState={viewState} onViewStateChange={({ viewState }) => setViewState(viewState)}
          controller={true} layers={layers}
          getCursor={({ isDragging }) => isDragging ? 'grabbing' : 'grab'}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}
export default App;

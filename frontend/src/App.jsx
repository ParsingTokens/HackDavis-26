import React, { useState, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport } from '@deck.gl/core';

const INITIAL_VIEW_STATE = {
  longitude: -121.7495, latitude: 38.5397, zoom: 16, pitch: 45, bearing: 0, transitionDuration: 1000
};

const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const getTreeColor = (name) => {
  if (!name) return [60, 140, 60];
  const n = name.toLowerCase();
  if (n.includes('oak')) return [34, 100, 34];
  if (n.includes('pine') || n.includes('cedar')) return [20, 80, 20];
  if (n.includes('maple')) return [60, 120, 30];
  if (n.includes('palm')) return [80, 170, 60];
  return [50 + Math.random()*30, 120 + Math.random()*40, 40 + Math.random()*20];
};

// Sun rays: use ScatterplotLayer with radiusPixels instead of TripsLayer
// This is guaranteed visible — no animation timing issues
const generateSunDots = (az, alt) => {
  if (alt <= 0) return [];
  const dots = [];
  const count = 800;
  for (let i = 0; i < count; i++) {
    const lat = 38.52 + Math.random() * 0.04;
    const lon = -121.77 + Math.random() * 0.04;
    const driftScale = Math.random() * 0.0005;
    dots.push({
      position: [
        lon + driftScale * Math.sin(az * Math.PI / 180),
        lat + driftScale * Math.cos(az * Math.PI / 180),
        60 + Math.random() * 200
      ],
      radius: 0.8 + Math.random() * 1.5
    });
  }
  return dots;
};

const generateWindRays = (dir) => {
  if (!dir) return [];
  const rays = [];
  const rad = (dir - 180) * Math.PI / 180;
  const dx = 0.001 * Math.sin(rad), dy = 0.001 * Math.cos(rad);
  for (let i = 0; i < 300; i++) {
    const lat = 38.50 + Math.random() * 0.08;
    const lon = -121.79 + Math.random() * 0.08;
    const z = 10 + Math.random() * 60;
    const path = [];
    for (let j = 0; j < 10; j++) path.push([lon + dx*j, lat + dy*j, z]);
    const off = Math.random() * 10000;
    rays.push({ path, timestamps: path.map((_, idx) => off + idx * 400) });
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

  useEffect(() => {
    if (value.length > 1 && showDropdown && value !== "Current Location") {
      const local = pois.filter(p => p.name.toLowerCase().includes(value.toLowerCase()));
      const t = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${value}, UC Davis, Davis, CA`)
          .then(r => r.json())
          .then(d => setResults([...local, ...d.map(r => ({ name: r.display_name.split(',')[0], lat: +r.lat, lon: +r.lon }))].slice(0, 8)))
          .catch(() => setResults(local));
      }, 400);
      return () => clearTimeout(t);
    }
  }, [value, showDropdown, pois]);

  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value}
        onFocus={() => setShowDropdown(true)} onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        onChange={(e) => { onChange(e.target.value); setShowDropdown(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={() => {
        navigator.geolocation?.getCurrentPosition(p => { onChange("Current Location"); onSelect(p.coords.latitude, p.coords.longitude); }, null, { enableHighAccuracy: true });
      }}>Nearby</button>}
      {showDropdown && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => (
            <div key={i} className="autocomplete-item" onMouseDown={e => { e.preventDefault(); onChange(r.name); onSelect(r.lat, r.lon); setShowDropdown(false); }}>{r.name}</div>
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
  const [activeRoute, setActiveRoute] = useState('coolest');
  const [treesData, setTreesData] = useState(null);
  const [buildingsData, setBuildingsData] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sunPos, setSunPos] = useState({ altitude: -20, azimuth: 0 });
  const [time, setTime] = useState(0);
  const debounce = useRef(null);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(setTreesData);
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBuildingsData);
    const anim = () => { setTime(t => (t + 15) % 10000); requestAnimationFrame(anim); };
    const id = requestAnimationFrame(anim);
    return () => cancelAnimationFrame(id);
  }, []);

  const doSearch = () => {
    if (!startCoords || !endCoords) return;
    setRouteLoading(true); setRouteError(null);
    fetch(`http://localhost:8000/route?start_lat=${startCoords.lat}&start_lon=${startCoords.lon}&end_lat=${endCoords.lat}&end_lon=${endCoords.lon}&time_offset=${timeOffset}`)
      .then(r => r.json()).then(data => {
        setRouteLoading(false);
        if (data.error) { setRouteError(data.error); return; }
        setRouteData(data); setActiveRoute('coolest'); setWeather(data.weather);
        if (uiState === 'search' || uiState === 'preview') {
          setUiState('preview');
          const cs = data.features.flatMap(f => f.geometry.coordinates);
          if (cs.length) {
            const lons = cs.map(c => c[0]), lats = cs.map(c => c[1]);
            const vp = new WebMercatorViewport(viewState);
            const fit = vp.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80 });
            setViewState({ ...viewState, longitude: fit.longitude, latitude: fit.latitude, zoom: fit.zoom - 0.1 });
          }
        }
      }).catch(() => { setRouteLoading(false); setRouteError("Connection error."); });
  };

  // Slider change: update env + debounced recalc
  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOffset}`).then(r => r.json()).then(d => {
      setSunPos({ altitude: d.altitude, azimuth: d.azimuth }); setTheme(d.altitude > 0 ? 'light' : 'dark');
    });
    fetch(`http://localhost:8000/weather?hours_offset=${timeOffset}`).then(r => r.json()).then(setWeather);
    if (startCoords && endCoords) {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(doSearch, 800);
    }
  }, [timeOffset]);

  useEffect(() => { if (startCoords && endCoords) doSearch(); }, [startCoords, endCoords]);

  const sunDots = useMemo(() => generateSunDots(sunPos.azimuth, sunPos.altitude), [sunPos]);
  const windRays = useMemo(() => generateWindRays(weather?.wind_dir), [weather]);

  // --- BUILD TREE LAYERS (broccoli shape) ---
  const treeLayers = useMemo(() => {
    if (!treesData?.features) return [];
    const features = treesData.features;
    return [
      // Brown trunk
      new ColumnLayer({
        id: 'tree-trunk', data: features, getPosition: d => d.geometry.coordinates,
        getFillColor: [92, 64, 40], radius: 0.3, extruded: true, getElevation: d => (d.properties.height_m || 8) * 0.4,
        diskResolution: 6
      }),
      // Bottom canopy sphere (wide)
      new ColumnLayer({
        id: 'canopy-bottom', data: features, getPosition: d => d.geometry.coordinates,
        getFillColor: d => [...getTreeColor(d.properties.common), 180],
        radius: 4, extruded: true, getElevation: d => (d.properties.height_m || 8) * 0.35,
        elevationScale: 1, diskResolution: 12,
        offset: [0, 0], elevationOffset: (d) => (d.properties.height_m || 8) * 0.3
      }),
      // Middle canopy sphere (medium, stacked higher)
      new ColumnLayer({
        id: 'canopy-mid', data: features, getPosition: d => d.geometry.coordinates,
        getFillColor: d => {
          const c = getTreeColor(d.properties.common);
          return [c[0] + 10, c[1] + 15, c[2] + 5, 170]; // slightly lighter
        },
        radius: 3.2, extruded: true, getElevation: d => (d.properties.height_m || 8) * 0.3,
        diskResolution: 12
      }),
      // Top canopy sphere (small, rounded top)
      new ColumnLayer({
        id: 'canopy-top', data: features, getPosition: d => d.geometry.coordinates,
        getFillColor: d => {
          const c = getTreeColor(d.properties.common);
          return [c[0] + 20, c[1] + 25, c[2] + 10, 160]; // lightest
        },
        radius: 2, extruded: true, getElevation: d => (d.properties.height_m || 8) * 0.2,
        diskResolution: 12
      }),
    ];
  }, [treesData]);

  const layers = [
    buildingsData && new GeoJsonLayer({
      id: 'buildings', data: buildingsData, extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [45, 55, 72, 220] : [100, 116, 139, 200],
      getLineColor: [80, 100, 120, 80],
      material: { ambient: 0.5, diffuse: 0.5, shininess: 20 }
    }),
    ...treeLayers,
    routeData && routeData.features.map(f => {
      const active = activeRoute === f.properties.type;
      if (uiState === 'nav' && !active) return null;
      return new GeoJsonLayer({
        id: `route-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'coolest' ? [14, 165, 233, active ? 255 : 120] : [245, 158, 11, active ? 255 : 120],
        getLineWidth: active ? 10 : 5, parameters: { depthTest: false }
      });
    }),
    // SUN RAYS: ScatterplotLayer — guaranteed visible, no animation timing issues
    sunPos.altitude > 0 && new ScatterplotLayer({
      id: 'sun-dots', data: sunDots,
      getPosition: d => d.position,
      getRadius: d => d.radius,
      getFillColor: [255, 236, 130, 100],
      radiusUnits: 'meters',
      radiusScale: 3,
      parameters: { depthTest: false }
    }),
    // Wind rays
    new TripsLayer({
      id: 'wind-rays', data: windRays, getPath: d => d.path, getTimestamps: d => d.timestamps,
      getColor: theme === 'light' ? [80, 80, 80, 120] : [255, 255, 255, 70],
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
              <label style={{fontSize:'0.8rem',fontWeight:700}}>
                {sunPos.altitude > 0 ? "☀️ Day Mode" : "🌙 Night Mode"}
                <span style={{float:'right',color:'var(--primary-accent)'}}>{getClock(timeOffset)}</span>
              </label>
              <input type="range" min="0" max="24" step="0.5" value={timeOffset} onChange={e => setTimeOffset(parseFloat(e.target.value))} className="time-slider" />
            </div>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From Hall/Building" value={startQuery} onChange={setStartQuery} onSelect={(lat,lon) => setStartCoords({lat,lon})} isDeparture />
              <SearchInput placeholder="To Hall/Building" value={endQuery} onChange={setEndQuery} onSelect={(lat,lon) => setEndCoords({lat,lon})} />
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
              {routeError ? <div style={{color:'red',fontSize:'0.8rem'}}>{routeError}</div> : (
                routeData?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'coolest' ? "Cooler" : "Efficient"}</span>
                      {f.properties.type === 'coolest' && <span className="badge">Best Temp</span>}
                    </div>
                    <div className="time" style={{color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)'}}>{f.properties.time_mins} min</div>
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
          getCursor={({isDragging}) => isDragging ? 'grabbing' : 'grab'}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}
export default App;

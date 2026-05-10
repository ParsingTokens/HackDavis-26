import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, PathLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport } from '@deck.gl/core';

const INIT_VS = { longitude: -121.7495, latitude: 38.5397, zoom: 16, pitch: 45, bearing: 0, transitionDuration: 800 };
const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const treeColor = (name) => {
  if (!name) return [55, 135, 55];
  const n = name.toLowerCase();
  if (n.includes('oak')) return [40, 105, 40];
  if (n.includes('pine') || n.includes('cedar') || n.includes('redwood')) return [25, 85, 30];
  if (n.includes('maple')) return [65, 125, 35];
  return [50 + (name.charCodeAt(0) % 20), 120 + (name.charCodeAt(0) % 30), 45];
};

// SUN RAYS: Static PathLayer lines — always visible, no animation dependency
const makeSunRays = (az, alt) => {
  if (alt <= 0) return [];
  const rays = [];
  const radAz = az * Math.PI / 180;
  const dx = 0.00025 * Math.sin(radAz);
  const dy = 0.00025 * Math.cos(radAz);
  const dropPerStep = 30 * (alt / 90 + 0.3);
  for (let i = 0; i < 250; i++) {
    const lat = 38.525 + Math.random() * 0.03;
    const lon = -121.765 + Math.random() * 0.03;
    const startZ = 150 + Math.random() * 200;
    const path = [];
    for (let j = 0; j < 8; j++) {
      path.push([lon + dx * j, lat + dy * j, startZ - dropPerStep * j]);
    }
    rays.push({ path });
  }
  return rays;
};

// WIND: TripsLayer animated streaks
const makeWindRays = (dir) => {
  if (dir === undefined || dir === null) return [];
  const rays = [];
  const rad = (dir - 180) * Math.PI / 180;
  const dx = 0.001 * Math.sin(rad), dy = 0.001 * Math.cos(rad);
  for (let i = 0; i < 200; i++) {
    const lat = 38.52 + Math.random() * 0.04;
    const lon = -121.77 + Math.random() * 0.04;
    const z = 8 + Math.random() * 50;
    const path = [];
    for (let j = 0; j < 8; j++) path.push([lon + dx * j, lat + dy * j, z]);
    const off = Math.random() * 8000;
    rays.push({ path, ts: path.map((_, idx) => off + idx * 350) });
  }
  return rays;
};

function SearchInput({ placeholder, value, onChange, onSelect, isDeparture }) {
  const [results, setResults] = useState([]);
  const [pois, setPois] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { fetch('http://localhost:8000/pois').then(r => r.json()).then(d => setPois(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  useEffect(() => {
    if (value.length > 1 && open && value !== 'Current Location') {
      const local = pois.filter(p => p.name.toLowerCase().includes(value.toLowerCase()));
      const t = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(value)}, UC Davis, Davis, CA`)
          .then(r => r.json())
          .then(d => setResults([...local, ...d.map(r => ({ name: r.display_name.split(',')[0], lat: +r.lat, lon: +r.lon }))].slice(0, 8)))
          .catch(() => setResults(local));
      }, 400);
      return () => clearTimeout(t);
    } else { setResults([]); }
  }, [value, open, pois]);

  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)}
        onChange={e => { onChange(e.target.value); setOpen(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={() => {
        navigator.geolocation?.getCurrentPosition(p => { onChange('Current Location'); onSelect(p.coords.latitude, p.coords.longitude); }, null, { enableHighAccuracy: true });
      }}>Nearby</button>}
      {open && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((r, i) => <div key={i} className="autocomplete-item" onMouseDown={e => { e.preventDefault(); onChange(r.name); onSelect(r.lat, r.lon); setOpen(false); }}>{r.name}</div>)}
        </div>
      )}
    </div>
  );
}

function Compass({ bearing }) {
  return (
    <div className="compass" style={{ transform: `rotate(${-bearing}deg)` }}>
      <div className="compass-ring">
        <span className="compass-n">N</span>
        <span className="compass-e">E</span>
        <span className="compass-s">S</span>
        <span className="compass-w">W</span>
        <div className="compass-needle" />
      </div>
    </div>
  );
}

export default function App() {
  const [vs, setVs] = useState(INIT_VS);
  const [ui, setUi] = useState('search');
  const [timeOff, setTimeOff] = useState(0);
  const [theme, setTheme] = useState('dark');
  const [sq, setSq] = useState(''); const [sc, setSc] = useState(null);
  const [eq, setEq] = useState(''); const [ec, setEc] = useState(null);
  const [rd, setRd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [active, setActive] = useState('coolest');
  const [trees, setTrees] = useState(null);
  const [bldg, setBldg] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sun, setSun] = useState({ alt: -20, az: 0 });
  const [tick, setTick] = useState(0);
  const sliderDebounce = useRef(null);
  const envDebounce = useRef(null);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(setTrees);
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBldg);
    const a = () => { setTick(t => (t + 12) % 8000); requestAnimationFrame(a); };
    const id = requestAnimationFrame(a);
    return () => cancelAnimationFrame(id);
  }, []);

  const doRoute = useCallback(() => {
    if (!sc || !ec) return;
    setLoading(true); setErr(null);
    fetch(`http://localhost:8000/route?start_lat=${sc.lat}&start_lon=${sc.lon}&end_lat=${ec.lat}&end_lon=${ec.lon}&time_offset=${timeOff}`)
      .then(r => r.json()).then(d => {
        setLoading(false);
        if (d.error) { setErr(d.error); return; }
        setRd(d); setActive('coolest'); setWeather(d.weather);
        if (ui === 'search' || ui === 'preview') {
          setUi('preview');
          const cs = d.features.flatMap(f => f.geometry.coordinates);
          if (cs.length) {
            const lns = cs.map(c => c[0]), lts = cs.map(c => c[1]);
            const vp = new WebMercatorViewport(vs);
            const fit = vp.fitBounds([[Math.min(...lns), Math.min(...lts)], [Math.max(...lns), Math.max(...lts)]], { padding: 80 });
            setVs(v => ({ ...v, longitude: fit.longitude, latitude: fit.latitude, zoom: fit.zoom - 0.1 }));
          }
        }
      }).catch(() => { setLoading(false); setErr('Connection error.'); });
  }, [sc, ec, timeOff, ui, vs]);

  // Slider: debounce BOTH env update and route recalc
  const onSliderChange = useCallback((val) => {
    setTimeOff(val);
    // Debounce everything until slider stops
    if (envDebounce.current) clearTimeout(envDebounce.current);
    envDebounce.current = setTimeout(() => {
      fetch(`http://localhost:8000/sun_position?hours_offset=${val}`).then(r => r.json()).then(d => {
        setSun({ alt: d.altitude, az: d.azimuth }); setTheme(d.altitude > 0 ? 'light' : 'dark');
      });
      fetch(`http://localhost:8000/weather?hours_offset=${val}`).then(r => r.json()).then(setWeather);
    }, 300);
    if (sliderDebounce.current) clearTimeout(sliderDebounce.current);
    sliderDebounce.current = setTimeout(() => {
      if (sc && ec) {
        setLoading(true); setErr(null);
        fetch(`http://localhost:8000/route?start_lat=${sc.lat}&start_lon=${sc.lon}&end_lat=${ec.lat}&end_lon=${ec.lon}&time_offset=${val}`)
          .then(r => r.json()).then(d => {
            setLoading(false);
            if (d.error) { setErr(d.error); return; }
            setRd(d); setWeather(d.weather);
          }).catch(() => { setLoading(false); });
      }
    }, 900);
  }, [sc, ec]);

  // Fetch env on mount
  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=0`).then(r => r.json()).then(d => {
      setSun({ alt: d.altitude, az: d.azimuth }); setTheme(d.altitude > 0 ? 'light' : 'dark');
    });
    fetch(`http://localhost:8000/weather?hours_offset=0`).then(r => r.json()).then(setWeather);
  }, []);

  // Route on coordinate select
  useEffect(() => { if (sc && ec) doRoute(); }, [sc, ec]);

  const sunRays = useMemo(() => makeSunRays(sun.az, sun.alt), [sun]);
  const windRays = useMemo(() => makeWindRays(weather?.wind_dir), [weather]);

  const treeLayers = useMemo(() => {
    if (!trees?.features) return [];
    const f = trees.features;
    return [
      // Trunk: thin brown cylinder
      new ColumnLayer({
        id: 'trunk', data: f, getPosition: d => d.geometry.coordinates,
        getFillColor: [92, 66, 42], radius: 0.35, extruded: true,
        getElevation: d => Math.max(3, (d.properties.height_m || 8) * 0.35),
        diskResolution: 6, material: { ambient: 0.6, diffuse: 0.4 }
      }),
      // Canopy: fat green cylinder with high resolution for roundness
      new ColumnLayer({
        id: 'canopy', data: f, getPosition: d => d.geometry.coordinates,
        getFillColor: d => [...treeColor(d.properties.common), 190],
        radius: 3.5, extruded: true,
        getElevation: d => Math.max(5, (d.properties.height_m || 8) * 0.65),
        diskResolution: 20, // high polygon count for round appearance
        material: { ambient: 0.65, diffuse: 0.35, shininess: 10 }
      })
    ];
  }, [trees]);

  const layers = [
    bldg && new GeoJsonLayer({
      id: 'bldg', data: bldg, extruded: true,
      getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [45, 55, 72, 220] : [140, 150, 160, 200],
      getLineColor: [80, 100, 120, 60],
      material: { ambient: 0.5, diffuse: 0.5, shininess: 20 }
    }),
    ...treeLayers,
    rd && rd.features.map(f => {
      const a = active === f.properties.type;
      if (ui === 'nav' && !a) return null;
      return new GeoJsonLayer({
        id: `r-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'coolest' ? [14, 165, 233, a ? 255 : 100] : [245, 158, 11, a ? 255 : 100],
        getLineWidth: a ? 10 : 5, parameters: { depthTest: false }
      });
    }),
    // SUN RAYS: PathLayer — static golden lines, ALWAYS visible during day
    sun.alt > 0 && new PathLayer({
      id: 'sun-rays', data: sunRays,
      getPath: d => d.path,
      getColor: [255, 220, 80, 60],
      getWidth: 1.5,
      widthUnits: 'pixels',
      parameters: { depthTest: false }
    }),
    // WIND: animated streaks
    new TripsLayer({
      id: 'wind', data: windRays, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: theme === 'light' ? [40, 40, 40, 100] : [220, 220, 255, 60],
      widthMinPixels: 1.5, trailLength: 1200, currentTime: tick,
      parameters: { depthTest: false }
    })
  ].flat().filter(Boolean);

  const clock = (off) => { const d = new Date(); d.setHours(d.getHours() + off); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const reset = () => { setUi('search'); setRd(null); setLoading(false); setErr(null); setSq(''); setSc(null); setEq(''); setEc(null); setTimeOff(0); };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header"><h1>Canopy</h1></div>
        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Schedule</span>
            <div className="time-controls">
              <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                {sun.alt > 0 ? '☀️ Day' : '🌙 Night'}
                <span style={{ float: 'right', color: 'var(--primary-accent)' }}>{clock(timeOff)}</span>
              </label>
              <input type="range" min="0" max="24" step="0.5" value={timeOff}
                onChange={e => onSliderChange(parseFloat(e.target.value))} className="time-slider" />
            </div>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <div className="input-group">
              <SearchInput placeholder="From Hall/Building" value={sq} onChange={setSq} onSelect={(lat, lon) => setSc({ lat, lon })} isDeparture />
              <SearchInput placeholder="To Hall/Building" value={eq} onChange={setEq} onSelect={(lat, lon) => setEc({ lat, lon })} />
            </div>
            {(ui === 'search' || ui === 'preview') && (
              <button className="action-btn" onClick={doRoute} disabled={loading}>
                {loading ? 'Calculating...' : 'Go'}
              </button>
            )}
          </div>
          {ui === 'preview' && (
            <div className="ui-section">
              <span className="section-title">Path Options</span>
              {err ? <div style={{ color: 'red', fontSize: '0.8rem' }}>{err}</div> : (
                rd?.features.map(f => (
                  <div key={f.properties.type} className={`route-card ${active === f.properties.type ? 'active' : ''}`} onClick={() => setActive(f.properties.type)}>
                    <div className="header">
                      <span className="type">{f.properties.type === 'coolest' ? 'Cooler' : 'Efficient'}</span>
                      {f.properties.type === 'coolest' && <span className="badge">Best Temp</span>}
                    </div>
                    <div className="time" style={{ color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)' }}>{f.properties.time_mins} min</div>
                  </div>
                ))
              )}
              {!loading && rd && <button className="action-btn" onClick={() => setUi('nav')}>Start Walking</button>}
              <button className="action-btn secondary" onClick={reset}>Reset</button>
            </div>
          )}
          {ui === 'nav' && (
            <div className="ui-section">
              <span className="section-title">Directions</span>
              <div className="instructions-list">
                {rd?.features.find(f => f.properties.type === active)?.properties?.instructions?.map((inst, i) => (
                  <div key={i} className="instruction-item">{inst}</div>
                ))}
              </div>
              <button className="action-btn secondary" onClick={() => setUi('search')}>Exit Navigation</button>
            </div>
          )}
        </div>
      </div>
      <div className="map-container">
        <Compass bearing={vs.bearing} />
        <div className="weather-container">
          <div className="weather-card"><span className="label">Temp</span><span className="value">{weather?.temp != null ? `${Math.round(weather.temp)}°F` : '--'}</span></div>
          <div className="weather-card"><span className="label">Wind</span><span className="value">{weather?.wind_speed != null ? `${weather.wind_speed} km/h` : '--'}</span></div>
        </div>
        <DeckGL viewState={vs} onViewStateChange={({ viewState }) => setVs(viewState)} controller layers={layers}
          getCursor={({ isDragging }) => isDragging ? 'grabbing' : 'grab'}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}

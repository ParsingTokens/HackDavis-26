import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, PathLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { WebMercatorViewport } from '@deck.gl/core';

const INIT_VS = { longitude: -121.7495, latitude: 38.5397, zoom: 16, pitch: 45, bearing: 0, transitionDuration: 500 };
const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const treeColor = (n) => {
  if (!n) return [55, 135, 55];
  const name = n.toLowerCase();
  if (name.includes('oak')) return [40, 105, 40];
  if (name.includes('pine') || name.includes('cedar')) return [25, 85, 30];
  return [50, 120, 45];
};

// PRECISE SUN RAYS: COMING FROM SUN AZIMUTH
const makeSunRays = (az, alt) => {
  if (alt <= 0) return [];
  const rays = [];
  // radFrom is the direction TO the sun. radTo is 180 deg away (direction of light).
  const radFrom = az * Math.PI / 180;
  const radTo = (az + 180) * Math.PI / 180;
  
  // Offset to place the "source" towards the sun
  const sourceDist = 0.005; 
  const dxFrom = sourceDist * Math.sin(radFrom);
  const dyFrom = sourceDist * Math.cos(radFrom);
  
  // Vector for the ray itself
  const dxRay = 0.001 * Math.sin(radTo);
  const dyRay = 0.001 * Math.cos(radTo);
  const drop = 50 * (alt / 90 + 0.1);

  for (let i = 0; i < 300; i++) {
    const baseLat = 38.52 + Math.random() * 0.04;
    const baseLon = -121.77 + Math.random() * 0.04;
    // Start way out towards the sun
    const startLat = baseLat + dyFrom;
    const startLon = baseLon + dxFrom;
    const startZ = 400 + Math.random() * 200;
    
    const path = [];
    // Long rays sweeping across the map
    for (let j = 0; j < 15; j++) {
      path.push([startLon + dxRay * j, startLat + dyRay * j, startZ - drop * j]);
    }
    rays.push({ path });
  }
  return rays;
};

const makeWindRays = (dir) => {
  if (dir === undefined || dir === null) return [];
  const rays = [];
  const rad = (dir - 180) * Math.PI / 180;
  const dx = 0.0015 * Math.sin(rad), dy = 0.0015 * Math.cos(rad);
  for (let i = 0; i < 200; i++) {
    const lat = 38.51 + Math.random() * 0.06;
    const lon = -121.78 + Math.random() * 0.06;
    const z = 15 + Math.random() * 50;
    const path = [];
    for (let j = 0; j < 8; j++) path.push([lon + dx * j, lat + dy * j, z]);
    const off = Math.random() * 8000;
    rays.push({ path, ts: path.map((_, idx) => off + idx * 300) });
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
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(value)}, Davis, CA`)
          .then(r => r.json())
          .then(d => setResults([...local, ...d.map(r => ({ name: r.display_name.split(',')[0], lat: +r.lat, lon: +r.lon }))].slice(0, 8)))
          .catch(() => setResults(local));
      }, 300);
      return () => clearTimeout(t);
    } else { setResults([]); }
  }, [value, open, pois]);
  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} onChange={e => { onChange(e.target.value); setOpen(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={() => { navigator.geolocation?.getCurrentPosition(p => { onChange('Current Location'); onSelect(p.coords.latitude, p.coords.longitude); }, null, { enableHighAccuracy: true }); }}>Nearby</button>}
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
        <span className="compass-n">N</span><span className="compass-e">E</span><span className="compass-s">S</span><span className="compass-w">W</span>
        <div className="compass-needle" />
      </div>
    </div>
  );
}

export default function App() {
  const [vs, setVs] = useState(INIT_VS);
  const [ui, setUi] = useState('search');
  const [timeOff, setTimeOff] = useState(0);
  const [tintMode, setTintMode] = useState(true);
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

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(setTrees);
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBldg);
    const a = () => { setTick(t => (t + 15) % 8000); requestAnimationFrame(a); };
    const id = requestAnimationFrame(a);
    return () => cancelAnimationFrame(id);
  }, []);

  const fetchEnv = useCallback((val) => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${val}`).then(r => r.json()).then(d => {
      setSun({ alt: d.altitude, az: d.azimuth }); setTheme(d.altitude > 0 ? 'light' : 'dark');
    });
    fetch(`http://localhost:8000/weather?hours_offset=${val}`).then(r => r.json()).then(setWeather);
  }, []);

  const doRoute = useCallback((val) => {
    if (!sc || !ec) return;
    setLoading(true); setErr(null);
    fetch(`http://localhost:8000/route?start_lat=${sc.lat}&start_lon=${sc.lon}&end_lat=${ec.lat}&end_lon=${ec.lon}&time_offset=${val}`)
      .then(r => r.json()).then(d => {
        setLoading(false);
        if (d.error) setErr(d.error);
        else { setRd(d); setWeather(d.weather); setUi('preview'); }
      }).catch(() => { setLoading(false); setErr('Calculation failed.'); });
  }, [sc, ec]);

  useEffect(() => { fetchEnv(timeOff); }, [timeOff]);
  useEffect(() => { if (sc && ec) doRoute(timeOff); }, [sc, ec]);

  const sunRays = useMemo(() => makeSunRays(sun.az, sun.alt), [sun]);
  const windRays = useMemo(() => makeWindRays(weather?.wind_dir), [weather]);

  const layers = [
    bldg && new GeoJsonLayer({
      id: 'bldg', data: bldg, extruded: true, getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [45, 55, 72, 220] : [140, 150, 160, 200],
      getLineColor: [100, 116, 139, 40], opacity: tintMode ? 0.3 : 1, material: { ambient: 0.5, diffuse: 0.5, shininess: 20 }
    }),
    trees?.features && [
      new ColumnLayer({
        id: 'trunk', data: trees.features, getPosition: d => d.geometry.coordinates,
        getFillColor: [92, 66, 42], radius: 0.4, extruded: true, getElevation: 3, diskResolution: 6
      }),
      new ColumnLayer({
        id: 'canopy', data: trees.features, getPosition: d => d.geometry.coordinates,
        getFillColor: d => [...treeColor(d.properties.common), 190],
        radius: 3.5, extruded: true, getElevation: 6, diskResolution: 20, opacity: tintMode ? 0.4 : 1
      })
    ],
    rd?.features.map(f => {
      const a = active === f.properties.type;
      if (ui === 'nav' && !a) return null;
      return new GeoJsonLayer({
        id: `r-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'coolest' ? [14, 165, 233, a ? 255 : 100] : [245, 158, 11, a ? 255 : 100],
        getLineWidth: a ? 14 : 7, parameters: { depthTest: false }
      });
    }),
    sun.alt > 0 && new PathLayer({
      id: 'sun-rays', data: sunRays, getPath: d => d.path, 
      getColor: [255, 255, 120, tintMode ? 220 : 150], // Neon bright
      getWidth: 4, widthUnits: 'pixels', parameters: { depthTest: false }
    }),
    new TripsLayer({
      id: 'wind', data: windRays, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: theme === 'light' ? [20, 20, 20, 150] : [240, 240, 255, 120],
      widthMinPixels: 2.5, trailLength: 1500, currentTime: tick, parameters: { depthTest: false }
    })
  ].flat().filter(Boolean);

  const clock = (off) => { const d = new Date(); d.setHours(d.getHours() + off); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header"><h1>Canopy</h1></div>
        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Prediction Hour</span>
            <div className="input-group" style={{flexDirection:'row', alignItems:'center', gap:'10px'}}>
              <input type="number" min="0" max="24" step="1" value={timeOff} onChange={e => setTimeOff(parseInt(e.target.value) || 0)} 
                style={{width:'70px', padding:'10px', borderRadius:'8px', border:'2px solid var(--primary-accent)', fontSize:'1rem', fontWeight:700}} />
              <div style={{fontSize:'0.9rem', fontWeight:600}}>Hours From Now<br/><span style={{color:'var(--primary-accent)'}}>{clock(timeOff)}</span></div>
            </div>
            <button className={`action-btn ${tintMode ? '' : 'secondary'}`} onClick={() => setTintMode(!tintMode)} style={{marginTop:'15px'}}>
              {tintMode ? 'Disable Ray Tint' : 'Enable Ray Tint'}
            </button>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <SearchInput placeholder="From..." value={sq} onChange={setSq} onSelect={(lat, lon) => setSc({ lat, lon })} isDeparture />
            <SearchInput placeholder="To..." value={eq} onChange={setEndQuery} onSelect={(lat, lon) => setEc({ lat, lon })} />
            <button className="action-btn" onClick={() => doRoute(timeOff)} disabled={loading} style={{marginTop:'10px'}}>{loading ? 'Searching...' : 'Calculate Routes'}</button>
          </div>
          {ui === 'preview' && rd && (
            <div className="ui-section">
              <span className="section-title">Best Routes</span>
              {rd.features.map(f => (
                <div key={f.properties.type} className={`route-card ${active === f.properties.type ? 'active' : ''}`} onClick={() => setActive(f.properties.type)}>
                  <div className="header"><span className="type">{f.properties.type === 'coolest' ? 'Cooler' : 'Efficient'}</span></div>
                  <div className="time" style={{ color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)' }}>{f.properties.time_mins} min</div>
                </div>
              ))}
              <button className="action-btn" onClick={() => setUi('nav')}>Start Walking</button>
              <button className="action-btn secondary" onClick={() => {setUi('search'); setRd(null); setSq(''); setEndQuery(''); setSc(null); setEc(null);}}>Reset</button>
            </div>
          )}
          {ui === 'nav' && (
            <div className="ui-section">
              <span className="section-title">Instructions</span>
              <div className="instructions-list">
                {rd?.features.find(f => f.properties.type === active)?.properties?.instructions?.map((inst, i) => <div key={i} className="instruction-item">{inst}</div>)}
              </div>
              <button className="action-btn secondary" onClick={() => setUi('search')}>Exit</button>
            </div>
          )}
        </div>
      </div>
      <div className="map-container">
        <Compass bearing={vs.bearing} />
        {tintMode && <div style={{position:'absolute', inset:0, background:'rgba(15,23,42,0.5)', pointerEvents:'none', zIndex:1}} />}
        <div className="weather-container">
          <div className="weather-card"><span className="label">Temp</span><span className="value">{weather?.temp != null ? `${Math.round(weather.temp)}°F` : '--'}</span></div>
          <div className="weather-card"><span className="label">Wind</span><span className="value">{weather?.wind_speed != null ? `${weather.wind_speed} km/h` : '--'}</span></div>
        </div>
        <DeckGL viewState={vs} onViewStateChange={({ viewState }) => setVs(viewState)} controller layers={layers} getCursor={({ isDragging }) => isDragging ? 'grabbing' : 'grab'}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}

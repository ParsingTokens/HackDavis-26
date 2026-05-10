import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';

const INIT_VS = { longitude: -121.7495, latitude: 38.5397, zoom: 16, pitch: 45, bearing: 0, transitionDuration: 300 };
const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const treeColor = (n) => {
  if (!n) return [40, 100, 40];
  const l = n.toLowerCase();
  if (l.includes('oak')) return [20, 70, 20];
  return [30, 90, 30];
};

const makeSunTrips = (az, alt) => {
  if (alt <= 0) return [];
  const rays = [];
  const radDir = (az + 180) * Math.PI / 180;
  const dx = 0.0008 * Math.sin(radDir), dy = 0.0008 * Math.cos(radDir);
  const drop = 60 * (alt / 90 + 0.1);
  for (let i = 0; i < 400; i++) {
    const lat = 38.51 + Math.random() * 0.06, lon = -121.78 + Math.random() * 0.06;
    const sz = 200 + Math.random() * 200;
    const path = [];
    for (let j = 0; j < 15; j++) path.push([lon + dx*j, lat + dy*j, sz - drop*j]);
    const off = Math.random() * 10000;
    rays.push({ path, ts: path.map((_, idx) => off + idx * 400) });
  }
  return rays;
};

const makeWindTrips = (dir) => {
  if (dir === undefined) return [];
  const rays = [];
  const rad = (dir - 180) * Math.PI / 180;
  const vx = 0.0012 * Math.sin(rad), vy = 0.0012 * Math.cos(rad);
  const px = -vy * 0.4, py = vx * 0.4;
  for (let i = 0; i < 300; i++) {
    const lat = 38.50 + Math.random() * 0.08, lon = -121.79 + Math.random() * 0.08;
    const z = 8 + Math.random() * 40;
    const path = [];
    path.push([lon, lat, z]);
    path.push([lon + vx * 0.5 + px, lat + vy * 0.5 + py, z]);
    path.push([lon + vx, lat + vy, z]);
    const off = Math.random() * 10000;
    rays.push({ path, ts: path.map((_, idx) => off + idx * 500) });
  }
  return rays;
};

function SearchInput({ placeholder, value, onChange, onSelect, pois, isDeparture }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (value.length > 0 && open && value !== 'Current Location') {
      const v = value.toLowerCase();
      setResults(pois.filter(p => p.name.toLowerCase().includes(v)).slice(0, 10));
    } else { setResults([]); }
  }, [value, open, pois]);
  return (
    <div className="search-input-wrapper">
      <input type="text" placeholder={placeholder} value={value} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} onChange={e => { onChange(e.target.value); setOpen(true); }} />
      {isDeparture && <button className="current-loc-btn" onClick={() => { navigator.geolocation?.getCurrentPosition(p => { onChange('Current Location'); onSelect(p.coords.latitude, p.coords.longitude); }, null, { enableHighAccuracy: true }); }}>Nearby</button>}
      {open && results.length > 0 && (
        <div className="autocomplete-dropdown" style={{display:'block'}}>
          {results.map((r, i) => <div key={i} className="autocomplete-item" onMouseDown={e => { e.preventDefault(); onChange(r.name); onSelect(r.lat, r.lon); setOpen(false); }}>{r.name}</div>)}
        </div>
      )}
    </div>
  );
}

function Compass({ bearing }) {
  return (
    <div className="compass" style={{ transform: `rotate(${-bearing}deg)` }}>
      <div className="compass-ring"><span className="compass-n">N</span><span className="compass-e">E</span><span className="compass-s">S</span><span className="compass-w">W</span><div className="compass-needle" /></div>
    </div>
  );
}

export default function App() {
  const [vs, setVs] = useState(INIT_VS);
  const [ui, setUi] = useState('search');
  const [timeOff, setTimeOff] = useState(0);
  const [tintMode, setTintMode] = useState(false); // Tint disabled by default
  const [theme, setTheme] = useState('dark');
  const [sq, setSq] = useState(''); const [sc, setSc] = useState(null);
  const [eq, setEq] = useState(''); const [ec, setEc] = useState(null);
  const [rd, setRd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [activeRoute, setActiveRoute] = useState('coolest');
  const [trees, setTrees] = useState(null);
  const [bldg, setBldg] = useState(null);
  const [weather, setWeather] = useState(null);
  const [sun, setSun] = useState({ alt: -20, az: 0 });
  const [tick, setTick] = useState(0);
  const [pois, setPois] = useState([]);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(setTrees);
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBldg);
    fetch('http://localhost:8000/pois').then(r => r.json()).then(d => setPois(Array.isArray(d) ? d : []));
    const a = () => { setTick(t => (t + 25) % 15000); requestAnimationFrame(a); };
    const id = requestAnimationFrame(a);
    return () => cancelAnimationFrame(id);
  }, []);

  const doRoute = useCallback(() => {
    if (!sc || !ec) return;
    setLoading(true); setErr(null);
    fetch(`http://localhost:8000/route?start_lat=${sc.lat}&start_lon=${sc.lon}&end_lat=${ec.lat}&end_lon=${ec.lon}&time_offset=${timeOff}`)
      .then(r => r.json()).then(d => {
        setLoading(false);
        if (d.error) setErr(d.error); else { setRd(d); setWeather(d.weather); setUi('preview'); }
      }).catch(() => { setLoading(false); setErr('Connection failed.'); });
  }, [sc, ec, timeOff]);

  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOff}`).then(r => r.json()).then(d => { setSun({ alt: d.altitude, az: d.azimuth }); setTheme(d.altitude > 0 ? 'light' : 'dark'); });
    fetch(`http://localhost:8000/weather?hours_offset=${timeOff}`).then(r => r.json()).then(setWeather);
  }, [timeOff]);

  const sunTrips = useMemo(() => makeSunTrips(sun.az, sun.alt), [sun.az, sun.alt]);
  const windTrips = useMemo(() => makeWindTrips(weather?.wind_dir), [weather?.wind_dir]);

  const layers = [
    bldg && new GeoJsonLayer({
      id: 'bldg', data: bldg, extruded: true, getElevation: d => d.properties?.height || 10,
      getFillColor: theme === 'dark' ? [20, 30, 50, 255] : [120, 130, 150, 255],
      opacity: tintMode ? 0.3 : 1, material: { ambient: 0.8, diffuse: 0.2 }
    }),
    trees?.features && [
      new ColumnLayer({ id: 'tr', data: trees.features, getPosition: d => d.geometry.coordinates, getFillColor: [60, 40, 20], radius: 0.5, extruded: true, getElevation: 3 }),
      new ColumnLayer({ id: 'cy', data: trees.features, getPosition: d => d.geometry.coordinates, getFillColor: d => [...treeColor(d.properties.common), 220], radius: 4, extruded: true, getElevation: 8, opacity: tintMode ? 0.3 : 1 })
    ],
    rd?.features.map(f => {
      const a = activeRoute === f.properties.type;
      // BRIGHT paths in tint mode
      const coolColor = tintMode ? [0, 255, 255, a ? 255 : 120] : [0, 150, 220, a ? 255 : 120];
      const effColor = tintMode ? [255, 220, 0, a ? 255 : 120] : [255, 120, 0, a ? 255 : 120];
      return new GeoJsonLayer({
        id: `r-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'coolest' ? coolColor : effColor,
        getLineWidth: a ? 14 : 7, parameters: { depthTest: false }
      });
    }),
    sun.alt > 0 && new TripsLayer({
      id: 'sun', data: sunTrips, getPath: d => d.path, getTimestamps: d => d.ts,
      // VIBRANT YELLOW in tint mode
      getColor: tintMode ? [255, 255, 100, 255] : [255, 240, 150, 200], 
      widthMinPixels: tintMode ? 6 : 4, trailLength: 6000, currentTime: tick, parameters: { depthTest: false }
    }),
    new TripsLayer({
      id: 'wind', data: windTrips, getPath: d => d.path, getTimestamps: d => d.ts,
      // PURE WHITE in tint mode
      getColor: tintMode ? [255, 255, 255, 255] : [240, 240, 240, 200], 
      widthMinPixels: tintMode ? 4 : 3, trailLength: 2500, currentTime: tick, parameters: { depthTest: false }
    })
  ].flat().filter(Boolean);

  const clock = (off) => { const d = new Date(); d.setHours(d.getHours() + off); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header"><h1>Canopy</h1></div>
        <div className="sidebar-content">
          <div className="ui-section">
            <span className="section-title">Schedule</span>
            <div className="input-group" style={{flexDirection:'row', alignItems:'center', gap:'12px'}}>
              <input type="number" value={timeOff} onChange={e => setTimeOff(parseFloat(e.target.value))} 
                style={{width:'80px', padding:'12px', fontSize:'1.2rem', fontWeight:800, borderRadius:'10px', border:'2px solid var(--primary-accent)'}} />
              <span style={{fontWeight:700}}>Hours ahead</span>
            </div>
            <div style={{marginTop:'12px', fontSize:'1rem', color:'var(--primary-accent)', fontWeight:800}}>Forecast: {clock(timeOff)}</div>
            <button className={`action-btn secondary ${tintMode ? 'active' : ''}`} onClick={() => setTintMode(!tintMode)} style={{marginTop:'15px'}}>
              {tintMode ? 'Visual Tint: ON' : 'Visual Tint: OFF'}
            </button>
          </div>
          <div className="ui-section">
            <span className="section-title">Navigation</span>
            <SearchInput placeholder="From Building" value={sq} onChange={setSq} onSelect={(lat, lon) => setSc({ lat, lon })} pois={pois} isDeparture />
            <SearchInput placeholder="To Building" value={eq} onChange={setEq} onSelect={(lat, lon) => setEc({ lat, lon })} pois={pois} />
            <button className="action-btn" onClick={doRoute} disabled={loading} style={{marginTop:'12px'}}>{loading ? 'Calculating...' : 'Go'}</button>
          </div>
          {ui === 'preview' && rd && (
            <div className="ui-section">
              {rd.features.map(f => (
                <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                  <div style={{fontWeight:800}}>{f.properties.type === 'coolest' ? 'Cooler' : 'Efficient'}</div>
                  <div style={{fontSize:'1.3rem', color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)', fontWeight:900}}>{f.properties.time_mins} min</div>
                </div>
              ))}
              <button className="action-btn" onClick={() => setUi('nav')} style={{marginTop:'12px'}}>Start Walking</button>
              <button className="action-btn secondary" onClick={() => {setUi('search'); setRd(null); setSq(''); setEq(''); setSc(null); setEc(null);}}>Reset</button>
            </div>
          )}
          {ui === 'nav' && (
            <div className="ui-section">
              {rd?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, i) => <div key={i} className="instruction-item" style={{padding:'10px 0', borderBottom:'1px solid #eee', fontSize:'0.9rem'}}>{inst}</div>)}
              <button className="action-btn secondary" onClick={() => setUi('search')} style={{marginTop:'12px'}}>End Trip</button>
            </div>
          )}
        </div>
      </div>
      <div className="map-container">
        {tintMode && <div style={{position:'absolute', inset:0, background:'rgba(5,10,25,0.75)', pointerEvents:'none', zIndex:1}} />}
        <DeckGL viewState={vs} onViewStateChange={({ viewState }) => setVs(viewState)} controller layers={layers}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} />
        </DeckGL>
      </div>
    </>
  );
}

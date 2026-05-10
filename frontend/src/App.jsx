import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import Map from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { GeoJsonLayer, ColumnLayer, PolygonLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { TripsLayer } from '@deck.gl/geo-layers';

const INIT_VS = { longitude: -121.7495, latitude: 38.5397, zoom: 16, pitch: 45, bearing: 0, transitionDuration: 300 };
const THEMES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const treeColor = (n) => {
  if (!n) return [140, 210, 140];
  const l = n.toLowerCase();
  if (l.includes('oak')) return [120, 190, 120];
  return [150, 220, 150];
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

const sphereMesh = new SphereGeometry({
  nlat: 24,
  nlong: 24,
  radius: 1
});

export default function App() {
  const [vs, setVs] = useState(INIT_VS);
  const [ui, setUi] = useState('search');
  const [activeTab, setActiveTab] = useState('nav');
  
  // Time state
  const getCurrentTimeString = () => {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  };
  const [selectedTime, setSelectedTime] = useState(getCurrentTimeString());
  
  // Calculate time offset in hours from the selected time vs current time
  const timeOff = useMemo(() => {
    const now = new Date();
    const [hours, mins] = selectedTime.split(':').map(Number);
    const selectedDate = new Date();
    selectedDate.setHours(hours, mins, 0, 0);
    
    // If selected time is earlier than current time, assume it's for tomorrow
    if (selectedDate < now && (now.getTime() - selectedDate.getTime()) > 1000 * 60 * 60) {
      selectedDate.setDate(selectedDate.getDate() + 1);
    }
    
    return (selectedDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  }, [selectedTime]);

  const [tintMode, setTintMode] = useState(false);
  const [theme, setTheme] = useState('light');
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
  const [communitySpots, setCommunitySpots] = useState([]);
  const [isDroppingPin, setIsDroppingPin] = useState(false);
  const [selectedPin, setSelectedPin] = useState(null);

  useEffect(() => {
    fetch('http://localhost:8000/trees').then(r => r.json()).then(d => {
      if (d.features) {
        d.features.forEach(f => {
          f.properties.rScale = 2.5 + Math.random() * 2.5;
          f.properties.hScale = 2.0 + Math.random() * 2.0;
          f.properties.zOff = 3 + Math.random() * 4;
        });
      }
      setTrees(d);
    });
    fetch('http://localhost:8000/buildings').then(r => r.json()).then(setBldg);
    fetch('http://localhost:8000/pois').then(r => r.json()).then(d => setPois(Array.isArray(d) ? d : []));
    fetch('http://localhost:8000/community_spots').then(r => r.json()).then(d => {
      const spots = (d.features || []).map(s => ({...s, properties: {...s.properties, votes: s.properties.votes || 0}, id: Math.random()}));
      setCommunitySpots(spots);
    });
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
        if (d.error) setErr(d.error); else { setRd(d); setWeather(d.weather); setUi('preview'); setActiveTab('nav'); }
      }).catch(() => { setLoading(false); setErr('Connection failed.'); });
  }, [sc, ec, timeOff]);

  useEffect(() => {
    fetch(`http://localhost:8000/sun_position?hours_offset=${timeOff}`).then(r => r.json()).then(d => { 
      setSun({ alt: d.altitude, az: d.azimuth }); 
      setTheme(d.altitude > 0 ? 'light' : 'dark'); 
    });
    fetch(`http://localhost:8000/weather?hours_offset=${timeOff}`).then(r => r.json()).then(setWeather);
  }, [timeOff]);

  const handleMapClick = (info) => {
    if (info.object && info.layer && info.layer.id.includes('community-pins-head')) {
      const clickedPin = info.object;
      const updatedSpots = communitySpots.map(s => {
        if (s.id === clickedPin.id) return { ...s, properties: { ...s.properties, votes: s.properties.votes + 1 }};
        return s;
      });
      setCommunitySpots(updatedSpots);
      const newlyUpdatedPin = updatedSpots.find(s => s.id === clickedPin.id);
      setSelectedPin({ ...newlyUpdatedPin, x: info.x, y: info.y, showAnim: true });
      setTimeout(() => setSelectedPin(prev => prev && prev.id === clickedPin.id ? { ...prev, showAnim: false } : prev), 1000);
      return;
    }

    if (isDroppingPin && info.coordinate) {
      const name = window.prompt("Give Suggested Name:");
      if (name) {
        const n = { 
          id: Math.random(),
          type: 'Feature', 
          properties: { name: name, description: "Community suggested spot", votes: 0 }, 
          geometry: { type: 'Point', coordinates: info.coordinate } 
        };
        setCommunitySpots([n, ...communitySpots]);
      }
      setIsDroppingPin(false);
    } else {
      setSelectedPin(null);
    }
  };

  const sunTrips = useMemo(() => makeSunTrips(sun.az, sun.alt), [sun.az, sun.alt]);
  const windTrips = useMemo(() => makeWindTrips(weather?.wind_dir), [weather?.wind_dir]);

  const layers = [
    tintMode && new PolygonLayer({
      id: 'dim-overlay',
      data: [{ polygon: [[-180, 90], [180, 90], [180, -90], [-180, -90], [-180, 90]] }],
      getPolygon: d => d.polygon,
      getFillColor: [10, 20, 20, 200],
      parameters: { depthTest: false }
    }),
    bldg && new GeoJsonLayer({
      id: 'bldg', data: bldg, extruded: true, 
      getElevation: d => (d.properties?.height || 10) * 0.5 + 8, // Shorter than before, but taller than max tree height (7)
      getFillColor: theme === 'dark' ? [40, 50, 45, 255] : [170, 180, 175, 255],
      opacity: tintMode ? 0.3 : 1, material: { ambient: 0.8, diffuse: 0.2 }
    }),
    trees?.features && [
      new ColumnLayer({ id: 'tr', data: trees.features, getPosition: d => d.geometry.coordinates, getFillColor: [120, 90, 70], radius: 0.6, extruded: true, getElevation: d => d.properties.zOff }),
      new SimpleMeshLayer({
        id: 'cy',
        data: trees.features,
        mesh: sphereMesh,
        getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.zOff],
        getColor: d => [...treeColor(d.properties.common), tintMode ? 75 : 240],
        getScale: d => [d.properties.rScale, d.properties.rScale, d.properties.hScale],
        getOrientation: d => [0, 0, Math.random() * 360],
        material: { ambient: 0.7, diffuse: 0.6 }
      })
    ],
    rd?.features && rd.features.map(f => {
      const a = activeRoute === f.properties.type;
      const coolColor = tintMode ? [162, 210, 255, a ? 255 : 120] : [120, 180, 240, a ? 255 : 120];
      const effColor = tintMode ? [251, 191, 36, a ? 255 : 120] : [245, 158, 11, a ? 255 : 120];
      return new GeoJsonLayer({
        id: `r-${f.properties.type}`, data: f, lineWidthUnits: 'pixels',
        getLineColor: f.properties.type === 'coolest' ? coolColor : effColor,
        getLineWidth: a ? 14 : 7, parameters: { depthTest: false }
      });
    }),
    sun.alt > 0 && new TripsLayer({
      id: 'sun', data: sunTrips, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: tintMode ? [255, 240, 100, 255] : [255, 220, 80, 200],
      widthMinPixels: tintMode ? 6 : 4, trailLength: 6000, currentTime: tick, parameters: { depthTest: false }
    }),
    new TripsLayer({
      id: 'wind', data: windTrips, getPath: d => d.path, getTimestamps: d => d.ts,
      getColor: tintMode ? [255, 255, 255, 255] : [240, 250, 245, 200], 
      widthMinPixels: tintMode ? 4 : 3, trailLength: 2500, currentTime: tick, parameters: { depthTest: false }
    }),
    communitySpots.length > 0 && [
      new ColumnLayer({
        id: 'community-pins-needle', data: communitySpots, getPosition: d => d.geometry.coordinates,
        getFillColor: [100, 100, 100, 255], radius: 1.0, extruded: true, getElevation: 40
      }),
      new SimpleMeshLayer({
        id: 'community-pins-head', data: communitySpots, mesh: sphereMesh,
        getPosition: d => [d.geometry.coordinates[0], d.geometry.coordinates[1], 40],
        getColor: d => [239, 68, 68, 255], getScale: d => [8, 8, 8], pickable: true,
        material: { ambient: 0.8, diffuse: 0.5 }
      })
    ]
  ].flat().filter(Boolean);

  const bestTimeToLeave = () => {
    const selectedHr = parseInt(selectedTime.split(':')[0], 10);
    if (selectedHr >= 10 && selectedHr <= 16) return "To minimize sun exposure, leaving around 6:30 PM is highly recommended.";
    if (selectedHr < 8 || selectedHr >= 18) return "Current time is optimal for thermal efficiency! Enjoy the walk.";
    return "Leaving before 9:00 AM or after 5:00 PM is best for thermal comfort.";
  };

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header" style={{ display: 'flex', justifyContent: 'center' }}>
          <img src="/logo.png" alt="Canopy Logo" style={{ height: '140px', width: '100%', objectFit: 'contain' }} />
        </div>
        <div style={{ display: 'flex', padding: '0 24px', gap: '12px', marginBottom: '16px' }}>
          <button onClick={() => setActiveTab('nav')} style={{ flex: 1, padding: '12px', background: activeTab === 'nav' ? 'var(--primary-dark)' : 'var(--surface-color)', color: activeTab === 'nav' ? '#fff' : 'var(--text-main)', border: '2px solid var(--primary-dark)', borderRadius: '14px', fontWeight: '700', cursor: 'pointer', transition: 'all 0.3s' }}>Navigation</button>
          <button onClick={() => setActiveTab('community')} style={{ flex: 1, padding: '12px', background: activeTab === 'community' ? 'var(--cool-blue)' : 'var(--surface-color)', color: activeTab === 'community' ? '#fff' : 'var(--text-main)', border: '2px solid var(--cool-blue)', borderRadius: '14px', fontWeight: '700', cursor: 'pointer', transition: 'all 0.3s' }}>Community</button>
        </div>
        <div className="sidebar-content">
          {activeTab === 'nav' ? (
            <>
              <div className="ui-section">
                <span className="section-title">Schedule</span>
                <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: '16px'}}>
                    <input type="time" value={selectedTime} onChange={e => setSelectedTime(e.target.value)} 
                      style={{width:'110px', padding:'12px', fontSize:'1.2rem', fontWeight:700, borderRadius:'16px', border:'2px solid var(--primary-accent)', outline:'none', color:'var(--text-primary)', textAlign: 'center', fontFamily: 'inherit'}} />
                    <div style={{display: 'flex', flexDirection: 'column'}}>
                      <span style={{fontWeight:700, color:'var(--text-secondary)'}}>Departure Time</span>
                    </div>
                  </div>
                </div>
                <button className={`action-btn secondary ${tintMode ? 'active' : ''}`} onClick={() => setTintMode(!tintMode)} style={{marginTop:'4px', width: 'auto'}}>
                  {tintMode ? 'Visual Tint: ON' : 'Visual Tint: OFF'}
                </button>
              </div>
              <div className="ui-section">
                <span className="section-title">Navigation</span>
                <SearchInput placeholder="From Building" value={sq} onChange={setSq} onSelect={(lat, lon) => setSc({ lat, lon })} pois={pois} isDeparture />
                <SearchInput placeholder="To Building" value={eq} onChange={setEq} onSelect={(lat, lon) => setEc({ lat, lon })} pois={pois} />
                <button className="action-btn" onClick={doRoute} disabled={loading} style={{marginTop:'10px'}}>{loading ? 'Calculating...' : 'Let\'s Go!'}</button>
              </div>
              {ui === 'preview' && rd && (
                <div className="ui-section">
                  {rd.features.map(f => (
                    <div key={f.properties.type} className={`route-card ${activeRoute === f.properties.type ? 'active' : ''}`} onClick={() => setActiveRoute(f.properties.type)}>
                      <div style={{fontWeight:700, color: 'var(--text-secondary)'}}>{f.properties.type === 'coolest' ? 'Cooler Path' : 'Efficient Path'}</div>
                      <div style={{fontSize:'1.5rem', color: f.properties.type === 'coolest' ? 'var(--cool-blue)' : 'var(--warm-orange)', fontWeight:800}}>{f.properties.time_mins} min</div>
                    </div>
                  ))}
                  <div style={{background: '#fef3c7', padding: '12px', borderRadius: '12px', border: '1px solid #fde68a', color: '#b45309', fontWeight: 600, fontSize: '0.85rem'}}>
                    💡 <strong>Recommendation:</strong> {bestTimeToLeave()}
                  </div>
                  <button className="action-btn" onClick={() => setUi('nav')} style={{marginTop:'10px'}}>Start Walking</button>
                  <button className="action-btn secondary" onClick={() => {setUi('search'); setRd(null); setSq(''); setEq(''); setSc(null); setEc(null);}} style={{marginTop:'10px'}}>Reset</button>
                </div>
              )}
              {ui === 'nav' && (
                <div className="ui-section">
                  {rd?.features.find(f => f.properties.type === activeRoute)?.properties?.instructions?.map((inst, i) => <div key={i} className="instruction-item" style={{padding:'12px 0', borderBottom:'1px solid var(--bg-color)', fontSize:'0.95rem', fontWeight:500}}>{inst}</div>)}
                  <button className="action-btn secondary" onClick={() => setUi('search')} style={{marginTop:'10px'}}>End Trip</button>
                </div>
              )}
            </>
          ) : (
            <div className="ui-section">
              <span className="section-title">Share a Spot</span>
              {isDroppingPin ? (
                <div style={{padding: '16px', background: '#ecfdf5', borderRadius: '16px', border: '1px solid #10b98133', color: '#065f46', fontWeight: 600, textAlign: 'center'}}>
                  Click anywhere on the map to drop a pin!
                </div>
              ) : (
                <button className="action-btn" onClick={() => setIsDroppingPin(true)} style={{marginBottom:'10px'}}>Drop Pin on Map</button>
              )}
              
              <span className="section-title" style={{marginTop:'20px'}}>Community Shade Spots</span>
              {communitySpots.map((s, i) => (
                <div key={i} className="route-card" style={{ cursor: 'default', border: '2px solid var(--cool-blue)', boxShadow: 'none' }}>
                  <div style={{fontWeight:800, color: 'var(--cool-blue)', fontSize:'1.1rem'}}>{s.properties.name}</div>
                  <div style={{fontSize:'0.95rem', marginTop:'8px', fontWeight:500}}>{s.properties.description}</div>
                  <div style={{fontSize:'0.8rem', marginTop:'12px', color:'var(--text-secondary)', fontWeight:700}}>Votes: {s.properties.votes}</div>
                </div>
              ))}
              {communitySpots.length === 0 && <div style={{padding:'10px', color:'var(--text-secondary)'}}>No community spots loaded.</div>}
            </div>
          )}
        </div>
      </div>
      <div className="map-container" style={{ cursor: isDroppingPin ? 'crosshair' : 'default' }}>
        <Compass bearing={vs.bearing} />
        <DeckGL viewState={vs} onViewStateChange={({ viewState }) => setVs(viewState)} controller layers={layers} onClick={handleMapClick}>
          <Map mapStyle={THEMES[theme]} mapLib={maplibregl} attributionControl={false} />
        </DeckGL>
        {selectedPin && (
          <div style={{
            position: 'absolute', zIndex: 1000, pointerEvents: 'none',
            left: selectedPin.x, top: selectedPin.y, transform: 'translate(-50%, -120%)',
            background: 'rgba(255, 255, 255, 0.95)', padding: '12px 16px', borderRadius: '16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column',
            alignItems: 'center', transition: 'all 0.2s', border: '2px solid var(--cool-blue)'
          }}>
            <div style={{fontWeight: 800, color: 'var(--cool-blue)', fontSize: '1.1rem'}}>{selectedPin.properties.name}</div>
            <div style={{fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px'}}>
              <span>Upvotes: {selectedPin.properties.votes}</span>
              {selectedPin.showAnim && (
                <span style={{
                  color: 'var(--primary-dark)', fontWeight: 800, animation: 'floatUp 1s ease-out forwards', position: 'absolute', right: '-15px'
                }}>+1</span>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

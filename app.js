const jaipur = [26.9124, 75.7873];
const demoPools = [
  { id: 'pool-101', host: 'Ananya', from: 'Mansarovar', stops: ['Civil Lines'], to: 'Jaipur Junction', time: '2026-08-02T08:30', seats: 2, route: [[26.852,75.772],[26.899,75.781],[26.920,75.790]] },
  { id: 'pool-102', host: 'Rohan', from: 'Mansarovar', stops: ['Sodala', 'Civil Lines'], to: 'Jaipur Junction', time: '2026-08-02T09:00', seats: 3, route: [[26.852,75.772],[26.894,75.775],[26.899,75.781],[26.920,75.790]] },
  { id: 'pool-103', host: 'Meera', from: 'Vaishali Nagar', stops: ['Civil Lines', 'MI Road'], to: 'Jaipur Junction', time: '2026-08-02T18:10', seats: 1, route: [[26.912,75.744],[26.899,75.781],[26.913,75.802],[26.920,75.790]] }
];
let pools = [...demoPools], fares = [], map, pickupMarker, dropoffMarker, routeLine, activePin = 'pickup';
let pickupPoint = null, dropoffPoint = null, selectedRoute = [];
const $ = (selector) => document.querySelector(selector);
const formatTime = (value) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const futureDefault = () => { const d = new Date(Date.now() + 60 * 60 * 1000); d.setMinutes(0, 0, 0); return d.toISOString().slice(0, 16); };
const normalize = (place) => place.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const routeFor = (pool) => [pool.from, ...(pool.stops || []), pool.to];
const escapeHTML = (value) => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const debounce = (fn, delay = 300) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

async function geocode(query) {
  if (!query || query.length < 3) return [];
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&addressdetails=1&limit=6&countrycodes=in`;
    const response = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const results = await response.json();
    return Array.isArray(results) ? results.map(item => ({
      label: item.display_name,
      point: [parseFloat(item.lat), parseFloat(item.lon)]
    })) : [];
  } catch {
    return [];
  }
}

function clearSuggestions(container) {
  container.innerHTML = '';
  container.style.display = 'none';
}

function showSuggestions(container, items, onSelect) {
  container.innerHTML = '';
  if (!items.length) {
    clearSuggestions(container);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'suggestion';
    row.tabIndex = 0;
    row.textContent = item.label;
    row.addEventListener('click', () => onSelect(item));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(item);
      }
    });
    container.appendChild(row);
  }
  container.style.display = 'block';
}

function attachAutocomplete(fieldId, containerId, onSelect) {
  const field = $(fieldId);
  const container = $(containerId);
  if (!field || !container) return;

  const update = debounce(async () => {
    const query = field.value.trim();
    if (!query) { clearSuggestions(container); return; }
    const items = await geocode(query);
    showSuggestions(container, items, item => {
      field.value = item.label;
      clearSuggestions(container);
      if (typeof onSelect === 'function') onSelect(item);
    });
  }, 250);

  field.addEventListener('input', update);
  field.addEventListener('focus', update);
  field.addEventListener('blur', () => setTimeout(() => clearSuggestions(container), 150));
}

async function useCurrentLocation() {
  if (!navigator.geolocation) {
    $('#status').textContent = 'Location access is not supported by this browser.';
    return;
  }

  $('#status').textContent = 'Locating you…';
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    $('#status').textContent = 'Current location found.';
    placePin(activePin, { lat: coords.latitude, lng: coords.longitude });
  }, (error) => {
    $('#status').textContent = `Unable to access location: ${error.message}`;
  }, { enableHighAccuracy: true, timeout: 10000 });
}
function demoFares(from, to, time) {
  const seed = [...`${from}${to}${time}`].reduce((sum, char) => sum + char.charCodeAt(0), 0), base = 115 + (seed % 40);
  return [{ provider: 'Ola', service: 'Auto', price: base - 18, bookingUrl: 'https://www.olacabs.com/' }, { provider: 'Uber', service: 'Hatchback / Go', price: base + 4, bookingUrl: 'https://www.uber.com/in/en/' }, { provider: 'Rapido', service: 'Auto', price: base - 12, bookingUrl: 'https://www.rapido.bike/' }, { provider: 'Ola', service: 'Sedan / Prime', price: base + 42, bookingUrl: 'https://www.olacabs.com/' }, { provider: 'Uber', service: 'SUV / XL', price: base + 82, bookingUrl: 'https://www.uber.com/in/en/' }];
}
function renderFares() {
  const lowest = Math.min(...fares.map(fare => fare.price));
  $('#fareCards').innerHTML = fares.slice().sort((a,b) => a.price - b.price).map(fare => `<article class="fare-card ${fare.price === lowest ? 'lowest' : ''}">${fare.price === lowest ? '<span class="badge">LOWEST</span>' : ''}<div class="provider">${fare.provider}</div><p class="ride-type">${fare.service}</p><div class="amount">₹${fare.price}<small> estimated</small></div><p class="range">Typical fare range for this trip</p><a href="${fare.bookingUrl}" target="_blank" rel="noopener"><button class="secondary">Open ${fare.provider}</button></a></article>`).join('');
}
function distanceKm(a, b) { const rad = Math.PI / 180, x = (b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) * rad / 2), y = (b[0] - a[0]) * rad; return 6371 * Math.sqrt(x*x + y*y); }
function routePosition(route, point) { let nearest = { index:-1, distance:Infinity }; route.forEach((routePoint, index) => { const distance = distanceKm(routePoint, point); if (distance < nearest.distance) nearest = { index, distance }; }); return nearest.distance <= 1 ? nearest.index : -1; }
function mapRouteMatch(pool) { if (!pickupPoint || !dropoffPoint || !Array.isArray(pool.route) || pool.route.length < 2) return null; const start = routePosition(pool.route, pickupPoint), end = routePosition(pool.route, dropoffPoint); return start !== -1 && end !== -1 && start < end; }
function matchesRoute(pool, from, to) {
  const mapMatch = mapRouteMatch(pool); if (mapMatch !== null) return mapMatch;
  const stops = routeFor(pool).map(normalize), pickup = normalize(from), drop = normalize(to), pickupIndex = stops.indexOf(pickup), dropIndex = stops.indexOf(drop);
  return pickupIndex !== -1 && dropIndex !== -1 && pickupIndex < dropIndex;
}
function renderPools() {
  const from = $('#from').value.trim(), to = $('#to').value.trim(), matches = pools.filter(pool => matchesRoute(pool, from, to));
  $('#poolCount').textContent = `${matches.length} matching pool${matches.length === 1 ? '' : 's'}`; $('#noPools').style.display = matches.length ? 'none' : 'block';
  $('#poolList').innerHTML = matches.map(pool => `<article class="pool"><div><h3>${escapeHTML(pool.host)}'s pool</h3><div class="pool-info"><span><strong>${escapeHTML(routeFor(pool).join(' → '))}</strong></span><span>${formatTime(pool.time)}</span><span>${pool.seats} seat${pool.seats === 1 ? '' : 's'} left</span></div></div><button class="join" data-id="${pool.id}" ${pool.seats < 1 ? 'disabled' : ''}>${pool.seats < 1 ? 'Full' : 'Join pool'}</button></article>`).join('');
  document.querySelectorAll('.join').forEach(button => button.addEventListener('click', () => joinPool(button.dataset.id)));
}
async function api(path, options) { if (location.protocol === 'file:') throw new Error('Static demo'); const response = await fetch(path, options); if (!response.ok) throw new Error('Server unavailable'); return response.json(); }
async function search() {
  const from = $('#from').value.trim(), to = $('#to').value.trim(), at = $('#scheduledAt').value;
  $('#routeLabel').textContent = `${from} → ${to}`; $('#poolFrom').value = from; $('#poolTo').value = to; $('#poolTime').value = at;
  try { const data = await api(`/api/fares?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&at=${encodeURIComponent(at)}`); fares = data.fares; pools = await api('/api/pools'); $('#status').textContent = data.notice; }
  catch { fares = demoFares(from, to, at); $('#status').textContent = 'Showing built-in demo data. Run the backend for saved pool bookings.'; }
  renderFares(); renderPools();
}
async function joinPool(id) { try { const updated = await api(`/api/pools/${id}/join`, { method: 'POST' }); pools = pools.map(pool => pool.id === id ? updated : pool); } catch { pools = pools.map(pool => pool.id === id ? { ...pool, seats: Math.max(0, pool.seats - 1) } : pool); } renderPools(); }

function setMode(mode) { activePin = mode; document.querySelectorAll('.map-action').forEach(button => button.classList.toggle('active', button.dataset.mapMode === mode)); $('#mapHint').textContent = mode === 'pickup' ? 'Click the map to place your pickup.' : 'Click the map to place your drop point.'; }
async function reverseName(point) { try { const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${point[0]}&lon=${point[1]}&zoom=16`); const data = await response.json(); return (data.display_name || '').split(',').slice(0, 2).join(', ') || `${point[0].toFixed(5)}, ${point[1].toFixed(5)}`; } catch { return `${point[0].toFixed(5)}, ${point[1].toFixed(5)}`; } }
async function drawRoute() {
  if (!pickupPoint || !dropoffPoint) return;
  $('#mapStatus').textContent = 'Finding the driving route…';
  try { const url = `https://router.project-osrm.org/route/v1/driving/${pickupPoint[1]},${pickupPoint[0]};${dropoffPoint[1]},${dropoffPoint[0]}?overview=full&geometries=geojson`; const response = await fetch(url); const data = await response.json(); if (!data.routes?.[0]) throw new Error('No route'); selectedRoute = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]); $('#mapStatus').textContent = 'Route ready. Pools can now match your pinned pickup and drop points.'; }
  catch { selectedRoute = [pickupPoint, dropoffPoint]; $('#mapStatus').textContent = 'A simple route line is shown. Type route stops for more exact matching.'; }
  if (routeLine) map.removeLayer(routeLine); routeLine = L.polyline(selectedRoute, { color:'#126a56', weight:5 }).addTo(map); map.fitBounds(routeLine.getBounds(), { padding:[35,35] }); renderPools();
}
async function placePin(mode, latlng) {
  const point = [latlng.lat, latlng.lng];
  const oldMarker = mode === 'pickup' ? pickupMarker : dropoffMarker;
  if (oldMarker) map.removeLayer(oldMarker);
  const marker = L.marker(point, { draggable:true }).addTo(map).bindPopup(mode === 'pickup' ? 'Pickup' : 'Drop point');
  if (mode === 'pickup') pickupMarker = marker; else dropoffMarker = marker;
  marker.on('dragend', event => placePin(mode, event.target.getLatLng()));
  if (mode === 'pickup') pickupPoint = point; else dropoffPoint = point;
  const name = await reverseName(point); if (mode === 'pickup') $('#from').value = name; else $('#to').value = name;
  if (pickupPoint && dropoffPoint) { await drawRoute(); search(); } else { setMode(mode === 'pickup' ? 'dropoff' : 'pickup'); }
}
function initialiseMap() {
  if (!window.L) { $('#mapStatus').textContent = 'The map could not load. You can still create pools by typing route locations.'; return; }
  map = L.map('map').setView(jaipur, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap contributors' }).addTo(map);
  map.on('click', event => placePin(activePin, event.latlng));
  document.querySelectorAll('.map-action').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mapMode)));
  $('#locateMe').addEventListener('click', useCurrentLocation);
  attachAutocomplete('#from', '#fromSuggestions');
  attachAutocomplete('#to', '#toSuggestions');
  attachAutocomplete('#poolFrom', '#poolFromSuggestions');
  attachAutocomplete('#poolTo', '#poolToSuggestions');
}
$('#searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
$('#poolForm').addEventListener('submit', async event => { event.preventDefault(); const stops = $('#poolStops').value.split(',').map(stop => stop.trim()).filter(Boolean); const pool = { host: $('#hostName').value.trim(), from: $('#poolFrom').value.trim(), to: $('#poolTo').value.trim(), stops, time: $('#poolTime').value, seats: Number($('#seats').value), route: selectedRoute }; try { const created = await api('/api/pools', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pool) }); pools.push(created); } catch { pools.push({ ...pool, id:`local-${Date.now()}` }); } event.target.reset(); $('#status').textContent = 'Your scheduled pool is ready for people to join.'; renderPools(); });
const firstAvailableTime = futureDefault(); $('#scheduledAt').min = firstAvailableTime; $('#poolTime').min = firstAvailableTime; $('#scheduledAt').value = firstAvailableTime; initialiseMap(); search();

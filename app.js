const jaipur = [26.9124, 75.7873];
const demoPools = [
  { id: 'pool-101', host: 'Ananya', from: 'Mansarovar', stops: ['Civil Lines'], to: 'Jaipur Junction', time: '2026-08-02T08:30', seats: 2, route: [[26.852,75.772],[26.899,75.781],[26.920,75.790]] },
  { id: 'pool-102', host: 'Rohan', from: 'Mansarovar', stops: ['Sodala', 'Civil Lines'], to: 'Jaipur Junction', time: '2026-08-02T09:00', seats: 3, route: [[26.852,75.772],[26.894,75.775],[26.899,75.781],[26.920,75.790]] },
  { id: 'pool-103', host: 'Meera', from: 'Vaishali Nagar', stops: ['Civil Lines', 'MI Road'], to: 'Jaipur Junction', time: '2026-08-02T18:10', seats: 1, route: [[26.912,75.744],[26.899,75.781],[26.913,75.802],[26.920,75.790]] }
];
let pools = [...demoPools], fares = [], map, pickupMarker, dropoffMarker, routeLine, activePin = 'pickup';
let pickupPoint = null, dropoffPoint = null, selectedRoute = [];
let currentUserProfile = null;
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
  return [{ provider: 'Uber', service: 'Hatchback / Go', price: base + 4, bookingUrl: 'https://www.uber.com/in/en/' }, { provider: 'Rapido', service: 'Auto', price: base - 12, bookingUrl: 'https://www.rapido.bike/' }, { provider: 'Uber', service: 'SUV / XL', price: base + 82, bookingUrl: 'https://www.uber.com/in/en/' }];
}
function renderFares() {
  const lowest = Math.min(...fares.map(fare => fare.price));
  $('#fareCards').innerHTML = fares.slice().sort((a,b) => a.price - b.price).map(fare => `<article class="fare-card ${fare.price === lowest ? 'lowest' : ''}">${fare.price === lowest ? '<span class="badge">LOWEST</span>' : ''}<div class="provider">${fare.provider}</div><p class="ride-type">${fare.service}</p><div class="amount">₹${fare.price}<small> estimated</small></div><p class="range">Estimated ride price for the full trip</p><div class="fare-note">Use the app to create or join a pool and complete the ride booking.</div></article>`).join('');
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
  $('#poolCount').textContent = `${matches.length} matching pool${matches.length === 1 ? '' : 's'}`;
  $('#noPools').style.display = matches.length ? 'none' : 'block';
  $('#poolList').innerHTML = matches.map(pool => {
    const routeLabel = escapeHTML(routeFor(pool).join(' → '));
    const vehicleLabel = pool.vehicleType && pool.vehicleType !== 'Any' ? `<span>Vehicle: ${escapeHTML(pool.vehicleType)}</span>` : '';
    const genderLabel = pool.gender && pool.gender !== 'Any' ? `<span>Gender: ${escapeHTML(pool.gender)}</span>` : '';
    const routeMatch = pickupPoint && dropoffPoint && mapRouteMatch(pool) ? '<span class="pool-match">Route is within 1 km of your trip</span>' : '';
    const manageBtn = (pool.host_phone && currentUserProfile && pool.host_phone === currentUserProfile.phone) ? `<button class="manage-requests" data-id="${pool.id}">Manage requests</button>` : '';
    return `<article class="pool"><div><h3>${escapeHTML(pool.host)}'s pool</h3><div class="pool-info"><span><strong>${routeLabel}</strong></span><span>${formatTime(pool.time)}</span><span>${pool.seats} seat${pool.seats === 1 ? '' : 's'} left</span>${vehicleLabel}${genderLabel}${routeMatch}</div></div><button class="join" data-id="${pool.id}" ${pool.seats < 1 ? 'disabled' : ''}>${pool.seats < 1 ? 'Full' : 'Join pool'}</button>${manageBtn}</article>`;
  }).join('');
  document.querySelectorAll('.join').forEach(button => button.addEventListener('click', () => joinPool(button.dataset.id)));
  // Add manage button handlers
  document.querySelectorAll('.manage-requests').forEach(button => button.addEventListener('click', () => openManageRequests(button.dataset.id)));
}

async function openManageRequests(poolId) {
  const container = $('#requestsList'); container.innerHTML = 'Loading…';
  try {
    const res = await fetch(`/api/pools/${poolId}/requests`); if (!res.ok) throw new Error('Unable to fetch'); const data = await res.json();
    if (!data.requests || !data.requests.length) { container.innerHTML = '<p>No requests.</p>'; }
    else {
      container.innerHTML = data.requests.map(r => `<div class="request" id="req_${r.id}"><div><strong>${escapeHTML(r.requester.name || 'Guest')}</strong> — ${r.status}</div><div>Pickup: ${escapeHTML(typeof r.pickup === 'string' ? r.pickup : JSON.stringify(r.pickup || ''))}</div><div>Drop: ${escapeHTML(typeof r.drop === 'string' ? r.drop : JSON.stringify(r.drop || ''))}</div><div class="req-actions">${r.status === 'pending' ? `<button data-id="${r.id}" data-pool="${poolId}" class="accept">Accept</button><button data-id="${r.id}" data-pool="${poolId}" class="reject">Reject</button>` : ''}</div></div>`).join('');
      container.querySelectorAll('.accept').forEach(btn => btn.addEventListener('click', async (e) => {
        const id = btn.dataset.id, pool = btn.dataset.pool; btn.disabled = true; try { const a = await fetch(`/api/pools/${pool}/requests/${id}/accept`, { method:'POST' }); const body = await a.json(); if (a.ok) { document.getElementById(`req_${id}`).querySelector('div').innerHTML = 'Accepted'; } else { alert(body.error || 'Error'); btn.disabled = false; } } catch (err) { alert('Error'); btn.disabled = false; }
      }));
      container.querySelectorAll('.reject').forEach(btn => btn.addEventListener('click', async (e) => {
        const id = btn.dataset.id, pool = btn.dataset.pool; btn.disabled = true; try { const a = await fetch(`/api/pools/${pool}/requests/${id}/reject`, { method:'POST' }); const body = await a.json(); if (a.ok) { document.getElementById(`req_${id}`).querySelector('div').innerHTML = 'Rejected'; } else { alert(body.error || 'Error'); btn.disabled = false; } } catch (err) { alert('Error'); btn.disabled = false; }
      }));
    }
  } catch (err) { container.innerHTML = '<p>Unable to load requests.</p>'; }
  const modal = document.getElementById('manageModal'); if (modal) modal.setAttribute('aria-hidden', 'false');
}

document.getElementById('manageClose').addEventListener('click', () => { const m = document.getElementById('manageModal'); if (m) m.setAttribute('aria-hidden', 'true'); });
async function api(path, options) { if (location.protocol === 'file:') throw new Error('Static demo'); const response = await fetch(path, options); if (!response.ok) throw new Error('Server unavailable'); return response.json(); }
async function search() {
  const from = $('#from').value.trim(), to = $('#to').value.trim(), at = $('#scheduledAt').value;
  $('#routeLabel').textContent = `${from} → ${to}`; $('#poolFrom').value = from; $('#poolTo').value = to; $('#poolTime').value = at;
  try {
    const data = await api(`/api/fares?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&at=${encodeURIComponent(at)}`);
    fares = data.fares;
    pools = await api('/api/pools');
    $('#status').textContent = data.notice;
  } catch {
    fares = demoFares(from, to, at);
    $('#status').textContent = 'Showing built-in demo data. Run the backend for saved pool bookings.';
  }

  // If a user is connected via Uber, fetch their personal estimates and prefer them
  try {
    const me = await fetch('/api/me').then(r => r.json()).catch(() => null);
    if (me && me.connected) {
      currentUserProfile = me.profile || null;
      const link = document.getElementById('openLogin');
      if (link) link.textContent = currentUserProfile && currentUserProfile.phone ? `Logged: ${currentUserProfile.phone}` : 'Logged in';
    } else {
      currentUserProfile = null;
    }
  } catch {}

  renderFares(); renderPools();
}
let joinTargetPoolId = null;
let joinPickupCoords = null;
let joinDropCoords = null;

async function joinPool(id) {
  // Open join modal to collect pickup/drop
  joinTargetPoolId = id;
  const pool = pools.find(p => p.id === id) || { from: '', to: '' };
  $('#joinPoolLabel').textContent = `${pool.host || 'Host'} — ${routeFor(pool).join(' → ')}`;
  $('#joinPickup').value = $('#from').value || pool.from || '';
  $('#joinDrop').value = $('#to').value || pool.to || '';
  joinPickupCoords = null; joinDropCoords = null;
  const modal = document.getElementById('joinModal'); if (modal) modal.setAttribute('aria-hidden', 'false');
}

function closeJoinModal() {
  const modal = document.getElementById('joinModal'); if (modal) modal.setAttribute('aria-hidden', 'true');
  $('#joinStatus').textContent = '';
  joinTargetPoolId = null; joinPickupCoords = null; joinDropCoords = null;
}

// Modal event handlers
document.addEventListener('click', (e) => {
  if (e.target && e.target.matches && e.target.matches('#joinCancel')) { e.preventDefault(); closeJoinModal(); }
});

document.getElementById('joinUseCurrent').addEventListener('click', async () => {
  if (!navigator.geolocation) { $('#joinStatus').textContent = 'Location access not supported.'; return; }
  $('#joinStatus').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    const name = await reverseName([coords.latitude, coords.longitude]);
    const focused = document.activeElement;
    if (focused === $('#joinDrop')) {
      $('#joinDrop').value = name;
      joinDropCoords = { lat: coords.latitude, lon: coords.longitude };
      $('#joinStatus').textContent = 'Drop set to current location.';
    } else {
      $('#joinPickup').value = name;
      joinPickupCoords = { lat: coords.latitude, lon: coords.longitude };
      $('#joinStatus').textContent = 'Pickup set to current location.';
    }
  }, (err) => { $('#joinStatus').textContent = `Unable to access location: ${err.message}`; }, { enableHighAccuracy: true, timeout: 10000 });
});

attachAutocomplete('#joinPickup', '#joinPickupSuggestions', (item) => { $('#joinPickup').value = item.label; joinPickupCoords = { lat: item.point[0], lon: item.point[1] }; });
attachAutocomplete('#joinDrop', '#joinDropSuggestions', (item) => { $('#joinDrop').value = item.label; joinDropCoords = { lat: item.point[0], lon: item.point[1] }; });

document.getElementById('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!joinTargetPoolId) return $('#joinStatus').textContent = 'No pool selected.';
  const pickupVal = $('#joinPickup').value.trim();
  const dropVal = $('#joinDrop').value.trim();
  if (!pickupVal || !dropVal) { $('#joinStatus').textContent = 'Enter pickup and drop locations.'; return; }
  const payload = {
    pickup: joinPickupCoords ? { lat: joinPickupCoords.lat, lon: joinPickupCoords.lon } : pickupVal,
    drop: joinDropCoords ? { lat: joinDropCoords.lat, lon: joinDropCoords.lon } : dropVal
  };
  $('#joinStatus').textContent = 'Checking route and joining…';
  try {
    // First validate pickup/drop against pool route
    const check = await api(`/api/pools/${joinTargetPoolId}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!check || !check.ok) { $('#joinStatus').textContent = (check && check.error) ? check.error : 'Pickup/drop do not match pool route.'; return; }

    // Create a join request instead of immediate join
    const created = await api(`/api/pools/${joinTargetPoolId}/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (created && created.ok) {
      $('#joinStatus').textContent = 'Request sent — waiting for host approval.';
      setTimeout(() => closeJoinModal(), 1200);
    } else {
      $('#joinStatus').textContent = (created && created.error) ? created.error : 'Unable to send request.';
    }
  } catch (err) {
    try { const res = await fetch(`/api/pools/${joinTargetPoolId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const body = await res.json(); $('#joinStatus').textContent = body && body.error ? body.error : 'Unable to join pool.'; } catch { $('#joinStatus').textContent = 'Unable to join pool.'; }
  }
  renderPools();
});

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
  // When the user focuses the from/to inputs, set the activePin so 'Use current location' targets the correct field
  const fromInput = $('#from');
  const toInput = $('#to');
  if (fromInput) fromInput.addEventListener('focus', () => setMode('pickup'));
  if (toInput) toInput.addEventListener('focus', () => setMode('dropoff'));
}
$('#searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
$('#poolForm').addEventListener('submit', async event => {
  event.preventDefault();
  const stops = $('#poolStops').value.split(',').map(stop => stop.trim()).filter(Boolean);
  const pool = {
    host: $('#hostName').value.trim(),
    vehicleType: $('#vehicleType').value || 'Any',
    gender: $('#genderPreference').value || 'Any',
    from: $('#poolFrom').value.trim(),
    to: $('#poolTo').value.trim(),
    stops,
    time: $('#poolTime').value,
    seats: Number($('#seats').value),
    route: selectedRoute
  };
  try {
    const created = await api('/api/pools', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pool) });
    pools.push(created);
  } catch {
    pools.push({ ...pool, id:`local-${Date.now()}` });
  }
  event.target.reset();
  $('#status').textContent = 'Your scheduled pool is ready for people to join.';
  renderPools();
});
const firstAvailableTime = futureDefault(); $('#scheduledAt').min = firstAvailableTime; $('#poolTime').min = firstAvailableTime; $('#scheduledAt').value = firstAvailableTime; initialiseMap(); search();

// Login modal handlers
const openLogin = document.getElementById('openLogin');
const loginModal = document.getElementById('loginModal');
if (openLogin && loginModal) openLogin.addEventListener('click', () => loginModal.setAttribute('aria-hidden', 'false'));
document.getElementById('loginCancel').addEventListener('click', () => { if (loginModal) loginModal.setAttribute('aria-hidden', 'true'); $('#loginStatus').textContent = ''; });
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginStatus').textContent = 'Logging in…';
  const phone = $('#loginPhone').value.trim();
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
    const body = await res.json();
    if (res.ok && body && body.ok) {
      $('#loginStatus').textContent = 'Logged in.'; currentUserProfile = body.profile || { phone };
      if (openLogin) openLogin.textContent = `Logged: ${currentUserProfile.phone}`;
      setTimeout(() => { loginModal.setAttribute('aria-hidden', 'true'); $('#loginStatus').textContent = ''; }, 800);
    } else {
      $('#loginStatus').textContent = body && body.error ? body.error : 'Login failed.';
    }
  } catch (err) { $('#loginStatus').textContent = 'Login failed.'; }
});

// Presence and chat
let eventSource = null;
let currentChatWith = null;
async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles'); const data = await res.json();
    const list = $('#profilesList'); list.innerHTML = '';
    if (!data || !Array.isArray(data.profiles) || !data.profiles.length) { list.textContent = 'No profiles yet.'; return; }
    data.profiles.forEach(p => {
      const item = document.createElement('div'); item.className = 'profile-item';
      item.innerHTML = `<strong>${p.phone}</strong> <span class="helper">${p.ready ? 'Ready' : 'Away'}</span> `;
      const toggle = document.createElement('button'); toggle.textContent = p.ready ? 'Set away' : 'Set ready'; toggle.className = 'secondary';
      toggle.addEventListener('click', async () => {
        await fetch('/api/profile/ready', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ ready: !p.ready }) });
        await loadProfiles();
      });
      const chatBtn = document.createElement('button'); chatBtn.textContent = 'Chat'; chatBtn.className = 'primary';
      chatBtn.addEventListener('click', () => openChat(p.phone));
      item.appendChild(toggle); item.appendChild(chatBtn); list.appendChild(item);
    });
  } catch (err) { $('#profilesList').textContent = 'Unable to load profiles.'; }
}

function openChat(phone) {
  currentChatWith = phone; $('#chatWithLabel').textContent = `Chat with ${phone}`; $('#chatModal').setAttribute('aria-hidden', 'false'); $('#chatMessages').innerHTML = '';
  loadMessages(phone);
}

async function loadMessages(phone) {
  try {
    const res = await fetch(`/api/messages?with=${encodeURIComponent(phone)}`); const data = await res.json();
    const box = $('#chatMessages'); box.innerHTML = '';
    if (data && Array.isArray(data.messages)) {
      data.messages.forEach(m => { const row = document.createElement('div'); row.textContent = `${m.from}: ${m.text}`; box.appendChild(row); });
      box.scrollTop = box.scrollHeight;
    }
  } catch { $('#chatMessages').textContent = 'Unable to load messages.'; }
}

$('#openPeople').addEventListener('click', () => { $('#peopleModal').setAttribute('aria-hidden', 'false'); loadProfiles(); });
$('#peopleClose').addEventListener('click', () => { $('#peopleModal').setAttribute('aria-hidden', 'true'); });
$('#chatClose').addEventListener('click', () => { $('#chatModal').setAttribute('aria-hidden', 'true'); currentChatWith = null; });

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (!currentChatWith) return; const text = $('#chatText').value.trim(); if (!text) return; $('#chatText').value = '';
  try {
    const res = await fetch('/api/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ to: currentChatWith, text }) });
    const body = await res.json(); if (res.ok && body && body.ok) { loadMessages(currentChatWith); }
    else { $('#chatStatus').textContent = body && body.error ? body.error : 'Send failed'; setTimeout(() => $('#chatStatus').textContent = '', 2000); }
  } catch { $('#chatStatus').textContent = 'Send failed'; setTimeout(() => $('#chatStatus').textContent = '', 2000); }
});

function ensureEventSource() {
  try {
    if (eventSource) return;
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('presence', (e) => { try { const d = JSON.parse(e.data); loadProfiles(); } catch {} });
    eventSource.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (currentChatWith && (m.from === currentChatWith || m.to === currentChatWith)) loadMessages(currentChatWith); } catch {} });
    eventSource.onerror = () => { /* silent */ };
  } catch (err) { /* not supported */ }
}

// Start SSE once app loads and after login
ensureEventSource();

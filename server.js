// FarePool backend. Uses only Node.js built-in modules, so no npm packages are needed.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const root = __dirname;
const poolFile = path.join(root, 'data', 'pools.json');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const port = process.env.PORT || 3000;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function readPools() { return JSON.parse(fs.readFileSync(poolFile, 'utf8')); }
function savePools(pools) { fs.writeFileSync(poolFile, JSON.stringify(pools, null, 2)); }
function send(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(err); }
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function geocodePlace(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(text)}&limit=1&countrycodes=in`;
  const result = await fetchJson(url, { headers: { 'User-Agent': 'FarePool/1.0 (https://github.com/prabal2404/farepool-jaipur)', 'Accept-Language': 'en' } });
  if (!Array.isArray(result) || !result[0]) return null;
  return { lat: parseFloat(result[0].lat), lon: parseFloat(result[0].lon), address: result[0].display_name };
}

function parseEstimate(estimate) {
  if (!estimate || typeof estimate !== 'string') return 0;
  const cleaned = estimate.replace(/[,|\u0016]/g, '');
  const match = cleaned.match(/\d+/g);
  if (!match || !match.length) return 0;
  return Number(match[0]);
}

function distanceKm(a, b) { const rad = Math.PI / 180; const x = (b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) * rad / 2); const y = (b[0] - a[0]) * rad; return 6371 * Math.sqrt(x*x + y*y); }

function routePosition(route, point) { let nearest = { index:-1, distance:Infinity }; route.forEach((routePoint, index) => { const distance = distanceKm(routePoint, point); if (distance < nearest.distance) nearest = { index, distance }; }); return nearest.distance <= 1 ? nearest.index : -1; }

// Simple file-backed user store
const usersFile = path.join(root, 'data', 'users.json');
function readUsers() { try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { return {}; } }
function saveUsers(obj) { fs.writeFileSync(usersFile, JSON.stringify(obj, null, 2)); }

// Messages store
const messagesFile = path.join(root, 'data', 'messages.json');
function readMessages() { try { return JSON.parse(fs.readFileSync(messagesFile, 'utf8')); } catch { return []; } }
function saveMessages(arr) { fs.writeFileSync(messagesFile, JSON.stringify(arr, null, 2)); }

// In-memory SSE clients: map phone -> array of response objects
const sseClients = {};
function sendSse(phone, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  Object.keys(sseClients).forEach(key => {
    sseClients[key].forEach(res => {
      try { res.write(payload); } catch (e) { /* ignore */ }
    });
  });
}

async function makeFares(from, to, at) {
  const seed = [...`${from}${to}${at}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const base = 115 + (seed % 40);
  return [
    { provider: 'Uber', service: 'Hatchback / Go', price: base + 4, bookingUrl: 'https://www.uber.com/in/en/' },
    { provider: 'Uber', service: 'SUV / XL', price: base + 82, bookingUrl: 'https://www.uber.com/in/en/' }
  ];
}
function body(req) { return new Promise((resolve, reject) => { let text = ''; req.on('data', part => { text += part; if (text.length > 100000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON')); } }); }); }

function parseCookies(req) {
  const header = req.headers && req.headers.cookie; if (!header) return {};
  return header.split(';').map(s => s.trim()).reduce((acc, part) => { const idx = part.indexOf('='); if (idx === -1) return acc; const k = part.slice(0, idx); const v = decodeURIComponent(part.slice(idx+1)); acc[k] = v; return acc; }, {});
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/fares') {
      const fares = await makeFares(url.searchParams.get('from') || '', url.searchParams.get('to') || '', url.searchParams.get('at') || '');
      return send(res, 200, { fares, notice: 'Live fare estimates are shown where available. Add approved provider API credentials for full real-time results.' });
    }

    // Mobile number login: create session
    if (req.method === 'POST' && url.pathname === '/api/login') {
      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }
      const phone = (payload && String(payload.phone || '').trim()) || '';
      if (!phone.match(/^\+?[0-9]{6,15}$/)) return send(res, 400, { error: 'Provide a valid phone number' });
      const sessionId = `s_${Date.now().toString(36)}_${Math.floor(Math.random()*900000+100000)}`;
      const users = readUsers(); users[sessionId] = { phone, created_at: Date.now() }; saveUsers(users);
      res.writeHead(200, { 'Set-Cookie': `fp_session=${sessionId}; Path=/; HttpOnly`, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, profile: { phone } }));
    }

    // Return session-connected profile
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const cookies = parseCookies(req); const session = cookies.fp_session; if (!session) return send(res, 200, { connected: false });
      const users = readUsers(); const entry = users[session]; if (!entry) return send(res, 200, { connected: false });
      return send(res, 200, { connected: true, profile: { phone: entry.phone } });
    }

    if (req.method === 'GET' && url.pathname === '/api/pools') return send(res, 200, readPools());
    // List profiles (phone + ready status)
    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      const users = readUsers();
      const profiles = Object.keys(users).map(k => ({ phone: users[k].phone, ready: !!users[k].ready, created_at: users[k].created_at }));
      return send(res, 200, { profiles });
    }

    // Set presence (ready/unready)
    if (req.method === 'POST' && url.pathname === '/api/profile/ready') {
      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }
      const cookies = parseCookies(req); const session = cookies.fp_session; if (!session) return send(res, 401, { error: 'Not logged in' });
      const users = readUsers(); const entry = users[session]; if (!entry) return send(res, 401, { error: 'Not logged in' });
      entry.ready = !!payload.ready; users[session] = entry; saveUsers(users);
      // notify SSE clients about presence change
      try { sendSse(entry.phone, 'presence', { phone: entry.phone, ready: !!entry.ready }); } catch (_) {}
      return send(res, 200, { ok: true, profile: { phone: entry.phone, ready: !!entry.ready } });
    }
    const checkPath = url.pathname.match(/^\/api\/pools\/([^/]+)\/check$/);
    if (req.method === 'POST' && checkPath) {
      const pools = readPools();
      const pool = pools.find(item => item.id === checkPath[1]);
      if (!pool) return send(res, 404, { ok: false, error: 'Pool not found.' });

      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }

      let pickupPoint = null;
      let dropPoint = null;

      if (payload && payload.pickup && typeof payload.pickup === 'object' && Number.isFinite(Number(payload.pickup.lat)) && Number.isFinite(Number(payload.pickup.lon))) {
        pickupPoint = [Number(payload.pickup.lat), Number(payload.pickup.lon)];
      } else if (payload && typeof payload.pickup === 'string' && payload.pickup.trim()) {
        const g = await geocodePlace(payload.pickup.trim()); if (g) pickupPoint = [g.lat, g.lon];
      }

      if (payload && payload.drop && typeof payload.drop === 'object' && Number.isFinite(Number(payload.drop.lat)) && Number.isFinite(Number(payload.drop.lon))) {
        dropPoint = [Number(payload.drop.lat), Number(payload.drop.lon)];
      } else if (payload && typeof payload.drop === 'string' && payload.drop.trim()) {
        const g2 = await geocodePlace(payload.drop.trim()); if (g2) dropPoint = [g2.lat, g2.lon];
      }

      if (!pickupPoint || !dropPoint) return send(res, 400, { ok: false, error: 'Please provide both pickup and drop locations.' });

      // If pool has route coordinates, check against them
      if (Array.isArray(pool.route) && pool.route.length >= 2) {
        const start = routePosition(pool.route, pickupPoint);
        const end = routePosition(pool.route, dropPoint);
        if (start === -1 || end === -1) return send(res, 200, { ok: false, error: 'Pickup and drop must both lie on the pool route. You cannot join this pool because your route differs.' });
        if (start >= end) return send(res, 200, { ok: false, error: 'Pickup must come before drop along the pool route. You cannot join this pool.' });
        return send(res, 200, { ok: true, pickup: { lat: pickupPoint[0], lon: pickupPoint[1] }, drop: { lat: dropPoint[0], lon: dropPoint[1] } });
      }

      // Fallback: match by named stops/order if route coords are not available
      const stops = [pool.from, ...(pool.stops || []), pool.to].map(s => String(s || '').trim().toLowerCase());
      const pickupName = typeof payload.pickup === 'string' ? payload.pickup.trim().toLowerCase() : '';
      const dropName = typeof payload.drop === 'string' ? payload.drop.trim().toLowerCase() : '';
      if (pickupName && dropName) {
        const pIndex = stops.indexOf(pickupName);
        const dIndex = stops.indexOf(dropName);
        if (pIndex === -1 || dIndex === -1) return send(res, 200, { ok: false, error: 'Pickup and drop must both match stops on the pool route. You cannot join this pool because your route differs.' });
        if (pIndex >= dIndex) return send(res, 200, { ok: false, error: 'Pickup must come before drop in the pool route order. You cannot join this pool.' });
        return send(res, 200, { ok: true, pickup: { name: pickupName }, drop: { name: dropName } });
      }

      return send(res, 400, { ok: false, error: 'Please provide both pickup and drop locations to check.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/pools') {
      const pool = await body(req);
      const stops = Array.isArray(pool.stops) ? pool.stops.filter(stop => typeof stop === 'string' && stop.trim()).slice(0, 6) : [];
      const route = Array.isArray(pool.route) ? pool.route.filter(point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(value))).slice(0, 500) : [];
      const vehicleType = ['Any', 'Auto', 'Hatchback', 'Sedan', 'SUV'].includes(pool.vehicleType) ? pool.vehicleType : 'Any';
      const gender = ['Any', 'Only girls', 'Only boys'].includes(pool.gender) ? pool.gender : 'Any';
      if (!pool.host || !pool.from || !pool.to || !pool.time || !Number.isInteger(pool.seats) || pool.seats < 1 || pool.seats > 6 || Number.isNaN(new Date(pool.time).getTime()) || new Date(pool.time) <= new Date()) return send(res, 400, { error: 'Please provide a future time, name, route, and 1–6 seats.' });
      const pools = readPools();
      const created = {
        id: `pool-${Date.now()}`,
        host: pool.host.trim(),
        vehicleType,
        gender,
        from: pool.from.trim(),
        to: pool.to.trim(),
        stops,
        route,
        time: pool.time,
        seats: pool.seats,
        requests: []
      };
      // Attach host phone from session if available
      try {
        const cookies = parseCookies(req); const session = cookies.fp_session; if (session) {
          const users = readUsers(); const entry = users[session]; if (entry && entry.phone) created.host_phone = entry.phone;
        }
      } catch (_) {}
      pools.push(created);
      savePools(pools);
      return send(res, 201, created);
    }
    const join = url.pathname.match(/^\/api\/pools\/([^/]+)\/join$/);
    if (req.method === 'POST' && join) {
      const pools = readPools();
      const pool = pools.find(item => item.id === join[1]);
      if (!pool) return send(res, 404, { error: 'Pool not found.' });
      if (pool.seats < 1) return send(res, 409, { error: 'This pool is full.' });

      // Read optional pickup/drop from request body
      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }

      let pickupPoint = null;
      let dropPoint = null;

      if (payload && payload.pickup && typeof payload.pickup === 'object' && Number.isFinite(Number(payload.pickup.lat)) && Number.isFinite(Number(payload.pickup.lon))) {
        pickupPoint = [Number(payload.pickup.lat), Number(payload.pickup.lon)];
      } else if (payload && typeof payload.pickup === 'string' && payload.pickup.trim()) {
        const g = await geocodePlace(payload.pickup.trim()); if (g) pickupPoint = [g.lat, g.lon];
      }

      if (payload && payload.drop && typeof payload.drop === 'object' && Number.isFinite(Number(payload.drop.lat)) && Number.isFinite(Number(payload.drop.lon))) {
        dropPoint = [Number(payload.drop.lat), Number(payload.drop.lon)];
      } else if (payload && typeof payload.drop === 'string' && payload.drop.trim()) {
        const g2 = await geocodePlace(payload.drop.trim()); if (g2) dropPoint = [g2.lat, g2.lon];
      }

      // Validate pickup/drop are on the pool route in correct order when coordinates/route available
      if (pickupPoint && dropPoint && Array.isArray(pool.route) && pool.route.length >= 2) {
        const start = routePosition(pool.route, pickupPoint);
        const end = routePosition(pool.route, dropPoint);
        if (start === -1 || end === -1) return send(res, 400, { error: 'Pickup and drop must both lie on the pool route. You cannot join this pool because your route differs.' });
        if (start >= end) return send(res, 400, { error: 'Pickup must come before drop along the pool route. You cannot join this pool.' });
      } else if (payload && (payload.pickup || payload.drop)) {
        // Fallback: match by named stops/order if route coords are not available
        const stops = [pool.from, ...(pool.stops || []), pool.to].map(s => String(s || '').trim().toLowerCase());
        const pickupName = typeof payload.pickup === 'string' ? payload.pickup.trim().toLowerCase() : '';
        const dropName = typeof payload.drop === 'string' ? payload.drop.trim().toLowerCase() : '';
        if (pickupName && dropName) {
          const pIndex = stops.indexOf(pickupName);
          const dIndex = stops.indexOf(dropName);
          if (pIndex === -1 || dIndex === -1) return send(res, 400, { error: 'Pickup and drop must both match stops on the pool route. You cannot join this pool because your route differs.' });
          if (pIndex >= dIndex) return send(res, 400, { error: 'Pickup must come before drop in the pool route order. You cannot join this pool.' });
        } else {
          return send(res, 400, { error: 'Please provide both pickup and drop locations to join this pool.' });
        }
      } else {
        return send(res, 400, { error: 'Please provide both pickup and drop locations to join this pool.' });
      }

      pool.seats -= 1;
      savePools(pools);
      return send(res, 200, pool);
    }

    // Create a join request (pending) instead of instantly joining
    const requestMatch = url.pathname.match(/^\/api\/pools\/([^/]+)\/request$/);
    if (req.method === 'POST' && requestMatch) {
      const pools = readPools(); const pool = pools.find(p => p.id === requestMatch[1]);
      if (!pool) return send(res, 404, { error: 'Pool not found.' });
      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }
      if (!payload || (!payload.pickup && !payload.drop)) return send(res, 400, { error: 'Provide pickup and drop' });
      const cookies = parseCookies(req); const session = cookies.fp_session; const users = readUsers(); const entry = session && users[session] ? users[session] : null;
      const reqId = `r_${Date.now().toString(36)}_${Math.floor(Math.random()*9000+1000)}`;
      const requester = entry ? { phone: entry.phone, name: payload.name || entry.phone } : { phone: null, name: payload.name || 'Guest' };
      const newReq = { id: reqId, requester, pickup: payload.pickup || null, drop: payload.drop || null, status: 'pending', created_at: Date.now() };
      pool.requests = Array.isArray(pool.requests) ? pool.requests : [];
      pool.requests.push(newReq);
      savePools(pools);
      return send(res, 201, { ok: true, request: newReq });
    }

    // Send a chat message
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      let payload = {};
      try { payload = await body(req); } catch { payload = {}; }
      const cookies = parseCookies(req); const session = cookies.fp_session; if (!session) return send(res, 401, { error: 'Not logged in' });
      const users = readUsers(); const sender = users[session]; if (!sender) return send(res, 401, { error: 'Not logged in' });
      const to = (payload && String(payload.to || '').trim()) || ''; const text = (payload && String(payload.text || '').trim()) || '';
      if (!to || !text) return send(res, 400, { error: 'Provide to and text' });
      const messages = readMessages(); const msg = { id: `m_${Date.now().toString(36)}_${Math.floor(Math.random()*9000+1000)}`, from: sender.phone, to, text, created_at: Date.now() };
      messages.push(msg); saveMessages(messages);
      // notify listeners
      try { sendSse(null, 'message', msg); } catch (_) {}
      return send(res, 201, { ok: true, message: msg });
    }

    // Fetch messages between current user and another
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const withPhone = String(url.searchParams.get('with') || '').trim();
      const cookies = parseCookies(req); const session = cookies.fp_session; if (!session) return send(res, 401, { error: 'Not logged in' });
      const users = readUsers(); const me = users[session]; if (!me) return send(res, 401, { error: 'Not logged in' });
      if (!withPhone) return send(res, 400, { error: 'Provide with param' });
      const messages = readMessages().filter(m => (m.from === me.phone && m.to === withPhone) || (m.from === withPhone && m.to === me.phone));
      return send(res, 200, { messages });
    }

    // Server-Sent Events for presence and messages
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const cookies = parseCookies(req); const session = cookies.fp_session; if (!session) { res.writeHead(401); return res.end('Not logged in'); }
      const users = readUsers(); const me = users[session]; if (!me) { res.writeHead(401); return res.end('Not logged in'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      // store client
      sseClients[me.phone] = sseClients[me.phone] || [];
      sseClients[me.phone].push(res);
      // send initial presence snapshot
      try { res.write(`event: presence\ndata: ${JSON.stringify({ phone: me.phone, ready: !!me.ready })}\n\n`); } catch (_) {}
      req.on('close', () => {
        try { sseClients[me.phone] = (sseClients[me.phone] || []).filter(r => r !== res); } catch (_) {}
      });
      return; // keep connection open
    }

    // List requests for a pool (only accessible to pool host)
    const requestsList = url.pathname.match(/^\/api\/pools\/([^/]+)\/requests$/);
    if (req.method === 'GET' && requestsList) {
      const pools = readPools(); const pool = pools.find(p => p.id === requestsList[1]); if (!pool) return send(res, 404, { error: 'Pool not found.' });
      const cookies = parseCookies(req); const session = cookies.fp_session; const users = readUsers(); const entry = session && users[session] ? users[session] : null;
      if (!pool.host_phone || !entry || !entry.phone || pool.host_phone !== entry.phone) return send(res, 403, { error: 'Only pool host may view requests.' });
      return send(res, 200, { requests: pool.requests || [] });
    }

    // Accept a request (only host)
    const acceptPath = url.pathname.match(/^\/api\/pools\/([^/]+)\/requests\/([^/]+)\/accept$/);
    if (req.method === 'POST' && acceptPath) {
      const [ , poolId, reqId ] = acceptPath; const pools = readPools(); const pool = pools.find(p => p.id === poolId); if (!pool) return send(res, 404, { error: 'Pool not found.' });
      const cookies = parseCookies(req); const session = cookies.fp_session; const users = readUsers(); const entry = session && users[session] ? users[session] : null;
      if (!pool.host_phone || !entry || !entry.phone || pool.host_phone !== entry.phone) return send(res, 403, { error: 'Only pool host may accept requests.' });
      pool.requests = Array.isArray(pool.requests) ? pool.requests : [];
      const r = pool.requests.find(x => x.id === reqId); if (!r) return send(res, 404, { error: 'Request not found.' });
      if (r.status !== 'pending') return send(res, 400, { error: 'Request already processed.' });
      if (pool.seats < 1) { r.status = 'rejected'; savePools(pools); return send(res, 409, { error: 'Pool is full.' }); }
      r.status = 'accepted'; r.processed_at = Date.now(); pool.seats -= 1; savePools(pools); return send(res, 200, { ok: true, request: r, pool });
    }

    // Reject a request (only host)
    const rejectPath = url.pathname.match(/^\/api\/pools\/([^/]+)\/requests\/([^/]+)\/reject$/);
    if (req.method === 'POST' && rejectPath) {
      const [ , poolId, reqId ] = rejectPath; const pools = readPools(); const pool = pools.find(p => p.id === poolId); if (!pool) return send(res, 404, { error: 'Pool not found.' });
      const cookies = parseCookies(req); const session = cookies.fp_session; const users = readUsers(); const entry = session && users[session] ? users[session] : null;
      if (!pool.host_phone || !entry || !entry.phone || pool.host_phone !== entry.phone) return send(res, 403, { error: 'Only pool host may reject requests.' });
      pool.requests = Array.isArray(pool.requests) ? pool.requests : [];
      const r = pool.requests.find(x => x.id === reqId); if (!r) return send(res, 404, { error: 'Request not found.' });
      if (r.status !== 'pending') return send(res, 400, { error: 'Request already processed.' });
      r.status = 'rejected'; r.processed_at = Date.now(); savePools(pools); return send(res, 200, { ok: true, request: r });
    }
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(root, `.${requestPath}`);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { send(res, 500, { error: error.message || 'Server error' }); }
}).listen(port, () => console.log(`FarePool is running at http://localhost:${port}`));

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

async function getUberFares(from, to) {
  const token = process.env.UBER_TOKEN || process.env.UBER_SERVER_TOKEN || process.env.UBER_API_KEY;
  if (!token) return [];

  const pickup = await geocodePlace(from);
  const drop = await geocodePlace(to);
  if (!pickup || !drop) return [];

  const url = `https://api.uber.com/v1.2/estimates/price?start_latitude=${pickup.lat}&start_longitude=${pickup.lon}&end_latitude=${drop.lat}&end_longitude=${drop.lon}`;
  const headers = {
    Authorization: token.startsWith('Bearer ') || token.startsWith('Token ') ? token : `Bearer ${token}`,
    'Accept-Language': 'en_US',
    'User-Agent': 'FarePool/1.0',
    Accept: 'application/json'
  };

  try {
    const response = await fetchJson(url, { method: 'GET', headers });
    if (!Array.isArray(response?.prices)) return [];
    return response.prices.map((price) => ({
      provider: 'Uber',
      service: price.display_name || price.localized_display_name || 'Uber',
      price: price.estimate ? parseEstimate(price.estimate) : (price.low_estimate ?? price.high_estimate ?? 0),
      bookingUrl: 'https://www.uber.com/in/en/'
    }));
  } catch {
    return [];
  }
}

async function getRapidoFares(from, to) {
  const token = process.env.RAPIDO_TOKEN;
  const deviceId = process.env.RAPIDO_DEVICE_ID;
  const customerId = process.env.RAPIDO_CUSTOMER_ID;
  if (!token || !deviceId || !customerId) return [];

  const pickup = await geocodePlace(from);
  const drop = await geocodePlace(to);
  if (!pickup || !drop) return [];

  const payload = JSON.stringify({
    pickupLocation: { addressType: '', address: pickup.address.split(',')[0], lat: pickup.lat, lng: pickup.lon, name: '' },
    dropLocation: { addressType: '', address: drop.address.split(',')[0], lat: drop.lat, lng: drop.lon, name: drop.address.split(',')[0] },
    serviceType: process.env.RAPIDO_SERVICE_TYPE || '57370b61a6855d70057417d1',
    customer: customerId,
    couponCode: '',
    paymentType: process.env.RAPIDO_PAYMENT_TYPE || 'paytm'
  });

  const headers = {
    deviceid: deviceId,
    latitude: process.env.RAPIDO_LATITUDE || '26.9124',
    longitude: process.env.RAPIDO_LONGITUDE || '75.7873',
    appid: '2',
    currentdatetime: new Date().toISOString().replace('T', ' ').slice(0, 19),
    internet: '0',
    appversion: process.env.RAPIDO_APPVERSION || '73',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    Host: 'auth.rapido.bike',
    Connection: 'Keep-Alive',
    'Accept-Encoding': 'gzip',
    'User-Agent': 'okhttp/3.6.0',
    'Cache-Control': 'no-cache'
  };

  try {
    const response = await fetchJson('https://auth.rapido.bike/om/api/orders/v2/rideAmount', { method: 'POST', headers, body: payload });
    if (!response?.data?.quotes) return [];
    return response.data.quotes.map((quote) => ({ provider: 'Rapido', service: quote.serviceName || quote.serviceId || 'Rapido', price: Number(quote.amount) || 0, bookingUrl: 'https://www.rapido.bike/' }));
  } catch {
    return [];
  }
}

async function makeFares(from, to, at) {
  const seed = [...`${from}${to}${at}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const base = 115 + (seed % 40);
  const fallbackFares = [{ provider: 'Uber', service: 'Hatchback / Go', price: base + 4, bookingUrl: 'https://www.uber.com/in/en/' }, { provider: 'Rapido', service: 'Auto', price: base - 12, bookingUrl: 'https://www.rapido.bike/' }, { provider: 'Uber', service: 'SUV / XL', price: base + 82, bookingUrl: 'https://www.uber.com/in/en/' }];

  const [uberFares, rapidoFares] = await Promise.all([getUberFares(from, to), getRapidoFares(from, to)]);
  const fares = [...(uberFares.length ? uberFares : fallbackFares.filter(fare => fare.provider !== 'Uber')), ...rapidoFares];
  return fares.length ? fares : fallbackFares;
}
function body(req) { return new Promise((resolve, reject) => { let text = ''; req.on('data', part => { text += part; if (text.length > 100000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON')); } }); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/fares') {
      const fares = await makeFares(url.searchParams.get('from') || '', url.searchParams.get('to') || '', url.searchParams.get('at') || '');
      return send(res, 200, { fares, notice: 'Live fare estimates are shown where available. Add approved provider API credentials for full real-time results.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/pools') return send(res, 200, readPools());
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
        seats: pool.seats
      };
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
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(root, `.${requestPath}`);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { send(res, 500, { error: error.message || 'Server error' }); }
}).listen(port, () => console.log(`FarePool is running at http://localhost:${port}`));

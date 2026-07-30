// FarePool backend. Uses only Node.js built-in modules, so no npm packages are needed.
const http = require('http');
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
function makeFares(from, to, at) {
  const seed = [...`${from}${to}${at}`].reduce((sum, char) => sum + char.charCodeAt(0), 0); const base = 115 + (seed % 40);
  return [{ provider: 'Ola', service: 'Auto', price: base - 18, bookingUrl: 'https://www.olacabs.com/' }, { provider: 'Uber', service: 'Hatchback / Go', price: base + 4, bookingUrl: 'https://www.uber.com/in/en/' }, { provider: 'Rapido', service: 'Auto', price: base - 12, bookingUrl: 'https://www.rapido.bike/' }, { provider: 'Ola', service: 'Sedan / Prime', price: base + 42, bookingUrl: 'https://www.olacabs.com/' }, { provider: 'Uber', service: 'SUV / XL', price: base + 82, bookingUrl: 'https://www.uber.com/in/en/' }];
}
function body(req) { return new Promise((resolve, reject) => { let text = ''; req.on('data', part => { text += part; if (text.length > 100000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON')); } }); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/fares') return send(res, 200, { fares: makeFares(url.searchParams.get('from') || '', url.searchParams.get('to') || '', url.searchParams.get('at') || ''), notice: 'Demo fare estimates are shown. Add approved provider API credentials before using live prices.' });
    if (req.method === 'GET' && url.pathname === '/api/pools') return send(res, 200, readPools());
    if (req.method === 'POST' && url.pathname === '/api/pools') { const pool = await body(req); const stops = Array.isArray(pool.stops) ? pool.stops.filter(stop => typeof stop === 'string' && stop.trim()).slice(0, 6) : []; const route = Array.isArray(pool.route) ? pool.route.filter(point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(value))).slice(0, 500) : []; if (!pool.host || !pool.from || !pool.to || !pool.time || !Number.isInteger(pool.seats) || pool.seats < 1 || pool.seats > 6 || Number.isNaN(new Date(pool.time).getTime()) || new Date(pool.time) <= new Date()) return send(res, 400, { error: 'Please provide a future time, name, route, and 1–6 seats.' }); const pools = readPools(); const created = { id: `pool-${Date.now()}`, host: pool.host.trim(), from: pool.from.trim(), to: pool.to.trim(), stops, route, time: pool.time, seats: pool.seats }; pools.push(created); savePools(pools); return send(res, 201, created); }
    const join = url.pathname.match(/^\/api\/pools\/([^/]+)\/join$/);
    if (req.method === 'POST' && join) { const pools = readPools(); const pool = pools.find(item => item.id === join[1]); if (!pool) return send(res, 404, { error: 'Pool not found.' }); if (pool.seats < 1) return send(res, 409, { error: 'This pool is full.' }); pool.seats -= 1; savePools(pools); return send(res, 200, pool); }
    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(root, `.${requestPath}`);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { send(res, 500, { error: error.message || 'Server error' }); }
}).listen(port, () => console.log(`FarePool is running at http://localhost:${port}`));

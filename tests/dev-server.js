'use strict';
/*
  A local stand-in for the real setup, for trying the pages in a browser.

    node tests/dev-server.js [--mode=seeded|ready|empty] [--latency=300] [--fee=30] [--quote=false]
                            [--collections=false] [--site-port=5173] [--api-port=5174]

  docs/ is served on one port, with config.js pointing at a fake order service on another
  port. The fake service runs the real Code.gs against in-memory copies of Google's services,
  and answers the way Apps Script does:
    - a POST to /exec is answered with a 302 to an "echo" address that returns the JSON,
    - a preflight (OPTIONS) request is refused, because Apps Script cannot answer one.
  So the pages' cross-origin calls are exercised the way they will really run.
  Nothing is saved: stop the server and the data is gone.
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGas } = require('./gas-mock');

const DOCS = path.join(__dirname, '..', 'docs');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const BANK = {
  bank_name: 'Test Bank',
  account_holder: 'G Bolus',
  account_number: '0012345678',
  branch_code: '250655',
  account_type: 'Cheque'
};

function expectOk(res) {
  if (!res || res.ok !== true) throw new Error('Setup step failed: ' + JSON.stringify(res));
  return res;
}

// Times below are Cape Town clock times (UTC+2), written as UTC.
function at(gas, iso) {
  gas.clock.now = Date.parse(iso);
}

function seed(gas, key) {
  const kiosk = (over) => expectOk(gas.call(Object.assign({
    action: 'order', areaConfirmed: true, notes: '', website: '',
    requestId: crypto.randomUUID().replace(/-/g, '')
  }, over, { expectedTotal: over.qty * 40 + 30 })));
  const dm = (over) => expectOk(gas.call(Object.assign({
    action: 'create', key, contact: '', address: '', notes: '',
    requestId: crypto.randomUUID().replace(/-/g, '')
  }, over)));
  const move = (invoice, status) => expectOk(gas.call({ action: 'setStatus', key, invoice, status }));

  at(gas, '2026-10-26T06:12:00Z');
  kiosk({ name: 'Thandi Mokoena', email: 'thandi@example.com', contact: '@thandi.runs', address: '14 Beach Rd, Sea Point', qty: 3 });
  at(gas, '2026-10-26T08:03:00Z');
  move('SJ-0001', 'Paid');
  at(gas, '2026-10-26T15:30:00Z');
  move('SJ-0001', 'Delivered');

  at(gas, '2026-10-26T10:00:00Z');
  kiosk({ name: 'Naledi Khumalo', email: 'naledi@example.com', contact: '@naledik', address: '8 Church St, Woodstock', qty: 2 });
  at(gas, '2026-10-26T11:20:00Z');
  move('SJ-0002', 'Cancelled');

  at(gas, '2026-10-27T17:40:00Z');
  kiosk({ name: 'Liam Peters', email: 'liam@example.com', contact: '082 555 0147', address: '3 Kloof Nek Rd, Tamboerskloof', qty: 1, notes: 'Leave with the guard' });
  at(gas, '2026-10-27T19:05:00Z');
  move('SJ-0003', 'Paid');

  at(gas, '2026-10-27T18:15:00Z');
  dm({ name: 'Ayesha Davids', contact: '@ayesha_trails', qty: 2 });

  at(gas, '2026-10-28T05:30:00Z');
  kiosk({
    name: 'Pieter van der Merwe', email: 'pieter@example.com', contact: '0719876543', address: '22 Main Rd, Claremont', qty: 5,
    notes: 'Gate code 4412. Please call on arrival.'
  });

  at(gas, '2026-10-28T13:41:00Z'); // 15:41, the mock's usual "now"
}

// Two collections tomorrow: 17:00 is full on the order page, and one is paid with its invite sent.
function seedCollections(gas, key) {
  const collect = (over) => {
    const r = expectOk(gas.call(Object.assign({
      action: 'order', notes: '', website: '', address: '', collect: true,
      requestId: crypto.randomUUID().replace(/-/g, '')
    }, over, { expectedTotal: over.qty * 40 })));
    return r.order.invoice;
  };
  at(gas, '2026-10-28T07:20:00Z');
  collect({ name: 'Sipho Ndlovu', email: 'sipho@example.com', contact: '@sipho.runs', qty: 4, collectAt: '2026-10-29 17:00' });
  at(gas, '2026-10-28T09:45:00Z');
  const paid = collect({ name: 'Jess Adams', email: 'jess@example.com', contact: '@jessruns', qty: 2, collectAt: '2026-10-29 18:00' });
  at(gas, '2026-10-28T11:02:00Z');
  expectOk(gas.call({ action: 'setStatus', key, invoice: paid, status: 'Paid' }));
  at(gas, '2026-10-28T13:41:00Z');
}

function build(mode, opts) {
  const gas = createGas();
  gas.run('setup()');
  const key = gas.key();
  if (mode !== 'empty') {
    expectOk(gas.call({
      action: 'saveSettings', key,
      values: Object.assign({
        price: '40',
        delivery_fee: String(opts.fee === undefined ? 30 : opts.fee),
        alert_email: 'greg@example.com',
        collection_note: 'Sea Point',
        delivery_quote: 'no' // the sample orders below were placed with a fixed fee
      }, BANK)
    }));
  }
  if (mode === 'seeded') seed(gas, key);
  if (mode === 'seeded' && opts.collections) seedCollections(gas, key);
  // Delivery fees confirmed per order, with one request waiting for a fee when there are sample orders.
  if (opts.quote && mode !== 'empty') {
    expectOk(gas.call({ action: 'saveSettings', key, values: { delivery_quote: 'yes' } }));
    if (mode === 'seeded') {
      at(gas, '2026-10-28T12:10:00Z');
      expectOk(gas.call({
        action: 'order', name: 'Megan Fourie', email: 'megan@example.com', contact: '@megan.trails',
        address: '5 Ou Kaapse Weg, Noordhoek', notes: 'Weekday evenings', qty: 4, areaConfirmed: true, website: '',
        requestId: crypto.randomUUID().replace(/-/g, ''), expectedTotal: 160
      }));
      at(gas, '2026-10-28T13:41:00Z');
    }
  }
  return { gas, key };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startDevServer(opts) {
  opts = opts || {};
  let current = build(opts.mode || 'seeded', opts);
  const settings = { latency: opts.latency || 0, instagram: 'gregbolus02', endpoint: null };
  const calls = []; // what the pages sent: { method, action, contentType }
  const echo = new Map();
  let apiPort = 0;

  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = { 'Access-Control-Allow-Origin': '*' };

    // Apps Script cannot answer a preflight. A page that triggers one would fail for real.
    if (req.method === 'OPTIONS') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (url.pathname === '/exec') {
      const body = req.method === 'POST' ? await readBody(req) : '';
      await new Promise((r) => setTimeout(r, settings.latency));
      let content;
      if (req.method === 'POST') {
        let action = null;
        try { action = JSON.parse(body).action; } catch (err) { /* not JSON */ }
        calls.push({ method: 'POST', action, contentType: String(req.headers['content-type'] || '') });
        content = current.gas.ctx.doPost({ postData: { contents: body, type: req.headers['content-type'] || '' } }).getContent();
      } else {
        calls.push({ method: 'GET', action: url.searchParams.get('action'), contentType: '' });
        content = current.gas.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) }).getContent();
      }
      const id = crypto.randomUUID();
      echo.set(id, content);
      res.writeHead(302, Object.assign({ Location: 'http://127.0.0.1:' + apiPort + '/echo/' + id }, cors));
      res.end();
      return;
    }

    if (url.pathname.indexOf('/echo/') === 0) {
      const id = url.pathname.slice('/echo/'.length);
      const content = echo.get(id);
      echo.delete(id);
      if (content === undefined) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      res.end(content);
      return;
    }

    res.writeHead(404, cors);
    res.end();
  });
  apiPort = await listen(api, opts.apiPort || 0);

  const site = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (err) { p = '/'; }
    const headers = { 'Cache-Control': 'no-store' };

    if (p === '/config.js') {
      const endpoint = settings.endpoint === null ? 'http://127.0.0.1:' + apiPort + '/exec' : settings.endpoint;
      res.writeHead(200, Object.assign({ 'Content-Type': TYPES['.js'] }, headers));
      res.end('window.SJ_CONFIG = ' + JSON.stringify({ endpoint: endpoint, instagram: settings.instagram }) + ';\n');
      return;
    }

    if (p.slice(-1) === '/') p += 'index.html';
    const file = path.normalize(path.join(DOCS, p));
    if (file.indexOf(DOCS + path.sep) !== 0) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, headers));
        res.end('Not found');
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }, headers));
      res.end(data);
    });
  });
  const sitePort = await listen(site, opts.sitePort || 0);

  const siteUrl = 'http://127.0.0.1:' + sitePort;
  return {
    siteUrl: siteUrl,
    apiUrl: 'http://127.0.0.1:' + apiPort + '/exec',
    calls: calls,
    get gas() { return current.gas; },
    get key() { return current.key; },
    adminUrl: function (key) { return siteUrl + '/admin.html#' + (key === undefined ? current.key : key); },
    // Start again with fresh data: 'seeded' (demo orders), 'ready' (configured, no orders) or 'empty' (not set up).
    reset: function (mode, over) {
      current = build(mode || 'seeded', Object.assign({}, opts, over || {}));
      calls.length = 0;
    },
    setLatency: function (ms) { settings.latency = ms; },
    setInstagram: function (handle) { settings.instagram = handle; },
    setEndpoint: function (url) { settings.endpoint = url; }, // null puts the fake service back
    close: function () {
      return Promise.all([
        new Promise((r) => { api.close(r); api.closeAllConnections && api.closeAllConnections(); }),
        new Promise((r) => { site.close(r); site.closeAllConnections && site.closeAllConnections(); })
      ]);
    }
  };
}

module.exports = { startDevServer };

if (require.main === module) {
  const args = {};
  process.argv.slice(2).forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  });
  startDevServer({
    mode: args.mode || 'seeded',
    latency: Number(args.latency || 0),
    fee: args.fee === undefined ? undefined : Number(args.fee),
    quote: args.quote !== 'false', // --quote=false for a fixed delivery fee
    collections: args.collections !== 'false', // sample collection orders, --collections=false for none
    sitePort: Number(args['site-port'] || 5173),
    apiPort: Number(args['api-port'] || 5174)
  }).then((dev) => {
    console.log('Order page  ' + dev.siteUrl + '/');
    console.log('Admin       ' + dev.adminUrl());
    console.log('Fake order service on ' + dev.apiUrl + ' (data lives in memory and is gone when this stops)');
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

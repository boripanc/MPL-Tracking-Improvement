'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { setupDatabase, startApp } = require('./helpers');
const { commonName, classify } = require('../src/cpi/certificates');

const DAY = 86400000;
const odata = (ms) => `/Date(${ms})/`;

function entry(alias, daysLeft, extra = {}) {
  // Field names and formats as returned by the real tenant (e.g. Type 'Key Pair', SerialNumber '0xB92C8671').
  const now = Date.now();
  return {
    __metadata: { type: 'com.sap.hci.api.KeystoreEntry' },
    Hexalias: Buffer.from(alias).toString('hex'), Alias: alias, Type: 'Certificate', Owner: 'Tenant Administrator',
    KeyType: 'RSA', KeySize: 2048, SerialNumber: '0A1B', SignatureAlgorithm: 'SHA256withRSA',
    SubjectDN: `CN=${alias}.example.com, O=Example, C=TH`, IssuerDN: 'CN=Example CA, O=Example, C=TH',
    ValidNotBefore: odata(now - 365 * DAY), ValidNotAfter: odata(now + daysLeft * DAY + 3600000),
    LastModifiedBy: 'admin', LastModifiedTime: odata(now - 10 * DAY),
    ...extra,
  };
}

function fakeCpi(pages, { failWith } = {}) {
  const seen = { keystore: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/oauth/token') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
    if (url.pathname === '/api/v1/KeystoreEntries') {
      seen.keystore++;
      // Like the real tenant: $format is not supported on this entity set, JSON comes via the Accept header.
      if (url.searchParams.has('$format')) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: { message: { value: 'The format query option is not supported.' } } }));
      }
      if (!/application[/]json/.test(req.headers.accept || '')) { res.statusCode = 406; return res.end(); }
      if (failWith) { res.statusCode = failWith; return res.end('Forbidden'); }
      const page = Number(url.searchParams.get('$skiptoken') || 0);
      const base = `http://127.0.0.1:${server.address().port}/api/v1/KeystoreEntries`;
      const d = { results: pages[page] };
      if (page + 1 < pages.length) d.__next = `${base}?$skiptoken=${page + 1}`;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ d }));
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function cpiEnv(port) {
  return {
    CPI_API_URL: `http://127.0.0.1:${port}/api/v1`, CPI_TOKEN_URL: `http://127.0.0.1:${port}/oauth/token`,
    CPI_CLIENT_ID: 'id', CPI_CLIENT_SECRET: 'secret', CERT_CRITICAL_DAYS: '30', CERT_WARN_DAYS: '90',
  };
}

let db;
test.before(async () => { db = await setupDatabase({ seed: false }); });
test.after(async () => { await db.teardown(); });

test('commonName and classify', () => {
  assert.equal(commonName('CN=*.hana.ondemand.com, O=SAP SE, C=DE'), '*.hana.ondemand.com');
  assert.equal(commonName('O=No CN, C=TH'), 'O=No CN');
  const now = Date.now();
  const t = { criticalDays: 30, warnDays: 90 };
  assert.deepEqual(classify(new Date(now - DAY).toISOString(), now, t), { daysLeft: -1, state: 'expired' });
  assert.equal(classify(new Date(now + 10 * DAY).toISOString(), now, t).state, 'critical');
  assert.equal(classify(new Date(now + 10 * DAY).toISOString(), now, t).daysLeft, 10);
  assert.equal(classify(new Date(now + 60 * DAY).toISOString(), now, t).state, 'warning');
  assert.equal(classify(new Date(now + 200 * DAY).toISOString(), now, t).state, 'ok');
  assert.equal(classify(null, now, t).state, 'unknown');
});

test('syncKeystore SQL stores raw CPI records, marks removed entries and logs the sync', async () => {
  const SQL = require('../src/sql');
  const sync = async (entries, source = 'n8n') => (await db.pool.query(SQL.syncKeystore, [JSON.stringify({ source, entries })])).rows[0].result;
  await db.pool.query('TRUNCATE cpi_keystore_entries, cpi_keystore_sync');

  const a = entry('partner_as2', 45, { Type: 'Key Pair', SerialNumber: '0xB92C8671', Certificate: 'MIIB...pem', SigningRequest: 'csr' });
  const b = entry('old_cert', -10);
  const r1 = await sync([a, b, { Alias: '' }]);
  assert.equal(r1.entries, 2);
  assert.equal(r1.removed, 0);
  assert.equal(r1.source, 'n8n');

  const { rows } = await db.pool.query("SELECT * FROM cpi_keystore_entries WHERE alias = 'partner_as2'");
  assert.equal(rows[0].entry_type, 'Key Pair');
  assert.equal(rows[0].key_size, 2048);
  assert.equal(rows[0].serial_number, '0xB92C8671');
  assert.ok(Math.abs(rows[0].valid_to.getTime() - Number(/\d+/.exec(a.ValidNotAfter)[0])) < 1000, 'OData date converted');
  assert.equal(rows[0].raw.Certificate, undefined, 'certificate material is not stored');
  assert.equal(rows[0].raw.__metadata, undefined);

  // Next sync without old_cert -> it is marked removed; an empty list changes nothing.
  const r2 = await sync([a], 'app');
  assert.equal(r2.removed, 1);
  assert.equal(await sync([]), null);
  const after = await db.pool.query('SELECT alias, removed_at IS NOT NULL AS removed FROM cpi_keystore_entries ORDER BY alias');
  assert.deepEqual(after.rows, [{ alias: 'old_cert', removed: true }, { alias: 'partner_as2', removed: false }]);
  // It comes back when it reappears.
  await sync([a, b]);
  assert.equal((await db.pool.query("SELECT removed_at FROM cpi_keystore_entries WHERE alias = 'old_cert'")).rows[0].removed_at, null);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM cpi_keystore_sync')).rows[0].n, 3);
});

test('GET /api/certificates reads from the database, classifies and sorts', async () => {
  const SQL = require('../src/sql');
  await db.pool.query('TRUNCATE cpi_keystore_entries, cpi_keystore_sync');
  const api = await startApp(db.pool);
  try {
    const empty = await api.call('GET', '/api/certificates');
    assert.equal(empty.body.enabled, true);
    assert.equal(empty.body.lastSync, null);
    assert.equal(empty.body.stale, true);
    assert.equal(empty.body.canSync, false);

    await db.pool.query(SQL.syncKeystore, [JSON.stringify({ source: 'n8n', entries: [
      entry('ok_cert', 400), entry('expired_cert', -5), entry('sap_cert', 20, { Owner: 'SAP', Type: 'Key Pair' }),
      entry('soon_cert', 60), entry('no_end', 0, { ValidNotAfter: null }), entry('gone_cert', 10),
    ] })]);
    await db.pool.query(SQL.syncKeystore, [JSON.stringify({ source: 'n8n', entries: [
      entry('ok_cert', 400), entry('expired_cert', -5), entry('sap_cert', 20, { Owner: 'SAP', Type: 'Key Pair' }),
      entry('soon_cert', 60), entry('no_end', 0, { ValidNotAfter: null }),
    ] })]);

    const r = await api.call('GET', '/api/certificates');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((c) => c.alias), ['expired_cert', 'sap_cert', 'soon_cert', 'ok_cert', 'no_end']);
    assert.deepEqual(r.body.summary, { total: 5, expired: 1, critical: 1, warning: 1, ok: 1, unknown: 1, removed: 0 });
    assert.equal(r.body.lastSync.source, 'n8n');
    assert.equal(r.body.lastSync.entries, 5);
    assert.equal(r.body.stale, false);
    assert.equal(r.body.items[1].entryType, 'Key Pair');
    assert.equal(r.body.items[1].subject, 'sap_cert.example.com');

    const withRemoved = await api.call('GET', '/api/certificates?removed=1');
    const gone = withRemoved.body.items.find((c) => c.alias === 'gone_cert');
    assert.ok(gone.removedAt);
    assert.equal(withRemoved.body.summary.removed, 1);
    assert.equal(withRemoved.body.summary.total, 5, 'removed entries are not counted as active');

    assert.equal((await api.call('POST', '/api/certificates/sync')).status, 409, 'no CPI connection here');
    assert.equal((await api.call('GET', '/api/meta')).body.certificatesCanSync, false);
  } finally {
    await api.close();
  }
});

test('POST /api/certificates/sync copies the keystore from CPI into the database', async () => {
  await db.pool.query('TRUNCATE cpi_keystore_entries, cpi_keystore_sync');
  const cpi = await fakeCpi([
    [entry('a_cert', 400), entry('b_cert', -5)],
    [entry('c_cert', 60)],
  ]);
  const api = await startApp(db.pool, cpiEnv(cpi.port));
  try {
    assert.equal((await api.call('GET', '/api/meta')).body.certificatesCanSync, true);
    const s = await api.call('POST', '/api/certificates/sync');
    assert.equal(s.status, 200);
    assert.equal(s.body.entries, 3);
    assert.equal(s.body.source, 'app');
    assert.equal(cpi.seen.keystore, 2, 'followed the __next link');
    const r = await api.call('GET', '/api/certificates');
    assert.equal(r.body.canSync, true);
    assert.equal(r.body.summary.total, 3);
    assert.equal(r.body.summary.expired, 1);
  } finally {
    await api.close();
    cpi.server.close();
  }

  const failing = await fakeCpi([[]], { failWith: 403 });
  const api2 = await startApp(db.pool, cpiEnv(failing.port));
  try {
    const r = await api2.call('POST', '/api/certificates/sync');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /HTTP 403/);
    assert.equal((await api2.call('GET', '/api/certificates')).body.summary.total, 3, 'a failed sync keeps the stored data');
  } finally {
    await api2.close();
    failing.server.close();
  }
});

test('explains when the certificate tables do not exist yet', async () => {
  const bare = await setupDatabase({ seed: false });
  await bare.pool.query('DROP TABLE cpi_keystore_entries, cpi_keystore_sync');
  const api = await startApp(bare.pool);
  try {
    const r = await api.call('GET', '/api/certificates');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.match(r.body.reason, /db:init|n8n/);
  } finally {
    await api.close();
    await bare.teardown();
  }
});

test('config rejects a partly configured CPI connection', () => {
  const { loadConfig, validateConfig } = require('../src/config');
  const problems = validateConfig(loadConfig({ DATABASE_URL: 'x', APP_USERS: 'a:b', CPI_API_URL: 'https://x/api/v1' }));
  assert.ok(problems.some((p) => /partly configured/.test(p)));
});

test('CPI settings accept service-key names and fix common URL mistakes', () => {
  const { loadConfig, missingCpiVars, cpiConfigured } = require('../src/config');
  const c = loadConfig({
    CPI_URL: 'int-prod-tug.it-cpi012.cfapps.ap21.hana.ondemand.com/',
    CPI_TOKENURL: 'https://sub.authentication.ap21.hana.ondemand.com',
    CPI_CLIENTID: ' sb-id ',
    CPI_CLIENTSECRET: 'secret',
  });
  assert.equal(c.poller.apiUrl, 'https://int-prod-tug.it-cpi012.cfapps.ap21.hana.ondemand.com/api/v1');
  assert.equal(c.poller.tokenUrl, 'https://sub.authentication.ap21.hana.ondemand.com/oauth/token');
  assert.equal(c.poller.clientId, 'sb-id');
  assert.ok(cpiConfigured(c));
  assert.deepEqual(missingCpiVars(loadConfig({ CPI_API_URL: 'https://x/api/v1', CPI_CLIENT_ID: 'a' })), ['CPI_TOKEN_URL', 'CPI_CLIENT_SECRET']);
});

test('.env next to package.json is found even when started from another folder', () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) return; // never touch a real .env
  fs.writeFileSync(envFile, 'CPI_API_URL=https://from-dotenv.example\n');
  try {
    const out = execFileSync(process.execPath, ['-e',
      "const l=require(process.argv[1]).loadEnvFiles(); console.log(JSON.stringify({ l, v: process.env.CPI_API_URL }))",
      path.join(__dirname, '..', 'src', 'env.js')], { cwd: os.tmpdir(), env: { PATH: process.env.PATH } }).toString();
    const r = JSON.parse(out);
    assert.equal(r.v, 'https://from-dotenv.example');
    assert.deepEqual(r.l, [envFile]);
  } finally {
    fs.unlinkSync(envFile);
  }
});

test('a non-JSON reply (wrong CPI_API_URL) gives a clear error on sync', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/oauth/token')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ access_token: 'tok' })); }
    res.setHeader('Content-Type', 'text/html'); res.end('<html>Integration Suite</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = await startApp(db.pool, cpiEnv(server.address().port));
  try {
    const r = await api.call('POST', '/api/certificates/sync');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /did not return JSON/);
  } finally {
    await api.close();
    server.close();
  }
});

/* ---------- CPI connection check, proxy and network errors ---------- */

const { checkConnection, describeNetworkError } = require('../src/cpi/client');

function cpiCfg(port, secret = 'secret') {
  return {
    apiUrl: `http://127.0.0.1:${port}/api/v1`, tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
    clientId: 'id', clientSecret: secret, requestTimeoutMs: 5000,
  };
}

function strictCpi({ keystoreStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/oauth/token') {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('id:secret').toString('base64')) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Bad credentials' }));
      }
      return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
    if (url.pathname === '/api/v1/KeystoreEntries') {
      if (keystoreStatus !== 200) { res.statusCode = keystoreStatus; return res.end('{"error":"Forbidden"}'); }
      return res.end(JSON.stringify({ d: { results: [entry('a', 100), entry('b', 5)] } }));
    }
    if (url.pathname === '/api/v1/MessageProcessingLogs') return res.end(JSON.stringify({ d: { results: [{}] } }));
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('checkConnection reports each step', async () => {
  const server = await strictCpi();
  try {
    const ok = await checkConnection(cpiCfg(server.address().port), { env: {} });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.steps.map((s) => s.name), ['Settings', 'Get OAuth token', 'Read keystore (Certificates)', 'Read message processing logs']);
    assert.match(ok.steps[2].detail, /2 entries/);
    assert.ok(!JSON.stringify(ok).includes('secret'), 'never returns the secret');

    const badSecret = await checkConnection(cpiCfg(server.address().port, 'wrong'), { env: {} });
    assert.equal(badSecret.ok, false);
    assert.equal(badSecret.steps.at(-1).name, 'Get OAuth token');
    assert.match(badSecret.steps.at(-1).detail, /HTTP 401 Bad credentials.*CPI_CLIENT_SECRET/);

    const missing = await checkConnection({ ...cpiCfg(1), clientSecret: '' }, { env: {} });
    assert.match(missing.steps[0].detail, /Missing: clientSecret/);
  } finally {
    server.close();
  }
  const forbidden = await strictCpi({ keystoreStatus: 403 });
  try {
    const r = await checkConnection(cpiCfg(forbidden.address().port), { env: {} });
    const ks = r.steps.find((s) => s.name.startsWith('Read keystore'));
    assert.equal(ks.ok, false);
    assert.match(ks.detail, /HTTP 403.*not allowed/);
  } finally {
    forbidden.close();
  }
});

test('GET /api/cpi/check is available to logged-in users', async () => {
  const server = await strictCpi();
  const api = await startApp(db.pool, cpiEnv(server.address().port));
  try {
    const r = await api.call('GET', '/api/cpi/check');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal((await api.call('GET', '/api/cpi/check', undefined, { Authorization: '' })).status, 401);
  } finally {
    await api.close();
    server.close();
  }
});

test('requests go through HTTP_PROXY when it is set', async () => {
  const target = await strictCpi();
  let proxied = 0;
  // Minimal forward proxy for plain-HTTP targets (absolute-URI requests).
  const proxy = http.createServer((req, res) => {
    proxied++;
    const u = new URL(req.url);
    const fwd = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(fwd);
  });
  // undici tunnels through the proxy with CONNECT, like real HTTPS traffic does.
  proxy.on('connect', (req, socket, head) => {
    proxied++;
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' };
    const r = await checkConnection(cpiCfg(target.address().port), { env });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.match(r.steps[0].detail, /proxy http:\/\/127\.0\.0\.1/);
    assert.ok(proxied >= 1, 'traffic went through the proxy');
  } finally {
    proxy.close();
    target.close();
  }
});

test('network failures get an explanation instead of "fetch failed"', () => {
  const url = 'https://tenant.example/api/v1/KeystoreEntries';
  const wrap = (code, message = 'x') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
  assert.match(describeNetworkError(wrap('ENOTFOUND'), url), /tenant\.example.*could not be resolved.*HTTPS_PROXY/);
  assert.match(describeNetworkError(wrap('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), url), /NODE_EXTRA_CA_CERTS/);
  assert.match(describeNetworkError(wrap('UND_ERR_CONNECT_TIMEOUT'), url), /proxy/);
  assert.match(describeNetworkError(wrap('UND_ERR_ABORTED', 'Proxy response (403) !== 200 when HTTP Tunneling'), url), /proxy refused.*403.*allow tenant\.example/);
  assert.match(describeNetworkError(Object.assign(new Error('t'), { name: 'TimeoutError' }), url), /No answer/);
});

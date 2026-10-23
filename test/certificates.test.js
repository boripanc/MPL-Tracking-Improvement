'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupDatabase, startApp } = require('./helpers');
const { toCertificate, commonName, classify } = require('../src/cpi/certificates');

const DAY = 86400000;
const odata = (ms) => `/Date(${ms})/`;

function entry(alias, daysLeft, extra = {}) {
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

test('toCertificate maps keystore fields', () => {
  const c = toCertificate(entry('partner_as2', 45), Date.now(), { criticalDays: 30, warnDays: 90 });
  assert.equal(c.alias, 'partner_as2');
  assert.equal(c.subject, 'partner_as2.example.com');
  assert.equal(c.issuer, 'Example CA');
  assert.equal(c.state, 'warning');
  assert.equal(c.daysLeft, 46); // 45 days + 1 hour rounds up
  assert.match(c.validTo, /^\d{4}-\d\d-\d\dT/);
});

test('GET /api/certificates reads all pages, classifies, sorts and caches', async () => {
  const cpi = await fakeCpi([
    [entry('ok_cert', 400), entry('expired_cert', -5), entry('sap_cert', 20, { Owner: 'SAP', Type: 'KeyPair' })],
    [entry('soon_cert', 60), entry('no_end', 0, { ValidNotAfter: null })],
  ]);
  const api = await startApp(db.pool, cpiEnv(cpi.port));
  try {
    const meta = await api.call('GET', '/api/meta');
    assert.equal(meta.body.certificatesEnabled, true);

    const r = await api.call('GET', '/api/certificates');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.items.map((c) => c.alias), ['expired_cert', 'sap_cert', 'soon_cert', 'ok_cert', 'no_end']);
    assert.deepEqual(r.body.summary, { total: 5, expired: 1, critical: 1, warning: 1, ok: 1, unknown: 1 });
    assert.equal(r.body.criticalDays, 30);
    assert.equal(r.body.warnDays, 90);
    assert.equal(cpi.seen.keystore, 2, 'followed the __next link');

    await api.call('GET', '/api/certificates');
    assert.equal(cpi.seen.keystore, 2, 'second call is served from the cache');
    await api.call('GET', '/api/certificates?refresh=1');
    assert.equal(cpi.seen.keystore, 2, 'forced refresh right after a read is ignored');
  } finally {
    await api.close();
    cpi.server.close();
  }
});

test('GET /api/certificates explains when CPI is not configured or fails', async () => {
  const notSet = await startApp(db.pool);
  try {
    const r = await notSet.call('GET', '/api/certificates');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.match(r.body.reason, /CPI_API_URL/);
    assert.equal((await notSet.call('GET', '/api/meta')).body.certificatesEnabled, false);
  } finally {
    await notSet.close();
  }

  const cpi = await fakeCpi([[]], { failWith: 403 });
  const api = await startApp(db.pool, cpiEnv(cpi.port));
  try {
    const r = await api.call('GET', '/api/certificates');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /HTTP 403/);
    assert.match(r.body.error, /read the keystore/);
  } finally {
    await api.close();
    cpi.server.close();
  }
});

test('config rejects a partly configured CPI connection', () => {
  const { loadConfig, validateConfig } = require('../src/config');
  const problems = validateConfig(loadConfig({ DATABASE_URL: 'x', APP_USERS: 'a:b', CPI_API_URL: 'https://x/api/v1' }));
  assert.ok(problems.some((p) => /partly configured/.test(p)));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupDatabase, startApp } = require('./helpers');
const SQL = require('../src/sql');
const { effectiveExpiry, splitUserId } = require('../src/cpi/pgp');

const DAY = 86400000;
const odata = (ms) => `/Date(${ms})/`;

// Field names and formats as returned by the real tenant (PgpKeyEntries?$expand=UserIds,SubKeys).
function key(id, daysLeft, { type = 'Public', uid = `Partner ${id} <pgp@${id.toLowerCase()}.example.com>`, subDays, extra = {} } = {}) {
  const now = Date.now();
  const until = (d) => (d === null ? null : odata(now + d * DAY + 3600000));
  return {
    __metadata: { type: 'com.sap.hci.api.PgpKeyEntry' },
    Id: id, KeyId: id, Fingerprint: `AAAA${id}`, Type: type, CreatedTime: odata(now - 300 * DAY),
    Algorithm: 'RSA (1)', KeyLength: 4096, KeyFlags: 3, KeyFlagsLabel: 'certify sign',
    ValidityState: daysLeft !== null && daysLeft < 0 ? 'Expired' : 'Valid', ValidUntil: until(daysLeft),
    ModifiedOn: odata(now - 300 * DAY), ErrorInformation: null, PrimaryUserId: uid,
    UserIds: { results: [{ __metadata: {}, UserId: uid }] },
    SubKeys: { results: [{
      __metadata: {}, Id: `S${id}`, KeyId: `S${id}`, CreatedTime: odata(now - 300 * DAY), Algorithm: 'RSA (1)', KeyLength: 4096,
      KeyFlags: 12, KeyFlagsLabel: 'encrypt_communications encrypt_storage', ValidityState: 'Valid',
      ValidUntil: until(subDays === undefined ? daysLeft : subDays),
    }] },
    PublicResource: { __deferred: { uri: 'x' } }, SecretResource: { __deferred: { uri: 'x' } },
    ...extra,
  };
}
const rings = [
  { __metadata: { type: 'com.sap.hci.api.PgpPublicKeyring' }, Name: 'pubring', LastModifiedBy: 'someone@example.com', LastModifiedTime: odata(Date.now() - DAY), AggregatedStatus: 'DEPLOYED', AggregatedErrors: '' },
  { __metadata: { type: 'com.sap.hci.api.PgpSecretKeyring' }, Name: 'secring', LastModifiedBy: 'other@example.com', LastModifiedTime: odata(Date.now() - 2 * DAY), AggregatedStatus: 'DEPLOYED', AggregatedErrors: '' },
];

let db;
test.before(async () => { db = await setupDatabase({ seed: false }); });
test.after(async () => { await db.teardown(); });

test('effectiveExpiry and splitUserId', () => {
  const enc = (validUntil) => ({ flags: 'encrypt_communications encrypt_storage', validUntil });
  assert.deepEqual(effectiveExpiry(null, []), { validUntil: null, limitedBy: null });
  assert.deepEqual(effectiveExpiry('2027-01-01T00:00:00.000Z', [enc(null)]), { validUntil: '2027-01-01T00:00:00.000Z', limitedBy: 'primary' });
  assert.deepEqual(effectiveExpiry(null, [enc('2026-12-01T00:00:00.000Z')]), { validUntil: '2026-12-01T00:00:00.000Z', limitedBy: 'subkey' });
  // The latest encryption subkey counts; a signing-only subkey does not.
  assert.deepEqual(effectiveExpiry('2028-01-01T00:00:00.000Z', [enc('2026-12-01T00:00:00.000Z'), enc('2027-06-01T00:00:00.000Z'),
    { flags: 'sign', validUntil: '2026-01-01T00:00:00.000Z' }]), { validUntil: '2027-06-01T00:00:00.000Z', limitedBy: 'subkey' });
  assert.deepEqual(splitUserId('hsbc_key (CHG364 renewal) <cmb@hsbc.co.in>'), { name: 'hsbc_key (CHG364 renewal)', email: 'cmb@hsbc.co.in' });
  assert.deepEqual(splitUserId('plain name'), { name: 'plain name', email: '' });
});

test('syncPgpKeys SQL stores keys with user IDs and subkeys, marks removed keys and logs the sync', async () => {
  const sync = async (keys, source = 'n8n') => (await db.pool.query(SQL.syncPgpKeys, [JSON.stringify({ source, keys, keyrings: rings })])).rows[0].result;
  await db.pool.query('TRUNCATE cpi_pgp_keys, cpi_pgp_sync');
  const a = key('1227AB2D2193366D', -10, { type: 'Secret' });
  const b = key('B5F18F48F8CECA1C', 400);
  const r1 = await sync([a, b, { KeyId: '' }]);
  assert.equal(r1.keys, 2);
  assert.equal(r1.removed, 0);
  assert.equal(r1.source, 'n8n');

  const { rows } = await db.pool.query("SELECT * FROM cpi_pgp_keys WHERE key_id = '1227AB2D2193366D'");
  assert.equal(rows[0].key_type, 'Secret');
  assert.equal(rows[0].key_length, 4096);
  assert.equal(rows[0].cpi_state, 'Expired');
  assert.deepEqual(rows[0].user_ids, [a.PrimaryUserId]);
  assert.equal(rows[0].subkeys.length, 1);
  assert.equal(rows[0].subkeys[0].keyId, 'S1227AB2D2193366D');
  assert.equal(rows[0].subkeys[0].flags, 'encrypt_communications encrypt_storage');
  assert.ok(Math.abs(rows[0].valid_until.getTime() - Number(/\d+/.exec(a.ValidUntil)[0])) < 1000, 'OData date converted');
  assert.equal(rows[0].raw.UserIds, undefined);
  assert.equal(rows[0].raw.__metadata, undefined);
  const log = (await db.pool.query('SELECT keyrings FROM cpi_pgp_sync ORDER BY id DESC LIMIT 1')).rows[0].keyrings;
  assert.deepEqual(log.map((g) => [g.name, g.type, g.status]), [['pubring', 'Public', 'DEPLOYED'], ['secring', 'Secret', 'DEPLOYED']]);

  // Next sync without a -> it is marked removed; an empty list changes nothing; it comes back when it reappears.
  assert.equal((await sync([b], 'app')).removed, 1);
  assert.equal(await sync([]), null);
  assert.equal(await sync(null), null);
  const after = await db.pool.query('SELECT key_id, removed_at IS NOT NULL AS removed FROM cpi_pgp_keys ORDER BY key_id');
  assert.deepEqual(after.rows, [{ key_id: '1227AB2D2193366D', removed: true }, { key_id: 'B5F18F48F8CECA1C', removed: false }]);
  await sync([a, b]);
  assert.equal((await db.pool.query("SELECT removed_at FROM cpi_pgp_keys WHERE key_id = '1227AB2D2193366D'")).rows[0].removed_at, null);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM cpi_pgp_sync')).rows[0].n, 3);
});

test('GET /api/pgp-keys reads from the database, classifies and sorts', async () => {
  await db.pool.query('TRUNCATE cpi_pgp_keys, cpi_pgp_sync');
  const api = await startApp(db.pool);
  try {
    const empty = await api.call('GET', '/api/pgp-keys');
    assert.equal(empty.body.enabled, true);
    assert.equal(empty.body.lastSync, null);
    assert.equal(empty.body.stale, true);
    assert.equal(empty.body.canSync, false);

    const keys = [
      key('00000000000000A1', 400), key('00000000000000A2', -5, { type: 'Secret' }), key('00000000000000A3', 7),
      key('00000000000000A4', 60), key('00000000000000A5', null),
      // Primary never expires, but its only encryption subkey ends in 20 days.
      key('00000000000000A6', null, { subDays: 20 }),
      key('00000000000000A7', 10),
    ];
    await db.pool.query(SQL.syncPgpKeys, [JSON.stringify({ source: 'n8n', keys, keyrings: rings })]);
    await db.pool.query(SQL.syncPgpKeys, [JSON.stringify({ source: 'n8n', keys: keys.slice(0, 6), keyrings: rings })]);

    const r = await api.call('GET', '/api/pgp-keys');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((k) => [k.keyId.slice(-2), k.state]),
      [['A2', 'expired'], ['A3', 'critical'], ['A6', 'critical'], ['A4', 'warning'], ['A1', 'ok'], ['A5', 'never']]);
    assert.deepEqual(r.body.summary, { total: 6, expired: 1, critical: 2, warning: 1, ok: 1, never: 1, removed: 0, public: 5, secret: 1 });
    const a6 = r.body.items.find((k) => k.keyId.endsWith('A6'));
    assert.equal(a6.limitedBy, 'subkey');
    assert.equal(a6.primaryValidUntil, null);
    assert.equal(a6.daysLeft, 21);
    assert.equal(a6.email, 'pgp@00000000000000a6.example.com');
    assert.equal(r.body.lastSync.keys, 6);
    assert.equal(r.body.stale, false);
    assert.deepEqual(r.body.keyrings.map((g) => g.lastModifiedBy), ['someone@example.com', 'other@example.com']);

    const withRemoved = await api.call('GET', '/api/pgp-keys?removed=1');
    assert.ok(withRemoved.body.items.find((k) => k.keyId.endsWith('A7')).removedAt);
    assert.equal(withRemoved.body.summary.removed, 1);
    assert.equal(withRemoved.body.summary.total, 6);

    assert.equal((await api.call('POST', '/api/pgp-keys/sync')).status, 409, 'no CPI connection here');
  } finally {
    await api.close();
  }
});

function fakeCpi({ pages, failWith } = {}) {
  const seen = { keys: 0, expand: [], rings: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
    if (url.pathname === '/api/v1/PgpKeyEntries') {
      seen.keys++;
      seen.expand.push(url.searchParams.get('$expand'));
      if (failWith) return json(failWith, { error: { message: { value: 'Forbidden' } } });
      const page = Number(url.searchParams.get('$skiptoken') || 0);
      const d = { results: pages[page] };
      if (page + 1 < pages.length) d.__next = `http://127.0.0.1:${server.address().port}/api/v1/PgpKeyEntries?$expand=UserIds,SubKeys&$skiptoken=${page + 1}`;
      return json(200, { d });
    }
    if (url.pathname === '/api/v1/PgpPublicKeyrings') { seen.rings++; return json(200, { d: { results: [rings[0]] } }); }
    if (url.pathname === '/api/v1/PgpSecretKeyrings') { seen.rings++; return json(404, { error: {} }); }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}
const cpiEnv = (port) => ({
  CPI_API_URL: `http://127.0.0.1:${port}/api/v1`, CPI_TOKEN_URL: `http://127.0.0.1:${port}/oauth/token`,
  CPI_CLIENT_ID: 'id', CPI_CLIENT_SECRET: 'secret',
});

test('POST /api/pgp-keys/sync copies the keys from CPI into the database', async () => {
  await db.pool.query('TRUNCATE cpi_pgp_keys, cpi_pgp_sync');
  const cpi = await fakeCpi({ pages: [[key('00000000000000B1', 400), key('00000000000000B2', -1)], [key('00000000000000B3', 15, { type: 'Secret' })]] });
  const api = await startApp(db.pool, cpiEnv(cpi.port));
  try {
    const s = await api.call('POST', '/api/pgp-keys/sync');
    assert.equal(s.status, 200);
    assert.equal(s.body.keys, 3);
    assert.equal(s.body.source, 'app');
    assert.equal(cpi.seen.keys, 2, 'followed the __next link');
    assert.equal(cpi.seen.expand[0], 'UserIds,SubKeys');
    const r = await api.call('GET', '/api/pgp-keys');
    assert.equal(r.body.canSync, true);
    assert.deepEqual([r.body.summary.total, r.body.summary.expired, r.body.summary.critical], [3, 1, 1]);
    assert.equal(r.body.keyrings.length, 1, 'a missing secret keyring (404) is not an error');
  } finally {
    await api.close();
    cpi.server.close();
  }

  const failing = await fakeCpi({ failWith: 403 });
  const api2 = await startApp(db.pool, cpiEnv(failing.port));
  try {
    const r = await api2.call('POST', '/api/pgp-keys/sync');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /HTTP 403/);
    assert.equal((await api2.call('GET', '/api/pgp-keys')).body.summary.total, 3, 'a failed sync keeps the stored data');
  } finally {
    await api2.close();
    failing.server.close();
  }
});

test('explains when the PGP tables do not exist yet', async () => {
  const bare = await setupDatabase({ seed: false });
  await bare.pool.query('DROP TABLE cpi_pgp_keys, cpi_pgp_sync');
  const api = await startApp(bare.pool);
  try {
    const r = await api.call('GET', '/api/pgp-keys');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.match(r.body.reason, /CPI PGP Keys → Postgres/);
  } finally {
    await api.close();
    await bare.teardown();
  }
});

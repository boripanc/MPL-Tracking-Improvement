'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupDatabase, startApp } = require('./helpers');
const SQL = require('../src/sql');
const { stripSecrets, classify } = require('../src/cpi/security-material');

const DAY = 86400000;
const odata = (ms) => `/Date(${ms})/`;
const desc = (daysAgo, status = 'DEPLOYED') => ({
  __metadata: { type: 'com.sap.hci.api.SecurityArtifactDescriptor' },
  Type: 'CREDENTIALS', DeployedBy: 'someone@example.com', DeployedOn: odata(Date.now() - daysAgo * DAY), Status: status,
});

// Field names and formats as returned by the real tenant (UserCredentials, OAuth2ClientCredentials, SecureParameters).
function user(name, daysAgo, { kind = 'default', status, extra = {} } = {}) {
  return {
    __metadata: { type: 'com.sap.hci.api.UserCredential' }, Name: name, Kind: kind, Description: `${name} login`,
    User: `${name.toLowerCase()}_user`, Password: null, CompanyId: kind === 'successfactors' ? 'COMP1' : null,
    SecurityArtifactDescriptor: desc(daysAgo, status), ...extra,
  };
}
function oauth(name, daysAgo, extra = {}) {
  return {
    __metadata: { type: 'com.sap.hci.api.OAuth2ClientCredential' }, Name: name, Description: '',
    TokenServiceUrl: 'https://login.example.com/oauth2/token', ClientId: `client-${name}`, ClientSecret: null,
    ClientAuthentication: 'header', Scope: 'https://graph.example.com/.default', ScopeContentType: 'urlencoded', Resource: '', Audience: '',
    SecurityArtifactDescriptor: desc(daysAgo), CustomParameters: { __deferred: { uri: 'x' } }, ...extra,
  };
}
const secure = (name, daysAgo) => ({
  __metadata: { type: 'com.sap.hci.api.SecureParameter' }, Name: name, Description: 'api key', SecureParam: null,
  DeployedBy: 'someone@example.com', DeployedOn: odata(Date.now() - daysAgo * DAY), Status: 'DEPLOYED',
});

let db;
test.before(async () => { db = await setupDatabase({ seed: false }); });
test.after(async () => { await db.teardown(); });

test('stripSecrets and classify', () => {
  assert.deepEqual(stripSecrets({ __metadata: {}, Name: 'A', Password: 'p', ClientSecret: 's', SecureParam: 'v', CustomParameters: {},
    SecurityArtifactDescriptor: { __metadata: {}, Status: 'DEPLOYED', password: 'x' } }), { Name: 'A', SecurityArtifactDescriptor: { Status: 'DEPLOYED' } });
  const now = Date.parse('2026-11-19T00:00:00Z');
  assert.deepEqual(classify({ status: 'DEPLOYED', deployedOn: '2025-11-18T00:00:00Z' }, now, 365), { state: 'old', ageDays: 366 });
  assert.deepEqual(classify({ status: 'DEPLOYED', deployedOn: '2026-11-01T00:00:00Z' }, now, 365), { state: 'ok', ageDays: 18 });
  assert.deepEqual(classify({ status: 'ERROR', deployedOn: '2026-11-01T00:00:00Z' }, now, 365), { state: 'error', ageDays: 18 });
  assert.deepEqual(classify({ status: '', deployedOn: null }, now, 365), { state: 'ok', ageDays: null });
});

test('syncSecurityMaterial SQL stores metadata only, merges OAuth2, marks removed artifacts and logs the sync', async () => {
  const sync = async (p) => (await db.pool.query(SQL.syncSecurityMaterial, [JSON.stringify({ source: 'n8n', ...p })])).rows[0].result;
  await db.pool.query('TRUNCATE cpi_security_material, cpi_security_material_sync');
  // Even if CPI ever returned a secret, it must not be stored.
  const leaky = user('SFTP_A', 10, { extra: { Password: 'hunter2' } });
  const r1 = await sync({
    userCredentials: [leaky, user('SF_B', 500, { kind: 'successfactors' }), user('OAUTH_C', 20, { kind: 'oauth2:default' }), { Name: '' }],
    oauth2: [oauth('OAUTH_C', 20, { ClientSecret: 'topsecret' })],
    secureParameters: [secure('KEY_D', 3)],
  });
  assert.equal(r1.items, 4);
  assert.equal(r1.removed, 0);
  assert.deepEqual(r1.counts, { user: 1, successfactors: 1, oauth2: 1, secure_param: 1 });

  const { rows } = await db.pool.query('SELECT * FROM cpi_security_material ORDER BY name');
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.OAUTH_C.kind, 'oauth2');
  assert.equal(by.OAUTH_C.user_name, 'client-OAUTH_C');
  assert.equal(by.OAUTH_C.token_url, 'https://login.example.com/oauth2/token');
  assert.equal(by.OAUTH_C.cpi_kind, null, 'the OAuth2ClientCredentials record wins over the UserCredentials one');
  assert.equal(by.SF_B.kind, 'successfactors');
  assert.equal(by.SF_B.company_id, 'COMP1');
  assert.equal(by.KEY_D.kind, 'secure_param');
  assert.equal(by.KEY_D.status, 'DEPLOYED');
  assert.equal(by.SFTP_A.deployed_by, 'someone@example.com');
  assert.ok(Math.abs(by.SFTP_A.deployed_on.getTime() - (Date.now() - 10 * DAY)) < 5000, 'OData date converted');
  const all = JSON.stringify(rows);
  assert.doesNotMatch(all, /hunter2|topsecret/);
  assert.doesNotMatch(all, /"(Password|ClientSecret|SecureParam|CustomParameters|__metadata)"/);

  // Secure parameters not answered (null): KEY_D stays. SFTP_A gone from user credentials: removed.
  const r2 = await sync({ userCredentials: [user('SF_B', 500, { kind: 'successfactors' }), user('OAUTH_C', 20, { kind: 'oauth2:default' })], oauth2: null, secureParameters: null });
  assert.equal(r2.removed, 1);
  const state = async () => (await db.pool.query('SELECT name, removed_at IS NOT NULL AS removed FROM cpi_security_material ORDER BY name')).rows
    .map((r) => `${r.name}:${r.removed ? 'removed' : 'here'}`).sort();
  assert.deepEqual(await state(), ['KEY_D:here', 'OAUTH_C:here', 'SFTP_A:removed', 'SF_B:here']);
  // Nothing answered: nothing changes and no sync is logged. An empty secure parameter list means "none left".
  assert.equal(await sync({ userCredentials: null, oauth2: null, secureParameters: null }), null);
  assert.equal((await sync({ secureParameters: [] })).removed, 1);
  assert.deepEqual(await state(), ['KEY_D:removed', 'OAUTH_C:here', 'SFTP_A:removed', 'SF_B:here']);
  // SFTP_A comes back when it reappears; SF_B is no longer in the user credentials, so it is removed now.
  await sync({ userCredentials: [leaky] });
  assert.deepEqual(await state(), ['KEY_D:removed', 'OAUTH_C:here', 'SFTP_A:here', 'SF_B:removed']);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM cpi_security_material_sync')).rows[0].n, 4);
});

test('GET /api/security-material reads from the database, classifies and sorts', async () => {
  await db.pool.query('TRUNCATE cpi_security_material, cpi_security_material_sync');
  const api = await startApp(db.pool, { SECMAT_ROTATE_DAYS: '365' });
  try {
    const empty = await api.call('GET', '/api/security-material');
    assert.equal(empty.body.enabled, true);
    assert.equal(empty.body.lastSync, null);
    assert.equal(empty.body.stale, true);
    assert.equal(empty.body.canSync, false);

    const full = { userCredentials: [user('NEW', 5), user('OLD', 800), user('BROKEN', 2, { status: 'ERROR' }), user('GONE', 1)], oauth2: [oauth('API', 400)], secureParameters: [secure('KEY', 30)] };
    await db.pool.query(SQL.syncSecurityMaterial, [JSON.stringify({ source: 'n8n', ...full })]);
    await db.pool.query(SQL.syncSecurityMaterial, [JSON.stringify({ source: 'n8n', ...full, userCredentials: full.userCredentials.slice(0, 3) })]);

    const r = await api.call('GET', '/api/security-material');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((m) => [m.name, m.state]), [['BROKEN', 'error'], ['OLD', 'old'], ['API', 'old'], ['KEY', 'ok'], ['NEW', 'ok']]);
    assert.deepEqual(r.body.summary, { total: 5, error: 1, old: 2, ok: 2, removed: 0,
      kinds: { user: 3, oauth2: 1, secure_param: 1, successfactors: 0, openconnectors: 0, other: 0 } });
    const api1 = r.body.items.find((m) => m.name === 'API');
    assert.equal(api1.kind, 'oauth2');
    assert.equal(api1.user, 'client-API');
    assert.equal(api1.ageDays, 400);
    assert.equal(r.body.rotateDays, 365);
    assert.equal(r.body.lastSync.items, 5);
    assert.equal(r.body.stale, false);
    assert.doesNotMatch(r.text, /password|secret/i);

    const withRemoved = await api.call('GET', '/api/security-material?removed=1');
    assert.ok(withRemoved.body.items.find((m) => m.name === 'GONE').removedAt);
    assert.equal(withRemoved.body.summary.removed, 1);
    assert.equal(withRemoved.body.items.at(-1).name, 'GONE', 'removed artifacts are listed last');

    assert.equal((await api.call('POST', '/api/security-material/sync')).status, 409, 'no CPI connection here');
  } finally {
    await api.close();
  }
});

function fakeCpi({ failUsers, noSecure } = {}) {
  const seen = { users: 0, oauth: 0, secure: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
    if (url.pathname === '/api/v1/UserCredentials') {
      seen.users++;
      if (failUsers) return json(failUsers, { error: { message: { value: 'Forbidden' } } });
      const page = Number(url.searchParams.get('$skiptoken') || 0);
      const d = { results: page ? [user('U2', 3, { extra: { Password: 'leak' } })] : [user('U1', 400)] };
      if (!page) d.__next = `http://127.0.0.1:${server.address().port}/api/v1/UserCredentials?$skiptoken=1`;
      return json(200, { d });
    }
    if (url.pathname === '/api/v1/OAuth2ClientCredentials') { seen.oauth++; return json(200, { d: { results: [oauth('O1', 10, { ClientSecret: 'leak' })] } }); }
    if (url.pathname === '/api/v1/SecureParameters') { seen.secure++; return noSecure ? json(404, { error: {} }) : json(200, { d: { results: [secure('S1', 1)] } }); }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}
const cpiEnv = (port) => ({
  CPI_API_URL: `http://127.0.0.1:${port}/api/v1`, CPI_TOKEN_URL: `http://127.0.0.1:${port}/oauth/token`,
  CPI_CLIENT_ID: 'id', CPI_CLIENT_SECRET: 'secret',
});

test('POST /api/security-material/sync copies the security material from CPI into the database', async () => {
  await db.pool.query('TRUNCATE cpi_security_material, cpi_security_material_sync');
  const cpi = await fakeCpi({ noSecure: true });
  const api = await startApp(db.pool, cpiEnv(cpi.port));
  try {
    const s = await api.call('POST', '/api/security-material/sync');
    assert.equal(s.status, 200);
    assert.equal(s.body.items, 3);
    assert.equal(s.body.source, 'app');
    assert.equal(cpi.seen.users, 2, 'followed the __next link');
    const r = await api.call('GET', '/api/security-material');
    assert.equal(r.body.canSync, true);
    assert.deepEqual(r.body.items.map((m) => m.name).sort(), ['O1', 'U1', 'U2'], 'a tenant without SecureParameters (404) is not an error');
    const raw = (await db.pool.query('SELECT raw FROM cpi_security_material')).rows;
    assert.doesNotMatch(JSON.stringify(raw), /leak/);
  } finally {
    await api.close();
    cpi.server.close();
  }

  const failing = await fakeCpi({ failUsers: 403 });
  const api2 = await startApp(db.pool, cpiEnv(failing.port));
  try {
    const r = await api2.call('POST', '/api/security-material/sync');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /HTTP 403/);
    assert.equal((await api2.call('GET', '/api/security-material')).body.summary.total, 3, 'a failed sync keeps the stored data');
  } finally {
    await api2.close();
    failing.server.close();
  }
});

test('explains when the security material tables do not exist yet', async () => {
  const bare = await setupDatabase({ seed: false });
  await bare.pool.query('DROP TABLE cpi_security_material, cpi_security_material_sync');
  const api = await startApp(bare.pool);
  try {
    const r = await api.call('GET', '/api/security-material');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.match(r.body.reason, /CPI Security Material → Postgres/);
  } finally {
    await api.close();
    await bare.teardown();
  }
});

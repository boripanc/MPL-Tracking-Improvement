'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { setupDatabase, startApp } = require('./helpers');
const { loadConfig, validateConfig } = require('../src/config');

// A small stand-in for an OpenID Connect provider (like Microsoft Entra ID): discovery, keys, an authorize page
// that "signs in" whoever `idp.next` says, and a token endpoint that checks PKCE and the client secret.
function fakeIdp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map();
  const idp = { next: { email: 'Alice@ThaiUnion.com', name: 'Alice A' }, tamper: null, base: '', tokens: new Map() };
  const sign = (claims, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const send = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idp.base);
    let body = '';
    for await (const c of req) body += c;
    if (url.pathname === '/tenant/v2.0/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer: `${idp.base}/tenant/v2.0`, authorization_endpoint: `${idp.base}/authorize`, token_endpoint: `${idp.base}/token`,
        jwks_uri: `${idp.base}/keys`, token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        userinfo_endpoint: `${idp.base}/me`, authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === '/keys') return send(res, 200, { keys: [jwk] });
    if (url.pathname === '/me') {
      const who = idp.tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      return who ? send(res, 200, { sub: idp.userinfoSub || who.sub, email: who.email, name: who.name }) : send(res, 401, { error: 'invalid_token' });
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      idp.lastAuthorize = q;
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { q, who: idp.next });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      if (!idp.noIss) back.searchParams.set('iss', idp.wrongIss || `${idp.base}/tenant/v2.0`);
      res.writeHead(302, { Location: back.toString() }).end();
      return undefined;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      const c = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const basic = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      if (!c || basic !== 'app-id:app-secret' || p.get('redirect_uri') !== c.q.get('redirect_uri')
        || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.q.get('code_challenge')) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: bad code' });
      }
      const now = Math.floor(Date.now() / 1000);
      const at = crypto.randomBytes(8).toString('hex');
      const sub = `sub-${c.who.email}`;
      idp.tokens.set(at, { sub, ...c.who });
      // Like node-oidc-provider (sso.teddybiere.info): in the code flow, email and name come only from userinfo.
      let claims = { iss: `${idp.base}/tenant/v2.0`, aud: 'app-id', sub, iat: now, exp: now + 3600, nonce: c.q.get('nonce'), ...(idp.userinfoOnly ? {} : c.who) };
      if (idp.tamper) claims = idp.tamper(claims);
      let token = sign(claims);
      if (idp.badSignature) token = token.slice(0, -4) + 'AAAA';
      return send(res, 200, { access_token: at, token_type: 'Bearer', id_token: token });
    }
    return send(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    idp.base = `http://127.0.0.1:${server.address().port}`;
    idp.issuer = `${idp.base}/tenant/v2.0`;
    idp.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
    resolve(idp);
  }));
}

// Browser-like client that keeps cookies (with their Path) and follows nothing by itself.
function browser(base) {
  const jar = new Map();
  async function go(url) {
    const u = new URL(url, base);
    const cookie = [...jar.values()].filter((c) => u.pathname.startsWith(c.path)).map((c) => c.pair).join('; ');
    const res = await fetch(u, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const name = pair.split('=')[0];
      const path = (attrs.find((a) => /^path=/i.test(a)) || 'Path=/').slice(5);
      if (/max-age=0/i.test(c)) jar.delete(name); else jar.set(name, { pair, path });
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  /** Login page -> SSO -> provider -> callback. Returns the last response. */
  async function signIn(next = '/') {
    const start = await go(`/login/sso?next=${encodeURIComponent(next)}`);
    if (start.status !== 303) return start;
    const atIdp = await fetch(start.location, { redirect: 'manual' });
    return go(atIdp.headers.get('location'));
  }
  return { go, signIn, jar };
}

let db;
let idp;
let app;
const SSO = () => ({ SSO_ISSUER: idp.issuer, SSO_CLIENT_ID: 'app-id', SSO_CLIENT_SECRET: 'app-secret', SSO_ALLOWED_DOMAINS: 'thaiunion.com', SSO_LABEL: 'Sign in with Microsoft' });

test.before(async () => {
  db = await setupDatabase();
  idp = await fakeIdp();
  app = await startApp(db.pool, SSO());
});
test.after(async () => {
  await app.close();
  await idp.close();
  await db.teardown();
});

test('the login page offers SSO next to the password form', async () => {
  const b = browser(app.base);
  const page = await b.go('/login?next=%2F%3Ftab%3Dcerts');
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="btn pri sso" id="sso" href="\/login\/sso\?next=%2F%3Ftab%3Dcerts">Sign in with Microsoft<\/a>/);
  assert.match(page.text, /<form method="post" action="\/login">/);
});

test('SSO: sign in with the company account and land on the page asked for', async () => {
  const b = browser(app.base);
  const start = await b.go('/login/sso?next=%2F%3Ftab%3Derrors');
  assert.equal(start.status, 303);
  const at = new URL(start.location);
  assert.equal(at.origin + at.pathname, `${idp.base}/authorize`);
  assert.equal(at.searchParams.get('client_id'), 'app-id');
  assert.equal(at.searchParams.get('redirect_uri'), `${app.base}/login/sso/callback`);
  assert.equal(at.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(at.searchParams.get('scope'), 'openid profile email');
  assert.equal(at.searchParams.get('response_mode'), 'query');

  const back = (await fetch(at, { redirect: 'manual' })).headers.get('location');
  const done = await b.go(back);
  assert.equal(done.status, 303);
  assert.equal(done.location, '/?tab=errors');
  const meta = await b.go('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(JSON.parse(meta.text).user, 'alice@thaiunion.com');
  // The same code cannot be used again.
  assert.equal((await b.go(back)).status, 400);
});

test('SSO: other domains, forged state, bad signature, wrong audience and expired tokens are refused', async () => {
  idp.next = { email: 'mallory@gmail.com', name: 'M' };
  try {
    const r = await browser(app.base).signIn();
    assert.equal(r.status, 403);
    assert.match(r.text, /mallory@gmail.com is not allowed/);
  } finally {
    idp.next = { email: 'Alice@ThaiUnion.com', name: 'Alice A' };
  }

  // A callback without the browser's own sign-in cookie (someone else's link) is refused.
  const b = browser(app.base);
  const start = await b.go('/login/sso');
  const back = (await fetch(start.location, { redirect: 'manual' })).headers.get('location');
  const other = browser(app.base);
  assert.equal((await other.go(back)).status, 400);
  const forged = new URL(back);
  forged.searchParams.set('state', 'forged');
  assert.equal((await b.go(forged.toString())).status, 400);

  for (const [what, set] of [
    ['bad signature', () => { idp.badSignature = true; }],
    ['wrong audience', () => { idp.tamper = (c) => ({ ...c, aud: 'other-app' }); }],
    ['other issuer', () => { idp.tamper = (c) => ({ ...c, iss: 'https://evil.example/v2.0' }); }],
    ['expired', () => { idp.tamper = (c) => ({ ...c, exp: c.iat - 3600 }); }],
    ['wrong nonce', () => { idp.tamper = (c) => ({ ...c, nonce: 'x' }); }],
  ]) {
    set();
    try {
      const r = await browser(app.base).signIn();
      assert.equal(r.status, 502, what);
      assert.match(r.text, /The SSO sign-in failed/, what);
    } finally {
      idp.badSignature = false;
      idp.tamper = null;
    }
  }

  // The provider reports an error (for example the user cancelled).
  const c = browser(app.base);
  await c.go('/login/sso');
  const cancelled = await c.go('/login/sso/callback?error=access_denied&error_description=AADSTS65004%3A+User+declined');
  assert.equal(cancelled.status, 401);
  assert.match(cancelled.text, /not completed: AADSTS65004: User declined/);
});

test('SSO: email from userinfo when the ID token has none (node-oidc-provider), and the iss check', async () => {
  idp.userinfoOnly = true;
  try {
    const b = browser(app.base);
    assert.equal((await b.signIn()).status, 303);
    assert.equal(JSON.parse((await b.go('/api/meta')).text).user, 'alice@thaiunion.com');
    idp.userinfoSub = 'someone-else';
    const mixed = await browser(app.base).signIn();
    assert.equal(mixed.status, 502);
    assert.match(mixed.text, /another user/);
  } finally {
    idp.userinfoOnly = false;
    idp.userinfoSub = null;
  }
  for (const [what, set] of [['wrong iss', () => { idp.wrongIss = 'https://evil.example'; }], ['missing iss', () => { idp.noIss = true; }]]) {
    set();
    try {
      const r = await browser(app.base).signIn();
      assert.equal(r.status, 502, what);
    } finally {
      idp.wrongIss = null;
      idp.noIss = false;
    }
  }
});

test('SSO_ONLY hides the password form and refuses passwords; SSO sessions end when the domain is removed', async () => {
  const only = await startApp(db.pool, { ...SSO(), SSO_ONLY: 'true' });
  try {
    const b = browser(only.base);
    const page = await b.go('/login');
    assert.match(page.text, /Sign in with Microsoft/);
    assert.doesNotMatch(page.text, /action="\/login"/);
    assert.equal((await only.call('GET', '/api/meta')).status, 401, 'no Basic passwords either');
    const r = await fetch(`${only.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'user=alice&password=wonderland' });
    assert.equal(r.status, 403);
    assert.equal((await b.signIn()).status, 303);
    assert.equal((await b.go('/api/meta')).status, 200);
  } finally {
    await only.close();
  }

  // Same session key, the domain is no longer allowed: the old SSO session stops working.
  const keyed = await startApp(db.pool, { ...SSO(), SESSION_SECRET: 'k' });
  const narrowed = await startApp(db.pool, { ...SSO(), SESSION_SECRET: 'k', SSO_ALLOWED_DOMAINS: 'example.com' });
  try {
    const s = browser(keyed.base);
    await s.signIn();
    assert.equal((await s.go('/api/meta')).status, 200);
    const t = browser(narrowed.base);
    for (const [k, v] of s.jar) t.jar.set(k, v);
    assert.equal((await t.go('/api/meta')).status, 401);
  } finally {
    await keyed.close();
    await narrowed.close();
  }
});

test('SSO settings are checked at start', () => {
  const base = { DATABASE_URL: 'x' };
  assert.match(validateConfig(loadConfig(base)).join(), /APP_USERS is empty/);
  assert.deepEqual(validateConfig(loadConfig({ ...base, SSO_ISSUER: 'https://login.microsoftonline.com/t/v2.0', SSO_CLIENT_ID: 'id' })), []);
  assert.match(validateConfig(loadConfig({ ...base, APP_USERS: 'a:b', SSO_ISSUER: 'https://login.microsoftonline.com/t/v2.0' })).join(), /both SSO_ISSUER and SSO_CLIENT_ID/);
  assert.match(validateConfig(loadConfig({ ...base, APP_USERS: 'a:b', SSO_ISSUER: 'http://idp.example', SSO_CLIENT_ID: 'id' })).join(), /must start with https/);
  assert.match(validateConfig(loadConfig({ ...base, APP_USERS: 'a:b', SSO_ONLY: 'true' })).join(), /SSO_ONLY=true needs/);
  assert.match(validateConfig(loadConfig({ ...base, APP_USERS: 'a:b', SSO_ISSUER: 'https://i.example', SSO_CLIENT_ID: 'id', SSO_REDIRECT_URL: 'https://app.example/' })).join(), /SSO_REDIRECT_URL/);
});

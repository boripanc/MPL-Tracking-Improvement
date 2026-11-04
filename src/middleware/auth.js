'use strict';

/**
 * Login for the app. Every page and API call needs a signed-in user; only /healthz, the login page and its
 * stylesheet are open.
 *
 * - With SSO set up (SSO_ISSUER, SSO_CLIENT_ID; see src/sso.js) the login page shows "Sign in with SSO": people
 *   sign in with their company account, limited to SSO_ALLOWED_DOMAINS / SSO_ALLOWED_USERS. SSO_ONLY=true hides
 *   the user/password form.
 *
 * - People sign in on /login with one of the APP_USERS accounts and get a session cookie. The session ends after
 *   SESSION_IDLE_MINUTES without activity, after SESSION_MAX_HOURS in any case, on "Sign out", when the user's
 *   password changes in APP_USERS, and (without SESSION_SECRET) when the server restarts.
 * - Scripts can still send HTTP Basic credentials with each request. The browser is never asked for them (no
 *   WWW-Authenticate), because a browser keeps Basic credentials until it is closed and has no way to sign out.
 */
const crypto = require('crypto');

const COOKIE = 'cpi_session';
const FLOW_COOKIE = 'cpi_sso'; // state, nonce and PKCE verifier while the person is at the SSO sign-in page
const FLOW_MS = 10 * 60 * 1000;
const SSO_START = '/login/sso';
const SSO_CALLBACK = '/login/sso/callback';
const PUBLIC_PATHS = new Set(['/login', '/logout', '/styles.css']);
const MAX_FAILURES = 10; // per client address, within FAILURE_WINDOW_MS
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// Compare via fixed-length hashes so the comparison time does not leak the secret's length or content.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** The matching account, checking every entry (no early exit) to keep timing uniform. */
function checkUser(users, user, pass) {
  let found = null;
  for (const u of users) if (safeEqual(u.user, user) & safeEqual(u.pass, pass)) found = found || u;
  return found;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Only paths on this site, so the login cannot send the browser somewhere else. */
function safeNext(next) {
  const n = String(next || '');
  return /^[/](?![/\\])/.test(n) && !/^[/](login|logout)\b/.test(n) ? n : '/';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage({ next, message, bad, sso }) {
  const ssoOn = sso && sso.enabled;
  const showForm = !(ssoOn && sso.only);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · CPI Error Center</title>
<link rel="stylesheet" href="/styles.css">
<style>
  .login{max-width:360px;margin:12vh auto;padding:0 16px}
  .login form{display:grid;gap:12px}
  .login label{display:grid;gap:4px}
  .login input{width:100%}
  .login h1{margin-bottom:14px}
  .login .sso{display:block;text-align:center;text-decoration:none}
  .login .or{text-align:center;margin:14px 0 10px}
</style>
</head>
<body>
<main class="login">
  <div class="card">
    <h1>CPI Error Center</h1>
    ${message ? `<p class="small ${bad ? 'bad' : 'muted'}" role="alert">${esc(message)}</p>` : ''}
    ${ssoOn ? `<a class="btn pri sso" id="sso" href="${SSO_START}?next=${encodeURIComponent(next)}">${esc(sso.label || 'Sign in with SSO')}</a>` : ''}
    ${ssoOn && showForm ? '<p class="muted small or">or with a user and password</p>' : ''}
    ${showForm ? `<form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label>User <input name="user" autocomplete="username" required${ssoOn ? '' : ' autofocus'}></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn${ssoOn ? '' : ' pri'}" type="submit">Sign in</button>
    </form>` : ''}
  </div>
</main>
</body>
</html>`;
}

/**
 * Express middleware that requires a signed-in user and serves /login and /logout.
 * Options: users [{ user, pass }], disabled, sessionSecret, idleMinutes, maxHours, and ssoClient (from createSso).
 */
function requireLogin({ users = [], disabled = false, sessionSecret = '', idleMinutes = 60, maxHours = 12, ssoClient = null } = {}) {
  const sso = ssoClient && ssoClient.enabled ? ssoClient : null;
  if (disabled) {
    return (req, res, next) => {
      if (req.path === '/login' || req.path === '/logout') return res.redirect(303, '/');
      req.user = 'anonymous';
      return next();
    };
  }
  // Without SESSION_SECRET the key changes on every start, so a restart signs everyone out.
  const key = sessionSecret ? crypto.createHash('sha256').update(sessionSecret).digest() : crypto.randomBytes(32);
  const idleMs = idleMinutes * 60 * 1000;
  const maxMs = maxHours * 3600 * 1000;
  const failures = new Map();

  const mac = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  // Ties a session to the password it was opened with: a new password in APP_USERS ends old sessions.
  const passTag = (u) => mac(`pass:${u.user}:${u.pass}`).slice(0, 16);

  const sealed = (v) => { const data = Buffer.from(JSON.stringify(v)).toString('base64url'); return `${data}.${mac(data)}`; };
  function unseal(raw) {
    const [data, sig] = String(raw || '').split('.');
    if (!data || !sig || !safeEqual(mac(data), sig)) return null;
    try { return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  }

  function issue(res, req, s) {
    res.append('Set-Cookie', `${COOKIE}=${sealed(s)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(maxMs / 1000)}${req.secure ? '; Secure' : ''}`);
  }
  function clear(res, req) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
  }

  /** The session in the cookie, if it is genuine, not expired and its user and password still exist. */
  function session(req) {
    const s = unseal(parseCookies(req.headers.cookie)[COOKIE]);
    const now = Date.now();
    if (!s || typeof s.u !== 'string' || !(now - s.iat < maxMs) || !(now - s.seen < idleMs)) return null;
    // SSO sessions: still allowed only while SSO is on and the person is still in the allowed list.
    if (s.k === 'sso') return sso && sso.allowed(s.u) ? s : null;
    if (sso && sso.only) return null;
    const u = users.find((x) => x.user === s.u);
    if (!u || !safeEqual(passTag(u), s.p)) return null;
    return s;
  }

  function basic(req) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i > 0 ? checkUser(users, decoded.slice(0, i), decoded.slice(i + 1)) : null;
  }

  function tooMany(ip) {
    const now = Date.now();
    const f = failures.get(ip);
    if (f && now - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
    return (failures.get(ip) || { n: 0 }).n >= MAX_FAILURES;
  }
  function failed(ip) {
    const f = failures.get(ip) || { n: 0, since: Date.now() };
    f.n += 1;
    failures.set(ip, f);
  }

  function readForm(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 10000) { reject(new Error('too large')); req.destroy(); } });
      req.on('end', () => resolve(new URLSearchParams(body)));
      req.on('error', reject);
    });
  }

  /** This app's address as the browser sees it (behind a reverse proxy: X-Forwarded-Host with TRUST_PROXY). */
  function origin(req) {
    const fwd = req.app.get('trust proxy') && req.get('x-forwarded-host');
    return `${req.protocol}://${fwd ? fwd.split(',')[0].trim() : req.get('host')}`;
  }
  const flowCookie = (req, value, maxAge) => `${FLOW_COOKIE}=${value}; Path=${SSO_START}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

  async function ssoStart(req, res, page) {
    try {
      const { url, flow } = await sso.start({ origin: origin(req), next: safeNext(req.query.next) });
      res.append('Set-Cookie', flowCookie(req, sealed({ ...flow, exp: Date.now() + FLOW_MS }), Math.ceil(FLOW_MS / 1000)));
      return res.redirect(303, url);
    } catch (err) {
      console.error('[auth] SSO sign-in could not start:', err.message);
      return page(502, { next: safeNext(req.query.next), message: `SSO is not available: ${err.message}`, bad: true });
    }
  }

  async function ssoCallback(req, res, page) {
    const flow = unseal(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
    res.append('Set-Cookie', flowCookie(req, '', 0));
    const nextUrl = flow ? safeNext(flow.next) : '/';
    const q = req.query;
    if (q.error) {
      const why = String(q.error_description || q.error).split(/\r?\n/)[0].slice(0, 300);
      return page(401, { next: nextUrl, message: `The SSO sign-in was not completed: ${why}`, bad: true });
    }
    if (!flow || !(flow.exp > Date.now()) || !q.state || !safeEqual(flow.state, String(q.state))) {
      return page(400, { next: nextUrl, message: 'The SSO sign-in could not be verified or took too long. Try again.', bad: true });
    }
    let who;
    try {
      who = await sso.finish({ code: String(q.code || ''), flow });
    } catch (err) {
      console.error('[auth] SSO sign-in failed:', err.message);
      return page(502, { next: nextUrl, message: `The SSO sign-in failed: ${err.message}`, bad: true });
    }
    if (!sso.allowed(who.user)) {
      console.warn(`[auth] SSO user ${who.user} is not allowed (SSO_ALLOWED_DOMAINS / SSO_ALLOWED_USERS)`);
      return page(403, { next: nextUrl, message: `${who.user} is not allowed to use this app. Ask the app owner to add you.`, bad: true });
    }
    const now = Date.now();
    issue(res, req, { u: who.user, k: 'sso', iat: now, seen: now });
    console.log(`[auth] ${who.user} signed in with SSO from ${req.ip}`);
    return res.redirect(303, nextUrl);
  }

  return async (req, res, next) => {
    const page = (status, opts) => res.status(status).type('html').set('Cache-Control', 'no-store').send(loginPage({ ...opts, sso }));

    if (sso && req.path === SSO_START && req.method === 'GET') return ssoStart(req, res, page);
    if (sso && req.path === SSO_CALLBACK && req.method === 'GET') return ssoCallback(req, res, page);

    if (req.path === '/login' && req.method === 'GET') {
      if (session(req)) return res.redirect(303, safeNext(req.query.next));
      const out = req.query.out === '1';
      const expired = req.query.expired === '1';
      return page(200, { next: safeNext(req.query.next), message: out ? 'You are signed out.' : expired ? 'Your session ended. Sign in again.' : '' });
    }
    if (req.path === '/login' && req.method === 'POST') {
      let form;
      try { form = await readForm(req); } catch { return page(400, { next: '/', message: 'The sign-in form could not be read.', bad: true }); }
      const nextUrl = safeNext(form.get('next'));
      if (sso && sso.only) return page(403, { next: nextUrl, message: 'Sign in with SSO.', bad: true });
      if (tooMany(req.ip)) return page(429, { next: nextUrl, message: 'Too many failed sign-ins. Wait 15 minutes and try again.', bad: true });
      const user = (form.get('user') || '').trim();
      const u = checkUser(users, user, form.get('password') || '');
      if (!u) {
        failed(req.ip);
        console.warn(`[auth] failed sign-in for "${user.slice(0, 50)}" from ${req.ip}`);
        return page(401, { next: nextUrl, message: 'Wrong user or password.', bad: true });
      }
      failures.delete(req.ip);
      const now = Date.now();
      issue(res, req, { u: u.user, p: passTag(u), iat: now, seen: now });
      console.log(`[auth] ${u.user} signed in from ${req.ip}`);
      return res.redirect(303, nextUrl);
    }
    if (req.path === '/logout' && req.method !== 'POST') return res.redirect(303, '/');
    if (req.path === '/logout') {
      const s = session(req);
      clear(res, req);
      if (s) console.log(`[auth] ${s.u} signed out`);
      return res.redirect(303, '/login?out=1');
    }
    if (PUBLIC_PATHS.has(req.path)) return next();

    const s = session(req);
    if (s) {
      req.user = s.u;
      // Sliding idle timeout: renew the cookie at most once a minute.
      if (Date.now() - s.seen > 60 * 1000) issue(res, req, { ...s, seen: Date.now() });
      return next();
    }
    const b = sso && sso.only ? null : basic(req);
    if (b) { req.user = b.user; return next(); }

    if (parseCookies(req.headers.cookie)[COOKIE]) clear(res, req);
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      return res.status(401).json({ error: 'Sign in required. Your session may have ended.', login: true });
    }
    const q = new URLSearchParams({ next: safeNext(req.originalUrl) });
    if (parseCookies(req.headers.cookie)[COOKIE]) q.set('expired', '1');
    return res.redirect(303, `/login?${q}`);
  };
}

module.exports = { requireLogin, safeNext };

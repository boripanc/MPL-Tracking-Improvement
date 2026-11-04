'use strict';

/**
 * Single sign-on with OpenID Connect (Microsoft Entra ID, Google Workspace, Okta, Keycloak, SAP IAS, ...).
 *
 * The browser goes to the company sign-in page and comes back to /login/sso/callback with a code. The server swaps
 * the code for an ID token (authorization code flow with PKCE), checks the token's signature against the
 * provider's published keys, its issuer, audience, expiry and nonce, and then signs the person in to this app.
 * No extra packages: discovery, PKCE and the signature check use Node's own fetch (undici) and crypto.
 */
const crypto = require('crypto');
const { fetch: undiciFetch } = require('undici');
const { proxyAgent } = require('./cpi/client');

const CALLBACK_PATH = '/login/sso/callback';
const SKEW_S = 300; // allowed clock difference with the provider
const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};

class SsoError extends Error {}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function createSso(cfg, { env = process.env } = {}) {
  const enabled = Boolean(cfg && cfg.issuer && cfg.clientId);
  const dispatcher = proxyAgent(env);
  let discovery = null;
  let jwks = null;
  let jwksAt = 0;

  async function getJson(url, init = {}) {
    let res;
    try {
      res = await undiciFetch(url, { ...init, dispatcher, signal: AbortSignal.timeout(cfg.timeoutMs || 15000) });
    } catch (err) {
      throw new SsoError(`Cannot reach the sign-in server (${new URL(url).host}): ${(err.cause && err.cause.message) || err.message}`);
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      const why = body && (body.error_description || body.error);
      throw new SsoError(`The sign-in server answered HTTP ${res.status}${why ? `: ${String(why).split('\n')[0].slice(0, 300)}` : ''}`);
    }
    if (!body) throw new SsoError(`The sign-in server did not answer with JSON (${url}).`);
    return body;
  }

  async function meta() {
    if (discovery) return discovery;
    const base = cfg.issuer.replace(/\/+$/, '');
    const d = await getJson(`${base}/.well-known/openid-configuration`);
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri || !d.issuer) {
      throw new SsoError('The sign-in server\'s OpenID configuration is incomplete. Check SSO_ISSUER.');
    }
    discovery = d;
    return d;
  }

  async function key(kid, refresh) {
    const d = await meta();
    if (!jwks || refresh) {
      // Keys rotate: fetch again for an unknown key id, at most once a minute.
      if (refresh && Date.now() - jwksAt < 60 * 1000) return null;
      jwks = (await getJson(d.jwks_uri)).keys || [];
      jwksAt = Date.now();
    }
    const jwk = jwks.find((k) => (kid ? k.kid === kid : true) && (!k.use || k.use === 'sig'));
    if (jwk) return jwk;
    return refresh ? null : key(kid, true);
  }

  /** Checks the ID token and returns its claims. */
  async function verifyIdToken(token, nonce) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new SsoError('The sign-in server sent no valid ID token.');
    let header;
    let claims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw new SsoError('The ID token could not be read.'); }
    const alg = ALGS[header.alg];
    if (!alg) throw new SsoError(`The ID token is signed with ${header.alg}, which is not accepted.`);
    const jwk = await key(header.kid);
    if (!jwk) throw new SsoError('The ID token is signed with an unknown key.');
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {
      key: pub,
      ...(alg.pss ? { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}),
      ...(alg.ec ? { dsaEncoding: 'ieee-p1363' } : {}),
    }, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new SsoError('The ID token signature is not valid.');

    const d = await meta();
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw new SsoError(`The ID token comes from ${claims.iss}, not from ${d.issuer}.`);
    if (!aud.includes(cfg.clientId)) throw new SsoError('The ID token was issued for another application.');
    if (aud.length > 1 && claims.azp && claims.azp !== cfg.clientId) throw new SsoError('The ID token was issued for another application.');
    if (!(claims.exp > now - SKEW_S)) throw new SsoError('The ID token has expired. Check the server clock.');
    if (claims.nbf && claims.nbf > now + SKEW_S) throw new SsoError('The ID token is not valid yet. Check the server clock.');
    if (!claims.nonce || claims.nonce !== nonce) throw new SsoError('The sign-in could not be verified (nonce mismatch). Start it again.');
    return claims;
  }

  /** Where the provider sends the browser back: SSO_REDIRECT_URL, or this app's address + /login/sso/callback. */
  function redirectUri(origin) {
    return cfg.redirectUrl || `${origin}${CALLBACK_PATH}`;
  }

  /** Starts a sign-in. Returns the provider URL and the values to keep (in a short-lived cookie) for the return. */
  async function start({ origin, next }) {
    const d = await meta();
    const flow = {
      state: crypto.randomBytes(24).toString('base64url'),
      nonce: crypto.randomBytes(24).toString('base64url'),
      verifier: crypto.randomBytes(48).toString('base64url'),
      redirect: redirectUri(origin),
      next,
    };
    const url = new URL(d.authorization_endpoint);
    const q = url.searchParams;
    q.set('response_type', 'code');
    q.set('response_mode', 'query');
    q.set('client_id', cfg.clientId);
    q.set('redirect_uri', flow.redirect);
    q.set('scope', cfg.scopes);
    q.set('state', flow.state);
    q.set('nonce', flow.nonce);
    q.set('code_challenge', crypto.createHash('sha256').update(flow.verifier).digest('base64url'));
    q.set('code_challenge_method', 'S256');
    if (cfg.prompt) q.set('prompt', cfg.prompt);
    if (cfg.domainHint) q.set('domain_hint', cfg.domainHint);
    return { url: url.toString(), flow };
  }

  /** Finishes a sign-in: swaps the code for tokens and returns { user, name, claims }. */
  async function finish({ code, flow }) {
    const d = await meta();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirect,
      client_id: cfg.clientId,
      code_verifier: flow.verifier,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (cfg.clientSecret) {
      const methods = d.token_endpoint_auth_methods_supported || ['client_secret_basic'];
      if (methods.includes('client_secret_post') && !methods.includes('client_secret_basic')) form.set('client_secret', cfg.clientSecret);
      else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
    }
    const tokens = await getJson(d.token_endpoint, { method: 'POST', headers, body: form.toString() });
    const claims = await verifyIdToken(tokens.id_token, flow.nonce);
    const user = String(claims[cfg.userClaim] || claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
    if (!user) throw new SsoError(`The ID token has no ${cfg.userClaim || 'email'} claim, so the user is unknown. Add the "email" scope or set SSO_USER_CLAIM.`);
    return { user, name: claims.name || user, claims };
  }

  /** SSO_ALLOWED_USERS / SSO_ALLOWED_DOMAINS; both empty = everyone the provider signs in. */
  function allowed(user) {
    const u = String(user || '').toLowerCase();
    if (!cfg.allowedUsers.length && !cfg.allowedDomains.length) return true;
    if (cfg.allowedUsers.includes(u)) return true;
    const domain = u.includes('@') ? u.slice(u.lastIndexOf('@') + 1) : '';
    return Boolean(domain) && cfg.allowedDomains.includes(domain);
  }

  return { enabled, label: cfg.label, only: Boolean(cfg.only), start, finish, allowed, redirectUri };
}

module.exports = { createSso, SsoError, CALLBACK_PATH };

'use strict';

/*
 * SAP CPI OData API client using OAuth2 client credentials.
 * cfg: { apiUrl, tokenUrl, clientId, clientSecret, requestTimeoutMs }
 *
 * Uses undici so that the standard proxy variables (HTTPS_PROXY / HTTP_PROXY / NO_PROXY) are honoured;
 * Node's built-in fetch ignores them, which breaks on servers that reach the internet through a company proxy.
 */

const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');

// undici prints an "EnvHttpProxyAgent is experimental" warning once; it is stable enough for this use.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning && warning.message;
  if (/EnvHttpProxyAgent is experimental/.test(text || '')) return undefined;
  return originalEmitWarning.call(process, warning, ...rest);
};

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

function proxyInUse(env = process.env) {
  const name = PROXY_VARS.find((n) => env[n]);
  if (!name) return null;
  try {
    const u = new URL(env[name]);
    return `${u.protocol}//${u.host}`; // never expose proxy credentials
  } catch {
    return env[name];
  }
}

const NETWORK_HINTS = {
  ENOTFOUND: 'the host name could not be resolved. Check the URL; if this server needs a proxy, set HTTPS_PROXY',
  EAI_AGAIN: 'the host name could not be resolved (DNS). Check the URL and the server\'s DNS / proxy settings',
  ECONNREFUSED: 'the connection was refused. Check the URL, firewall and proxy settings',
  ECONNRESET: 'the connection was reset, often by a firewall or proxy',
  ETIMEDOUT: 'the connection timed out. The server probably needs a proxy (set HTTPS_PROXY) or a firewall opening',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out. The server probably needs a proxy (set HTTPS_PROXY) or a firewall opening',
  UND_ERR_SOCKET: 'the connection was closed unexpectedly, often by a firewall or proxy',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate not trusted, usually company TLS inspection. Set NODE_EXTRA_CA_CERTS to your company root CA file',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS certificate not trusted, usually company TLS inspection. Set NODE_EXTRA_CA_CERTS to your company root CA file',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted, usually company TLS inspection. Set NODE_EXTRA_CA_CERTS to your company root CA file',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate not trusted (self-signed). Set NODE_EXTRA_CA_CERTS to the CA file',
  CERT_HAS_EXPIRED: 'the server\'s TLS certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the TLS certificate does not match the host name. Check the URL',
};

/** Turns low-level fetch failures ("fetch failed") into a message that says what to fix. */
function describeNetworkError(err, url) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `No answer from ${host} within the time limit. The server probably needs a proxy (HTTPS_PROXY) or a firewall opening`;
  }
  let cause = err;
  while (cause && cause.cause && !cause.code) cause = cause.cause;
  const code = (cause && cause.code) || (err && err.code);
  const proxyStatus = /Proxy response \((\d+)\)/.exec((cause && cause.message) || '');
  if (proxyStatus) {
    return `Cannot reach ${host}: the proxy refused the connection (HTTP ${proxyStatus[1]}). Ask the network team to allow ${host} through the proxy`;
  }
  if (code && NETWORK_HINTS[code]) return `Cannot reach ${host}: ${NETWORK_HINTS[code]} (${code})`;
  const detail = (cause && cause.message) || (err && err.message) || String(err);
  return `Cannot reach ${host}: ${detail}${code ? ` (${code})` : ''}`;
}

/** Proxy agent built from HTTPS_PROXY / HTTP_PROXY / NO_PROXY (upper or lower case), or undefined for direct. */
function proxyAgent(env) {
  if (!proxyInUse(env)) return undefined;
  const httpProxy = env.HTTP_PROXY || env.http_proxy || undefined;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || httpProxy;
  return new EnvHttpProxyAgent({ httpProxy: httpProxy || httpsProxy, httpsProxy, noProxy: env.NO_PROXY || env.no_proxy || '' });
}

class CpiError extends Error {
  constructor(message, { step, status } = {}) {
    super(message);
    this.step = step;
    this.status = status;
  }
}

function createClient(cfg, { env = process.env } = {}) {
  const dispatcher = proxyAgent(env);
  let token = null;
  let tokenExpires = 0;

  async function send(url, init, step) {
    try {
      return await undiciFetch(url, { ...init, dispatcher, signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
    } catch (err) {
      throw new CpiError(describeNetworkError(err, url), { step });
    }
  }

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await send(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    }, 'token');
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !body.access_token) {
      const why = body.error_description || body.error || text.slice(0, 150) || res.statusText;
      const hint = res.status === 401 || body.error === 'invalid_client'
        ? ' Check CPI_CLIENT_ID and CPI_CLIENT_SECRET (copy them from the same service key as CPI_TOKEN_URL).'
        : res.status === 404 ? ' Check CPI_TOKEN_URL (the "tokenurl" of the service key).' : '';
      throw new CpiError(`OAuth token request failed: HTTP ${res.status} ${why}.${hint}`, { step: 'token', status: res.status });
    }
    token = body.access_token;
    tokenExpires = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return token;
  }

  // `path` is relative to apiUrl, or an absolute URL on the same host (OData __next links).
  function resolve(path) {
    if (!/^https?:/i.test(path)) return cfg.apiUrl + path;
    if (new URL(path).origin !== new URL(cfg.apiUrl).origin) throw new Error('Refusing to follow a link to another host');
    return path;
  }

  async function request(path, { accept = 'application/json', retry = true } = {}) {
    const url = resolve(path);
    const res = await send(url, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: accept } }, 'api');
    if (res.status === 401 && retry) {
      token = null;
      return request(path, { accept, retry: false });
    }
    return res;
  }

  return { request, getToken, proxy: proxyInUse(env) };
}

/**
 * Step-by-step connection check for the UI and `npm run check:cpi`. Never returns secrets.
 * Each step: { name, ok, detail, ms }.
 */
async function checkConnection(cfg, { env = process.env } = {}) {
  const steps = [];
  const host = (u) => { try { return new URL(u).host; } catch { return u || '(not set)'; } };
  const missing = ['apiUrl', 'tokenUrl', 'clientId', 'clientSecret'].filter((k) => !cfg[k]);
  steps.push({
    name: 'Settings',
    ok: missing.length === 0,
    detail: missing.length
      ? `Missing: ${missing.join(', ')}`
      : `API ${cfg.apiUrl} · token ${host(cfg.tokenUrl)} · client ${cfg.clientId.slice(0, 12)}… · proxy ${proxyInUse(env) || 'none'}`,
  });
  if (missing.length) return { ok: false, steps };

  const client = createClient(cfg, { env });
  const timed = async (name, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail, ms: Date.now() - t });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: err.message, ms: Date.now() - t });
      return false;
    }
  };

  if (!(await timed('Get OAuth token', async () => { await client.getToken(); return `Token received from ${host(cfg.tokenUrl)}`; }))) {
    return { ok: false, steps };
  }
  const read = async (path, label) => {
    const res = await client.request(path);
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const hint = res.status === 403 ? ' The service key is not allowed to read this; add the missing role to the service instance.'
        : res.status === 404 ? ' Check that CPI_API_URL is the tenant API address ending in /api/v1.' : '';
      throw new Error(`HTTP ${res.status} ${body}${hint}`);
    }
    if (!/json/i.test(type)) throw new Error(`Got ${type || 'no content type'} instead of JSON. CPI_API_URL must be the tenant API address (…/api/v1), not the web UI`);
    const n = (((await res.json()).d || {}).results || []).length;
    return `${n} ${label} returned`;
  };
  const ks = await timed('Read keystore (Certificates)', () => read('/KeystoreEntries', 'entries'));
  const mpl = await timed('Read message processing logs', () => read('/MessageProcessingLogs?$top=1&$format=json', 'log'));
  return { ok: ks && mpl, steps };
}

module.exports = { createClient, checkConnection, describeNetworkError, proxyInUse, proxyAgent, CpiError };

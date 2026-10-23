'use strict';

/*
 * Minimal SAP CPI OData API client using OAuth2 client credentials.
 * cfg: { apiUrl, tokenUrl, clientId, clientSecret, requestTimeoutMs }
 */

function createClient(cfg) {
  let token = null;
  let tokenExpires = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`CPI token request failed: HTTP ${res.status}`);
    const body = await res.json();
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
    const res = await fetch(resolve(path), {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: accept },
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (res.status === 401 && retry) {
      token = null;
      return request(path, { accept, retry: false });
    }
    return res;
  }

  return { request };
}

module.exports = { createClient };

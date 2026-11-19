'use strict';

/*
 * Security material menu. The user credentials, OAuth2 client credentials and secure parameters in CPI
 * (Monitor > Manage Security > Security Material, OData "UserCredentials", "OAuth2ClientCredentials" and
 * "SecureParameters") are copied into the database (tables cpi_security_material and cpi_security_material_sync)
 * by the n8n workflow "CPI Security Material → Postgres" or by this app's own sync. The web page always reads from
 * the database. Passwords, client secrets and secure parameter values are never read into the database: CPI does
 * not return them, and any field that could hold one is dropped here and again in the SQL.
 * Keystore entries are on the Certificates menu and PGP keys on the PGP keys menu.
 */

const SQL = require('../sql');

const MAX_PAGES = 20;
const DAY = 86400000;
const ORDER = { error: 0, old: 1, ok: 2 };
const KINDS = ['user', 'oauth2', 'secure_param', 'successfactors', 'openconnectors', 'other'];
const SECRET = /password|secret|secureparam|^__/i;

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Drops every field that could hold a secret (top level and one level down), plus OData metadata. */
function stripSecrets(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (SECRET.test(k) || k === 'CustomParameters') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? stripSecrets(v) : v;
  }
  return out;
}

/**
 * error = not deployed in CPI (status other than DEPLOYED); old = not changed for `rotateDays` or more
 * (the password or secret is probably due for rotation); ok otherwise.
 */
function classify(r, now, rotateDays) {
  const ageDays = r.deployedOn ? Math.floor((now - Date.parse(r.deployedOn)) / DAY) : null;
  if (r.status && !/^deployed$/i.test(r.status)) return { state: 'error', ageDays };
  if (ageDays != null && ageDays >= rotateDays) return { state: 'old', ageDays };
  return { state: 'ok', ageDays };
}

/** Converts a cpi_security_material row into the shape the web page uses. */
function fromRow(r, now, rotateDays) {
  const item = {
    name: r.name,
    kind: KINDS.includes(r.kind) ? r.kind : 'other',
    cpiKind: r.cpi_kind || '',
    description: r.description || '',
    user: r.user_name || '',
    companyId: r.company_id || '',
    tokenUrl: r.token_url || '',
    clientAuthentication: r.client_auth || '',
    scope: r.scope || '',
    resource: r.resource || '',
    audience: r.audience || '',
    deployedBy: r.deployed_by || '',
    deployedOn: iso(r.deployed_on),
    status: r.status || '',
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    removedAt: iso(r.removed_at),
  };
  return { ...item, ...classify(item, now, rotateDays) };
}

async function readAll(client, set) {
  const out = [];
  let path = `/${set}`;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res = await client.request(path);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      const hint = res.status === 404 ? ' (check that CPI_API_URL ends in /api/v1)'
        : res.status === 403 ? ' (the service key may not read security material)' : '';
      const err = new Error(`CPI ${set} request failed: HTTP ${res.status}${hint}${detail ? ` ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    if (!/json/i.test(res.headers.get('content-type') || '')) {
      throw new Error('CPI did not return JSON. CPI_API_URL must be the tenant API address ending in /api/v1');
    }
    const d = (await res.json()).d || {};
    out.push(...(d.results || []).map(stripSecrets));
    path = d.__next || null;
  }
  return out;
}

/**
 * Reads the three kinds of security material from CPI, without secrets. A kind that CPI does not answer is null
 * (left unchanged in the database); the user credentials must answer, or the sync fails.
 */
async function fetchSecurityMaterial(client) {
  const optional = async (set) => {
    try { return await readAll(client, set); } catch (err) { if (err.status === 404 || err.status === 403) return null; throw err; }
  };
  const userCredentials = await readAll(client, 'UserCredentials');
  const oauth2 = await optional('OAuth2ClientCredentials');
  const secureParameters = await optional('SecureParameters');
  return { userCredentials, oauth2, secureParameters };
}

/**
 * Security material store backed by PostgreSQL.
 *  - read(): artifacts from the database, classified by status and age
 *  - sync(): copy the security material from CPI into the database (only when `client` is given)
 */
function createSecurityMaterialStore({ pool, client = null, rotateDays = 365, staleHours = 26, now = () => Date.now() }) {
  let syncing = null;

  async function read({ includeRemoved = false } = {}) {
    let data;
    try {
      ({ rows: [{ result: data }] } = await pool.query(SQL.readSecurityMaterial, [JSON.stringify({ includeRemoved })]));
    } catch (err) {
      if (err.code === '42P01') {
        return { enabled: false, reason: 'The security material tables do not exist yet. Run "npm run db:init" once, or run the n8n workflow "CPI Security Material → Postgres", which creates them.' };
      }
      throw err;
    }
    const t = now();
    const items = data.items.map((r) => fromRow(r, t, rotateDays))
      .sort((a, b) => Boolean(a.removedAt) - Boolean(b.removedAt) || ORDER[a.state] - ORDER[b.state]
        || (a.deployedOn || '').localeCompare(b.deployedOn || '') || a.name.localeCompare(b.name));
    const summary = { total: 0, error: 0, old: 0, ok: 0, removed: 0, kinds: Object.fromEntries(KINDS.map((k) => [k, 0])) };
    for (const m of items) {
      if (m.removedAt) { summary.removed++; continue; }
      summary.total++;
      summary[m.state]++;
      summary.kinds[m.kind]++;
    }
    const last = data.lastSync;
    return {
      enabled: true,
      canSync: Boolean(client),
      lastSync: last ? { at: iso(last.synced_at), source: last.source, items: last.items, removed: last.removed, counts: last.counts || {} } : null,
      stale: !last || t - Date.parse(last.synced_at) > staleHours * 3600000,
      staleHours,
      rotateDays,
      summary,
      items,
    };
  }

  async function sync({ source = 'app' } = {}) {
    if (!client) throw new Error('This server has no CPI connection configured, so it cannot sync. The n8n workflow keeps the data up to date.');
    if (!syncing) {
      syncing = (async () => {
        const payload = await fetchSecurityMaterial(client);
        const { rows } = await pool.query(SQL.syncSecurityMaterial, [JSON.stringify({ source, ...payload })]);
        return rows[0].result || { items: 0, removed: 0 };
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  return { read, sync, canSync: Boolean(client) };
}

/** Runs sync() now and then every `intervalMinutes`, without overlapping. Returns { stop }. */
function startSecurityMaterialSync({ store, intervalMinutes, logger = console }) {
  const tick = async () => {
    try {
      const r = await store.sync({ source: 'app' });
      logger.log(`[security-material] synced ${r.items} artifacts from CPI (${r.removed} removed)`);
    } catch (err) {
      logger.error('[security-material] sync failed:', err.message);
    }
  };
  const first = setTimeout(tick, 7000);
  const timer = setInterval(tick, intervalMinutes * 60000);
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createSecurityMaterialStore, startSecurityMaterialSync, fetchSecurityMaterial, fromRow, classify, stripSecrets };

'use strict';

/*
 * PGP keys menu. The keys in the CPI PGP public and secret keyrings (Monitor > Manage Security > PGP Keys,
 * OData "PgpKeyEntries" with their user IDs and subkeys) are copied into the database (tables cpi_pgp_keys and
 * cpi_pgp_sync) by the n8n workflow "CPI PGP Keys → Postgres" or by this app's own sync. The web page always reads
 * from the database. Key material is never read or stored.
 */

const SQL = require('../sql');
const { classify } = require('./certificates');

const MAX_PAGES = 20;
const ORDER = { expired: 0, critical: 1, warning: 2, ok: 3, never: 4 };

const iso = (v) => (v ? new Date(v).toISOString() : null);
const time = (v) => (v ? Date.parse(v) : Infinity); // no end date = never expires

/** "Partner name (comment) <owner@example.com>" -> { name, email }. */
function splitUserId(uid) {
  const s = String(uid || '').trim();
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(s);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: s, email: /@/.test(s) ? s : '' };
}

/**
 * When the key stops working: the end of the primary key, or earlier when every encryption subkey ends before it
 * (a partner can then no longer encrypt to it). Returns { validUntil, limitedBy: 'primary' | 'subkey' | null }.
 */
function effectiveExpiry(primaryUntil, subkeys) {
  const enc = (subkeys || []).filter((k) => /encrypt/i.test(k.flags || ''));
  const subEnd = enc.length ? Math.max(...enc.map((k) => time(k.validUntil))) : Infinity;
  const primEnd = time(primaryUntil);
  if (primEnd === Infinity && subEnd === Infinity) return { validUntil: null, limitedBy: null };
  return subEnd < primEnd
    ? { validUntil: new Date(subEnd).toISOString(), limitedBy: 'subkey' }
    : { validUntil: new Date(primEnd).toISOString(), limitedBy: 'primary' };
}

/** Converts a cpi_pgp_keys row into the shape the web page uses. */
function fromRow(r, now, thresholds) {
  const subkeys = (Array.isArray(r.subkeys) ? r.subkeys : []).map((k) => ({
    keyId: k.keyId || '', algorithm: k.algorithm || '', keyLength: k.keyLength != null ? Number(k.keyLength) : null,
    flags: k.flags || '', cpiState: k.state || '', createdAt: iso(k.createdAt), validUntil: iso(k.validUntil),
  }));
  const eff = effectiveExpiry(iso(r.valid_until), subkeys);
  const c = classify(eff.validUntil, now, thresholds);
  const owner = splitUserId(r.primary_user_id);
  return {
    id: `${r.key_type}:${r.key_id}`,
    keyId: r.key_id,
    keyType: r.key_type,
    fingerprint: r.fingerprint || '',
    algorithm: r.algorithm || '',
    keyLength: r.key_length != null ? Number(r.key_length) : null,
    flags: r.key_flags || '',
    primaryUserId: r.primary_user_id || '',
    name: owner.name,
    email: owner.email,
    userIds: Array.isArray(r.user_ids) ? r.user_ids : [],
    subkeys,
    createdAt: iso(r.created_at),
    primaryValidUntil: iso(r.valid_until),
    validUntil: eff.validUntil,
    limitedBy: eff.limitedBy,
    cpiState: r.cpi_state || '',
    modifiedOn: iso(r.modified_on),
    errorInformation: r.error_information || '',
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    removedAt: iso(r.removed_at),
    daysLeft: c.daysLeft,
    state: c.state === 'unknown' ? 'never' : c.state,
  };
}

async function readJson(client, path, label) {
  const res = await client.request(path);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const hint = res.status === 404 ? ' (check that CPI_API_URL ends in /api/v1)'
      : res.status === 403 ? ' (the service key may not read security material)' : '';
    const err = new Error(`CPI ${label} request failed: HTTP ${res.status}${hint}${detail ? ` ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (!/json/i.test(res.headers.get('content-type') || '')) {
    throw new Error('CPI did not return JSON. CPI_API_URL must be the tenant API address ending in /api/v1');
  }
  return (await res.json()).d || {};
}

async function readAll(client, path, label) {
  const out = [];
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const d = await readJson(client, path, label);
    out.push(...(d.results || []));
    path = d.__next || null;
  }
  return out;
}

/** Reads the PGP keys (with user IDs and subkeys) and the two keyrings from CPI (raw OData records). */
async function fetchPgp(client) {
  const keys = await readAll(client, '/PgpKeyEntries?$expand=UserIds,SubKeys', 'PGP keys');
  const keyrings = [];
  for (const set of ['PgpPublicKeyrings', 'PgpSecretKeyrings']) {
    // The keyring details are extra information; a tenant without one of the keyrings answers 404.
    try {
      keyrings.push(...await readAll(client, `/${set}`, 'PGP keyring'));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return { keys, keyrings };
}

/**
 * PGP key store backed by PostgreSQL.
 *  - read(): keys from the database, classified by days left
 *  - sync(): copy the keys from CPI into the database (only when `client` is given)
 */
function createPgpStore({ pool, client = null, thresholds, staleHours = 26, now = () => Date.now() }) {
  let syncing = null;

  async function read({ includeRemoved = false } = {}) {
    let data;
    try {
      ({ rows: [{ result: data }] } = await pool.query(SQL.readPgpKeys, [JSON.stringify({ includeRemoved })]));
    } catch (err) {
      if (err.code === '42P01') {
        return { enabled: false, reason: 'The PGP key tables do not exist yet. Run "npm run db:init" once, or run the n8n workflow "CPI PGP Keys → Postgres", which creates them.' };
      }
      throw err;
    }
    const t = now();
    const items = data.items.map((r) => fromRow(r, t, thresholds))
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.validUntil || '9').localeCompare(b.validUntil || '9')
        || a.primaryUserId.localeCompare(b.primaryUserId));
    const summary = { total: 0, expired: 0, critical: 0, warning: 0, ok: 0, never: 0, removed: 0, public: 0, secret: 0 };
    for (const k of items) {
      if (k.removedAt) { summary.removed++; continue; }
      summary.total++;
      summary[k.state]++;
      if (/^public$/i.test(k.keyType)) summary.public++;
      else if (/^secret$/i.test(k.keyType)) summary.secret++;
    }
    const last = data.lastSync;
    return {
      enabled: true,
      canSync: Boolean(client),
      lastSync: last ? { at: iso(last.synced_at), source: last.source, keys: last.keys, removed: last.removed } : null,
      keyrings: last && Array.isArray(last.keyrings) ? last.keyrings.map((g) => ({ ...g, lastModifiedTime: iso(g.lastModifiedTime) })) : [],
      stale: !last || t - Date.parse(last.synced_at) > staleHours * 3600000,
      staleHours,
      criticalDays: thresholds.criticalDays,
      warnDays: thresholds.warnDays,
      summary,
      items,
    };
  }

  async function sync({ source = 'app' } = {}) {
    if (!client) throw new Error('This server has no CPI connection configured, so it cannot sync. The n8n workflow keeps the data up to date.');
    if (!syncing) {
      syncing = (async () => {
        const { keys, keyrings } = await fetchPgp(client);
        const { rows } = await pool.query(SQL.syncPgpKeys, [JSON.stringify({ source, keys, keyrings })]);
        return rows[0].result || { keys: 0, removed: 0 };
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  return { read, sync, canSync: Boolean(client) };
}

/** Runs sync() now and then every `intervalMinutes`, without overlapping. Returns { stop }. */
function startPgpSync({ store, intervalMinutes, logger = console }) {
  const tick = async () => {
    try {
      const r = await store.sync({ source: 'app' });
      logger.log(`[pgp] synced ${r.keys} PGP keys from CPI (${r.removed} removed)`);
    } catch (err) {
      logger.error('[pgp] sync failed:', err.message);
    }
  };
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, intervalMinutes * 60000);
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createPgpStore, startPgpSync, fetchPgp, fromRow, effectiveExpiry, splitUserId };

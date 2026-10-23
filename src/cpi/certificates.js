'use strict';

/*
 * Certificates menu. The CPI keystore is copied into the database (tables cpi_keystore_entries and
 * cpi_keystore_sync) by the n8n workflow "CPI Keystore → Postgres" or by this app's own sync.
 * The web page always reads from the database, so it works even when this server cannot reach CPI.
 */

const SQL = require('../sql');

const DAY = 86400000;
const MAX_PAGES = 20;
const ORDER = { expired: 0, critical: 1, warning: 2, ok: 3, unknown: 4 };

/** Returns the CN (or the first part) of a distinguished name, for compact display. */
function commonName(dn) {
  if (!dn) return '';
  const m = /(?:^|,\s*)CN=((?:\\,|[^,])+)/i.exec(dn);
  return (m ? m[1] : dn.split(',')[0]).replace(/\\,/g, ',').trim();
}

function classify(validTo, now, { criticalDays, warnDays }) {
  if (!validTo) return { daysLeft: null, state: 'unknown' };
  const diff = Date.parse(validTo) - now;
  // Round towards 'more time left' for future dates (9.9 days -> 10) and 'longer ago' for past ones.
  const daysLeft = diff > 0 ? Math.ceil(diff / DAY) : Math.floor(diff / DAY);
  let state = 'ok';
  if (diff <= 0) state = 'expired';
  else if (daysLeft < criticalDays) state = 'critical';
  else if (daysLeft < warnDays) state = 'warning';
  return { daysLeft, state };
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Converts a cpi_keystore_entries row into the shape the web page uses. */
function fromRow(r, now, thresholds) {
  const validTo = iso(r.valid_to);
  return {
    id: r.hexalias,
    alias: r.alias || '',
    entryType: r.entry_type || '',
    keyType: r.key_type || '',
    keySize: r.key_size != null ? Number(r.key_size) : null,
    owner: r.owner || '',
    subjectDN: r.subject_dn || '',
    issuerDN: r.issuer_dn || '',
    subject: commonName(r.subject_dn),
    issuer: commonName(r.issuer_dn),
    serialNumber: r.serial_number || '',
    signatureAlgorithm: r.signature_algorithm || '',
    fingerprintSha256: r.fingerprint_sha256 || '',
    validFrom: iso(r.valid_from),
    validTo,
    lastModifiedBy: r.last_modified_by || '',
    lastModifiedTime: iso(r.last_modified_time),
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    removedAt: iso(r.removed_at),
    ...classify(validTo, now, thresholds),
  };
}

/** Reads all KeystoreEntries pages from CPI (raw OData records). */
async function fetchKeystoreEntries(client) {
  const entries = [];
  // The keystore API rejects the $format option; JSON is requested via the Accept header instead.
  let path = '/KeystoreEntries';
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res = await client.request(path);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      const hint = res.status === 404 ? ' (check that CPI_API_URL ends in /api/v1)'
        : res.status === 403 ? ' (the service key may not read the keystore)' : '';
      const err = new Error(`CPI keystore request failed: HTTP ${res.status}${hint}${detail ? ` ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    if (!/json/i.test(res.headers.get('content-type') || '')) {
      throw new Error('CPI did not return JSON. CPI_API_URL must be the tenant API address ending in /api/v1 '
        + '(the "url" of the service key, usually ...it-cpiNNN...), not the Integration Suite web address');
    }
    const d = (await res.json()).d || {};
    entries.push(...(d.results || []));
    path = d.__next || null;
  }
  return entries;
}

/**
 * Certificate store backed by PostgreSQL.
 *  - read(): certificates from the database, classified by days left
 *  - sync(): copy the keystore from CPI into the database (only when `client` is given)
 */
function createCertificateStore({ pool, client = null, thresholds, staleHours = 26, now = () => Date.now() }) {
  let syncing = null;

  async function read({ includeRemoved = false } = {}) {
    let data;
    try {
      ({ rows: [{ result: data }] } = await pool.query(SQL.readCertificates, [JSON.stringify({ includeRemoved })]));
    } catch (err) {
      if (err.code === '42P01') {
        return { enabled: false, reason: 'The certificate tables do not exist yet. Run "npm run db:init" once, or run the n8n workflow "CPI Keystore → Postgres", which creates them.' };
      }
      throw err;
    }
    const t = now();
    const items = data.items.map((r) => fromRow(r, t, thresholds))
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.validTo || '9').localeCompare(b.validTo || '9') || a.alias.localeCompare(b.alias));
    const summary = { total: 0, expired: 0, critical: 0, warning: 0, ok: 0, unknown: 0, removed: 0 };
    for (const c of items) {
      if (c.removedAt) { summary.removed++; continue; }
      summary.total++;
      summary[c.state]++;
    }
    const last = data.lastSync;
    return {
      enabled: true,
      canSync: Boolean(client),
      lastSync: last ? { at: iso(last.synced_at), source: last.source, entries: last.entries, removed: last.removed } : null,
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
        const entries = await fetchKeystoreEntries(client);
        const { rows } = await pool.query(SQL.syncKeystore, [JSON.stringify({ source, entries })]);
        return rows[0].result || { entries: 0, removed: 0 };
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  return { read, sync, canSync: Boolean(client) };
}

/** Runs sync() now and then every `intervalMinutes`, without overlapping. Returns { stop }. */
function startCertificateSync({ store, intervalMinutes, logger = console }) {
  const tick = async () => {
    try {
      const r = await store.sync({ source: 'app' });
      logger.log(`[certificates] synced ${r.entries} keystore entries from CPI (${r.removed} removed)`);
    } catch (err) {
      logger.error('[certificates] sync failed:', err.message);
    }
  };
  const first = setTimeout(tick, 3000);
  const timer = setInterval(tick, intervalMinutes * 60000);
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createCertificateStore, startCertificateSync, fetchKeystoreEntries, fromRow, commonName, classify };

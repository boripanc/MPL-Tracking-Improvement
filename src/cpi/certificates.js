'use strict';

/*
 * Reads certificates and key pairs from the CPI tenant keystore (OData KeystoreEntries)
 * and classifies them by how soon they expire.
 */

const DAY = 86400000;
const MAX_PAGES = 20;

function odataDate(value) {
  if (!value) return null;
  const m = /\/Date\((-?\d+)/.exec(value);
  if (m) return new Date(Number(m[1])).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

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
  if (Date.parse(validTo) <= now) state = 'expired';
  else if (daysLeft < criticalDays) state = 'critical';
  else if (daysLeft < warnDays) state = 'warning';
  return { daysLeft, state };
}

/** Converts one KeystoreEntries record into the shape the app uses. */
function toCertificate(r, now, thresholds) {
  const validTo = odataDate(r.ValidNotAfter);
  return {
    alias: r.Alias || r.Hexalias || '',
    entryType: r.Type || '',            // e.g. Certificate, KeyPair
    keyType: r.KeyType || '',           // e.g. RSA, EC
    keySize: r.KeySize != null ? Number(r.KeySize) : null,
    owner: r.Owner || '',               // e.g. SAP, Tenant Administrator
    subjectDN: r.SubjectDN || '',
    issuerDN: r.IssuerDN || '',
    subject: commonName(r.SubjectDN),
    issuer: commonName(r.IssuerDN),
    serialNumber: r.SerialNumber || '',
    signatureAlgorithm: r.SignatureAlgorithm || '',
    fingerprintSha256: r.FingerprintSha256 || r.FingerprintSha1 || '',
    validFrom: odataDate(r.ValidNotBefore),
    validTo,
    lastModifiedBy: r.LastModifiedBy || '',
    lastModifiedTime: odataDate(r.LastModifiedTime),
    ...classify(validTo, now, thresholds),
  };
}

async function fetchKeystoreEntries(client) {
  const entries = [];
  let path = '/KeystoreEntries?$format=json';
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res = await client.request(path);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      const hint = res.status === 404 ? ' (check that CPI_API_URL ends in /api/v1)' : '';
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

const ORDER = { expired: 0, critical: 1, warning: 2, ok: 3, unknown: 4 };

/** Service with an in-memory cache so the keystore is not read on every page load. */
function createCertificateService({ client, thresholds, cacheMinutes, now = () => Date.now() }) {
  let cache = null;
  let inflight = null;

  async function load() {
    const t = now();
    const raw = await fetchKeystoreEntries(client);
    const items = raw.map((r) => toCertificate(r, t, thresholds))
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.validTo || '9').localeCompare(b.validTo || '9') || a.alias.localeCompare(b.alias));
    const summary = { total: items.length, expired: 0, critical: 0, warning: 0, ok: 0, unknown: 0 };
    for (const c of items) summary[c.state]++;
    cache = { fetchedAt: new Date(t).toISOString(), items, summary, ...thresholds };
    return cache;
  }

  return {
    /** Returns cached data, refreshing when older than cacheMinutes or when force is true. */
    async get({ force = false } = {}) {
      const fresh = cache && now() - Date.parse(cache.fetchedAt) < cacheMinutes * 60000;
      if (cache && fresh && !force) return cache;
      if (!inflight) inflight = load().finally(() => { inflight = null; });
      return inflight;
    },
    lastFetchedAt: () => (cache ? Date.parse(cache.fetchedAt) : 0),
  };
}

module.exports = { createCertificateService, toCertificate, commonName, classify, odataDate };

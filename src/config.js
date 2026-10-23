'use strict';

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseUsers(value) {
  return String(value || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      return i > 0 ? { user: pair.slice(0, i), pass: pair.slice(i + 1) } : null;
    })
    .filter((u) => u && u.pass);
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

// Accepts the names used in this app and the field names of the SAP service key (url, tokenurl, clientid, ...).
const CPI_VARS = {
  apiUrl: ['CPI_API_URL', 'CPI_URL', 'CPI_BASE_URL'],
  tokenUrl: ['CPI_TOKEN_URL', 'CPI_TOKENURL'],
  clientId: ['CPI_CLIENT_ID', 'CPI_CLIENTID'],
  clientSecret: ['CPI_CLIENT_SECRET', 'CPI_CLIENTSECRET'],
};

function firstSet(env, names) {
  for (const n of names) {
    const v = env[n] === undefined || env[n] === null ? '' : String(env[n]).trim();
    if (v) return v;
  }
  return '';
}

/** Normalises the CPI API URL: the service key's `url` (tenant host) gets /api/v1 appended. */
function normaliseApiUrl(url) {
  if (!url) return '';
  let u = url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/\/api\/v1$/i.test(u)) u += '/api/v1';
  return u;
}

/** Normalises the token URL: the service key's `tokenurl` sometimes comes without /oauth/token. */
function normaliseTokenUrl(url) {
  if (!url) return '';
  let u = url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/\/oauth\/token$/i.test(u)) u += '/oauth/token';
  return u;
}

function cpiConnection(env) {
  return {
    apiUrl: normaliseApiUrl(firstSet(env, CPI_VARS.apiUrl)),
    tokenUrl: normaliseTokenUrl(firstSet(env, CPI_VARS.tokenUrl)),
    clientId: firstSet(env, CPI_VARS.clientId),
    clientSecret: firstSet(env, CPI_VARS.clientSecret),
  };
}

/** Names of the CPI connection variables that are still missing (empty when fully configured). */
function missingCpiVars(config) {
  return Object.keys(CPI_VARS).filter((k) => !config.poller[k]).map((k) => CPI_VARS[k][0]);
}

/** Builds the configuration object from environment variables (process.env by default). */
function loadConfig(env = process.env) {
  const schema = env.DB_SCHEMA || 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a plain identifier');

  const statuses = String(env.CPI_POLL_STATUSES || 'FAILED,RETRY,ESCALATED')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (statuses.some((s) => !/^[A-Z_]+$/.test(s))) throw new Error('CPI_POLL_STATUSES must be a comma-separated list of status names');

  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    defaultTz: env.DEFAULT_TZ || 'Asia/Bangkok',
    auth: {
      users: parseUsers(env.APP_USERS),
      disabled: bool(env.AUTH_DISABLED, false),
      realm: 'CPI Error Center',
    },
    db: {
      url: env.DATABASE_URL || '',
      ssl: (env.PGSSL || '').toLowerCase(),
      schema,
      max: int(env.PG_POOL_MAX, 10),
    },
    certificates: {
      criticalDays: Math.max(1, int(env.CERT_CRITICAL_DAYS, 30)),
      warnDays: Math.max(1, int(env.CERT_WARN_DAYS, 90)),
      // Only used when this server has a CPI connection: how often the app copies the keystore into the database.
      syncIntervalMinutes: Math.max(5, int(env.CERT_SYNC_INTERVAL_MINUTES, 360)),
      // The page warns when the last sync (by n8n or the app) is older than this.
      staleHours: Math.max(1, int(env.CERT_STALE_HOURS, 26)),
    },
    poller: {
      enabled: bool(env.CPI_POLL_ENABLED, false),
      ...cpiConnection(env),
      intervalMinutes: Math.max(1, int(env.CPI_POLL_INTERVAL_MINUTES, 60)),
      lookbackHours: Math.max(1, int(env.CPI_POLL_LOOKBACK_HOURS, 24)),
      statuses,
      pageSize: 500,
      maxPages: Math.max(1, int(env.CPI_POLL_MAX_PAGES, 40)),
      concurrency: Math.max(1, int(env.CPI_POLL_CONCURRENCY, 5)),
      requestTimeoutMs: Math.max(1000, int(env.CPI_REQUEST_TIMEOUT_MS, 60000)),
    },
  };
}

/** Returns a list of problems that prevent the server from starting safely. */
function validateConfig(config) {
  const problems = [];
  if (!config.db.url) problems.push('DATABASE_URL is not set.');
  if (!config.auth.disabled && config.auth.users.length === 0) {
    problems.push('APP_USERS is empty. Set APP_USERS=user:password (or AUTH_DISABLED=true for local development only).');
  }
  const missing = missingCpiVars(config);
  if (missing.length > 0 && missing.length < 4) {
    problems.push(`CPI connection is partly configured; also set: ${missing.join(', ')}.`);
  }
  if (config.certificates.criticalDays > config.certificates.warnDays) {
    problems.push('CERT_CRITICAL_DAYS must not be larger than CERT_WARN_DAYS.');
  }
  if (config.poller.enabled && missing.length === 4) {
    problems.push('CPI_POLL_ENABLED=true but the CPI connection is not set (CPI_API_URL, CPI_TOKEN_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET).');
  }
  return problems;
}

/** True when all CPI connection settings are present (used by the poller and the certificate view). */
function cpiConfigured(config) {
  const p = config.poller;
  return Boolean(p.apiUrl && p.tokenUrl && p.clientId && p.clientSecret);
}

module.exports = { loadConfig, validateConfig, cpiConfigured, missingCpiVars };

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
      cacheMinutes: Math.max(0, int(env.CERT_CACHE_MINUTES, 15)),
    },
    poller: {
      enabled: bool(env.CPI_POLL_ENABLED, false),
      apiUrl: (env.CPI_API_URL || '').replace(/\/+$/, ''),
      tokenUrl: env.CPI_TOKEN_URL || '',
      clientId: env.CPI_CLIENT_ID || '',
      clientSecret: env.CPI_CLIENT_SECRET || '',
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
  const cpiKeys = ['apiUrl', 'tokenUrl', 'clientId', 'clientSecret'];
  const cpiSet = cpiKeys.filter((k) => config.poller[k]);
  if (cpiSet.length > 0 && cpiSet.length < cpiKeys.length) {
    problems.push(`CPI connection is partly configured; also set: ${cpiKeys.filter((k) => !config.poller[k]).join(', ')} (see CPI_* variables).`);
  }
  if (config.certificates.criticalDays > config.certificates.warnDays) {
    problems.push('CERT_CRITICAL_DAYS must not be larger than CERT_WARN_DAYS.');
  }
  if (config.poller.enabled) {
    for (const key of ['apiUrl', 'tokenUrl', 'clientId', 'clientSecret']) {
      if (!config.poller[key]) problems.push(`CPI poller is enabled but ${key} is missing (see CPI_* variables).`);
    }
  }
  return problems;
}

/** True when all CPI connection settings are present (used by the poller and the certificate view). */
function cpiConfigured(config) {
  const p = config.poller;
  return Boolean(p.apiUrl && p.tokenUrl && p.clientId && p.clientSecret);
}

module.exports = { loadConfig, validateConfig, cpiConfigured };

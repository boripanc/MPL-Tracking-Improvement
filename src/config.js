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
    tickets: {
      // Freshservice tickets table filled by the n8n workflow "FreshServices Tickets" (Ticket pulse menu).
      table: env.TICKETS_TABLE || 'tickets',
      // Link to a ticket; {number} = digits of the ticket id (INC-123 -> 123), {id} = the whole id.
      // Set TICKET_URL=off to hide the links.
      linkTemplate: /^(off|none|false)$/i.test(env.TICKET_URL || '') ? '' : (env.TICKET_URL || 'https://itservice.thaiunion.com/a/tickets/{number}'),
      dueSoonHours: Math.max(1, int(env.TICKETS_DUE_SOON_HOURS, 72)),
      staleHours: Math.max(1, int(env.TICKETS_STALE_HOURS, 24)),
    },
    kanban: {
      // MCP server of the TodoList Kanban app (Streamable HTTP), used to create a card from an error.
      url: (env.KANBAN_MCP_URL || '').trim(),
      // Login is OAuth by default (someone clicks "Connect Kanban board" once). These are all optional:
      // where the Kanban app sends the browser back (default: this app's address + /kanban/oauth/callback),
      redirectUrl: (env.KANBAN_OAUTH_REDIRECT_URL || '').trim(),
      // a client registered by hand when the server does not allow automatic registration,
      clientId: (env.KANBAN_OAUTH_CLIENT_ID || '').trim(),
      clientSecret: (env.KANBAN_OAUTH_CLIENT_SECRET || '').trim(),
      scope: (env.KANBAN_OAUTH_SCOPE || '').trim(),
      // or a fixed API key instead of OAuth. Authorization sends "Bearer <token>", another header sends it as is.
      token: (env.KANBAN_MCP_TOKEN || '').trim(),
      authHeader: (env.KANBAN_MCP_AUTH_HEADER || 'Authorization').trim(),
      board: (env.KANBAN_BOARD || '').trim(),
      column: (env.KANBAN_COLUMN || 'To do').trim(),
      labels: String(env.KANBAN_LABELS === undefined ? 'Monitoring' : env.KANBAN_LABELS).split(',').map((s) => s.trim()).filter(Boolean),
      priority: (env.KANBAN_PRIORITY || 'medium').trim().toLowerCase(),
      // A known error saved with status Open gets a card by itself (once), assigned to these team members.
      autoCard: bool(env.KANBAN_AUTO_CARD, true),
      autoAssignees: String(env.KANBAN_AUTO_ASSIGNEE || '').split(',').map((s) => s.trim()).filter(Boolean),
      // Optional link to a card in the Kanban app; {id} = card id.
      cardUrl: (env.KANBAN_CARD_URL || '').trim(),
      timeoutMs: Math.max(1000, int(env.KANBAN_TIMEOUT_MS, 20000)),
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*([.][A-Za-z_][A-Za-z0-9_]*)?$/.test(config.tickets.table)) {
    problems.push('TICKETS_TABLE must be a table name such as tickets or public.tickets.');
  }
  if (config.tickets.linkTemplate && !/^https?:[/][/]/i.test(config.tickets.linkTemplate)) {
    problems.push('TICKET_URL must start with http:// or https://.');
  }
  const k = config.kanban;
  if (k.url && !/^https?:[/][/]/i.test(k.url)) problems.push('KANBAN_MCP_URL must start with http:// or https://.');
  if (k.redirectUrl && !/^https?:[/][/]/i.test(k.redirectUrl)) problems.push('KANBAN_OAUTH_REDIRECT_URL must start with http:// or https://.');
  if (k.cardUrl && !/^https?:[/][/]/i.test(k.cardUrl)) problems.push('KANBAN_CARD_URL must start with http:// or https://.');
  if (!/^[A-Za-z0-9-]+$/.test(k.authHeader)) problems.push('KANBAN_MCP_AUTH_HEADER must be a header name such as Authorization or X-API-Key.');
  if (!['none', 'low', 'medium', 'high', 'urgent'].includes(k.priority)) problems.push('KANBAN_PRIORITY must be none, low, medium, high or urgent.');
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

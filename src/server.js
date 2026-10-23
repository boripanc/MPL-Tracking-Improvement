'use strict';

const { loadEnvFiles } = require('./env');
const envFiles = loadEnvFiles();
const { loadConfig, validateConfig, cpiConfigured, missingCpiVars } = require('./config');
const { createPool } = require('./db');
const { createApp } = require('./app');
const { startPoller } = require('./poller/cpi');
const { startCertificateSync } = require('./cpi/certificates');

const config = loadConfig(process.env);
const problems = validateConfig(config);
if (problems.length) {
  console.error('Cannot start CPI Error Center:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
if (config.auth.disabled) console.warn('[auth] AUTH_DISABLED=true: anyone who can reach this server can read and change data.');

console.log(envFiles.length ? `Settings read from ${envFiles.join(', ')} and the environment` : 'No .env file found; using environment variables only');
if (cpiConfigured(config)) {
  console.log(`[certificates] read from the database; this server also syncs the keystore from ${new URL(config.poller.apiUrl).host} every ${config.certificates.syncIntervalMinutes} min`);
} else {
  console.log(`[certificates] read from the database (filled by n8n); no CPI connection here (${missingCpiVars(config).join(', ')} not set), so no sync from this server`);
}

const pool = createPool(config.db);
const app = createApp({ pool, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`CPI Error Center listening on http://${config.host}:${config.port}`);
});

const poller = config.poller.enabled ? startPoller({ pool, config: config.poller }) : null;
const certSync = app.locals.certificates.canSync
  ? startCertificateSync({ store: app.locals.certificates, intervalMinutes: config.certificates.syncIntervalMinutes })
  : null;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  if (poller) poller.stop();
  if (certSync) certSync.stop();
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

'use strict';

const { loadEnvFiles } = require('./env');
const envFiles = loadEnvFiles();
const { loadConfig, validateConfig, cpiConfigured, missingCpiVars } = require('./config');
const { createPool } = require('./db');
const { createApp } = require('./app');
const { startPoller } = require('./poller/cpi');

const config = loadConfig(process.env);
const problems = validateConfig(config);
if (problems.length) {
  console.error('Cannot start CPI Error Center:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
if (config.auth.disabled) console.warn('[auth] AUTH_DISABLED=true: anyone who can reach this server can read and change data.');

console.log(envFiles.length ? `Settings read from ${envFiles.join(', ')} and the environment` : 'No .env file found; using environment variables only');
if (cpiConfigured(config)) {
  console.log(`[certificates] enabled, reading the keystore from ${new URL(config.poller.apiUrl).host}`);
} else {
  console.log(`[certificates] disabled, missing: ${missingCpiVars(config).join(', ')}`);
}

const pool = createPool(config.db);
const app = createApp({ pool, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`CPI Error Center listening on http://${config.host}:${config.port}`);
});

const poller = config.poller.enabled ? startPoller({ pool, config: config.poller }) : null;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  if (poller) poller.stop();
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

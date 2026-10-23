'use strict';

// npm run check:cpi -> tests the CPI connection step by step (settings, token, keystore, message logs).
const { loadEnvFiles } = require('../env');
const files = loadEnvFiles();
const { loadConfig } = require('../config');
const { checkConnection } = require('../cpi/client');

(async () => {
  console.log(files.length ? `Settings from: ${files.join(', ')}` : 'No .env file found; using environment variables only');
  const result = await checkConnection(loadConfig(process.env).poller);
  for (const s of result.steps) {
    console.log(`${s.ok ? 'OK  ' : 'FAIL'}  ${s.name}${s.ms != null ? ` (${s.ms} ms)` : ''}\n      ${s.detail}`);
  }
  console.log(result.ok ? '\nCPI connection works.' : '\nCPI connection has a problem: see the FAIL line above.');
  process.exitCode = result.ok ? 0 : 1;
})();

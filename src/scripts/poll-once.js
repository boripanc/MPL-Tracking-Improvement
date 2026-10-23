'use strict';

// Runs the CPI poller once (npm run poll). Useful from cron or for a manual backfill.
const { loadEnvFiles } = require('../env');
loadEnvFiles();
const { loadConfig } = require('../config');
const { createPool } = require('../db');
const { pollOnce } = require('../poller/cpi');

(async () => {
  const config = loadConfig(process.env);
  const missing = ['apiUrl', 'tokenUrl', 'clientId', 'clientSecret'].filter((k) => !config.poller[k]);
  if (!config.db.url || missing.length) {
    console.error('Set DATABASE_URL and CPI_API_URL, CPI_TOKEN_URL, CPI_CLIENT_ID, CPI_CLIENT_SECRET first.');
    process.exit(1);
  }
  const pool = createPool(config.db);
  try {
    const r = await pollOnce({ pool, config: config.poller });
    console.log(`Stored ${r.mpls} MPLs; fetched ${r.errorTexts} error texts (${r.withText} with text).`);
  } catch (err) {
    console.error('Poll failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

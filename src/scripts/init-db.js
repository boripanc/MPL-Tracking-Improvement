'use strict';

// npm run db:init        -> creates any missing tables / view (safe on an existing database)
// npm run db:seed        -> db:init + loads sample data into an EMPTY database (local development only)
const { loadEnvFiles } = require('../env');
loadEnvFiles();
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { createPool } = require('../db');

(async () => {
  const config = loadConfig(process.env);
  if (!config.db.url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = createPool(config.db);
  const dbDir = path.join(__dirname, '..', '..', 'db');
  try {
    if (config.db.schema !== 'public') await pool.query(`CREATE SCHEMA IF NOT EXISTS ${config.db.schema}`);
    await pool.query(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
    console.log('Schema is in place.');
    if (process.argv.includes('--seed')) {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM message_processing_logs');
      if (rows[0].n > 0) {
        console.error('message_processing_logs already has data, so sample data was NOT loaded.');
        process.exitCode = 1;
      } else {
        await pool.query(fs.readFileSync(path.join(dbDir, 'seed-sample.sql'), 'utf8'));
        console.log('Sample data loaded.');
      }
    }
  } catch (err) {
    console.error('Database setup failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();

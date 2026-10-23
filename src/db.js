'use strict';

const { Pool } = require('pg');

function sslOption(mode) {
  if (mode === 'require' || mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}

function createPool(db) {
  const pool = new Pool({
    connectionString: db.url,
    ssl: sslOption(db.ssl),
    max: db.max,
    // Unqualified table names in the queries resolve against this schema.
    options: db.schema && db.schema !== 'public' ? `-c search_path=${db.schema},public` : undefined,
    application_name: 'cpi-error-center',
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/** Runs a query that takes one JSON parameter ($1::jsonb) and returns a single `result` column. */
async function queryResult(pool, sql, params) {
  const { rows } = await pool.query(sql, [JSON.stringify(params || {})]);
  return rows.length ? rows[0].result : null;
}

module.exports = { createPool, queryResult };

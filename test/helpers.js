'use strict';

// Test helpers: each test file gets its own throw-away schema in TEST_DATABASE_URL.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://cpiapp:cpiapp@localhost:5432/cpi_error_center_test';

async function setupDatabase({ seed = true } = {}) {
  const schema = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: TEST_DB, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: TEST_DB, max: 5, options: `-c search_path=${schema}` });
  const dbDir = path.join(__dirname, '..', 'db');
  await pool.query(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
  if (seed) await pool.query(fs.readFileSync(path.join(dbDir, 'seed-sample.sql'), 'utf8'));
  return {
    pool,
    async teardown() {
      await pool.end();
      const a = new Pool({ connectionString: TEST_DB, max: 1 });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

async function startApp(pool, env = {}) {
  const config = loadConfig({ APP_USERS: 'alice:wonderland', DATABASE_URL: 'x', ...env });
  const app = createApp({ pool, config });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = 'Basic ' + Buffer.from('alice:wonderland').toString('base64');
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { Authorization: auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return { base, call, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { setupDatabase, startApp };

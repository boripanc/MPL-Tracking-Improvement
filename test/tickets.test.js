'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDatabase, startApp } = require('./helpers');
const { ticketLink, parseTableName } = require('../src/tickets');

let db;
let api;

// Same columns as the table the n8n workflow "FreshServices Tickets" fills.
const TABLE = `CREATE TABLE tickets (
  human_display_id text PRIMARY KEY, subject text, category text, sub_category text, item_category text,
  due_by timestamptz, created_at timestamptz, updated_at timestamptz, type text, impacted_entity text,
  status_name text, pending_reason text, "group" text, responder text, first_resp_time_in_secs numeric,
  resolution_time_in_secs numeric, requester text, details text, tags text, change_process_type text,
  last_comment_at timestamptz, last_comment_by text, last_comment_type text, last_comment_text text)`;

const H = 3600 * 1000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();

const ROWS = [
  // id, status, group, responder, created (h ago), updated (h ago), due (h ago; negative = in the future), sub_category, frt secs
  ['INC-101', 'Open', 'EDI Support', 'Ann', 2, 1, -10, 'EDI', 1800],
  ['INC-102', 'Pending', 'EDI Support', 'Ann', 30, 5, 3, 'EDI', 3600],          // overdue
  ['INC-103', 'Open', 'CPI Support', null, 24 * 40, 24 * 2, 24 * 30, 'CPI', 7200], // overdue, unassigned, 40 days old
  ['SR-104', 'In Progress', 'CPI Support', 'Bo', 50, 4, -100, 'Access', 600],
  ['INC-105', 'Resolved', 'EDI Support', 'Ann', 48, 6, 10, 'EDI', 900],          // resolved in the last 7 days
  ['INC-106', 'Closed', 'CPI Support', 'Bo', 24 * 20, 24 * 15, 24 * 18, 'CPI', 100], // closed long ago
];

test.before(async () => {
  db = await setupDatabase();
  await db.pool.query(TABLE);
  for (const r of ROWS) {
    await db.pool.query(
      `INSERT INTO tickets (human_display_id, status_name, "group", responder, created_at, updated_at, due_by, sub_category,
         first_resp_time_in_secs, subject, pending_reason, details, last_comment_by, last_comment_text, last_comment_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $6)`,
      [r[0], r[1], r[2], r[3], ago(r[4]), ago(r[5]), ago(r[6]), r[7], r[8], 'Subject ' + r[0],
        r[1] === 'Pending' ? 'Waiting for customer' : null, 'Details of ' + r[0], 'Ann', 'Checked the log'],
    );
  }
  api = await startApp(db.pool, { TICKET_URL: 'https://itservice.example.com/a/tickets/{number}' });
});
test.after(async () => {
  await api.close();
  await db.teardown();
});

test('pulse counts open, overdue, unassigned, created and resolved tickets', async () => {
  const r = await api.call('GET', '/api/tickets/pulse?tz=Asia/Bangkok');
  assert.equal(r.status, 200);
  const d = r.body;
  assert.equal(d.enabled, true);
  assert.equal(d.total, 6);
  assert.equal(d.kpi.open, 4);
  assert.equal(d.kpi.overdue, 2);
  assert.equal(d.kpi.dueSoon, 1); // INC-101, due in 10 hours (SR-104 is due in 100 hours)
  assert.equal(d.kpi.unassigned, 1);
  assert.equal(d.kpi.created, 4); // INC-101, 102, SR-104, INC-105 in the last 7 days
  assert.equal(d.kpi.resolved, 1);
  assert.equal(d.kpi.frtMedianH, 0.4); // median of 1800, 3600, 600, 900 secs = 1350 s
  assert.equal(d.stale, false);
});

test('pulse breaks the open backlog down and lists overdue tickets first', async () => {
  const d = (await api.call('GET', '/api/tickets/pulse')).body;
  assert.deepEqual(d.byGroup.map((g) => [g.name, g.n, g.overdue]), [['CPI Support', 2, 1], ['EDI Support', 2, 1]]);
  assert.ok(d.byResponder.some((x) => x.name === '(unassigned)' && x.n === 1));
  assert.deepEqual(d.byPending, [{ name: 'Waiting for customer', n: 1 }]);
  assert.equal(d.aging.find((a) => a.name === '30-90 days').n, 1);
  assert.equal(d.aging.reduce((s, a) => s + a.n, 0), 4);
  assert.deepEqual(d.open.slice(0, 2).map((t) => t.id).sort(), ['INC-102', 'INC-103']);
  assert.equal(d.open.find((t) => t.id === 'INC-103').link, 'https://itservice.example.com/a/tickets/103');
  assert.equal(d.series.reduce((s, p) => s + p.created, 0), 4);
  assert.equal(d.series.reduce((s, p) => s + p.resolved, 0), 1);
  assert.ok(d.series.length >= 7, 'one bucket per day, including empty days');
});

test('ticket detail returns the description and last comment', async () => {
  const r = await api.call('GET', '/api/tickets/INC-102');
  assert.equal(r.status, 200);
  assert.equal(r.body.details, 'Details of INC-102');
  assert.equal(r.body.last_comment_text, 'Checked the log');
  assert.equal((await api.call('GET', '/api/tickets/INC-999')).status, 404);
});

test('a missing tickets table or optional columns do not break the page', async () => {
  await db.pool.query('ALTER TABLE tickets DROP COLUMN last_comment_text, DROP COLUMN due_by');
  const d = (await api.call('GET', '/api/tickets/pulse')).body;
  assert.equal(d.enabled, true);
  assert.equal(d.kpi.overdue, 0);
  await db.pool.query('ALTER TABLE tickets RENAME TO tickets_old');
  const gone = await api.call('GET', '/api/tickets/pulse');
  assert.equal(gone.status, 200);
  assert.equal(gone.body.enabled, false);
  assert.match(gone.body.reason, /FreshServices Tickets/);
  await db.pool.query('ALTER TABLE tickets_old RENAME TO tickets');
});

test('table name and ticket link helpers', () => {
  assert.equal(parseTableName('public.tickets').sql, '"public"."tickets"');
  assert.throws(() => parseTableName('tickets; drop table x'));
  assert.equal(ticketLink('https://x/a/tickets/{number}', 'SR-45'), 'https://x/a/tickets/45');
  assert.equal(ticketLink('', 'SR-45'), null);
});

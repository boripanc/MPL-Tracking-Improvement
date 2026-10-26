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
  // Excluded from the pulse: non-chargeable tags and change tickets. All are open, old and overdue.
  const excluded = [['INC-201', 'Hypercare, NonCharge', null], ['INC-202', 'noncharged', null], ['INC-203', null, 'Standard'],
    ['INC-204', 'EDI', 'Normal'], ['INC-205', null, 'Emergency']];
  for (const [id, tags, change] of excluded) {
    await db.pool.query(
      `INSERT INTO tickets (human_display_id, status_name, "group", created_at, updated_at, due_by, tags, change_process_type)
       VALUES ($1, 'Open', 'EDI Support', $2, $2, $2, $3, $4)`, [id, ago(24 * 100), tags, change]);
  }
  await db.pool.query(`INSERT INTO tickets (human_display_id, status_name, "group", created_at, updated_at, tags, change_process_type)
    VALUES ('INC-206', 'Resolved', 'EDI Support', $1, $1, 'EDI,charge', 'Not a change')`, [ago(24 * 200)]);
  api = await startApp(db.pool, { TICKET_URL: 'https://itservice.example.com/a/tickets/{number}', TICKETS_CLOSURE_GROUPS: 'all' });
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
  assert.equal(d.total, 7); // 6 above + INC-206; INC-201..205 are excluded
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

test('noncharge tickets and Standard / Normal / Emergency changes are left out', async () => {
  const d = (await api.call('GET', '/api/tickets/pulse')).body;
  assert.equal(d.aging.find((a) => a.name === '> 90 days').n, 0);
  assert.ok(!d.open.some((t) => /^INC-20/.test(t.id)));
  assert.equal((await api.call('GET', '/api/tickets/INC-201')).status, 404);
  assert.equal((await api.call('GET', '/api/tickets/INC-206')).status, 200);
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

test('ticket links default to Freshservice and can be turned off', () => {
  const { loadConfig } = require('../src/config');
  assert.equal(loadConfig({}).tickets.linkTemplate, 'https://itservice.thaiunion.com/a/tickets/{number}');
  assert.equal(loadConfig({ TICKET_URL: 'off' }).tickets.linkTemplate, '');
});

test('weekly, monthly and yearly views group the trend by week, month and year', async () => {
  for (const [view, n] of [['week', 12], ['month', 12], ['year', 5]]) {
    const d = (await api.call('GET', `/api/tickets/pulse?view=${view}&tz=Asia/Bangkok`)).body;
    assert.equal(d.range.unit, view);
    assert.equal(d.series.length, n, view);
    assert.equal(d.series.reduce((s, p) => s + p.created, 0), d.kpi.created, view);
  }
  const year = (await api.call('GET', '/api/tickets/pulse?view=year')).body;
  assert.equal(year.kpi.created, 7); // every ticket that is not excluded, including INC-206 from 200 days ago
  assert.equal((await api.call('GET', '/api/tickets/pulse?view=quarter')).status, 400);
  assert.equal((await api.call('GET', '/api/tickets/pulse?view=day')).body.range.unit, 'day');
});

test('open list and detail include category, sub-category and item', async () => {
  await db.pool.query(`UPDATE tickets SET category = 'Integration', item_category = 'AS2' WHERE human_display_id = 'INC-102'`);
  const d = (await api.call('GET', '/api/tickets/pulse')).body;
  const t = d.open.find((x) => x.id === 'INC-102');
  assert.deepEqual([t.category, t.sub_category, t.item], ['Integration', 'EDI', 'AS2']);
  const detail = (await api.call('GET', '/api/tickets/INC-102')).body;
  assert.deepEqual([detail.category, detail.sub_category, detail.item], ['Integration', 'EDI', 'AS2']);
});

test('closed tickets missing Issue Summary, Correction Solution or Root Cause are listed', async () => {
  let d = (await api.call('GET', '/api/tickets/pulse?view=year')).body;
  assert.equal(d.closure.stored, false); // the columns are not in the table yet
  await db.pool.query('ALTER TABLE tickets ADD COLUMN issue_summary text, ADD COLUMN correction_solution text, ADD COLUMN root_cause text');
  await db.pool.query(`UPDATE tickets SET issue_summary = '<p>Mapping failed</p>', correction_solution = 'Fixed mapping', root_cause = '<p>&nbsp;</p>'
    WHERE human_display_id = 'INC-105'`);
  await db.pool.query(`UPDATE tickets SET issue_summary = 'x', correction_solution = 'y', root_cause = 'z' WHERE human_display_id = 'INC-206'`);
  d = (await api.call('GET', '/api/tickets/pulse?view=year')).body;
  assert.equal(d.closure.stored, true);
  assert.equal(d.closure.closed, 3); // INC-105, INC-106 and INC-206 were resolved or closed this past year
  assert.equal(d.closure.incomplete, 2);
  assert.deepEqual(d.closure.rows.find((r) => r.id === 'INC-106').missing, ['issue_summary', 'correction_solution', 'root_cause']);
  const ids = d.closure.rows.map((r) => r.id);
  assert.ok(ids.includes('INC-105'));
  assert.ok(!ids.includes('INC-206'));
  assert.deepEqual(d.closure.rows.find((r) => r.id === 'INC-105').missing, ['root_cause']);
  const detail = (await api.call('GET', '/api/tickets/INC-105')).body;
  assert.equal(detail.correction_solution, 'Fixed mapping');
});

test('this month lists every ticket created this calendar month, without excluded tickets', async () => {
  const d = (await api.call('GET', '/api/tickets/pulse?tz=Asia/Bangkok')).body;
  const start = Date.parse(d.month.start);
  const ids = d.month.rows.map((r) => r.id);
  assert.equal(d.month.created, ids.length);
  assert.ok(d.month.rows.every((r) => Date.parse(r.created_at) >= start));
  assert.ok(!ids.some((id) => /^INC-20/.test(id)));
  assert.equal(d.month.open + d.month.closed, d.month.created);
  if (ids.includes('INC-105')) {
    const r = d.month.rows.find((x) => x.id === 'INC-105');
    assert.deepEqual(r.missing, ['root_cause']);
    assert.equal(r.link, 'https://itservice.example.com/a/tickets/105');
  }
  const open = d.month.rows.find((r) => !r.closed);
  if (open) assert.equal(open.missing, null);
});

test('change process type is matched without regard to case', async () => {
  await db.pool.query(`INSERT INTO tickets (human_display_id, status_name, created_at, change_process_type) VALUES ('INC-207', 'Open', now(), 'standard ')`);
  assert.equal((await api.call('GET', '/api/tickets/INC-207')).status, 404);
  const d = (await api.call('GET', '/api/tickets/pulse')).body;
  assert.ok(!d.month.rows.some((r) => r.id === 'INC-207'));
});

test('closure notes are checked only for the configured groups (default L2 DDAI TUIP)', async () => {
  const { loadConfig } = require('../src/config');
  assert.deepEqual(loadConfig({}).tickets.closureGroups, ['L2 DDAI TUIP']);
  assert.deepEqual(loadConfig({ TICKETS_CLOSURE_GROUPS: 'all' }).tickets.closureGroups, []);
  const edi = await startApp(db.pool, { TICKETS_CLOSURE_GROUPS: ' edi support ' });
  try {
    const d = (await edi.call('GET', '/api/tickets/pulse?view=year')).body;
    assert.deepEqual(d.closure.groups, ['edi support']);
    assert.equal(d.closure.closed, 2); // INC-105 and INC-206; INC-106 (CPI Support) is not checked
    assert.deepEqual(d.closure.rows.map((r) => r.id), ['INC-105']);
    const cpi = d.month.rows.find((r) => r.grp === 'CPI Support' && r.closed);
    if (cpi) assert.equal(cpi.missing, null);
  } finally {
    await edi.close();
  }
});

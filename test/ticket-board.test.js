'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { setupDatabase, startApp } = require('./helpers');
const { cardFor, columnFor, plan, ticketIdOf, weekdays, COLUMNS } = require('../src/ticket-board');

const TOKEN = 'test-key';
const H = 3600 * 1000;
const ago = (h) => new Date(Date.now() - h * H).toISOString();

// A small WorkStream stand-in that keeps several boards and supports the tools the sync uses.
function fakeWorkStream() {
  const state = { boards: [], calls: [] };
  const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  const err = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const findCard = (cardId) => {
    for (const b of state.boards) {
      const c = b.cards.find((x) => x.id === cardId);
      if (c) return { b, c };
    }
    return {};
  };
  const labelObjs = (b, names = []) => names.map((name) => {
    let l = b.labels.find((x) => x.name === name);
    if (!l) b.labels.push(l = { id: id('l'), name });
    return { id: l.id, name: l.name };
  });
  function build() {
    const s = new McpServer({ name: 'WorkStream', version: '1.0.0' });
    const log = (name, args) => state.calls.push({ name, args });
    s.tool('list_boards', {}, async () => json(state.boards.map((b) => ({ id: b.id, title: b.title, role: b.role, cardCount: b.cards.length }))));
    s.tool('create_board', { title: z.string(), columns: z.array(z.string()).optional() }, async (a) => {
      log('create_board', a);
      const b = { id: id('b'), title: a.title, role: 'owner', labels: [], team: [], columns: a.columns || ['To do', 'In progress', 'Done'], cards: [] };
      state.boards.push(b);
      return json({ id: b.id, title: b.title, role: b.role });
    });
    s.tool('get_board', { boardId: z.string() }, async ({ boardId }) => {
      const b = state.boards.find((x) => x.id === boardId);
      if (!b) return err('Board not found');
      return json({ id: b.id, title: b.title, role: b.role, labels: b.labels, team: b.team,
        columns: b.columns.map((t) => ({ id: t, title: t, cards: b.cards.filter((c) => c.column === t) })) });
    });
    s.tool('add_column', { boardId: z.string(), title: z.string() }, async (a) => {
      log('add_column', a);
      state.boards.find((x) => x.id === a.boardId).columns.push(a.title);
      return json({ ok: true });
    });
    s.tool('create_card', {
      boardId: z.string(), column: z.string(), title: z.string(), description: z.string().optional(),
      labels: z.array(z.string()).optional(), priority: z.string().optional(), dueDate: z.string().nullable().optional(), startDate: z.string().nullable().optional(), estimateDays: z.number().nullable().optional(),
      assignees: z.array(z.string()).optional(),
    }, async (a) => {
      log('create_card', a);
      const b = state.boards.find((x) => x.id === a.boardId);
      if (!b.columns.includes(a.column)) return err(`Column "${a.column}" not found`);
      const c = { id: id('c'), column: a.column, title: a.title, description: a.description || '', priority: a.priority || 'none',
        estimateDays: a.estimateDays || null, startDate: a.startDate || null, dueDate: a.dueDate || null, labels: labelObjs(b, a.labels), assignees: (a.assignees || []).map((name) => ({ id: name, name })), pendingAssignment: null };
      b.cards.push(c);
      return json(c);
    });
    s.tool('update_card', {
      cardId: z.string(), column: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
      labels: z.array(z.string()).optional(), priority: z.string().optional(), dueDate: z.string().nullable().optional(), startDate: z.string().nullable().optional(), estimateDays: z.number().nullable().optional(),
      assignees: z.array(z.string()).optional(),
    }, async (a) => {
      log('update_card', a);
      const { b, c } = findCard(a.cardId);
      if (!c) return err('Card not found');
      for (const k of ['column', 'title', 'description', 'priority']) if (a[k] !== undefined) c[k] = a[k];
      if (a.dueDate !== undefined) c.dueDate = a.dueDate || null;
      if (a.startDate !== undefined) c.startDate = a.startDate || null;
      if (a.estimateDays !== undefined) c.estimateDays = a.estimateDays;
      if (a.labels) c.labels = labelObjs(b, a.labels);
      if (a.assignees) c.assignees = a.assignees.map((name) => ({ id: name, name }));
      return json(c);
    });
    s.tool('delete_card', { cardId: z.string() }, async (a) => {
      log('delete_card', a);
      const { b, c } = findCard(a.cardId);
      if (!c) return err('Card not found');
      b.cards.splice(b.cards.indexOf(c), 1);
      return json({ ok: true });
    });
    return s;
  }
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const s = build();
    res.on('close', () => { transport.close(); s.close(); });
    await s.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

const TABLE = `CREATE TABLE tickets (
  human_display_id text PRIMARY KEY, subject text, type text, status_name text, pending_reason text, "group" text,
  responder text, requester text, created_at timestamptz, updated_at timestamptz, due_by timestamptz,
  tags text, change_process_type text)`;

async function insert(pool, rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO tickets (human_display_id, status_name, subject, type, responder, created_at, updated_at, due_by, tags, change_process_type, pending_reason, "group")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'L2 DDAI TUIP')
       ON CONFLICT (human_display_id) DO UPDATE SET status_name = EXCLUDED.status_name, updated_at = EXCLUDED.updated_at, due_by = EXCLUDED.due_by`,
      r,
    );
  }
}

let db;
let ws;
let api;

test.before(async () => {
  db = await setupDatabase();
  await db.pool.query(TABLE);
  await insert(db.pool, [
    ['INC-1', 'Open', 'Interface down', 'Incident', 'Ann', ago(5), ago(1), ago(2), null, null, null], // overdue
    ['SR-2', 'In Progress', 'New iFlow', 'Service Request', 'Bo', ago(50), ago(3), ago(-48), null, null, null],
    ['INC-3', 'Waiting on Customer', 'File missing', 'Incident', null, ago(80), ago(10), null, null, null, 'Customer'],
    ['INC-4', 'Resolved', 'Duplicate invoices', 'Incident', 'Ann', ago(100), ago(24), ago(30), null, null, null],
    ['INC-5', 'Closed', 'Old ticket', 'Incident', 'Ann', ago(24 * 60), ago(24 * 40), null, null, null, null], // closed long ago
    ['INC-6', 'Open', 'Test ticket', 'Incident', 'Ann', ago(5), ago(1), null, 'noncharge', null, null], // excluded
    ['SR-7', 'Open', 'Cert renewal', 'Service Request', 'Ann', ago(5), ago(1), null, null, 'Standard', null], // excluded
  ]);
  ws = await fakeWorkStream();
  api = await startApp(db.pool, { KANBAN_MCP_URL: ws.url, KANBAN_MCP_TOKEN: TOKEN });
});
test.after(async () => {
  await api.close();
  await ws.close();
  await db.teardown();
});

test('card mapping: column by status, overdue = high priority, id parsed back from the title', () => {
  assert.equal(columnFor({ status: 'Open' }), 'Open');
  assert.equal(columnFor({ status: 'In Progress' }), 'In Progress');
  assert.equal(columnFor({ status: 'Pending' }), 'Pending');
  assert.equal(columnFor({ status: 'Waiting on Third Party' }), 'Pending');
  assert.equal(columnFor({ status: 'Closed', closed: true }), 'Resolved / Closed');
  const c = cardFor({ id: 'INC-9', subject: 'Down', status: 'Open', type: 'Incident', due_by: ago(1), created_at: ago(5), link: 'https://fs/a/tickets/9' });
  assert.equal(c.title, 'INC-9 · Down');
  assert.equal(c.priority, 'high');
  assert.deepEqual(c.labels, ['Incident']);
  assert.match(c.description, /Open in Freshservice: https:\/\/fs\/a\/tickets\/9/);
  assert.match(c.description, /Responder: Unassigned/);
  assert.equal(ticketIdOf(c), 'INC-9');
  assert.equal(ticketIdOf({ title: 'Team meeting' }), null);
  const closed = cardFor({ id: 'INC-9', subject: 'Down', status: 'Closed', closed: true, due_by: ago(1), created_at: ago(5), updated_at: ago(1) });
  assert.equal(closed.priority, 'none');
  assert.equal(closed.estimateDays >= 1, true);
  assert.match(closed.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  // Start date = the day the ticket was created (Bangkok time).
  assert.equal(cardFor({ id: 'INC-9', status: 'Open', created_at: '2026-11-18T18:30:00Z' }).startDate, '2026-11-19');
});

test('man-days for closed tickets: weekdays from created to closed, both counted', () => {
  assert.equal(weekdays('2026-11-17', '2026-11-17'), 1); // Tue
  assert.equal(weekdays('2026-11-13', '2026-11-17'), 3); // Fri .. Tue, weekend skipped
  assert.equal(weekdays('2026-11-14', '2026-11-15'), 1); // Sat .. Sun: at least 1
  const c = cardFor({ id: 'INC-9', status: 'Closed', closed: true, created_at: '2026-11-13T03:00:00Z', updated_at: '2026-11-17T09:00:00Z' });
  assert.equal(c.startDate, '2026-11-13');
  assert.equal(c.dueDate, '2026-11-17');
  assert.equal(c.estimateDays, 3);
  assert.match(c.description, /Man-days: 3/);
  assert.equal(cardFor({ id: 'INC-9', status: 'Open', created_at: '2026-11-13T03:00:00Z' }).estimateDays, null);
  // WorkStream may work out its own due date from the estimate: only the estimate is compared, so no endless updates.
  assert.deepEqual(plan([{ id: 'x1', ...c, dueDate: '2026-11-18' }], [{ id: 'INC-9', status: 'Closed', closed: true, created_at: '2026-11-13T03:00:00Z', updated_at: '2026-11-17T09:00:00Z' }]).update, []);
  assert.deepEqual(plan([{ id: 'x1', ...c, estimateDays: null }], [{ id: 'INC-9', status: 'Closed', closed: true, created_at: '2026-11-13T03:00:00Z', updated_at: '2026-11-17T09:00:00Z' }]).update,
    [{ cardId: 'x1', estimateDays: 3, dueDate: '2026-11-17' }]);
});

test('plan: creates new, updates changed, removes gone and duplicate ticket cards, leaves hand-made cards', () => {
  const t1 = { id: 'INC-1', subject: 'A', status: 'Open', created_at: ago(1) };
  const t2 = { id: 'INC-2', subject: 'B', status: 'Pending', created_at: ago(1) };
  const same = { id: 'x1', ...cardFor(t1) };
  const moved = { id: 'x2', ...cardFor(t2), column: 'Open' };
  const dup = { id: 'x3', ...cardFor(t1) };
  const gone = { id: 'x4', ...cardFor({ id: 'INC-3', subject: 'C', status: 'Open', created_at: ago(1) }) };
  const manual = { id: 'x5', title: 'Weekly review', column: 'Open' };
  const p = plan([same, moved, dup, gone, manual], [t1, t2, { id: 'SR-8', subject: 'D', status: 'Open', created_at: ago(1) }]);
  assert.deepEqual(p.create.map((c) => c.title), ['SR-8 · D']);
  assert.deepEqual(p.update, [{ cardId: 'x2', column: 'Pending' }]);
  assert.deepEqual(p.remove.map((c) => c.id).sort(), ['x3', 'x4']);
});

test('assignee = the ticket agent; a waiting request is not sent again', () => {
  const t = { id: 'INC-1', subject: 'A', status: 'Open', responder: 'Ann', created_at: ago(1) };
  const want = cardFor(t);
  assert.deepEqual(want.assignees, ['Ann']);
  assert.deepEqual(cardFor({ ...t, responder: null }).assignees, []);
  const base = { id: 'x1', ...want, assignees: [] };
  assert.deepEqual(plan([base], [t]).update, [{ cardId: 'x1', assignees: ['Ann'] }]);
  assert.deepEqual(plan([{ ...base, assignees: [{ id: 'm1', name: 'Ann' }] }], [t]).update, []);
  assert.deepEqual(plan([{ ...base, pendingAssignment: { assignees: [{ name: 'Ann' }] } }], [t]).update, []);
  assert.deepEqual(plan([{ ...base, pendingAssignment: { requestedAt: 'x' } }], [t]).update, []);
  assert.deepEqual(plan([{ ...base, pendingAssignment: { assignees: [{ name: 'Bo' }] } }], [t]).update, [{ cardId: 'x1', assignees: ['Ann'] }]);
  // Responder removed in Freshservice: the card is unassigned again.
  assert.deepEqual(plan([{ ...base, assignees: [{ id: 'm1', name: 'Ann' }] }], [{ ...t, responder: null }]).update[0].assignees, []);
});

test('first sync creates the board with its columns and one card per ticket, filters kept', async () => {
  assert.deepEqual((await api.call('GET', '/api/kanban/ticket-board')).body, { enabled: true, board: 'Ticket pulse', minutes: 15, running: false, last: null });
  const r = await api.call('POST', '/api/kanban/ticket-board/sync');
  assert.equal(r.status, 200);
  assert.equal(r.body.last.ok, true, r.body.last.error);
  assert.equal(r.body.last.createdBoard, true);
  assert.equal(r.body.last.created, 4);
  const b = ws.state.boards.find((x) => x.title === 'Ticket pulse');
  assert.deepEqual(b.columns, COLUMNS);
  const where = Object.fromEntries(b.cards.map((c) => [ticketIdOf(c), c.column]));
  assert.deepEqual(where, { 'INC-1': 'Open', 'SR-2': 'In Progress', 'INC-3': 'Pending', 'INC-4': 'Resolved / Closed' });
  assert.equal(b.cards.find((c) => c.title.startsWith('INC-1 ')).priority, 'high');
  const who = Object.fromEntries(b.cards.map((c) => [ticketIdOf(c), c.assignees.map((a) => a.name)]));
  assert.deepEqual(who, { 'INC-1': ['Ann'], 'SR-2': ['Bo'], 'INC-3': [], 'INC-4': ['Ann'] });
  assert.ok(b.cards.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.startDate)));
});

test('a second sync changes nothing; a status change moves the card; a hand-moved card is put back', async () => {
  ws.state.calls.length = 0;
  let r = await api.call('POST', '/api/kanban/ticket-board/sync');
  assert.equal(r.body.last.created + r.body.last.updated + r.body.last.removed, 0);
  assert.deepEqual(ws.state.calls, []);

  const b = ws.state.boards.find((x) => x.title === 'Ticket pulse');
  b.cards.find((c) => c.title.startsWith('SR-2 ')).column = 'Resolved / Closed'; // someone dragged it
  b.cards.push({ id: 'manual', title: 'Team note', column: 'Open', labels: [] }); // a card added by hand
  await insert(db.pool, [['INC-1', 'Resolved', 'Interface down', 'Incident', 'Ann', ago(5), ago(0.1), ago(2), null, null, null]]);
  r = await api.call('POST', '/api/kanban/ticket-board/sync');
  assert.equal(r.body.last.updated, 2);
  const where = Object.fromEntries(b.cards.map((c) => [ticketIdOf(c) || c.id, c.column]));
  assert.equal(where['SR-2'], 'In Progress');
  assert.equal(where['INC-1'], 'Resolved / Closed');
  assert.equal(where.manual, 'Open');
  assert.equal(b.cards.find((c) => c.title.startsWith('INC-1 ')).priority, 'none');
});

test('a ticket closed longer than KANBAN_TICKET_DONE_DAYS leaves the board; KANBAN_TICKET_BOARD=off turns it off', async () => {
  await db.pool.query(`UPDATE tickets SET updated_at = now() - interval '20 days' WHERE human_display_id = 'INC-4'`);
  const r = await api.call('POST', '/api/kanban/ticket-board/sync');
  assert.equal(r.body.last.removed, 1);
  const b = ws.state.boards.find((x) => x.title === 'Ticket pulse');
  assert.equal(b.cards.some((c) => c.title.startsWith('INC-4 ')), false);
  assert.equal(ws.state.boards.length, 1);

  const off = await startApp(db.pool, { KANBAN_MCP_URL: ws.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_TICKET_BOARD: 'off' });
  try {
    assert.equal((await off.call('GET', '/api/kanban/ticket-board')).body.enabled, false);
    assert.equal((await off.call('POST', '/api/kanban/ticket-board/sync')).status, 409);
  } finally {
    await off.close();
  }
});

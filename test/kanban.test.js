'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { setupDatabase, startApp } = require('./helpers');
const { loadConfig, validateConfig } = require('../src/config');

const TOKEN = 'test-key';
let db;
let api;
let mcp;
let cards;
let lastArgs;

// A small stand-in for the TodoList Kanban (WorkStream) MCP server, with the same tool names and result shape.
function fakeKanbanServer() {
  const board = {
    id: 'b1', title: 'TUIP', role: 'owner',
    labels: [{ id: 'l1', name: 'Monitoring' }, { id: 'l2', name: 'R4C' }],
    team: [{ id: 't1', name: 'Boripan.C' }],
  };
  const columns = ['Backlog', 'To do', 'In progress', 'Done'];
  const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  function build() {
    const s = new McpServer({ name: 'WorkStream', version: '1.0.0' });
    s.tool('list_boards', {}, async () => json([{ id: board.id, title: board.title, role: board.role, cardCount: cards.length }]));
    s.tool('get_board', { boardId: z.string() }, async ({ boardId }) => {
      if (boardId !== board.id) return { isError: true, content: [{ type: 'text', text: 'Board not found' }] };
      return json({ ...board, columns: columns.map((t) => ({ id: t, title: t, cards: cards.filter((c) => c.column === t) })) });
    });
    s.tool('find_cards', { boardId: z.string().optional(), search: z.string().optional(), limit: z.number().optional() }, async ({ search }) =>
      json(cards.filter((c) => !search || (c.title + c.description).includes(search))));
    s.tool('create_card', {
      boardId: z.string(), column: z.string(), title: z.string(), description: z.string().optional(),
      labels: z.array(z.string()).optional(), priority: z.string().optional(), assignees: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional(),
    }, async (args) => {
      lastArgs = args;
      if (!columns.includes(args.column)) return { isError: true, content: [{ type: 'text', text: `Column "${args.column}" not found` }] };
      const card = { id: 'c' + (cards.length + 1), ...args, priority: args.priority || 'none', createdAt: new Date().toISOString() };
      cards.push(card);
      return json(card);
    });
    return s;
  }
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end('Unauthorized'); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    // Stateless mode: a new server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const s = build();
    res.on('close', () => { transport.close(); s.close(); });
    await s.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

test.before(async () => {
  cards = [];
  db = await setupDatabase();
  mcp = await fakeKanbanServer();
  api = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_CARD_URL: 'https://kanban.example/cards/{id}' });
});
test.after(async () => {
  await api.close();
  await mcp.close();
  await db.teardown();
});

test('meta says whether the Kanban board is connected', async () => {
  assert.equal((await api.call('GET', '/api/meta')).body.kanban, true);
  const off = await startApp(db.pool);
  try {
    assert.equal((await off.call('GET', '/api/meta')).body.kanban, false);
    const info = await off.call('GET', '/api/errors/MPL-0001/card');
    assert.equal(info.body.enabled, false);
    assert.match(info.body.suggested.title, /INT406_TUE_IOT_COMB/);
    const r = await off.call('POST', '/api/errors/MPL-0001/card', {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /KANBAN_MCP_URL/);
  } finally {
    await off.close();
  }
});

test('suggests a card from the error and lists the board', async () => {
  const r = await api.call('GET', '/api/errors/MPL-0001/card');
  assert.equal(r.status, 200);
  assert.equal(r.body.board.title, 'TUIP');
  assert.deepEqual(r.body.columns, ['Backlog', 'To do', 'In progress', 'Done']);
  assert.deepEqual(r.body.labels, ['Monitoring', 'R4C']);
  assert.deepEqual(r.body.team, ['Boripan.C']);
  assert.deepEqual(r.body.defaults, { column: 'To do', labels: ['Monitoring'], priority: 'medium' });
  assert.deepEqual(r.body.existing, []);
  assert.equal(r.body.suggested.title, 'Fix error on INT406_TUE_IOT_COMB');
  assert.match(r.body.suggested.description, /Message ID: MPL-0001/);
  assert.match(r.body.suggested.description, /Error:\n/);
  assert.equal((await api.call('GET', '/api/errors/NOPE/card')).status, 404);
});

test('creates a card with the defaults, then finds it again by message ID', async () => {
  const r = await api.call('POST', '/api/errors/MPL-0001/card', {});
  assert.equal(r.status, 201);
  assert.equal(r.body.column, 'To do');
  assert.equal(r.body.title, 'Fix error on INT406_TUE_IOT_COMB');
  assert.deepEqual(lastArgs.labels, ['Monitoring']);
  assert.equal(lastArgs.priority, 'medium');
  assert.equal(lastArgs.boardId, 'b1');
  assert.match(lastArgs.description, /MPL-0001/);

  const info = await api.call('GET', '/api/errors/MPL-0001/card');
  assert.equal(info.body.existing.length, 1);
  assert.equal(info.body.existing[0].id, r.body.id);
  assert.equal(info.body.cardUrl, 'https://kanban.example/cards/{id}');
});

test('creates a card with the fields the user edited', async () => {
  const r = await api.call('POST', '/api/errors/MPL-0003/card', {
    title: 'EDI997 ack failing', description: 'See CPI', column: 'Backlog', labels: [], priority: 'urgent',
    assignees: ['Boripan.C'], dueDate: '2026-11-30',
  });
  assert.equal(r.status, 201);
  assert.equal(lastArgs.title, 'EDI997 ack failing');
  assert.equal(lastArgs.description, 'See CPI');
  assert.equal(lastArgs.column, 'Backlog');
  assert.equal(lastArgs.labels, undefined); // [] = no labels
  assert.equal(lastArgs.priority, 'urgent');
  assert.deepEqual(lastArgs.assignees, ['Boripan.C']);
  assert.equal(lastArgs.dueDate, '2026-11-30');
});

test('rejects bad input and passes Kanban errors on as 502', async () => {
  assert.equal((await api.call('POST', '/api/errors/MPL-0001/card', { priority: 'asap' })).status, 400);
  assert.equal((await api.call('POST', '/api/errors/MPL-0001/card', { dueDate: '30/11/2026' })).status, 400);
  assert.equal((await api.call('POST', '/api/errors/MPL-0001/card', { labels: 'Monitoring' })).status, 400);
  const bad = await api.call('POST', '/api/errors/MPL-0001/card', { column: 'Nowhere' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /Column "Nowhere" not found/);
});

test('reports a wrong token and an unknown board clearly', async () => {
  const wrong = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: 'nope' });
  const noBoard = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_BOARD: 'Other' });
  try {
    const r = await wrong.call('GET', '/api/errors/MPL-0001/card');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /refused the login/);
    const b = await noBoard.call('GET', '/api/errors/MPL-0001/card');
    assert.equal(b.status, 502);
    assert.match(b.body.error, /board "Other" not found/);
  } finally {
    await wrong.close();
    await noBoard.close();
  }
});

test('validates the Kanban settings', () => {
  const base = { DATABASE_URL: 'x', APP_USERS: 'a:b' };
  assert.deepEqual(validateConfig(loadConfig({ ...base, KANBAN_MCP_URL: 'https://kanban.example/mcp' })), []);
  assert.match(validateConfig(loadConfig({ ...base, KANBAN_MCP_URL: 'kanban.example' })).join(), /KANBAN_MCP_URL/);
  assert.match(validateConfig(loadConfig({ ...base, KANBAN_PRIORITY: 'asap' })).join(), /KANBAN_PRIORITY/);
  assert.deepEqual(loadConfig({ ...base, KANBAN_LABELS: '' }).kanban.labels, []);
});

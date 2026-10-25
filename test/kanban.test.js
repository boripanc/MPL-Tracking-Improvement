'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
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
// It accepts the fixed key TOKEN or an OAuth access token it issued itself (dynamic client registration,
// authorization code + PKCE, refresh tokens), like the real server.
function fakeKanbanServer() {
  const board = {
    id: 'b1', title: 'TUIP', role: 'owner',
    labels: [{ id: 'l1', name: 'Monitoring' }, { id: 'l2', name: 'R4C' }],
    team: [{ id: 't1', name: 'Boripan.C' }],
  };
  const columns = ['Backlog', 'To do', 'In progress', 'Done'];
  const oauth = { clients: new Map(), codes: new Map(), access: new Set(), refresh: new Set(), n: 0 };
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
  let base = '';
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body)); };
  const issue = () => {
    oauth.n += 1;
    const t = { access_token: `at-${oauth.n}`, refresh_token: `rt-${oauth.n}`, token_type: 'Bearer', expires_in: 3600 };
    oauth.access.add(t.access_token);
    oauth.refresh.add(t.refresh_token);
    return t;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/.well-known/oauth-protected-resource/api/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      return send(res, 200, { resource: `${base}/api/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return send(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(body);
      // Same rule as WorkStream: https, or http only on localhost.
      if (!meta.redirect_uris.every((u) => /^https:/.test(u) || /^http:[/][/](localhost|127[.]0[.]0[.]1)([:/]|$)/.test(u))) {
        return send(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must use https (or http on localhost)' });
      }
      const client = { ...meta, client_id: `client-${oauth.clients.size + 1}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
      oauth.clients.set(client.client_id, client);
      return send(res, 201, client);
    }
    if (url.pathname === '/authorize') {
      // The user "signs in and approves" at once: back to the app with a code.
      const p = url.searchParams;
      const client = oauth.clients.get(p.get('client_id'));
      if (!client || !client.redirect_uris.includes(p.get('redirect_uri'))) return send(res, 400, { error: 'invalid_request' });
      const code = `code-${oauth.codes.size + 1}`;
      oauth.codes.set(code, { challenge: p.get('code_challenge'), client: client.client_id, redirect: p.get('redirect_uri') });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      res.writeHead(302, { Location: back.toString() }).end();
      return undefined;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const c = oauth.codes.get(p.get('code'));
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (!c || c.challenge !== challenge || c.client !== p.get('client_id') || c.redirect !== p.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
        oauth.codes.delete(p.get('code'));
        return send(res, 200, issue());
      }
      if (p.get('grant_type') === 'refresh_token' && oauth.refresh.delete(p.get('refresh_token'))) return send(res, 200, issue());
      return send(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname !== '/api/mcp') return send(res, 404, { error: 'not found' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (bearer !== TOKEN && !oauth.access.has(bearer)) {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"` }).end();
      return undefined;
    }
    // Stateless mode: a new server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const s = build();
    res.on('close', () => { transport.close(); s.close(); });
    await s.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    return undefined;
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url: `${base}/api/mcp`,
      oauth,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    });
  }));
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
  assert.deepEqual((await api.call('GET', '/api/meta')).body.kanban, { enabled: true, connected: true, auth: 'token', autoCard: true });
  const off = await startApp(db.pool);
  try {
    assert.deepEqual((await off.call('GET', '/api/meta')).body.kanban, { enabled: false, connected: false });
    const info = await off.call('GET', '/api/errors/MPL-0001/card');
    assert.equal(info.body.enabled, false);
    assert.match(info.body.suggested.title, /INT406_TUE_IOT_COMB/);
    const r = await off.call('POST', '/api/errors/MPL-0001/card', {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /KANBAN_MCP_URL/);
    assert.equal((await off.call('POST', '/api/kanban/connect')).status, 409);
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

test('OAuth: connect once, create cards, refresh the token, disconnect', async () => {
  const app = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_BOARD: 'TUIP' });
  const authz = 'Basic ' + Buffer.from('alice:wonderland').toString('base64');
  try {
    assert.deepEqual((await app.call('GET', '/api/meta')).body.kanban, { enabled: true, connected: false, auth: 'oauth', autoCard: true, connectedBy: null, connectedAt: null });
    const before = await app.call('GET', '/api/errors/MPL-0002/card');
    assert.equal(before.body.connected, false);
    assert.match(before.body.suggested.title, /INT401/);
    const blocked = await app.call('POST', '/api/errors/MPL-0002/card', {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.connect, true);

    // Start the sign-in: the app registers itself and returns the Kanban sign-in page.
    const start = await app.call('POST', '/api/kanban/connect');
    assert.equal(start.status, 200);
    const signIn = new URL(start.body.url);
    assert.equal(signIn.pathname, '/authorize');
    assert.equal(signIn.searchParams.get('redirect_uri'), `${app.base}/kanban/oauth/callback`);
    assert.equal(signIn.searchParams.get('code_challenge_method'), 'S256');

    // The Kanban app sends the browser back with a code.
    const approved = await fetch(signIn, { redirect: 'manual' });
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get('location'));

    // A forged state is refused.
    const forged = new URL(callback);
    forged.searchParams.set('state', 'not-the-state');
    const bad = await fetch(forged, { redirect: 'manual', headers: { Authorization: authz } });
    assert.match(bad.headers.get('location'), /kanban=error/);

    // Start again and finish properly.
    const again = new URL((await app.call('POST', '/api/kanban/connect')).body.url);
    const back = new URL((await fetch(again, { redirect: 'manual' })).headers.get('location'));
    const done = await fetch(back, { redirect: 'manual', headers: { Authorization: authz } });
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/?kanban=connected');
    // The same code cannot be used twice.
    assert.match((await fetch(back, { redirect: 'manual', headers: { Authorization: authz } })).headers.get('location'), /kanban=error/);

    const st = (await app.call('GET', '/api/kanban/status')).body;
    assert.equal(st.connected, true);
    assert.equal(st.connectedBy, 'alice');

    const info = await app.call('GET', '/api/errors/MPL-0002/card');
    assert.equal(info.body.board.title, 'TUIP');
    const created = await app.call('POST', '/api/errors/MPL-0002/card', {});
    assert.equal(created.status, 201);

    // The access token expires: the app refreshes it by itself.
    mcp.oauth.access.clear();
    const refreshed = await app.call('POST', '/api/errors/MPL-0002/card', { title: 'after refresh' });
    assert.equal(refreshed.status, 201);
    assert.equal(lastArgs.title, 'after refresh');

    // Access and refresh tokens both revoked: the user is asked to connect again.
    mcp.oauth.access.clear();
    mcp.oauth.refresh.clear();
    const revoked = await app.call('GET', '/api/errors/MPL-0002/card');
    assert.equal(revoked.status, 409);
    assert.equal(revoked.body.connect, true);
    assert.equal((await app.call('GET', '/api/kanban/status')).body.connected, false);

    // Connect again, then disconnect.
    const third = new URL((await app.call('POST', '/api/kanban/connect')).body.url);
    await fetch(new URL((await fetch(third, { redirect: 'manual' })).headers.get('location')), { redirect: 'manual', headers: { Authorization: authz } });
    assert.equal((await app.call('GET', '/api/kanban/status')).body.connected, true);
    const off = await app.call('POST', '/api/kanban/disconnect');
    assert.equal(off.body.connected, false);
    assert.equal((await app.call('POST', '/api/errors/MPL-0002/card', {})).status, 409);
  } finally {
    await app.close();
  }
});

test('OAuth: the sign-in page reporting an error comes back as a message', async () => {
  const app = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url });
  try {
    const r = await fetch(`${app.base}/kanban/oauth/callback?error=access_denied&error_description=User+said+no`, {
      redirect: 'manual', headers: { Authorization: 'Basic ' + Buffer.from('alice:wonderland').toString('base64') },
    });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /kanban=error&msg=User\+said\+no/);
  } finally {
    await app.close();
  }
});

const KNOWN = { integration_flow_name: 'INT406_TUE_IOT_COMB', errormessage: 'HTTP operation failed invoking', rootcause: 'MWW API down', solutions: 'Restart', status: 'Open' };

test('a new known error creates its Kanban card by itself', async () => {
  const r = await api.call('POST', '/api/known-errors', { ...KNOWN, message_guid: 'MPL-0001' });
  assert.equal(r.status, 201);
  const id = r.body.ea_id;
  assert.equal(r.body.kanban.existed, false);
  assert.equal(r.body.kanban.card.column, 'To do');
  assert.equal(lastArgs.title, 'Fix error on INT406_TUE_IOT_COMB: MWW API down');
  assert.match(lastArgs.description, new RegExp(`\\[CPI-KE-${id}\\]`));
  assert.match(lastArgs.description, /Root cause: MWW API down/);
  assert.match(lastArgs.description, /Recorded from this message:[\s\S]*Message ID: MPL-0001/);
  assert.deepEqual(lastArgs.labels, ['Monitoring']);
  assert.equal(lastArgs.assignees, undefined);

  // Editing the known error does not create another card.
  const n = cards.length;
  const u = await api.call('PUT', `/api/known-errors/${id}`, { ...KNOWN, status: 'In Progress' });
  assert.equal(u.status, 200);
  assert.equal(cards.length, n);
});

test('a known error that already has a card is not filed twice', async () => {
  const next = (await db.pool.query("SELECT nextval(pg_get_serial_sequence('error_analyzed', 'ea_id')) AS n")).rows[0].n;
  const id = Number(next) + 1;
  cards.push({ id: 'pre', column: 'Backlog', title: 'made by hand', description: `notes [CPI-KE-${id}]`, createdAt: new Date().toISOString() });
  const n = cards.length;
  const r = await api.call('POST', '/api/known-errors', KNOWN);
  assert.equal(r.body.ea_id, id);
  assert.equal(r.body.kanban.existed, true);
  assert.equal(r.body.kanban.card.id, 'pre');
  assert.equal(cards.length, n);
});

test('auto cards: assignee setting, switched off, and Kanban failures do not block the save', async () => {
  const assigned = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_AUTO_ASSIGNEE: 'Boripan.C' });
  const off = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_AUTO_CARD: 'false' });
  const broken = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_MCP_TOKEN: TOKEN, KANBAN_COLUMN: 'Nowhere' });
  const oauth = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url });
  try {
    const a = await assigned.call('POST', '/api/known-errors', KNOWN);
    assert.equal(a.status, 201);
    assert.deepEqual(lastArgs.assignees, ['Boripan.C']);

    const n = cards.length;
    const o = await off.call('POST', '/api/known-errors', KNOWN);
    assert.equal(o.status, 201);
    assert.equal(o.body.kanban, undefined);
    assert.equal(cards.length, n);

    const b = await broken.call('POST', '/api/known-errors', KNOWN);
    assert.equal(b.status, 201);
    assert.ok(b.body.ea_id);
    assert.match(b.body.kanban.error, /Column "Nowhere" not found/);

    const c = await oauth.call('POST', '/api/known-errors', KNOWN);
    assert.equal(c.status, 201);
    assert.equal(c.body.kanban.connect, true);
  } finally {
    await Promise.all([assigned.close(), off.close(), broken.close(), oauth.close()]);
  }
});

test('OAuth from an app on plain http: the sign-in ends on localhost and the address is pasted back', async () => {
  const app = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, TRUST_PROXY: '1' });
  try {
    await app.call('POST', '/api/kanban/disconnect');
    const start = await app.call('POST', '/api/kanban/connect', undefined, { 'X-Forwarded-Host': 'cpi-errors.intranet:3000' });
    assert.equal(start.status, 200);
    assert.equal(start.body.paste, true);
    const signIn = new URL(start.body.url);
    assert.equal(signIn.searchParams.get('redirect_uri'), 'http://localhost/kanban/oauth/callback');
    const landed = (await fetch(signIn, { redirect: 'manual' })).headers.get('location');
    assert.match(landed, /^http:[/][/]localhost[/]kanban[/]oauth[/]callback[?]code=/);

    assert.equal((await app.call('POST', '/api/kanban/finish', { url: 'http://localhost/kanban/oauth/callback' })).status, 400);
    const denied = await app.call('POST', '/api/kanban/finish', { url: 'http://localhost/kanban/oauth/callback?error=access_denied' });
    assert.match(denied.body.error, /not approved: access_denied/);

    const done = await app.call('POST', '/api/kanban/finish', { url: `  ${landed}  ` });
    assert.equal(done.status, 200);
    assert.equal(done.body.connected, true);
    assert.equal((await app.call('POST', '/api/errors/MPL-0002/card', { title: 'via paste' })).status, 201);
  } finally {
    await app.close();
  }
});

test('OAuth behind an https proxy uses the public https address', async () => {
  const app = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, TRUST_PROXY: '1' });
  const fixed = await startApp(db.pool, { KANBAN_MCP_URL: mcp.url, KANBAN_OAUTH_REDIRECT_URL: 'https://cpi.example.com/kanban/oauth/callback' });
  try {
    const r = await app.call('POST', '/api/kanban/connect', undefined, { 'X-Forwarded-Host': 'cpi.example.com', 'X-Forwarded-Proto': 'https' });
    assert.equal(r.body.paste, false);
    assert.equal(new URL(r.body.url).searchParams.get('redirect_uri'), 'https://cpi.example.com/kanban/oauth/callback');
    const f = await fixed.call('POST', '/api/kanban/connect', undefined, {});
    assert.equal(f.body.paste, false);
    assert.equal(new URL(f.body.url).searchParams.get('redirect_uri'), 'https://cpi.example.com/kanban/oauth/callback');
  } finally {
    await app.close();
    await fixed.close();
  }
});

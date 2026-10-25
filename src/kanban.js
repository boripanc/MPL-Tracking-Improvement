'use strict';

/**
 * MCP client for the TodoList Kanban app (the "WorkStream" MCP server). Used to turn a CPI error into a card.
 *
 * Login: OAuth (the standard MCP authorization flow). Someone clicks "Connect Kanban board" once, signs in to
 * the Kanban app and approves; the app keeps the tokens in the kanban_oauth table and refreshes them by itself.
 * Cards are then created as that person. A fixed API key (KANBAN_MCP_TOKEN) also works, for servers that offer one.
 *
 * Each request opens a short MCP session (initialize, call the tools, close): cards are created by hand, a few
 * times a day, so there is no long-lived connection to keep healthy.
 */
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { auth, UnauthorizedError } = require('@modelcontextprotocol/sdk/client/auth.js');
const { fetch: undiciFetch } = require('undici');
const { proxyAgent } = require('./cpi/client');

const VERSION = require('../package.json').version;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const CALLBACK_PATH = '/kanban/oauth/callback';

class KanbanError extends Error {
  constructor(message, status = 502, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Reads a tool result: the servers answer with JSON in a text block; errors come back with isError. */
function toolResult(name, r) {
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new KanbanError(`Kanban ${name}: ${text || 'failed'}`);
  if (text) {
    try { return JSON.parse(text); } catch { /* not JSON */ }
  }
  return r.structuredContent !== undefined ? r.structuredContent : text;
}

/* ---------- OAuth state, kept in one row of kanban_oauth ---------- */

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS kanban_oauth (
  id         text PRIMARY KEY,
  data       jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now())`;

function createOAuthStore(pool, key = 'default') {
  let ready = null;
  const ensure = () => (ready = ready || pool.query(ENSURE_TABLE).catch((e) => { ready = null; throw e; }));
  return {
    async get() {
      await ensure();
      const { rows } = await pool.query('SELECT data FROM kanban_oauth WHERE id = $1', [key]);
      return rows.length ? rows[0].data : {};
    },
    /** Merges `values` into the row; keys set to null are removed. */
    async patch(values) {
      await ensure();
      const drop = Object.keys(values).filter((k) => values[k] === null || values[k] === undefined);
      const set = Object.fromEntries(Object.entries(values).filter(([k]) => !drop.includes(k)));
      await pool.query(
        `INSERT INTO kanban_oauth (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = (kanban_oauth.data - $3::text[]) || $2::jsonb, updated_at = now()`,
        [key, JSON.stringify(set), drop],
      );
    },
  };
}

/** OAuthClientProvider for the MCP SDK, backed by the store. */
function oauthProvider(store, cfg, redirectUri, onRedirect, { ignoreTokens = false } = {}) {
  return {
    get redirectUrl() { return redirectUri; },
    get clientMetadata() {
      return {
        client_name: 'CPI Error Center',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: cfg.clientSecret ? 'client_secret_post' : 'none',
        ...(cfg.scope ? { scope: cfg.scope } : {}),
      };
    },
    async state() { return (await store.get()).state; },
    async clientInformation() {
      if (cfg.clientId) return { client_id: cfg.clientId, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}) };
      return (await store.get()).client;
    },
    async saveClientInformation(client) { await store.patch({ client }); },
    async tokens() { return ignoreTokens ? undefined : (await store.get()).tokens; },
    async saveTokens(tokens) { await store.patch({ tokens, tokensSavedAt: new Date().toISOString() }); },
    redirectToAuthorization(url) { onRedirect(url); },
    async saveCodeVerifier(verifier) { await store.patch({ verifier }); },
    async codeVerifier() {
      const v = (await store.get()).verifier;
      if (!v) throw new KanbanError('The Kanban sign-in expired. Click "Connect Kanban board" again.', 400);
      return v;
    },
    async invalidateCredentials(scope) {
      if (scope === 'all') await store.patch({ client: null, tokens: null, verifier: null });
      else if (scope === 'client') await store.patch({ client: null });
      else if (scope === 'tokens') await store.patch({ tokens: null });
      else if (scope === 'verifier') await store.patch({ verifier: null });
    },
  };
}

function createKanban(cfg, { pool, env = process.env } = {}) {
  const enabled = Boolean(cfg && cfg.url);
  const useOAuth = enabled && !cfg.token;
  const store = useOAuth ? createOAuthStore(pool) : null;
  const dispatcher = proxyAgent(env);
  const fetchFn = dispatcher ? (url, init) => undiciFetch(url, { ...init, dispatcher }) : undefined;
  let boardIdCache = null;

  const expired = async () => {
    await store.patch({ tokens: null });
    return new KanbanError('The Kanban sign-in has expired or was revoked. Click "Connect Kanban board" and sign in again.', 409, { connect: true });
  };
  const refused = (err) => {
    const code = err && (err.code || (err.cause && err.cause.code));
    return err instanceof UnauthorizedError || code === 401 || code === 403 || /\b(401|403)\b/.test((err && err.message) || '');
  };

  const notConnected = () => new KanbanError('The Kanban board is not connected yet. Click "Connect Kanban board" and sign in.', 409, { connect: true });

  async function session(fn) {
    if (!enabled) throw new KanbanError('The Kanban board is not set up. Set KANBAN_MCP_URL on the server.', 409);
    let authProvider;
    let requestInit;
    if (useOAuth) {
      const saved = await store.get();
      if (!saved.tokens) throw notConnected();
      // A refresh that fails would start a new sign-in; that can only happen from the Connect button.
      authProvider = oauthProvider(store, cfg, saved.redirectUri, () => {});
    } else {
      const headers = { [cfg.authHeader]: /^authorization$/i.test(cfg.authHeader) ? `Bearer ${cfg.token}` : cfg.token };
      requestInit = { headers };
    }
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { authProvider, requestInit, fetch: fetchFn });
    const client = new Client({ name: 'cpi-error-center', version: VERSION });
    const opts = { timeout: cfg.timeoutMs };
    try {
      await client.connect(transport, opts);
    } catch (err) {
      if (err instanceof KanbanError) throw err;
      const host = new URL(cfg.url).host;
      // A token the server no longer takes: forget it and ask for a new sign-in (OAuth), or name the key.
      if (refused(err)) {
        if (useOAuth) throw await expired();
        throw new KanbanError(`The Kanban server ${host} refused the login. Check KANBAN_MCP_TOKEN.`);
      }
      throw new KanbanError(`Cannot reach the Kanban server ${host}: ${err.message}`);
    }
    const call = async (name, args = {}) => toolResult(name, await client.callTool({ name, arguments: args }, undefined, opts));
    try {
      return await fn(call);
    } catch (err) {
      // The token can also be revoked between two calls of the same request.
      if (useOAuth && !(err instanceof KanbanError) && refused(err)) throw await expired();
      throw err;
    } finally {
      await client.close().catch(() => {});
    }
  }

  /* ----- OAuth connect / callback / disconnect ----- */

  /**
   * Starts the sign-in. `redirectUri` is where the Kanban app sends the browser back. Returns the URL to open.
   * `force` (the "Sign in again" link): forget the saved tokens and client registration first, so nothing old is
   * reused, and ask the Kanban app to show its login page even if the browser is still signed in there
   * (prompt=login), so another account can be picked.
   */
  async function connect({ redirectUri, user, force = false }) {
    if (!useOAuth) throw new KanbanError('This server uses a fixed Kanban API key (KANBAN_MCP_TOKEN), so there is nothing to connect.', 409);
    // The Kanban server only takes an https callback (or http on localhost). When this app is opened over plain
    // http on another host and no KANBAN_OAUTH_REDIRECT_URL is set, the sign-in returns to http://localhost and
    // the user pastes that address back into the app ("paste" mode).
    if (cfg.redirectUrl) {
      const r = new URL(cfg.redirectUrl);
      if (r.host === new URL(cfg.url).host || r.pathname !== CALLBACK_PATH) {
        throw new KanbanError(`KANBAN_OAUTH_REDIRECT_URL must be this app's own address ending in ${CALLBACK_PATH}, `
          + `not the Kanban server's (it is ${cfg.redirectUrl}). Clear it to use the copy-and-paste sign-in, then restart.`, 409);
      }
    }
    let uri = cfg.redirectUrl || redirectUri;
    const paste = !cfg.redirectUrl && !callbackAllowed(uri);
    if (paste) uri = `http://localhost${CALLBACK_PATH}`;
    if (force) {
      await store.patch({ tokens: null, client: null, verifier: null, connectedBy: null, connectedAt: null });
      boardIdCache = null;
    }
    const saved = await store.get();
    // A client registered for another callback address (the app moved) has to register again.
    const stale = saved.client && Array.isArray(saved.client.redirect_uris) && !saved.client.redirect_uris.includes(uri);
    await store.patch({ state: crypto.randomBytes(24).toString('base64url'), redirectUri: uri, pendingUser: user || null, ...(stale ? { client: null } : {}) });
    let url = null;
    // Ignore saved tokens so auth() goes to the sign-in page; the current connection keeps working until it is replaced.
    const provider = oauthProvider(store, cfg, uri, (u) => { url = u; }, { ignoreTokens: true });
    let result;
    try {
      result = await auth(provider, { serverUrl: cfg.url, scope: cfg.scope || undefined, fetchFn });
    } catch (err) {
      throw new KanbanError(`Cannot start the Kanban sign-in: ${err.message}`);
    }
    if (result !== 'REDIRECT' || !url) throw new KanbanError('The Kanban server did not ask for a sign-in.');
    if (force) {
      url = new URL(url);
      url.searchParams.set('prompt', 'login');
    }
    return { url: url.toString(), paste, force };
  }

  /** Finishes the sign-in with the code and state the Kanban app sent back. */
  async function finish({ code, state }) {
    if (!useOAuth) throw new KanbanError('This server does not use a Kanban sign-in.', 409);
    const saved = await store.get();
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    if (!saved.state || !state || !crypto.timingSafeEqual(digest(saved.state), digest(state))) {
      throw new KanbanError('The Kanban sign-in could not be verified (state mismatch). Start it again from the app.', 400);
    }
    const provider = oauthProvider(store, cfg, saved.redirectUri, () => {});
    try {
      const result = await auth(provider, { serverUrl: cfg.url, authorizationCode: code, scope: cfg.scope || undefined, fetchFn });
      if (result !== 'AUTHORIZED') throw new Error('no token was issued');
    } catch (err) {
      if (err instanceof KanbanError) throw err;
      throw new KanbanError(`The Kanban sign-in failed: ${err.message}`);
    } finally {
      await store.patch({ state: null, verifier: null });
    }
    await store.patch({ connectedBy: saved.pendingUser || null, connectedAt: new Date().toISOString(), pendingUser: null });
    boardIdCache = null;
  }

  async function disconnect() {
    if (!useOAuth) throw new KanbanError('This server uses a fixed Kanban API key, so there is nothing to disconnect.', 409);
    await store.patch({ tokens: null, connectedBy: null, connectedAt: null });
    boardIdCache = null;
  }

  /** enabled = KANBAN_MCP_URL set; connected = a key is set or someone signed in. */
  async function status() {
    if (!enabled) return { enabled: false, connected: false };
    if (!useOAuth) return { enabled: true, connected: true, auth: 'token', autoCard: cfg.autoCard };
    const s = await store.get();
    return { enabled: true, connected: Boolean(s.tokens), auth: 'oauth', autoCard: cfg.autoCard, connectedBy: s.connectedBy || null, connectedAt: s.connectedAt || null };
  }

  /* ----- board and cards ----- */

  /** KANBAN_BOARD may be a board id or title; when empty, the first board is used. */
  async function boardId(call) {
    if (boardIdCache) return boardIdCache;
    const boards = await call('list_boards');
    if (!Array.isArray(boards) || !boards.length) throw new KanbanError('The Kanban account has no boards.');
    const want = (cfg.board || '').toLowerCase();
    const board = want ? boards.find((b) => b.id.toLowerCase() === want || String(b.title).toLowerCase() === want) : boards[0];
    if (!board) throw new KanbanError(`Kanban board "${cfg.board}" not found. Boards: ${boards.map((b) => b.title).join(', ')}.`);
    if (board.role === 'viewer') throw new KanbanError(`The Kanban account can only view board "${board.title}", so it cannot create cards.`);
    boardIdCache = board.id;
    return board.id;
  }

  /** Columns, labels and team of the board, plus the cards that already mention `search` (the message ID). */
  async function board({ search } = {}) {
    return session(async (call) => {
      const id = await boardId(call);
      const b = await call('get_board', { boardId: id });
      const cards = search ? await call('find_cards', { boardId: id, search, limit: 20 }) : [];
      const assignee = await suggestedAssignee(call, id);
      return {
        enabled: true,
        connected: true,
        board: { id: b.id, title: b.title },
        columns: (b.columns || []).map((c) => c.title),
        labels: (b.labels || []).map((l) => l.name),
        team: (b.team || []).map((t) => t.name),
        defaults: { column: cfg.column, labels: cfg.labels, priority: cfg.priority, assignee },
        existing: (Array.isArray(cards) ? cards : []).map(cardSummary),
        cardUrl: cfg.cardUrl,
      };
    });
  }

  async function createCard(card) {
    return session(async (call) => {
      const args = { boardId: await boardId(call), column: card.column || cfg.column, title: card.title, description: card.description };
      if (card.labels && card.labels.length) args.labels = card.labels;
      if (card.priority && card.priority !== 'none') args.priority = card.priority;
      if (card.assignees && card.assignees.length) args.assignees = card.assignees;
      if (card.dueDate) args.dueDate = card.dueDate;
      return cardSummary(await call('create_card', args));
    });
  }

  /**
   * Card for a new known error (error_analyzed row), unless the board already has one for it. Used when someone
   * records a root cause, so every known error gets a card without a click. Returns { card, existed }.
   */
  async function ensureKnownErrorCard(ea, { detail } = {}) {
    const card = cardFromKnownError(ea, detail);
    return session(async (call) => {
      const id = await boardId(call);
      const found = await call('find_cards', { boardId: id, search: knownErrorMarker(ea.ea_id), limit: 5 });
      if (Array.isArray(found) && found.length) return { card: cardSummary(found[0]), existed: true };
      const args = { boardId: id, column: cfg.column, title: card.title, description: card.description };
      if (cfg.labels.length) args.labels = cfg.labels;
      if (cfg.priority && cfg.priority !== 'none') args.priority = cfg.priority;
      const assign = await autoAssignee(call, id);
      if (assign.names.length) args.assignees = assign.names;
      const created = cardSummary(await call('create_card', args));
      return { card: { ...created, assignees: assign.names, assignedBy: assign.by }, existed: false, assign };
    });
  }

  /**
   * Who an automatic card goes to. KANBAN_AUTO_ASSIGNEE: a list of names = always them, "none" = nobody,
   * empty (default) = the team member with the most free capacity on the board (see pickByCapacity).
   */
  async function autoAssignee(call, id) {
    if (cfg.autoAssignMode === 'none') return { names: [], by: 'none' };
    if (cfg.autoAssignMode === 'fixed') return { names: cfg.autoAssignees, by: 'setting' };
    try {
      const w = await call('get_workload', { boardId: id });
      const pick = pickByCapacity(w && w.members);
      return pick ? { names: [pick.name], by: 'capacity', free: pick.free } : { names: [], by: 'capacity', reason: 'everyone is at or over capacity' };
    } catch (err) {
      // Never lose the card over this: create it unassigned.
      console.error('[kanban] workload lookup failed:', err.message);
      return { names: [], by: 'capacity', reason: `workload not available (${err.message})` };
    }
  }

  /** Suggested assignee for the card form: the same capacity rule, or the fixed names. */
  async function suggestedAssignee(call, id) {
    const a = await autoAssignee(call, id);
    return a.names[0] || '';
  }

  return { enabled, useOAuth, status, connect, finish, disconnect, board, createCard, ensureKnownErrorCard };
}

/**
 * The member with room left (open cards below capacity) and the most room; ties go to fewer overdue cards,
 * then fewer open cards, then name. Nobody with room left = no one (the card stays unassigned).
 */
function pickByCapacity(members) {
  const withRoom = (Array.isArray(members) ? members : [])
    .map((m) => ({ name: m.name, free: Number(m.capacity || 0) - Number(m.openCount || 0), overdue: Number(m.overdue || 0), open: Number(m.openCount || 0) }))
    .filter((m) => m.name && m.free > 0);
  withRoom.sort((a, b) => b.free - a.free || a.overdue - b.overdue || a.open - b.open || a.name.localeCompare(b.name));
  return withRoom[0] || null;
}

function cardSummary(c) {
  return { id: c.id, title: c.title, column: c.column, priority: c.priority, createdAt: c.createdAt };
}

/** Default card for an error (the shape of GET /api/errors/:guid). Plain text, as the board shows notes as text. */
function cardFromError(d) {
  const m = d.mpl;
  const lines = [
    `iFlow: ${m.flow || '–'}`,
    m.package ? `Package: ${m.package}` : '',
    `Status: ${m.status || '–'}${m.custom_status && m.custom_status !== m.status ? ` (${m.custom_status})` : ''}`,
    m.log_start ? `Started: ${new Date(m.log_start).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '',
    `Message ID: ${m.message_guid}`,
    m.correlation_id ? `Correlation ID: ${m.correlation_id}` : '',
    m.sender || m.receiver ? `Sender / receiver: ${m.sender || '–'} / ${m.receiver || '–'}` : '',
    m.application_message_id ? `Application message: ${m.application_message_id}${m.application_message_type ? ` (${m.application_message_type})` : ''}` : '',
    d.category ? `Category: ${d.category.category_name}` : '',
    m.link ? `CPI monitor: ${m.link}` : '',
  ].filter(Boolean);
  if (d.analysis) {
    lines.push('', `Known error #${d.analysis.ea_id} (${d.analysis.status})`);
    if (d.analysis.rootcause) lines.push(`Root cause: ${d.analysis.rootcause}`);
    if (d.analysis.solutions) lines.push(`Solution: ${d.analysis.solutions}`);
  }
  const err = (d.errormsg || '').trim();
  if (err) lines.push('', 'Error:', err.length > 3000 ? err.slice(0, 3000) + '…' : err);
  return { title: `Fix error on ${m.flow || m.message_guid}`.slice(0, 200), description: lines.join('\n') };
}

/** OAuth servers accept https callbacks, and plain http only on this computer (localhost). */
function callbackAllowed(uri) {
  return /^https:[/][/]/i.test(uri) || /^http:[/][/](localhost|127[.]0[.]0[.]1|\[::1\])([:/]|$)/i.test(uri);
}

/** Reads code / state / error from the address the browser landed on after the sign-in (paste mode). */
function parseCallback(text) {
  const raw = String(text || '').trim();
  let q;
  try {
    q = new URL(raw).searchParams;
  } catch {
    q = new URLSearchParams(raw.replace(/^[^?]*[?]/, ''));
  }
  return { code: q.get('code') || '', state: q.get('state') || '', error: q.get('error_description') || q.get('error') || '' };
}

/** Tag in the card notes that ties a card to a known error, so it is found again (find_cards searches notes). */
function knownErrorMarker(eaId) { return `[CPI-KE-${eaId}]`; }

/** Card for a known error; `detail` (GET /api/errors/:guid shape) adds the message it was recorded from. */
function cardFromKnownError(ea, detail) {
  const flow = ea.integration_flow_name || '';
  const cause = (ea.rootcause || '').replace(/\s+/g, ' ').trim();
  const head = flow ? `Fix error on ${flow}` : `Known error #${ea.ea_id}`;
  const title = (cause ? `${head}: ${cause.length > 80 ? cause.slice(0, 80) + '…' : cause}` : head).slice(0, 200);
  const lines = [
    `Known error #${ea.ea_id} (${ea.status || 'Open'}) ${knownErrorMarker(ea.ea_id)}`,
    `iFlow: ${flow || 'any'}`,
    ea.rootcause ? `Root cause: ${ea.rootcause}` : '',
    ea.solutions ? `Solution: ${ea.solutions}` : '',
    '',
    'Error text pattern:',
    ea.errormessage || '',
  ];
  if (detail && detail.mpl) {
    const from = cardFromError({ ...detail, analysis: null });
    lines.push('', 'Recorded from this message:', from.description);
  }
  return { title, description: lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 8000) };
}

module.exports = { createKanban, cardFromError, cardFromKnownError, pickByCapacity, parseCallback, callbackAllowed, KanbanError, PRIORITIES, CALLBACK_PATH };

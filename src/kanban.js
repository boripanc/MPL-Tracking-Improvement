'use strict';

/**
 * MCP client for the TodoList Kanban app (the "WorkStream" MCP server). Used to turn a CPI error into a card.
 * Each request opens a short MCP session (initialize, call the tools, close): cards are created by hand, a few
 * times a day, so there is no long-lived connection to keep healthy.
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { fetch: undiciFetch } = require('undici');
const { proxyAgent } = require('./cpi/client');

const VERSION = require('../package.json').version;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

class KanbanError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
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

function createKanban(cfg, { env = process.env } = {}) {
  const enabled = Boolean(cfg && cfg.url);
  let boardIdCache = null;

  async function session(fn) {
    if (!enabled) throw new KanbanError('The Kanban board is not connected. Set KANBAN_MCP_URL (and KANBAN_MCP_TOKEN) on the server.', 409);
    const headers = {};
    if (cfg.token) headers[cfg.authHeader] = /^authorization$/i.test(cfg.authHeader) ? `Bearer ${cfg.token}` : cfg.token;
    const dispatcher = proxyAgent(env);
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers },
      fetch: dispatcher ? (url, init) => undiciFetch(url, { ...init, dispatcher }) : undefined,
    });
    const client = new Client({ name: 'cpi-error-center', version: VERSION });
    const opts = { timeout: cfg.timeoutMs };
    try {
      await client.connect(transport, opts);
    } catch (err) {
      const host = new URL(cfg.url).host;
      const code = err && (err.code || (err.cause && err.cause.code));
      if (code === 401 || code === 403 || /\b(401|403)\b/.test(err.message || '')) {
        throw new KanbanError(`The Kanban server ${host} refused the login. Check KANBAN_MCP_TOKEN.`);
      }
      throw new KanbanError(`Cannot reach the Kanban server ${host}: ${err.message}`);
    }
    const call = async (name, args = {}) => toolResult(name, await client.callTool({ name, arguments: args }, undefined, opts));
    try {
      return await fn(call);
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** KANBAN_BOARD may be a board id or title; when empty, the only board (or the first one) is used. */
  async function boardId(call) {
    if (boardIdCache) return boardIdCache;
    const boards = await call('list_boards');
    if (!Array.isArray(boards) || !boards.length) throw new KanbanError('The Kanban server has no boards for this API key.');
    const want = (cfg.board || '').toLowerCase();
    const board = want ? boards.find((b) => b.id.toLowerCase() === want || String(b.title).toLowerCase() === want) : boards[0];
    if (!board) throw new KanbanError(`Kanban board "${cfg.board}" not found. Boards: ${boards.map((b) => b.title).join(', ')}.`);
    if (board.role === 'viewer') throw new KanbanError(`The API key can only view board "${board.title}", so it cannot create cards.`);
    boardIdCache = board.id;
    return board.id;
  }

  /** Columns, labels and team of the board, plus the cards that already mention `search` (the message ID). */
  async function board({ search } = {}) {
    return session(async (call) => {
      const id = await boardId(call);
      const b = await call('get_board', { boardId: id });
      const cards = search ? await call('find_cards', { boardId: id, search, limit: 20 }) : [];
      return {
        enabled: true,
        board: { id: b.id, title: b.title },
        columns: (b.columns || []).map((c) => c.title),
        labels: (b.labels || []).map((l) => l.name),
        team: (b.team || []).map((t) => t.name),
        defaults: { column: cfg.column, labels: cfg.labels, priority: cfg.priority },
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

  return { enabled, board, createCard };
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

module.exports = { createKanban, cardFromError, KanbanError, PRIORITIES };

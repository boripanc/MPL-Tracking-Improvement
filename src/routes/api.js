'use strict';

const express = require('express');
const SQL = require('../sql');
const { queryResult } = require('../db');
const { HttpError } = require('../middleware/errors');
const { checkConnection } = require('../cpi/client');
const { cardFromError, parseCallback, KanbanError, PRIORITIES, CALLBACK_PATH } = require('../kanban');

const STATUSES = ['Open', 'In Progress', 'Monitoring', 'Resolved'];
const MPL_STATUSES = ['FAILED', 'ESCALATED', 'RETRY'];

/* ---------- input helpers ---------- */

function text(value, field, max, { required = false, min = 0 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const v = value.trim();
  if (required && !v) throw new HttpError(400, `${field} is required`);
  if (v && v.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, `${field} must be a positive integer`);
  return n;
}

function int(value, field, { min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be an integer between ${min} and ${max}`);
  return n;
}

function isoDate(value, field) {
  if (value === undefined || value === '') return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new HttpError(400, `${field} must be an ISO date`);
  return new Date(t).toISOString();
}

function timeZone(value, fallback) {
  const tz = value || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new HttpError(400, 'tz must be an IANA time zone such as Asia/Bangkok');
  }
  return tz;
}

function range(query, config) {
  const r = { from: isoDate(query.from, 'from'), to: isoDate(query.to, 'to'), tz: timeZone(query.tz, config.defaultTz) };
  if (r.from && r.to && r.from > r.to) throw new HttpError(400, 'from must be before to');
  return r;
}

function knownErrorBody(b) {
  const status = b.status === undefined || b.status === '' ? 'Open' : b.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}`);
  return {
    integration_flow_name: text(b.integration_flow_name, 'integration_flow_name', 300),
    errormessage: text(b.errormessage, 'errormessage', 4000, { required: true, min: 10 }),
    rootcause: text(b.rootcause, 'rootcause', 4000),
    solutions: text(b.solutions, 'solutions', 8000),
    status,
  };
}

function categoryBody(b) {
  return {
    category_name: text(b.category_name, 'category_name', 200, { required: true }),
    category_expression: text(b.category_expression, 'category_expression', 2000, { required: true }),
    integration_flow_name: text(b.integration_flow_name, 'integration_flow_name', 300),
    application_name: text(b.application_name, 'application_name', 200),
  };
}

function list(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== 'string' || v.length > 100)) {
    throw new HttpError(400, `${field} must be a list of names`);
  }
  return value.map((v) => v.trim()).filter(Boolean);
}

/** Turns Kanban failures into a readable HTTP error (409 = not configured, 502 = the Kanban server failed). */
async function kanbanCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof KanbanError) throw Object.assign(new HttpError(err.status, err.message), err.connect ? { connect: true } : {});
    console.error('[kanban] request failed:', err);
    throw new HttpError(502, `Kanban server error: ${err.message}`);
  }
}

/* ---------- router ---------- */

function apiRouter({ pool, config, certificates, tickets, kanban }) {
  const router = express.Router();
  const run = (sql, params) => queryResult(pool, sql, params);
  const handle = (fn) => (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((data) => { if (!res.headersSent) res.json(data); })
      .catch(next);
  };

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/meta', handle(async () => ({
    ...(await run(SQL.meta)),
    certificatesCanSync: certificates.canSync,
    kanban: await kanban.status().catch(() => ({ enabled: kanban.enabled, connected: false })),
  })));

  router.get('/dashboard', handle((req) => run(SQL.dashboard, range(req.query, config))));

  router.get('/errors', handle((req) => {
    const q = req.query;
    const status = q.status || '';
    if (status && !MPL_STATUSES.includes(status)) throw new HttpError(400, `status must be one of: ${MPL_STATUSES.join(', ')}`);
    const category = q.category || '';
    if (category && category !== '__none') id(category, 'category');
    const analysis = q.analysis || '';
    if (analysis && !['__none', '__known', ...STATUSES].includes(analysis)) throw new HttpError(400, 'analysis filter is not valid');
    return run(SQL.errors, {
      ...range(q, config),
      flow: text(q.flow, 'flow', 300),
      status,
      category,
      analysis,
      q: text(q.q, 'q', 500),
      limit: int(q.limit, 'limit', { min: 1, max: 500, fallback: 50 }),
      offset: int(q.offset, 'offset', { min: 0, max: 1000000, fallback: 0 }),
    });
  }));

  router.get('/errors/:guid', handle(async (req) => {
    const guid = text(req.params.guid, 'guid', 100, { required: true });
    const data = await run(SQL.errorDetail, { guid });
    if (!data || !data.mpl) throw new HttpError(404, 'Message not found');
    return data;
  }));

  // Kanban (TodoList Kanban app over MCP): board columns/labels/team, the suggested card for this error and the
  // cards that already mention its message ID.
  router.get('/errors/:guid/card', handle(async (req) => {
    const guid = text(req.params.guid, 'guid', 100, { required: true });
    const data = await run(SQL.errorDetail, { guid });
    if (!data || !data.mpl) throw new HttpError(404, 'Message not found');
    const suggested = cardFromError(data);
    const st = await kanban.status();
    if (!st.connected) return { ...st, suggested };
    return { ...(await kanbanCall(() => kanban.board({ search: guid }))), suggested };
  }));

  // Behind a reverse proxy (TRUST_PROXY) the address the browser used is in X-Forwarded-Host.
  const publicHost = (req) => {
    const fwd = config.trustProxy && req.get('x-forwarded-host');
    return fwd ? fwd.split(',')[0].trim() : req.get('host');
  };

  router.get('/kanban/status', handle(() => kanban.status()));

  // Starts the OAuth sign-in; the browser opens the returned URL and comes back to /kanban/oauth/callback.
  router.post('/kanban/connect', handle((req) => kanbanCall(() => kanban.connect({
    redirectUri: `${req.protocol}://${publicHost(req)}${CALLBACK_PATH}`,
    user: req.user,
  }))));

  // Paste mode: the sign-in ended on http://localhost/...; the user pastes that address here to finish it.
  router.post('/kanban/finish', handle(async (req) => {
    const r = parseCallback(text((req.body || {}).url, 'url', 4000, { required: true }));
    if (r.error) throw new HttpError(400, `The Kanban sign-in was not approved: ${r.error}`);
    if (!r.code) throw new HttpError(400, 'That address has no code in it. Paste the whole address from the browser bar after you approve.');
    await kanbanCall(() => kanban.finish(r));
    console.log(`[kanban] ${req.user || 'user'} connected the Kanban board`);
    return kanban.status();
  }));

  router.post('/kanban/disconnect', handle(async (req) => {
    await kanbanCall(() => kanban.disconnect());
    console.log(`[kanban] ${req.user || 'user'} disconnected the Kanban board`);
    return kanban.status();
  }));

  router.post('/errors/:guid/card', handle(async (req, res) => {
    const guid = text(req.params.guid, 'guid', 100, { required: true });
    const data = await run(SQL.errorDetail, { guid });
    if (!data || !data.mpl) throw new HttpError(404, 'Message not found');
    const b = req.body || {};
    const suggested = cardFromError(data);
    const priority = b.priority === undefined || b.priority === '' ? config.kanban.priority : b.priority;
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, `priority must be one of: ${PRIORITIES.join(', ')}`);
    const dueDate = text(b.dueDate, 'dueDate', 10);
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new HttpError(400, 'dueDate must be YYYY-MM-DD');
    const input = {
      title: text(b.title, 'title', 200) || suggested.title,
      description: text(b.description, 'description', 8000) || suggested.description,
      column: text(b.column, 'column', 100),
      labels: b.labels === undefined ? config.kanban.labels : list(b.labels, 'labels'),
      assignees: list(b.assignees, 'assignees'),
      priority,
      dueDate,
    };
    const card = await kanbanCall(() => kanban.createCard(input));
    console.log(`[kanban] ${req.user || 'user'} created card ${card.id} for message ${guid}`);
    res.status(201);
    return card;
  }));

  router.get('/known-errors', handle((req) => run(SQL.knownErrors, range(req.query, config))));

  router.post('/known-errors', handle(async (req, res) => {
    const b = req.body || {};
    const guid = text(b.message_guid, 'message_guid', 100);
    const saved = await run(SQL.saveKnownError, { ...knownErrorBody(b), ea_id: null, user: req.user });
    res.status(201);
    return { ...saved, kanban: await autoCard(saved, guid, req.user) };
  }));

  // A known error saved with status Open (new, or edited back to Open) gets a Kanban card by itself
  // (KANBAN_AUTO_CARD), once: a card that already carries its tag is reused. The known error is saved either
  // way; a Kanban problem only comes back as kanban.error.
  async function autoCard(ea, guid, user) {
    if (!kanban.enabled || !config.kanban.autoCard || !ea || ea.status !== 'Open') return undefined;
    try {
      const st = await kanban.status();
      if (!st.connected) return { error: 'The Kanban board is not connected, so no card was created.', connect: true };
      const detail = guid ? await run(SQL.errorDetail, { guid }) : null;
      const r = await kanban.ensureKnownErrorCard(ea, { detail });
      if (!r.existed) console.log(`[kanban] ${user || 'user'} saved known error ${ea.ea_id} as Open; created card ${r.card.id}`);
      return r;
    } catch (err) {
      console.error(`[kanban] no card for known error ${ea.ea_id}:`, err.message);
      return { error: err.message, ...(err.connect ? { connect: true } : {}) };
    }
  }

  router.put('/known-errors/:id', handle(async (req) => {
    const saved = await run(SQL.saveKnownError, { ...knownErrorBody(req.body || {}), ea_id: id(req.params.id), user: req.user });
    if (!saved) throw new HttpError(404, 'Known error not found');
    const card = await autoCard(saved, '', req.user);
    return card ? { ...saved, kanban: card } : saved;
  }));

  router.delete('/known-errors/:id', handle(async (req) => {
    const r = await run(SQL.deleteKnownError, { ea_id: id(req.params.id) });
    if (!r.deleted) throw new HttpError(404, 'Known error not found');
    return r;
  }));

  router.post('/known-errors/:id/comments', handle(async (req, res) => {
    const comment = text((req.body || {}).comment, 'comment', 5000, { required: true });
    try {
      const saved = await run(SQL.addComment, { ea_id: id(req.params.id), comment });
      res.status(201);
      return saved;
    } catch (e) {
      if (e.code === '23503') throw new HttpError(404, 'Known error not found');
      throw e;
    }
  }));

  router.get('/categories', handle((req) => run(SQL.categories, range(req.query, config))));

  router.post('/categories', handle(async (req, res) => {
    const saved = await run(SQL.saveCategory, { ...categoryBody(req.body || {}), error_id: null });
    res.status(201);
    return saved;
  }));

  router.put('/categories/:id', handle(async (req) => {
    const saved = await run(SQL.saveCategory, { ...categoryBody(req.body || {}), error_id: id(req.params.id) });
    if (!saved) throw new HttpError(404, 'Category not found');
    return saved;
  }));

  router.delete('/categories/:id', handle(async (req) => {
    const r = await run(SQL.deleteCategory, { error_id: id(req.params.id) });
    if (!r.deleted) throw new HttpError(404, 'Category not found');
    return r;
  }));

  router.post('/test-match', handle((req) => {
    const b = req.body || {};
    const kind = b.kind === 'like' ? 'like' : b.kind === 'regex' ? 'regex' : null;
    if (!kind) throw new HttpError(400, "kind must be 'like' or 'regex'");
    return run(SQL.testMatch, {
      kind,
      pattern: text(b.pattern, 'pattern', 4000, { required: true }),
      flow: text(b.flow, 'flow', 300),
    });
  }));

  // Certificate expiry, read from the database (filled by the n8n workflow or the app's own sync).
  router.get('/certificates', handle((req) => certificates.read({ includeRemoved: req.query.removed === '1' })));

  // Copy the keystore from CPI into the database now (only when this server has a CPI connection).
  router.post('/certificates/sync', handle(async () => {
    if (!certificates.canSync) {
      throw new HttpError(409, 'This server has no CPI connection, so it cannot sync. The n8n workflow "CPI Keystore → Postgres" keeps the data up to date.');
    }
    try {
      return await certificates.sync({ source: 'app' });
    } catch (err) {
      console.error('[certificates] sync failed:', err.message);
      throw new HttpError(502, `Could not read the keystore from CPI: ${err.message}`);
    }
  }));

  // Ticket pulse: Freshservice tickets from the table the n8n workflow "FreshServices Tickets" fills.
  router.get('/tickets/pulse', handle((req) => {
    const view = req.query.view || '';
    if (!['', 'day', 'week', 'month', 'year'].includes(view)) throw new HttpError(400, 'view must be day, week, month or year');
    return tickets.pulse({ ...range(req.query, config), view: view === 'day' ? '' : view });
  }));

  router.get('/tickets/:id', handle(async (req) => {
    const t = await tickets.ticket(text(req.params.id, 'id', 100, { required: true }));
    if (!t) throw new HttpError(404, 'Ticket not found');
    return t;
  }));

  // Step-by-step CPI connection test (settings, OAuth token, keystore, message logs). Never returns secrets.
  router.get('/cpi/check', handle(() => checkConnection(config.poller)));

  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}

module.exports = { apiRouter, STATUSES };

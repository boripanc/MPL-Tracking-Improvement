'use strict';

const express = require('express');
const SQL = require('../sql');
const { queryResult } = require('../db');
const { HttpError } = require('../middleware/errors');

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

/* ---------- router ---------- */

function apiRouter({ pool, config, certificates }) {
  const router = express.Router();
  const run = (sql, params) => queryResult(pool, sql, params);
  const handle = (fn) => (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((data) => { if (!res.headersSent) res.json(data); })
      .catch(next);
  };

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/meta', handle(async () => ({ ...(await run(SQL.meta)), certificatesEnabled: Boolean(certificates) })));

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

  router.get('/known-errors', handle((req) => run(SQL.knownErrors, range(req.query, config))));

  router.post('/known-errors', handle(async (req, res) => {
    const saved = await run(SQL.saveKnownError, { ...knownErrorBody(req.body || {}), ea_id: null, user: req.user });
    res.status(201);
    return saved;
  }));

  router.put('/known-errors/:id', handle(async (req) => {
    const saved = await run(SQL.saveKnownError, { ...knownErrorBody(req.body || {}), ea_id: id(req.params.id), user: req.user });
    if (!saved) throw new HttpError(404, 'Known error not found');
    return saved;
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

  // Certificate expiry, read live from the CPI keystore (cached). ?refresh=1 forces a re-read.
  router.get('/certificates', handle(async (req) => {
    if (!certificates) {
      return { enabled: false, reason: 'Set CPI_API_URL, CPI_TOKEN_URL, CPI_CLIENT_ID and CPI_CLIENT_SECRET to show certificates.' };
    }
    // Avoid hammering CPI: a forced refresh is ignored if the last read was under 30 seconds ago.
    const force = req.query.refresh === '1' && Date.now() - certificates.lastFetchedAt() > 30000;
    try {
      return { enabled: true, ...(await certificates.get({ force })) };
    } catch (err) {
      console.error('[certificates]', err.message);
      const hint = err.status === 401 || err.status === 403 ? ' Check that the CPI service key may read the keystore.' : '';
      throw new HttpError(502, `Could not read certificates from CPI: ${err.message}.${hint}`);
    }
  }));

  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}

module.exports = { apiRouter, STATUSES };

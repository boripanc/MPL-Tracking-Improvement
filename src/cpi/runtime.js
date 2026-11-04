'use strict';

/*
 * Locks and Message queues menus. CPI design-time artifact locks (Monitor > Manage Design-Time Artifact Locks,
 * OData "IntegrationDesigntimeLocks") and JMS queues
 * (Monitor > Message Queues, OData "Queues", "JmsBrokers('Broker1')", "Queues('<name>')/Messages") are copied
 * into the database (tables cpi_designtime_locks, cpi_jms_queues, cpi_jms_messages, cpi_runtime_sync) by the n8n workflow
 * "CPI Locks & Queues → Postgres" or by this app's own sync. The web pages always read from the database.
 * This is read-only: unlocking an artifact or retrying a queued message is still done in CPI.
 */

const SQL = require('../sql');

const MAX_PAGES = 20;
const MAX_MESSAGES_PER_QUEUE = 1000;
const QUEUE_STATES = { 0: 'ok', 1: 'critical', 2: 'full' };
const QUEUE_ORDER = { full: 0, critical: 1, failed: 2, inactive: 3, waiting: 4, ok: 5, removed: 6 };

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

/** OData key literal: 'name' with single quotes doubled, URL-encoded. */
function key(name) {
  return encodeURIComponent(`'${String(name).replace(/'/g, "''")}'`);
}

/** Reads every page of an OData collection (raw records). Throws with err.status on HTTP errors. */
async function readAll(client, path, label) {
  const out = [];
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const d = await readJson(client, path, label);
    out.push(...(d.results || []));
    path = d.__next || null;
  }
  return out;
}

async function readJson(client, path, label) {
  const res = await client.request(path);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const hint = res.status === 403 ? ' (the service key may not read this; it needs the MonitoringDataRead role)' : '';
    const err = new Error(`CPI ${label} request failed: HTTP ${res.status}${hint}${detail ? ` ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (!/json/i.test(res.headers.get('content-type') || '')) {
    throw new Error('CPI did not return JSON. CPI_API_URL must be the tenant API address ending in /api/v1');
  }
  return (await res.json()).d || {};
}

/** Runs fn over items with at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Reads locks, the JMS broker, the queues (with the iFlows that use them) and the messages of non-empty queues.
 * A part that fails comes back as null plus an entry in `errors`, so one failing part does not stop the others.
 */
async function fetchRuntime(client, { concurrency = 5 } = {}) {
  const errors = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
  };
  const locks = await attempt('locks', () => readAll(client, '/IntegrationDesigntimeLocks', 'design-time locks'));
  // A tenant without JMS has no broker (404); that just means there are no queues.
  const broker = await attempt('broker', async () => {
    try {
      return await readJson(client, "/JmsBrokers('Broker1')", 'JMS broker');
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  });
  let queues = await attempt('queues', () => readAll(client, '/Queues', 'queues'));
  const messages = [];
  if (queues) {
    queues = await mapLimit(queues, concurrency, async (q) => {
      const arts = await attempt(`iFlows of queue ${q.Name}`, () => readAll(client, `/Queues(${key(q.Name)})/Artifacts`, 'queue iFlows'));
      return { ...q, Artifacts: arts ? arts.map((a) => ({ name: a.Name, id: a.Id, direction: a.Direction })) : undefined };
    });
    const busy = queues.filter((q) => Number(q.NumbOfMsgs) > 0);
    await mapLimit(busy, concurrency, async (q) => {
      const list = await attempt(`messages of queue ${q.Name}`,
        () => readAll(client, `/Queues(${key(q.Name)})/Messages?$top=${MAX_MESSAGES_PER_QUEUE}`, 'queue messages'));
      if (list) messages.push({ name: q.Name, messages: list.slice(0, MAX_MESSAGES_PER_QUEUE) });
    });
  }
  return { locks, broker, queues, messages, errors };
}

function lockFromRow(r, now, warnHours = 24) {
  const createdAt = iso(r.created_at);
  const ageMinutes = createdAt ? Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60000)) : null;
  let state = 'locked';
  if (r.released_at) state = 'released';
  else if (ageMinutes != null && ageMinutes >= warnHours * 60) state = 'old';
  return {
    id: r.resource_id,
    artifactId: r.artifact_id || '',
    artifactName: r.artifact_name || r.artifact_id || '',
    artifactType: r.artifact_type || '',
    packageId: r.package_id || '',
    packageName: r.package_name || r.package_id || '',
    lockedBy: r.created_by || '',
    createdAt,
    ageMinutes,
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    releasedAt: iso(r.released_at),
    state,
  };
}

function queueState(r) {
  if (r.removed_at) return 'removed';
  const s = QUEUE_STATES[r.state];
  if (s === 'full' || s === 'critical') return s;
  if (Number(r.failed) > 0) return 'failed';
  if (r.active === false) return 'inactive';
  if (Number(r.messages) > 0) return 'waiting';
  return 'ok';
}

function queueFromRow(r) {
  return {
    name: r.name,
    messages: num(r.messages),
    sizeBytes: num(r.size_bytes),
    fillGrade: num(r.fill_grade),
    queueType: num(r.queue_type),
    stateCode: num(r.state),
    active: r.active,
    exclusive: r.exclusive,
    failed: Number(r.failed || 0),
    oldest: iso(r.oldest),
    maxRetries: num(r.max_retries),
    iflows: (r.artifacts || []).map((a) => a.name).filter(Boolean),
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    removedAt: iso(r.removed_at),
    state: queueState(r),
  };
}

function brokerFromRaw(b) {
  if (!b) return null;
  const n = (v) => (v == null || v === '' ? null : Number(v));
  return {
    capacity: n(b.Capacity),
    maxCapacity: n(b.MaxCapacity),
    queues: n(b.QueueNumber),
    maxQueues: n(b.MaxQueueNumber),
    queuesOk: n(b.CapacityOk),
    queuesWarning: n(b.CapacityWarning),
    queuesError: n(b.CapacityError),
    warnings: [
      b.IsQueuesHigh ? 'Too many queues' : '',
      b.IsMessageSpoolHigh ? 'Message storage is nearly full' : '',
      b.IsConsumersHigh ? 'Too many consumers' : '',
      b.IsProducersHigh ? 'Too many producers' : '',
      b.IsTransactedSessionsHigh ? 'Too many transacted sessions' : '',
    ].filter(Boolean),
  };
}

const missingTables = 'The lock and queue tables do not exist yet. Run "npm run db:init" once, or run the n8n workflow "CPI Locks & Queues → Postgres", which creates them.';

/**
 * Store backed by PostgreSQL.
 *  - locks() / queues() / queue(name): read from the database
 *  - sync(): copy locks and queues from CPI into the database (only when `client` is given)
 */
function createRuntimeStore({ pool, client = null, staleMinutes = 60, lockWarnHours = 24, now = () => Date.now() }) {
  let syncing = null;

  async function query(sql, params) {
    try {
      const { rows: [{ result }] } = await pool.query(sql, [JSON.stringify(params)]);
      return result;
    } catch (err) {
      if (err.code === '42P01') return null;
      throw err;
    }
  }

  const syncInfo = (last, t) => ({
    lastSync: last ? { at: iso(last.synced_at), source: last.source } : null,
    stale: !last || t - Date.parse(last.synced_at) > staleMinutes * 60000,
    staleMinutes,
    canSync: Boolean(client),
  });

  async function locks({ releasedDays = 0 } = {}) {
    const data = await query(SQL.readLocks, { releasedDays });
    if (!data) return { enabled: false, reason: missingTables };
    const t = now();
    const items = data.items.map((r) => lockFromRow(r, t, lockWarnHours));
    const summary = { locked: 0, old: 0, released: 0, types: {}, people: {} };
    for (const l of items) {
      summary[l.state]++;
      if (l.state === 'released') continue;
      summary.types[l.artifactType || 'Other'] = (summary.types[l.artifactType || 'Other'] || 0) + 1;
      if (l.lockedBy) summary.people[l.lockedBy] = (summary.people[l.lockedBy] || 0) + 1;
    }
    return { enabled: true, ...syncInfo(data.lastSync, t), warnHours: lockWarnHours, summary, items };
  }

  async function queues({ includeRemoved = false } = {}) {
    const data = await query(SQL.readQueues, { includeRemoved });
    if (!data) return { enabled: false, reason: missingTables };
    const t = now();
    const items = data.items.map(queueFromRow)
      .sort((a, b) => QUEUE_ORDER[a.state] - QUEUE_ORDER[b.state] || (b.messages || 0) - (a.messages || 0) || a.name.localeCompare(b.name));
    const summary = { queues: 0, withMessages: 0, messages: 0, failed: 0, full: 0, critical: 0, inactive: 0 };
    for (const q of items) {
      if (q.removedAt) continue;
      summary.queues++;
      summary.messages += q.messages || 0;
      summary.failed += q.failed;
      if (q.messages > 0) summary.withMessages++;
      if (q.state === 'full') summary.full++;
      if (q.state === 'critical') summary.critical++;
      if (q.active === false) summary.inactive++;
    }
    const last = data.lastSync;
    return { enabled: true, ...syncInfo(last, t), broker: brokerFromRaw(last && last.broker), summary, items };
  }

  async function queue(name) {
    const data = await query(SQL.readQueue, { name });
    if (!data) return { enabled: false, reason: missingTables };
    if (!data.queue) return null;
    return {
      queue: queueFromRow({ ...data.queue, failed: data.messages.filter((m) => m.failed).length }),
      messages: data.messages.map((m) => ({
        msgid: m.msgid,
        failed: m.failed,
        mplId: m.mpl_id || '',
        hasMpl: m.has_mpl,
        flow: m.flow || '',
        mplStatus: m.mpl_status || '',
        createdAt: iso(m.created_at),
        retryCount: num(m.retry_count),
        nextRetry: iso(m.next_retry),
        overdueAt: iso(m.overdue_at),
        expiresAt: iso(m.expires_at),
        sender: m.sender || '',
        receiver: m.receiver || '',
        messageType: m.message_type || '',
        applicationId: m.application_id || '',
        correlationId: m.correlation_id || '',
        customStatus: m.custom_status || '',
      })),
    };
  }

  async function sync({ source = 'app' } = {}) {
    if (!client) throw new Error('This server has no CPI connection configured, so it cannot sync. The n8n workflow keeps the data up to date.');
    if (!syncing) {
      syncing = (async () => {
        const r = await fetchRuntime(client);
        if (!r.locks && !r.queues) throw new Error(r.errors.join('; '));
        const { rows: [row] } = await pool.query(SQL.syncRuntime, [JSON.stringify({ source, locks: r.locks, broker: r.broker, queues: r.queues })]);
        if (r.messages.length) await pool.query(SQL.syncQueueMessages, [JSON.stringify({ queues: r.messages })]);
        const s = row.result || {};
        return { locks: s.locks || 0, locksReleased: s.locks_released || 0, queues: s.queues || 0, messages: Number(s.messages || 0), errors: r.errors };
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  return { locks, queues, queue, sync, canSync: Boolean(client) };
}

/** Runs sync() now and then every `intervalMinutes`, without overlapping. Returns { stop }. */
function startRuntimeSync({ store, intervalMinutes, logger = console }) {
  const tick = async () => {
    try {
      const r = await store.sync({ source: 'app' });
      logger.log(`[locks/queues] synced ${r.locks} design-time locks and ${r.queues} queues (${r.messages} messages) from CPI`
        + (r.errors.length ? `; problems: ${r.errors.join('; ')}` : ''));
    } catch (err) {
      logger.error('[locks/queues] sync failed:', err.message);
    }
  };
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, intervalMinutes * 60000);
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { createRuntimeStore, startRuntimeSync, fetchRuntime, lockFromRow, queueFromRow, queueState, brokerFromRaw, key };

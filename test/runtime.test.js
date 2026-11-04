'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupDatabase, startApp } = require('./helpers');
const SQL = require('../src/sql');
const { queueState, key } = require('../src/cpi/runtime');

const MIN = 60000;

// Field names and formats as returned by the real tenant (numbers as strings, times in epoch milliseconds).
// IntegrationDesigntimeLocks record as documented in the tenant's $metadata (CreatedAt is Edm.DateTime).
function lock(name, { type = 'IFlow', pkg = 'TUIP Interfaces', by = 'alice@example.com', ageMin = 10 } = {}) {
  return {
    __metadata: { type: 'com.sap.hci.api.IntegrationDesigntimeLock' },
    ResourceId: 'res-' + name, ArtifactId: name, ArtifactName: name.replace(/_/g, ' '), ArtifactType: type,
    PackageId: pkg.replace(/ /g, ''), PackageName: pkg, CreatedAt: `/Date(${Date.now() - ageMin * MIN})/`, CreatedBy: by,
  };
}

function queue(name, msgs = 0, extra = {}) {
  return {
    __metadata: { type: 'com.sap.hci.api.Queue' }, Name: name, NumbOfMsgs: String(msgs), Size: String(msgs * 2048),
    Type: '0', State: '0', FillGrade: '0', Active: '1', Exclusive: '0', Messages: { __deferred: {} }, ...extra,
  };
}

function jmsMessage(id, { failed = false, mpl = '', retries = 0 } = {}) {
  return {
    __metadata: { type: 'com.sap.hci.api.JmsMessage' }, Msgid: id, Name: 'Q', Failed: failed, Mplid: mpl,
    CreatedAt: String(Date.now() - 30 * MIN), RetryCount: String(retries), NextRetry: failed ? '0' : String(Date.now() + MIN),
    OverdueAt: '0', ExpirationDate: String(Date.now() + 90 * 86400000), SapSender: 'S4', SapReceiver: 'UBER',
    SapMsgType: 'EDI940', SapApplicationId: 'APP-1', SapMplCorrelationId: 'COR-1', SapMessageProcessingLogCustomStatus: '',
  };
}

const BROKER = {
  __metadata: {}, Key: 'Broker1', Capacity: '1048576', MaxCapacity: '31457280000', IsTransactedSessionsHigh: 0, IsConsumersHigh: 0,
  IsProducersHigh: 0, MaxQueueNumber: '100', QueueNumber: '3', CapacityOk: '3', CapacityWarning: '0', CapacityError: '0',
  IsQueuesHigh: 0, IsMessageSpoolHigh: 1, QueueStates: { __deferred: {} },
};

function fakeCpi(state) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (d, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(d)); };
    if (url.pathname === '/oauth/token') return send({ access_token: 'tok', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
    const p = decodeURIComponent(url.pathname.replace('/api/v1', ''));
    seen.push(p);
    if (p === '/IntegrationDesigntimeLocks') return state.locksFail ? send({ error: 'x' }, 500) : send({ d: { results: state.locks } });
    if (p === "/JmsBrokers('Broker1')") return send({ d: BROKER });
    if (p === '/Queues') return send({ d: { results: state.queues } });
    let m = /^\/Queues\('(.+)'\)\/(Artifacts|Messages)$/.exec(p);
    if (m) {
      const name = m[1].replace(/''/g, "'");
      if (m[2] === 'Artifacts') return send({ d: { results: [{ Name: `IF_${name}`, Id: 'x', Direction: '2' }] } });
      return send({ d: { results: state.messages[name] || [] } });
    }
    send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

const cpiEnv = (port) => ({
  CPI_API_URL: `http://127.0.0.1:${port}/api/v1`, CPI_TOKEN_URL: `http://127.0.0.1:${port}/oauth/token`,
  CPI_CLIENT_ID: 'id', CPI_CLIENT_SECRET: 'secret',
});

let db;
test.before(async () => { db = await setupDatabase({ seed: false }); });
test.after(async () => { await db.teardown(); });

test('queueState and key', () => {
  assert.equal(queueState({ state: 2, messages: 0 }), 'full');
  assert.equal(queueState({ state: 1 }), 'critical');
  assert.equal(queueState({ state: 0, failed: 2, messages: 2 }), 'failed');
  assert.equal(queueState({ state: 0, active: false }), 'inactive');
  assert.equal(queueState({ state: 0, messages: 5, active: true }), 'waiting');
  assert.equal(queueState({ state: 0, messages: 0, active: true }), 'ok');
  assert.equal(queueState({ removed_at: new Date() }), 'removed');
  assert.equal(key("A'B C"), encodeURIComponent("'A''B C'"));
});

test('pages say the tables are missing before the first sync', async () => {
  const empty = await setupDatabase({ seed: false });
  await empty.pool.query('DROP TABLE cpi_designtime_locks, cpi_jms_queues, cpi_jms_messages, cpi_runtime_sync');
  const app = await startApp(empty.pool);
  try {
    const r = await app.call('GET', '/api/locks');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.match(r.body.reason, /CPI Locks & Queues/);
    assert.equal((await app.call('GET', '/api/queues')).body.enabled, false);
    assert.equal((await app.call('POST', '/api/runtime/sync')).status, 409);
  } finally {
    await app.close();
    await empty.teardown();
  }
});

test('the n8n statements store locks, queues and messages; released locks and emptied queues are tracked', async () => {
  const run = async (payload) => (await db.pool.query(SQL.syncRuntime, [JSON.stringify(payload)])).rows[0];
  let r = await run({
    source: 'n8n',
    locks: [lock('IF_A'), lock('IF_B', { ageMin: 26 * 60, by: 'bob@example.com' }), lock('VM_1', { type: 'ValueMapping' })],
    broker: BROKER,
    queues: [{ ...queue('Q1', 2), Artifacts: [{ name: 'IF_A', id: '1', direction: '2' }] }, queue('Q2'), queue('Q3', 0, { State: '2' })],
  });
  assert.equal(r.result.locks, 3);
  assert.equal(r.result.queues, 3);
  assert.equal(Number(r.result.messages), 2);

  let m = (await db.pool.query(SQL.syncQueueMessages, [JSON.stringify({ queues: [{ name: 'Q1', messages: [jmsMessage('m1', { failed: true, mpl: 'G1', retries: 4 }), jmsMessage('m2')] }] })])).rows[0].result;
  assert.deepEqual(m, { queues: 1, messages: 2, removed: 0 });

  const app = await startApp(db.pool);
  try {
    let locks = (await app.call('GET', '/api/locks')).body;
    assert.equal(locks.enabled, true);
    assert.equal(locks.lastSync.source, 'n8n');
    assert.equal(locks.warnHours, 24);
    assert.equal(locks.summary.locked, 2);
    assert.equal(locks.summary.old, 1, 'the artifact locked 26 hours ago is flagged');
    assert.deepEqual(locks.summary.types, { IFlow: 2, ValueMapping: 1 });
    assert.deepEqual(locks.summary.people, { 'alice@example.com': 2, 'bob@example.com': 1 });
    const a = locks.items.find((l) => l.artifactId === 'IF_A');
    assert.equal(a.artifactName, 'IF A');
    assert.equal(a.packageName, 'TUIP Interfaces');
    assert.equal(a.lockedBy, 'alice@example.com');
    assert.equal(a.state, 'locked');
    assert.ok(a.ageMinutes >= 9 && a.ageMinutes <= 11);

    let qs = (await app.call('GET', '/api/queues')).body;
    assert.equal(qs.summary.queues, 3);
    assert.equal(qs.summary.messages, 2);
    assert.equal(qs.summary.failed, 1);
    assert.equal(qs.summary.full, 1);
    assert.deepEqual(qs.items.map((q) => [q.name, q.state]), [['Q3', 'full'], ['Q1', 'failed'], ['Q2', 'ok']]);
    assert.deepEqual(qs.items[1].iflows, ['IF_A']);
    assert.equal(qs.broker.maxQueues, 100);
    assert.deepEqual(qs.broker.warnings, ['Message storage is nearly full']);

    const detail = (await app.call('GET', '/api/queues/Q1')).body;
    assert.equal(detail.messages.length, 2);
    const failed = detail.messages.find((x) => x.failed);
    assert.equal(failed.mplId, 'G1');
    assert.equal(failed.retryCount, 4);
    assert.equal(failed.nextRetry, null, 'NextRetry 0 means none');
    assert.equal(failed.messageType, 'EDI940');
    assert.equal((await app.call('GET', '/api/queues/NOPE')).status, 404);

    // Next run: one lock gone, Q1 emptied, Q2 removed. CPI not answering for locks would leave them alone.
    await run({ source: 'n8n', locks: [lock('IF_A')], queues: [queue('Q1'), queue('Q3')] });
    locks = (await app.call('GET', '/api/locks')).body;
    assert.equal(locks.items.length, 1);
    locks = (await app.call('GET', '/api/locks?released=7')).body;
    assert.equal(locks.summary.released, 2);
    qs = (await app.call('GET', '/api/queues')).body;
    assert.deepEqual(qs.items.map((q) => q.name).sort(), ['Q1', 'Q3']);
    assert.equal(qs.summary.failed, 0, 'messages of an emptied queue are dropped');
    assert.equal(qs.items.find((q) => q.name === 'Q1').iflows[0], 'IF_A', 'iFlows are kept when a run does not read them');
    assert.equal((await app.call('GET', '/api/queues?removed=1')).body.items.length, 3);

    r = await run({ source: 'n8n', locks: null, queues: null });
    assert.equal(r.result, null, 'nothing is logged when CPI answered neither');
    assert.equal((await app.call('GET', '/api/locks')).body.items.length, 1);
  } finally {
    await app.close();
  }
});

test('the app syncs locks, queues and messages from CPI itself when it has a CPI connection', async () => {
  const fresh = await setupDatabase({ seed: false });
  const state = {
    locks: [lock('IF_X'), lock('IF_Y')],
    queues: [queue("Q'ONE", 1), queue('Q_TWO')],
    messages: { "Q'ONE": [jmsMessage('mx', { failed: true })] },
  };
  const cpi = await fakeCpi(state);
  const app = await startApp(fresh.pool, cpiEnv(cpi.port));
  try {
    const s = await app.call('POST', '/api/runtime/sync');
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(s.body, { locks: 2, locksReleased: 0, queues: 2, messages: 1, errors: [] });
    assert.ok(!cpi.seen.includes("/Queues('Q_TWO')/Messages"), 'empty queues are not asked for messages');
    const qs = (await app.call('GET', '/api/queues')).body;
    assert.equal(qs.canSync, true);
    assert.equal(qs.lastSync.source, 'app');
    assert.equal(qs.items[0].name, "Q'ONE");
    assert.equal(qs.items[0].failed, 1);
    assert.deepEqual(qs.items[0].iflows, ["IF_Q'ONE"]);
    assert.equal((await app.call('GET', `/api/queues/${encodeURIComponent("Q'ONE")}`)).body.messages[0].msgid, 'mx');

    // Locks fail this time: queues are still synced and the stored locks are kept.
    state.locksFail = true;
    state.queues = [queue('Q_TWO')];
    const s2 = await app.call('POST', '/api/runtime/sync');
    assert.equal(s2.status, 200);
    assert.match(s2.body.errors[0], /^locks: CPI design-time locks request failed: HTTP 500/);
    assert.equal((await app.call('GET', '/api/locks')).body.items.length, 2);
    assert.equal((await app.call('GET', '/api/queues')).body.items.length, 1);
  } finally {
    await app.close();
    cpi.server.close();
    await fresh.teardown();
  }
});

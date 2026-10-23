'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupDatabase } = require('./helpers');
const { pollOnce, toRow, buildFilter } = require('../src/poller/cpi');

function mpl(guid, status, minutesAgo) {
  const t = Date.now() - minutesAgo * 60000;
  return {
    __metadata: { type: 'com.sap.hci.api.MessageProcessingLog' },
    MessageGuid: guid, CorrelationId: 'C-' + guid, IntegrationFlowName: 'FLOW_A', Status: status, CustomStatus: status,
    LogStart: `/Date(${t})/`, LogEnd: `/Date(${t + 5000})/`, TransactionId: 'tx',
    IntegrationArtifact: { __metadata: { type: 'x' }, Id: 'FLOW_A', Name: 'FLOW_A', PackageName: 'PKG' },
    AlternateWebLink: 'https://cpi.example/' + guid,
  };
}

function fakeCpi({ records, errorText }) {
  const seen = { token: 0, pages: [], errorText: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/oauth/token') {
      seen.token++;
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('id:secret').toString('base64'));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end(); }
    if (url.pathname === '/api/v1/MessageProcessingLogs') {
      const top = Number(url.searchParams.get('$top'));
      const skip = Number(url.searchParams.get('$skip'));
      seen.pages.push({ skip, filter: url.searchParams.get('$filter') });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ d: { results: records.slice(skip, skip + top) } }));
    }
    const m = /^\/api\/v1\/MessageProcessingLogs\('(.+)'\)\/ErrorInformation\/\$value$/.exec(decodeURIComponent(url.pathname));
    if (m) {
      seen.errorText.push(m[1]);
      const t = errorText[m[1]];
      if (t === undefined) { res.statusCode = 404; return res.end(); }
      return res.end(t);
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('toRow converts OData dates and drops __metadata', () => {
  const row = toRow(mpl('G1', 'FAILED', 0));
  assert.match(row.log_start, /^\d{4}-\d\d-\d\dT/);
  assert.equal(row.artifact_details.PackageName, 'PKG');
  assert.equal(row.artifact_details.__metadata, undefined);
  assert.equal(row.raw.__metadata, undefined);
  assert.equal(row.raw.AlternateWebLink, 'https://cpi.example/G1');
});

test('buildFilter combines statuses and the look-back time', () => {
  const f = buildFilter(['FAILED', 'RETRY'], new Date('2026-01-02T03:04:05.678Z'));
  assert.equal(f, "(Status eq 'FAILED' or Status eq 'RETRY') and LogStart gt datetime'2026-01-02T03:04:05'");
});

test('pollOnce pages through CPI, stores MPLs and error texts, and skips known texts next time', async () => {
  const db = await setupDatabase({ seed: false });
  const records = [];
  for (let i = 0; i < 7; i++) records.push(mpl(`P-${i}`, i % 2 ? 'ESCALATED' : 'FAILED', i * 10));
  const errorText = { 'P-0': 'java.net.SocketTimeoutException: Read timed out', 'P-1': '  ', 'P-2': 'Mapping failed' };
  const cpi = await fakeCpi({ records, errorText });
  const config = {
    apiUrl: `http://127.0.0.1:${cpi.port}/api/v1`, tokenUrl: `http://127.0.0.1:${cpi.port}/oauth/token`,
    clientId: 'id', clientSecret: 'secret', lookbackHours: 24, statuses: ['FAILED', 'ESCALATED'],
    pageSize: 3, maxPages: 10, concurrency: 2, requestTimeoutMs: 5000,
  };
  try {
    const r1 = await pollOnce({ pool: db.pool, config });
    assert.deepEqual(r1, { mpls: 7, errorTexts: 7, withText: 2 });
    assert.deepEqual(cpi.seen.pages.map((p) => p.skip), [0, 3, 6]);
    assert.match(cpi.seen.pages[0].filter, /Status eq 'FAILED' or Status eq 'ESCALATED'/);
    assert.equal(cpi.seen.token, 1, 'token is reused');

    const { rows } = await db.pool.query(
      "SELECT m.message_guid, m.artifact_details->>'PackageName' AS pkg, e.hasvalue, e.errormsg FROM message_processing_logs m JOIN error_information e USING (message_guid) ORDER BY 1");
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[0], { message_guid: 'P-0', pkg: 'PKG', hasvalue: true, errormsg: 'java.net.SocketTimeoutException: Read timed out' });
    assert.equal(rows[1].hasvalue, false, 'whitespace-only text counts as no text');

    cpi.seen.errorText.length = 0;
    const r2 = await pollOnce({ pool: db.pool, config });
    assert.equal(r2.mpls, 7);
    assert.equal(r2.errorTexts, 5, 'messages that already have error text are not fetched again');
    assert.ok(!cpi.seen.errorText.includes('P-0'));
    const count = await db.pool.query('SELECT count(*)::int AS n FROM message_processing_logs');
    assert.equal(count.rows[0].n, 7, 'no duplicates');
  } finally {
    cpi.server.close();
    await db.teardown();
  }
});

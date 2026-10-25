'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupDatabase, startApp } = require('./helpers');

let db;
let api;

test.before(async () => {
  db = await setupDatabase();
  api = await startApp(db.pool);
});
test.after(async () => {
  await api.close();
  await db.teardown();
});

test('requires login for the app and the API, but not for /healthz', async () => {
  // The page sends the browser to the login form; the API answers 401. The browser is never asked for Basic
  // credentials (no WWW-Authenticate), so it cannot keep them after "Sign out".
  for (const [url, to] of [['/?tab=errors', '/login?next=%2F%3Ftab%3Derrors'], ['/app.js', '/login?next=%2Fapp.js']]) {
    const page = await fetch(api.base + url, { redirect: 'manual' });
    assert.equal(page.status, 303, url);
    assert.equal(page.headers.get('location'), to);
    assert.equal(page.headers.get('www-authenticate'), null);
  }
  const apiCall = await api.call('GET', '/api/meta', undefined, { Authorization: '' });
  assert.equal(apiCall.status, 401);
  assert.equal(apiCall.headers.get('www-authenticate'), null);
  assert.equal((await api.call('POST', '/api/known-errors', {}, { Authorization: '' })).status, 401);
  const wrong = await api.call('GET', '/api/meta', undefined, { Authorization: 'Basic ' + Buffer.from('alice:nope').toString('base64') });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.login, true);
  // Scripts can still send Basic credentials.
  assert.equal((await api.call('GET', '/api/meta')).body.user, 'alice');
  const health = await api.call('GET', '/healthz', undefined, { Authorization: '' });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

// Browser-like client: no Basic header, keeps the session cookie.
function browser(base) {
  let cookie = '';
  async function go(method, url, { form, json } = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}) };
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      cookie = /max-age=0/i.test(attrs.join(';')) ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, setCookie: res.headers.getSetCookie() };
  }
  return { go, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

test('login page: sign in, use the app, sign out', async () => {
  const b = browser(api.base);
  const form = await b.go('GET', '/login?next=%2F%3Ftab%3Dcerts');
  assert.equal(form.status, 200);
  assert.match(form.text, /<form method="post" action="\/login">/);
  assert.match(form.text, /value="\/\?tab=certs"/);
  assert.equal((await b.go('GET', '/styles.css')).status, 200, 'the login page can load its styles');

  const bad = await b.go('POST', '/login', { form: { user: 'alice', password: 'nope', next: '/' } });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Wrong user or password/);
  assert.equal(b.cookie, '');

  const ok = await b.go('POST', '/login', { form: { user: 'alice', password: 'wonderland', next: '/?tab=certs' } });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/?tab=certs');
  assert.match(ok.setCookie[0], /HttpOnly; SameSite=Lax/);
  assert.equal((await b.go('GET', '/')).status, 200);
  const meta = await b.go('GET', '/api/meta');
  assert.equal(JSON.parse(meta.text).user, 'alice');
  assert.equal((await b.go('GET', '/login')).location, '/', 'signed in: the login page goes to the app');

  // A tampered cookie is refused.
  const good = b.cookie;
  b.cookie = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await b.go('GET', '/api/meta')).status, 401);
  b.cookie = good;

  // GET /logout does nothing (no sign-out from a link on another site); POST signs out.
  assert.equal((await b.go('GET', '/logout')).location, '/');
  assert.equal((await b.go('GET', '/api/meta')).status, 200);
  const out = await b.go('POST', '/logout');
  assert.equal(out.location, '/login?out=1');
  assert.equal(b.cookie, '');
  assert.equal((await b.go('GET', '/api/meta')).status, 401);
});

test('login: never sends the browser to another site after signing in', async () => {
  const b = browser(api.base);
  for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/login']) {
    const r = await b.go('POST', '/login', { form: { user: 'alice', password: 'wonderland', next } });
    assert.equal(r.location, '/', next);
  }
});

test('sessions end after the idle time, and when the password changes', async () => {
  const app = await startApp(db.pool, { SESSION_SECRET: 's3cret', SESSION_IDLE_MINUTES: '1' });
  try {
    const b = browser(app.base);
    await b.go('POST', '/login', { form: { user: 'alice', password: 'wonderland' } });
    assert.equal((await b.go('GET', '/api/meta')).status, 200);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60 * 1000;
      const late = await b.go('GET', '/?tab=errors');
      assert.equal(late.status, 303);
      assert.match(late.location, /^\/login\?next=.*&expired=1$/);
    } finally {
      Date.now = realNow;
    }

    // Same secret, new password: the old session is refused.
    await b.go('POST', '/login', { form: { user: 'alice', password: 'wonderland' } });
    const kept = b.cookie;
    const changed = await startApp(db.pool, { SESSION_SECRET: 's3cret', APP_USERS: 'alice:new-password' });
    try {
      const c = browser(changed.base);
      c.cookie = kept;
      assert.equal((await c.go('GET', '/api/meta')).status, 401);
    } finally {
      await changed.close();
    }
  } finally {
    await app.close();
  }
});

test('too many wrong passwords block the sign-in for a while', async () => {
  const app = await startApp(db.pool);
  try {
    const b = browser(app.base);
    for (let i = 0; i < 10; i += 1) await b.go('POST', '/login', { form: { user: 'alice', password: 'x' } });
    const blocked = await b.go('POST', '/login', { form: { user: 'alice', password: 'wonderland' } });
    assert.equal(blocked.status, 429);
  } finally {
    await app.close();
  }
});

test('serves the page, script, styles and Chart.js', async () => {
  const page = await api.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /CPI Error Center/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  for (const url of ['/app.js', '/styles.css', '/vendor/chart.umd.js']) assert.equal((await api.call('GET', url)).status, 200, url);
});

test('page, script and styles are re-validated on every load and use versioned links', async () => {
  const page = await api.call('GET', '/');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const js = /src="(app[.]js[?]v=[^"]+)"/.exec(page.text);
  const css = /href="(styles[.]css[?]v=[^"]+)"/.exec(page.text);
  assert.ok(js && css, 'script and stylesheet links carry a version');
  for (const url of ['/' + js[1], '/' + css[1], '/app.js']) {
    const r = await api.call('GET', url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get('cache-control'), 'no-cache', url);
  }
  assert.equal((await api.call('GET', '/index.html')).headers.get('cache-control'), 'no-cache');
});

test('dashboard summarises the last 7 days with categories and known errors', async () => {
  const r = await api.call('GET', '/api/dashboard?tz=Asia/Bangkok');
  assert.equal(r.status, 200);
  const d = r.body;
  assert.equal(d.kpi.total, 9); // MPL-0009 is older than 7 days
  assert.equal(d.kpi.known, 2); // MPL-0001 (ea 1) and MPL-0005 (ea 2)
  assert.equal(d.kpi.categorized, 4);
  assert.equal(d.range.unit, 'day');
  const unc = d.byCategory.find((c) => c.name === 'Uncategorized');
  assert.equal(unc.n, 5);
  const edi = d.topUnknown.find((u) => u.flow === 'Common_Outbound_Acknowledgement_EDI997');
  assert.equal(edi.n, 2, 'identical errors are grouped into one pattern');
  assert.ok(d.openIssues.some((o) => o.ea_id === 1 && o.n === 1));

  const last24h = await api.call('GET', `/api/dashboard?from=${new Date(Date.now() - 86400000).toISOString()}`);
  assert.equal(last24h.body.range.unit, 'hour');
  assert.equal(last24h.body.kpi.total, 7); // MPL-0007 (25 h) and older fall outside
});

test('errors list supports filters and paging', async () => {
  const all = await api.call('GET', '/api/errors?limit=3');
  assert.equal(all.body.total, 9);
  assert.equal(all.body.rows.length, 3);
  assert.equal(all.body.rows[0].message_guid, 'MPL-0001', 'newest first');

  const page2 = await api.call('GET', '/api/errors?limit=3&offset=3');
  assert.notEqual(page2.body.rows[0].message_guid, all.body.rows[0].message_guid);

  assert.equal((await api.call('GET', '/api/errors?analysis=__none')).body.total, 7);
  assert.equal((await api.call('GET', '/api/errors?analysis=__known')).body.total, 2);
  assert.equal((await api.call('GET', '/api/errors?category=__none')).body.total, 5);
  assert.equal((await api.call('GET', '/api/errors?status=ESCALATED')).body.total, 2);
  assert.equal((await api.call('GET', '/api/errors?q=partneridhash')).body.total, 2, 'search is case-insensitive');
  assert.equal((await api.call('GET', '/api/errors?flow=EPP_COMB2')).body.total, 1);
});

test('rejects invalid query parameters with 400', async () => {
  for (const url of ['/api/errors?limit=0', '/api/errors?status=DONE', '/api/errors?category=abc', '/api/dashboard?tz=Nowhere/City', '/api/dashboard?from=yesterday']) {
    const r = await api.call('GET', url);
    assert.equal(r.status, 400, url);
    assert.ok(r.body.error);
  }
});

test('error detail includes category, known error, attributes and related messages', async () => {
  const r = await api.call('GET', '/api/errors/MPL-0001');
  assert.equal(r.status, 200);
  assert.equal(r.body.mpl.flow, 'INT406_TUE_IOT_COMB');
  assert.equal(r.body.category.category_name, 'Process Corrupted');
  assert.equal(r.body.analysis.ea_id, 1);
  assert.equal(r.body.analysis.comments.length, 1);
  assert.equal(r.body.attributes.length, 2);
  assert.deepEqual(r.body.related.map((x) => x.message_guid), ['MPL-0002']);
  assert.match(r.body.mpl.link, /^https:/);
  assert.equal((await api.call('GET', '/api/errors/does-not-exist')).status, 404);
});

test('known errors: create, match, comment, change status, delete', async () => {
  const bad = await api.call('POST', '/api/known-errors', { errormessage: 'short' });
  assert.equal(bad.status, 400);
  const badStatus = await api.call('POST', '/api/known-errors', { errormessage: 'Invalid xpath: /BusinessTransactionActivity', status: 'Done' });
  assert.equal(badStatus.status, 400);

  const created = await api.call('POST', '/api/known-errors', {
    errormessage: 'Invalid xpath: /BusinessTransactionActivity/PartnerIDHash',
    integration_flow_name: 'Common_Outbound_Acknowledgement_EDI997',
    rootcause: 'Partner sends a non-XML payload',
  });
  assert.equal(created.status, 201);
  const eaId = created.body.ea_id;
  assert.equal(created.body.status, 'Open');

  const errors = await api.call('GET', '/api/errors?analysis=__known');
  assert.equal(errors.body.total, 4, 'the two EDI997 errors now match the new known error');

  const comment = await api.call('POST', `/api/known-errors/${eaId}/comments`, { comment: 'Asked the partner to fix it' });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.comment, 'Asked the partner to fix it');
  assert.equal((await api.call('POST', `/api/known-errors/${eaId}/comments`, { comment: '  ' })).status, 400);
  assert.equal((await api.call('POST', '/api/known-errors/99999/comments', { comment: 'x' })).status, 404);

  const updated = await api.call('PUT', `/api/known-errors/${eaId}`, {
    errormessage: 'Invalid xpath: /BusinessTransactionActivity/PartnerIDHash',
    integration_flow_name: 'Common_Outbound_Acknowledgement_EDI997',
    rootcause: 'Partner sends a non-XML payload',
    solutions: 'Partner fixed their mapping',
    status: 'Resolved',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'Resolved');

  const list = await api.call('GET', '/api/known-errors');
  const mine = list.body.find((k) => k.ea_id === eaId);
  assert.equal(mine.n, 2);
  assert.deepEqual(mine.comments.map((c) => c.comment), ['Asked the partner to fix it', 'Status changed from Open to Resolved by alice']);

  assert.equal((await api.call('PUT', '/api/known-errors/99999', { errormessage: 'something long enough' })).status, 404);
  assert.equal((await api.call('DELETE', `/api/known-errors/${eaId}`)).status, 200);
  assert.equal((await api.call('DELETE', `/api/known-errors/${eaId}`)).status, 404);
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM error_analyzed_comments WHERE ea_id = $1', [eaId]);
  assert.equal(rows[0].n, 0, 'comments are deleted with the known error');
});

test('categories: invalid regex is rejected, create/update/delete work', async () => {
  const bad = await api.call('POST', '/api/categories', { category_name: 'Broken', category_expression: 'abc((' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Invalid regular expression/);
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM error_category WHERE category_name = 'Broken'");
  assert.equal(rows[0].n, 0, 'nothing is saved when the regex is invalid');

  assert.equal((await api.call('POST', '/api/categories', { category_name: 'No regex' })).status, 400);

  const created = await api.call('POST', '/api/categories', { category_name: 'Invalid XML', category_expression: 'InvalidXPathException' });
  assert.equal(created.status, 201);
  const id = created.body.error_id;
  const cats = await api.call('GET', '/api/categories');
  assert.equal(cats.body.rows.find((c) => c.error_id === id).n, 2);
  assert.equal(cats.body.uncategorized, 3);

  const scoped = await api.call('PUT', `/api/categories/${id}`, { category_name: 'Invalid XML', category_expression: 'InvalidXPathException', integration_flow_name: 'EPP_COMB2' });
  assert.equal(scoped.status, 200);
  assert.equal((await api.call('GET', '/api/categories')).body.rows.find((c) => c.error_id === id).n, 0, 'scoped to another iFlow, so no matches');

  assert.equal((await api.call('DELETE', `/api/categories/${id}`)).status, 200);
  assert.equal((await api.call('DELETE', `/api/categories/${id}`)).status, 404);
});

test('test-match counts matches over the last 30 days', async () => {
  const like = await api.call('POST', '/api/test-match', { kind: 'like', pattern: 'No consumers available on endpoint' });
  assert.equal(like.status, 200);
  assert.equal(like.body.n, 2);
  assert.equal(like.body.of, 10); // all sample messages with an error_information row in 30 days
  const regex = await api.call('POST', '/api/test-match', { kind: 'regex', pattern: 'timeoutexception', flow: 'INT401_TUE_IOT_MWW_To_S4HANA_Notification_Creation_Inbound' });
  assert.equal(regex.body.n, 1);
  assert.equal((await api.call('POST', '/api/test-match', { kind: 'regex', pattern: '([' })).status, 400);
  assert.equal((await api.call('POST', '/api/test-match', { kind: 'sql', pattern: 'x' })).status, 400);
});

test('unknown API routes return JSON 404 and bad JSON returns 400', async () => {
  const r = await api.call('GET', '/api/nothing');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Not found');
  const res = await fetch(api.base + '/api/categories', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from('alice:wonderland').toString('base64'), 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

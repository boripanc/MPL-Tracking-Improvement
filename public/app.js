'use strict';

var STATUSES = ['Open', 'In Progress', 'Monitoring', 'Resolved'];
var NL = String.fromCharCode(10);
var S = { tab: 'dash', meta: { flows: [], categories: [], analyses: [] }, ef: blankFilter(), kst: '', charts: {}, cache: {} };

function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(n) { return Number(n || 0).toLocaleString(); }
function pct(a, b) { return b ? Math.round(a * 100 / b) + '%' : '–'; }
function dt(s) { return s ? new Date(s).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''; }
function dtFull(s) { return s ? new Date(s).toLocaleString() : ''; }
function short(s, n) { s = s || ''; return s.length > n ? s.slice(0, n) + '…' : s; }
function pill(s, cls) { return '<span class="pill ' + esc(cls || String(s || 'none').replace(/ /g, '')) + '">' + esc(s || 'None') + '</span>'; }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function blankFilter(o) { return Object.assign({ flow: '', status: '', category: '', analysis: '', q: '', offset: 0 }, o || {}); }
function opts(list, sel) { return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(sel) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }

function rangeParams() {
  var h = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[$('#range').value] || 168;
  var tz = 'Asia/Bangkok';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) {}
  return { from: new Date(Date.now() - h * 3600000).toISOString(), to: new Date(Date.now() + 60000).toISOString(), tz: tz };
}
function request(method, path, body) {
  var opts = { method: method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var e = new Error(j.error || ('Server returned HTTP ' + r.status)); e.connect = !!j.connect; throw e; }
      return j;
    });
  });
}
function get(path, params) {
  var qs = new URLSearchParams();
  Object.keys(params || {}).forEach(function (k) { var v = params[k]; if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
  var s = qs.toString();
  return request('GET', path + (s ? '?' + s : ''));
}
function withRange(params) { return Object.assign(rangeParams(), params || {}); }
var toastTimer;
function toast(m, bad) { var t = $('#toast'); t.textContent = m; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, bad ? 7000 : 2500); }
function fail(e) { toast((e && e.message) || String(e), true); }

function show(tab) {
  S.tab = tab;
  $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === tab); });
  ['dash', 'errors', 'known', 'cats', 'tickets', 'certs'].forEach(function (t) { $('#v-' + t).hidden = t !== tab; });
  syncRangeVisibility();
  window.scrollTo(0, 0);
  return load();
}
function load() {
  var loaders = { dash: loadDash, errors: loadErrors, known: loadKnown, cats: loadCats, tickets: loadTickets, certs: loadCerts };
  if (!loaders[S.tab]) return show('dash'); // unknown menu: fall back to the dashboard instead of failing
  return loaders[S.tab]().catch(fail);
}
function loadMeta() {
  return get('api/meta').then(function (m) {
    S.meta = m;
    $('#polled').textContent = m.lastPolled ? 'Data polled ' + dt(m.lastPolled) : '';
    $('#tabs button[data-t="certs"]').hidden = false;
    if (!S.cache.certs) {
      // Fill the menu badge in the background (from the database); problems are shown on the Certificates screen.
      get('api/certificates').then(function (d) { if (d.enabled) { S.cache.certs = d; setCertBadge(d.summary); } }).catch(function () {});
    }
    if (S.tab !== 'tickets') get('api/tickets/pulse', rangeParams()).then(setTicketBadge).catch(function () {});
  });
}
function refreshAll() {
  S.cache.known = null;
  if (S.tab === 'certs') return loadCerts().catch(fail);
  return loadMeta().then(load).catch(fail);
}

/* ---------- Dashboard ---------- */
function kpi(l, v, s, cls) { return '<div class="card kpi ' + (cls || '') + '"><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div><div class="s">' + esc(s || '') + '</div></div>'; }
function loadDash() {
  var v = $('#v-dash');
  if (!v.innerHTML) v.innerHTML = '<div class="empty">Loading…</div>';
  return get('api/dashboard', withRange()).then(function (d) {
    var k = d.kpi;
    v.innerHTML =
      '<div class="grid kpis">' +
        kpi('Errors', fmt(k.total), fmt(k.failed) + ' failed · ' + fmt(k.escalated) + ' escalated' + (k.retry ? ' · ' + fmt(k.retry) + ' retry' : '')) +
        kpi('Business messages', fmt(k.correlations), 'unique correlation IDs') +
        kpi('Affected iFlows', fmt(k.flows), 'with at least one error') +
        kpi('Categorized', pct(k.categorized, k.total), fmt(k.categorized) + ' of ' + fmt(k.total) + ' errors') +
        kpi('Known root cause', pct(k.known, k.total), fmt(k.known) + ' match a known error') +
        kpi('Needs analysis', fmt(k.unknown), 'no known root cause yet', k.unknown ? 'alert' : '') +
      '</div>' +
      '<div class="grid two mt">' +
        '<div class="card"><h2>Errors over time <small>known root cause vs. needs analysis</small></h2><div class="ch"><canvas id="c-series"></canvas></div></div>' +
        '<div class="card"><h2>By category <small>click a bar to see the errors</small></h2><div class="ch"><canvas id="c-cat"></canvas></div></div>' +
      '</div>' +
      '<div class="card mt"><h2>Top error patterns without a known root cause <small>record the root cause and solution, or create a category</small></h2><div class="scroll">' + unknownTable(d.topUnknown) + '</div></div>' +
      '<div class="grid half mt">' +
        '<div class="card"><h2>Top iFlows <small>click to see the errors</small></h2><div class="scroll">' + flowTable(d.byFlow) + '</div></div>' +
        '<div class="card"><h2>Unresolved known errors <small>hits in selected period</small></h2><div class="scroll">' + openTable(d.openIssues) + '</div></div>' +
      '</div>';
    drawDash(d);
    bindDash(d);
  });
}
function unknownTable(rows) {
  if (!rows.length) return '<div class="empty">Every error in this period matches a known error.</div>';
  return '<table><thead><tr><th>iFlow</th><th>Latest error text</th><th>Category</th><th class="num">Count</th><th>Last seen</th><th></th></tr></thead><tbody>' +
    rows.map(function (r, i) {
      return '<tr><td>' + esc(r.flow) + '</td><td class="mono">' + (r.sample ? esc(short(r.sample, 220)) : '<span class="muted">(no error text)</span>') + '</td><td>' + (r.category ? esc(r.category) : '<span class="muted">Uncategorized</span>') + '</td><td class="num">' + fmt(r.n) + '</td><td class="nowrap">' + dt(r.last_seen) + '</td>' +
        '<td class="nowrap"><button class="btn sm pri" data-an="' + i + '">Analyze</button> ' + (r.category ? '' : '<button class="btn sm" data-ca="' + i + '">Categorize</button> ') + '<button class="btn sm" data-vw="' + i + '">View</button></td></tr>';
    }).join('') + '</tbody></table>';
}
function flowTable(rows) {
  if (!rows.length) return '<div class="empty">No errors in this period.</div>';
  var max = Math.max.apply(null, rows.map(function (r) { return r.n; }));
  return '<table><thead><tr><th>iFlow</th><th class="num">Errors</th><th></th><th class="num">Needs analysis</th><th>Last seen</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="click" data-flow="' + esc(r.flow) + '"><td>' + esc(r.flow) + (r.package ? '<div class="muted small">' + esc(r.package) + '</div>' : '') + '</td><td class="num">' + fmt(r.n) + '</td><td><div class="bar"><i style="width:' + Math.round(r.n * 100 / max) + '%"></i></div></td><td class="num">' + (r.unknown ? '<b class="bad">' + fmt(r.unknown) + '</b>' : '0') + '</td><td class="nowrap">' + dt(r.last_seen) + '</td></tr>';
    }).join('') + '</tbody></table>';
}
function openTable(rows) {
  if (!rows.length) return '<div class="empty">No unresolved known errors.</div>';
  return '<table><thead><tr><th>Root cause</th><th>iFlow</th><th>Status</th><th class="num">Hits</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="click" data-ea="' + r.ea_id + '"><td>' + esc(r.rootcause || '(no root cause yet)') + '</td><td class="small">' + esc(r.flow || 'Any iFlow') + '</td><td>' + pill(r.status) + '</td><td class="num">' + fmt(r.n) + '</td></tr>';
    }).join('') + '</tbody></table>';
}
function chart(id, cfg) {
  if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; }
  var el = document.getElementById(id);
  if (!el || !window.Chart) return;
  S.charts[id] = new Chart(el, cfg);
}
function drawDash(d) {
  if (!window.Chart) return;
  var grid = css('--line');
  Chart.defaults.color = css('--muted');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  var unit = d.range.unit;
  var labels = d.series.map(function (p) { var x = p.bucket, dd = x.slice(8, 10) + '/' + x.slice(5, 7); return unit === 'hour' ? dd + ' ' + x.slice(11, 16) : dd; });
  chart('c-series', {
    type: 'bar',
    data: { labels: labels, datasets: [
      { label: 'Known root cause', data: d.series.map(function (p) { return p.known; }), backgroundColor: css('--accent'), stack: 's', borderRadius: 2 },
      { label: 'Needs analysis', data: d.series.map(function (p) { return p.unknown; }), backgroundColor: css('--bad'), stack: 's', borderRadius: 2 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, grid: { color: grid }, ticks: { precision: 0 } } } }
  });
  var cats = d.byCategory;
  chart('c-cat', {
    type: 'bar',
    data: { labels: cats.map(function (c) { return c.name; }), datasets: [{ data: cats.map(function (c) { return c.n; }), backgroundColor: cats.map(function (c) { return c.error_id == null ? css('--muted') : css('--accent'); }), borderRadius: 2 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, grid: { color: grid }, ticks: { precision: 0 } }, y: { grid: { display: false } } },
      onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      onClick: function (ev, els) { if (!els.length) return; var c = cats[els[0].index]; S.ef = blankFilter({ category: c.error_id == null ? '__none' : String(c.error_id) }); show('errors'); }
    }
  });
}
function bindDash(d) {
  var v = $('#v-dash');
  $$('[data-an]', v).forEach(function (b) { b.onclick = function () { var r = d.topUnknown[+b.dataset.an]; openAnalysis({ integration_flow_name: r.flow, errormessage: suggestPattern(r.sample), status: 'Open' }); }; });
  $$('[data-ca]', v).forEach(function (b) { b.onclick = function () { var r = d.topUnknown[+b.dataset.ca]; openCategory({ category_expression: suggestRegex(r.sample) }); }; });
  $$('[data-vw]', v).forEach(function (b) { b.onclick = function () { var r = d.topUnknown[+b.dataset.vw]; S.ef = blankFilter({ flow: r.flow, analysis: '__none' }); show('errors'); }; });
  $$('tr[data-flow]', v).forEach(function (t) { t.onclick = function () { S.ef = blankFilter({ flow: t.dataset.flow }); show('errors'); }; });
  $$('tr[data-ea]', v).forEach(function (t) { t.onclick = function () { openAnalysisById(+t.dataset.ea); }; });
}
function suggestPattern(s) {
  s = (s || '').split(NL)[0];
  var m = s.search(/[0-9]{4,}/);
  if (m > 30) s = s.slice(0, m);
  return s.slice(0, 250).trim();
}
function reEsc(t) {
  return t.split('').map(function (c) {
    if (c === ']' || c === '^' || c.charCodeAt(0) === 92) return '.';
    return '.*+?$(){}|['.indexOf(c) >= 0 ? '[' + c + ']' : c;
  }).join('');
}
function suggestRegex(s) {
  var m = (s || '').match(/([A-Za-z0-9_]+[.])+[A-Z][A-Za-z0-9_]*(Exception|Error)/);
  return reEsc(m ? m[0] : suggestPattern(s).slice(0, 80));
}

/* ---------- Errors ---------- */
function errorsShell() {
  return '<div class="filters"><select id="f-flow" aria-label="iFlow"></select><select id="f-status" aria-label="Status"></select><select id="f-cat" aria-label="Category"></select><select id="f-an" aria-label="Analysis"></select>' +
    '<input id="f-q" type="search" placeholder="Search error text, iFlow, message or correlation ID" style="min-width:240px;flex:1">' +
    '<button class="btn" id="f-clear">Clear filters</button><button class="btn" id="f-csv">Export CSV</button></div>' +
    '<div class="card"><div class="row" style="margin-bottom:8px"><b id="ecount"></b><span class="sp"></span><span id="epager"></span></div><div class="scroll" id="etab"></div></div>';
}
function bindErrors() {
  [['f-flow', 'flow'], ['f-status', 'status'], ['f-cat', 'category'], ['f-an', 'analysis']].forEach(function (p) {
    $('#' + p[0]).onchange = function () { S.ef[p[1]] = this.value; S.ef.offset = 0; loadErrors().catch(fail); };
  });
  var t;
  $('#f-q').oninput = function () { var v = this.value; clearTimeout(t); t = setTimeout(function () { S.ef.q = v.trim(); S.ef.offset = 0; loadErrors().catch(fail); }, 400); };
  $('#f-clear').onclick = function () { S.ef = blankFilter(); $('#f-q').value = ''; loadErrors().catch(fail); };
  $('#f-csv').onclick = exportCsv;
}
function fillFilters() {
  var m = S.meta, f = S.ef;
  $('#f-flow').innerHTML = opts([['', 'All iFlows']].concat(m.flows.map(function (x) { return [x, x]; })), f.flow);
  $('#f-status').innerHTML = opts([['', 'All statuses'], ['FAILED', 'Failed'], ['ESCALATED', 'Escalated'], ['RETRY', 'Retry']], f.status);
  $('#f-cat').innerHTML = opts([['', 'All categories'], ['__none', 'Uncategorized']].concat(m.categories.map(function (c) { return [String(c.error_id), c.name]; })), f.category);
  $('#f-an').innerHTML = opts([['', 'Any analysis'], ['__none', 'Needs analysis'], ['__known', 'Has a known error']].concat(STATUSES.map(function (s) { return [s, 'Known error: ' + s]; })), f.analysis);
  if (document.activeElement !== $('#f-q')) $('#f-q').value = f.q;
}
function loadErrors() {
  var v = $('#v-errors');
  if (!$('#etab', v)) { v.innerHTML = errorsShell(); bindErrors(); }
  fillFilters();
  $('#etab').innerHTML = '<div class="empty">Loading…</div>';
  return get('api/errors', withRange(Object.assign({ limit: 50 }, S.ef))).then(renderErrors);
}
function renderErrors(d) {
  var rows = d.rows;
  $('#ecount').textContent = fmt(d.total) + ' errors';
  if (!rows.length) { $('#etab').innerHTML = '<div class="empty">No errors match these filters.</div>'; $('#epager').innerHTML = ''; return; }
  $('#etab').innerHTML = '<table><thead><tr><th>Time</th><th>iFlow</th><th>Status</th><th>Category</th><th>Known error / root cause</th><th>Error text</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="click" data-g="' + esc(r.message_guid) + '"><td class="nowrap">' + dt(r.log_start) + '</td><td>' + esc(r.flow) + '</td><td>' + pill(r.status) + '</td>' +
        '<td>' + (r.category_name ? esc(r.category_name) : '<span class="muted">Uncategorized</span>') + '</td>' +
        '<td>' + (r.ea_id ? pill(r.ea_status) + ' ' + esc(short(r.rootcause, 90)) : '<span class="bad small">Needs analysis</span>') + '</td>' +
        '<td class="mono">' + (r.errormsg ? esc(short(r.errormsg, 170)) : '<span class="muted">(no error text)</span>') + '</td></tr>';
    }).join('') + '</tbody></table>';
  $$('#etab tr[data-g]').forEach(function (t) { t.onclick = function () { openDetail(t.dataset.g); }; });
  var o = S.ef.offset, n = rows.length;
  $('#epager').innerHTML = '<span class="muted small">' + fmt(o + 1) + '–' + fmt(o + n) + ' of ' + fmt(d.total) + '</span> <button class="btn sm" id="pp"' + (o ? '' : ' disabled') + '>Previous</button> <button class="btn sm" id="pn"' + (o + n < d.total ? '' : ' disabled') + '>Next</button>';
  $('#pp').onclick = function () { S.ef.offset = Math.max(0, o - 50); loadErrors().catch(fail); };
  $('#pn').onclick = function () { S.ef.offset = o + 50; loadErrors().catch(fail); };
}
function exportCsv() {
  get('api/errors', withRange(Object.assign({}, S.ef, { limit: 500, offset: 0 }))).then(function (d) {
    var cols = ['log_start', 'flow', 'status', 'category_name', 'ea_id', 'ea_status', 'rootcause', 'correlation_id', 'message_guid', 'errormsg'];
    var q = function (v) { v = v == null ? '' : String(v); return '"' + v.split('"').join('""') + '"'; };
    var csv = cols.join(',') + NL + d.rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); }).join(NL);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'cpi-errors.csv';
    a.click();
    toast('Exported ' + d.rows.length + ' rows' + (d.total > 500 ? ' (first 500 of ' + fmt(d.total) + ')' : ''));
  }).catch(fail);
}

/* ---------- Drawer ---------- */
function openDrawer(html) { var d = $('#dr'); d.innerHTML = html; d.classList.add('on'); $('#ov').classList.add('on'); d.scrollTop = 0; }
function closeDrawer() { $('#dr').classList.remove('on'); $('#ov').classList.remove('on'); }
function drawerHead(title) { return '<div class="dh"><h2>' + esc(title) + '</h2><button class="btn sm" data-close>Close</button></div>'; }
function kv(k, v) { return v ? '<div>' + esc(k) + '</div><div>' + v + '</div>' : ''; }
function flowDatalist() { return '<datalist id="flows">' + S.meta.flows.map(function (f) { return '<option value="' + esc(f) + '">'; }).join('') + '</datalist>'; }

function openDetail(guid) {
  openDrawer(drawerHead('Error details') + '<div class="empty">Loading…</div>');
  get('api/errors/' + encodeURIComponent(guid)).then(function (d) {
    var m = d.mpl;
    if (!m) { openDrawer(drawerHead('Error details') + '<div class="empty">Message not found.</div>'); return; }
    var dur = m.log_start && m.log_end ? Math.round((new Date(m.log_end) - new Date(m.log_start)) / 100) / 10 + ' s' : '';
    var a = d.analysis;
    var h = drawerHead('Error details') +
      '<div class="kv">' +
        kv('iFlow', esc(m.flow)) + kv('Package', esc(m.package)) +
        kv('Status', pill(m.status) + (m.custom_status && m.custom_status !== m.status ? ' <span class="muted">' + esc(m.custom_status) + '</span>' : '')) +
        kv('Started', esc(dtFull(m.log_start)) + (dur ? ' <span class="muted">(' + dur + ')</span>' : '')) +
        kv('Correlation ID', '<span class="mono">' + esc(m.correlation_id) + '</span>') +
        kv('Message ID', '<span class="mono">' + esc(m.message_guid) + '</span>') +
        (m.sender || m.receiver ? kv('Sender / receiver', esc((m.sender || '–') + ' / ' + (m.receiver || '–'))) : '') +
        (m.application_message_id ? kv('Application message', esc(m.application_message_id + (m.application_message_type ? ' (' + m.application_message_type + ')' : ''))) : '') +
        (m.link ? kv('CPI monitor', '<a href="' + esc(m.link) + '" target="_blank" rel="noopener">Open in Integration Suite ↗</a>') : '') +
      '</div>' +
      '<h3>Category</h3>' + (d.category ? '<div>' + pill(d.category.category_name, 'cat') + ' <span class="muted mono">' + esc(d.category.category_expression) + '</span></div>' : '<div class="row"><span class="muted">Uncategorized</span><button class="btn sm" id="d-cat">Create a category from this error</button></div>') +
      '<h3>Root cause &amp; solution</h3>' + (a ? analysisBlock(a) : '<div class="row"><span class="muted">No known error matches this message yet.</span><button class="btn sm pri" id="d-an">Record root cause &amp; solution</button></div>') +
      (kanbanOn() ? '<h3>Kanban</h3><div class="row" id="d-kb"><span class="muted small">Checking the board…</span></div>' : '') +
      '<h3>Error text</h3><pre class="err">' + esc(d.errormsg || '(no error text returned by CPI)') + '</pre>' +
      (d.attributes.length ? '<h3>Custom header properties</h3><table><tbody>' + d.attributes.map(function (x) { return '<tr><td class="muted">' + esc(x.name) + '</td><td class="mono">' + esc(x.value) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (d.related.length ? '<h3>Other messages with the same correlation ID</h3><table><tbody>' + d.related.map(function (r) { return '<tr class="click" data-g="' + esc(r.message_guid) + '"><td class="nowrap">' + dt(r.log_start) + '</td><td>' + esc(r.flow) + '</td><td>' + pill(r.status) + '</td></tr>'; }).join('') + '</tbody></table>' : '');
    openDrawer(h);
    var dc = $('#d-cat'); if (dc) dc.onclick = function () { openCategory({ category_expression: suggestRegex(d.errormsg) }); };
    var da = $('#d-an'); if (da) da.onclick = function () { openAnalysis({ integration_flow_name: m.flow, errormessage: suggestPattern(d.errormsg), status: 'Open' }); };
    var de = $('#d-edit'); if (de) de.onclick = function () { openAnalysis(a); };
    $$('#dr tr[data-g]').forEach(function (t) { t.onclick = function () { openDetail(t.dataset.g); }; });
    if (kanbanOn()) loadCardInfo(guid);
  }).catch(fail);
}

/* ---------- Kanban card from an error (TodoList Kanban over MCP) ---------- */
function cardLink(k, c) { return k.cardUrl ? '<a href="' + esc(k.cardUrl.split('{id}').join(encodeURIComponent(c.id))) + '" target="_blank" rel="noopener">' + esc(c.title) + ' ↗</a>' : esc(c.title); }
function kanbanOn() { return !!(S.meta.kanban && S.meta.kanban.enabled); }
function connectKanban(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Opening sign-in…'; }
  request('POST', 'api/kanban/connect').then(function (r) { window.location.href = r.url; })
    .catch(function (e) { if (btn) { btn.disabled = false; btn.textContent = 'Connect Kanban board'; } fail(e); });
}
function kanbanConnectBox(msg) {
  return '<div class="row" id="d-kb"><span class="muted small">' + esc(msg) + '</span><button class="btn sm pri" id="d-kconn">Connect Kanban board</button></div>';
}
function bindKanbanConnect() { var b = $('#d-kconn'); if (b) b.onclick = function () { connectKanban(b); }; }
function loadCardInfo(guid) {
  get('api/errors/' + encodeURIComponent(guid) + '/card').then(function (k) {
    var box = $('#d-kb'); if (!box) return;
    if (!k.connected) {
      box.outerHTML = kanbanConnectBox('Sign in to the Kanban app once to create cards from errors.');
      bindKanbanConnect();
      return;
    }
    var ex = k.existing || [];
    var who = S.meta.kanban && S.meta.kanban.auth === 'oauth'
      ? '<div class="muted small" style="margin-top:6px">Cards are created as the Kanban account connected' + (S.meta.kanban.connectedBy ? ' by ' + esc(S.meta.kanban.connectedBy) : '') + '. <a href="#" id="d-kdis">Disconnect</a></div>' : '';
    box.outerHTML = '<div id="d-kb">' + (ex.length ? '<table><tbody>' + ex.map(function (c) { return '<tr><td>' + cardLink(k, c) + '</td><td class="nowrap">' + pill(c.column, 'cat') + '</td><td class="muted small nowrap">' + esc(dt(c.createdAt)) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      '<div class="row"><span class="muted small">' + (ex.length ? ex.length + ' card' + (ex.length > 1 ? 's' : '') + ' on ' : 'No card yet on ') + esc(k.board.title) + '.</span><button class="btn sm' + (ex.length ? '' : ' pri') + '" id="d-card">' + (ex.length ? 'Create another card' : 'Create Kanban card') + '</button></div>' + who + '</div>';
    $('#d-card').onclick = function () { openCard(guid, k); };
    var dis = $('#d-kdis');
    if (dis) dis.onclick = function (ev) {
      ev.preventDefault();
      if (!confirm('Disconnect the Kanban board? Nobody can create cards until someone connects it again.')) return;
      request('POST', 'api/kanban/disconnect').then(function (st) { S.meta.kanban = st; toast('Kanban board disconnected'); openDetail(guid); }).catch(fail);
    };
  }).catch(function (e) {
    var box = $('#d-kb'); if (!box) return;
    if (e.connect) { box.outerHTML = kanbanConnectBox(e.message); bindKanbanConnect(); return; }
    box.innerHTML = '<span class="bad small">' + esc(e.message) + '</span>';
  });
}
function openCard(guid, k) {
  var s = k.suggested, d = k.defaults;
  var checks = function (name, all, on) {
    return '<div class="row" style="flex-wrap:wrap;gap:4px 14px">' + all.map(function (x, i) {
      return '<label class="small"><input type="checkbox" name="' + name + '" value="' + esc(x) + '"' + (on.indexOf(x) >= 0 ? ' checked' : '') + '> ' + esc(x) + '</label>';
    }).join('') + '</div>';
  };
  openDrawer(drawerHead('New Kanban card') +
    '<p class="muted small" style="margin-top:0">Creates a card on <b>' + esc(k.board.title) + '</b> with the error details. Edit anything before you create it.</p>' +
    '<label class="f" for="c-title">Title</label><input id="c-title" style="width:100%" maxlength="200" value="' + esc(s.title) + '">' +
    '<div class="row" style="gap:12px;flex-wrap:wrap">' +
      '<div><label class="f" for="c-col">Column</label><select id="c-col">' + opts(k.columns.map(function (c) { return [c, c]; }), k.columns.indexOf(d.column) >= 0 ? d.column : k.columns[0]) + '</select></div>' +
      '<div><label class="f" for="c-pri">Priority</label><select id="c-pri">' + opts(['none', 'low', 'medium', 'high', 'urgent'].map(function (p) { return [p, p[0].toUpperCase() + p.slice(1)]; }), d.priority) + '</select></div>' +
      '<div><label class="f" for="c-as">Assignee</label><select id="c-as">' + opts([['', 'Nobody']].concat(k.team.map(function (t) { return [t, t]; })), '') + '</select></div>' +
      '<div><label class="f" for="c-due">Due date</label><input id="c-due" type="date"></div>' +
    '</div>' +
    (k.labels.length ? '<label class="f">Labels</label>' + checks('c-lb', k.labels, d.labels) : '') +
    '<label class="f" for="c-desc">Notes</label><textarea id="c-desc" rows="14">' + esc(s.description) + '</textarea>' +
    (k.team.length ? '<p class="muted small">An assignee is a request: the board owner approves it in the Kanban app.</p>' : '') +
    '<div class="row mt"><button class="btn pri" id="c-save">Create card</button><span class="sp"></span><button class="btn" id="c-back">Back to the error</button></div>');
  $('#c-back').onclick = function () { openDetail(guid); };
  $('#c-save').onclick = function () {
    var p = {
      title: $('#c-title').value.trim(), column: $('#c-col').value, priority: $('#c-pri').value, dueDate: $('#c-due').value,
      description: $('#c-desc').value.trim(),
      labels: $$('input[name="c-lb"]:checked').map(function (x) { return x.value; }),
      assignees: $('#c-as').value ? [$('#c-as').value] : []
    };
    if (!p.title) { toast('The card needs a title', true); return; }
    var b = this; b.disabled = true; b.textContent = 'Creating…';
    request('POST', 'api/errors/' + encodeURIComponent(guid) + '/card', p).then(function (c) {
      toast('Card created in ' + (c.column || p.column)); openDetail(guid);
    }).catch(function (e) {
      b.disabled = false; b.textContent = 'Create card'; fail(e);
      if (e.connect) openDetail(guid);
    });
  };
}
function analysisBlock(a) {
  var last = a.comments && a.comments.length ? a.comments[a.comments.length - 1] : null;
  return '<div class="box"><div class="row">' + pill(a.status) + '<span class="muted small">Known error #' + a.ea_id + '</span><span class="sp"></span><button class="btn sm" id="d-edit">Edit / comment</button></div>' +
    '<div class="lbl">Root cause</div><div class="txt">' + esc(a.rootcause || '–') + '</div>' +
    '<div class="lbl">Solution</div><div class="txt">' + esc(a.solutions || '–') + '</div>' +
    (last ? '<div class="lbl">Latest comment · ' + esc(dt(last.created_at)) + '</div><div class="txt">' + esc(last.comment) + '</div>' : '') + '</div>';
}

/* ---------- Known errors ---------- */
function loadKnown() {
  var v = $('#v-known');
  if (!$('#kt', v)) {
    v.innerHTML = '<div class="filters"><button class="btn pri" id="k-new">+ New known error</button><select id="k-st" aria-label="Status"></select>' +
      '<input id="k-q" type="search" placeholder="Search root cause, solution, iFlow or error text" style="min-width:240px;flex:1"></div>' +
      '<div class="card"><div class="scroll" id="kt"></div></div><p class="muted small">Hits = errors in the selected period that match the pattern (same rule as the errorscenario view: error text contains the pattern, same iFlow).</p>';
    $('#k-new').onclick = function () { openAnalysis({ status: 'Open' }); };
    $('#k-st').onchange = function () { S.kst = this.value; renderKnown(); };
    $('#k-q').oninput = renderKnown;
  }
  $('#k-st').innerHTML = opts([['', 'All statuses']].concat(STATUSES.map(function (s) { return [s, s]; })), S.kst);
  $('#kt').innerHTML = '<div class="empty">Loading…</div>';
  return get('api/known-errors', withRange()).then(function (rows) { S.cache.known = rows; renderKnown(); });
}
function renderKnown() {
  var st = S.kst, q = ($('#k-q').value || '').toLowerCase();
  var rows = (S.cache.known || []).filter(function (r) {
    if (st && r.status !== st) return false;
    return !q || [r.rootcause, r.solutions, r.integration_flow_name, r.errormessage].join(' ').toLowerCase().indexOf(q) >= 0;
  });
  if (!rows.length) { $('#kt').innerHTML = '<div class="empty">No known errors match.</div>'; return; }
  $('#kt').innerHTML = '<table><thead><tr><th>#</th><th>Status</th><th>iFlow</th><th>Root cause</th><th>Solution</th><th>Error pattern</th><th class="num">Hits</th><th>Last seen</th><th class="num">Comments</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="click" data-ea="' + r.ea_id + '"><td class="muted">' + r.ea_id + '</td><td>' + pill(r.status) + '</td><td class="small">' + esc(r.integration_flow_name || 'Any iFlow') + '</td>' +
        '<td>' + (r.rootcause ? esc(short(r.rootcause, 120)) : '<span class="muted">–</span>') + '</td><td>' + (r.solutions ? esc(short(r.solutions, 120)) : '<span class="muted">No solution yet</span>') + '</td>' +
        '<td class="mono">' + esc(short(r.errormessage, 110)) + '</td><td class="num">' + fmt(r.n) + '</td><td class="nowrap">' + dt(r.last_seen) + '</td><td class="num">' + (r.comments.length || '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  $$('#kt tr[data-ea]').forEach(function (t) { t.onclick = function () { openAnalysisById(+t.dataset.ea); }; });
}
function openAnalysisById(id) {
  var go = function (rows) { var a = rows.filter(function (r) { return r.ea_id === id; })[0]; if (a) openAnalysis(a); else toast('Known error not found', true); };
  if (S.cache.known) go(S.cache.known); else get('api/known-errors', withRange()).then(function (r) { S.cache.known = r; go(r); }).catch(fail);
}
function openAnalysis(a) {
  var isNew = !a.ea_id;
  openDrawer(drawerHead(isNew ? 'New known error' : 'Known error #' + a.ea_id) +
    '<p class="muted small" style="margin-top:0">An error matches when its text contains the pattern and it comes from the same iFlow. Leave iFlow empty to match any iFlow.</p>' +
    '<label class="f" for="a-flow">iFlow</label><input id="a-flow" list="flows" style="width:100%" value="' + esc(a.integration_flow_name || '') + '">' + flowDatalist() +
    '<label class="f" for="a-pat">Error text pattern</label><textarea id="a-pat" rows="4">' + esc(a.errormessage || '') + '</textarea>' +
    '<div class="row"><button class="btn sm" id="a-test">Test against last 30 days</button><span id="a-res" class="small"></span></div>' +
    '<label class="f" for="a-rc">Root cause</label><textarea id="a-rc" rows="3" class="txt">' + esc(a.rootcause || '') + '</textarea>' +
    '<label class="f" for="a-sol">Solution</label><textarea id="a-sol" rows="4" class="txt">' + esc(a.solutions || '') + '</textarea>' +
    '<label class="f" for="a-st">Status</label><select id="a-st">' + opts(STATUSES.map(function (s) { return [s, s]; }), a.status || 'Open') + '</select>' +
    '<div class="row mt"><button class="btn pri" id="a-save">Save</button>' + (isNew ? '' : '<button class="btn danger" id="a-del">Delete</button>') + '<span class="sp"></span><button class="btn" data-close>Cancel</button></div>' +
    (isNew ? '' : '<h3>Comments</h3><div id="a-cm">' + commentsHtml(a.comments || []) + '</div><textarea id="a-nc" rows="2" class="txt" placeholder="Add a comment (investigation notes, who is working on it)"></textarea><div class="row" style="margin-top:6px"><button class="btn sm" id="a-addc">Add comment</button></div>'));
  $('#a-test').onclick = function () { testMatch('like', $('#a-pat').value, $('#a-flow').value, '#a-res'); };
  $('#a-save').onclick = function () {
    var p = { integration_flow_name: $('#a-flow').value.trim(), errormessage: $('#a-pat').value.trim(), rootcause: $('#a-rc').value.trim(), solutions: $('#a-sol').value.trim(), status: $('#a-st').value };
    if (p.errormessage.length < 10) { toast('The error text pattern needs at least 10 characters, otherwise it matches almost everything', true); return; }
    var b = this; b.disabled = true;
    (a.ea_id ? request('PUT', 'api/known-errors/' + a.ea_id, p) : request('POST', 'api/known-errors', p)).then(function () { toast('Saved'); closeDrawer(); refreshAll(); }).catch(function (e) { b.disabled = false; fail(e); });
  };
  var del = $('#a-del');
  if (del) del.onclick = function () {
    if (!confirm('Delete known error #' + a.ea_id + ' and its comments?')) return;
    request('DELETE', 'api/known-errors/' + a.ea_id).then(function () { toast('Deleted'); closeDrawer(); refreshAll(); }).catch(fail);
  };
  var ac = $('#a-addc');
  if (ac) ac.onclick = function () {
    var t = $('#a-nc').value.trim(); if (!t) return;
    request('POST', 'api/known-errors/' + a.ea_id + '/comments', { comment: t }).then(function (r) {
      a.comments = (a.comments || []).concat([r]);
      $('#a-cm').innerHTML = commentsHtml(a.comments); $('#a-nc').value = ''; S.cache.known = null; toast('Comment added');
    }).catch(fail);
  };
}
function commentsHtml(list) {
  if (!list.length) return '<p class="muted small">No comments yet.</p>';
  return list.slice().sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); }).map(function (c) {
    return '<div class="cm"><div class="muted small">' + esc(dtFull(c.created_at)) + '</div><div class="txt">' + esc(c.comment) + '</div></div>';
  }).join('');
}
function testMatch(kind, pattern, flow, out) {
  if (!pattern.trim()) { $(out).textContent = 'Enter a pattern first.'; return; }
  $(out).textContent = 'Testing…';
  request('POST', 'api/test-match', { kind: kind, pattern: pattern.trim(), flow: flow.trim() }).then(function (r) {
    $(out).innerHTML = '<b>' + fmt(r.n) + '</b> of ' + fmt(r.of) + ' errors in the last 30 days match' + (r.flows.length ? ': ' + r.flows.map(function (f) { return esc(f.flow) + ' (' + fmt(f.n) + ')'; }).join(', ') : '');
  }).catch(function (e) { $(out).innerHTML = '<span class="bad">' + esc(e.message) + '</span>'; });
}

/* ---------- Categories ---------- */
function loadCats() {
  var v = $('#v-cats');
  if (!$('#ct', v)) {
    v.innerHTML = '<div class="filters"><button class="btn pri" id="c-new">+ New category</button><span class="sp"></span><span class="small" id="c-sum"></span></div>' +
      '<div class="card"><div class="scroll" id="ct"></div></div><p class="muted small">A category is a regular expression (case-insensitive) matched against the error text. When several match, the one with the lowest # wins.</p>';
    $('#c-new').onclick = function () { openCategory({}); };
  }
  $('#ct').innerHTML = '<div class="empty">Loading…</div>';
  return get('api/categories', withRange()).then(function (d) {
    $('#c-sum').innerHTML = '<span class="muted">' + fmt(d.total) + ' errors in period ·</span> <a href="#" id="c-unc">' + fmt(d.uncategorized) + ' uncategorized</a>';
    $('#c-unc').onclick = function (e) { e.preventDefault(); S.ef = blankFilter({ category: '__none' }); show('errors'); };
    if (!d.rows.length) { $('#ct').innerHTML = '<div class="empty">No categories yet.</div>'; return; }
    $('#ct').innerHTML = '<table><thead><tr><th>#</th><th>Category</th><th>Regular expression</th><th>iFlow</th><th>Application</th><th class="num">Hits</th><th>Last seen</th><th></th></tr></thead><tbody>' +
      d.rows.map(function (c, i) {
        return '<tr><td class="muted">' + c.error_id + '</td><td><b>' + esc(c.category_name) + '</b></td><td class="mono">' + esc(c.category_expression) + '</td><td class="small">' + esc(c.integration_flow_name || 'Any') + '</td><td class="small">' + esc(c.application_name || '') + '</td>' +
          '<td class="num">' + fmt(c.n) + '</td><td class="nowrap">' + dt(c.last_seen) + '</td><td class="nowrap"><button class="btn sm" data-ed="' + i + '">Edit</button> <button class="btn sm" data-vc="' + i + '">View errors</button></td></tr>';
      }).join('') + '</tbody></table>';
    $$('#ct [data-ed]').forEach(function (b) { b.onclick = function () { openCategory(d.rows[+b.dataset.ed]); }; });
    $$('#ct [data-vc]').forEach(function (b) { b.onclick = function () { S.ef = blankFilter({ category: String(d.rows[+b.dataset.vc].error_id) }); show('errors'); }; });
  });
}
function openCategory(c) {
  var isNew = !c.error_id;
  openDrawer(drawerHead(isNew ? 'New category' : 'Category #' + c.error_id) +
    '<label class="f" for="c-name">Category name</label><input id="c-name" style="width:100%" value="' + esc(c.category_name || '') + '">' +
    '<label class="f" for="c-re">Regular expression (case-insensitive)</label><textarea id="c-re" rows="3">' + esc(c.category_expression || '') + '</textarea>' +
    '<div class="row"><button class="btn sm" id="c-test">Test against last 30 days</button><span id="c-res" class="small"></span></div>' +
    '<label class="f" for="c-flow">Only for iFlow (optional)</label><input id="c-flow" list="flows" style="width:100%" value="' + esc(c.integration_flow_name || '') + '">' + flowDatalist() +
    '<label class="f" for="c-app">Application (optional)</label><input id="c-app" style="width:100%" value="' + esc(c.application_name || '') + '">' +
    '<div class="row mt"><button class="btn pri" id="c-save">Save</button>' + (isNew ? '' : '<button class="btn danger" id="c-del">Delete</button>') + '<span class="sp"></span><button class="btn" data-close>Cancel</button></div>');
  $('#c-test').onclick = function () { testMatch('regex', $('#c-re').value, $('#c-flow').value, '#c-res'); };
  $('#c-save').onclick = function () {
    var p = { category_name: $('#c-name').value.trim(), category_expression: $('#c-re').value.trim(), integration_flow_name: $('#c-flow').value.trim(), application_name: $('#c-app').value.trim() };
    if (!p.category_name || !p.category_expression) { toast('Category name and regular expression are required', true); return; }
    var b = this; b.disabled = true;
    (c.error_id ? request('PUT', 'api/categories/' + c.error_id, p) : request('POST', 'api/categories', p)).then(function () { toast('Saved'); closeDrawer(); refreshAll(); }).catch(function (e) { b.disabled = false; fail(e); });
  };
  var del = $('#c-del');
  if (del) del.onclick = function () {
    if (!confirm('Delete category "' + c.category_name + '"?')) return;
    request('DELETE', 'api/categories/' + c.error_id).then(function () { toast('Deleted'); closeDrawer(); refreshAll(); }).catch(fail);
  };
}

/* ---------- Certificates ---------- */
var CERT_STATES = { expired: 'Expired', critical: 'Expires soon', warning: 'Expiring', ok: 'Valid', unknown: 'No end date' };
S.cf = { state: '', type: '', hideSap: false, q: '', showRemoved: false };

function certPill(c) {
  if (c.removedAt) return '<span class="pill">Removed</span>';
  return '<span class="pill cert-' + esc(c.state) + '">' + esc(CERT_STATES[c.state] || c.state) + '</span>';
}
function daysText(c) {
  if (c.daysLeft == null) return '–';
  if (c.state === 'expired') return c.daysLeft === 0 ? 'expired today' : 'expired ' + fmt(-c.daysLeft) + ' d ago';
  return fmt(c.daysLeft) + ' d';
}
function dateOnly(s) { return s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '–'; }
function setCertBadge(sum) {
  var b = $('#cert-badge'), n = sum ? sum.expired + sum.critical : 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}
function certsShell() {
  return '<div class="grid kpis" id="cert-kpis"></div>' +
    '<div class="filters mt"><select id="cf-state" aria-label="Status"></select><select id="cf-type" aria-label="Type"></select>' +
    '<label class="check"><input type="checkbox" id="cf-sap"> Hide SAP-owned</label>' +
    '<input id="cf-q" type="search" placeholder="Search alias, subject, issuer or serial number" style="min-width:240px;flex:1">' +
    '<label class="check"><input type="checkbox" id="cf-removed"> Show removed</label>' +
    '<button class="btn" id="cf-csv">Export CSV</button>' +
    '<button class="btn" id="cf-sync" hidden>Sync from CPI now</button><button class="btn" id="cf-check" hidden>Test CPI connection</button></div>' +
    '<div id="cert-sync"></div>' +
    '<div class="card"><div class="row" style="margin-bottom:8px"><b id="cert-count"></b><span class="sp"></span><span class="muted small" id="cert-fetched"></span></div><div class="scroll" id="cert-tab"></div></div>' +
    '<p class="muted small" id="cert-note"></p>';
}
function bindCerts() {
  $('#cf-state').onchange = function () { S.cf.state = this.value; renderCerts(); };
  $('#cf-type').onchange = function () { S.cf.type = this.value; renderCerts(); };
  $('#cf-sap').onchange = function () { S.cf.hideSap = this.checked; renderCerts(); };
  $('#cf-q').oninput = function () { S.cf.q = this.value.trim().toLowerCase(); renderCerts(); };
  $('#cf-removed').onchange = function () { S.cf.showRemoved = this.checked; loadCerts().catch(fail); };
  $('#cf-sync').onclick = syncCerts;
  $('#cf-csv').onclick = exportCertCsv;
  $('#cf-check').onclick = checkCpi;
}
function checkCpi() {
  openDrawer(drawerHead('CPI connection test') + '<div class="empty">Testing the connection to CPI…</div>');
  get('api/cpi/check').then(function (r) {
    openDrawer(drawerHead('CPI connection test') +
      '<p>' + (r.ok ? pill('Connection works', 'Resolved') : pill('Problem found', 'Open')) + '</p>' +
      r.steps.map(function (st) {
        return '<div class="box" style="margin:8px 0"><div class="row">' + (st.ok ? pill('OK', 'Resolved') : pill('Failed', 'Open')) +
          '<b>' + esc(st.name) + '</b>' + (st.ms != null ? '<span class="muted small">' + st.ms + ' ms</span>' : '') + '</div>' +
          '<div class="small" style="margin-top:6px;word-break:break-word">' + esc(st.detail) + '</div></div>';
      }).join('') +
      '<p class="muted small">The same test runs on the server with: npm run check:cpi</p>');
  }).catch(function (e) { openDrawer(drawerHead('CPI connection test') + '<div class="empty bad">' + esc(e.message) + '</div>'); });
}
function loadCerts() {
  var v = $('#v-certs');
  if (!$('#cert-tab', v)) { v.innerHTML = certsShell(); bindCerts(); }
  $('#cert-tab').innerHTML = '<div class="empty">Loading…</div>';
  return get('api/certificates', S.cf.showRemoved ? { removed: 1 } : {}).then(function (d) {
    if (!d.enabled) {
      v.innerHTML = '<div class="card"><h2>Certificates are not available yet</h2><p class="muted">' + esc(d.reason) + '</p></div>';
      return;
    }
    S.cache.certs = d;
    setCertBadge(d.summary);
    renderCerts();
  }, function (e) {
    $('#cert-tab').innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>';
  });
}
function syncCerts() {
  var b = $('#cf-sync');
  b.disabled = true;
  b.textContent = 'Syncing…';
  request('POST', 'api/certificates/sync').then(function (r) {
    toast('Synced ' + r.entries + ' keystore entries from CPI' + (r.removed ? ', ' + r.removed + ' removed' : ''));
    return loadCerts();
  }).catch(fail).then(function () { b.disabled = false; b.textContent = 'Sync from CPI now'; });
}
function certMatches(c, f) {
  if (f.state === 'attention' && ['expired', 'critical', 'warning'].indexOf(c.state) < 0) return false;
  if (f.state && f.state !== 'attention' && c.state !== f.state) return false;
  if (f.state && c.removedAt) return false;
  if (f.type && c.entryType !== f.type) return false;
  if (f.hideSap && /^sap$/i.test(c.owner)) return false;
  if (f.q && [c.alias, c.subjectDN, c.issuerDN, c.serialNumber].join(' ').toLowerCase().indexOf(f.q) < 0) return false;
  return true;
}
function certKpi(state, label, value, sub, cls) {
  return '<div class="card kpi click ' + (cls || '') + (S.cf.state === state ? ' sel' : '') + '" data-st="' + state + '" role="button" tabindex="0">' +
    '<div class="l">' + esc(label) + '</div><div class="v">' + fmt(value) + '</div><div class="s">' + esc(sub) + '</div></div>';
}
function renderCerts() {
  var d = S.cache.certs, f = S.cf, sum = d.summary;
  $('#cert-kpis').innerHTML =
    certKpi('expired', 'Expired', sum.expired, 'renew or remove now', sum.expired ? 'alert' : '') +
    certKpi('critical', 'Expires within ' + d.criticalDays + ' days', sum.critical, 'plan the renewal', sum.critical ? 'alert' : '') +
    certKpi('warning', 'Expires within ' + d.warnDays + ' days', sum.warning, 'coming up', sum.warning ? 'warn' : '') +
    certKpi('ok', 'Valid', sum.ok, 'more than ' + d.warnDays + ' days left', 'good') +
    certKpi('', 'All entries', sum.total, 'in the tenant keystore', '');
  $$('#cert-kpis [data-st]').forEach(function (el) {
    var pick = function () { S.cf.state = S.cf.state === el.dataset.st ? '' : el.dataset.st; renderCerts(); };
    el.onclick = pick;
    el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  var types = [];
  d.items.forEach(function (c) { if (c.entryType && types.indexOf(c.entryType) < 0) types.push(c.entryType); });
  $('#cf-state').innerHTML = opts([['', 'All statuses'], ['attention', 'Needs attention (expired or expiring)'], ['expired', 'Expired'], ['critical', 'Expires within ' + d.criticalDays + ' days'], ['warning', 'Expires within ' + d.warnDays + ' days'], ['ok', 'Valid']], f.state);
  $('#cf-type').innerHTML = opts([['', 'All types']].concat(types.sort().map(function (t) { return [t, t]; })), f.type);
  $('#cf-sap').checked = f.hideSap;
  $('#cf-removed').checked = f.showRemoved;
  $('#cf-sync').hidden = !d.canSync;
  $('#cf-check').hidden = !d.canSync;
  var ls = d.lastSync;
  $('#cert-fetched').textContent = ls ? 'Last synced from CPI ' + dt(ls.at) + ' (' + (ls.source || 'unknown') + ', ' + fmt(ls.entries) + ' entries)' : 'Never synced';
  $('#cert-sync').innerHTML = !ls
    ? '<div class="card mt" style="margin-bottom:12px"><b class="bad">No keystore data yet.</b> <span class="muted">Run the n8n workflow "CPI Keystore → Postgres" once' + (d.canSync ? ' or press "Sync from CPI now"' : '') + '.</span></div>'
    : d.stale
      ? '<div class="card" style="margin-bottom:12px"><b class="bad">This data may be out of date:</b> <span class="muted">the last sync was ' + esc(dt(ls.at)) + ', more than ' + d.staleHours + ' hours ago. Check that the n8n workflow "CPI Keystore → Postgres" is active and succeeds.</span></div>'
      : '';
  $('#cert-note').textContent = 'Expires soon = less than ' + d.criticalDays + ' days left; Expiring = less than ' + d.warnDays + ' days (CERT_CRITICAL_DAYS / CERT_WARN_DAYS). The data comes from the database, which the n8n workflow "CPI Keystore → Postgres" fills from the CPI keystore.';
  var rows = d.items.filter(function (c) { return certMatches(c, f); });
  S.cache.certRows = rows;
  $('#cert-count').textContent = fmt(rows.length) + ' of ' + fmt(d.items.length) + ' entries' + (d.summary.removed ? ' (' + fmt(d.summary.removed) + ' removed)' : '');
  if (!rows.length) { $('#cert-tab').innerHTML = '<div class="empty">No certificates match these filters.</div>'; return; }
  $('#cert-tab').innerHTML = '<table><thead><tr><th>Status</th><th>Alias</th><th>Type</th><th>Subject</th><th>Issuer</th><th>Valid until</th><th class="num">Days left</th><th>Owner</th></tr></thead><tbody>' +
    rows.map(function (c, i) {
      return '<tr class="click" data-i="' + i + '"><td>' + certPill(c) + '</td><td><b>' + esc(c.alias) + '</b></td>' +
        '<td class="small">' + esc(c.entryType) + (c.keyType ? '<div class="muted">' + esc(c.keyType + (c.keySize ? ' ' + c.keySize : '')) + '</div>' : '') + '</td>' +
        '<td>' + esc(c.subject) + '</td><td class="small">' + esc(c.issuer) + '</td><td class="nowrap">' + dateOnly(c.validTo) + '</td>' +
        '<td class="num nowrap' + (c.state === 'expired' || c.state === 'critical' ? ' bad' : '') + '">' + daysText(c) + '</td><td class="small">' + esc(c.owner) + '</td></tr>';
    }).join('') + '</tbody></table>';
  $$('#cert-tab tr[data-i]').forEach(function (t) { t.onclick = function () { openCert(rows[+t.dataset.i]); }; });
}
function openCert(c) {
  openDrawer(drawerHead('Certificate: ' + c.alias) +
    '<div class="row" style="margin-bottom:12px">' + certPill(c) + '<span class="muted">' + esc(daysText(c)) + '</span></div>' +
    '<div class="kv">' +
      kv('Alias', '<b>' + esc(c.alias) + '</b>') + kv('Entry type', esc(c.entryType)) +
      kv('Key', esc([c.keyType, c.keySize].filter(Boolean).join(' '))) + kv('Owner', esc(c.owner)) +
      kv('Valid from', esc(dtFull(c.validFrom))) + kv('Valid until', '<b>' + esc(dtFull(c.validTo)) + '</b>') +
      kv('Subject', '<span class="mono">' + esc(c.subjectDN) + '</span>') + kv('Issuer', '<span class="mono">' + esc(c.issuerDN) + '</span>') +
      kv('Serial number', '<span class="mono">' + esc(c.serialNumber) + '</span>') + kv('Signature algorithm', esc(c.signatureAlgorithm)) +
      kv('Fingerprint', '<span class="mono">' + esc(c.fingerprintSha256) + '</span>') +
      kv('Last changed in CPI', esc([dtFull(c.lastModifiedTime), c.lastModifiedBy].filter(Boolean).join(' by '))) +
      kv('First seen', esc(dtFull(c.firstSeenAt))) + kv('Last seen in keystore', esc(dtFull(c.lastSeenAt))) +
      (c.removedAt ? kv('Removed from keystore', '<b>' + esc(dtFull(c.removedAt)) + '</b>') : '') +
    '</div>' +
    '<p class="muted small" style="margin-top:20px">Renew the entry in Integration Suite under Monitor → Integrations and APIs → Manage Security → Keystore. The change shows here after the next sync.</p>');
}
function exportCertCsv() {
  var rows = S.cache.certRows || [];
  var cols = ['state', 'alias', 'entryType', 'keyType', 'keySize', 'owner', 'subjectDN', 'issuerDN', 'serialNumber', 'validFrom', 'validTo', 'daysLeft'];
  var q = function (v) { v = v == null ? '' : String(v); return '"' + v.split('"').join('""') + '"'; };
  var csv = cols.join(',') + NL + rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); }).join(NL);
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'cpi-certificates.csv';
  a.click();
  toast('Exported ' + rows.length + ' certificates');
}

/* ---------- Ticket pulse ---------- */
S.tf = { view: 'all', grp: '', responder: '', q: '' };
// Ticket pulse time view: 'day' follows the period picker; week / month / year show the last 12 weeks, 12 months or 5 years.
S.tp = 'day';
try { S.tp = localStorage.getItem('cpiec-tkview') || 'day'; } catch (e) {}
var TP = {
  day: { label: 'Daily', span: 'in the selected period', cur: '', prev: '' },
  week: { label: 'Weekly', span: 'in the last 12 weeks', cur: 'This week', prev: 'last week' },
  month: { label: 'Monthly', span: 'in the last 12 months', cur: 'This month', prev: 'last month' },
  year: { label: 'Yearly', span: 'in the last 5 years', cur: 'This year', prev: 'last year' }
};
if (!TP[S.tp]) S.tp = 'day';
function syncRangeVisibility() {
  // Certificates do not depend on the period; Ticket pulse only uses it in the daily view.
  $('#range').hidden = S.tab === 'certs' || (S.tab === 'tickets' && S.tp !== 'day');
}
function setTicketView(tp) {
  S.tp = tp;
  try { localStorage.setItem('cpiec-tkview', tp); } catch (e) {}
  syncRangeVisibility();
  return loadTickets().catch(fail);
}
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(x, unit) {
  var dd = x.slice(8, 10) + '/' + x.slice(5, 7);
  if (unit === 'hour') return dd + ' ' + x.slice(11, 16);
  if (unit === 'week') return 'Wk ' + dd;
  if (unit === 'month') return MONTHS[+x.slice(5, 7) - 1] + ' ' + x.slice(2, 4);
  if (unit === 'year') return x.slice(0, 4);
  return dd;
}
var TK_VIEWS = { all: 'All open', overdue: 'Overdue', soon: 'Due soon', unassigned: 'Unassigned' };

function setTicketBadge(d) {
  var b = $('#tk-badge'), n = d && d.enabled ? d.kpi.overdue : 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}
function ageText(s) {
  if (!s) return '–';
  var h = (Date.now() - new Date(s)) / 3600000;
  return h < 24 ? Math.max(0, Math.round(h)) + ' h' : Math.floor(h / 24) + ' d';
}
function dueText(s) {
  if (!s) return '<span class="muted">–</span>';
  var h = (new Date(s) - Date.now()) / 3600000;
  var rel = Math.abs(h) < 24 ? Math.round(Math.abs(h)) + ' h' : Math.round(Math.abs(h) / 24) + ' d';
  return h < 0 ? '<span class="bad">' + rel + ' overdue</span>' : '<span title="' + esc(dtFull(s)) + '">in ' + rel + '</span>';
}
function tkMatches(t, f, soonHours) {
  var due = t.due_by ? new Date(t.due_by).getTime() : null, now = Date.now();
  if (f.view === 'overdue' && !(due && due < now)) return false;
  if (f.view === 'soon' && !(due && due >= now && due < now + soonHours * 3600000)) return false;
  if (f.view === 'unassigned' && t.responder) return false;
  if (f.grp && (t.grp || '(none)') !== f.grp) return false;
  if (f.responder && (t.responder || '(unassigned)') !== f.responder) return false;
  if (f.q && [t.id, t.subject, t.requester, t.entity, t.category, t.sub_category, t.item, t.status, t.pending_reason].join(' ').toLowerCase().indexOf(f.q) < 0) return false;
  return true;
}
function tkKpi(view, label, value, sub, cls) {
  var attrs = view ? ' click' + (S.tf.view === view ? ' sel' : '') + '" data-tv="' + view + '" role="button" tabindex="0' : '';
  return '<div class="card kpi ' + (cls || '') + attrs + '"><div class="l">' + esc(label) + '</div><div class="v">' + value + '</div><div class="s">' + esc(sub || '') + '</div></div>';
}
function countTable(rows, key, empty, cols) {
  if (!rows.length) return '<div class="empty">' + esc(empty) + '</div>';
  var max = Math.max.apply(null, rows.map(function (r) { return r.n; }));
  return '<table><thead><tr><th>' + esc(cols[0]) + '</th><th class="num">Open</th><th></th>' + (cols[1] ? '<th class="num">' + esc(cols[1]) + '</th>' : '') + '</tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="click" data-' + key + '="' + esc(r.name) + '"><td>' + esc(r.name) + '</td><td class="num">' + fmt(r.n) + '</td><td><div class="bar"><i style="width:' + Math.round(r.n * 100 / max) + '%"></i></div></td>' +
        (cols[1] ? '<td class="num">' + (r.overdue ? '<b class="bad">' + fmt(r.overdue) + '</b>' : '0') + '</td>' : '') + '</tr>';
    }).join('') + '</tbody></table>';
}
function loadTickets() {
  var v = $('#v-tickets');
  if (!v.innerHTML) v.innerHTML = '<div class="empty">Loading…</div>';
  return get('api/tickets/pulse', withRange({ view: S.tp })).then(function (d) {
    setTicketBadge(d);
    if (!d.enabled) {
      v.innerHTML = '<div class="card"><h2>Ticket pulse is not available yet</h2><p class="muted">' + esc(d.reason) + '</p></div>';
      return;
    }
    S.cache.tickets = d;
    var span = TP[S.tp].span;
    v.innerHTML =
      '<div class="filters"><span class="muted small">View</span><div class="seg" role="group" aria-label="View">' +
        Object.keys(TP).map(function (x) { return '<button class="btn' + (x === S.tp ? ' on' : '') + '" data-tp="' + x + '" aria-pressed="' + (x === S.tp) + '">' + TP[x].label + '</button>'; }).join('') +
      '</div><span class="muted small">' + esc(S.tp === 'day' ? 'Uses the period picker at the top.' : 'Created, resolved and first response ' + span + '.') + '</span></div>' +
      (d.stale ? '<div class="card" style="margin-bottom:16px"><b class="bad">The ticket data may be out of date:</b> <span class="muted">the newest ticket change is from ' + esc(d.lastChange ? dt(d.lastChange) : 'never') + ', more than ' + d.staleHours + ' hours ago. Run the n8n workflow "FreshServices Tickets" (and check its Freshservice cookie) to refresh it.</span></div>' : '') +
      '<div class="grid kpis" id="tk-kpis"></div>' +
      '<div class="grid two mt">' +
        '<div class="card"><h2>Created vs. resolved <small>' + esc(span) + '</small></h2><div class="ch"><canvas id="c-tk-flow"></canvas></div></div>' +
        '<div class="card"><h2>Open backlog by age <small>since the ticket was created</small></h2><div class="ch"><canvas id="c-tk-age"></canvas></div></div>' +
      '</div>' +
      '<div class="grid half mt">' +
        '<div class="card"><h2>Open by group <small>click to filter the list</small></h2><div class="scroll">' + countTable(d.byGroup, 'tg', 'No open tickets.', ['Group', 'Overdue']) + '</div></div>' +
        '<div class="card"><h2>Open by responder <small>click to filter the list</small></h2><div class="scroll">' + countTable(d.byResponder, 'tr', 'No open tickets.', ['Responder', 'Overdue']) + '</div></div>' +
      '</div>' +
      '<div class="grid half mt">' +
        '<div class="card"><h2>Open by status</h2><div class="scroll">' + countTable(d.byStatus, 'ts', 'No open tickets.', ['Status']) +
          (d.byPending.length ? '<h3>Pending reasons</h3>' + countTable(d.byPending, 'tp', '', ['Reason']) : '') + '</div></div>' +
        '<div class="card"><h2>Top sub-categories <small>tickets created ' + esc(span) + '</small></h2><div class="scroll">' + countTable(d.bySubCategory, 'tc', 'No tickets created in this period.', ['Sub-category']).replace('<th class="num">Open</th>', '<th class="num">Created</th>') + '</div></div>' +
      '</div>' +
      '<div class="filters mt"><select id="tf-view" aria-label="Show"></select><select id="tf-grp" aria-label="Group"></select><select id="tf-resp" aria-label="Responder"></select>' +
        '<input id="tf-q" type="search" placeholder="Search ticket, subject, category, requester or entity" style="min-width:240px;flex:1">' +
        '<button class="btn" id="tf-clear">Clear filters</button><button class="btn" id="tf-csv">Export CSV</button></div>' +
      '<div class="card"><div class="row" style="margin-bottom:8px"><b id="tk-count"></b><span class="sp"></span><span class="muted small">Newest ticket change ' + esc(dt(d.lastChange)) + '</span></div><div class="scroll" id="tk-tab"></div></div>' +
      '<p class="muted small">Freshservice tickets from the database table the n8n workflow "FreshServices Tickets" fills. Open = any status except Resolved and Closed. Tickets tagged noncharge and changes (Standard, Normal, Emergency) are left out. Due soon = due within ' + d.dueSoonHours + ' hours (TICKETS_DUE_SOON_HOURS).</p>';
    $('#tf-q').value = S.tf.q;
    $$('#v-tickets [data-tp]').forEach(function (b) { b.onclick = function () { if (b.dataset.tp !== S.tp) setTicketView(b.dataset.tp); }; });
    $('#tf-view').onchange = function () { S.tf.view = this.value; renderTickets(); };
    $('#tf-grp').onchange = function () { S.tf.grp = this.value; renderTickets(); };
    $('#tf-resp').onchange = function () { S.tf.responder = this.value; renderTickets(); };
    $('#tf-q').oninput = function () { S.tf.q = this.value.trim().toLowerCase(); renderTickets(); };
    $('#tf-clear').onclick = function () { S.tf = { view: 'all', grp: '', responder: '', q: '' }; $('#tf-q').value = ''; renderTickets(); };
    $('#tf-csv').onclick = exportTicketCsv;
    var pick = function (patch) { return function () { Object.assign(S.tf, patch(this)); renderTickets(); $('#tk-tab').scrollIntoView({ behavior: 'smooth', block: 'center' }); }; };
    $$('#v-tickets tr[data-tg]').forEach(function (t) { t.onclick = pick(function (el) { return { grp: el.dataset.tg, responder: '' }; }); });
    $$('#v-tickets tr[data-tr]').forEach(function (t) { t.onclick = pick(function (el) { return { responder: el.dataset.tr, grp: '' }; }); });
    $$('#v-tickets tr[data-ts], #v-tickets tr[data-tp]').forEach(function (t) { t.onclick = pick(function (el) { return { q: (el.dataset.ts || el.dataset.tp).toLowerCase() }; }); });
    $$('#v-tickets tr[data-tc]').forEach(function (t) { t.classList.remove('click'); });
    drawTickets(d);
    renderTickets();
  });
}
function renderTickets() {
  var d = S.cache.tickets, f = S.tf, k = d.kpi, net = k.created - k.resolved;
  $('#tk-kpis').innerHTML =
    tkKpi('all', 'Open backlog', fmt(k.open), 'all open tickets', '') +
    tkKpi('overdue', 'Overdue', fmt(k.overdue), 'past the due date', k.overdue ? 'alert' : 'good') +
    tkKpi('soon', 'Due soon', fmt(k.dueSoon), 'due within ' + d.dueSoonHours + ' hours', k.dueSoon ? 'warn' : '') +
    tkKpi('unassigned', 'Unassigned', fmt(k.unassigned), 'open, no responder', k.unassigned ? 'warn' : '') +
    createdKpi(d) +
    tkKpi('', 'First response', k.frtMedianH == null ? '–' : k.frtMedianH + ' h', 'median, tickets created ' + TP[S.tp].span, '');
  $$('#tk-kpis [data-tv]').forEach(function (el) {
    var go = function () { S.tf.view = el.dataset.tv; renderTickets(); };
    el.onclick = go;
    el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  });
  $('#tf-view').innerHTML = opts(Object.keys(TK_VIEWS).map(function (x) { return [x, TK_VIEWS[x]]; }), f.view);
  $('#tf-grp').innerHTML = opts([['', 'All groups']].concat(d.byGroup.map(function (g) { return [g.name, g.name]; })), f.grp);
  $('#tf-resp').innerHTML = opts([['', 'All responders']].concat(d.byResponder.map(function (r) { return [r.name, r.name]; })), f.responder);
  if (document.activeElement !== $('#tf-q')) $('#tf-q').value = f.q;
  var rows = d.open.filter(function (t) { return tkMatches(t, f, d.dueSoonHours); });
  S.cache.ticketRows = rows;
  $('#tk-count').textContent = fmt(rows.length) + ' of ' + fmt(k.open) + ' open tickets' + (d.open.length < k.open ? ' (list shows the first ' + fmt(d.open.length) + ')' : '');
  if (!rows.length) { $('#tk-tab').innerHTML = '<div class="empty">No open tickets match these filters.</div>'; return; }
  $('#tk-tab').innerHTML = '<table><thead><tr><th>Ticket</th><th>Subject</th><th>Category</th><th>Sub-category</th><th>Item</th><th>Status</th><th>Group</th><th>Responder</th><th class="num">Age</th><th>Due</th><th>Last comment</th></tr></thead><tbody>' +
    rows.map(function (t, i) {
      return '<tr class="click" data-i="' + i + '"><td class="nowrap"><b>' + (t.link ? '<a href="' + esc(t.link) + '" target="_blank" rel="noopener" title="Open in Freshservice" data-ext>' + esc(t.id) + ' ↗</a>' : esc(t.id)) + '</b>' + (t.type ? '<div class="muted small">' + esc(t.type) + '</div>' : '') + '</td>' +
        '<td>' + esc(short(t.subject, 120)) + (t.requester || t.entity ? '<div class="muted small">' + esc([t.requester, t.entity].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
        '<td class="small">' + esc(t.category || '') + '</td><td class="small">' + esc(t.sub_category || '') + '</td><td class="small">' + esc(t.item || '') + '</td>' +
        '<td>' + pill(t.status, 'tk') + (t.pending_reason ? '<div class="muted small">' + esc(t.pending_reason) + '</div>' : '') + '</td>' +
        '<td class="small">' + esc(t.grp || '') + '</td><td class="small">' + (t.responder ? esc(t.responder) : '<span class="bad">Unassigned</span>') + '</td>' +
        '<td class="num nowrap">' + ageText(t.created_at) + '</td><td class="nowrap">' + dueText(t.due_by) + '</td>' +
        '<td class="small nowrap">' + (t.last_comment_at ? esc(dt(t.last_comment_at)) + '<div class="muted">' + esc([t.last_comment_by, t.last_comment_type].filter(Boolean).join(' · ')) + '</div>' : '<span class="muted">–</span>') + '</td></tr>';
    }).join('') + '</tbody></table>';
  $$('#tk-tab tr[data-i]').forEach(function (t) { t.onclick = function (e) { if (e.target.closest('[data-ext]')) return; openTicket(rows[+t.dataset.i].id); }; });
}
function createdKpi(d) {
  var k = d.kpi, net = k.created - k.resolved, tp = TP[S.tp];
  if (S.tp === 'day' || !d.series.length) {
    return tkKpi('', 'Created', fmt(k.created), 'in period · ' + fmt(k.resolved) + ' resolved (' + (net > 0 ? '+' : '') + fmt(net) + ' net)', '');
  }
  var cur = d.series[d.series.length - 1], prev = d.series[d.series.length - 2];
  return tkKpi('', tp.cur + ': created', fmt(cur.created), fmt(cur.resolved) + ' resolved' + (prev ? ' · ' + tp.prev + ' ' + fmt(prev.created) + ' created, ' + fmt(prev.resolved) + ' resolved' : ''), '');
}
function drawTickets(d) {
  if (!window.Chart) return;
  var grid = css('--line');
  Chart.defaults.color = css('--muted');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  var unit = d.range.unit;
  var labels = d.series.map(function (p) { return bucketLabel(p.bucket, unit); });
  chart('c-tk-flow', {
    type: 'bar',
    data: { labels: labels, datasets: [
      { label: 'Created', data: d.series.map(function (p) { return p.created; }), backgroundColor: css('--accent'), borderRadius: 2 },
      { label: 'Resolved / closed', data: d.series.map(function (p) { return p.resolved; }), backgroundColor: css('--ok'), borderRadius: 2 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { precision: 0 } } } }
  });
  chart('c-tk-age', {
    type: 'bar',
    data: { labels: d.aging.map(function (a) { return a.name; }), datasets: [{ data: d.aging.map(function (a) { return a.n; }), backgroundColor: d.aging.map(function (a, i) { return i >= 3 ? css('--bad') : i === 2 ? css('--warn') : css('--accent'); }), borderRadius: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: grid }, ticks: { precision: 0 } } } }
  });
}
function openTicket(id) {
  openDrawer(drawerHead('Ticket ' + id) + '<div class="empty">Loading…</div>');
  get('api/tickets/' + encodeURIComponent(id)).then(function (t) {
    openDrawer(drawerHead('Ticket ' + t.id) +
      '<p style="margin-top:0"><b>' + esc(t.subject || '(no subject)') + '</b></p>' +
      '<div class="row" style="margin-bottom:12px">' + pill(t.status, 'tk') + (t.pending_reason ? '<span class="muted">' + esc(t.pending_reason) + '</span>' : '') + '<span class="sp"></span>' +
        (t.link ? '<a class="btn sm" href="' + esc(t.link) + '" target="_blank" rel="noopener">Open in Freshservice ↗</a>' : '') + '</div>' +
      '<div class="kv">' +
        kv('Type', esc(t.type)) + kv('Group', esc(t.grp)) + kv('Responder', t.responder ? esc(t.responder) : '<span class="bad">Unassigned</span>') +
        kv('Requester', esc(t.requester)) + kv('Impacted entity', esc(t.entity)) +
        kv('Category', esc(t.category)) + kv('Sub-category', esc(t.sub_category)) + kv('Item', esc(t.item)) +
        kv('Created', esc(dtFull(t.created_at)) + ' <span class="muted">(' + ageText(t.created_at) + ' ago)</span>') +
        kv('Due', t.due_by ? esc(dtFull(t.due_by)) + ' · ' + dueText(t.due_by) : '') +
        kv('Last updated', esc(dtFull(t.updated_at))) +
        kv('First response', t.frt_secs ? Math.round(t.frt_secs / 360) / 10 + ' h' : '') +
        kv('Tags', esc(t.tags)) +
      '</div>' +
      (t.last_comment_at ? '<h3>Last comment</h3><div class="box"><div class="muted small">' + esc(dtFull(t.last_comment_at)) + ' · ' + esc([t.last_comment_by, t.last_comment_type].filter(Boolean).join(' · ')) + '</div><div class="txt" style="margin-top:6px">' + esc(t.last_comment_text || '') + '</div></div>' : '') +
      (t.details ? '<h3>Description</h3><div class="box rich" id="tk-desc"></div>' : ''));
    if (t.details) $('#tk-desc').appendChild(safeHtml(t.details));
  }).catch(function (e) { openDrawer(drawerHead('Ticket ' + id) + '<div class="empty bad">' + esc(e.message) + '</div>'); });
}
// Freshservice descriptions are HTML. Keep only formatting tags and safe links; drop scripts, styles, event
// handlers and images (the page's security policy blocks outside images anyway).
var SAFE_TAGS = ['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'A', 'PRE', 'CODE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'FONT', 'SMALL', 'BIG', 'DL', 'DT', 'DD'];
var DROP_TAGS = ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE'];
function safeHtml(html) {
  var doc = new DOMParser().parseFromString('<body>' + String(html) + '</body>', 'text/html');
  var out = document.createDocumentFragment();
  function copy(src, dst) {
    Array.prototype.forEach.call(src.childNodes, function (n) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1 || DROP_TAGS.indexOf(n.tagName) >= 0) return;
      if (n.tagName === 'IMG') { dst.appendChild(document.createTextNode(n.getAttribute('alt') ? '[image: ' + n.getAttribute('alt') + ']' : '[image]')); return; }
      if (SAFE_TAGS.indexOf(n.tagName) < 0) { copy(n, dst); return; } // unknown tag: keep its text
      var el = document.createElement(n.tagName === 'FONT' ? 'span' : n.tagName.toLowerCase());
      if (n.tagName === 'A') {
        var href = (n.getAttribute('href') || '').trim();
        if (/^(https?:|mailto:)/i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
      ['colspan', 'rowspan'].forEach(function (a) { var v = n.getAttribute(a); if (v && /^[0-9]{1,3}$/.test(v)) el.setAttribute(a, v); });
      copy(n, el);
      dst.appendChild(el);
    });
  }
  copy(doc.body, out);
  return out;
}
function exportTicketCsv() {
  var rows = S.cache.ticketRows || [];
  var cols = ['id', 'subject', 'type', 'status', 'pending_reason', 'grp', 'responder', 'requester', 'entity', 'category', 'sub_category', 'item', 'created_at', 'due_by', 'updated_at', 'last_comment_at', 'last_comment_by'];
  var q = function (v) { v = v == null ? '' : String(v); return '"' + v.split('"').join('""') + '"'; };
  var csv = cols.join(',') + NL + rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); }).join(NL);
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'open-tickets.csv';
  a.click();
  toast('Exported ' + rows.length + ' tickets');
}

/* ---------- Start ---------- */
document.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
$('#ov').onclick = closeDrawer;
$$('#tabs button').forEach(function (b) { b.onclick = function () { show(b.dataset.t); }; });
try { var savedRange = localStorage.getItem('cpiec-range'); if (savedRange) $('#range').value = savedRange; } catch (e) {}
$('#range').onchange = function () { try { localStorage.setItem('cpiec-range', this.value); } catch (e) {} S.ef.offset = 0; load(); };
$('#refresh').onclick = refreshAll;
// Back from the Kanban sign-in (see /kanban/oauth/callback).
(function () {
  var q = new URLSearchParams(window.location.search), k = q.get('kanban');
  if (!k) return;
  history.replaceState(null, '', window.location.pathname);
  setTimeout(function () { if (k === 'connected') toast('Kanban board connected'); else toast('Kanban sign-in failed: ' + (q.get('msg') || 'unknown error'), true); }, 300);
})();
loadMeta().then(function () { return show('dash'); }).catch(fail);

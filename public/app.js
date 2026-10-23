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
      if (!r.ok) throw new Error(j.error || ('Server returned HTTP ' + r.status));
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
  ['dash', 'errors', 'known', 'cats'].forEach(function (t) { $('#v-' + t).hidden = t !== tab; });
  window.scrollTo(0, 0);
  return load();
}
function load() { var f = { dash: loadDash, errors: loadErrors, known: loadKnown, cats: loadCats }[S.tab]; return f().catch(fail); }
function loadMeta() {
  return get('api/meta').then(function (m) { S.meta = m; $('#polled').textContent = m.lastPolled ? 'Data polled ' + dt(m.lastPolled) : ''; });
}
function refreshAll() { S.cache.known = null; return loadMeta().then(load).catch(fail); }

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
      '<h3>Error text</h3><pre class="err">' + esc(d.errormsg || '(no error text returned by CPI)') + '</pre>' +
      (d.attributes.length ? '<h3>Custom header properties</h3><table><tbody>' + d.attributes.map(function (x) { return '<tr><td class="muted">' + esc(x.name) + '</td><td class="mono">' + esc(x.value) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (d.related.length ? '<h3>Other messages with the same correlation ID</h3><table><tbody>' + d.related.map(function (r) { return '<tr class="click" data-g="' + esc(r.message_guid) + '"><td class="nowrap">' + dt(r.log_start) + '</td><td>' + esc(r.flow) + '</td><td>' + pill(r.status) + '</td></tr>'; }).join('') + '</tbody></table>' : '');
    openDrawer(h);
    var dc = $('#d-cat'); if (dc) dc.onclick = function () { openCategory({ category_expression: suggestRegex(d.errormsg) }); };
    var da = $('#d-an'); if (da) da.onclick = function () { openAnalysis({ integration_flow_name: m.flow, errormessage: suggestPattern(d.errormsg), status: 'Open' }); };
    var de = $('#d-edit'); if (de) de.onclick = function () { openAnalysis(a); };
    $$('#dr tr[data-g]').forEach(function (t) { t.onclick = function () { openDetail(t.dataset.g); }; });
  }).catch(fail);
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

/* ---------- Start ---------- */
document.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
$('#ov').onclick = closeDrawer;
$$('#tabs button').forEach(function (b) { b.onclick = function () { show(b.dataset.t); }; });
try { var savedRange = localStorage.getItem('cpiec-range'); if (savedRange) $('#range').value = savedRange; } catch (e) {}
$('#range').onchange = function () { try { localStorage.setItem('cpiec-range', this.value); } catch (e) {} S.ef.offset = 0; load(); };
$('#refresh').onclick = refreshAll;
loadMeta().then(function () { return show('dash'); }).catch(fail);

'use strict';

/*
 * Ticket pulse: reads the Freshservice tickets table that the n8n workflow "FreshServices Tickets" fills
 * (one row per ticket, upserted by human_display_id). The app never writes to it.
 *
 * The table belongs to n8n, so its columns can differ between installs. The app looks the columns up first and
 * reads a missing optional column as NULL instead of failing.
 */

// Name used in the queries -> column in the tickets table. `required` columns must exist.
const COLUMNS = {
  id: { col: 'human_display_id', type: 'text', required: true },
  status: { col: 'status_name', type: 'text', required: true },
  created_at: { col: 'created_at', type: 'timestamptz', required: true },
  updated_at: { col: 'updated_at', type: 'timestamptz' },
  due_by: { col: 'due_by', type: 'timestamptz' },
  subject: { col: 'subject', type: 'text' },
  type: { col: 'type', type: 'text' },
  category: { col: 'category', type: 'text' },
  sub_category: { col: 'sub_category', type: 'text' },
  pending_reason: { col: 'pending_reason', type: 'text' },
  grp: { col: 'group', type: 'text' },
  responder: { col: 'responder', type: 'text' },
  requester: { col: 'requester', type: 'text' },
  entity: { col: 'impacted_entity', type: 'text' },
  frt_secs: { col: 'first_resp_time_in_secs', type: 'numeric' },
  resolution_secs: { col: 'resolution_time_in_secs', type: 'numeric' },
  tags: { col: 'tags', type: 'text' },
  change_process_type: { col: 'change_process_type', type: 'text' },
  details: { col: 'details', type: 'text' },
  last_comment_at: { col: 'last_comment_at', type: 'timestamptz' },
  last_comment_by: { col: 'last_comment_by', type: 'text' },
  last_comment_type: { col: 'last_comment_type', type: 'text' },
  last_comment_text: { col: 'last_comment_text', type: 'text' },
};

const CLOSED_STATUSES = ['Resolved', 'Closed'];
// Left out of Ticket pulse: non-chargeable tickets (tag) and change tickets (Change Process Type).
const EXCLUDED_TAGS = ['noncharge', 'noncharged'];
const EXCLUDED_CHANGE_TYPES = ['Standard', 'Normal', 'Emergency'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Parses TICKETS_TABLE ("tickets" or "schema.tickets"); throws when it is not a plain name. */
function parseTableName(name) {
  const parts = String(name || '').split('.');
  if (parts.length > 2 || !parts.every((p) => IDENT.test(p))) {
    throw new Error('TICKETS_TABLE must be a table name such as tickets or public.tickets');
  }
  return { parts, sql: parts.map(quoteIdent).join('.') };
}

/** Text after the prefix in "INC-123" / "SR-45", used to build the link to Freshservice. */
function ticketNumber(id) {
  const m = /(\d+)$/.exec(String(id || ''));
  return m ? m[1] : '';
}

function ticketLink(template, id) {
  if (!template || !id) return null;
  return template.replace('{id}', encodeURIComponent(id)).replace('{number}', encodeURIComponent(ticketNumber(id)));
}

function createTicketStore({ pool, config }) {
  const table = parseTableName(config.tickets.table);
  const closedList = CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

  // Returns { ok, select } or { ok: false, reason } when the table or a required column is missing.
  async function source() {
    const { rows } = await pool.query(
      `SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
      [table.parts.join('.')],
    );
    if (!rows.length) {
      return { ok: false, reason: `The tickets table "${config.tickets.table}" was not found in the database. Run the n8n workflow "FreshServices Tickets" once, or set TICKETS_TABLE.` };
    }
    const have = new Set(rows.map((r) => r.attname));
    const missing = Object.values(COLUMNS).filter((c) => c.required && !have.has(c.col)).map((c) => c.col);
    if (missing.length) {
      return { ok: false, reason: `The tickets table "${config.tickets.table}" has no column ${missing.join(', ')}.` };
    }
    const select = Object.entries(COLUMNS).map(([alias, c]) => (have.has(c.col)
      ? `NULLIF(${quoteIdent(c.col)}::text, '')::${c.type} AS ${alias}`
      : `NULL::${c.type} AS ${alias}`)).join(',\n    ');
    // Same exclusions as the n8n fetch, applied again here because a ticket can get the tag or change type
    // after it was stored.
    const where = [];
    if (have.has('tags')) {
      where.push(`NOT EXISTS (SELECT 1 FROM unnest(string_to_array(lower(COALESCE(${quoteIdent('tags')}::text, '')), ',')) AS tg
                    WHERE btrim(tg) IN (${EXCLUDED_TAGS.map((t) => `'${t}'`).join(', ')}))`);
    }
    if (have.has('change_process_type')) {
      where.push(`COALESCE(btrim(${quoteIdent('change_process_type')}::text), '') NOT IN (${EXCLUDED_CHANGE_TYPES.map((t) => `'${t}'`).join(', ')})`);
    }
    return { ok: true, select, where: where.length ? 'WHERE ' + where.join('\n    AND ') : '' };
  }

  const tk = (src) => `tk AS (
  SELECT ${src.select},
    COALESCE(${quoteIdent(COLUMNS.status.col)}, '') IN (${closedList}) AS closed
  FROM ${table.sql}
  ${src.where})`;

  async function pulse({ from, to, tz }) {
    const src = await source();
    if (!src.ok) return { enabled: false, reason: src.reason };
    const sql = `WITH p AS (SELECT $1::jsonb AS j),
rng AS (
  SELECT COALESCE(NULLIF(j->>'from', '')::timestamptz, now() - interval '7 days') AS f,
         COALESCE(NULLIF(j->>'to', '')::timestamptz, now()) AS t,
         COALESCE(NULLIF(j->>'tz', ''), 'Asia/Bangkok') AS tz,
         (j->>'soonHours')::int AS soon
  FROM p),
${tk(src)},
o AS (SELECT tk.*, now() - created_at AS age FROM tk WHERE NOT closed),
created AS (SELECT tk.* FROM tk, rng WHERE created_at >= rng.f AND created_at < rng.t),
resolved AS (SELECT tk.* FROM tk, rng WHERE closed AND updated_at >= rng.f AND updated_at < rng.t),
b AS (SELECT CASE WHEN t - f <= interval '3 days' THEN 'hour' ELSE 'day' END AS unit FROM rng),
buckets AS (
  SELECT generate_series(date_trunc(b.unit, rng.f AT TIME ZONE rng.tz), date_trunc(b.unit, rng.t AT TIME ZONE rng.tz),
                         ('1 ' || b.unit)::interval) AS bk
  FROM rng, b)
SELECT json_build_object(
  'range', (SELECT json_build_object('from', f, 'to', t, 'unit', (SELECT unit FROM b)) FROM rng),
  'lastChange', (SELECT max(updated_at) FROM tk),
  'total', (SELECT count(*) FROM tk),
  'kpi', json_build_object(
    'open', (SELECT count(*) FROM o),
    'overdue', (SELECT count(*) FROM o WHERE due_by < now()),
    'dueSoon', (SELECT count(*) FROM o, rng WHERE due_by >= now() AND due_by < now() + make_interval(hours => rng.soon)),
    'unassigned', (SELECT count(*) FROM o WHERE COALESCE(responder, '') = ''),
    'created', (SELECT count(*) FROM created),
    'resolved', (SELECT count(*) FROM resolved),
    'frtMedianH', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY frt_secs) / 3600)::numeric, 1)
                   FROM created WHERE frt_secs > 0),
    'resolutionMedianH', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY resolution_secs) / 3600)::numeric, 1)
                          FROM resolved WHERE resolution_secs > 0)),
  'series', (SELECT COALESCE(json_agg(x ORDER BY x.bucket), '[]') FROM (
      SELECT to_char(buckets.bk, 'YYYY-MM-DD"T"HH24:00') AS bucket,
             (SELECT count(*) FROM created, rng, b WHERE date_trunc(b.unit, created.created_at AT TIME ZONE rng.tz) = buckets.bk) AS created,
             (SELECT count(*) FROM resolved, rng, b WHERE date_trunc(b.unit, resolved.updated_at AT TIME ZONE rng.tz) = buckets.bk) AS resolved
      FROM buckets) x),
  'aging', (SELECT json_agg(json_build_object('name', name, 'n', n) ORDER BY ord) FROM (
      SELECT v.ord, v.name, (SELECT count(*) FROM o WHERE o.age >= v.lo AND (v.hi IS NULL OR o.age < v.hi)) AS n
      FROM (VALUES (1, '< 1 day', interval '0', interval '1 day'), (2, '1-7 days', interval '1 day', interval '7 days'),
                   (3, '7-30 days', interval '7 days', interval '30 days'), (4, '30-90 days', interval '30 days', interval '90 days'),
                   (5, '> 90 days', interval '90 days', NULL)) v(ord, name, lo, hi)) x),
  'byStatus', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]') FROM (
      SELECT COALESCE(status, '(none)') AS name, count(*) AS n FROM o GROUP BY 1) x),
  'byPending', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]') FROM (
      SELECT pending_reason AS name, count(*) AS n FROM o WHERE COALESCE(pending_reason, '') <> '' GROUP BY 1) x),
  'byGroup', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]') FROM (
      SELECT COALESCE(grp, '(none)') AS name, count(*) AS n, count(*) FILTER (WHERE due_by < now()) AS overdue FROM o GROUP BY 1) x),
  'byResponder', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]') FROM (
      SELECT COALESCE(NULLIF(responder, ''), '(unassigned)') AS name, count(*) AS n,
             count(*) FILTER (WHERE due_by < now()) AS overdue, min(created_at) AS oldest
      FROM o GROUP BY 1) x),
  'bySubCategory', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.name), '[]') FROM (
      SELECT COALESCE(sub_category, category, '(none)') AS name, count(*) AS n FROM created GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10) x),
  'open', (SELECT COALESCE(json_agg(x), '[]') FROM (
      SELECT id, subject, type, status, pending_reason, grp, responder, requester, entity, sub_category,
             created_at, updated_at, due_by, last_comment_at, last_comment_by, last_comment_type
      FROM o
      ORDER BY (due_by < now()) DESC NULLS LAST, due_by NULLS LAST, created_at
      LIMIT 1000) x)
) AS result`;
    const { rows } = await pool.query(sql, [JSON.stringify({ from, to, tz, soonHours: config.tickets.dueSoonHours })]);
    const data = rows[0].result;
    data.open.forEach((t) => { t.link = ticketLink(config.tickets.linkTemplate, t.id); });
    const last = data.lastChange ? Date.parse(data.lastChange) : null;
    return {
      enabled: true,
      ...data,
      dueSoonHours: config.tickets.dueSoonHours,
      staleHours: config.tickets.staleHours,
      stale: !last || Date.now() - last > config.tickets.staleHours * 3600000,
    };
  }

  async function ticket(id) {
    const src = await source();
    if (!src.ok) return null;
    const { rows } = await pool.query(`WITH ${tk(src)} SELECT row_to_json(tk) AS t FROM tk WHERE id = $1 LIMIT 1`, [id]);
    if (!rows.length) return null;
    const t = rows[0].t;
    t.link = ticketLink(config.tickets.linkTemplate, t.id);
    return t;
  }

  return { pulse, ticket };
}

module.exports = { createTicketStore, parseTableName, ticketLink, CLOSED_STATUSES, EXCLUDED_TAGS, EXCLUDED_CHANGE_TYPES };

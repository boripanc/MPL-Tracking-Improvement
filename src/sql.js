'use strict';

/*
 * All queries take a single JSON parameter ($1::jsonb, aliased as p.j) and return one row
 * with a `result` column. Values are always read from $1, never concatenated into SQL.
 *
 * Matching rules are the same as the existing `errorscenario` view:
 *   - category:    error text ~* error_category.category_expression (case-insensitive regex);
 *                  optional integration_flow_name restricts the rule to one iFlow;
 *                  when several match, the lowest error_id wins.
 *   - known error: error text LIKE '%' || error_analyzed.errormessage || '%' and same iFlow
 *                  (an empty iFlow on the known error matches any iFlow);
 *                  when several match, the lowest ea_id wins.
 */

const CATEGORY_MATCH = `
    COALESCE(ec.category_expression, '') <> '' AND ei.errormsg ~* ec.category_expression
    AND (COALESCE(ec.integration_flow_name, '') = '' OR ec.integration_flow_name = m.integration_flow_name)`;

const ANALYSIS_MATCH = `
    COALESCE(ea.errormessage, '') <> '' AND ei.errormsg LIKE '%' || ea.errormessage || '%'
    AND (COALESCE(ea.integration_flow_name, '') = '' OR ea.integration_flow_name = m.integration_flow_name)`;

// Errors in the requested period, enriched with category and known error.
const BASE = `p AS (SELECT $1::jsonb AS j),
rng AS (
  SELECT COALESCE(NULLIF(j->>'from', '')::timestamptz, now() - interval '7 days') AS f,
         COALESCE(NULLIF(j->>'to', '')::timestamptz, now()) AS t,
         COALESCE(NULLIF(j->>'tz', ''), 'Asia/Bangkok') AS tz
  FROM p),
e AS (
  SELECT m.message_guid, m.correlation_id, m.log_start, m.integration_flow_name AS flow, m.status,
         m.artifact_details->>'PackageName' AS package, ei.errormsg,
         c.error_id, c.category_name, a.ea_id, a.rootcause, a.status AS ea_status
  FROM message_processing_logs m
  CROSS JOIN rng
  LEFT JOIN error_information ei ON ei.message_guid = m.message_guid
  LEFT JOIN LATERAL (
    SELECT ec.error_id, ec.category_name FROM error_category ec
    WHERE ${CATEGORY_MATCH}
    ORDER BY ec.error_id LIMIT 1) c ON true
  LEFT JOIN LATERAL (
    SELECT ea.ea_id, ea.rootcause, ea.status FROM error_analyzed ea
    WHERE ${ANALYSIS_MATCH}
    ORDER BY ea.ea_id LIMIT 1) a ON true
  WHERE m.log_start >= rng.f AND m.log_start < rng.t)`;

const meta = `WITH p AS (SELECT $1::jsonb AS j)
SELECT json_build_object(
  'flows', (SELECT COALESCE(json_agg(f ORDER BY f), '[]') FROM (
      SELECT DISTINCT integration_flow_name AS f FROM message_processing_logs WHERE integration_flow_name IS NOT NULL) x),
  'categories', (SELECT COALESCE(json_agg(json_build_object('error_id', error_id, 'name', category_name) ORDER BY error_id), '[]') FROM error_category),
  'lastPolled', (SELECT max(polled_at) FROM message_processing_logs),
  'oldest', (SELECT min(log_start) FROM message_processing_logs)
) AS result`;

const dashboard = `WITH ${BASE},
b AS (SELECT CASE WHEN (SELECT t - f FROM rng) <= interval '3 days' THEN 'hour' ELSE 'day' END AS unit)
SELECT json_build_object(
  'range', (SELECT json_build_object('from', f, 'to', t, 'unit', (SELECT unit FROM b)) FROM rng),
  'kpi', (SELECT json_build_object(
      'total', count(*), 'correlations', count(DISTINCT correlation_id), 'flows', count(DISTINCT flow),
      'categorized', count(*) FILTER (WHERE error_id IS NOT NULL), 'known', count(*) FILTER (WHERE ea_id IS NOT NULL),
      'unknown', count(*) FILTER (WHERE ea_id IS NULL), 'resolved', count(*) FILTER (WHERE ea_status = 'Resolved'),
      'failed', count(*) FILTER (WHERE status = 'FAILED'), 'escalated', count(*) FILTER (WHERE status = 'ESCALATED'),
      'retry', count(*) FILTER (WHERE status = 'RETRY')) FROM e),
  'series', (SELECT COALESCE(json_agg(x ORDER BY x.bucket), '[]') FROM (
      SELECT to_char(date_trunc((SELECT unit FROM b), e.log_start AT TIME ZONE (SELECT tz FROM rng)), 'YYYY-MM-DD"T"HH24:00') AS bucket,
             count(*) FILTER (WHERE ea_id IS NOT NULL) AS known, count(*) FILTER (WHERE ea_id IS NULL) AS unknown
      FROM e GROUP BY 1) x),
  'byCategory', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]') FROM (
      SELECT COALESCE(category_name, 'Uncategorized') AS name, error_id, count(*) AS n FROM e GROUP BY 1, 2) x),
  'byFlow', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]') FROM (
      SELECT flow, max(package) AS package, count(*) AS n, count(*) FILTER (WHERE ea_id IS NULL) AS unknown, max(log_start) AS last_seen
      FROM e GROUP BY flow ORDER BY count(*) DESC LIMIT 15) x),
  'topUnknown', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]') FROM (
      SELECT flow, sig, count(*) AS n, max(log_start) AS last_seen, max(category_name) AS category,
             (array_agg(message_guid ORDER BY log_start DESC))[1] AS guid,
             (array_agg(left(errormsg, 1500) ORDER BY log_start DESC))[1] AS sample
      FROM (
        -- Group errors that differ only by IDs: any word containing a digit becomes '#'.
        SELECT e.*, left(regexp_replace(regexp_replace(COALESCE(errormsg, '(no error text)'),
                 '[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*', '#', 'g'), '[[:space:]]+', ' ', 'g'), 180) AS sig
        FROM e WHERE ea_id IS NULL) u
      GROUP BY flow, sig ORDER BY count(*) DESC LIMIT 15) x),
  'openIssues', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC, x.ea_id), '[]') FROM (
      SELECT ea.ea_id, ea.integration_flow_name AS flow, ea.rootcause, ea.status, count(e.message_guid) AS n, max(e.log_start) AS last_seen
      FROM error_analyzed ea LEFT JOIN e ON e.ea_id = ea.ea_id
      WHERE ea.status <> 'Resolved'
      GROUP BY ea.ea_id, ea.integration_flow_name, ea.rootcause, ea.status
      ORDER BY count(e.message_guid) DESC LIMIT 15) x)
) AS result`;

const errors = `WITH ${BASE},
fl AS (SELECT e.* FROM e, p WHERE
  (COALESCE(j->>'flow', '') = '' OR e.flow = j->>'flow')
  AND (COALESCE(j->>'status', '') = '' OR e.status = j->>'status')
  AND (COALESCE(j->>'category', '') = '' OR (j->>'category' = '__none' AND e.error_id IS NULL) OR e.error_id::text = j->>'category')
  AND (COALESCE(j->>'analysis', '') = '' OR (j->>'analysis' = '__none' AND e.ea_id IS NULL)
       OR (j->>'analysis' = '__known' AND e.ea_id IS NOT NULL) OR e.ea_status = j->>'analysis')
  AND (COALESCE(j->>'q', '') = '' OR e.errormsg ILIKE '%' || (j->>'q') || '%' OR e.flow ILIKE '%' || (j->>'q') || '%'
       OR e.correlation_id = j->>'q' OR e.message_guid = j->>'q'))
SELECT json_build_object(
  'total', (SELECT count(*) FROM fl),
  'rows', (SELECT COALESCE(json_agg(x ORDER BY x.log_start DESC), '[]') FROM (
     SELECT message_guid, correlation_id, log_start, flow, status, error_id, category_name, ea_id, ea_status, rootcause,
            left(errormsg, 300) AS errormsg
     FROM fl ORDER BY log_start DESC
     LIMIT (SELECT (j->>'limit')::int FROM p) OFFSET (SELECT (j->>'offset')::int FROM p)) x)
) AS result`;

const errorDetail = `WITH p AS (SELECT $1::jsonb AS j),
m AS (SELECT m.* FROM message_processing_logs m, p WHERE m.message_guid = j->>'guid'),
ei AS (SELECT i.errormsg FROM error_information i, m WHERE i.message_guid = m.message_guid)
SELECT json_build_object(
  'mpl', (SELECT json_build_object('message_guid', message_guid, 'correlation_id', correlation_id, 'flow', integration_flow_name,
      'status', status, 'custom_status', custom_status, 'log_start', log_start, 'log_end', log_end, 'sender', sender,
      'receiver', receiver, 'application_message_id', application_message_id, 'application_message_type', application_message_type,
      'package', artifact_details->>'PackageName', 'link', raw->>'AlternateWebLink') FROM m),
  'errormsg', (SELECT errormsg FROM ei),
  'category', (SELECT row_to_json(c) FROM (
      SELECT ec.error_id, ec.category_name, ec.category_expression FROM error_category ec, m, ei
      WHERE ${CATEGORY_MATCH}
      ORDER BY ec.error_id LIMIT 1) c),
  'analysis', (SELECT row_to_json(a) FROM (
      SELECT ea.*, (SELECT COALESCE(json_agg(cm ORDER BY cm.created_at), '[]') FROM error_analyzed_comments cm WHERE cm.ea_id = ea.ea_id) AS comments
      FROM error_analyzed ea, m, ei
      WHERE ${ANALYSIS_MATCH}
      ORDER BY ea.ea_id LIMIT 1) a),
  'attributes', (SELECT COALESCE(json_agg(json_build_object('name', ca.name, 'value', ca.value) ORDER BY ca.name), '[]')
      FROM customs_attributes ca, m WHERE ca.message_guid = m.message_guid),
  'related', (SELECT COALESCE(json_agg(r ORDER BY r.log_start), '[]') FROM (
      SELECT o.message_guid, o.integration_flow_name AS flow, o.status, o.log_start FROM message_processing_logs o, m
      WHERE o.correlation_id = m.correlation_id AND o.message_guid <> m.message_guid ORDER BY o.log_start LIMIT 30) r)
) AS result`;

const knownErrors = `WITH ${BASE},
hits AS (SELECT ea_id, count(*) AS n, max(log_start) AS last_seen FROM e WHERE ea_id IS NOT NULL GROUP BY ea_id)
SELECT COALESCE(json_agg(x ORDER BY x.sort_status, x.n DESC, x.ea_id), '[]') AS result FROM (
  SELECT ea.*, COALESCE(h.n, 0) AS n, h.last_seen,
         CASE ea.status WHEN 'Open' THEN 1 WHEN 'In Progress' THEN 2 WHEN 'Monitoring' THEN 3 ELSE 4 END AS sort_status,
         (SELECT COALESCE(json_agg(cm ORDER BY cm.created_at), '[]') FROM error_analyzed_comments cm WHERE cm.ea_id = ea.ea_id) AS comments
  FROM error_analyzed ea LEFT JOIN hits h ON h.ea_id = ea.ea_id) x`;

// Insert when ea_id is null, otherwise update. A status change adds an automatic comment.
const saveKnownError = `WITH p AS (SELECT $1::jsonb AS j),
old AS (SELECT ea.ea_id, ea.status FROM error_analyzed ea, p WHERE ea.ea_id = (j->>'ea_id')::int),
upd AS (
  UPDATE error_analyzed ea SET errormessage = j->>'errormessage', integration_flow_name = NULLIF(j->>'integration_flow_name', ''),
    rootcause = NULLIF(j->>'rootcause', ''), solutions = NULLIF(j->>'solutions', ''), status = j->>'status'
  FROM p WHERE ea.ea_id = (j->>'ea_id')::int RETURNING ea.*),
ins AS (
  INSERT INTO error_analyzed (errormessage, integration_flow_name, rootcause, solutions, status)
  SELECT j->>'errormessage', NULLIF(j->>'integration_flow_name', ''), NULLIF(j->>'rootcause', ''), NULLIF(j->>'solutions', ''), j->>'status'
  FROM p WHERE j->>'ea_id' IS NULL RETURNING *),
cmt AS (
  INSERT INTO error_analyzed_comments (ea_id, comment)
  SELECT u.ea_id, 'Status changed from ' || o.status || ' to ' || u.status || COALESCE(' by ' || (SELECT j->>'user' FROM p), '')
  FROM upd u JOIN old o ON o.ea_id = u.ea_id
  WHERE o.status IS DISTINCT FROM u.status RETURNING id)
SELECT (SELECT row_to_json(x) FROM (SELECT * FROM upd UNION ALL SELECT * FROM ins) x LIMIT 1) AS result,
       (SELECT count(*) FROM cmt) AS status_comments`;

const deleteKnownError = `WITH p AS (SELECT $1::jsonb AS j),
d AS (DELETE FROM error_analyzed ea USING p WHERE ea.ea_id = (j->>'ea_id')::int RETURNING ea.ea_id)
SELECT json_build_object('deleted', (SELECT count(*) FROM d)) AS result`;

const addComment = `WITH p AS (SELECT $1::jsonb AS j),
i AS (INSERT INTO error_analyzed_comments (ea_id, comment) SELECT (j->>'ea_id')::int, j->>'comment' FROM p RETURNING *)
SELECT (SELECT row_to_json(i) FROM i) AS result`;

const categories = `WITH ${BASE},
hits AS (SELECT error_id, count(*) AS n, max(log_start) AS last_seen FROM e GROUP BY error_id)
SELECT json_build_object(
  'rows', (SELECT COALESCE(json_agg(x ORDER BY x.error_id), '[]') FROM (
      SELECT ec.*, COALESCE(h.n, 0) AS n, h.last_seen FROM error_category ec LEFT JOIN hits h ON h.error_id = ec.error_id) x),
  'uncategorized', COALESCE((SELECT n FROM hits WHERE error_id IS NULL), 0),
  'total', (SELECT count(*) FROM e)
) AS result`;

// The chk CTE makes PostgreSQL compile the regex first, so an invalid expression fails the whole statement.
const saveCategory = `WITH p AS (SELECT $1::jsonb AS j),
chk AS (SELECT (''::text ~* (j->>'category_expression')) AS ok FROM p),
upd AS (
  UPDATE error_category ec SET category_name = j->>'category_name', category_expression = j->>'category_expression',
    integration_flow_name = NULLIF(j->>'integration_flow_name', ''), application_name = NULLIF(j->>'application_name', '')
  FROM p WHERE ec.error_id = (j->>'error_id')::int RETURNING ec.*),
ins AS (
  INSERT INTO error_category (category_name, category_expression, integration_flow_name, application_name)
  SELECT j->>'category_name', j->>'category_expression', NULLIF(j->>'integration_flow_name', ''), NULLIF(j->>'application_name', '')
  FROM p WHERE j->>'error_id' IS NULL RETURNING *)
SELECT (SELECT row_to_json(x) FROM (SELECT * FROM upd UNION ALL SELECT * FROM ins) x LIMIT 1) AS result,
       (SELECT ok IS NOT NULL FROM chk) AS regex_ok`;

const deleteCategory = `WITH p AS (SELECT $1::jsonb AS j),
d AS (DELETE FROM error_category ec USING p WHERE ec.error_id = (j->>'error_id')::int RETURNING ec.error_id)
SELECT json_build_object('deleted', (SELECT count(*) FROM d)) AS result`;

const testMatch = `WITH p AS (SELECT $1::jsonb AS j),
src AS (
  SELECT m.message_guid, m.integration_flow_name AS flow, m.log_start, ei.errormsg
  FROM message_processing_logs m JOIN error_information ei ON ei.message_guid = m.message_guid, p
  WHERE m.log_start > now() - interval '30 days'
    AND (COALESCE(j->>'flow', '') = '' OR m.integration_flow_name = j->>'flow')),
hit AS (
  SELECT src.* FROM src, p
  WHERE CASE WHEN j->>'kind' = 'like' THEN src.errormsg LIKE '%' || (j->>'pattern') || '%' ELSE src.errormsg ~* (j->>'pattern') END)
SELECT json_build_object(
  'n', (SELECT count(*) FROM hit), 'of', (SELECT count(*) FROM src),
  'flows', (SELECT COALESCE(json_agg(x ORDER BY x.n DESC), '[]') FROM (SELECT flow, count(*) AS n FROM hit GROUP BY flow ORDER BY count(*) DESC LIMIT 8) x),
  'samples', (SELECT COALESCE(json_agg(x ORDER BY x.log_start DESC), '[]') FROM (
      SELECT message_guid, flow, log_start, left(errormsg, 300) AS errormsg FROM hit ORDER BY log_start DESC LIMIT 5) x)
) AS result`;

/* ---------- Used by the optional CPI poller ---------- */

// $1 = JSON array of MPL rows. Returns the GUIDs that still have no error text.
const upsertMpls = `WITH up AS (
  INSERT INTO message_processing_logs
    (message_guid, correlation_id, application_message_id, application_message_type, log_start, log_end,
     sender, receiver, integration_flow_name, status, custom_status, transaction_id, artifact_details, raw, polled_at)
  SELECT r.message_guid, r.correlation_id, r.application_message_id, r.application_message_type,
         r.log_start::timestamptz, r.log_end::timestamptz, r.sender, r.receiver, r.integration_flow_name,
         r.status, r.custom_status, r.transaction_id, r.artifact_details, r.raw, now()
  FROM jsonb_to_recordset($1::jsonb) AS r(
    message_guid text, correlation_id text, application_message_id text, application_message_type text,
    log_start text, log_end text, sender text, receiver text, integration_flow_name text, status text,
    custom_status text, transaction_id text, artifact_details jsonb, raw jsonb)
  ON CONFLICT (message_guid) DO UPDATE SET
    status = EXCLUDED.status, custom_status = EXCLUDED.custom_status, log_end = EXCLUDED.log_end,
    artifact_details = EXCLUDED.artifact_details, raw = EXCLUDED.raw, polled_at = EXCLUDED.polled_at
  RETURNING message_guid
)
SELECT u.message_guid FROM up u
WHERE NOT EXISTS (SELECT 1 FROM error_information e WHERE e.message_guid = u.message_guid AND e.hasvalue IS TRUE)`;

// $1 = JSON array of { message_guid, hasvalue, errormsg }.
const upsertErrorInformation = `INSERT INTO error_information (message_guid, hasvalue, errormsg)
SELECT r.message_guid, r.hasvalue, r.errormsg
FROM jsonb_to_recordset($1::jsonb) AS r(message_guid text, hasvalue boolean, errormsg text)
ON CONFLICT (message_guid) DO UPDATE SET hasvalue = EXCLUDED.hasvalue, errormsg = EXCLUDED.errormsg`;

module.exports = {
  meta, dashboard, errors, errorDetail,
  knownErrors, saveKnownError, deleteKnownError, addComment,
  categories, saveCategory, deleteCategory, testMatch,
  upsertMpls, upsertErrorInformation,
};

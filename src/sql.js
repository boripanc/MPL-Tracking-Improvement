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

/* ---------- Certificates (CPI keystore stored in the database) ---------- */

// OData dates arrive as "/Date(1788213599000)/"; ISO strings are accepted too.
const odataTs = (x) => `CASE WHEN ${x} LIKE '/Date(%' THEN to_timestamp(substring(${x} from '-?[0-9]+')::bigint / 1000.0)
      WHEN COALESCE(${x}, '') = '' THEN NULL ELSE (${x})::timestamptz END`;

// $1 = { source, entries: [raw KeystoreEntries records] }. Upserts all entries, marks entries that are no
// longer in the keystore as removed and writes one row to cpi_keystore_sync. An empty list changes nothing.
// The same statement is used by the n8n workflow "CPI Keystore → Postgres".
const syncKeystore = `WITH p AS (SELECT $1::jsonb AS j),
src AS (
  SELECT r FROM p, jsonb_array_elements(COALESCE(p.j->'entries', '[]'::jsonb)) AS r
  WHERE COALESCE(r->>'Alias', '') <> ''),
rows AS (
  SELECT DISTINCT ON (hexalias) * FROM (
    SELECT COALESCE(NULLIF(r->>'Hexalias', ''), encode(convert_to(r->>'Alias', 'UTF8'), 'hex')) AS hexalias,
           r->>'Alias' AS alias, r->>'Type' AS entry_type, r->>'KeyType' AS key_type,
           CASE WHEN r->>'KeySize' ~ '^[0-9]+$' THEN (r->>'KeySize')::int END AS key_size,
           r->>'Owner' AS owner, r->>'SubjectDN' AS subject_dn, r->>'IssuerDN' AS issuer_dn,
           r->>'SerialNumber' AS serial_number, r->>'SignatureAlgorithm' AS signature_algorithm,
           COALESCE(r->>'FingerprintSha256', r->>'FingerprintSha1') AS fingerprint_sha256,
           ${odataTs("r->>'ValidNotBefore'")} AS valid_from,
           ${odataTs("r->>'ValidNotAfter'")} AS valid_to,
           r->>'LastModifiedBy' AS last_modified_by,
           ${odataTs("r->>'LastModifiedTime'")} AS last_modified_time,
           r - 'Certificate' - 'SigningRequest' - 'ChainCertificates' - 'ChainResource' - 'Sshkey' - '__metadata' AS raw
    FROM src) x),
up AS (
  INSERT INTO cpi_keystore_entries (hexalias, alias, entry_type, key_type, key_size, owner, subject_dn, issuer_dn, serial_number,
                                    signature_algorithm, fingerprint_sha256, valid_from, valid_to, last_modified_by,
                                    last_modified_time, raw, first_seen_at, last_seen_at, removed_at)
  SELECT hexalias, alias, entry_type, key_type, key_size, owner, subject_dn, issuer_dn, serial_number,
         signature_algorithm, fingerprint_sha256, valid_from, valid_to, last_modified_by, last_modified_time, raw, now(), now(), NULL
  FROM rows
  ON CONFLICT (hexalias) DO UPDATE SET
    alias = EXCLUDED.alias, entry_type = EXCLUDED.entry_type, key_type = EXCLUDED.key_type, key_size = EXCLUDED.key_size,
    owner = EXCLUDED.owner, subject_dn = EXCLUDED.subject_dn, issuer_dn = EXCLUDED.issuer_dn, serial_number = EXCLUDED.serial_number,
    signature_algorithm = EXCLUDED.signature_algorithm, fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
    valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, last_modified_by = EXCLUDED.last_modified_by,
    last_modified_time = EXCLUDED.last_modified_time, raw = EXCLUDED.raw, last_seen_at = now(), removed_at = NULL
  RETURNING hexalias),
gone AS (
  UPDATE cpi_keystore_entries k SET removed_at = now()
  WHERE k.removed_at IS NULL AND EXISTS (SELECT 1 FROM rows)
    AND NOT EXISTS (SELECT 1 FROM rows WHERE rows.hexalias = k.hexalias)
  RETURNING k.hexalias),
log AS (
  INSERT INTO cpi_keystore_sync (source, entries, removed)
  SELECT COALESCE((SELECT j->>'source' FROM p), 'unknown'), (SELECT count(*) FROM up), (SELECT count(*) FROM gone)
  WHERE EXISTS (SELECT 1 FROM rows)
  RETURNING id, synced_at, source, entries, removed)
SELECT (SELECT row_to_json(log) FROM log) AS result`;

const readCertificates = `WITH p AS (SELECT $1::jsonb AS j)
SELECT json_build_object(
  'lastSync', (SELECT row_to_json(s) FROM (
      SELECT synced_at, source, entries, removed FROM cpi_keystore_sync ORDER BY synced_at DESC, id DESC LIMIT 1) s),
  'items', (SELECT COALESCE(json_agg(k), '[]') FROM (
      SELECT hexalias, alias, entry_type, key_type, key_size, owner, subject_dn, issuer_dn, serial_number,
             signature_algorithm, fingerprint_sha256, valid_from, valid_to, last_modified_by, last_modified_time,
             first_seen_at, last_seen_at, removed_at
      FROM cpi_keystore_entries
      WHERE removed_at IS NULL OR (SELECT (j->>'includeRemoved')::boolean FROM p)
      ORDER BY valid_to NULLS LAST, alias) k)
) AS result`;

/* ---------- Design-time artifact locks and JMS message queues (stored in the database) ---------- */

// Epoch milliseconds ("1793279156662"), OData "/Date(ms)/" or an ISO string; 0 and empty mean "none".
const msTs = (x) => `CASE WHEN COALESCE(${x}, '') IN ('', '0') THEN NULL
      WHEN ${x} ~ '^-?[0-9]+$' THEN to_timestamp((${x})::bigint / 1000.0)
      WHEN ${x} LIKE '/Date(%' THEN to_timestamp(substring(${x} from '-?[0-9]+')::bigint / 1000.0)
      ELSE (${x})::timestamptz END`;
const odataInt = (x) => `CASE WHEN ${x} ~ '^-?[0-9]+$' THEN (${x})::bigint END`;
const odataBool = (x) => `CASE WHEN ${x} IN ('1', 'true') THEN true WHEN ${x} IN ('0', 'false') THEN false END`;

// $1 = { source, locks: [raw IntegrationDesigntimeLocks] | null, broker: {raw JmsBroker} | null, queues: [raw Queues + Artifacts] | null }.
// null (or missing) means "CPI did not answer this time": that part is left as it is. An empty list means
// "there are none": every stored lock is marked released / every queue removed. Messages of queues that are
// now empty or gone are deleted; the messages themselves are stored by syncQueueMessages.
// The same statement is used by the n8n workflow "CPI Locks & Queues → Postgres".
const syncRuntime = `WITH p AS (SELECT $1::jsonb AS j),
f AS (SELECT jsonb_typeof(j->'locks') = 'array' AS locks_ok, jsonb_typeof(j->'queues') = 'array' AS queues_ok FROM p),
lk AS (
  SELECT DISTINCT ON (resource_id) * FROM (
    SELECT r->>'ResourceId' AS resource_id, r->>'ArtifactId' AS artifact_id, r->>'ArtifactName' AS artifact_name,
           r->>'ArtifactType' AS artifact_type, r->>'PackageId' AS package_id, r->>'PackageName' AS package_name,
           ${msTs("r->>'CreatedAt'")} AS created_at, r->>'CreatedBy' AS created_by,
           r - '__metadata' AS raw
    FROM p, f, jsonb_array_elements(CASE WHEN f.locks_ok THEN p.j->'locks' ELSE '[]'::jsonb END) AS r
    WHERE COALESCE(r->>'ResourceId', '') <> '') x),
lk_up AS (
  INSERT INTO cpi_designtime_locks (resource_id, artifact_id, artifact_name, artifact_type, package_id, package_name, created_at,
                                    created_by, raw, first_seen_at, last_seen_at, released_at)
  SELECT resource_id, artifact_id, artifact_name, artifact_type, package_id, package_name, created_at, created_by, raw, now(), now(), NULL
  FROM lk
  ON CONFLICT (resource_id) DO UPDATE SET
    artifact_id = EXCLUDED.artifact_id, artifact_name = EXCLUDED.artifact_name, artifact_type = EXCLUDED.artifact_type,
    package_id = EXCLUDED.package_id, package_name = EXCLUDED.package_name, created_at = EXCLUDED.created_at,
    created_by = EXCLUDED.created_by, raw = EXCLUDED.raw, last_seen_at = now(), released_at = NULL
  RETURNING 1),
lk_gone AS (
  UPDATE cpi_designtime_locks l SET released_at = now()
  FROM f WHERE f.locks_ok AND l.released_at IS NULL AND NOT EXISTS (SELECT 1 FROM lk WHERE lk.resource_id = l.resource_id)
  RETURNING 1),
lk_purge AS (
  DELETE FROM cpi_designtime_locks l WHERE l.released_at < now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM lk WHERE lk.resource_id = l.resource_id)
  RETURNING 1),
q AS (
  SELECT DISTINCT ON (name) * FROM (
    SELECT r->>'Name' AS name,
           ${odataInt("r->>'NumbOfMsgs'")} AS messages, ${odataInt("r->>'Size'")} AS size_bytes,
           ${odataInt("r->>'Type'")}::int AS queue_type, ${odataInt("r->>'State'")}::int AS state,
           ${odataInt("r->>'FillGrade'")}::int AS fill_grade,
           ${odataBool("r->>'Active'")} AS active, ${odataBool("r->>'Exclusive'")} AS exclusive,
           CASE WHEN jsonb_typeof(r->'Artifacts') = 'array' THEN r->'Artifacts' END AS artifacts,
           r - '__metadata' - 'Messages' - 'Artifacts' - 'JmsQueues' - 'Broker' AS raw
    FROM p, f, jsonb_array_elements(CASE WHEN f.queues_ok THEN p.j->'queues' ELSE '[]'::jsonb END) AS r
    WHERE COALESCE(r->>'Name', '') <> '') x),
q_up AS (
  INSERT INTO cpi_jms_queues (name, messages, size_bytes, queue_type, state, fill_grade, active, exclusive, artifacts, raw,
                              first_seen_at, last_seen_at, removed_at)
  SELECT name, messages, size_bytes, queue_type, state, fill_grade, active, exclusive, artifacts, raw, now(), now(), NULL FROM q
  ON CONFLICT (name) DO UPDATE SET
    messages = EXCLUDED.messages, size_bytes = EXCLUDED.size_bytes, queue_type = EXCLUDED.queue_type, state = EXCLUDED.state,
    fill_grade = EXCLUDED.fill_grade, active = EXCLUDED.active, exclusive = EXCLUDED.exclusive,
    artifacts = COALESCE(EXCLUDED.artifacts, cpi_jms_queues.artifacts), raw = EXCLUDED.raw, last_seen_at = now(), removed_at = NULL
  RETURNING 1),
q_gone AS (
  UPDATE cpi_jms_queues t SET removed_at = now()
  FROM f WHERE f.queues_ok AND t.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM q WHERE q.name = t.name)
  RETURNING 1),
m_gone AS (
  DELETE FROM cpi_jms_messages m USING f
  WHERE f.queues_ok AND NOT EXISTS (SELECT 1 FROM q WHERE q.name = m.queue_name AND COALESCE(q.messages, 1) > 0)
  RETURNING 1),
log AS (
  INSERT INTO cpi_runtime_sync (source, locks_ok, queues_ok, locks, locks_released, queues, messages, broker)
  SELECT COALESCE(j->>'source', 'unknown'), f.locks_ok, f.queues_ok, (SELECT count(*) FROM lk_up), (SELECT count(*) FROM lk_gone),
         (SELECT count(*) FROM q_up), COALESCE((SELECT sum(messages) FROM q), 0),
         CASE WHEN jsonb_typeof(j->'broker') = 'object' THEN (j->'broker') - '__metadata' - 'QueueNamesHigh' - 'InactiveQueues' - 'QueueStates' END
  FROM p, f WHERE f.locks_ok OR f.queues_ok
  RETURNING id, synced_at, source, locks_ok, queues_ok, locks, locks_released, queues, messages)
SELECT (SELECT row_to_json(log) FROM log) AS result, (SELECT count(*) FROM lk_purge) AS purged, (SELECT count(*) FROM q_gone) AS queues_removed,
       (SELECT count(*) FROM m_gone) AS messages_removed`;

// $1 = { queues: [{ name, messages: [raw JmsMessages of Queues('name')/Messages] }] }. Replaces the stored
// messages of each listed queue (a queue without a messages list is left as it is).
const syncQueueMessages = `WITH p AS (SELECT $1::jsonb AS j),
qs AS (
  SELECT r->>'name' AS name, r->'messages' AS msgs
  FROM p, jsonb_array_elements(CASE WHEN jsonb_typeof(p.j->'queues') = 'array' THEN p.j->'queues' ELSE '[]'::jsonb END) AS r
  WHERE COALESCE(r->>'name', '') <> '' AND jsonb_typeof(r->'messages') = 'array'),
m AS (
  SELECT DISTINCT ON (queue_name, msgid) * FROM (
    SELECT qs.name AS queue_name, x->>'Msgid' AS msgid, ${odataBool("x->>'Failed'")} AS failed, x->>'Mplid' AS mpl_id,
           ${msTs("x->>'CreatedAt'")} AS created_at, ${odataInt("x->>'RetryCount'")}::int AS retry_count,
           ${msTs("x->>'NextRetry'")} AS next_retry, ${msTs("x->>'OverdueAt'")} AS overdue_at,
           ${msTs("x->>'ExpirationDate'")} AS expires_at,
           x->>'SapSender' AS sender, x->>'SapReceiver' AS receiver, x->>'SapMsgType' AS message_type,
           x->>'SapApplicationId' AS application_id, x->>'SapMplCorrelationId' AS correlation_id,
           x->>'SapMessageProcessingLogCustomStatus' AS custom_status, x - '__metadata' - 'Queue' AS raw
    FROM qs, jsonb_array_elements(qs.msgs) AS x
    WHERE COALESCE(x->>'Msgid', '') <> '') y
  ORDER BY queue_name, msgid, failed DESC NULLS LAST),
del AS (
  DELETE FROM cpi_jms_messages t USING qs
  WHERE t.queue_name = qs.name AND NOT EXISTS (SELECT 1 FROM m WHERE m.queue_name = t.queue_name AND m.msgid = t.msgid)
  RETURNING 1),
up AS (
  INSERT INTO cpi_jms_messages (queue_name, msgid, failed, mpl_id, created_at, retry_count, next_retry, overdue_at, expires_at,
                                sender, receiver, message_type, application_id, correlation_id, custom_status, raw,
                                first_seen_at, last_seen_at)
  SELECT queue_name, msgid, failed, mpl_id, created_at, retry_count, next_retry, overdue_at, expires_at, sender, receiver,
         message_type, application_id, correlation_id, custom_status, raw, now(), now() FROM m
  ON CONFLICT (queue_name, msgid) DO UPDATE SET
    failed = EXCLUDED.failed, mpl_id = EXCLUDED.mpl_id, created_at = EXCLUDED.created_at, retry_count = EXCLUDED.retry_count,
    next_retry = EXCLUDED.next_retry, overdue_at = EXCLUDED.overdue_at, expires_at = EXCLUDED.expires_at,
    sender = EXCLUDED.sender, receiver = EXCLUDED.receiver, message_type = EXCLUDED.message_type,
    application_id = EXCLUDED.application_id, correlation_id = EXCLUDED.correlation_id, custom_status = EXCLUDED.custom_status,
    raw = EXCLUDED.raw, last_seen_at = now()
  RETURNING 1)
SELECT json_build_object('queues', (SELECT count(*) FROM qs), 'messages', (SELECT count(*) FROM up), 'removed', (SELECT count(*) FROM del)) AS result`;

const lastRuntimeSync = (flag) => `(SELECT row_to_json(s) FROM (
      SELECT synced_at, source, locks, locks_released, queues, messages, broker FROM cpi_runtime_sync
      WHERE ${flag} ORDER BY synced_at DESC, id DESC LIMIT 1) s)`;

// $1 = { releasedDays }: current locks, plus the ones released in the last releasedDays days (0 = none).
const readLocks = `WITH p AS (SELECT $1::jsonb AS j)
SELECT json_build_object(
  'lastSync', ${lastRuntimeSync('locks_ok')},
  'items', (SELECT COALESCE(json_agg(l ORDER BY l.released_at DESC NULLS FIRST, l.created_at NULLS LAST), '[]') FROM (
      SELECT resource_id, artifact_id, artifact_name, artifact_type, package_id, package_name, created_at, created_by,
             first_seen_at, last_seen_at, released_at
      FROM cpi_designtime_locks, p
      WHERE released_at IS NULL OR released_at > now() - make_interval(days => COALESCE((j->>'releasedDays')::int, 0))) l)
) AS result`;

const readQueues = `WITH p AS (SELECT $1::jsonb AS j),
mm AS (SELECT queue_name, count(*) FILTER (WHERE failed) AS failed, min(created_at) AS oldest, max(retry_count) AS max_retries
       FROM cpi_jms_messages GROUP BY queue_name)
SELECT json_build_object(
  'lastSync', ${lastRuntimeSync('queues_ok')},
  'items', (SELECT COALESCE(json_agg(x ORDER BY x.messages DESC NULLS LAST, x.name), '[]') FROM (
      SELECT q.name, q.messages, q.size_bytes, q.queue_type, q.state, q.fill_grade, q.active, q.exclusive,
             COALESCE(q.artifacts, '[]') AS artifacts, q.first_seen_at, q.last_seen_at, q.removed_at,
             COALESCE(mm.failed, 0) AS failed, mm.oldest, mm.max_retries
      FROM cpi_jms_queues q LEFT JOIN mm ON mm.queue_name = q.name, p
      WHERE q.removed_at IS NULL OR (j->>'includeRemoved')::boolean) x)
) AS result`;

// $1 = { name }: one queue with its stored messages (newest first, at most 500).
const readQueue = `WITH p AS (SELECT $1::jsonb AS j)
SELECT json_build_object(
  'queue', (SELECT row_to_json(q) FROM (SELECT name, messages, size_bytes, queue_type, state, fill_grade, active, exclusive,
              COALESCE(artifacts, '[]') AS artifacts, first_seen_at, last_seen_at, removed_at
            FROM cpi_jms_queues, p WHERE name = j->>'name') q),
  'messages', (SELECT COALESCE(json_agg(m ORDER BY m.created_at DESC NULLS LAST), '[]') FROM (
      SELECT jm.msgid, jm.failed, jm.mpl_id, jm.created_at, jm.retry_count, jm.next_retry, jm.overdue_at, jm.expires_at,
             jm.sender, jm.receiver, jm.message_type, jm.application_id, jm.correlation_id, jm.custom_status, jm.last_seen_at,
             mpl.integration_flow_name AS flow, mpl.status AS mpl_status, (mpl.message_guid IS NOT NULL) AS has_mpl
      FROM p, cpi_jms_messages jm
      LEFT JOIN message_processing_logs mpl ON mpl.message_guid = jm.mpl_id
      WHERE jm.queue_name = j->>'name'
      ORDER BY jm.created_at DESC NULLS LAST LIMIT 500) m)
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
  syncKeystore, readCertificates,
  syncRuntime, syncQueueMessages, readLocks, readQueues, readQueue,
};

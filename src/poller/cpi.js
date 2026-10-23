'use strict';

/*
 * Optional replacement for the n8n "CPI MPL Errors → Postgres" workflow:
 * pulls FAILED / RETRY / ESCALATED message processing logs from the SAP CPI OData API,
 * upserts them into message_processing_logs and stores the error text in error_information.
 */

const SQL = require('../sql');

const CHUNK = 500;

function odataDate(value) {
  const m = /\/Date\((-?\d+)/.exec(value || '');
  return m ? new Date(Number(m[1])).toISOString() : null;
}

function stripMeta(obj) {
  if (!obj || typeof obj !== 'object') return obj || null;
  const copy = { ...obj };
  delete copy.__metadata;
  return copy;
}

/** Converts one CPI MPL record into a message_processing_logs row. */
function toRow(r) {
  return {
    message_guid: r.MessageGuid,
    correlation_id: r.CorrelationId || null,
    application_message_id: r.ApplicationMessageId || null,
    application_message_type: r.ApplicationMessageType || null,
    log_start: odataDate(r.LogStart),
    log_end: odataDate(r.LogEnd),
    sender: r.Sender || null,
    receiver: r.Receiver || null,
    integration_flow_name: r.IntegrationFlowName || null,
    status: r.Status || null,
    custom_status: r.CustomStatus || null,
    transaction_id: r.TransactionId || null,
    artifact_details: r.IntegrationArtifact ? stripMeta(r.IntegrationArtifact) : null,
    raw: stripMeta(r),
  };
}

function buildFilter(statuses, since) {
  const status = statuses.map((s) => `Status eq '${s}'`).join(' or ');
  return `(${status}) and LogStart gt datetime'${since.toISOString().slice(0, 19)}'`;
}

function createClient(cfg) {
  let token = null;
  let tokenExpires = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`CPI token request failed: HTTP ${res.status}`);
    const body = await res.json();
    token = body.access_token;
    tokenExpires = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return token;
  }

  async function request(path, { accept = 'application/json', retry = true } = {}) {
    const res = await fetch(cfg.apiUrl + path, {
      headers: { Authorization: `Bearer ${await getToken()}`, Accept: accept },
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (res.status === 401 && retry) {
      token = null;
      return request(path, { accept, retry: false });
    }
    return res;
  }

  return { request };
}

async function fetchErrorMpls(client, cfg, since) {
  const rows = new Map();
  for (let page = 0; page < cfg.maxPages; page++) {
    const qs = new URLSearchParams({
      $filter: buildFilter(cfg.statuses, since),
      $format: 'json',
      $orderby: 'LogStart desc',
      $top: String(cfg.pageSize),
      $skip: String(page * cfg.pageSize),
    });
    const res = await client.request(`/MessageProcessingLogs?${qs}`);
    if (!res.ok) throw new Error(`CPI MessageProcessingLogs request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const results = ((await res.json()).d || {}).results || [];
    for (const r of results) if (r.MessageGuid) rows.set(r.MessageGuid, toRow(r));
    if (results.length < cfg.pageSize) break;
  }
  return [...rows.values()];
}

async function fetchErrorText(client, guid) {
  const path = `/MessageProcessingLogs('${encodeURIComponent(guid.replace(/'/g, "''"))}')/ErrorInformation/$value`;
  try {
    const res = await client.request(path, { accept: 'text/plain' });
    const body = res.ok ? (await res.text()).trim() : '';
    return { message_guid: guid, hasvalue: body.length > 0, errormsg: body || null };
  } catch {
    return { message_guid: guid, hasvalue: false, errormsg: null };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Runs one poll. Returns counts of stored MPLs and error texts. */
async function pollOnce({ pool, config, client = createClient(config), now = Date.now() }) {
  const since = new Date(now - config.lookbackHours * 3600000);
  const rows = await fetchErrorMpls(client, config, since);

  const needText = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { rows: r } = await pool.query(SQL.upsertMpls, [JSON.stringify(rows.slice(i, i + CHUNK))]);
    needText.push(...r.map((x) => x.message_guid));
  }

  const texts = await mapLimit(needText, config.concurrency, (guid) => fetchErrorText(client, guid));
  for (let i = 0; i < texts.length; i += CHUNK) {
    await pool.query(SQL.upsertErrorInformation, [JSON.stringify(texts.slice(i, i + CHUNK))]);
  }
  return { mpls: rows.length, errorTexts: texts.length, withText: texts.filter((t) => t.hasvalue).length };
}

/** Polls on an interval without overlapping runs. Returns { stop }. */
function startPoller({ pool, config, logger = console }) {
  const client = createClient(config);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const r = await pollOnce({ pool, config, client });
      logger.log(`[poller] stored ${r.mpls} MPLs, fetched ${r.errorTexts} error texts (${r.withText} with text) in ${Date.now() - started} ms`);
    } catch (err) {
      logger.error('[poller] run failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, config.intervalMinutes * 60000);
  logger.log(`[poller] enabled: every ${config.intervalMinutes} min, looking back ${config.lookbackHours} h, statuses ${config.statuses.join('/')}`);
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { pollOnce, startPoller, toRow, odataDate, buildFilter };

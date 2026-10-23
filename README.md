# CPI Error Center

A Node.js web application for tracking SAP Cloud Integration (CPI) message processing log (MPL) errors.
It reads the errors that are already collected in PostgreSQL, sorts them into **categories**, links them to
**known errors with root cause and solution**, and shows everything on a dashboard.

It works on the existing tables (`message_processing_logs`, `error_information`, `error_category`,
`error_analyzed`, `error_analyzed_comments`, `customs_attributes`) and uses the same matching rules as the
existing `errorscenario` view, so the app and the view always agree.

## What it does

| Screen | Purpose |
| --- | --- |
| **Dashboard** | Error count, business messages (unique correlation IDs), affected iFlows, % categorized, % with a known root cause, errors over time, errors by category, top iFlows, unresolved known errors, and the **top error patterns that still have no known root cause** (patterns that differ only by IDs are grouped). Each pattern has **Analyze** (record root cause + solution) and **Categorize** (create a category rule) buttons. |
| **Errors** | Filter by iFlow, status, category, analysis status and free text; page through results; export CSV. Clicking an error shows the full error text, category, root cause and solution, custom header properties, other messages with the same correlation ID, and a link to the CPI monitor. |
| **Known errors & solutions** | Create / edit / delete entries in `error_analyzed`, set status (Open, In Progress, Monitoring, Resolved), add comments. A status change automatically adds a comment such as "Status changed from Open to Resolved by alice". |
| **Categories** | Create / edit / delete rules in `error_category`, optionally limited to one iFlow, and see how many errors each rule catches. |
| **Certificates** | Certificates and key pairs in the CPI tenant keystore with their expiry date and days left: **Expired**, **Expires soon** (< 30 days), **Expiring** (< 90 days) or **Valid**. Filter by status or type, hide SAP-owned entries, search, open the full details (subject, issuer, serial, fingerprint) and export CSV. The menu shows a red badge with the number of expired and soon-expiring entries. |

Both editors have a **Test against last 30 days** button that shows how many errors a pattern would match before you save it.

### Matching rules

- **Category**: the error text matches `error_category.category_expression` as a case-insensitive regular
  expression (PostgreSQL `~*`). If `integration_flow_name` is set, the rule only applies to that iFlow.
  When several rules match, the lowest `error_id` wins. Invalid regular expressions are rejected on save.
- **Known error**: the error text contains `error_analyzed.errormessage` (SQL `LIKE '%…%'`) **and** the iFlow is
  the same. An empty iFlow matches any iFlow in this app (the `errorscenario` view ignores such entries).
  When several match, the lowest `ea_id` wins.

## Requirements

- Node.js 20 or newer
- PostgreSQL with the tables above (`db/schema.sql` documents them and can create them for a new database)
- Something that fills `message_processing_logs` / `error_information` — either the existing n8n workflow
  **"CPI MPL Errors → Postgres"** or this app's built-in poller (see below)

## Quick start

```bash
npm install
cp .env.example .env        # then edit DATABASE_URL and APP_USERS
npm start                   # http://localhost:3000
```

Sign in with one of the `APP_USERS` accounts.

### Try it locally with sample data

With Docker:

```bash
docker compose up --build   # http://localhost:3000, user admin / password admin
```

Without Docker (needs a local PostgreSQL and an empty database):

```bash
export DATABASE_URL=postgres://user:pass@localhost/cpi_error_center_dev
npm run db:seed             # creates the tables and loads sample data
AUTH_DISABLED=true npm run dev
```

`npm run db:seed` refuses to load sample data into a database that already has messages.

## Configuration

All settings are environment variables (a `.env` file is read automatically). See `.env.example`.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | – | **Required.** PostgreSQL connection string. |
| `PGSSL` | (off) | `require` = TLS with certificate check, `no-verify` = TLS without check. |
| `DB_SCHEMA` | `public` | Schema that holds the tables. |
| `PG_POOL_MAX` | `10` | Max database connections. |
| `APP_USERS` | – | **Required** unless auth is disabled. Comma-separated `user:password` pairs. |
| `AUTH_DISABLED` | `false` | Local development only. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `TRUST_PROXY` | (off) | Set to `1` behind a reverse proxy / load balancer. |
| `DEFAULT_TZ` | `Asia/Bangkok` | Time zone for chart buckets if the browser doesn't send one. |

The server will not start without `DATABASE_URL`, or without `APP_USERS` unless `AUTH_DISABLED=true`.

## Certificate expiry

The **Certificates** menu reads the tenant keystore live from the CPI OData API (`KeystoreEntries`), so it needs the
same CPI connection settings as the poller (`CPI_API_URL`, `CPI_TOKEN_URL`, `CPI_CLIENT_ID`, `CPI_CLIENT_SECRET`).
The poller itself does not have to be enabled. Without these settings the menu explains what to configure.

The service key's client must be allowed to read the keystore; if it is not, the screen shows the HTTP 401/403 error
from CPI. Nothing is stored in the database.

| Variable | Default | Description |
| --- | --- | --- |
| `CERT_CRITICAL_DAYS` | `30` | Fewer days left than this → **Expires soon** (red, counted in the menu badge). |
| `CERT_WARN_DAYS` | `90` | Fewer days left than this → **Expiring** (amber). |
| `CERT_CACHE_MINUTES` | `15` | How long the keystore is cached. **Re-read from CPI** forces a new read (at most every 30 seconds). |

## Optional: pull errors from CPI directly

The app can replace the n8n workflow that copies CPI error MPLs into the database. It does the same thing:
every `CPI_POLL_INTERVAL_MINUTES` it fetches FAILED / RETRY / ESCALATED logs from the last
`CPI_POLL_LOOKBACK_HOURS`, upserts them into `message_processing_logs` (no duplicates, the `checked` column is
never touched), then fetches the error text for every message that does not have it yet and stores it in
`error_information`.

```env
CPI_POLL_ENABLED=true
CPI_API_URL=https://<tenant>.it-cpi012.cfapps.ap21.hana.ondemand.com/api/v1
CPI_TOKEN_URL=https://<subaccount>.authentication.ap21.hana.ondemand.com/oauth/token
CPI_CLIENT_ID=...
CPI_CLIENT_SECRET=...
```

The OAuth values come from the service key of a Process Integration Runtime instance with the `api` plan
(role `MonitoringDataRead`). `npm run poll` runs a single poll, which is handy for cron or a manual backfill.

Running the poller and the n8n workflow at the same time is harmless (both upsert by `message_guid`), but it
doubles the calls to CPI, so switch one of them off.

## Deployment

- **Docker**: `docker build -t cpi-error-center .` and run with the environment variables above.
  The image runs as a non-root user and has a health check on `/healthz`.
- **Plain Node / PM2 / systemd**: `npm ci --omit=dev && node src/server.js`.
- Put it behind HTTPS (reverse proxy or load balancer) — Basic auth sends passwords with every request.
  Set `TRUST_PROXY=1` in that case.

### Security notes

- Every page and API call requires login, except `GET /healthz`.
- All SQL uses bound parameters; user input is never concatenated into queries.
- The page is served with a strict Content-Security-Policy (no inline scripts, no external scripts —
  Chart.js is served from the app itself), and all data is HTML-escaped before display.
- Use a database user with only `SELECT` on the log tables and `SELECT, INSERT, UPDATE, DELETE` on
  `error_category`, `error_analyzed` and `error_analyzed_comments` (plus `INSERT, UPDATE` on the log tables if
  the poller is enabled).

## API

All endpoints are under `/api`, require login and return JSON. Errors return `{ "error": "message" }` with a
4xx/5xx status. List endpoints accept `from`, `to` (ISO dates, default last 7 days) and `tz` (IANA time zone).

| Method & path | Description |
| --- | --- |
| `GET /api/meta` | iFlow names, categories, last poll time |
| `GET /api/dashboard` | Everything the dashboard shows |
| `GET /api/errors` | Error list. Filters: `flow`, `status` (FAILED/ESCALATED/RETRY), `category` (id or `__none`), `analysis` (`__none`, `__known` or a status), `q`, `limit` (≤ 500), `offset` |
| `GET /api/errors/:guid` | One message with category, known error, comments, custom attributes, related messages |
| `GET /api/known-errors` | Known errors with hit counts and comments |
| `POST /api/known-errors` | Create: `{ errormessage, integration_flow_name, rootcause, solutions, status }` |
| `PUT /api/known-errors/:id` | Update (same body) |
| `DELETE /api/known-errors/:id` | Delete (comments are deleted too) |
| `POST /api/known-errors/:id/comments` | Add a comment: `{ comment }` |
| `GET /api/categories` | Categories with hit counts, plus uncategorized count |
| `POST /api/categories` | Create: `{ category_name, category_expression, integration_flow_name, application_name }` |
| `PUT /api/categories/:id` | Update (same body) |
| `DELETE /api/categories/:id` | Delete |
| `POST /api/test-match` | `{ kind: "like" \| "regex", pattern, flow }` → matches in the last 30 days |
| `GET /api/certificates` | Keystore entries with `state` (expired / critical / warning / ok / unknown), `daysLeft` and a summary. `?refresh=1` re-reads CPI |
| `GET /healthz` | Database check (no login) |

## Development

```bash
npm run dev     # restarts on file changes
npm test        # needs TEST_DATABASE_URL (default postgres://cpiapp:cpiapp@localhost:5432/cpi_error_center_test)
```

Tests create a temporary schema per run, load `db/schema.sql` and `db/seed-sample.sql`, and drop it afterwards.
The poller tests use a fake CPI server, so no real tenant is needed.

### Project layout

```
src/
  server.js          start-up, config checks, graceful shutdown
  app.js             Express app: security headers, login, API, static files
  config.js          environment variables
  db.js              PostgreSQL pool
  sql.js             all SQL queries (matching rules live here)
  routes/api.js      REST API and input validation
  middleware/        Basic auth, error handling
  cpi/client.js      CPI OData API client (OAuth2 client credentials)
  cpi/certificates.js keystore read + expiry classification (Certificates menu)
  poller/cpi.js      optional CPI MPL poller
  scripts/           db:init / db:seed, one-off poll
public/              the web page (index.html, app.js, styles.css)
db/                  schema.sql (existing tables + view), seed-sample.sql
test/                node:test suites
```

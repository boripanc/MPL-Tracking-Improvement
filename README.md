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
| **Ticket pulse** | Health of the Freshservice ticket queue (from the table the n8n workflow fills): open backlog, overdue, due soon, unassigned, created vs. resolved per day, backlog by age, group, responder and status, and a filterable list of open tickets with their last comment. The menu shows a red badge with the number of overdue tickets. |
| **Kanban card** (in the error details) | Turns an error into a card on the TodoList Kanban board (through the board's MCP server). The form is filled with the iFlow, message and correlation IDs, category, known root cause, CPI link and error text; pick the column, priority, labels, assignee and due date, then create. The error details list the cards that already mention the message ID, so the same error is not filed twice. Shown only when `KANBAN_MCP_URL` is set; the first time, someone clicks **Connect Kanban board** and signs in to the Kanban app. |
| **Certificates** | Certificates and key pairs in the CPI tenant keystore (stored in the database by the n8n workflow) with their expiry date and days left: **Expired**, **Expires soon** (< 30 days), **Expiring** (< 90 days) or **Valid**. Filter by status or type, hide SAP-owned entries, search, open the full details (subject, issuer, serial, fingerprint) and export CSV. The menu shows a red badge with the number of expired and soon-expiring entries. |

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

### Login

Every page and API call needs a signed-in user; only `/healthz` is open. Opening the app without a session goes to
the **login page**; after signing in, the browser returns to the page it asked for. The header shows the user and a
**Sign out** button.

A session ends, and the user has to sign in again, when:

- nothing was done for `SESSION_IDLE_MINUTES` (default 60),
- `SESSION_MAX_HOURS` have passed since signing in (default 12), even while working,
- the user clicks **Sign out**,
- the user's password is changed in `APP_USERS` (or the user is removed),
- the server restarts, unless `SESSION_SECRET` is set.

Ten wrong passwords from one address block the login for 15 minutes. Scripts can still send HTTP Basic credentials
(`curl -u user:password …`) with each request; the browser is never asked for them, because a browser keeps Basic
credentials until it is closed and cannot sign out.

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
| `AUTH_DISABLED` | `false` | Local development only: no login at all. |
| `SESSION_SECRET` | (random per start) | Key that signs the session cookie. Set it so a restart does not sign everyone out. |
| `SESSION_IDLE_MINUTES` | `60` | Sign out after this long without activity. |
| `SESSION_MAX_HOURS` | `12` | Sign in again after this long in any case. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |
| `TRUST_PROXY` | (off) | Set to `1` behind a reverse proxy / load balancer. |
| `DEFAULT_TZ` | `Asia/Bangkok` | Time zone for chart buckets if the browser doesn't send one. |

The server will not start without `DATABASE_URL`, or without `APP_USERS` unless `AUTH_DISABLED=true`.

## Certificate expiry

The **Certificates** menu reads from the database, so the web server does **not** need access to CPI.
The CPI keystore is copied into two tables (created automatically, also in `db/schema.sql`):

- `cpi_keystore_entries`: one row per keystore entry: alias, type, owner, subject, issuer, serial number,
  `valid_from` / `valid_to`, and when it was first seen, last seen and removed from the keystore.
  Certificate and key material is **not** stored.
- `cpi_keystore_sync`: one row per sync (time, source, number of entries, number removed).

**Who fills the tables**

1. **n8n workflow "CPI Keystore → Postgres"** (recommended). It runs every 6 hours: it creates the tables if needed,
   reads `GET /api/v1/KeystoreEntries` with the tenant's OAuth credential and stores the result with the same SQL as
   the app (`syncKeystore` in `src/sql.js`). Entries that disappear from the keystore are marked as removed, not deleted.
2. **The app itself**, only if this server can reach CPI and the CPI connection is set
   (`CPI_API_URL`, `CPI_TOKEN_URL`, `CPI_CLIENT_ID`, `CPI_CLIENT_SECRET`; the service-key names `CPI_URL`, `CPI_TOKENURL`,
   `CPI_CLIENTID`, `CPI_CLIENTSECRET` work too). It then syncs every `CERT_SYNC_INTERVAL_MINUTES` and shows a
   **Sync from CPI now** and a **Test CPI connection** button.

The screen shows when the data was last synced, and warns when that is older than `CERT_STALE_HOURS`
(for example if the n8n workflow stopped). Tick **Show removed** to see entries that were deleted from the keystore.

| Variable | Default | Description |
| --- | --- | --- |
| `CERT_CRITICAL_DAYS` | `30` | Fewer days left than this → **Expires soon** (red, counted in the menu badge). |
| `CERT_WARN_DAYS` | `90` | Fewer days left than this → **Expiring** (amber). |
| `CERT_STALE_HOURS` | `26` | Warn on the screen when the last sync is older than this. |
| `CERT_SYNC_INTERVAL_MINUTES` | `360` | Only with a CPI connection on this server: how often the app syncs. |

`.env` is read from the folder next to `package.json` (and from the current folder). With Docker, pass it explicitly
(`docker run --env-file .env ...`); `docker compose` passes it automatically.

### When the app's own CPI sync fails

This only matters if the app syncs the keystore itself (the n8n workflow does not need it).
Press **Test CPI connection** on the Certificates screen, or run `npm run check:cpi` on the server. Both test the
settings, the OAuth token, the keystore and the message logs one step at a time, and say what to fix. The usual
causes on company servers:

| Message | Fix |
| --- | --- |
| *host name could not be resolved* / *timed out* | The server reaches the internet through a proxy: set `HTTPS_PROXY=http://proxy:port` (and `NO_PROXY` for internal hosts such as the database). |
| *proxy refused the connection (HTTP 403)* | Ask the network team to allow the CPI and token hosts through the proxy. |
| *TLS certificate not trusted* | Company TLS inspection: set `NODE_EXTRA_CA_CERTS=/path/to/company-root-ca.pem`. |
| *OAuth token request failed: HTTP 401* | Wrong `CPI_CLIENT_ID` / `CPI_CLIENT_SECRET`, or they come from a different service key than `CPI_TOKEN_URL`. |
| *Read keystore … HTTP 403* | The service key may not read the keystore; add the role to the service instance. |
| *Got text/html instead of JSON* | `CPI_API_URL` points to the web UI instead of the tenant API (`…it-cpiNNN…/api/v1`). |

## Ticket pulse

The **Ticket pulse** menu shows how the Freshservice ticket queue is doing: open backlog, overdue, due soon and
unassigned tickets, created vs. resolved per day in the selected period, the backlog by age, group, responder,
status and pending reason (folded under **Breakdowns**), and a filterable list of all open tickets (click one for
its description and last comment). The menu shows a red badge with the number of overdue tickets.
Above the open tickets, **This month** lists every ticket created in the current calendar month, whatever its
status, with buttons to show only the ones still open, resolved / closed, or missing closure notes. Long lists show
the first rows with a **Show all** button.
The **View** switch at the top picks **Daily** (the period picker), **Weekly** (last 12 weeks), **Monthly**
(last 12 months) or **Yearly** (last 5 years) for the created vs. resolved chart, the created / resolved KPI
(this week, month or year next to the previous one), first response time and top sub-categories.

It reads the `tickets` table that the **n8n workflow "FreshServices Tickets"** fills (one row per ticket, keyed by
`human_display_id`). The app only reads it and does not create it. Open = any status except Resolved and Closed.
Tickets tagged `noncharge` / `noncharged` and tickets whose Change Process Type (`change_process_type`) is
Standard, Normal or Emergency (any letter case) are left out of every number, chart and list.
**Closure notes** lists tickets resolved or closed in the selected period whose
Issue/Investigation Summary, Correction Solution or Root Cause is empty (columns `issue_summary`,
`correction_solution`, `root_cause`, from the Freshservice custom fields of the same names; HTML-only blanks
such as `<p>&nbsp;</p>` count as empty). Until the n8n workflow stores those columns, the card says so.
Missing optional columns (such as `last_comment_*` or `tags`) are shown as empty; if the table is missing, the
screen says so. The screen warns when the newest ticket change is older than `TICKETS_STALE_HOURS`, which usually
means the workflow has not run or its Freshservice cookie expired.

| Variable | Default | Description |
| --- | --- | --- |
| `TICKETS_TABLE` | `tickets` | Table with the Freshservice tickets (`schema.table` is allowed). |
| `TICKET_URL` | `https://itservice.thaiunion.com/a/tickets/{number}` | Link to a ticket (`{number}` = digits of `INC-123`, `{id}` = the whole id). The ticket number in the list and the ticket panel link there. `off` hides the links. |
| `TICKETS_DUE_SOON_HOURS` | `72` | Open tickets due within this many hours count as **Due soon**. |
| `TICKETS_STALE_HOURS` | `24` | Warn when the newest ticket change is older than this. |

## Kanban cards from errors

The app is an MCP client of the TodoList Kanban app (the "WorkStream" MCP server). It uses the server's
`list_boards`, `get_board`, `find_cards` and `create_card` tools over Streamable HTTP, and opens a short session
per request. The proxy variables (`HTTPS_PROXY`, `NO_PROXY`) apply here too.

**Login is OAuth** (the standard MCP authorization flow):

1. Set `KANBAN_MCP_URL=https://workstream.teddybiere.info/api/mcp` and restart.
2. Open any error. The Kanban section shows **Connect Kanban board**. Click it, sign in to the Kanban app and approve.
3. The browser comes back to `/kanban/oauth/callback` and the app says "Kanban board connected".

The app registers itself with the Kanban server (dynamic client registration), uses PKCE, keeps the client and the
tokens in the `kanban_oauth` table (created automatically) and refreshes the access token by itself. Cards are
created as the account that connected, for everyone who uses this app. **Disconnect** (in the Kanban section)
forgets the tokens. If the tokens are revoked or refused (401/403), the app drops them and the section asks to
connect again.

**Sign in again** (next to Disconnect) forces a fresh sign-in: it removes the saved tokens and the client
registration at once, registers the app again and opens the Kanban login page with `prompt=login`, so the login
form is shown even when the browser is still signed in to WorkStream. Use it to switch to another Kanban account or
when the connection looks stuck. Until the new sign-in is finished, no cards can be created (automatic cards say why).
API: `POST /api/kanban/connect` with `{"force": true}`.

The callback address is the address you opened the app with plus `/kanban/oauth/callback`. The Kanban server only
accepts **https** callbacks (or http on localhost):

- **App on https** (directly or behind an https reverse proxy): set `TRUST_PROXY=1` behind the proxy, or set
  `KANBAN_OAUTH_REDIRECT_URL=https://<this app's public address>/kanban/oauth/callback`. The browser comes straight
  back. This is the CPI Error Center's address, never the Kanban server's; the app refuses the Kanban server's.
- **App on plain http** (e.g. `http://server:3000`): the sign-in returns to `http://localhost/kanban/oauth/callback`,
  which does not load. (The WorkStream site may rewrite it to `https://workstream.teddybiere.info/kanban/oauth/callback?…`;
  that address works the same.) The app shows a box: copy that address from the browser bar, paste it, click
  **Finish connecting**. This is needed only once, when connecting.

| Variable | Default | Description |
| --- | --- | --- |
| `KANBAN_MCP_URL` | (off) | MCP endpoint of the Kanban app. Empty hides the Kanban section. |
| `KANBAN_OAUTH_REDIRECT_URL` | (from the request) | Callback address registered with the Kanban server. |
| `KANBAN_OAUTH_CLIENT_ID` / `KANBAN_OAUTH_CLIENT_SECRET` | – | Only when the server does not allow automatic client registration. |
| `KANBAN_OAUTH_SCOPE` | – | Scope to ask for, if the server needs one. |
| `KANBAN_MCP_TOKEN` | – | Instead of OAuth: a fixed API key. |
| `KANBAN_MCP_AUTH_HEADER` | `Authorization` | Header for the fixed key. `Authorization` sends `Bearer <key>`; any other header sends the key as is. |
| `KANBAN_BOARD` | (first board) | Board id or title, e.g. `TUIP`. |
| `KANBAN_COLUMN` | `To do` | Column a new card goes to. |
| `KANBAN_LABELS` | `Monitoring` | Comma-separated labels for a new card. |
| `KANBAN_PRIORITY` | `medium` | `none`, `low`, `medium`, `high` or `urgent`. |
| `KANBAN_AUTO_CARD` | `true` | A known error saved with status Open creates its card by itself. |
| `KANBAN_AUTO_ASSIGNEE` | (by capacity) | Empty = member with the most free capacity; names (comma-separated) = always them; `none` = unassigned. |
| `KANBAN_CARD_URL` | (none) | Link to a card in the Kanban app (`{id}` = card id), used in the error details. |
| `KANBAN_TIMEOUT_MS` | `20000` | Timeout per MCP request. |

Assignees picked in the form are requests: the board owner approves them in the Kanban app.

**Automatic cards for known errors.** When a known error (root cause & solution) is saved with status **Open**,
new or edited back to Open, the app creates its card by itself: title `Fix error on <iFlow>: <root cause>`, notes with the pattern, root cause,
solution and, when recorded from an error, that message's details. The notes carry a tag such as `[CPI-KE-12]`, so
a known error that already has a card is not filed twice. Saving with another status (In Progress, Monitoring,
Resolved) never creates a card.

**Automatic assignee.** The card goes to the team member with the most free capacity on the board (their capacity
minus their open cards, from the Kanban app's workload); ties go to fewer overdue cards, then fewer open cards. If
everyone is at or over capacity, the card stays unassigned. The same person is preselected in the manual card form.
Set `KANBAN_AUTO_ASSIGNEE` to fixed names to always assign them, or `none` to never assign. The board owner still
approves assignments in the Kanban app. The known error
is saved even if the Kanban server fails; the app then says why no card was created. Turn it off with
`KANBAN_AUTO_CARD=false`.

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
| `GET /api/errors/:guid/card` | Kanban: the suggested card for this error, the board's columns, labels and team, and the cards that already mention the message ID |
| `POST /api/errors/:guid/card` | Create a Kanban card: `{ title, description, column, labels, priority, assignees, dueDate }` (all optional; missing fields use the suggestion and the `KANBAN_*` defaults). 409 when Kanban is not set up or not connected (`connect: true`), 502 when the Kanban server fails |
| `GET /api/kanban/status` | Kanban connection: `enabled`, `connected`, `auth` (oauth/token), who connected and when |
| `POST /api/kanban/connect` | Start the Kanban sign-in; returns `{ url, paste }` (`paste: true` = the app is on plain http, see above) |
| `POST /api/kanban/finish` | Finish the sign-in with the pasted callback address: `{ url }` (app on plain http) |
| `POST /api/kanban/disconnect` | Forget the Kanban tokens |
| `GET /api/known-errors` | Known errors with hit counts and comments |
| `POST /api/known-errors` | Create: `{ errormessage, integration_flow_name, rootcause, solutions, status, message_guid? }`. With Kanban on, the answer has `kanban: { card, existed }` or `kanban: { error }` |
| `PUT /api/known-errors/:id` | Update (same body) |
| `DELETE /api/known-errors/:id` | Delete (comments are deleted too) |
| `POST /api/known-errors/:id/comments` | Add a comment: `{ comment }` |
| `GET /api/categories` | Categories with hit counts, plus uncategorized count |
| `POST /api/categories` | Create: `{ category_name, category_expression, integration_flow_name, application_name }` |
| `PUT /api/categories/:id` | Update (same body) |
| `DELETE /api/categories/:id` | Delete |
| `POST /api/test-match` | `{ kind: "like" \| "regex", pattern, flow }` → matches in the last 30 days |
| `GET /api/certificates` | Keystore entries from the database with `state` (expired / critical / warning / ok / unknown), `daysLeft`, a summary and the last sync. `?removed=1` includes removed entries |
| `POST /api/certificates/sync` | Copy the keystore from CPI into the database now (only when this server has a CPI connection; otherwise 409) |
| `GET /api/tickets/pulse` | Ticket pulse: KPIs, created vs. resolved, backlog breakdowns and the open tickets (`from`, `to`, `tz`, or `view=week` / `month` / `year` for the last 12 weeks, 12 months or 5 years) |
| `GET /api/tickets/:id` | One ticket with description, tags and last comment |
| `GET /api/cpi/check` | Step-by-step CPI connection test (no secrets in the result) |
| `GET /healthz` | Database check (no login) |

## Development

```bash
npm run dev     # restarts on file changes
npm test        # needs TEST_DATABASE_URL (default postgres://cpiapp:cpiapp@localhost:5432/cpi_error_center_test)
```

Tests create a temporary schema per run, load `db/schema.sql` and `db/seed-sample.sql`, and drop it afterwards.
The poller tests use a fake CPI server and the Kanban tests a fake MCP server, so no real tenant or board is needed.

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
  cpi/certificates.js keystore store/read in the database + expiry classification (Certificates menu)
  kanban.js          MCP client for the TodoList Kanban board (OAuth sign-in, create a card from an error)
  tickets.js         Ticket pulse queries on the Freshservice tickets table (filled by n8n)
  poller/cpi.js      optional CPI MPL poller
  scripts/           db:init / db:seed, one-off poll
public/              the web page (index.html, app.js, styles.css)
db/                  schema.sql (existing tables + view), seed-sample.sql
test/                node:test suites
```

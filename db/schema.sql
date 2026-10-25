-- Tables used by CPI Error Center.
--
-- These tables already exist in the production database. This file mirrors their structure so
-- you can create a local/test database (npm run db:init). Every statement is "create if missing",
-- so running it against an existing database does not change existing tables or the view.

CREATE TABLE IF NOT EXISTS message_processing_logs (
  id                       serial PRIMARY KEY,
  message_guid             text NOT NULL UNIQUE,
  correlation_id           text,
  application_message_id   text,
  application_message_type text,
  log_start                timestamptz,
  log_end                  timestamptz,
  sender                   text,
  receiver                 text,
  integration_flow_name    text,
  status                   text,
  custom_status            text,
  transaction_id           text,
  artifact_details         jsonb,
  raw                      jsonb,
  polled_at                timestamptz NOT NULL,
  checked                  boolean
);

CREATE TABLE IF NOT EXISTS error_information (
  message_guid varchar CONSTRAINT error_information_unique UNIQUE,
  hasvalue     boolean,
  errormsg     varchar
);

CREATE TABLE IF NOT EXISTS customs_attributes (
  message_guid varchar,
  ca_id        varchar,
  name         varchar,
  value        varchar,
  CONSTRAINT customs_attributes_unique UNIQUE (message_guid, ca_id)
);

-- Category rules: category_expression is a case-insensitive regular expression (~*).
CREATE TABLE IF NOT EXISTS error_category (
  error_id              serial CONSTRAINT error_category_unique UNIQUE,
  category_name         varchar,
  category_expression   varchar,
  integration_flow_name varchar,
  application_name      varchar
);

-- Known errors: error text LIKE '%errormessage%' for the same iFlow.
CREATE TABLE IF NOT EXISTS error_analyzed (
  ea_id                 serial CONSTRAINT error_analyzed_unique UNIQUE,
  errormessage          varchar,
  integration_flow_name varchar,
  rootcause             varchar,
  solutions             varchar,
  status                varchar(20) NOT NULL DEFAULT 'Open'
    CONSTRAINT error_analyzed_status_check CHECK (status IN ('Open', 'In Progress', 'Resolved', 'Monitoring'))
);

CREATE TABLE IF NOT EXISTS error_analyzed_comments (
  id         serial PRIMARY KEY,
  ea_id      integer NOT NULL REFERENCES error_analyzed (ea_id) ON DELETE CASCADE,
  comment    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Existing view: latest error per correlation ID with its category and known error.
DO $$
BEGIN
  IF to_regclass('errorscenario') IS NULL THEN
    CREATE VIEW errorscenario AS
    SELECT DISTINCT ON (message_processing_logs.correlation_id) message_processing_logs.correlation_id,
        message_processing_logs.integration_flow_name,
        message_processing_logs.log_start,
        ei.errormsg,
        ec.category_name,
        ea.ea_id,
        ea.rootcause,
        row_number() OVER (PARTITION BY message_processing_logs.correlation_id ORDER BY message_processing_logs.log_start DESC NULLS LAST) AS rn
    FROM message_processing_logs
      LEFT JOIN error_information ei ON ei.message_guid::text = message_processing_logs.message_guid
      LEFT JOIN error_category ec ON ei.errormsg::text ~* ec.category_expression::text
      LEFT JOIN error_analyzed ea ON ei.errormsg::text ~~ (('%'::text || ea.errormessage::text) || '%'::text)
        AND message_processing_logs.integration_flow_name = ea.integration_flow_name::text
    ORDER BY message_processing_logs.correlation_id, message_processing_logs.log_start DESC NULLS LAST;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- CPI keystore (Certificates menu). Filled by the n8n workflow "CPI Keystore → Postgres" or by
-- this app's own sync; the web page only reads these tables.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cpi_keystore_entries (
  hexalias            text PRIMARY KEY,
  alias               text NOT NULL,
  entry_type          text,          -- Certificate, Key Pair, ...
  key_type            text,          -- RSA, EC, ...
  key_size            integer,
  owner               text,          -- SAP or Tenant Administrator
  subject_dn          text,
  issuer_dn           text,
  serial_number       text,
  signature_algorithm text,
  fingerprint_sha256  text,
  valid_from          timestamptz,
  valid_to            timestamptz,
  last_modified_by    text,
  last_modified_time  timestamptz,
  raw                 jsonb,         -- CPI record without certificate/key material
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz    -- set when the entry is no longer in the keystore
);
CREATE INDEX IF NOT EXISTS cpi_keystore_entries_valid_to_idx ON cpi_keystore_entries (valid_to);

CREATE TABLE IF NOT EXISTS cpi_keystore_sync (
  id        serial PRIMARY KEY,
  synced_at timestamptz NOT NULL DEFAULT now(),
  source    text,                    -- n8n or app
  entries   integer NOT NULL,
  removed   integer NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Kanban sign-in (OAuth) for creating cards from errors. The app creates this table by itself the
-- first time it is needed; it holds the registered client and the tokens of the connected account.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kanban_oauth (
  id         text PRIMARY KEY,
  data       jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

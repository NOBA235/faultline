'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  // version 1
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment = 'sandbox'),
    paypal_client_id TEXT NOT NULL,
    paypal_secret_enc TEXT NOT NULL,
    webhook_endpoint_url TEXT NOT NULL,
    connection_status TEXT NOT NULL DEFAULT 'unverified'
      CHECK (connection_status IN ('unverified', 'connected', 'auth_failed', 'unreachable')),
    connection_checked_at TEXT,
    connection_error_code TEXT,
    connection_error_message TEXT,
    paypal_app_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_projects_name ON projects (name COLLATE NOCASE);

  CREATE TABLE connection_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    http_status INTEGER,
    error_code TEXT,
    error_message TEXT,
    duration_ms INTEGER NOT NULL,
    paypal_debug_id TEXT
  );
  CREATE INDEX idx_checks_project ON connection_checks (project_id, id DESC);
  `,
  // version 2: Sandbox orders, captures and a log of every PayPal API call
  `
  CREATE TABLE paypal_orders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    paypal_order_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    intent TEXT NOT NULL,
    amount_value TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    approve_url TEXT,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_synced_at TEXT NOT NULL,
    UNIQUE (project_id, idempotency_key),
    UNIQUE (project_id, paypal_order_id)
  );

  CREATE TABLE paypal_captures (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES paypal_orders (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    paypal_capture_id TEXT NOT NULL,
    status TEXT NOT NULL,
    amount_value TEXT,
    currency_code TEXT,
    final_capture INTEGER,
    paypal_created_at TEXT,
    paypal_updated_at TEXT,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_synced_at TEXT NOT NULL,
    UNIQUE (project_id, paypal_capture_id)
  );
  CREATE INDEX idx_captures_order ON paypal_captures (order_id);

  CREATE TABLE paypal_api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    order_id TEXT REFERENCES paypal_orders (id) ON DELETE SET NULL,
    called_at TEXT NOT NULL,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    http_status INTEGER,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    error_name TEXT,
    error_message TEXT,
    paypal_debug_id TEXT
  );
  CREATE INDEX idx_calls_project ON paypal_api_calls (project_id, id DESC);
  `,
  // version 3: webhook receiver (events, inbound deliveries) and per-project PayPal webhook ID
  `
  ALTER TABLE projects ADD COLUMN paypal_webhook_id TEXT;

  CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    paypal_event_id TEXT,
    event_type TEXT,
    resource_type TEXT,
    resource_id TEXT,
    paypal_event_created_at TEXT,
    transmission_id TEXT,
    transmission_time TEXT,
    first_received_at TEXT NOT NULL,
    raw_body BLOB NOT NULL,
    headers_json TEXT NOT NULL,
    verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'failed', 'error', 'unverified')),
    verification_code TEXT,
    verification_detail TEXT,
    processing_status TEXT NOT NULL DEFAULT 'stored',
    related_order_id TEXT REFERENCES paypal_orders (id) ON DELETE SET NULL,
    origin TEXT NOT NULL DEFAULT 'unlinked'
  );
  CREATE UNIQUE INDEX idx_events_verified_unique ON webhook_events (project_id, paypal_event_id)
    WHERE verification_status = 'verified' AND paypal_event_id IS NOT NULL;
  CREATE INDEX idx_events_project ON webhook_events (project_id, first_received_at DESC);

  CREATE TABLE webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    event_id TEXT REFERENCES webhook_events (id) ON DELETE SET NULL,
    received_at TEXT NOT NULL,
    transmission_id TEXT,
    transmission_time TEXT,
    verification_status TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    is_redelivery INTEGER NOT NULL DEFAULT 0,
    body_bytes INTEGER NOT NULL,
    note TEXT
  );
  CREATE INDEX idx_deliveries_project ON webhook_deliveries (project_id, id DESC);
  CREATE INDEX idx_deliveries_event ON webhook_deliveries (event_id);
  `,
  // version 4: forwarding to the developer's endpoint and fault-injection scenario runs
  `
  ALTER TABLE projects ADD COLUMN forward_mode TEXT NOT NULL DEFAULT 'manual';

  CREATE TABLE scenario_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES webhook_events (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    params_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    planned_attempts INTEGER NOT NULL,
    destination_url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    scheduled_for TEXT,
    started_at TEXT,
    finished_at TEXT,
    error_text TEXT,
    UNIQUE (project_id, idempotency_key)
  );
  CREATE INDEX idx_runs_project ON scenario_runs (project_id, created_at DESC);
  CREATE INDEX idx_runs_event ON scenario_runs (event_id);

  CREATE TABLE forward_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES scenario_runs (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES webhook_events (id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    delivery_kind TEXT NOT NULL,
    destination_url TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    http_status INTEGER,
    error_text TEXT,
    response_snippet TEXT,
    response_bytes INTEGER,
    body_sha256 TEXT NOT NULL,
    request_headers_json TEXT NOT NULL
  );
  CREATE INDEX idx_attempts_run ON forward_attempts (run_id, attempt_no);
  CREATE INDEX idx_attempts_event ON forward_attempts (event_id);
  `,
  // version 5: deterministic checks, evidence snapshots, optional state probe
  `
  ALTER TABLE projects ADD COLUMN probe_url TEXT;
  ALTER TABLE scenario_runs ADD COLUMN verdict TEXT;
  ALTER TABLE scenario_runs ADD COLUMN verdict_reason TEXT;
  ALTER TABLE scenario_runs ADD COLUMN evaluated_at TEXT;
  ALTER TABLE scenario_runs ADD COLUMN risks_json TEXT;

  CREATE TABLE run_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES scenario_runs (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    phase TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    http_status INTEGER,
    duration_ms INTEGER NOT NULL,
    error_text TEXT,
    data_json TEXT,
    UNIQUE (run_id, source, phase)
  );

  CREATE TABLE assertion_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES scenario_runs (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    check_id TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL
  );
  CREATE INDEX idx_assertions_project ON assertion_results (project_id, check_id);
  CREATE INDEX idx_assertions_run ON assertion_results (run_id);
  `,
  // version 6: AI test engineer (validated test plans and evidence-based run analyses)
  `
  CREATE TABLE ai_test_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
    validation_errors_json TEXT,
    matched_event_id TEXT REFERENCES webhook_events (id) ON DELETE SET NULL,
    executed_run_id TEXT REFERENCES scenario_runs (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_plans_project ON ai_test_plans (project_id, created_at DESC);

  CREATE TABLE ai_run_analyses (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES scenario_runs (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_analyses_project ON ai_run_analyses (project_id, created_at DESC);
  `,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

module.exports = { openDb, MIGRATIONS };

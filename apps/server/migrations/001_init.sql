-- Core schema. See plan.md §11. Implementation note: the junction aggregate is stored as one JSONB
-- snapshot (junction_state.state) written in the same transaction as the audit rows, instead of the
-- normalized queue/emergency/manual tables in the plan. Constraints that protect safety-relevant
-- invariants are kept as real database constraints.

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ftms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ftms_app;

CREATE TABLE junctions (
  junction_id            text PRIMARY KEY CHECK (junction_id ~ '^[A-Z0-9_-]{1,16}$'),
  name                   text NOT NULL,
  active_config_version  int  NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL
);

CREATE TABLE junction_configs (
  junction_id  text NOT NULL REFERENCES junctions (junction_id),
  version      int  NOT NULL CHECK (version > 0),
  config       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  PRIMARY KEY (junction_id, version)
);

ALTER TABLE junctions ADD CONSTRAINT junctions_active_config_fk
  FOREIGN KEY (junction_id, active_config_version)
  REFERENCES junction_configs (junction_id, version) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE junction_state (
  junction_id  text PRIMARY KEY REFERENCES junctions (junction_id),
  version      bigint NOT NULL,                -- optimistic concurrency (one writer per junction)
  epoch        int    NOT NULL DEFAULT 0,      -- fencing epoch, +1 per startup
  state        jsonb  NOT NULL,                -- JunctionState snapshot from the domain
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_events (
  source_id     text NOT NULL,
  event_id      text NOT NULL,
  junction_id   text NOT NULL,
  payload_hash  bytea NOT NULL,
  outcome       jsonb NOT NULL,
  received_at   timestamptz NOT NULL,
  PRIMARY KEY (source_id, event_id)
);
CREATE INDEX processed_events_received_at ON processed_events (received_at);

CREATE TABLE rejected_events (
  rejected_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL CHECK (channel IN ('HTTP','MQTT')),
  endpoint      text NOT NULL,
  source_id     text NULL,
  remote_addr   text NULL,
  reason_code   text NOT NULL,
  detail        text NULL,
  payload       jsonb NULL
);
CREATE INDEX rejected_events_received_at ON rejected_events (received_at);

CREATE TABLE controller_commands (
  command_id       text PRIMARY KEY,
  junction_id      text NOT NULL REFERENCES junctions (junction_id),
  seq              bigint NOT NULL,
  epoch            int NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('SET_ASPECTS','SAFE_STOP')),
  step             text NOT NULL,
  phase            text NULL,
  target_aspects   jsonb NULL,
  cause            text NOT NULL,
  status           text NOT NULL CHECK (status IN ('PENDING','ACKED','NACKED','TIMED_OUT','ABANDONED','SUPERSEDED','MISMATCH')),
  attempts         int NOT NULL DEFAULT 1,
  issued_at        timestamptz NOT NULL,
  resolved_at      timestamptz NULL,
  UNIQUE (junction_id, seq)
);
CREATE UNIQUE INDEX one_pending_command_per_junction ON controller_commands (junction_id) WHERE status = 'PENDING';

CREATE TABLE operator_requests (
  request_id        text PRIMARY KEY,
  junction_id       text NOT NULL REFERENCES junctions (junction_id),
  command           text NOT NULL,
  payload           jsonb NOT NULL,
  requested_by      text NOT NULL,
  idempotency_key   text NULL,
  outcome           jsonb NOT NULL,
  received_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX operator_requests_idempotency ON operator_requests (requested_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE audit_chain_heads (
  chain_id   text PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  bytea  NOT NULL
);

CREATE TABLE audit_log (
  audit_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id        text   NOT NULL,
  chain_seq       bigint NOT NULL,
  occurred_at     timestamptz NOT NULL,
  junction_id     text   NULL,
  event_type      text   NOT NULL,
  severity        text   NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL','SECURITY')),
  actor_type      text   NOT NULL CHECK (actor_type IN ('SYSTEM','SCHEDULER','OPERATOR','DEVICE','SIMULATOR')),
  actor_id        text   NULL,
  correlation_id  text   NULL,
  direction       text   NULL,
  previous_state  jsonb  NULL,
  new_state       jsonb  NULL,
  details         jsonb  NOT NULL DEFAULT '{}',
  prev_hash       bytea  NOT NULL,
  hash            bytea  NOT NULL,
  UNIQUE (chain_id, chain_seq)
);
CREATE INDEX audit_by_junction_time ON audit_log (junction_id, occurred_at DESC);
CREATE INDEX audit_by_correlation   ON audit_log (correlation_id);

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ftms_app;

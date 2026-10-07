CREATE TABLE users (
  user_id             text PRIMARY KEY,
  username            text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  role                text NOT NULL CHECK (role IN ('VIEWER','OPERATOR','ADMIN')),
  simulation_allowed  boolean NOT NULL DEFAULT false,
  failed_logins       int NOT NULL DEFAULT 0,
  locked_until        timestamptz NULL,
  disabled_at         timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  session_hash  bytea PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (user_id),
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  ip            text NULL,
  user_agent    text NULL,
  revoked_at    timestamptz NULL
);

CREATE TABLE devices (
  device_id     text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('SENSOR','CONTROLLER')),
  junction_id   text NOT NULL REFERENCES junctions (junction_id),
  approach      text NULL,
  key_prefix    text NOT NULL UNIQUE,
  key_hash      bytea NOT NULL,
  status        text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NULL,
  CHECK (kind <> 'SENSOR' OR approach IS NOT NULL)
);

-- The audit log stays append-only for the runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ftms_app;

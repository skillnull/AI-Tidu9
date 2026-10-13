CREATE TABLE IF NOT EXISTS tidu_enterprise_state (
  singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
  revision BIGINT NOT NULL CHECK (revision >= 0),
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

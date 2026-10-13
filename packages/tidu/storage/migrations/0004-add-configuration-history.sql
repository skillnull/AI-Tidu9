CREATE TABLE tidu_configuration_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('managed', 'expert')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  activated_at TEXT NOT NULL
) STRICT;

CREATE INDEX tidu_configuration_history_activated_at
ON tidu_configuration_history(activated_at DESC);

UPDATE tidu_metadata SET value = '4' WHERE key = 'schema_version';

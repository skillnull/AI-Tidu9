CREATE TABLE tidu_configuration_drafts (
  mode TEXT PRIMARY KEY NOT NULL CHECK (mode IN ('managed', 'expert')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tidu_active_configuration (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('managed', 'expert')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

UPDATE tidu_metadata SET value = '2' WHERE key = 'schema_version';

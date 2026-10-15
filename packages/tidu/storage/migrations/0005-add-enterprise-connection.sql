CREATE TABLE tidu_enterprise_connection (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  endpoint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  checked_at TEXT NOT NULL
) STRICT;

UPDATE tidu_metadata SET value = '5' WHERE key = 'schema_version';

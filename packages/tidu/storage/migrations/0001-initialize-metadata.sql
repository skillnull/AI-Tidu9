CREATE TABLE IF NOT EXISTS tidu_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

INSERT INTO tidu_metadata (key, value)
VALUES ('schema_version', '1')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

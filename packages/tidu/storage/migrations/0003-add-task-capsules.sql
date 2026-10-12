CREATE TABLE tidu_task_capsules (
  task_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'created',
      'running',
      'waiting_for_approval',
      'paused',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  capsule_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX tidu_task_capsules_updated_at
ON tidu_task_capsules(updated_at DESC);

UPDATE tidu_metadata SET value = '3' WHERE key = 'schema_version';

CREATE TABLE IF NOT EXISTS tidu_scaling_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  task_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tidu_scaling_tasks_schedule_idx
ON tidu_scaling_tasks (status, available_at, tenant_id);

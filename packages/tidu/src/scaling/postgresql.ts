import type { PostgresqlClient } from "../enterprise/postgresql.js";
import type { ScalingTaskRecord, ScalingTaskStore } from "./index.js";

interface ScalingTaskRow {
  /** Task idempotency key. */
  task_id: string;
  /** Optimistic task revision returned as a number or BIGINT string. */
  revision: number | string;
  /** JSONB task envelope. */
  task_json: ScalingTaskRecord | string;
}

const parseRow = (row: ScalingTaskRow): ScalingTaskRecord => {
  const revision = typeof row.revision === "string" ? Number(row.revision) : row.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("PostgreSQL scaling task revision is invalid.");
  }
  const task = typeof row.task_json === "string" ? JSON.parse(row.task_json) : row.task_json;
  if (task.id !== row.task_id || task.revision !== revision) {
    throw new Error("PostgreSQL scaling task state is inconsistent.");
  }
  return structuredClone(task);
};

export const initializePostgresqlScalingStorage = async (
  client: PostgresqlClient,
): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tidu_scaling_tasks (
      task_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      lease_expires_at TIMESTAMPTZ,
      revision BIGINT NOT NULL CHECK (revision >= 0),
      task_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS tidu_scaling_tasks_schedule_idx
    ON tidu_scaling_tasks (status, available_at, tenant_id)
  `);
};

export const createPostgresqlScalingTaskStore = (client: PostgresqlClient): ScalingTaskStore => ({
  get: async (taskId) => {
    const result = await client.query<ScalingTaskRow>(
      "SELECT task_id, revision, task_json FROM tidu_scaling_tasks WHERE task_id = $1",
      [taskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseRow(row);
  },
  countActive: async (tenantId) => {
    const result = await client.query<{ active_count: number | string }>(
      tenantId === undefined
        ? "SELECT COUNT(*) AS active_count FROM tidu_scaling_tasks WHERE status IN ('queued', 'leased')"
        : "SELECT COUNT(*) AS active_count FROM tidu_scaling_tasks WHERE status IN ('queued', 'leased') AND tenant_id = $1",
      tenantId === undefined ? [] : [tenantId],
    );
    const activeCount = Number(result.rows[0]?.active_count ?? 0);
    if (!Number.isSafeInteger(activeCount) || activeCount < 0) {
      throw new Error("PostgreSQL active task count is invalid.");
    }
    return activeCount;
  },
  listQueued: async (availableBefore) => {
    const result = await client.query<ScalingTaskRow>(
      `
        SELECT task_id, revision, task_json FROM tidu_scaling_tasks
        WHERE status = 'queued' AND available_at <= $1
        ORDER BY tenant_id, available_at, task_id
      `,
      [availableBefore],
    );
    return result.rows.map(parseRow);
  },
  listLeased: async () => {
    const result = await client.query<ScalingTaskRow>(
      "SELECT task_id, revision, task_json FROM tidu_scaling_tasks WHERE status = 'leased'",
    );
    return result.rows.map(parseRow);
  },
  listExpiredLeases: async (expiresBefore) => {
    const result = await client.query<ScalingTaskRow>(
      `
        SELECT task_id, revision, task_json FROM tidu_scaling_tasks
        WHERE status = 'leased' AND lease_expires_at <= $1
      `,
      [expiresBefore],
    );
    return result.rows.map(parseRow);
  },
  insert: async (task) => {
    const result = await client.query(
      `
        INSERT INTO tidu_scaling_tasks (
          task_id, tenant_id, status, available_at, lease_expires_at, revision, task_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (task_id) DO NOTHING
      `,
      [
        task.id,
        task.tenantId,
        task.status,
        task.availableAt,
        task.lease?.expiresAt ?? null,
        task.revision,
        JSON.stringify(task),
      ],
    );
    return result.rowCount === 1;
  },
  save: async (task, expectedRevision) => {
    const result = await client.query(
      `
        UPDATE tidu_scaling_tasks
        SET tenant_id = $1, status = $2, available_at = $3, lease_expires_at = $4,
            revision = $5, task_json = $6::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = $7 AND revision = $8
      `,
      [
        task.tenantId,
        task.status,
        task.availableAt,
        task.lease?.expiresAt ?? null,
        task.revision,
        JSON.stringify(task),
        task.id,
        expectedRevision,
      ],
    );
    return result.rowCount === 1;
  },
});

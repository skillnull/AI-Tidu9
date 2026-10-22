import type { DatabaseSync } from "node:sqlite";

import { TASK_CAPSULE_VERSION, type TaskCapsule, type TaskCapsuleStore } from "../agent/index.js";

interface TaskCapsuleRow {
  /** Serialized bounded task capsule. */
  capsule_json: string;
  /** Optimistic persistence revision. */
  revision: number;
}

const MAXIMUM_TASK_CAPSULE_BYTES = 256 * 1024;

const parseCapsule = (row: TaskCapsuleRow): TaskCapsule => {
  const capsule = JSON.parse(row.capsule_json) as TaskCapsule;
  if (
    capsule.capsuleVersion !== TASK_CAPSULE_VERSION ||
    capsule.revision !== row.revision ||
    typeof capsule.task?.taskId !== "string"
  ) {
    throw new Error("Stored task capsule is invalid or unsupported.");
  }
  return capsule;
};

const serializeCapsule = (capsule: TaskCapsule): string => {
  const serialized = JSON.stringify(capsule);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_TASK_CAPSULE_BYTES) {
    throw new Error(`Task capsule exceeds ${MAXIMUM_TASK_CAPSULE_BYTES} bytes.`);
  }
  return serialized;
};

export const createSqliteTaskCapsuleStore = (database: DatabaseSync): TaskCapsuleStore => {
  database
    .prepare("DELETE FROM tidu_task_capsules WHERE status IN ('completed', 'cancelled')")
    .run();
  return {
    load: async (taskId) => {
      const row = database
        .prepare("SELECT revision, capsule_json FROM tidu_task_capsules WHERE task_id = ?")
        .get(taskId) as TaskCapsuleRow | undefined;
      return row === undefined ? undefined : parseCapsule(row);
    },
    list: async (limit = 50) => {
      const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
      const rows = database
        .prepare(`
        SELECT revision, capsule_json
        FROM tidu_task_capsules
        ORDER BY updated_at DESC
        LIMIT ?
      `)
        .all(boundedLimit) as unknown as TaskCapsuleRow[];
      return rows.map(parseCapsule);
    },
    save: async (capsule, expectedRevision) => {
      const savedAt = new Date().toISOString();
      const savedCapsule: TaskCapsule = {
        ...structuredClone(capsule),
        revision: expectedRevision + 1,
        updatedAt: savedAt,
      };
      const serialized = serializeCapsule(savedCapsule);
      const existing = database
        .prepare("SELECT revision FROM tidu_task_capsules WHERE task_id = ?")
        .get(capsule.task.taskId) as Pick<TaskCapsuleRow, "revision"> | undefined;

      if ((existing?.revision ?? 0) !== expectedRevision) {
        throw new Error("Task capsule revision conflict.");
      }
      if (existing === undefined) {
        database
          .prepare(`
          INSERT INTO tidu_task_capsules
            (task_id, revision, status, capsule_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `)
          .run(
            savedCapsule.task.taskId,
            savedCapsule.revision,
            savedCapsule.task.status,
            serialized,
            savedAt,
          );
      } else {
        const update = database
          .prepare(`
          UPDATE tidu_task_capsules
          SET revision = ?, status = ?, capsule_json = ?, updated_at = ?
          WHERE task_id = ? AND revision = ?
        `)
          .run(
            savedCapsule.revision,
            savedCapsule.task.status,
            serialized,
            savedAt,
            savedCapsule.task.taskId,
            expectedRevision,
          );
        if (Number(update.changes) !== 1) {
          throw new Error("Task capsule revision conflict.");
        }
      }
      return savedCapsule;
    },
    remove: async (taskId) => {
      database.prepare("DELETE FROM tidu_task_capsules WHERE task_id = ?").run(taskId);
    },
  };
};

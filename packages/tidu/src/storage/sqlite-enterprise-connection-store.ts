import type { DatabaseSync } from "node:sqlite";
import type { EnterpriseConnectionSnapshot, EnterpriseConnectionStore } from "./types.js";

interface EnterpriseConnectionRow {
  /** Company runtime base URL. */
  endpoint: string;
  /** Serialized verified company snapshot. */
  snapshot_json: string;
  /** First successful connection timestamp. */
  connected_at: string;
  /** Latest successful metadata check timestamp. */
  checked_at: string;
}

const readSnapshot = (row: EnterpriseConnectionRow): EnterpriseConnectionSnapshot => {
  const snapshot = JSON.parse(row.snapshot_json) as Omit<
    EnterpriseConnectionSnapshot,
    "endpoint" | "connectedAt" | "checkedAt"
  >;
  return {
    ...snapshot,
    endpoint: row.endpoint,
    connectedAt: row.connected_at,
    checkedAt: row.checked_at,
  };
};

export const createSqliteEnterpriseConnectionStore = (
  database: DatabaseSync,
): EnterpriseConnectionStore => ({
  load: async () => {
    const row = database
      .prepare(
        `SELECT endpoint, snapshot_json, connected_at, checked_at
         FROM tidu_enterprise_connection WHERE singleton = 1`,
      )
      .get() as EnterpriseConnectionRow | undefined;
    return row === undefined ? null : readSnapshot(row);
  },
  save: async (snapshot) => {
    const existing = database
      .prepare("SELECT endpoint, connected_at FROM tidu_enterprise_connection WHERE singleton = 1")
      .get() as { endpoint: string; connected_at: string } | undefined;
    const connectedAt =
      existing?.endpoint === snapshot.endpoint ? existing.connected_at : snapshot.connectedAt;
    const serialized = JSON.stringify({
      companyName: snapshot.companyName,
      revision: snapshot.revision,
      virtualModelId: snapshot.virtualModelId,
      virtualModelName: snapshot.virtualModelName,
      policyCount: snapshot.policyCount,
      capabilityCount: snapshot.capabilityCount,
      resourceCount: snapshot.resourceCount,
      employeeGuidance: snapshot.employeeGuidance,
    });
    database
      .prepare(
        `INSERT INTO tidu_enterprise_connection (
           singleton, endpoint, snapshot_json, connected_at, checked_at
         ) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           endpoint = excluded.endpoint,
           snapshot_json = excluded.snapshot_json,
           checked_at = excluded.checked_at`,
      )
      .run(snapshot.endpoint, serialized, connectedAt, snapshot.checkedAt);
    return { ...snapshot, connectedAt };
  },
  remove: async () => {
    database.prepare("DELETE FROM tidu_enterprise_connection WHERE singleton = 1").run();
  },
});

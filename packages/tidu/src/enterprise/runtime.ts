import { Pool } from "pg";

import { createEnterpriseControlPlane, type EnterpriseControlPlane } from "./index.js";
import {
  createPostgresqlEnterpriseStateRepository,
  initializePostgresqlEnterpriseStorage,
} from "./postgresql.js";

export interface EnterpriseRuntime {
  /** PostgreSQL-backed enterprise control plane. */
  controlPlane: EnterpriseControlPlane;
  /** Releases the PostgreSQL connection pool. */
  close: () => Promise<void>;
}

export const createEnterpriseRuntimeFromEnvironment = async (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EnterpriseRuntime | undefined> => {
  const connectionString = environment.TIDU_POSTGRES_URL?.trim();
  if (!connectionString) {
    return undefined;
  }
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: environment.TIDU_POSTGRES_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  });
  try {
    await initializePostgresqlEnterpriseStorage(pool);
    return {
      controlPlane: createEnterpriseControlPlane(createPostgresqlEnterpriseStateRepository(pool)),
      close: async () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
};

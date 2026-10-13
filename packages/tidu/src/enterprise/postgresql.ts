import {
  createEmptyEnterpriseState,
  type EnterpriseState,
  type EnterpriseStateRepository,
} from "./index.js";

export interface PostgresqlQueryResult<Row> {
  /** Rows returned by the statement. */
  rows: readonly Row[];
  /** Number of rows changed or returned. */
  rowCount: number;
}

export interface PostgresqlClient {
  /** Executes a parameterized PostgreSQL statement. */
  query: <Row = Record<string, unknown>>(
    statement: string,
    parameters?: readonly unknown[],
  ) => Promise<PostgresqlQueryResult<Row>>;
}

interface EnterpriseStateRow {
  /** Optimistic state revision. */
  revision: number | string;
  /** JSONB state payload. */
  state_json: EnterpriseState | string;
}

const parseState = (row: EnterpriseStateRow): EnterpriseState => {
  const revision = typeof row.revision === "string" ? Number(row.revision) : row.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("PostgreSQL enterprise state revision is invalid.");
  }
  const state = typeof row.state_json === "string" ? JSON.parse(row.state_json) : row.state_json;
  if (state.revision !== revision) {
    throw new Error("PostgreSQL enterprise state revision is inconsistent.");
  }
  return structuredClone(state);
};

export const initializePostgresqlEnterpriseStorage = async (
  client: PostgresqlClient,
): Promise<void> => {
  const initialState = createEmptyEnterpriseState();
  await client.query(`
    CREATE TABLE IF NOT EXISTS tidu_enterprise_state (
      singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
      revision BIGINT NOT NULL CHECK (revision >= 0),
      state_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query(
    `
      INSERT INTO tidu_enterprise_state (singleton, revision, state_json)
      VALUES (1, 0, $1::jsonb)
      ON CONFLICT (singleton) DO NOTHING
    `,
    [JSON.stringify(initialState)],
  );
};

export const createPostgresqlEnterpriseStateRepository = (
  client: PostgresqlClient,
): EnterpriseStateRepository => ({
  load: async () => {
    const result = await client.query<EnterpriseStateRow>(
      "SELECT revision, state_json FROM tidu_enterprise_state WHERE singleton = 1",
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("PostgreSQL enterprise storage is not initialized.");
    }
    return parseState(row);
  },
  save: async (state, expectedRevision) => {
    const nextState: EnterpriseState = {
      ...structuredClone(state),
      revision: expectedRevision + 1,
    };
    const result = await client.query<EnterpriseStateRow>(
      `
        UPDATE tidu_enterprise_state
        SET revision = $1, state_json = $2::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1 AND revision = $3
        RETURNING revision, state_json
      `,
      [nextState.revision, JSON.stringify(nextState), expectedRevision],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Enterprise state revision conflict.");
    }
    return parseState(row);
  },
});

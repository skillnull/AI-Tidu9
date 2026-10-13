import type { DatabaseSync } from "node:sqlite";

import {
  type ConfigurationMode,
  createDefaultConfiguration,
  type TiduConfiguration,
  validateConfiguration,
} from "../config/index.js";
import { TiduError } from "../core/index.js";
import type {
  ActiveConfiguration,
  ConfigurationDraft,
  ConfigurationStore,
  ConfigurationWorkspace,
  SaveConfigurationDraftInput,
} from "./types.js";

interface ConfigurationRow {
  /** Stored configuration mode. */
  mode: ConfigurationMode;
  /** Stored JSON payload. */
  payload_json: string;
  /** Stored revision. */
  revision: number;
  /** Stored ISO update timestamp. */
  updated_at: string;
}

const CONFIGURATION_MODES = ["managed", "expert"] as const;

const normalizeConfiguration = (configuration: TiduConfiguration): TiduConfiguration => ({
  ...configuration,
  activeProfileId: configuration.activeProfileId.trim(),
  virtualModelName: configuration.virtualModelName.trim(),
});

const assertValidConfiguration = (
  configuration: TiduConfiguration,
  expectedMode: ConfigurationMode,
): TiduConfiguration => {
  const normalizedConfiguration = normalizeConfiguration(configuration);
  const validation = validateConfiguration(normalizedConfiguration, expectedMode);
  if (!validation.valid) {
    throw new TiduError("CONFIGURATION_INVALID", "Configuration validation failed.", {
      details: { issues: validation.issues },
    });
  }
  return normalizedConfiguration;
};

const parseConfiguration = (
  payload: string,
  expectedMode: ConfigurationMode,
): TiduConfiguration => {
  const configuration = JSON.parse(payload) as TiduConfiguration;
  return assertValidConfiguration(configuration, expectedMode);
};

const toDraft = (row: ConfigurationRow): ConfigurationDraft => ({
  mode: row.mode,
  revision: row.revision,
  configuration: parseConfiguration(row.payload_json, row.mode),
  updatedAt: row.updated_at,
});

const toActiveConfiguration = (row: ConfigurationRow): ActiveConfiguration => ({
  revision: row.revision,
  configuration: parseConfiguration(row.payload_json, row.mode),
  updatedAt: row.updated_at,
});

const throwRevisionConflict = (): never => {
  throw new TiduError(
    "CONFIGURATION_CONFLICT",
    "Configuration changed after it was loaded. Refresh before retrying.",
  );
};

export const createSqliteConfigurationStore = (database: DatabaseSync): ConfigurationStore => {
  const initialize = (): void => {
    const insertDraft = database.prepare(`
      INSERT OR IGNORE INTO tidu_configuration_drafts
        (mode, revision, payload_json, updated_at)
      VALUES (?, 1, ?, ?)
    `);
    const insertActive = database.prepare(`
      INSERT OR IGNORE INTO tidu_active_configuration
        (singleton, mode, revision, payload_json, updated_at)
      VALUES (1, ?, 1, ?, ?)
    `);
    const initializedAt = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const mode of CONFIGURATION_MODES) {
        insertDraft.run(mode, JSON.stringify(createDefaultConfiguration(mode)), initializedAt);
      }
      const managedConfiguration = createDefaultConfiguration("managed");
      insertActive.run("managed", JSON.stringify(managedConfiguration), initializedAt);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  };

  const loadWorkspace = async (): Promise<ConfigurationWorkspace> => {
    const draftRows = database
      .prepare(
        "SELECT mode, revision, payload_json, updated_at FROM tidu_configuration_drafts ORDER BY mode",
      )
      .all() as unknown as ConfigurationRow[];
    const activeRow = database
      .prepare(`
        SELECT mode, revision, payload_json, updated_at
        FROM tidu_active_configuration
        WHERE singleton = 1
      `)
      .get() as ConfigurationRow | undefined;
    const drafts = Object.fromEntries(draftRows.map((row) => [row.mode, toDraft(row)])) as Partial<
      Record<ConfigurationMode, ConfigurationDraft>
    >;

    if (activeRow === undefined || drafts.managed === undefined || drafts.expert === undefined) {
      throw new TiduError("INTERNAL_ERROR", "Configuration storage is incomplete.");
    }

    return {
      active: toActiveConfiguration(activeRow),
      drafts: {
        managed: drafts.managed,
        expert: drafts.expert,
      },
    };
  };

  const saveDraft = async (input: SaveConfigurationDraftInput): Promise<ConfigurationWorkspace> => {
    const configuration = assertValidConfiguration(input.configuration, input.mode);
    const updatedAt = new Date().toISOString();
    const updateResult = database
      .prepare(`
        UPDATE tidu_configuration_drafts
        SET revision = revision + 1, payload_json = ?, updated_at = ?
        WHERE mode = ? AND revision = ?
      `)
      .run(JSON.stringify(configuration), updatedAt, input.mode, input.expectedRevision);

    if (Number(updateResult.changes) !== 1) {
      throwRevisionConflict();
    }
    return loadWorkspace();
  };

  const activateDraft = async (
    mode: ConfigurationMode,
    expectedDraftRevision: number,
  ): Promise<ConfigurationWorkspace> => {
    const draftRow = database
      .prepare(`
        SELECT mode, revision, payload_json, updated_at
        FROM tidu_configuration_drafts
        WHERE mode = ?
      `)
      .get(mode) as ConfigurationRow | undefined;
    if (draftRow === undefined) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "Configuration changed after it was loaded. Refresh before retrying.",
      );
    }
    if (draftRow.revision !== expectedDraftRevision) {
      throwRevisionConflict();
    }
    const configuration = assertValidConfiguration(
      parseConfiguration(draftRow.payload_json, mode),
      mode,
    );
    const activatedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE;");
    try {
      database
        .prepare(`
        INSERT INTO tidu_configuration_history
          (mode, revision, payload_json, activated_at)
        SELECT mode, revision, payload_json, updated_at
        FROM tidu_active_configuration
        WHERE singleton = 1
      `)
        .run();
      database
        .prepare(`
        UPDATE tidu_active_configuration
        SET mode = ?, revision = revision + 1, payload_json = ?, updated_at = ?
        WHERE singleton = 1
      `)
        .run(mode, JSON.stringify(configuration), activatedAt);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return loadWorkspace();
  };

  const rollbackActive = async (): Promise<ConfigurationWorkspace> => {
    const previousRow = database
      .prepare(`
      SELECT history_id, mode, revision, payload_json, activated_at AS updated_at
      FROM tidu_configuration_history
      ORDER BY history_id DESC
      LIMIT 1
    `)
      .get() as (ConfigurationRow & { history_id: number }) | undefined;
    if (previousRow === undefined) {
      throw new TiduError("CONFIGURATION_CONFLICT", "No known-good configuration is available.");
    }
    const configuration = parseConfiguration(previousRow.payload_json, previousRow.mode);
    const restoredAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE;");
    try {
      database
        .prepare(`
        UPDATE tidu_active_configuration
        SET mode = ?, revision = revision + 1, payload_json = ?, updated_at = ?
        WHERE singleton = 1
      `)
        .run(previousRow.mode, JSON.stringify(configuration), restoredAt);
      database
        .prepare("DELETE FROM tidu_configuration_history WHERE history_id = ?")
        .run(previousRow.history_id);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return loadWorkspace();
  };

  initialize();
  return { activateDraft, loadWorkspace, rollbackActive, saveDraft };
};

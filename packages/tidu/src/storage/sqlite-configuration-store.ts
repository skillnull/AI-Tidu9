import type { DatabaseSync } from "node:sqlite";

import {
  type ConfigurationMode,
  createDefaultConfiguration,
  DEFAULT_VIRTUAL_MODEL_ID,
  type ExpertServiceConfiguration,
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

interface ExpertDraftPayload {
  /** Settings that exist only in expert mode. */
  expertServices: ExpertServiceConfiguration;
}

const normalizeConfiguration = (configuration: TiduConfiguration): TiduConfiguration => ({
  ...configuration,
  activeProfileId:
    configuration.activeProfileId.trim() === "managed-default"
      ? DEFAULT_VIRTUAL_MODEL_ID
      : configuration.activeProfileId.trim(),
  virtualModelName: configuration.virtualModelName.trim(),
  modelSelection: {
    source: configuration.modelSelection?.source ?? "official",
    model: configuration.modelSelection?.model.trim() || "current",
  },
  capabilityCompletion: {
    enabled: configuration.capabilityCompletion?.enabled ?? true,
    mainCapabilities: [
      ...new Set(
        (configuration.capabilityCompletion?.mainCapabilities ?? ["text", "structured-output"])
          .map((capability) => capability.trim())
          .filter(Boolean),
      ),
    ],
    specialists: (configuration.capabilityCompletion?.specialists ?? []).map((specialist) => ({
      source: specialist.source,
      model: specialist.model.trim(),
      capabilities: [
        ...new Set(specialist.capabilities.map((capability) => capability.trim())),
      ].filter(Boolean),
      inputCostPerMillionTokens: specialist.inputCostPerMillionTokens ?? null,
      outputCostPerMillionTokens: specialist.outputCostPerMillionTokens ?? null,
    })),
    maximumSpecialists: configuration.capabilityCompletion?.maximumSpecialists ?? 2,
    hostPolicies: Object.fromEntries(
      Object.entries(configuration.capabilityCompletion?.hostPolicies ?? {}).map(
        ([host, policy]) => [
          host,
          {
            mainModel: {
              source: policy.mainModel.source,
              model: policy.mainModel.model.trim(),
            },
            mainCapabilities: [
              ...new Set(policy.mainCapabilities.map((item) => item.trim())),
            ].filter(Boolean),
            specialists: policy.specialists.map((specialist) => ({
              source: specialist.source,
              model: specialist.model.trim(),
              capabilities: [...new Set(specialist.capabilities.map((item) => item.trim()))].filter(
                Boolean,
              ),
              inputCostPerMillionTokens: specialist.inputCostPerMillionTokens ?? null,
              outputCostPerMillionTokens: specialist.outputCostPerMillionTokens ?? null,
            })),
            maximumSpecialists: policy.maximumSpecialists,
          },
        ],
      ),
    ),
  },
  ...(configuration.expertServices
    ? {
        expertServices: {
          ...configuration.expertServices,
          host: configuration.expertServices.host.trim(),
        },
      }
    : {}),
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

const parseActiveConfiguration = (
  payload: string,
  expectedMode: ConfigurationMode,
): TiduConfiguration => {
  const configuration = JSON.parse(payload) as TiduConfiguration;
  return assertValidConfiguration(configuration, expectedMode);
};

const readSharedConfiguration = (row: ConfigurationRow): TiduConfiguration => {
  const storedConfiguration = JSON.parse(row.payload_json) as Partial<TiduConfiguration>;
  const sharedConfiguration: TiduConfiguration = {
    schemaVersion: "1",
    activeMode: "managed",
    activeProfileId: storedConfiguration.activeProfileId ?? DEFAULT_VIRTUAL_MODEL_ID,
    virtualModelName: storedConfiguration.virtualModelName ?? "九门赛博提督",
    modelSelection: storedConfiguration.modelSelection ?? { source: "official", model: "current" },
    capabilityCompletion:
      storedConfiguration.capabilityCompletion ??
      createDefaultConfiguration("managed").capabilityCompletion,
  };
  return assertValidConfiguration(sharedConfiguration, "managed");
};

const readExpertServices = (row: ConfigurationRow): ExpertServiceConfiguration => {
  const storedPayload = JSON.parse(row.payload_json) as Partial<
    TiduConfiguration & ExpertDraftPayload
  >;
  const defaultExpertServices = createDefaultConfiguration("expert").expertServices;
  if (storedPayload.expertServices !== undefined) {
    return storedPayload.expertServices;
  }
  if (defaultExpertServices === undefined) {
    throw new TiduError("INTERNAL_ERROR", "Expert service defaults are unavailable.");
  }
  return defaultExpertServices;
};

const createDraft = (
  mode: ConfigurationMode,
  row: ConfigurationRow,
  sharedConfiguration: TiduConfiguration,
  expertServices: ExpertServiceConfiguration,
): ConfigurationDraft => ({
  mode,
  revision: row.revision,
  configuration: assertValidConfiguration(
    {
      ...sharedConfiguration,
      activeMode: mode,
      ...(mode === "expert" ? { expertServices } : {}),
    },
    mode,
  ),
  updatedAt: row.updated_at,
});

const toActiveConfiguration = (row: ConfigurationRow): ActiveConfiguration => ({
  revision: row.revision,
  configuration: parseActiveConfiguration(row.payload_json, row.mode),
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
    const managedConfiguration = createDefaultConfiguration("managed");
    const expertConfiguration = createDefaultConfiguration("expert");

    database.exec("BEGIN IMMEDIATE;");
    try {
      insertDraft.run("managed", JSON.stringify(managedConfiguration), initializedAt);
      insertDraft.run(
        "expert",
        JSON.stringify({ expertServices: expertConfiguration.expertServices }),
        initializedAt,
      );
      insertActive.run("managed", JSON.stringify(managedConfiguration), initializedAt);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  };

  const loadDraftRows = (): Record<ConfigurationMode, ConfigurationRow> => {
    const rows = database
      .prepare(
        "SELECT mode, revision, payload_json, updated_at FROM tidu_configuration_drafts ORDER BY mode",
      )
      .all() as unknown as ConfigurationRow[];
    const drafts = Object.fromEntries(rows.map((row) => [row.mode, row])) as Partial<
      Record<ConfigurationMode, ConfigurationRow>
    >;
    if (drafts.managed === undefined || drafts.expert === undefined) {
      throw new TiduError("INTERNAL_ERROR", "Configuration storage is incomplete.");
    }
    return { managed: drafts.managed, expert: drafts.expert };
  };

  const loadWorkspace = async (): Promise<ConfigurationWorkspace> => {
    const draftRows = loadDraftRows();
    const activeRow = database
      .prepare(`
        SELECT mode, revision, payload_json, updated_at
        FROM tidu_active_configuration
        WHERE singleton = 1
      `)
      .get() as ConfigurationRow | undefined;
    if (activeRow === undefined) {
      throw new TiduError("INTERNAL_ERROR", "Configuration storage is incomplete.");
    }
    const sharedConfiguration = readSharedConfiguration(draftRows.managed);
    const expertServices = readExpertServices(draftRows.expert);
    return {
      active: toActiveConfiguration(activeRow),
      drafts: {
        managed: createDraft("managed", draftRows.managed, sharedConfiguration, expertServices),
        expert: createDraft("expert", draftRows.expert, sharedConfiguration, expertServices),
      },
    };
  };

  const saveDraft = async (input: SaveConfigurationDraftInput): Promise<ConfigurationWorkspace> => {
    const configuration = assertValidConfiguration(input.configuration, input.mode);
    const draftRows = loadDraftRows();
    if (draftRows[input.mode].revision !== input.expectedRevision) {
      throwRevisionConflict();
    }
    const updatedAt = new Date().toISOString();
    const sharedPayload: TiduConfiguration = {
      schemaVersion: configuration.schemaVersion,
      activeMode: "managed",
      activeProfileId: configuration.activeProfileId,
      virtualModelName: configuration.virtualModelName,
      modelSelection: configuration.modelSelection,
      capabilityCompletion: configuration.capabilityCompletion,
    };
    const expertPayload: ExpertDraftPayload = {
      expertServices: configuration.expertServices ?? readExpertServices(draftRows.expert),
    };

    database.exec("BEGIN IMMEDIATE;");
    try {
      database
        .prepare(`
          UPDATE tidu_configuration_drafts
          SET revision = revision + 1, payload_json = ?, updated_at = ?
          WHERE mode = 'managed'
        `)
        .run(JSON.stringify(sharedPayload), updatedAt);
      database
        .prepare(`
          UPDATE tidu_configuration_drafts
          SET revision = revision + 1, payload_json = ?, updated_at = ?
          WHERE mode = 'expert'
        `)
        .run(JSON.stringify(expertPayload), updatedAt);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return loadWorkspace();
  };

  const activateDraft = async (
    mode: ConfigurationMode,
    expectedDraftRevision: number,
  ): Promise<ConfigurationWorkspace> => {
    const workspace = await loadWorkspace();
    const draft = workspace.drafts[mode];
    if (draft.revision !== expectedDraftRevision) {
      throwRevisionConflict();
    }
    const configuration = assertValidConfiguration(draft.configuration, mode);
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
    const configuration = parseActiveConfiguration(previousRow.payload_json, previousRow.mode);
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

import type { TaskCapsuleStore } from "../agent/index.js";
import type { ConfigurationMode, TiduConfiguration } from "../config/index.js";

export interface ConfigurationDraft {
  /** Configuration mode owned exclusively by this draft. */
  mode: ConfigurationMode;
  /** Optimistic-concurrency revision. */
  revision: number;
  /** Last valid configuration persisted for this mode. */
  configuration: TiduConfiguration;
  /** ISO timestamp of the latest successful save. */
  updatedAt: string;
}

export interface ActiveConfiguration {
  /** Explicitly activated runtime configuration. */
  configuration: TiduConfiguration;
  /** Activation revision, independent from draft revisions. */
  revision: number;
  /** ISO timestamp of the latest activation. */
  updatedAt: string;
}

export interface ConfigurationWorkspace {
  /** Configuration currently driving runtime behavior. */
  active: ActiveConfiguration;
  /** Independently persisted valid drafts. */
  drafts: Readonly<Record<ConfigurationMode, ConfigurationDraft>>;
}

export interface SaveConfigurationDraftInput {
  /** Draft mode being updated. */
  mode: ConfigurationMode;
  /** Revision last observed by the caller. */
  expectedRevision: number;
  /** Candidate configuration, persisted only when valid. */
  configuration: TiduConfiguration;
}

export interface ConfigurationStore {
  /** Loads the active configuration and both isolated drafts. */
  loadWorkspace: () => Promise<ConfigurationWorkspace>;
  /** Validates and saves one draft without changing the active configuration. */
  saveDraft: (input: SaveConfigurationDraftInput) => Promise<ConfigurationWorkspace>;
  /** Explicitly activates a previously saved draft. */
  activateDraft: (
    mode: ConfigurationMode,
    expectedDraftRevision: number,
  ) => Promise<ConfigurationWorkspace>;
}

export interface StorageAdapter {
  /** Stable storage provider identifier. */
  provider: string;
  /** Provider-specific location used by the adapter. */
  location: string;
  /** Language-neutral schema version currently active in the store. */
  schemaVersion: string;
  /** Configuration persistence isolated behind the storage adapter. */
  configurationStore: ConfigurationStore;
  /** Bounded Agent task capsules used for recovery without storing full conversations. */
  taskCapsuleStore: TaskCapsuleStore;
  /** Releases resources owned by the adapter. */
  close: () => void;
}

export interface NodeSqliteStorageOptions {
  /** SQLite file path; use `:memory:` for an isolated ephemeral database. */
  databasePath?: string;
}

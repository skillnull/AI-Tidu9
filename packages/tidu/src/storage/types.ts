import type { TaskCapsuleStore } from "../agent/index.js";
import type { ConfigurationMode, TiduConfiguration } from "../config/index.js";

export interface ConfigurationDraft {
  /** Mode used to project the shared draft and optional expert extension. */
  mode: ConfigurationMode;
  /** Optimistic-concurrency revision. */
  revision: number;
  /** Composed view of the shared fields and mode-specific fields. */
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
  /** Mode projections backed by one shared draft and one expert-only extension. */
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
  /** Loads the active configuration and both projections of the shared draft. */
  loadWorkspace: () => Promise<ConfigurationWorkspace>;
  /** Validates and saves one draft without changing the active configuration. */
  saveDraft: (input: SaveConfigurationDraftInput) => Promise<ConfigurationWorkspace>;
  /** Explicitly activates a previously saved draft. */
  activateDraft: (
    mode: ConfigurationMode,
    expectedDraftRevision: number,
  ) => Promise<ConfigurationWorkspace>;
  /** Restores the most recent known-good active configuration. */
  rollbackActive: () => Promise<ConfigurationWorkspace>;
}

export interface EnterpriseConnectionSnapshot {
  /** Company runtime base URL entered by the employee. */
  endpoint: string;
  /** Company name published by the enterprise runtime. */
  companyName: string;
  /** Published enterprise-state revision. */
  revision: number;
  /** Read-only virtual-model identifier published by the company. */
  virtualModelId: string;
  /** Read-only virtual-model name published by the company. */
  virtualModelName: string;
  /** Number of published mandatory and advisory policies. */
  policyCount: number;
  /** Number of published internal capabilities. */
  capabilityCount: number;
  /** Number of published company model resources. */
  resourceCount: number;
  /** Sanitized employee guidance published by the company. */
  employeeGuidance: readonly string[];
  /** ISO timestamp of the first successful connection. */
  connectedAt: string;
  /** ISO timestamp of the latest successful metadata check. */
  checkedAt: string;
}

export interface EnterpriseConnectionStore {
  /** Loads the currently attached company snapshot, if any. */
  load: () => Promise<EnterpriseConnectionSnapshot | null>;
  /** Saves a verified company snapshot without storing credentials. */
  save: (snapshot: EnterpriseConnectionSnapshot) => Promise<EnterpriseConnectionSnapshot>;
  /** Removes the local company attachment only. */
  remove: () => Promise<void>;
}

export interface StorageAdapter {
  /** Stable storage provider identifier. */
  provider: string;
  /** Provider-specific location used by the adapter. */
  location: string;
  /** Language-neutral schema version currently active in the store. */
  schemaVersion: string;
  /** Non-sensitive table inventory exposed for local diagnostics. */
  tables?: readonly {
    /** Physical table name. */
    name: string;
    /** Current number of persisted rows. */
    rowCount: number;
  }[];
  /** Configuration persistence isolated behind the storage adapter. */
  configurationStore: ConfigurationStore;
  /** Employee-owned attachment to a remote enterprise runtime. */
  enterpriseConnectionStore: EnterpriseConnectionStore;
  /** Bounded Agent task capsules used for recovery without storing full conversations. */
  taskCapsuleStore: TaskCapsuleStore;
  /** Releases resources owned by the adapter. */
  close: () => void;
}

export interface NodeSqliteStorageOptions {
  /** SQLite file path; use `:memory:` for an isolated ephemeral database. */
  databasePath?: string;
}

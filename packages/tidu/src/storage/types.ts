export interface StorageAdapter {
  /** Stable storage provider identifier. */
  provider: string;
  /** Provider-specific location used by the adapter. */
  location: string;
  /** Language-neutral schema version currently active in the store. */
  schemaVersion: string;
  /** Releases resources owned by the adapter. */
  close: () => void;
}

export interface NodeSqliteStorageOptions {
  /** SQLite file path; use `:memory:` for an isolated ephemeral database. */
  databasePath?: string;
}

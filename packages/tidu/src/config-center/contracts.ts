import type { ConfigurationWorkspace } from "../storage/index.js";

export interface ConfigCenterBootstrap {
  /** Public product identity displayed by the local configuration center. */
  product: {
    /** Product name. */
    name: string;
    /** Short product explanation. */
    explanation: string;
    /** Product positioning statement. */
    positioning: string;
    /** Running package version. */
    version: string;
  };
  /** Current local runtime state. */
  runtime: {
    /** Runtime health state. */
    status: "ok";
  };
  /** Current storage adapter state. */
  storage: {
    /** Active storage provider identifier. */
    provider: string;
    /** Active storage schema version. */
    schemaVersion: string;
    /** Storage health state. */
    status: "ok";
  };
  /** Isolated drafts and the explicitly activated runtime configuration. */
  configuration: {
    /** Whether validated draft editing is available. */
    editable: true;
    /** Persisted active configuration and mode-specific drafts. */
    workspace: ConfigurationWorkspace;
  };
}

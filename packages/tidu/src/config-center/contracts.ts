import type { ConfigurationMode } from "../config/index.js";

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
  /** Safe configuration summary available before editing is implemented. */
  configuration: {
    /** Active configuration mode. */
    activeMode: ConfigurationMode;
    /** Whether configuration editing is available in this release. */
    editable: false;
    /** Configuration schema version. */
    schemaVersion: string;
    /** Virtual-model display name. */
    virtualModelName: string;
  };
}

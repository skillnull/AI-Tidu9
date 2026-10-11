export const CONFIG_SCHEMA_VERSION = "1" as const;

export type ConfigurationMode = "managed" | "expert";

export interface TiduConfiguration {
  /** Version used to migrate the persisted configuration safely. */
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Stable identifier for the active configuration profile. */
  activeProfileId: string;
  /** Determines whether managed defaults or an expert profile drives execution. */
  activeMode: ConfigurationMode;
  /** Virtual-model display name exposed to compatible clients. */
  virtualModelName: string;
}

export const createDefaultConfiguration = (): TiduConfiguration => ({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  activeProfileId: "managed-default",
  activeMode: "managed",
  virtualModelName: "九门赛博提督",
});

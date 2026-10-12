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

export interface ConfigurationValidationIssue {
  /** Stable machine-readable validation code. */
  code: "INVALID_MODE" | "INVALID_PROFILE_ID" | "INVALID_SCHEMA" | "INVALID_VIRTUAL_MODEL_NAME";
  /** Configuration field that failed validation. */
  field: keyof TiduConfiguration;
  /** Human-readable validation message. */
  message: string;
}

export interface ConfigurationValidationResult {
  /** Whether the configuration can be persisted and activated. */
  valid: boolean;
  /** Validation failures; empty when valid is true. */
  issues: readonly ConfigurationValidationIssue[];
}

export const createDefaultConfiguration = (
  mode: ConfigurationMode = "managed",
): TiduConfiguration => ({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  activeProfileId: `${mode}-default`,
  activeMode: mode,
  virtualModelName: "九门赛博提督",
});

export const validateConfiguration = (
  configuration: TiduConfiguration,
  expectedMode: ConfigurationMode = configuration.activeMode,
): ConfigurationValidationResult => {
  const issues: ConfigurationValidationIssue[] = [];

  if (configuration.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push({
      code: "INVALID_SCHEMA",
      field: "schemaVersion",
      message: `Configuration schema must be ${CONFIG_SCHEMA_VERSION}.`,
    });
  }
  if (configuration.activeMode !== expectedMode) {
    issues.push({
      code: "INVALID_MODE",
      field: "activeMode",
      message: `Configuration mode must remain ${expectedMode}.`,
    });
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(configuration.activeProfileId)) {
    issues.push({
      code: "INVALID_PROFILE_ID",
      field: "activeProfileId",
      message: "Profile ID must use 1-64 lowercase letters, numbers, or hyphens.",
    });
  }
  const virtualModelNameLength = [...configuration.virtualModelName.trim()].length;
  if (virtualModelNameLength < 1 || virtualModelNameLength > 64) {
    issues.push({
      code: "INVALID_VIRTUAL_MODEL_NAME",
      field: "virtualModelName",
      message: "Virtual-model name must contain 1-64 characters.",
    });
  }

  return { valid: issues.length === 0, issues };
};

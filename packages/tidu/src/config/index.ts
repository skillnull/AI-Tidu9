export const CONFIG_SCHEMA_VERSION = "1" as const;
export const DEFAULT_VIRTUAL_MODEL_ID = "ai-tidu9-config";

export type ConfigurationMode = "managed" | "expert";
export type ModelSource = "company" | "custom" | "official";
export type AgentHostId = "codex" | "cursor" | "ollama" | "openai-compatible";

export interface ModelSelection {
  /** Provider group used behind the single AI-Tidu9 virtual-model entry. */
  source: ModelSource;
  /** Upstream model ID, or `current` to follow the active official Codex model. */
  model: string;
}

export interface CapabilitySpecialistConfiguration extends ModelSelection {
  /** Different host whose model supplies the missing capability. */
  host: AgentHostId;
  /** Capabilities this specialist is explicitly allowed to complete. */
  capabilities: readonly string[];
  /** Configured input price per million tokens, or null when unknown or account-funded. */
  inputCostPerMillionTokens?: number | null;
  /** Configured output price per million tokens, or null when unknown or account-funded. */
  outputCostPerMillionTokens?: number | null;
}

export interface HostCapabilityCompletionPolicy {
  /** Primary model used when requests enter through this host. */
  mainModel: ModelSelection;
  /** Capabilities explicitly declared for this host's primary model. */
  mainCapabilities: readonly string[];
  /** Specialist pool isolated to this host. */
  specialists: readonly CapabilitySpecialistConfiguration[];
  /** Hard upper bound for specialist calls in one request. */
  maximumSpecialists: number;
}

export interface CapabilityCompletionConfiguration {
  /** Enables bounded specialist calls when the primary model lacks a required capability. */
  enabled: boolean;
  /** Capabilities explicitly declared for the selected primary model. */
  mainCapabilities: readonly string[];
  /** Ordered, explicitly configured specialist pool. */
  specialists: readonly CapabilitySpecialistConfiguration[];
  /** Hard upper bound for specialist calls in one model request. */
  maximumSpecialists: number;
  /** Host-isolated policies; legacy top-level fields remain the default fallback. */
  hostPolicies?: Partial<Record<AgentHostId, HostCapabilityCompletionPolicy>>;
}

export interface ExpertServiceConfiguration {
  /** Network interface used by the local runtime after the next restart. */
  host: string;
  /** TCP port used by the local runtime after the next restart. */
  port: number;
  /** Whether the OpenAI Responses compatible endpoint is exposed. */
  responsesApiEnabled: boolean;
  /** Whether the OpenAI Chat Completions compatible endpoint is exposed. */
  chatCompletionsApiEnabled: boolean;
  /** Whether the bounded Agent task API is exposed. */
  taskApiEnabled: boolean;
}

export interface TiduConfiguration {
  /** Version used to migrate the persisted configuration safely. */
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  /** Stable identifier for the active configuration profile. */
  activeProfileId: string;
  /** Determines whether managed defaults or an expert profile drives execution. */
  activeMode: ConfigurationMode;
  /** Virtual-model display name exposed to compatible clients. */
  virtualModelName: string;
  /** Upstream selected behind the virtual model. */
  modelSelection: ModelSelection;
  /** Shared Agent-level capability completion policy used by every host entry point. */
  capabilityCompletion: CapabilityCompletionConfiguration;
  /** Advanced service settings, present only for expert-mode configurations. */
  expertServices?: ExpertServiceConfiguration;
}

export interface ConfigurationValidationIssue {
  /** Stable machine-readable validation code. */
  code:
    | "INVALID_EXPERT_HOST"
    | "INVALID_EXPERT_PORT"
    | "INVALID_MODE"
    | "INVALID_PROFILE_ID"
    | "INVALID_SCHEMA"
    | "INVALID_MODEL_SELECTION"
    | "INVALID_VIRTUAL_MODEL_NAME";
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
): TiduConfiguration => {
  const configuration: TiduConfiguration = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeProfileId: mode === "managed" ? DEFAULT_VIRTUAL_MODEL_ID : "expert-default",
    activeMode: mode,
    virtualModelName: "九门赛博提督",
    modelSelection: { source: "official", model: "current" },
    capabilityCompletion: {
      enabled: false,
      mainCapabilities: ["text", "structured-output"],
      specialists: [],
      maximumSpecialists: 2,
      hostPolicies: {},
    },
  };
  if (mode === "expert") {
    configuration.expertServices = {
      host: "127.0.0.1",
      port: 9639,
      responsesApiEnabled: true,
      chatCompletionsApiEnabled: true,
      taskApiEnabled: true,
    };
  }
  return configuration;
};

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
  if (
    (configuration.modelSelection.source !== "official" &&
      configuration.modelSelection.source !== "company" &&
      configuration.modelSelection.source !== "custom") ||
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(configuration.modelSelection.model.trim())
  ) {
    issues.push({
      code: "INVALID_MODEL_SELECTION",
      field: "modelSelection",
      message: "Model selection must contain a supported source and non-empty model ID.",
    });
  }
  const completion = configuration.capabilityCompletion;
  const safeCapability = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;
  const policies = [
    {
      host: undefined,
      mainModel: configuration.modelSelection,
      mainCapabilities: completion.mainCapabilities,
      specialists: completion.specialists,
      maximumSpecialists: completion.maximumSpecialists,
    },
    ...Object.entries(completion.hostPolicies ?? {}).map(([host, policy]) => ({
      host: host as AgentHostId,
      ...policy,
    })),
  ];
  if (
    typeof completion?.enabled !== "boolean" ||
    policies.some(
      (policy) =>
        !Number.isInteger(policy.maximumSpecialists) ||
        policy.maximumSpecialists < 1 ||
        policy.maximumSpecialists > 8 ||
        policy.mainCapabilities.length === 0 ||
        policy.mainCapabilities.some((capability) => !safeCapability.test(capability)) ||
        policy.specialists.some(
          (specialist) =>
            (specialist.source !== "official" &&
              specialist.source !== "company" &&
              specialist.source !== "custom") ||
            (specialist.host !== "codex" &&
              specialist.host !== "cursor" &&
              specialist.host !== "ollama" &&
              specialist.host !== "openai-compatible") ||
            specialist.host === policy.host ||
            !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(specialist.model) ||
            specialist.capabilities.length === 0 ||
            specialist.capabilities.some((capability) => !safeCapability.test(capability)) ||
            (specialist.inputCostPerMillionTokens != null &&
              (!Number.isFinite(specialist.inputCostPerMillionTokens) ||
                specialist.inputCostPerMillionTokens < 0)) ||
            (specialist.outputCostPerMillionTokens != null &&
              (!Number.isFinite(specialist.outputCostPerMillionTokens) ||
                specialist.outputCostPerMillionTokens < 0)),
        ),
    )
  ) {
    issues.push({
      code: "INVALID_MODEL_SELECTION",
      field: "capabilityCompletion",
      message: "Capability completion requires valid primary capabilities and specialist models.",
    });
  }
  if (expectedMode === "expert" && configuration.expertServices !== undefined) {
    if (
      !/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+)$/iu.test(
        configuration.expertServices.host.trim(),
      )
    ) {
      issues.push({
        code: "INVALID_EXPERT_HOST",
        field: "expertServices",
        message: "Expert runtime host must be a hostname or IPv4 address.",
      });
    }
    if (
      !Number.isInteger(configuration.expertServices.port) ||
      configuration.expertServices.port < 1 ||
      configuration.expertServices.port > 65_535
    ) {
      issues.push({
        code: "INVALID_EXPERT_PORT",
        field: "expertServices",
        message: "Expert runtime port must be an integer from 1 to 65535.",
      });
    }
  }

  return { valid: issues.length === 0, issues };
};

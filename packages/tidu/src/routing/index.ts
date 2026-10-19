import type {
  AgentHostId,
  CapabilityCompletionConfiguration,
  CapabilitySpecialistConfiguration,
  ModelSelection,
} from "../config/index.js";
import type {
  ModelProvider,
  ProviderExecutionRequest,
  ProviderExecutionResult,
  ProviderPrivacy,
} from "../providers/index.js";

export interface RoutingMetricWeights {
  /** Weight assigned to required-capability coverage. */
  capability: number;
  /** Weight assigned to lower configured token cost. */
  cost: number;
  /** Weight assigned to a tighter data boundary. */
  privacy: number;
  /** Weight assigned to lower observed or configured latency. */
  latency: number;
  /** Weight assigned to current provider availability. */
  availability: number;
}

export interface ModelRouteProfile {
  /** Stable model identifier used by routing policies. */
  id: string;
  /** Capabilities the model is configured and verified to provide. */
  capabilities: readonly string[];
  /** Configured input price per million tokens; zero represents a free model. */
  inputCostPerMillionTokens: number;
  /** Configured output price per million tokens; zero represents a free model. */
  outputCostPerMillionTokens: number;
  /** Expected or recently observed end-to-end latency. */
  averageLatencyMilliseconds: number;
  /** Availability ratio from zero to one. */
  availability: number;
  /** Data boundary on which the model executes. */
  privacy: ProviderPrivacy;
  /** Remaining request allowance, or null when unmetered or unknown. */
  remainingRequests: number | null;
  /** Whether the model may receive new requests. */
  enabled: boolean;
}

export interface RoutableModel {
  /** Non-secret routing metadata. */
  profile: ModelRouteProfile;
  /** Provider adapter that performs the actual request. */
  provider: ModelProvider;
}

export interface CapabilityCompletionPolicy {
  /** Enables bounded specialist calls before the main-model request. */
  enabled: boolean;
  /** Model identifiers explicitly allowed to provide missing capabilities. */
  poolModelIds: readonly string[];
  /** Maximum specialists called for one request. */
  maximumSpecialists: number;
}

export interface DynamicRoutingPolicy {
  /** Enables scoring and fallback; disabled mode always uses the configured main model. */
  enabled: boolean;
  /** Preferred model used when it satisfies request constraints. */
  mainModelId: string;
  /** Relative weights used by deterministic model scoring. */
  weights: RoutingMetricWeights;
  /** Optional capability-completion pool. */
  capabilityCompletion: CapabilityCompletionPolicy;
}

export interface RoutingDecision {
  /** Selected primary model. */
  mainModelId: string;
  /** Bounded specialists called before the primary model. */
  specialistModelIds: readonly string[];
  /** Capabilities required by the request. */
  requiredCapabilities: readonly string[];
  /** Capabilities that could not be covered. */
  missingCapabilities: readonly string[];
  /** Deterministic score of the selected primary model. */
  score: number;
  /** Estimated configured cost per million input and output tokens. */
  estimatedCostPerMillionTokens: number;
}

export interface DynamicModelRouter extends ModelProvider {
  /** Returns the latest non-secret routing decision. */
  inspect: () => RoutingDecision | undefined;
}

export interface CapabilityCompletionUsageRecord extends RoutingDecision {
  /** Host entry whose isolated policy produced this route. */
  host: AgentHostId;
  /** ISO timestamp for the completed routing attempt. */
  occurredAt: string;
  /** Agent role that requested the route. */
  role: string;
  /** Whether at least one specialist actually contributed. */
  complemented: boolean;
  /** Upstream request outcome after routing. */
  outcome: "failed" | "succeeded";
}

export interface CapabilityCompletionStatus {
  /** Active policy snapshot. */
  configuration: CapabilityCompletionConfiguration;
  /** Primary upstream selected by the active configuration. */
  mainModel: ModelSelection;
  /** Recent bounded usage, newest first. */
  records: readonly CapabilityCompletionUsageRecord[];
}

export interface CapabilityCompletionProvider extends ModelProvider {
  /** Returns the active policy and bounded non-secret usage records. */
  inspectCapabilityCompletion: () => Promise<CapabilityCompletionStatus>;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const PRIVACY_RANK: Readonly<Record<ProviderPrivacy, number>> = {
  local: 0,
  private: 1,
  external: 2,
};
const DEFAULT_REQUIRED_CAPABILITY = "text";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeCapabilities = (capabilities: readonly string[]): readonly string[] =>
  [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].sort();

const inferCapabilities = (request: ProviderExecutionRequest): readonly string[] => {
  const inferred = new Set<string>([
    DEFAULT_REQUIRED_CAPABILITY,
    ...(request.routing?.requiredCapabilities ?? []),
  ]);
  if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
    inferred.add("tool-use");
  }
  if (request.body.response_format !== undefined) {
    inferred.add("structured-output");
  }
  if (request.protocol === "responses") {
    inferred.add("responses");
  }
  const serialized = JSON.stringify(request.body);
  if (/"type"\s*:\s*"(?:image|image_url|input_image)"/u.test(serialized)) {
    inferred.add("vision");
  }
  return normalizeCapabilities([...inferred]);
};

const validateProfile = (profile: ModelRouteProfile): ModelRouteProfile => {
  if (!ID_PATTERN.test(profile.id)) {
    throw new Error("Routable models require a safe stable identifier.");
  }
  const capabilities = normalizeCapabilities(profile.capabilities);
  if (capabilities.length === 0) {
    throw new Error(`Routable model ${profile.id} must declare at least one capability.`);
  }
  const costs = [profile.inputCostPerMillionTokens, profile.outputCostPerMillionTokens];
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) {
    throw new Error(`Routable model ${profile.id} has an invalid configured cost.`);
  }
  if (
    !Number.isFinite(profile.averageLatencyMilliseconds) ||
    profile.averageLatencyMilliseconds < 0
  ) {
    throw new Error(`Routable model ${profile.id} has invalid latency metadata.`);
  }
  if (
    !Number.isFinite(profile.availability) ||
    profile.availability < 0 ||
    profile.availability > 1
  ) {
    throw new Error(`Routable model ${profile.id} has invalid availability metadata.`);
  }
  if (
    profile.remainingRequests !== null &&
    (!Number.isSafeInteger(profile.remainingRequests) || profile.remainingRequests < 0)
  ) {
    throw new Error(`Routable model ${profile.id} has invalid remainingRequests metadata.`);
  }
  return { ...profile, capabilities };
};

const covers = (profile: ModelRouteProfile, capabilities: readonly string[]): boolean =>
  capabilities.every((capability) => profile.capabilities.includes(capability));

const scoreProfile = (
  profile: ModelRouteProfile,
  requiredCapabilities: readonly string[],
  weights: RoutingMetricWeights,
): number => {
  const coverage =
    requiredCapabilities.filter((capability) => profile.capabilities.includes(capability)).length /
    Math.max(1, requiredCapabilities.length);
  const configuredCost = profile.inputCostPerMillionTokens + profile.outputCostPerMillionTokens;
  const costScore = 1 / (1 + configuredCost);
  const latencyScore = 1 / (1 + profile.averageLatencyMilliseconds / 1000);
  const privacyScore = (3 - PRIVACY_RANK[profile.privacy]) / 3;
  return (
    coverage * weights.capability +
    costScore * weights.cost +
    privacyScore * weights.privacy +
    latencyScore * weights.latency +
    profile.availability * weights.availability
  );
};

const extractModelText = (result: ProviderExecutionResult): string => {
  if (result.kind !== "json" || !isRecord(result.body)) {
    throw new Error("Capability-completion specialists must return bounded JSON responses.");
  }
  if (Array.isArray(result.body.choices)) {
    const choice = result.body.choices[0];
    if (
      isRecord(choice) &&
      isRecord(choice.message) &&
      typeof choice.message.content === "string"
    ) {
      return choice.message.content.slice(0, 8192);
    }
  }
  if (typeof result.body.output_text === "string") {
    return result.body.output_text.slice(0, 8192);
  }
  throw new Error("Capability-completion specialist returned no text result.");
};

const injectSpecialistContext = (
  request: ProviderExecutionRequest,
  contributions: readonly { modelId: string; capabilities: readonly string[]; result: string }[],
): ProviderExecutionRequest => {
  if (contributions.length === 0) {
    return request;
  }
  const context = {
    instruction:
      "Use these bounded specialist results as evidence. Validate them and do not claim capabilities beyond the supplied results.",
    contributions,
  };
  if (request.protocol === "chat-completions") {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    return {
      ...request,
      body: {
        ...request.body,
        messages: [{ role: "system", content: JSON.stringify(context) }, ...messages],
      },
    };
  }
  const input = request.body.input;
  const normalizedInput = Array.isArray(input)
    ? input
    : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input ?? "") }];
  return {
    ...request,
    body: {
      ...request.body,
      input: [{ role: "system", content: JSON.stringify(context) }, ...normalizedInput],
    },
  };
};

export const createDynamicModelRouter = (
  inputModels: readonly RoutableModel[],
  policy: DynamicRoutingPolicy,
): DynamicModelRouter => {
  if (inputModels.length === 0) {
    throw new Error("Dynamic routing requires at least one model.");
  }
  const models = inputModels.map((model) => ({
    ...model,
    profile: validateProfile(model.profile),
  }));
  const modelsById = new Map(models.map((model) => [model.profile.id, model]));
  if (modelsById.size !== models.length || !modelsById.has(policy.mainModelId)) {
    throw new Error(
      "Routing model identifiers must be unique and include the configured main model.",
    );
  }
  if (
    !Number.isSafeInteger(policy.capabilityCompletion.maximumSpecialists) ||
    policy.capabilityCompletion.maximumSpecialists < 1 ||
    policy.capabilityCompletion.maximumSpecialists > 8
  ) {
    throw new Error("maximumSpecialists must be an integer from 1 to 8.");
  }
  const weightValues = Object.values(policy.weights);
  if (weightValues.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("Routing weights must be non-negative finite numbers.");
  }
  const exhaustedModels = new Set<string>();
  let latestDecision: RoutingDecision | undefined;

  const eligibleModels = (privacy: ProviderPrivacy): readonly RoutableModel[] =>
    models.filter(
      (model) =>
        model.profile.enabled &&
        model.profile.remainingRequests !== 0 &&
        !exhaustedModels.has(model.profile.id) &&
        PRIVACY_RANK[model.profile.privacy] <= PRIVACY_RANK[privacy],
    );

  const rankModels = (
    candidates: readonly RoutableModel[],
    capabilities: readonly string[],
  ): readonly RoutableModel[] =>
    [...candidates].sort(
      (left, right) =>
        scoreProfile(right.profile, capabilities, policy.weights) -
          scoreProfile(left.profile, capabilities, policy.weights) ||
        left.profile.id.localeCompare(right.profile.id),
    );

  const selectRoute = (
    request: ProviderExecutionRequest,
    excludedMainIds: ReadonlySet<string> = new Set(),
  ): { main: RoutableModel; specialists: readonly RoutableModel[]; decision: RoutingDecision } => {
    const requiredCapabilities = inferCapabilities(request);
    const privacy = request.routing?.privacy ?? "external";
    const eligible = eligibleModels(privacy).filter(
      (model) => !excludedMainIds.has(model.profile.id),
    );
    if (eligible.length === 0) {
      throw new Error("No enabled model satisfies the request privacy and quota constraints.");
    }
    const configuredMain = modelsById.get(policy.mainModelId) as RoutableModel;
    const preferredMain = eligible.find((model) => model.profile.id === configuredMain.profile.id);
    let main: RoutableModel | undefined;
    const specialists: RoutableModel[] = [];

    if (!policy.enabled) {
      main = preferredMain;
    } else if (preferredMain !== undefined && covers(preferredMain.profile, requiredCapabilities)) {
      main = preferredMain;
    } else if (preferredMain !== undefined && policy.capabilityCompletion.enabled) {
      const missing = new Set(
        requiredCapabilities.filter(
          (capability) => !preferredMain.profile.capabilities.includes(capability),
        ),
      );
      const pool = eligible.filter(
        (model) =>
          model.profile.id !== preferredMain.profile.id &&
          policy.capabilityCompletion.poolModelIds.includes(model.profile.id),
      );
      while (
        missing.size > 0 &&
        specialists.length < policy.capabilityCompletion.maximumSpecialists
      ) {
        const next = rankModels(
          pool.filter((model) => !specialists.includes(model)),
          [...missing],
        ).find((model) => model.profile.capabilities.some((capability) => missing.has(capability)));
        if (next === undefined) {
          break;
        }
        specialists.push(next);
        for (const capability of next.profile.capabilities) {
          missing.delete(capability);
        }
      }
      if (missing.size === 0) {
        main = preferredMain;
      } else {
        specialists.length = 0;
      }
    }
    main ??= rankModels(
      eligible.filter((model) => covers(model.profile, requiredCapabilities)),
      requiredCapabilities,
    )[0];
    if (main === undefined) {
      throw new Error("No configured model or capability-completion pool can cover this request.");
    }
    const covered = new Set(main.profile.capabilities);
    for (const specialist of specialists) {
      for (const capability of specialist.profile.capabilities) {
        covered.add(capability);
      }
    }
    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !covered.has(capability),
    );
    const estimatedCostPerMillionTokens = [main, ...specialists].reduce(
      (cost, model) =>
        cost + model.profile.inputCostPerMillionTokens + model.profile.outputCostPerMillionTokens,
      0,
    );
    return {
      main,
      specialists,
      decision: {
        mainModelId: main.profile.id,
        specialistModelIds: specialists.map((model) => model.profile.id),
        requiredCapabilities,
        missingCapabilities,
        score: scoreProfile(main.profile, requiredCapabilities, policy.weights),
        estimatedCostPerMillionTokens,
      },
    };
  };

  const execute = async (request: ProviderExecutionRequest): Promise<ProviderExecutionResult> => {
    const attemptedMainIds = new Set<string>();
    while (attemptedMainIds.size < models.length) {
      const route = selectRoute(request, attemptedMainIds);
      latestDecision = route.decision;
      const contributions = await Promise.all(
        route.specialists.map(async (specialist) => {
          const specialistResult = await specialist.provider.execute({
            ...request,
            body: { ...request.body, stream: false },
            routing: { ...request.routing, role: "specialist" },
          });
          if (specialistResult.statusCode === 429) {
            exhaustedModels.add(specialist.profile.id);
            throw new Error(`Capability specialist ${specialist.profile.id} exhausted its quota.`);
          }
          if (specialistResult.statusCode < 200 || specialistResult.statusCode >= 300) {
            throw new Error(`Capability specialist ${specialist.profile.id} failed.`);
          }
          return {
            modelId: specialist.profile.id,
            capabilities: specialist.profile.capabilities.filter((capability) =>
              route.decision.requiredCapabilities.includes(capability),
            ),
            result: extractModelText(specialistResult),
          };
        }),
      );
      const result = await route.main.provider.execute({
        ...injectSpecialistContext(request, contributions),
        routing: { ...request.routing, role: request.routing?.role ?? "main" },
      });
      if (result.statusCode !== 429) {
        return result;
      }
      exhaustedModels.add(route.main.profile.id);
      attemptedMainIds.add(route.main.profile.id);
    }
    throw new Error("All eligible model quotas are exhausted.");
  };

  return {
    descriptor: { type: "tidu-router", model: policy.mainModelId },
    execute,
    inspect: () => (latestDecision === undefined ? undefined : structuredClone(latestDecision)),
  };
};

export const createCapabilityCompletionProvider = (
  provider: ModelProvider,
  loadConfiguration: () => Promise<{
    modelSelection: ModelSelection;
    capabilityCompletion: CapabilityCompletionConfiguration;
  }>,
): CapabilityCompletionProvider => {
  const records: CapabilityCompletionUsageRecord[] = [];
  const bindModel = (
    selection: ModelSelection,
    capabilities: readonly string[],
    id: string,
    costs?: Pick<
      CapabilitySpecialistConfiguration,
      "inputCostPerMillionTokens" | "outputCostPerMillionTokens"
    >,
  ): RoutableModel => ({
    profile: {
      id,
      capabilities,
      inputCostPerMillionTokens: costs?.inputCostPerMillionTokens ?? Number.MAX_SAFE_INTEGER,
      outputCostPerMillionTokens: costs?.outputCostPerMillionTokens ?? Number.MAX_SAFE_INTEGER,
      averageLatencyMilliseconds: 0,
      availability: 1,
      privacy: selection.source === "company" ? "private" : "external",
      remainingRequests: null,
      enabled: true,
    },
    provider: {
      descriptor: provider.descriptor,
      execute: (request) =>
        provider.execute({
          ...request,
          routing: {
            ...request.routing,
            modelSource: selection.source,
            ...(selection.model === "current" ? {} : { targetModel: selection.model }),
          },
        }),
    },
  });
  const resolveHostPolicy = (
    active: Awaited<ReturnType<typeof loadConfiguration>>,
    host: AgentHostId | undefined,
  ) => {
    const policy =
      host === undefined ? undefined : active.capabilityCompletion.hostPolicies?.[host];
    return policy === undefined
      ? {
          modelSelection: active.modelSelection,
          mainCapabilities: active.capabilityCompletion.mainCapabilities,
          specialists: active.capabilityCompletion.specialists,
          maximumSpecialists: active.capabilityCompletion.maximumSpecialists,
        }
      : {
          modelSelection: policy.mainModel,
          mainCapabilities: policy.mainCapabilities,
          specialists: policy.specialists,
          maximumSpecialists: policy.maximumSpecialists,
        };
  };
  const readStatus = async (): Promise<CapabilityCompletionStatus> => {
    const configuration = await loadConfiguration();
    return {
      configuration: structuredClone(configuration.capabilityCompletion),
      mainModel: structuredClone(configuration.modelSelection),
      records: structuredClone(records),
    };
  };
  return {
    descriptor: provider.descriptor,
    listModels: provider.listModels?.bind(provider),
    close: provider.close?.bind(provider),
    inspectCapabilityCompletion: readStatus,
    execute: async (request) => {
      const active = await loadConfiguration();
      const hostPolicy = resolveHostPolicy(active, request.routing?.host);
      const mainId = `main:${hostPolicy.modelSelection.source}:${hostPolicy.modelSelection.model}`;
      const specialists = hostPolicy.specialists.map((specialist, index) =>
        bindModel(
          specialist,
          specialist.capabilities,
          `specialist-${index}:${specialist.source}:${specialist.model}`,
          specialist,
        ),
      );
      if (!active.capabilityCompletion.enabled || specialists.length === 0) {
        const requiredCapabilities = inferCapabilities(request);
        const result = await bindModel(
          hostPolicy.modelSelection,
          hostPolicy.mainCapabilities,
          mainId,
        ).provider.execute(request);
        records.unshift({
          host: request.routing?.host ?? "openai-compatible",
          mainModelId: mainId,
          specialistModelIds: [],
          requiredCapabilities,
          missingCapabilities: requiredCapabilities.filter(
            (capability) => !hostPolicy.mainCapabilities.includes(capability),
          ),
          score: 0,
          estimatedCostPerMillionTokens: 0,
          occurredAt: new Date().toISOString(),
          role: request.routing?.role ?? "main",
          complemented: false,
          outcome: result.statusCode >= 200 && result.statusCode < 300 ? "succeeded" : "failed",
        });
        records.splice(50);
        return result;
      }
      const router = createDynamicModelRouter(
        [bindModel(hostPolicy.modelSelection, hostPolicy.mainCapabilities, mainId), ...specialists],
        {
          enabled: active.capabilityCompletion.enabled,
          mainModelId: mainId,
          weights: { capability: 10, cost: 1, privacy: 2, latency: 1, availability: 3 },
          capabilityCompletion: {
            enabled: active.capabilityCompletion.enabled,
            poolModelIds: specialists.map((specialist) => specialist.profile.id),
            maximumSpecialists: hostPolicy.maximumSpecialists,
          },
        },
      );
      try {
        const result = await router.execute(request);
        const decision = router.inspect();
        if (decision !== undefined) {
          records.unshift({
            host: request.routing?.host ?? "openai-compatible",
            ...decision,
            occurredAt: new Date().toISOString(),
            role: request.routing?.role ?? "main",
            complemented: decision.specialistModelIds.length > 0,
            outcome: "succeeded",
          });
          records.splice(50);
        }
        return result;
      } catch (error) {
        const decision = router.inspect();
        if (decision !== undefined) {
          records.unshift({
            host: request.routing?.host ?? "openai-compatible",
            ...decision,
            occurredAt: new Date().toISOString(),
            role: request.routing?.role ?? "main",
            complemented: decision.specialistModelIds.length > 0,
            outcome: "failed",
          });
          records.splice(50);
        }
        throw error;
      }
    },
  };
};

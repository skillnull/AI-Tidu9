import type {
  AgentHostId,
  CapabilityCompletionConfiguration,
  CapabilitySpecialistConfiguration,
  ModelSelection,
} from "../config/index.js";
import { requestRequiresToolExecution } from "../openai/index.js";
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
  /** Host that owns and executes this model when routing is host-backed. */
  host?: AgentHostId;
  /** Capabilities the model is configured and verified to provide. */
  capabilities: readonly string[];
  /** Configured input price per million tokens; zero is free and null is unknown. */
  inputCostPerMillionTokens: number | null;
  /** Configured output price per million tokens; zero is free and null is unknown. */
  outputCostPerMillionTokens: number | null;
  /** Observed average input tokens for requests requiring each capability. */
  averageInputTokensByCapability?: Readonly<Record<string, number>>;
  /** Observed average output tokens for requests requiring each capability. */
  averageOutputTokensByCapability?: Readonly<Record<string, number>>;
  /** Expected or recently observed end-to-end latency. */
  averageLatencyMilliseconds: number;
  /** Number of recent requests contributing to latency and availability observations. */
  performanceSamples?: number;
  /** Availability ratio from zero to one. */
  availability: number;
  /** Data boundary on which the model executes. */
  privacy: ProviderPrivacy;
  /** Verified remaining request allowance, or null when no verified quota data is available. */
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
  /** Estimated configured cost per million tokens, or null when any selected price is unknown. */
  estimatedCostPerMillionTokens: number | null;
  /** Why this route was selected under the active multi-factor policy. */
  reason:
    | "main-capability-match"
    | "capability-gap"
    | "lower-token-cost"
    | "lower-latency"
    | "higher-availability"
    | "tighter-privacy"
    | "failure-fallback"
    | "explicit-secondary-test";
  /** Actual upstream token usage when the selected providers report it. */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  /** Per-model token usage used to update capability-specific routing observations. */
  modelTokenUsage: readonly {
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }[];
}

export interface DynamicModelRouter extends ModelProvider {
  /** Returns the latest non-secret routing decision. */
  inspect: () => RoutingDecision | undefined;
  /** Returns the latest per-model execution attempts. */
  inspectAttempts: () => readonly RoutingModelAttempt[];
}

export interface RoutingModelAttempt {
  /** Stable routed-model identifier. */
  modelId: string;
  /** Whether this attempt ran as the primary or a secondary model. */
  role: "main" | "secondary";
  /** Result of this individual model call. */
  outcome: "cancelled" | "failed" | "succeeded";
  /** Upstream model explicitly confirmed by the provider or host, or null without a receipt. */
  executedModel: string | null;
  /** Upstream HTTP status, or null when the provider threw before returning one. */
  statusCode: number | null;
  /** Wall-clock duration for this individual model call. */
  durationMilliseconds: number;
  /** Bounded diagnostic summary safe to expose in local history. */
  message: string;
}

export interface CapabilityCompletionModelResult {
  /** Stable routed-model identifier. */
  modelId: string;
  /** Host that owns this model. */
  host: AgentHostId;
  /** Configured upstream model identifier. */
  model: string;
  /** Upstream model explicitly confirmed for this call, or null when no receipt was obtained. */
  executedModel: string | null;
  /** Whether this entry is the primary or a secondary model. */
  role: "main" | "secondary";
  /** Required capabilities assigned to this model for the request. */
  capabilities: readonly string[];
  /** Individual call result, including models skipped after an earlier failure. */
  outcome: "cancelled" | "failed" | "not-run" | "succeeded";
  /** Why a configured model was not called for this request. */
  skipReason?:
    | "awaiting-tool-results"
    | "blocked-by-cancellation"
    | "blocked-by-failure"
    | "not-selected";
  /** Upstream HTTP status, or null when unavailable. */
  statusCode: number | null;
  /** Wall-clock duration, or null when the model was not called. */
  durationMilliseconds: number | null;
  /** Bounded diagnostic summary. */
  message: string;
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
  outcome: "cancelled" | "failed" | "succeeded";
  /** Primary-model execution result. */
  mainResult: CapabilityCompletionModelResult;
  /** Secondary-model execution results in configured order. */
  secondaryResults: readonly CapabilityCompletionModelResult[];
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

export interface CapabilityCompletionProviderOptions {
  /** Resolves the concrete provider owned by a host; no cross-host fallback is allowed. */
  resolveProviderForHost?: (host: AgentHostId) => Promise<ModelProvider | undefined>;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const PRIVACY_RANK: Readonly<Record<ProviderPrivacy, number>> = {
  local: 0,
  private: 1,
  external: 2,
};
const DEFAULT_REQUIRED_CAPABILITY = "text";
const LONG_CONTEXT_INPUT_CHARACTER_THRESHOLD = 100_000;
const WEB_RESEARCH_TOOL_TYPES = new Set(["search", "web_search", "web_search_preview"]);
const IMAGE_INPUT_TYPES = new Set(["image", "image_url", "input_image", "localImage"]);
const CODE_EXECUTION_TOOL_NAMES = new Set([
  "apply_patch",
  "code_interpreter",
  "exec",
  "exec_command",
  "execute",
  "shell",
  "shell_command",
  "terminal",
]);
const WORKSPACE_REFERENCE_PATTERN =
  /(?:\/(?:Users|home|workspace|tmp|var)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+|\b(?:local|workspace|repository|repo|file|directory|codebase)\b|(?:本地|仓库|文件|目录|代码|SKILL))/iu;
const WORKSPACE_ACTION_PATTERN =
  /(?:\b(?:read|inspect|open|edit|modify|update|fix|implement|review|check)\b|(?:查看|读取|打开|编辑|修改|更新|修复|实现|审查|检查))/iu;
const WEB_RESEARCH_REFERENCE_PATTERN =
  /(?:\b(?:web|internet|online|website)\b|(?:联网|网上|网页|网站))/iu;
const WEB_RESEARCH_ACTION_PATTERN =
  /(?:\b(?:search|research|browse|look\s+up)\b|(?:搜索|检索|查找|查询|调研))/iu;
const HOST_BRIDGE_CAPABILITY_UNSUPPORTED_CODES = new Set([
  "host_bridge_image_unsupported",
  "host_bridge_vision_unsupported",
  "host_bridge_tool_unsupported",
  "host_bridge_tools_unsupported",
  "host_bridge_web_unsupported",
  "host_bridge_web_research_unsupported",
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeCapabilities = (capabilities: readonly string[]): readonly string[] =>
  [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].sort();

const modelObservationKey = (host: AgentHostId, selection: ModelSelection): string =>
  `${host}\u0000${selection.source}\u0000${selection.model}`;

const normalizeToolIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim().toLowerCase().replaceAll("-", "_") : undefined;

const toolIdentifiers = (tool: unknown): readonly string[] => {
  if (!isRecord(tool)) return [];
  const nestedFunction = isRecord(tool.function) ? tool.function : undefined;
  return [tool.type, tool.name, nestedFunction?.name]
    .map(normalizeToolIdentifier)
    .filter((identifier): identifier is string => identifier !== undefined && identifier !== "");
};

const inputTextCharacterCount = (value: unknown): number => {
  if (typeof value === "string") return [...value].length;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + inputTextCharacterCount(item), 0);
  }
  if (!isRecord(value)) return 0;
  const type = normalizeToolIdentifier(value.type);
  if (type === "image" || type === "image_url" || type === "input_image") return 0;
  if (value.content !== undefined) return inputTextCharacterCount(value.content);
  return [value.text, value.input_text, value.output].reduce<number>(
    (total, item) => total + inputTextCharacterCount(item),
    0,
  );
};

const collectUserRequestText = (value: unknown, output: string[]): void => {
  if (typeof value === "string") {
    if (value.trim() !== "") output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUserRequestText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.role === "string" && value.role !== "user") return;
  for (const key of ["content", "text", "input_text"]) {
    if (key in value) collectUserRequestText(value[key], output);
  }
};

const inferCapabilitiesFromUserRequest = (request: ProviderExecutionRequest): readonly string[] => {
  const parts: string[] = [];
  const input = request.protocol === "responses" ? request.body.input : request.body.messages;
  collectUserRequestText(input, parts);
  const text = parts.join("\n");
  const capabilities: string[] = [];
  if (WORKSPACE_REFERENCE_PATTERN.test(text) && WORKSPACE_ACTION_PATTERN.test(text)) {
    capabilities.push("code");
  }
  if (WEB_RESEARCH_REFERENCE_PATTERN.test(text) && WEB_RESEARCH_ACTION_PATTERN.test(text)) {
    capabilities.push("web-research");
  }
  return capabilities;
};

export const inferModelRequestCapabilities = (
  request: ProviderExecutionRequest,
): readonly string[] => {
  const inferred = new Set<string>([
    DEFAULT_REQUIRED_CAPABILITY,
    ...(request.routing?.requiredCapabilities ?? []),
    ...inferCapabilitiesFromUserRequest(request),
  ]);
  const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
  const toolExecutionRequired = requestRequiresToolExecution(request.body);
  if (toolExecutionRequired) {
    inferred.add("tool-use");
  }
  const selectedToolIdentifiers = isRecord(request.body.tool_choice)
    ? toolIdentifiers(request.body.tool_choice)
    : [];
  const identifiers =
    selectedToolIdentifiers.length > 0
      ? selectedToolIdentifiers
      : toolExecutionRequired && tools.length === 1
        ? tools.flatMap(toolIdentifiers)
        : [];
  if (identifiers.some((identifier) => WEB_RESEARCH_TOOL_TYPES.has(identifier))) {
    inferred.add("web-research");
  }
  if (identifiers.some((identifier) => CODE_EXECUTION_TOOL_NAMES.has(identifier))) {
    inferred.add("code");
  }
  const responseText = isRecord(request.body.text) ? request.body.text : undefined;
  if (request.body.response_format !== undefined || responseText?.format !== undefined) {
    inferred.add("structured-output");
  }
  const reasoningEffort = isRecord(request.body.reasoning)
    ? request.body.reasoning.effort
    : request.body.reasoning_effort;
  if (typeof reasoningEffort === "string" && reasoningEffort !== "none") {
    inferred.add("reasoning");
  }
  const serialized = JSON.stringify(request.body);
  if (/"type"\s*:\s*"(?:image|image_url|input_image|localImage)"/u.test(serialized)) {
    inferred.add("vision");
  }
  const requestInput =
    request.protocol === "responses" ? request.body.input : request.body.messages;
  if (inputTextCharacterCount(requestInput) >= LONG_CONTEXT_INPUT_CHARACTER_THRESHOLD) {
    inferred.add("long-context");
  }
  return normalizeCapabilities([...inferred]);
};

const inferCapabilities = inferModelRequestCapabilities;

const removeImageInputs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const projected = removeImageInputs(item);
      return projected === undefined ? [] : [projected];
    });
  }
  if (!isRecord(value)) return value;
  if (typeof value.type === "string" && IMAGE_INPUT_TYPES.has(value.type)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const projected = removeImageInputs(item);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
};

const projectRequestForCapabilities = (
  request: ProviderExecutionRequest,
  capabilities: readonly string[],
): ProviderExecutionRequest => {
  if (capabilities.includes("vision")) return request;
  const conversationKey = request.protocol === "responses" ? "input" : "messages";
  return {
    ...request,
    body: {
      ...request.body,
      [conversationKey]: removeImageInputs(request.body[conversationKey]),
    },
  };
};

const validateProfile = (profile: ModelRouteProfile): ModelRouteProfile => {
  if (!ID_PATTERN.test(profile.id)) {
    throw new Error("Routable models require a safe stable identifier.");
  }
  const capabilities = normalizeCapabilities(profile.capabilities);
  const costs = [profile.inputCostPerMillionTokens, profile.outputCostPerMillionTokens];
  if (costs.some((cost) => cost !== null && (!Number.isFinite(cost) || cost < 0))) {
    throw new Error(`Routable model ${profile.id} has an invalid configured cost.`);
  }
  const tokenObservations = [
    ...Object.values(profile.averageInputTokensByCapability ?? {}),
    ...Object.values(profile.averageOutputTokensByCapability ?? {}),
  ];
  if (tokenObservations.some((tokens) => !Number.isFinite(tokens) || tokens < 0)) {
    throw new Error(`Routable model ${profile.id} has invalid token observations.`);
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

const configuredTokenCost = (profile: ModelRouteProfile): number | null => {
  const prices = [profile.inputCostPerMillionTokens, profile.outputCostPerMillionTokens];
  if (
    prices.some(
      (price) => price === null || !Number.isFinite(price) || price >= Number.MAX_SAFE_INTEGER,
    )
  ) {
    return null;
  }
  return (prices[0] as number) + (prices[1] as number);
};

const observedTokenUsage = (
  profile: ModelRouteProfile,
  requiredCapabilities: readonly string[],
): { inputTokens: number; outputTokens: number } | null => {
  const observations = requiredCapabilities.map((capability) => ({
    inputTokens: profile.averageInputTokensByCapability?.[capability],
    outputTokens: profile.averageOutputTokensByCapability?.[capability],
  }));
  if (
    observations.length === 0 ||
    observations.some(
      (observation) =>
        observation.inputTokens === undefined || observation.outputTokens === undefined,
    )
  ) {
    return null;
  }
  return {
    inputTokens:
      observations.reduce((total, observation) => total + (observation.inputTokens as number), 0) /
      observations.length,
    outputTokens:
      observations.reduce((total, observation) => total + (observation.outputTokens as number), 0) /
      observations.length,
  };
};

const hasTokenObservations = (profile: ModelRouteProfile): boolean =>
  Object.keys(profile.averageInputTokensByCapability ?? {}).length > 0 ||
  Object.keys(profile.averageOutputTokensByCapability ?? {}).length > 0;

const observedTokenCost = (
  profile: ModelRouteProfile,
  requiredCapabilities: readonly string[],
): number | null => {
  const usage = observedTokenUsage(profile, requiredCapabilities);
  if (
    usage === null ||
    profile.inputCostPerMillionTokens === null ||
    profile.outputCostPerMillionTokens === null
  ) {
    return null;
  }
  return (
    usage.inputTokens * profile.inputCostPerMillionTokens +
    usage.outputTokens * profile.outputCostPerMillionTokens
  );
};

const hasLowerTokenCost = (
  candidate: ModelRouteProfile,
  current: ModelRouteProfile,
  requiredCapabilities: readonly string[],
): boolean => {
  const candidateConfiguredCost = configuredTokenCost(candidate);
  const currentConfiguredCost = configuredTokenCost(current);
  if (candidateConfiguredCost === null || currentConfiguredCost === null) return false;
  const candidateObservedCost = observedTokenCost(candidate, requiredCapabilities);
  const currentObservedCost = observedTokenCost(current, requiredCapabilities);
  if (candidateObservedCost !== null && currentObservedCost !== null) {
    return candidateObservedCost < currentObservedCost;
  }
  if (hasTokenObservations(candidate) || hasTokenObservations(current)) return false;
  return candidateConfiguredCost < currentConfiguredCost;
};

const routeAdvantage = (
  candidate: ModelRouteProfile,
  current: ModelRouteProfile,
  requiredCapabilities: readonly string[],
): RoutingDecision["reason"] | undefined => {
  if (PRIVACY_RANK[candidate.privacy] < PRIVACY_RANK[current.privacy]) {
    return "tighter-privacy";
  }
  if ((candidate.performanceSamples ?? 0) > 0 && (current.performanceSamples ?? 0) > 0) {
    if (candidate.availability > current.availability) return "higher-availability";
    if (
      candidate.availability === current.availability &&
      candidate.averageLatencyMilliseconds < current.averageLatencyMilliseconds
    ) {
      return "lower-latency";
    }
  }
  return hasLowerTokenCost(candidate, current, requiredCapabilities)
    ? "lower-token-cost"
    : undefined;
};

const scoreProfile = (
  profile: ModelRouteProfile,
  requiredCapabilities: readonly string[],
  weights: RoutingMetricWeights,
): number => {
  const coverage =
    requiredCapabilities.filter((capability) => profile.capabilities.includes(capability)).length /
    Math.max(1, requiredCapabilities.length);
  const observedCost = observedTokenCost(profile, requiredCapabilities);
  const configuredCost = configuredTokenCost(profile);
  const costScore =
    configuredCost === null
      ? 0
      : 1 / (1 + (observedCost === null ? configuredCost : observedCost / 1_000));
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

type RoutingTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const extractTokenUsageRecord = (body: Record<string, unknown>): RoutingTokenUsage | null => {
  if (!isRecord(body.usage)) return null;
  const usage = body.usage;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0
  ) {
    return null;
  }
  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens: (inputTokens as number) + (outputTokens as number),
  };
};

const extractTokenUsage = (result: ProviderExecutionResult): RoutingTokenUsage | null =>
  result.kind === "json" && isRecord(result.body) ? extractTokenUsageRecord(result.body) : null;

const combineTokenUsage = (
  usages: readonly ({
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null)[],
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null => {
  const reported = usages.filter((usage) => usage !== null);
  if (reported.length === 0) return null;
  return reported.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
};

const extractModelText = (result: ProviderExecutionResult): string => {
  if (result.kind !== "json" || !isRecord(result.body)) {
    throw new Error("Capability-completion secondary models must return bounded JSON responses.");
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
  if (Array.isArray(result.body.output)) {
    const outputText = result.body.output
      .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
      .flatMap((content) =>
        isRecord(content) && typeof content.text === "string" ? [content.text] : [],
      )
      .join("");
    if (outputText !== "") return outputText.slice(0, 8192);
  }
  throw new Error("Capability-completion secondary model returned no text result.");
};

const MAX_SHARED_PROCESS_CHARACTERS = 16_384;

const appendSharedProcess = (current: string, delta: string): string => {
  if (current.length >= MAX_SHARED_PROCESS_CHARACTERS || delta === "") return current;
  return `${current}${delta.slice(0, MAX_SHARED_PROCESS_CHARACTERS - current.length)}`;
};

const providerErrorMessage = (result: ProviderExecutionResult, fallback: string): string => {
  if (result.kind !== "json" || !isRecord(result.body) || !isRecord(result.body.error)) {
    return fallback;
  }
  return typeof result.body.error.message === "string"
    ? result.body.error.message.slice(0, 500)
    : fallback;
};

const isHostBridgeCapabilityUnsupported = (result: ProviderExecutionResult): boolean => {
  if (result.kind !== "json" || result.statusCode !== 400 || !isRecord(result.body)) return false;
  const error = isRecord(result.body.error) ? result.body.error : undefined;
  return (
    typeof error?.code === "string" && HOST_BRIDGE_CAPABILITY_UNSUPPORTED_CODES.has(error.code)
  );
};

const requestCancellationError = (
  request: ProviderExecutionRequest,
  error?: unknown,
): Error | undefined => {
  if (request.signal?.aborted === true) {
    return request.signal.reason instanceof Error
      ? request.signal.reason
      : new DOMException("The model request was cancelled.", "AbortError");
  }
  return error instanceof Error && error.name === "AbortError" ? error : undefined;
};

interface ProviderStreamObservation {
  /** Whether the consumer or its request signal stopped execution. */
  cancelled?: boolean;
  /** Whether the stream produced assistant output and reached a successful terminal event. */
  succeeded: boolean;
  /** Bounded terminal diagnostic used by local routing history. */
  message: string;
  /** Provider-reported usage parsed from the successful or failed stream terminal. */
  tokenUsage: RoutingTokenUsage | null;
}

interface ProviderStreamObservationState {
  sawOutput: boolean;
  sawSuccessfulTerminal: boolean;
  failureMessage?: string;
  tokenUsage?: RoutingTokenUsage;
}

const boundedStreamMessage = (message: string): string => message.slice(0, 500);

const responseOutputHasContent = (response: Record<string, unknown>): boolean => {
  if (typeof response.output_text === "string" && response.output_text !== "") return true;
  if (!Array.isArray(response.output)) return false;
  return response.output.some((item) => {
    if (!isRecord(item)) return false;
    if (
      item.type === "function_call" ||
      item.type === "custom_tool_call" ||
      item.type === "tool_search_call"
    )
      return true;
    if (!Array.isArray(item.content)) return false;
    return item.content.some(
      (content) =>
        isRecord(content) &&
        ((typeof content.text === "string" && content.text !== "") ||
          content.type === "tool_call" ||
          content.type === "function_call"),
    );
  });
};

const observeProviderStreamEvent = (
  event: string,
  state: ProviderStreamObservationState,
  protocol: ProviderExecutionRequest["protocol"],
): void => {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (data === "") return;
  if (data === "[DONE]") {
    if (protocol === "chat-completions") state.sawSuccessfulTerminal = true;
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(data) as unknown;
  } catch {
    state.failureMessage ??= "Provider stream contained invalid SSE JSON.";
    return;
  }
  if (!isRecord(body)) return;
  const usageBody = isRecord(body.response) ? body.response : body;
  state.tokenUsage = extractTokenUsageRecord(usageBody) ?? state.tokenUsage;

  if (isRecord(body.error)) {
    state.failureMessage ??= boundedStreamMessage(
      typeof body.error.message === "string" ? body.error.message : "Provider stream failed.",
    );
    return;
  }
  if (body.type === "error") {
    state.failureMessage ??= boundedStreamMessage(
      typeof body.message === "string" ? body.message : "Provider stream failed.",
    );
    return;
  }
  if (body.type === "response.failed" || body.type === "response.incomplete") {
    const response = isRecord(body.response) ? body.response : undefined;
    const responseError =
      response !== undefined && isRecord(response.error) ? response.error : undefined;
    state.failureMessage ??= boundedStreamMessage(
      typeof responseError?.message === "string"
        ? responseError.message
        : body.type === "response.incomplete"
          ? "Provider response was incomplete."
          : "Provider response failed.",
    );
    return;
  }
  if (body.type === "response.completed" && isRecord(body.response)) {
    if (body.response.status === "failed" || body.response.status === "incomplete") {
      state.failureMessage ??= "Provider response did not complete successfully.";
      return;
    }
    if (body.response.status === "completed") state.sawSuccessfulTerminal = true;
    if (responseOutputHasContent(body.response)) state.sawOutput = true;
  }
  if (
    (body.type === "response.output_text.delta" &&
      typeof body.delta === "string" &&
      body.delta !== "") ||
    (body.type === "response.output_text.done" && typeof body.text === "string" && body.text !== "")
  ) {
    state.sawOutput = true;
  }

  if (!Array.isArray(body.choices)) return;
  for (const choice of body.choices) {
    if (!isRecord(choice)) continue;
    if (
      protocol === "chat-completions" &&
      typeof choice.finish_reason === "string" &&
      choice.finish_reason !== ""
    ) {
      state.sawSuccessfulTerminal = true;
    }
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (
      (typeof delta?.content === "string" && delta.content !== "") ||
      (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) ||
      isRecord(delta?.function_call)
    ) {
      state.sawOutput = true;
    }
  }
};

const observeProviderStream = (
  result: Extract<ProviderExecutionResult, { kind: "stream" }>,
  onFinished: (observation: ProviderStreamObservation) => void,
  protocol: ProviderExecutionRequest["protocol"],
  signal?: AbortSignal,
): Extract<ProviderExecutionResult, { kind: "stream" }> => {
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  const state: ProviderStreamObservationState = {
    sawOutput: false,
    sawSuccessfulTerminal: false,
  };
  let buffer = "";
  let finished = false;
  let cancelled = false;
  let aborted = false;
  let readerReleased = false;
  let consumerCancelled = false;
  let cancellationPromise: Promise<void> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let abortListener: (() => void) | undefined;

  const releaseReader = (): void => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };
  const detachAbortListener = (): void => {
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  const finish = (observation: ProviderStreamObservation): void => {
    if (finished) return;
    finished = true;
    detachAbortListener();
    onFinished(observation);
  };
  const consumeBufferedEvents = (flush: boolean): void => {
    while (true) {
      const delimiter = /\r?\n\r?\n/u.exec(buffer);
      if (delimiter?.index === undefined) break;
      observeProviderStreamEvent(buffer.slice(0, delimiter.index), state, protocol);
      buffer = buffer.slice(delimiter.index + delimiter[0].length);
    }
    if (flush && buffer.trim() !== "") {
      observeProviderStreamEvent(buffer, state, protocol);
      buffer = "";
    }
  };
  const completedObservation = (): ProviderStreamObservation => {
    const tokenUsage = state.tokenUsage ?? null;
    if (cancelled) {
      return {
        cancelled: true,
        succeeded: false,
        message: aborted
          ? "Provider stream was cancelled because the request was aborted."
          : "Provider stream was cancelled before completion.",
        tokenUsage,
      };
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return {
        succeeded: false,
        message: `Primary model returned HTTP ${result.statusCode}.`,
        tokenUsage,
      };
    }
    if (state.failureMessage !== undefined) {
      return { succeeded: false, message: state.failureMessage, tokenUsage };
    }
    if (!state.sawOutput) {
      return {
        succeeded: false,
        message: "Provider stream ended without assistant output.",
        tokenUsage,
      };
    }
    if (!state.sawSuccessfulTerminal) {
      return {
        succeeded: false,
        message: "Provider stream ended without a successful terminal event.",
        tokenUsage,
      };
    }
    return { succeeded: true, message: "", tokenUsage };
  };
  const cancelStream = (
    reason: unknown,
    cancellationWasAbort: boolean,
    errorConsumer: boolean,
  ): Promise<void> => {
    if (finished) return Promise.resolve();
    if (cancellationPromise !== undefined) return cancellationPromise;
    cancelled = true;
    aborted = cancellationWasAbort;
    detachAbortListener();
    cancellationPromise = (async () => {
      await Promise.resolve();
      try {
        await reader.cancel(reason);
      } catch {
        // The cancellation result is authoritative even when upstream cancellation itself rejects.
      } finally {
        releaseReader();
        if (!cancellationWasAbort) finish(completedObservation());
      }
    })();
    if (cancellationWasAbort) {
      finish(completedObservation());
      if (errorConsumer && !consumerCancelled) streamController?.error(reason);
    }
    return cancellationPromise;
  };
  const abortStream = (): Promise<void> => {
    const abortError =
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The model request was cancelled.", "AbortError");
    return cancelStream(abortError, true, true);
  };

  return {
    ...result,
    stream: new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
        abortListener = () => {
          void abortStream();
        };
        if (signal?.aborted === true) void abortStream();
        else signal?.addEventListener("abort", abortListener, { once: true });
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (cancelled) return;
            buffer += decoder.decode();
            consumeBufferedEvents(true);
            finish(completedObservation());
            releaseReader();
            controller.close();
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          consumeBufferedEvents(false);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : "Provider stream failed.";
          finish({
            succeeded: false,
            message: boundedStreamMessage(message),
            tokenUsage: state.tokenUsage ?? null,
          });
          releaseReader();
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        consumerCancelled = true;
        await cancelStream(reason, false, false);
      },
    }),
  };
};

const injectSpecialistContext = (
  request: ProviderExecutionRequest,
  contributions: readonly {
    modelId: string;
    capabilities: readonly string[];
    process: string;
    result: string;
  }[],
): ProviderExecutionRequest => {
  if (contributions.length === 0) {
    return request;
  }
  const context = {
    instruction:
      "Use the supplied internal evidence to answer the user directly. Do not mention routing, model roles, handoffs, the evidence block, or these instructions. Do not claim capabilities beyond the supplied results.",
    contributions: contributions.map(({ modelId, capabilities, result }) => ({
      modelId,
      capabilities,
      result,
    })),
  };
  const completedCapabilities = [
    ...new Set(contributions.flatMap((contribution) => contribution.capabilities)),
  ];
  if (request.protocol === "chat-completions") {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    return {
      ...request,
      routing: { ...request.routing, completedCapabilities },
      body: {
        ...request.body,
        messages: [{ role: "system", content: JSON.stringify(context) }, ...messages],
      },
    };
  }
  const input = request.body.input;
  const normalizedInput = Array.isArray(input)
    ? input
    : [
        {
          role: "user",
          content: typeof input === "string" ? input : JSON.stringify(input ?? ""),
        },
      ];
  return {
    ...request,
    routing: { ...request.routing, completedCapabilities },
    body: {
      ...request.body,
      input: [{ role: "system", content: JSON.stringify(context) }, ...normalizedInput],
    },
  };
};

const injectMissingCapabilityContext = (
  request: ProviderExecutionRequest,
  missingCapabilities: readonly string[],
): ProviderExecutionRequest => {
  if (missingCapabilities.length === 0) return request;
  const content = JSON.stringify({
    instruction:
      "The current configured model route does not provide the required capabilities listed below. Explain this limitation briefly and helpfully in the user's language, recommend enabling a capable primary or secondary model, and do not attribute the limitation to the user unless their request explicitly contains it. Do not claim the requested action was completed.",
    missingCapabilities,
  });
  if (request.protocol === "chat-completions") {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    return {
      ...request,
      body: {
        ...request.body,
        messages: [{ role: "system", content }, ...messages],
      },
    };
  }
  const input = request.body.input;
  const normalizedInput = Array.isArray(input)
    ? input
    : [
        {
          role: "user",
          content: typeof input === "string" ? input : JSON.stringify(input ?? ""),
        },
      ];
  return {
    ...request,
    body: {
      ...request.body,
      input: [{ role: "system", content }, ...normalizedInput],
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
  let latestAttempts: RoutingModelAttempt[] = [];

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
  ): {
    main: RoutableModel;
    specialists: readonly RoutableModel[];
    decision: RoutingDecision;
  } => {
    const requiredCapabilities = inferCapabilities(request);
    const privacy = request.routing?.privacy ?? "external";
    const eligible = eligibleModels(privacy).filter(
      (model) => !excludedMainIds.has(model.profile.id),
    );
    if (eligible.length === 0) {
      throw new Error("No enabled model satisfies the verified request routing constraints.");
    }
    const configuredMain = modelsById.get(policy.mainModelId) as RoutableModel;
    const preferredMain = eligible.find((model) => model.profile.id === configuredMain.profile.id);
    let main: RoutableModel | undefined;
    const specialists: RoutableModel[] = [];
    let reason: RoutingDecision["reason"] = "main-capability-match";

    if (!policy.enabled) {
      main = preferredMain;
    } else if (preferredMain !== undefined && covers(preferredMain.profile, requiredCapabilities)) {
      const fullyCapableAlternatives = rankModels(
        eligible.filter(
          (model) =>
            model.profile.id !== preferredMain.profile.id &&
            policy.capabilityCompletion.poolModelIds.includes(model.profile.id) &&
            covers(model.profile, requiredCapabilities) &&
            routeAdvantage(model.profile, preferredMain.profile, requiredCapabilities) !==
              undefined,
        ),
        requiredCapabilities,
      );
      const betterFullyCapable = fullyCapableAlternatives[0];
      if (request.routing?.requireSpecialist === true && policy.capabilityCompletion.enabled) {
        const diagnosticSpecialist = rankModels(
          eligible.filter(
            (model) =>
              model.profile.id !== preferredMain.profile.id &&
              policy.capabilityCompletion.poolModelIds.includes(model.profile.id) &&
              model.profile.capabilities.some((capability) =>
                requiredCapabilities.includes(capability),
              ),
          ),
          requiredCapabilities,
        )[0];
        if (diagnosticSpecialist !== undefined) {
          main = preferredMain;
          specialists.push(diagnosticSpecialist);
          reason = "explicit-secondary-test";
        }
      }
      if (main === undefined) {
        main = betterFullyCapable ?? preferredMain;
        if (betterFullyCapable !== undefined) {
          reason =
            routeAdvantage(
              betterFullyCapable.profile,
              preferredMain.profile,
              requiredCapabilities,
            ) ?? "main-capability-match";
        }
      }
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
        const preferredMainCapabilities = requiredCapabilities.filter((capability) =>
          preferredMain.profile.capabilities.includes(capability),
        );
        const finalSpecialist = requiredCapabilities.includes("text")
          ? rankModels(
              specialists.filter((specialist) => specialist.profile.capabilities.includes("text")),
              requiredCapabilities,
            )[0]
          : undefined;
        if (finalSpecialist !== undefined && !preferredMain.profile.capabilities.includes("text")) {
          main = finalSpecialist;
          specialists.splice(specialists.indexOf(finalSpecialist), 1);
          const finalCapabilities = new Set(finalSpecialist.profile.capabilities);
          if (preferredMainCapabilities.some((capability) => !finalCapabilities.has(capability))) {
            specialists.unshift(preferredMain);
          }
        } else if (preferredMainCapabilities.length === 0 && finalSpecialist !== undefined) {
          main = finalSpecialist;
          specialists.splice(specialists.indexOf(finalSpecialist), 1);
        }
        main ??= preferredMain;
        reason = "capability-gap";
      } else {
        specialists.length = 0;
      }
    }
    main ??= rankModels(
      eligible.filter((model) => covers(model.profile, requiredCapabilities)),
      requiredCapabilities,
    )[0];
    if (main === undefined) {
      main = preferredMain ?? rankModels(eligible, requiredCapabilities)[0];
      reason = "capability-gap";
    }
    if (main === undefined) {
      throw new Error("No enabled model satisfies the verified request routing constraints.");
    }
    if (excludedMainIds.size > 0) reason = "failure-fallback";
    else if (main.profile.id !== policy.mainModelId && reason === "main-capability-match") {
      reason = "capability-gap";
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
    const routeCosts = [main, ...specialists].map((model) => configuredTokenCost(model.profile));
    const knownRouteCosts = routeCosts.filter((cost): cost is number => cost !== null);
    const estimatedCostPerMillionTokens =
      knownRouteCosts.length === routeCosts.length
        ? knownRouteCosts.reduce((total, cost) => total + cost, 0)
        : null;
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
        reason,
        tokenUsage: null,
        modelTokenUsage: [],
      },
    };
  };

  const execute = async (request: ProviderExecutionRequest): Promise<ProviderExecutionResult> => {
    const requestAttempts: RoutingModelAttempt[] = [];
    const usageByModel = new Map<string, RoutingTokenUsage>();
    const recordUsage = (modelId: string, usage: RoutingTokenUsage | null): void => {
      if (usage !== null) usageByModel.set(modelId, usage);
      if (latestDecision === undefined) return;
      latestDecision = {
        ...latestDecision,
        tokenUsage: combineTokenUsage([...usageByModel.values()]),
        modelTokenUsage: [...usageByModel].map(([usedModelId, modelUsage]) => ({
          modelId: usedModelId,
          ...modelUsage,
        })),
      };
    };
    latestAttempts = requestAttempts;
    const attemptedMainIds = new Set<string>();
    let lastFailure: Error | undefined;
    let lastCapabilityUnsupportedResult: ProviderExecutionResult | undefined;
    while (attemptedMainIds.size < models.length) {
      let route: ReturnType<typeof selectRoute>;
      try {
        route = selectRoute(request, attemptedMainIds);
      } catch (error) {
        const cancellation = requestCancellationError(request, error);
        if (cancellation !== undefined) throw cancellation;
        if (lastCapabilityUnsupportedResult !== undefined) {
          return lastCapabilityUnsupportedResult;
        }
        throw lastFailure ?? error;
      }
      latestDecision = route.decision;
      if (route.decision.missingCapabilities.length > 0) {
        throw new Error(
          `No configured model combination covers required capabilities: ${route.decision.missingCapabilities.join(", ")}.`,
        );
      }
      const cancellationBeforeRoute = requestCancellationError(request);
      if (cancellationBeforeRoute !== undefined) throw cancellationBeforeRoute;
      let contributions: Array<{
        modelId: string;
        capabilities: readonly string[];
        process: string;
        result: string;
        tokenUsage: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        } | null;
      }>;
      try {
        contributions = [];
        for (const specialist of route.specialists) {
          const startedAt = performance.now();
          let statusCode: number | null = null;
          let executedModel: string | null = null;
          let process = "";
          try {
            const assignedCapabilities = route.decision.requiredCapabilities.filter((capability) =>
              specialist.profile.capabilities.includes(capability),
            );
            const cancellationBeforeSpecialist = requestCancellationError(request);
            if (cancellationBeforeSpecialist !== undefined) {
              throw cancellationBeforeSpecialist;
            }
            const projectedRequest = projectRequestForCapabilities(request, assignedCapabilities);
            const specialistRequest = injectSpecialistContext(
              {
                ...projectedRequest,
                body: { ...projectedRequest.body, stream: false },
                onProcessDelta: (delta) => {
                  process = appendSharedProcess(process, delta);
                  request.onProcessDelta?.(delta);
                },
              },
              contributions,
            );
            const specialistResult = await specialist.provider.execute({
              ...specialistRequest,
              onExecutionReceipt: (receipt) => {
                recordUsage(specialist.profile.id, receipt.usage);
                request.onExecutionReceipt?.(receipt);
              },
              onModelConfirmed: (model) => {
                executedModel = model;
              },
              routing: {
                ...specialistRequest.routing,
                host: specialist.profile.host ?? specialistRequest.routing?.host,
                role: "specialist",
                requiredCapabilities: assignedCapabilities,
                availableCapabilities: assignedCapabilities,
              },
            });
            statusCode = specialistResult.statusCode;
            if (specialistResult.statusCode === 429) {
              throw new Error(`Secondary model quota exhausted (HTTP 429).`);
            }
            if (specialistResult.statusCode < 200 || specialistResult.statusCode >= 300) {
              throw new Error(
                providerErrorMessage(
                  specialistResult,
                  `Secondary model failed with HTTP ${specialistResult.statusCode}.`,
                ),
              );
            }
            const callerToolRequest =
              specialistResult.kind === "json" &&
              isRecord(specialistResult.body) &&
              Array.isArray(specialistResult.body.output) &&
              specialistResult.body.output.some(
                (item) =>
                  isRecord(item) &&
                  (item.type === "function_call" ||
                    item.type === "custom_tool_call" ||
                    item.type === "tool_search_call"),
              );
            const result = callerToolRequest ? "" : extractModelText(specialistResult);
            const tokenUsage = extractTokenUsage(specialistResult);
            recordUsage(specialist.profile.id, tokenUsage);
            requestAttempts.push({
              modelId: specialist.profile.id,
              role: "secondary",
              outcome: "succeeded",
              executedModel: specialistResult.upstreamModel ?? executedModel,
              statusCode,
              durationMilliseconds: Math.round(performance.now() - startedAt),
              message: "",
            });
            const confirmedSpecialistModel = specialistResult.upstreamModel ?? executedModel;
            if (confirmedSpecialistModel !== null) {
              request.onExecutionReceipt?.({
                host: specialist.profile.host ?? request.routing?.host ?? "openai-compatible",
                model: confirmedSpecialistModel,
                role: "specialist",
                capabilities: assignedCapabilities,
                usage: tokenUsage,
              });
            }
            contributions.push({
              modelId: specialist.profile.id,
              capabilities: specialist.profile.capabilities.filter((capability) =>
                route.decision.requiredCapabilities.includes(capability),
              ),
              process,
              result,
              tokenUsage,
            });
            if (callerToolRequest) return specialistResult;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Secondary model failed.";
            requestAttempts.push({
              modelId: specialist.profile.id,
              role: "secondary",
              outcome:
                requestCancellationError(request, error) === undefined ? "failed" : "cancelled",
              executedModel,
              statusCode,
              durationMilliseconds: Math.round(performance.now() - startedAt),
              message: message.slice(0, 500),
            });
            throw error;
          }
        }
      } catch (error) {
        const cancellation = requestCancellationError(request, error);
        if (cancellation !== undefined) throw cancellation;
        lastFailure =
          error instanceof Error ? error : new Error("Capability secondary model failed.");
        throw lastFailure;
      }
      const cancellationAfterSpecialists = requestCancellationError(request);
      if (cancellationAfterSpecialists !== undefined) throw cancellationAfterSpecialists;
      let result: ProviderExecutionResult;
      const mainStartedAt = performance.now();
      let mainExecutedModel: string | null = null;
      try {
        const mainCapabilities = route.decision.requiredCapabilities.filter((capability) =>
          route.main.profile.capabilities.includes(capability),
        );
        const complementedRequest = injectSpecialistContext(
          projectRequestForCapabilities(request, mainCapabilities),
          contributions,
        );
        const routedRequest = injectMissingCapabilityContext(
          complementedRequest,
          route.decision.missingCapabilities,
        );
        result = await route.main.provider.execute({
          ...routedRequest,
          onExecutionReceipt: (receipt) => {
            recordUsage(route.main.profile.id, receipt.usage);
            request.onExecutionReceipt?.(receipt);
          },
          onModelConfirmed: (model) => {
            mainExecutedModel = model;
          },
          routing: {
            ...routedRequest.routing,
            host: route.main.profile.host ?? routedRequest.routing?.host,
            requiredCapabilities: route.decision.requiredCapabilities,
            availableCapabilities: mainCapabilities,
            role: request.routing?.role ?? "main",
          },
        });
      } catch (error) {
        const cancellation = requestCancellationError(request, error);
        lastFailure =
          cancellation ?? (error instanceof Error ? error : new Error("Model provider failed."));
        requestAttempts.push({
          modelId: route.main.profile.id,
          role: "main",
          outcome: cancellation === undefined ? "failed" : "cancelled",
          executedModel: mainExecutedModel,
          statusCode: null,
          durationMilliseconds: Math.round(performance.now() - mainStartedAt),
          message: lastFailure.message.slice(0, 500),
        });
        if (cancellation !== undefined) throw cancellation;
        attemptedMainIds.add(route.main.profile.id);
        if (attemptedMainIds.size >= models.length) {
          if (lastCapabilityUnsupportedResult !== undefined) {
            return lastCapabilityUnsupportedResult;
          }
          throw lastFailure;
        }
        continue;
      }
      const cancellationAfterMain = requestCancellationError(request);
      if (cancellationAfterMain !== undefined) {
        requestAttempts.push({
          modelId: route.main.profile.id,
          role: "main",
          outcome: "cancelled",
          executedModel: result.upstreamModel ?? mainExecutedModel,
          statusCode: result.statusCode,
          durationMilliseconds: Math.round(performance.now() - mainStartedAt),
          message: cancellationAfterMain.message.slice(0, 500),
        });
        throw cancellationAfterMain;
      }
      if (isHostBridgeCapabilityUnsupported(result)) {
        lastCapabilityUnsupportedResult = result;
        lastFailure = new Error(
          providerErrorMessage(
            result,
            `Model ${route.main.profile.id} does not support a required capability.`,
          ),
        );
        requestAttempts.push({
          modelId: route.main.profile.id,
          role: "main",
          outcome: "failed",
          executedModel: result.upstreamModel ?? mainExecutedModel,
          statusCode: result.statusCode,
          durationMilliseconds: Math.round(performance.now() - mainStartedAt),
          message: lastFailure.message.slice(0, 500),
        });
        attemptedMainIds.add(route.main.profile.id);
        if (attemptedMainIds.size >= models.length) return result;
        continue;
      }
      if (result.statusCode !== 429 && result.statusCode < 500) {
        const resultTokenUsage = extractTokenUsage(result);
        recordUsage(route.main.profile.id, resultTokenUsage);
        if (result.kind === "stream") {
          const confirmedMainModel = result.upstreamModel ?? mainExecutedModel;
          if (confirmedMainModel !== null) {
            request.onExecutionReceipt?.({
              host: route.main.profile.host ?? request.routing?.host ?? "openai-compatible",
              model: confirmedMainModel,
              role: request.routing?.role ?? "main",
              capabilities: route.main.profile.capabilities.filter((capability) =>
                route.decision.requiredCapabilities.includes(capability),
              ),
              usage: null,
            });
          }
          return observeProviderStream(
            result,
            (observation) => {
              recordUsage(route.main.profile.id, observation.tokenUsage);
              requestAttempts.push({
                modelId: route.main.profile.id,
                role: "main",
                outcome: observation.cancelled
                  ? "cancelled"
                  : observation.succeeded
                    ? "succeeded"
                    : "failed",
                executedModel: result.upstreamModel ?? mainExecutedModel,
                statusCode: result.statusCode,
                durationMilliseconds: Math.round(performance.now() - mainStartedAt),
                message: observation.message,
              });
            },
            request.protocol,
            request.signal,
          );
        }
        requestAttempts.push({
          modelId: route.main.profile.id,
          role: "main",
          outcome: result.statusCode >= 200 && result.statusCode < 300 ? "succeeded" : "failed",
          executedModel: result.upstreamModel ?? null,
          statusCode: result.statusCode,
          durationMilliseconds: Math.round(performance.now() - mainStartedAt),
          message:
            result.statusCode >= 200 && result.statusCode < 300
              ? ""
              : `Primary model returned HTTP ${result.statusCode}.`,
        });
        const confirmedMainModel = result.upstreamModel ?? mainExecutedModel;
        if (confirmedMainModel !== null) {
          request.onExecutionReceipt?.({
            host: route.main.profile.host ?? request.routing?.host ?? "openai-compatible",
            model: confirmedMainModel,
            role: request.routing?.role ?? "main",
            capabilities: route.main.profile.capabilities.filter((capability) =>
              route.decision.requiredCapabilities.includes(capability),
            ),
            usage: resultTokenUsage,
          });
        }
        return result;
      }
      lastFailure = new Error(
        `Model ${route.main.profile.id} failed with HTTP ${result.statusCode}.`,
      );
      requestAttempts.push({
        modelId: route.main.profile.id,
        role: "main",
        outcome: "failed",
        executedModel: result.upstreamModel ?? mainExecutedModel,
        statusCode: result.statusCode,
        durationMilliseconds: Math.round(performance.now() - mainStartedAt),
        message: lastFailure.message.slice(0, 500),
      });
      if (result.statusCode === 429) exhaustedModels.add(route.main.profile.id);
      attemptedMainIds.add(route.main.profile.id);
    }
    if (lastCapabilityUnsupportedResult !== undefined) return lastCapabilityUnsupportedResult;
    throw lastFailure ?? new Error("All eligible models failed.");
  };

  return {
    descriptor: { type: "tidu-router", model: policy.mainModelId },
    execute,
    inspect: () => (latestDecision === undefined ? undefined : structuredClone(latestDecision)),
    inspectAttempts: () => structuredClone(latestAttempts),
  };
};

export const createCapabilityCompletionProvider = (
  provider: ModelProvider,
  loadConfiguration: () => Promise<{
    modelSelection: ModelSelection;
    capabilityCompletion: CapabilityCompletionConfiguration;
  }>,
  options: CapabilityCompletionProviderOptions = {},
): CapabilityCompletionProvider => {
  const records: CapabilityCompletionUsageRecord[] = [];
  const pruneRecords = (): void => {
    const countsByHost = new Map<AgentHostId, number>();
    const retained = records.filter((record) => {
      const count = countsByHost.get(record.host) ?? 0;
      countsByHost.set(record.host, count + 1);
      return count < 50;
    });
    records.splice(0, records.length, ...retained);
  };
  const tokenObservations = new Map<
    string,
    { inputTokens: number; outputTokens: number; samples: number }
  >();
  const performanceObservations = new Map<
    string,
    { totalDurationMilliseconds: number; samples: number; successes: number }
  >();
  const resolvedProviders = new Set<ModelProvider>([provider]);
  const bindModel = (
    host: AgentHostId,
    selection: ModelSelection,
    capabilities: readonly string[],
    id: string,
    costs?: Pick<
      CapabilitySpecialistConfiguration,
      "inputCostPerMillionTokens" | "outputCostPerMillionTokens"
    >,
  ): RoutableModel => {
    const observationKey = modelObservationKey(host, selection);
    const performanceObservation = performanceObservations.get(observationKey);
    const recordPerformance = (startedAt: number, succeeded: boolean): void => {
      const previous = performanceObservations.get(observationKey) ?? {
        totalDurationMilliseconds: 0,
        samples: 0,
        successes: 0,
      };
      performanceObservations.set(observationKey, {
        totalDurationMilliseconds:
          previous.totalDurationMilliseconds + (performance.now() - startedAt),
        samples: previous.samples + 1,
        successes: previous.successes + (succeeded ? 1 : 0),
      });
    };
    return {
      profile: {
        id,
        host,
        capabilities,
        inputCostPerMillionTokens: costs?.inputCostPerMillionTokens ?? null,
        outputCostPerMillionTokens: costs?.outputCostPerMillionTokens ?? null,
        averageInputTokensByCapability: Object.fromEntries(
          capabilities.flatMap((capability) => {
            const observation = tokenObservations.get(`${observationKey}\u0000${capability}`);
            return observation === undefined
              ? []
              : [[capability, observation.inputTokens / observation.samples]];
          }),
        ),
        averageOutputTokensByCapability: Object.fromEntries(
          capabilities.flatMap((capability) => {
            const observation = tokenObservations.get(`${observationKey}\u0000${capability}`);
            return observation === undefined
              ? []
              : [[capability, observation.outputTokens / observation.samples]];
          }),
        ),
        averageLatencyMilliseconds:
          performanceObservation === undefined
            ? 0
            : performanceObservation.totalDurationMilliseconds / performanceObservation.samples,
        performanceSamples: performanceObservation?.samples ?? 0,
        availability:
          performanceObservation === undefined
            ? 1
            : performanceObservation.successes / performanceObservation.samples,
        privacy: host === "ollama" ? "local" : "external",
        remainingRequests: null,
        enabled: true,
      },
      provider: {
        descriptor: provider.descriptor,
        execute: async (request) => {
          const startedAt = performance.now();
          try {
            const selectedProvider =
              options.resolveProviderForHost === undefined
                ? provider
                : await options.resolveProviderForHost(host);
            if (selectedProvider === undefined) {
              recordPerformance(startedAt, false);
              return {
                kind: "json",
                statusCode: 503,
                body: {
                  error: {
                    code: "specialist_host_unavailable",
                    message: `The ${host} host is unavailable for capability completion.`,
                    type: "server_error",
                  },
                },
              };
            }
            resolvedProviders.add(selectedProvider);
            const result = await selectedProvider.execute({
              ...request,
              routing: {
                ...request.routing,
                host,
                modelSource: selection.source,
                availableCapabilities: request.routing?.availableCapabilities ?? capabilities,
                ...(selection.model === "current" ? {} : { targetModel: selection.model }),
              },
            });
            if (result.kind === "stream") {
              return observeProviderStream(
                result,
                (observation) => {
                  if (!observation.cancelled) recordPerformance(startedAt, observation.succeeded);
                },
                request.protocol,
              );
            }
            recordPerformance(startedAt, result.statusCode >= 200 && result.statusCode < 300);
            return result;
          } catch (error) {
            if (requestCancellationError(request, error) === undefined)
              recordPerformance(startedAt, false);
            throw error;
          }
        },
      },
    };
  };
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
          specialists: active.capabilityCompletion.specialists.filter(
            (specialist) => specialist.host !== host,
          ),
          maximumSpecialists: active.capabilityCompletion.maximumSpecialists,
        }
      : {
          modelSelection: policy.mainModel,
          mainCapabilities: policy.mainCapabilities,
          specialists: policy.specialists.filter((specialist) => specialist.host !== host),
          maximumSpecialists: policy.maximumSpecialists,
        };
  };
  const modelResult = (
    modelId: string,
    host: AgentHostId,
    model: string,
    role: "main" | "secondary",
    capabilities: readonly string[],
    attempts: readonly RoutingModelAttempt[],
    selectedModelIds: ReadonlySet<string>,
  ): CapabilityCompletionModelResult => {
    const attempt = [...attempts].reverse().find((item) => item.modelId === modelId);
    const skipReason = selectedModelIds.has(modelId)
      ? attempts.some((item) => item.outcome === "cancelled")
        ? "blocked-by-cancellation"
        : attempts.length > 0 && attempts.every((item) => item.outcome === "succeeded")
          ? "awaiting-tool-results"
          : "blocked-by-failure"
      : "not-selected";
    return attempt === undefined
      ? {
          modelId,
          host,
          model,
          role,
          capabilities: [],
          outcome: "not-run",
          executedModel: null,
          skipReason,
          statusCode: null,
          durationMilliseconds: null,
          message:
            skipReason === "awaiting-tool-results"
              ? "Waiting for the caller to execute the requested tools and return their results."
              : skipReason === "blocked-by-cancellation"
                ? "Selected but not called because the request was cancelled."
                : skipReason === "blocked-by-failure"
                  ? "Selected but not called because another selected model failed first."
                  : "Not selected by the active routing rules for this request.",
        }
      : {
          modelId,
          host,
          model,
          role,
          capabilities,
          outcome: attempt.outcome,
          executedModel: attempt.executedModel,
          statusCode: attempt.statusCode,
          durationMilliseconds: attempt.durationMilliseconds,
          message: attempt.message,
        };
  };
  const assignedCapabilities = (
    requiredCapabilities: readonly string[],
    availableCapabilities: readonly string[],
    includeText: boolean,
  ): readonly string[] => [
    ...new Set([
      ...requiredCapabilities.filter((capability) => availableCapabilities.includes(capability)),
      ...(includeText && availableCapabilities.includes("text") ? ["text"] : []),
    ]),
  ];
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
    close: async () => {
      await Promise.all([...resolvedProviders].map((item) => item.close?.()));
    },
    inspectCapabilityCompletion: readStatus,
    execute: async (request) => {
      const active = await loadConfiguration();
      const requestHost = request.routing?.host ?? "openai-compatible";
      const hostPolicy = resolveHostPolicy(active, requestHost);
      const mainId = `main:${requestHost}:${hostPolicy.modelSelection.source}`;
      const specialists = hostPolicy.specialists.map((specialist, index) =>
        bindModel(
          specialist.host,
          specialist,
          specialist.capabilities,
          `specialist-${index}:${specialist.host}:${specialist.source}`,
          specialist,
        ),
      );
      if (!active.capabilityCompletion.enabled || specialists.length === 0) {
        const requiredCapabilities = inferCapabilities(request);
        const missingCapabilities = requiredCapabilities.filter(
          (capability) => !hostPolicy.mainCapabilities.includes(capability),
        );
        if (missingCapabilities.length > 0) {
          records.unshift({
            host: requestHost,
            mainModelId: mainId,
            specialistModelIds: [],
            requiredCapabilities,
            missingCapabilities,
            score: 0,
            estimatedCostPerMillionTokens: null,
            reason: "capability-gap",
            tokenUsage: null,
            modelTokenUsage: [],
            occurredAt: new Date().toISOString(),
            role: request.routing?.role ?? "main",
            complemented: false,
            outcome: "failed",
            mainResult: {
              modelId: mainId,
              host: requestHost,
              model: hostPolicy.modelSelection.model,
              executedModel: null,
              role: "main",
              capabilities: assignedCapabilities(
                requiredCapabilities,
                hostPolicy.mainCapabilities,
                true,
              ),
              outcome: "not-run",
              skipReason: "not-selected",
              statusCode: null,
              durationMilliseconds: null,
              message: "Not called because the configured capabilities do not cover the request.",
            },
            secondaryResults: hostPolicy.specialists.map((specialist, index) => ({
              modelId: `specialist-${index}:${specialist.host}:${specialist.source}`,
              host: specialist.host,
              model: specialist.model,
              executedModel: null,
              role: "secondary",
              capabilities: [],
              outcome: "not-run",
              skipReason: "not-selected",
              statusCode: null,
              durationMilliseconds: null,
              message: active.capabilityCompletion.enabled
                ? "Not selected because the configured capability union does not cover the request."
                : "Not selected because capability completion is disabled.",
            })),
          });
          pruneRecords();
          throw new Error(
            `No configured model combination covers required capabilities: ${missingCapabilities.join(", ")}.`,
          );
        }
        const startedAt = performance.now();
        let reportedUsage: RoutingTokenUsage | null = null;
        const recordMainResult = (
          mainAttempt: RoutingModelAttempt,
          tokenUsage: ReturnType<typeof extractTokenUsage>,
        ): void => {
          records.unshift({
            host: requestHost,
            mainModelId: mainId,
            specialistModelIds: [],
            requiredCapabilities,
            missingCapabilities,
            score: 0,
            estimatedCostPerMillionTokens: null,
            reason: "main-capability-match",
            tokenUsage,
            modelTokenUsage: tokenUsage === null ? [] : [{ modelId: mainId, ...tokenUsage }],
            occurredAt: new Date().toISOString(),
            role: request.routing?.role ?? "main",
            complemented: false,
            outcome: mainAttempt.outcome,
            mainResult: modelResult(
              mainId,
              requestHost,
              hostPolicy.modelSelection.model,
              "main",
              assignedCapabilities(requiredCapabilities, hostPolicy.mainCapabilities, true),
              [mainAttempt],
              new Set([mainId]),
            ),
            secondaryResults: [],
          });
          pruneRecords();
        };
        let result: ProviderExecutionResult;
        const mainCapabilities = assignedCapabilities(
          requiredCapabilities,
          hostPolicy.mainCapabilities,
          true,
        );
        try {
          const routedRequest = injectMissingCapabilityContext(request, missingCapabilities);
          result = await bindModel(
            requestHost,
            hostPolicy.modelSelection,
            hostPolicy.mainCapabilities,
            mainId,
          ).provider.execute({
            ...routedRequest,
            onExecutionReceipt: (receipt) => {
              if (receipt.usage !== null) reportedUsage = receipt.usage;
              request.onExecutionReceipt?.(receipt);
            },
            routing: {
              ...routedRequest.routing,
              host: requestHost,
              requiredCapabilities,
              availableCapabilities: mainCapabilities,
            },
          });
        } catch (error) {
          const mainAttempt: RoutingModelAttempt = {
            modelId: mainId,
            role: "main",
            outcome:
              requestCancellationError(request, error) === undefined ? "failed" : "cancelled",
            executedModel: null,
            statusCode: null,
            durationMilliseconds: Math.round(performance.now() - startedAt),
            message: (error instanceof Error ? error.message : "Primary model failed.").slice(
              0,
              500,
            ),
          };
          recordMainResult(mainAttempt, reportedUsage);
          throw error;
        }
        if (result.kind === "stream") {
          if (result.upstreamModel !== undefined) {
            request.onExecutionReceipt?.({
              host: requestHost,
              model: result.upstreamModel,
              role: request.routing?.role ?? "main",
              capabilities: mainCapabilities,
              usage: null,
            });
          }
          return observeProviderStream(
            result,
            (observation) => {
              recordMainResult(
                {
                  modelId: mainId,
                  role: "main",
                  outcome: observation.cancelled
                    ? "cancelled"
                    : observation.succeeded
                      ? "succeeded"
                      : "failed",
                  executedModel: result.upstreamModel ?? null,
                  statusCode: result.statusCode,
                  durationMilliseconds: Math.round(performance.now() - startedAt),
                  message: observation.message,
                },
                observation.tokenUsage ?? reportedUsage,
              );
            },
            request.protocol,
            request.signal,
          );
        }
        const mainSucceeded = result.statusCode >= 200 && result.statusCode < 300;
        const mainTokenUsage = extractTokenUsage(result);
        recordMainResult(
          {
            modelId: mainId,
            role: "main",
            outcome: mainSucceeded ? "succeeded" : "failed",
            executedModel: result.upstreamModel ?? null,
            statusCode: result.statusCode,
            durationMilliseconds: Math.round(performance.now() - startedAt),
            message: mainSucceeded ? "" : `Primary model returned HTTP ${result.statusCode}.`,
          },
          mainTokenUsage,
        );
        if (result.upstreamModel !== undefined) {
          request.onExecutionReceipt?.({
            host: requestHost,
            model: result.upstreamModel,
            role: request.routing?.role ?? "main",
            capabilities: mainCapabilities,
            usage: mainTokenUsage,
          });
        }
        return result;
      }
      const router = createDynamicModelRouter(
        [
          bindModel(requestHost, hostPolicy.modelSelection, hostPolicy.mainCapabilities, mainId),
          ...specialists,
        ],
        {
          enabled: active.capabilityCompletion.enabled,
          mainModelId: mainId,
          weights: {
            capability: 10,
            cost: 1,
            privacy: 2,
            latency: 1,
            availability: 3,
          },
          capabilityCompletion: {
            enabled: active.capabilityCompletion.enabled,
            poolModelIds: specialists.map((specialist) => specialist.profile.id),
            maximumSpecialists: hostPolicy.maximumSpecialists,
          },
        },
      );
      const capabilitiesByModel = new Map(
        [
          bindModel(requestHost, hostPolicy.modelSelection, hostPolicy.mainCapabilities, mainId),
          ...specialists,
        ].map((model) => [model.profile.id, model.profile.capabilities]),
      );
      const observationKeysByModel = new Map<string, string>([
        [mainId, modelObservationKey(requestHost, hostPolicy.modelSelection)],
        ...hostPolicy.specialists.map((specialist, index): [string, string] => [
          `specialist-${index}:${specialist.host}:${specialist.source}`,
          modelObservationKey(specialist.host, specialist),
        ]),
      ]);
      const recordRoutingResult = (
        decision: RoutingDecision,
        outcome: CapabilityCompletionUsageRecord["outcome"],
      ): void => {
        for (const usage of decision.modelTokenUsage) {
          const capabilities = capabilitiesByModel.get(usage.modelId) ?? [];
          const observationKey = observationKeysByModel.get(usage.modelId);
          if (observationKey === undefined) continue;
          for (const capability of decision.requiredCapabilities.filter((item) =>
            capabilities.includes(item),
          )) {
            const key = `${observationKey}\u0000${capability}`;
            const previous = tokenObservations.get(key) ?? {
              inputTokens: 0,
              outputTokens: 0,
              samples: 0,
            };
            tokenObservations.set(key, {
              inputTokens: previous.inputTokens + usage.inputTokens,
              outputTokens: previous.outputTokens + usage.outputTokens,
              samples: previous.samples + 1,
            });
          }
        }
        records.unshift({
          host: requestHost,
          ...decision,
          occurredAt: new Date().toISOString(),
          role: request.routing?.role ?? "main",
          complemented: decision.mainModelId !== mainId || decision.specialistModelIds.length > 0,
          outcome,
          mainResult: modelResult(
            mainId,
            requestHost,
            hostPolicy.modelSelection.model,
            "main",
            assignedCapabilities(decision.requiredCapabilities, hostPolicy.mainCapabilities, true),
            router.inspectAttempts(),
            new Set([decision.mainModelId, ...decision.specialistModelIds]),
          ),
          secondaryResults: hostPolicy.specialists.map((specialist, index) =>
            modelResult(
              `specialist-${index}:${specialist.host}:${specialist.source}`,
              specialist.host,
              specialist.model,
              "secondary",
              assignedCapabilities(decision.requiredCapabilities, specialist.capabilities, false),
              router.inspectAttempts(),
              new Set([decision.mainModelId, ...decision.specialistModelIds]),
            ),
          ),
        });
        pruneRecords();
      };
      try {
        const result = await router.execute(request);
        const decision = router.inspect();
        if (decision !== undefined) {
          if (result.kind === "stream") {
            return observeProviderStream(
              result,
              (observation) => {
                recordRoutingResult(
                  router.inspect() ?? decision,
                  observation.cancelled
                    ? "cancelled"
                    : observation.succeeded
                      ? "succeeded"
                      : "failed",
                );
              },
              request.protocol,
              request.signal,
            );
          }
          recordRoutingResult(
            decision,
            result.statusCode >= 200 && result.statusCode < 300 ? "succeeded" : "failed",
          );
        }
        return result;
      } catch (error) {
        const decision = router.inspect();
        if (decision !== undefined) {
          recordRoutingResult(
            decision,
            requestCancellationError(request, error) === undefined ? "failed" : "cancelled",
          );
        }
        throw error;
      }
    },
  };
};

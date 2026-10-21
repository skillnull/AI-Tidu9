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
  outcome: "failed" | "succeeded";
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
  /** Whether this entry is the primary or a secondary model. */
  role: "main" | "secondary";
  /** Required capabilities assigned to this model for the request. */
  capabilities: readonly string[];
  /** Individual call result, including models skipped after an earlier failure. */
  outcome: "failed" | "not-run" | "succeeded";
  /** Why a configured model was not called for this request. */
  skipReason?: "blocked-by-failure" | "not-selected";
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
  outcome: "failed" | "succeeded";
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

export const inferModelRequestCapabilities = (
  request: ProviderExecutionRequest,
): readonly string[] => {
  const inferred = new Set<string>([
    DEFAULT_REQUIRED_CAPABILITY,
    ...(request.routing?.requiredCapabilities ?? []),
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
  if (/"type"\s*:\s*"(?:image|image_url|input_image)"/u.test(serialized)) {
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

const validateProfile = (profile: ModelRouteProfile): ModelRouteProfile => {
  if (!ID_PATTERN.test(profile.id)) {
    throw new Error("Routable models require a safe stable identifier.");
  }
  const capabilities = normalizeCapabilities(profile.capabilities);
  if (capabilities.length === 0) {
    throw new Error(`Routable model ${profile.id} must declare at least one capability.`);
  }
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

const extractTokenUsage = (
  result: ProviderExecutionResult,
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null => {
  if (result.kind !== "json" || !isRecord(result.body) || !isRecord(result.body.usage)) {
    return null;
  }
  const usage = result.body.usage;
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
  /** Whether the stream produced assistant output and reached a successful terminal event. */
  succeeded: boolean;
  /** Bounded terminal diagnostic used by local routing history. */
  message: string;
}

interface ProviderStreamObservationState {
  sawOutput: boolean;
  sawSuccessfulTerminal: boolean;
  failureMessage?: string;
}

const boundedStreamMessage = (message: string): string => message.slice(0, 500);

const responseOutputHasContent = (response: Record<string, unknown>): boolean => {
  if (typeof response.output_text === "string" && response.output_text !== "") return true;
  if (!Array.isArray(response.output)) return false;
  return response.output.some((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return false;
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
    if (cancelled) {
      return {
        succeeded: false,
        message: aborted
          ? "Provider stream was cancelled because the request was aborted."
          : "Provider stream was cancelled before completion.",
      };
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return {
        succeeded: false,
        message: `Primary model returned HTTP ${result.statusCode}.`,
      };
    }
    if (state.failureMessage !== undefined) {
      return { succeeded: false, message: state.failureMessage };
    }
    if (!state.sawOutput) {
      return {
        succeeded: false,
        message: "Provider stream ended without assistant output.",
      };
    }
    if (!state.sawSuccessfulTerminal) {
      return {
        succeeded: false,
        message: "Provider stream ended without a successful terminal event.",
      };
    }
    return { succeeded: true, message: "" };
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
          finish({ succeeded: false, message: boundedStreamMessage(message) });
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
    result: string;
  }[],
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
        main = preferredMain;
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
      const cancellationBeforeRoute = requestCancellationError(request);
      if (cancellationBeforeRoute !== undefined) throw cancellationBeforeRoute;
      let contributions: Array<{
        modelId: string;
        capabilities: readonly string[];
        result: string;
        tokenUsage: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        } | null;
      }>;
      try {
        contributions = await Promise.all(
          route.specialists.map(async (specialist) => {
            const startedAt = performance.now();
            let statusCode: number | null = null;
            try {
              const cancellationBeforeSpecialist = requestCancellationError(request);
              if (cancellationBeforeSpecialist !== undefined) {
                throw cancellationBeforeSpecialist;
              }
              const specialistResult = await specialist.provider.execute({
                ...request,
                body: { ...request.body, stream: false },
                routing: { ...request.routing, role: "specialist" },
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
              const result = extractModelText(specialistResult);
              requestAttempts.push({
                modelId: specialist.profile.id,
                role: "secondary",
                outcome: "succeeded",
                statusCode,
                durationMilliseconds: Math.round(performance.now() - startedAt),
                message: "",
              });
              return {
                modelId: specialist.profile.id,
                capabilities: specialist.profile.capabilities.filter((capability) =>
                  route.decision.requiredCapabilities.includes(capability),
                ),
                result,
                tokenUsage: extractTokenUsage(specialistResult),
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Secondary model failed.";
              requestAttempts.push({
                modelId: specialist.profile.id,
                role: "secondary",
                outcome: "failed",
                statusCode,
                durationMilliseconds: Math.round(performance.now() - startedAt),
                message: message.slice(0, 500),
              });
              throw error;
            }
          }),
        );
      } catch (error) {
        const cancellation = requestCancellationError(request, error);
        if (cancellation !== undefined) throw cancellation;
        for (const specialist of route.specialists) exhaustedModels.add(specialist.profile.id);
        lastFailure =
          error instanceof Error ? error : new Error("Capability secondary model failed.");
        continue;
      }
      const cancellationAfterSpecialists = requestCancellationError(request);
      if (cancellationAfterSpecialists !== undefined) throw cancellationAfterSpecialists;
      let result: ProviderExecutionResult;
      const mainStartedAt = performance.now();
      try {
        result = await route.main.provider.execute({
          ...injectSpecialistContext(request, contributions),
          routing: {
            ...request.routing,
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
          outcome: "failed",
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
          outcome: "failed",
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
        latestDecision = {
          ...route.decision,
          tokenUsage: combineTokenUsage([
            ...contributions.map((contribution) => contribution.tokenUsage),
            resultTokenUsage,
          ]),
          modelTokenUsage: [
            ...contributions.flatMap((contribution) =>
              contribution.tokenUsage === null
                ? []
                : [
                    {
                      modelId: contribution.modelId,
                      ...contribution.tokenUsage,
                    },
                  ],
            ),
            ...(resultTokenUsage === null
              ? []
              : [
                  {
                    modelId: route.main.profile.id,
                    ...resultTokenUsage,
                  },
                ]),
          ],
        };
        if (result.kind === "stream") {
          return observeProviderStream(
            result,
            (observation) => {
              requestAttempts.push({
                modelId: route.main.profile.id,
                role: "main",
                outcome: observation.succeeded ? "succeeded" : "failed",
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
          statusCode: result.statusCode,
          durationMilliseconds: Math.round(performance.now() - mainStartedAt),
          message:
            result.statusCode >= 200 && result.statusCode < 300
              ? ""
              : `Primary model returned HTTP ${result.statusCode}.`,
        });
        return result;
      }
      lastFailure = new Error(
        `Model ${route.main.profile.id} failed with HTTP ${result.statusCode}.`,
      );
      requestAttempts.push({
        modelId: route.main.profile.id,
        role: "main",
        outcome: "failed",
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
                ...(selection.model === "current" ? {} : { targetModel: selection.model }),
              },
            });
            if (result.kind === "stream") {
              return observeProviderStream(
                result,
                (observation) => {
                  recordPerformance(startedAt, observation.succeeded);
                },
                request.protocol,
              );
            }
            recordPerformance(startedAt, result.statusCode >= 200 && result.statusCode < 300);
            return result;
          } catch (error) {
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
    const skipReason = selectedModelIds.has(modelId) ? "blocked-by-failure" : "not-selected";
    return attempt === undefined
      ? {
          modelId,
          host,
          model,
          role,
          capabilities: [],
          outcome: "not-run",
          skipReason,
          statusCode: null,
          durationMilliseconds: null,
          message:
            skipReason === "blocked-by-failure"
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
        const startedAt = performance.now();
        const recordMainResult = (
          mainAttempt: RoutingModelAttempt,
          tokenUsage: ReturnType<typeof extractTokenUsage>,
        ): void => {
          records.unshift({
            host: requestHost,
            mainModelId: mainId,
            specialistModelIds: [],
            requiredCapabilities,
            missingCapabilities: requiredCapabilities.filter(
              (capability) => !hostPolicy.mainCapabilities.includes(capability),
            ),
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
        try {
          result = await bindModel(
            requestHost,
            hostPolicy.modelSelection,
            hostPolicy.mainCapabilities,
            mainId,
          ).provider.execute(request);
        } catch (error) {
          const mainAttempt: RoutingModelAttempt = {
            modelId: mainId,
            role: "main",
            outcome: "failed",
            statusCode: null,
            durationMilliseconds: Math.round(performance.now() - startedAt),
            message: (error instanceof Error ? error.message : "Primary model failed.").slice(
              0,
              500,
            ),
          };
          recordMainResult(mainAttempt, null);
          throw error;
        }
        if (result.kind === "stream") {
          return observeProviderStream(
            result,
            (observation) => {
              recordMainResult(
                {
                  modelId: mainId,
                  role: "main",
                  outcome: observation.succeeded ? "succeeded" : "failed",
                  statusCode: result.statusCode,
                  durationMilliseconds: Math.round(performance.now() - startedAt),
                  message: observation.message,
                },
                null,
              );
            },
            request.protocol,
            request.signal,
          );
        }
        const mainSucceeded = result.statusCode >= 200 && result.statusCode < 300;
        recordMainResult(
          {
            modelId: mainId,
            role: "main",
            outcome: mainSucceeded ? "succeeded" : "failed",
            statusCode: result.statusCode,
            durationMilliseconds: Math.round(performance.now() - startedAt),
            message: mainSucceeded ? "" : `Primary model returned HTTP ${result.statusCode}.`,
          },
          extractTokenUsage(result),
        );
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
        outcome: "failed" | "succeeded",
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
          complemented: decision.specialistModelIds.length > 0,
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
                recordRoutingResult(decision, observation.succeeded ? "succeeded" : "failed");
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
          recordRoutingResult(decision, "failed");
        }
        throw error;
      }
    },
  };
};

import {
  type CodexHostInspectionOptions,
  createCodexAppServerLaunch,
} from "../accounts/codex-host.js";
import { TiduError } from "../core/index.js";
import {
  createStdioJsonRpcClient,
  type JsonRpcClient,
  type JsonRpcClientOptions,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./json-rpc.js";

export type CodexApprovalDecision = "accept" | "acceptForSession" | "cancel" | "decline";
export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface CodexAgentEvent {
  /** App-server notification method. */
  method: string;
  /** Notification payload returned by Codex. */
  params: unknown;
}

export interface CodexAgentOptions extends CodexHostInspectionOptions {
  /** Optional transport adapter; the native stdio transport remains the default. */
  transportFactory?: (handlers: JsonRpcClientOptions) => JsonRpcClient;
  /** Working directory used for new Codex threads. */
  workingDirectory: string;
  /** Whether new threads should remain ephemeral and out of host history. */
  ephemeral?: boolean;
  /** Filesystem access granted to Codex for this thread. */
  sandbox?: "read-only" | "workspace-write";
  /** Optional model selected through Codex's authoritative model catalog. */
  model?: string;
  /** Reasoning effort used by delegated inference turns. */
  reasoningEffort?: CodexReasoningEffort;
  /** Optional notification observer for streaming UI integration. */
  onEvent?: (event: CodexAgentEvent) => void;
  /** Explicit reviewer for command and file-change approval requests. */
  onApproval?: (request: JsonRpcServerRequest) => Promise<CodexApprovalDecision>;
}

export interface CodexThread {
  /** Codex thread identifier used for follow-up turns and cancellation. */
  id: string;
  /** Model selected by Codex for this thread. */
  model: string;
}

export interface CodexAccountSummary {
  /** Host-owned account sign-in method. */
  type: "chatgpt" | "apiKey" | "amazonBedrock" | "unknown";
  /** Account email when the official app-server provides it. */
  email: string | null;
  /** Account plan when the official app-server provides it. */
  plan: string | null;
}

export interface CodexRateLimitWindow {
  /** Percentage of the window already consumed, as reported by Codex. */
  usedPercent: number;
  /** Duration of this window in minutes, when reported. */
  windowDurationMins: number | null;
  /** Unix timestamp for the next reset, when reported. */
  resetsAt: number | null;
}

export interface CodexUsageSummary {
  /** Metered Codex limit identifier, when reported. */
  limitId: string | null;
  /** Shorter quota window, when reported. */
  primary: CodexRateLimitWindow | null;
  /** Longer quota window, when reported. */
  secondary: CodexRateLimitWindow | null;
  /** Remaining prepaid credits, when reported. */
  creditBalance: string | null;
  /** Available reset credits; null means the host did not report a count. */
  availableResetCredits: number | null;
  /** Account lifetime token total, when reported. */
  lifetimeTokens: number | null;
  /** Daily account token totals, when reported. */
  dailyTokens: readonly { date: string; tokens: number }[];
}

export interface CodexTurnResult {
  /** Codex thread that owns the completed turn. */
  threadId: string;
  /** Codex turn identifier. */
  turnId: string;
  /** Terminal turn status. */
  status: "completed" | "failed" | "interrupted";
  /** Host-reported failure, when the turn failed with an explanation. */
  error?: {
    /** Original upstream failure message. */
    message: string;
    /** Authoritative native failure category, including capacity and transport errors. */
    codexErrorInfo?: unknown;
  };
  /** Concatenated assistant message deltas. */
  text: string;
  /** Caller-owned tools yielded without execution by the delegated host. */
  toolCalls?: readonly CodexCallerToolCall[];
  /** Completed native reasoning and commentary items from delegated model rounds. */
  progressItems?: readonly Record<string, unknown>[];
  /** Per-turn token usage reported by the official app-server. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  } | null;
}

export interface CodexCallerToolCall {
  /** Stable call identifier returned by the model. */
  callId: string;
  /** Caller tool namespace, when declared. */
  namespace: string | null;
  /** Caller tool name. */
  tool: string;
  /** Model-generated arguments; execution remains with the caller. */
  arguments: unknown;
}

export type CodexTurnInput =
  | {
      /** Text input forwarded to the Codex turn. */
      type: "text";
      /** User-visible text supplied to the model. */
      text: string;
      /** Optional rich-text metadata supported by app-server. */
      text_elements?: readonly unknown[];
    }
  | {
      /** Remote or data-URL image input. */
      type: "image";
      /** Fully qualified URL or base64 data URL. */
      url: string;
    }
  | {
      /** Local image input available to the Codex host. */
      type: "localImage";
      /** Absolute local filesystem path. */
      path: string;
    };

/** Host-defined message phase; known values are hints, not a closed compatibility gate. */
export type CodexMessagePhase = "commentary" | "final_answer" | (string & {});

export interface CodexProcessDeltaSource {
  /** Official item identifier that emitted this process delta. */
  itemId: string;
  /** Native process kind retained while the item is streaming. */
  type: "activity" | "commentary" | "reasoning";
  /** Native reasoning summary part receiving this delta. */
  summaryIndex?: number;
  /** Adapter-inserted separator rather than model-authored text. */
  separator?: boolean;
}

export interface CodexAgentClient {
  /** Negotiates protocol capabilities and sends the initialized notification. */
  initialize: () => Promise<void>;
  /** Starts a persistent Codex thread under the configured workspace. */
  startThread: (
    model?: string,
    callerTools?: readonly Record<string, unknown>[],
    webSearchMode?: "disabled" | "cached" | "live",
  ) => Promise<CodexThread>;
  /** Reads non-secret account metadata through the official app-server. */
  readAccount: () => Promise<CodexAccountSummary | null>;
  /** Reads account quota and token totals without running a model turn. */
  readUsage: () => Promise<CodexUsageSummary>;
  /** Sends one user turn, streams text deltas, and resolves after a terminal notification. */
  prompt: (
    threadId: string,
    input: readonly CodexTurnInput[],
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
    reasoningEffort?: CodexReasoningEffort,
    onProcessDelta?: (delta: string, source?: CodexProcessDeltaSource) => void,
    historyItems?: readonly Record<string, unknown>[],
    outputSchema?: Record<string, unknown>,
    onUsageUpdate?: (usage: NonNullable<CodexTurnResult["usage"]>) => void,
    reasoningSummary?: CodexReasoningSummary,
    onNativeItem?: (item: Record<string, unknown>) => void,
  ) => Promise<CodexTurnResult>;
  /** Interrupts one active turn. */
  cancel: (threadId: string, turnId: string) => Promise<void>;
  /** Terminates the delegated app-server process. */
  close: () => Promise<void>;
}

interface TurnState {
  /** Thread owning the live native turn. */
  threadId: string;
  /** Native turn retained while caller tools execute. */
  turnId: string;
  /** Whether this response has already been handed to the caller. */
  yielded: boolean;
  /** Claimed caller batches, retained while their native turn remains active. */
  resumes: Map<string, CallerResume>;
  /** Unanswered native RPCs indexed by the caller's stable call ID. */
  toolReplies: Map<
    string,
    { resolve: (reply: CodexToolReply) => void; reject: (error: Error) => void }
  >;
  /** Real caller results retained until sequential native tool requests consume them. */
  toolResults: Map<string, CodexToolReply>;
  /** Whether the current model response reached its official completion boundary. */
  modelResponseCompleted: boolean;
  /** Dynamic requests waiting for the complete model response and its usage. */
  responseWaiters: Array<() => void>;
  /** Streams completed native progress before subsequent text or tool requests. */
  onNativeItem?: (item: Record<string, unknown>) => void;
  /** Completed model items that can be durably forwarded without flattening their phase. */
  progressItems: Record<string, unknown>[];
  /** Caller-owned tool requests emitted by the current model response. */
  toolCalls: CodexCallerToolCall[];
  /** Assistant text accumulated from streaming notifications. */
  text: string;
  /** Completes the public prompt promise. */
  resolve: (result: CodexTurnResult) => void;
  /** Rejects the public prompt promise. */
  reject: (error: Error) => void;
  /** Removes cancellation listeners. */
  cleanup: () => void;
  /** Receives text as soon as the official app-server emits it. */
  onTextDelta?: (delta: string) => void;
  /** Receives public reasoning summaries and commentary as soon as they are emitted. */
  onProcessDelta?: (delta: string, source?: CodexProcessDeltaSource) => void;
  /** Process item whose deltas were most recently forwarded. */
  processItemKey?: string;
  /** Latest per-turn token usage reported by the official app-server. */
  usage: CodexTurnResult["usage"];
  /** Whether usage came from the turn-aggregate notification instead of one raw model response. */
  hasTurnAggregateUsage: boolean;
  /** Receives provider-authoritative usage before the turn reaches a terminal state. */
  onUsageUpdate?: (usage: NonNullable<CodexTurnResult["usage"]>) => void;
  /** Successful completion held briefly while an adjacent exact-usage notification arrives. */
  pendingCompletion?: Omit<CodexTurnResult, "text" | "usage">;
  /** Bounded timer that prevents a missing usage event from delaying completion indefinitely. */
  usageWaitTimer?: NodeJS.Timeout;
}

interface CallerResume {
  /** Canonical caller payload used to distinguish retries from conflicting results. */
  key: string;
  /** Shared outcome for all concurrent deliveries of this batch. */
  promise: Promise<CodexTurnResult>;
  /** Whether a rejected attempt may be resumed without repeating accepted input. */
  failed?: boolean;
  /** Whether the original additional user input was already accepted. */
  steered?: boolean;
  /** Whether the original additional context was already accepted. */
  injected?: boolean;
}

interface CodexToolReply {
  /** Actual caller output in the native dynamic-tool response format. */
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
  /** Whether the caller reported successful execution. */
  success: boolean;
}

interface BufferedTurnNotifications {
  /** A model response boundary received before local turn registration. */
  modelResponseCompleted?: boolean;
  /** Native items and deltas in their original arrival order before local registration. */
  notifications: Array<
    | { type: "native"; item: Record<string, unknown> }
    | { type: "text"; delta: string }
    | { type: "process"; itemKey: string; delta: string; separator?: boolean }
    | { type: "tool"; call: CodexCallerToolCall }
  >;
  /** Terminal result received before the turn was registered locally. */
  completion?: Omit<CodexTurnResult, "text" | "usage">;
  /** Token usage received before the turn was registered locally. */
  usage?: NonNullable<CodexTurnResult["usage"]>;
  /** Whether buffered usage is the authoritative turn aggregate. */
  hasTurnAggregateUsage?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const callerPayloadKey = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) =>
    isRecord(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([left], [right]) => left.localeCompare(right)),
        )
      : child,
  );

const readString = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

const readNumber = (value: unknown, key: string): number | null => {
  if (!isRecord(value)) return null;
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string" && /^\d+(?:\.\d+)?$/u.test(field)) {
    const numeric = Number(field);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }
  return null;
};

const readTurnTokenUsage = (value: unknown): NonNullable<CodexTurnResult["usage"]> | null => {
  const inputTokens = readNumber(value, "inputTokens");
  const outputTokens = readNumber(value, "outputTokens");
  const totalTokens = readNumber(value, "totalTokens");
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  const cachedInputTokens = readNumber(value, "cachedInputTokens");
  const cacheWriteInputTokens = readNumber(value, "cacheWriteInputTokens");
  const reasoningTokens = readNumber(value, "reasoningOutputTokens");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === null ? {} : { cacheWriteInputTokens }),
    ...(reasoningTokens === null ? {} : { reasoningTokens }),
  };
};

const tokenUsageMatches = (
  left: CodexTurnResult["usage"],
  right: NonNullable<CodexTurnResult["usage"]>,
): boolean =>
  left !== null &&
  left.inputTokens === right.inputTokens &&
  left.outputTokens === right.outputTokens &&
  left.totalTokens === right.totalTokens &&
  left.cachedInputTokens === right.cachedInputTokens &&
  left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
  left.reasoningTokens === right.reasoningTokens;

const markdownCode = (value: string): string => `\`${value.replaceAll("`", "\\`")}\``;

const describeCommandAction = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const type = readString(value, "type");
  if (type === "read") {
    const path = readString(value, "path") ?? readString(value, "name");
    return path === undefined ? undefined : `读取 ${markdownCode(path)}`;
  }
  if (type === "listFiles") {
    const path = readString(value, "path");
    if (path !== undefined) return `列出 ${markdownCode(path)} 中的文件`;
    const command = readString(value, "command");
    return command === undefined ? "列出文件" : `运行命令 ${markdownCode(command)}`;
  }
  if (type === "search") {
    const query = readString(value, "query");
    const path = readString(value, "path");
    if (query !== undefined && path !== undefined) {
      return `在 ${markdownCode(path)} 中搜索 ${markdownCode(query)}`;
    }
    if (query !== undefined) return `搜索 ${markdownCode(query)}`;
  }
  return undefined;
};

const describeProcessItem = (value: unknown): readonly string[] => {
  if (!isRecord(value)) return [];
  const type = readString(value, "type");
  if (type === "userMessage") {
    const hasImage =
      Array.isArray(value.content) &&
      value.content.some(
        (part) =>
          isRecord(part) &&
          (part.type === "image" ||
            part.type === "localImage" ||
            part.type === "input_image" ||
            part.type === "image_url"),
      );
    return hasImage ? ["读取图片内容"] : [];
  }
  if (type === "commandExecution") {
    const actions = Array.isArray(value.commandActions)
      ? value.commandActions.flatMap((action) => {
          const description = describeCommandAction(action);
          return description === undefined ? [] : [description];
        })
      : [];
    if (actions.length > 0) return actions;
    const command = readString(value, "command");
    return command === undefined ? [] : [`运行命令 ${markdownCode(command)}`];
  }
  if (type === "fileChange") {
    const paths = Array.isArray(value.changes)
      ? value.changes.flatMap((change) => {
          const path = readString(change, "path");
          return path === undefined ? [] : [markdownCode(path)];
        })
      : [];
    if (paths.length === 0) return ["编辑文件"];
    return [`编辑文件 ${paths.join("、")}`];
  }
  if (type === "webSearch") {
    const action = isRecord(value.action) ? value.action : undefined;
    const actionType = readString(action, "type");
    if (actionType === "openPage") {
      const url = readString(action, "url");
      return [url === undefined ? "打开网页" : `打开网页 ${markdownCode(url)}`];
    }
    if (actionType === "findInPage") {
      const pattern = readString(action, "pattern");
      return [pattern === undefined ? "在网页中查找" : `在网页中查找 ${markdownCode(pattern)}`];
    }
    const query = readString(value, "query") ?? readString(action, "query");
    return [query === undefined ? "搜索网页" : `搜索网页 ${markdownCode(query)}`];
  }
  if (type === "mcpToolCall") {
    const server = readString(value, "server");
    const tool = readString(value, "tool");
    const name = [server, tool].filter((part): part is string => part !== undefined).join("/");
    return [name === "" ? "调用 MCP 工具" : `调用 MCP 工具 ${markdownCode(name)}`];
  }
  if (type === "dynamicToolCall") {
    const namespace = readString(value, "namespace");
    const tool = readString(value, "tool");
    const name = [namespace, tool].filter((part): part is string => part !== undefined).join("/");
    return [name === "" ? "调用工具" : `调用工具 ${markdownCode(name)}`];
  }
  if (type === "imageView") {
    const path = readString(value, "path");
    return [path === undefined ? "查看图片" : `查看图片 ${markdownCode(path)}`];
  }
  if (type === "imageGeneration") return ["生成图片"];
  if (type === "contextCompaction") return ["上下文已自动压缩"];
  if (type === "sleep") {
    const durationMilliseconds = readNumber(value, "durationMs");
    return [
      durationMilliseconds === null ? "等待" : `等待 ${String(durationMilliseconds / 1_000)} 秒`,
    ];
  }
  return [];
};

const readWindow = (value: unknown): CodexRateLimitWindow | null => {
  const usedPercent = readNumber(value, "usedPercent");
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: readNumber(value, "windowDurationMins"),
    resetsAt: readNumber(value, "resetsAt"),
  };
};

const defaultServerRequest = async (
  request: JsonRpcServerRequest,
  reviewer: CodexAgentOptions["onApproval"],
): Promise<unknown> => {
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    const decision = reviewer === undefined ? "decline" : await reviewer(request);
    return { decision };
  }
  throw new TiduError(
    "CONFIGURATION_INVALID",
    `Unsupported Codex server request requires explicit handling: ${request.method}`,
  );
};

export const createCodexAgentClient = (options: CodexAgentOptions): CodexAgentClient => {
  const activeTurns = new Map<string, TurnState>();
  const startingTurns = new Set<{
    threadId: string;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>();
  const registrations = new Map<
    string,
    { threadId: string; ready: Promise<void>; resolve: () => void }
  >();
  const finishedTurns = new Set<string>();
  let connectionFailure: Error | undefined;
  const retireTurn = (turnId: string): void => {
    finishedTurns.add(turnId);
    bufferedTurnNotifications.delete(turnId);
    registrations.get(turnId)?.resolve();
    registrations.delete(turnId);
    if (finishedTurns.size > 256) {
      const oldest = finishedTurns.values().next().value;
      if (oldest !== undefined) finishedTurns.delete(oldest);
    }
  };
  const registerIncomingTurn = (turnId: string, threadId: string): void => {
    if (activeTurns.has(turnId) || finishedTurns.has(turnId) || registrations.has(turnId)) return;
    if (![...startingTurns].some((pending) => pending.threadId === threadId)) return;
    if (registrations.size >= startingTurns.size) {
      const error = new TiduError(
        "INTERNAL_ERROR",
        "Native notifications exceeded pending turn registrations.",
      );
      failActiveTurns(error);
      void client.close();
      return;
    }
    let resolve!: () => void;
    const ready = new Promise<void>((accept) => {
      resolve = accept;
    });
    registrations.set(turnId, { threadId, ready, resolve });
  };
  const yieldCallerTools = (state: TurnState): void => {
    setImmediate(() => {
      if (
        state.yielded ||
        !state.modelResponseCompleted ||
        state.toolCalls.length === 0 ||
        state.toolReplies.size === 0 ||
        activeTurns.get(state.turnId) !== state
      )
        return;
      state.yielded = true;
      state.cleanup();
      state.resolve({
        threadId: state.threadId,
        turnId: state.turnId,
        status: "completed",
        text: state.text,
        toolCalls: [...state.toolCalls],
        progressItems: [...state.progressItems],
        usage: state.usage,
      });
    });
  };
  const bufferedTurnNotifications = new Map<string, BufferedTurnNotifications>();
  const messagePhases = new Map<string, CodexMessagePhase>();
  const forwardedMessageText = new Map<string, string>();
  const forwardedProcessItems = new Set<string>();
  let initialized = false;
  const messagePhaseKey = (turnId: string, itemId: string): string => `${turnId}\u0000${itemId}`;

  const bufferTurnNotification = (
    turnId: string,
    update: (buffer: BufferedTurnNotifications) => void,
  ): void => {
    if (!registrations.has(turnId)) return;
    const buffer = bufferedTurnNotifications.get(turnId) ?? {
      notifications: [],
    };
    update(buffer);
    bufferedTurnNotifications.set(turnId, buffer);
  };

  const processDeltaSource = (itemKey: string): CodexProcessDeltaSource | undefined => {
    const typeSeparator = itemKey.indexOf(":");
    if (typeSeparator <= 0) return undefined;
    const type = itemKey.slice(0, typeSeparator);
    if (type !== "activity" && type !== "commentary" && type !== "reasoning") return undefined;
    const encodedItemId = itemKey.slice(typeSeparator + 1);
    const indexSeparator = type === "commentary" ? -1 : encodedItemId.lastIndexOf(":");
    const itemId = indexSeparator === -1 ? encodedItemId : encodedItemId.slice(0, indexSeparator);
    return itemId === ""
      ? undefined
      : {
          type,
          itemId,
          ...(type === "reasoning" && indexSeparator !== -1
            ? { summaryIndex: Number(encodedItemId.slice(indexSeparator + 1)) }
            : {}),
        };
  };

  const forwardProcessDelta = (
    turnId: string,
    itemKey: string,
    delta: string,
    separator = false,
  ): void => {
    const state = activeTurns.get(turnId);
    if (state === undefined) {
      bufferTurnNotification(turnId, (buffer) =>
        buffer.notifications.push({
          type: "process",
          itemKey,
          delta,
          separator,
        }),
      );
      return;
    }
    if (state.processItemKey !== undefined && state.processItemKey !== itemKey) {
      const source = processDeltaSource(state.processItemKey);
      state.onProcessDelta?.(
        "\n\n",
        source === undefined ? undefined : { ...source, separator: true },
      );
    }
    state.processItemKey = separator ? undefined : itemKey;
    const source = processDeltaSource(itemKey);
    state.onProcessDelta?.(
      delta,
      source === undefined || !separator ? source : { ...source, separator: true },
    );
  };

  const forwardProcessItem = (turnId: string, item: Record<string, unknown>): void => {
    const itemId = readString(item, "id");
    if (itemId === undefined) return;
    const processItemKey = `${turnId}\u0000${itemId}`;
    if (forwardedProcessItems.has(processItemKey)) return;
    const descriptions = describeProcessItem(item);
    if (descriptions.length === 0) return;
    forwardedProcessItems.add(processItemKey);
    descriptions.forEach((description, index) => {
      forwardProcessDelta(turnId, `activity:${itemId}:${String(index)}`, description);
    });
    // An observed activity is already a complete public record, even while its command runs.
    forwardProcessDelta(
      turnId,
      `activity:${itemId}:${String(descriptions.length - 1)}`,
      "\n\n",
      true,
    );
    const state = activeTurns.get(turnId);
    if (state !== undefined) state.processItemKey = undefined;
  };

  const clearTurnProcessItems = (turnId: string): void => {
    const prefix = `${turnId}\u0000`;
    for (const processItemKey of forwardedProcessItems) {
      if (processItemKey.startsWith(prefix)) forwardedProcessItems.delete(processItemKey);
    }
    for (const messageKey of forwardedMessageText.keys()) {
      if (messageKey.startsWith(prefix)) forwardedMessageText.delete(messageKey);
    }
    for (const phaseKey of messagePhases.keys()) {
      if (phaseKey.startsWith(prefix)) messagePhases.delete(phaseKey);
    }
  };

  const completeTurn = (
    completion: Omit<CodexTurnResult, "text" | "usage">,
    state: TurnState,
  ): void => {
    if (state.usageWaitTimer !== undefined) clearTimeout(state.usageWaitTimer);
    state.pendingCompletion = undefined;
    state.usageWaitTimer = undefined;
    activeTurns.delete(completion.turnId);
    retireTurn(completion.turnId);
    for (const reply of state.toolReplies.values())
      reply.reject(new Error("Native turn ended before tool completion."));
    state.toolReplies.clear();
    state.toolResults.clear();
    clearTurnProcessItems(completion.turnId);
    state.cleanup();
    state.resolve({
      ...completion,
      text: state.text,
      usage: state.usage,
      ...(state.toolCalls.length === 0 ? {} : { toolCalls: state.toolCalls }),
      ...(state.progressItems.length === 0 ? {} : { progressItems: state.progressItems }),
    });
  };

  const scheduleTurnCompletion = (
    completion: Omit<CodexTurnResult, "text" | "usage">,
    state: TurnState,
  ): void => {
    if (state.hasTurnAggregateUsage) {
      completeTurn(completion, state);
      return;
    }
    state.pendingCompletion = completion;
    state.usageWaitTimer = setTimeout(() => {
      if (activeTurns.get(completion.turnId) === state) completeTurn(completion, state);
    }, 25);
  };

  const updateTurnUsage = (
    turnId: string,
    usage: NonNullable<CodexTurnResult["usage"]>,
    turnAggregate: boolean,
  ): void => {
    const state = activeTurns.get(turnId);
    if (state === undefined) {
      bufferTurnNotification(turnId, (buffer) => {
        if (buffer.hasTurnAggregateUsage === true && !turnAggregate) return;
        buffer.usage = usage;
        buffer.hasTurnAggregateUsage = turnAggregate;
      });
      return;
    }
    if (!state.hasTurnAggregateUsage || turnAggregate) {
      const usageChanged = !tokenUsageMatches(state.usage, usage);
      state.usage = usage;
      if (usageChanged) state.onUsageUpdate?.(usage);
    }
    if (turnAggregate) state.hasTurnAggregateUsage = true;
    if (state.pendingCompletion !== undefined && state.hasTurnAggregateUsage) {
      completeTurn(state.pendingCompletion, state);
    }
  };

  const onNotification = (notification: JsonRpcNotification): void => {
    options.onEvent?.(notification);
    const turnId = readString(notification.params, "turnId");
    const incomingTurnId =
      turnId ??
      (isRecord(notification.params) ? readString(notification.params.turn, "id") : undefined);
    const incomingThreadId = readString(notification.params, "threadId");
    if (incomingTurnId !== undefined) {
      if (finishedTurns.has(incomingTurnId)) return;
      // History injection also emits raw items with non-running turn IDs; only a native lifecycle start claims a registration.
      if (notification.method === "turn/started" && incomingThreadId !== undefined)
        registerIncomingTurn(incomingTurnId, incomingThreadId);
    }
    if (
      notification.method === "rawResponseItem/completed" &&
      turnId !== undefined &&
      isRecord(notification.params) &&
      isRecord(notification.params.item)
    ) {
      const item = notification.params.item;
      if (
        item.type === "function_call" &&
        typeof item.call_id === "string" &&
        typeof item.name === "string" &&
        typeof item.arguments === "string"
      ) {
        const state = activeTurns.get(turnId);
        try {
          const call = {
            callId: item.call_id,
            tool: item.name,
            namespace: readString(item, "namespace") ?? null,
            arguments: JSON.parse(item.arguments) as unknown,
          };
          if (state !== undefined) {
            if (
              !state.resumes.has(call.callId) &&
              !state.toolCalls.some((existing) => existing.callId === call.callId)
            )
              state.toolCalls.push(call);
          } else
            bufferTurnNotification(turnId, (buffer) =>
              buffer.notifications.push({ type: "tool", call }),
            );
        } catch {
          /* The official tool handler reports malformed arguments as a failure. */
        }
      }
      if (
        item.type === "reasoning" ||
        item.type === "web_search_call" ||
        (item.type === "message" && item.phase === "commentary")
      ) {
        const state = activeTurns.get(turnId);
        if (state !== undefined) {
          state.progressItems.push(item);
          state.onNativeItem?.(item);
        } else
          bufferTurnNotification(turnId, (buffer) => {
            buffer.notifications.push({ type: "native", item });
          });
      }
      return;
    }
    if (
      notification.method === "item/started" &&
      turnId !== undefined &&
      isRecord(notification.params) &&
      isRecord(notification.params.item)
    ) {
      const item = notification.params.item;
      if (item.type === "agentMessage") {
        const itemId = readString(item, "id");
        const phase = readString(item, "phase");
        if (itemId !== undefined && phase !== undefined && phase !== "") {
          messagePhases.set(messagePhaseKey(turnId, itemId), phase);
        }
      } else {
        forwardProcessItem(turnId, item);
      }
      return;
    }
    if (
      notification.method === "rawResponse/completed" &&
      turnId !== undefined &&
      isRecord(notification.params)
    ) {
      const state = activeTurns.get(turnId);
      if (state !== undefined) state.hasTurnAggregateUsage = false;
      else {
        const buffered = bufferedTurnNotifications.get(turnId);
        if (buffered !== undefined) buffered.hasTurnAggregateUsage = false;
      }
      const usage = readTurnTokenUsage(notification.params.usage);
      if (usage !== null) updateTurnUsage(turnId, usage, false);
      if (state !== undefined) {
        state.modelResponseCompleted = true;
        yieldCallerTools(state);
        state.responseWaiters.splice(0).forEach((resolve) => {
          resolve();
        });
      } else
        bufferTurnNotification(turnId, (buffer) => {
          buffer.modelResponseCompleted = true;
        });
      return;
    }
    if (
      notification.method === "thread/tokenUsage/updated" &&
      turnId !== undefined &&
      isRecord(notification.params) &&
      isRecord(notification.params.tokenUsage)
    ) {
      const tokenUsage = notification.params.tokenUsage;
      const last = isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage.total;
      const usage = readTurnTokenUsage(last);
      if (usage !== null) updateTurnUsage(turnId, usage, true);
      return;
    }
    if (notification.method === "item/agentMessage/delta" && turnId !== undefined) {
      const state = activeTurns.get(turnId);
      const delta = readString(notification.params, "delta");
      const itemId = readString(notification.params, "itemId");
      const phase =
        itemId === undefined ? undefined : messagePhases.get(messagePhaseKey(turnId, itemId));
      if (itemId !== undefined && delta !== undefined) {
        const messageKey = `${turnId}\u0000${itemId}`;
        forwardedMessageText.set(
          messageKey,
          `${forwardedMessageText.get(messageKey) ?? ""}${delta}`,
        );
      }
      if (delta !== undefined && phase === "commentary") {
        forwardProcessDelta(turnId, `commentary:${itemId ?? "unknown"}`, delta);
      } else if (state !== undefined && delta !== undefined) {
        state.text += delta;
        state.onTextDelta?.(delta);
      } else if (delta !== undefined) {
        bufferTurnNotification(turnId, (buffer) =>
          buffer.notifications.push({ type: "text", delta }),
        );
      }
      return;
    }
    if (notification.method === "item/reasoning/summaryTextDelta" && turnId !== undefined) {
      const delta = readString(notification.params, "delta");
      if (delta !== undefined) {
        const itemId = readString(notification.params, "itemId") ?? "unknown";
        const summaryIndex = readNumber(notification.params, "summaryIndex") ?? 0;
        forwardProcessDelta(turnId, `reasoning:${itemId}:${summaryIndex}`, delta);
      }
      return;
    }
    if (
      notification.method === "item/completed" &&
      turnId !== undefined &&
      isRecord(notification.params) &&
      isRecord(notification.params.item)
    ) {
      const item = notification.params.item;
      const itemId = readString(item, "id");
      const state = activeTurns.get(turnId);
      if (item.type === "agentMessage" && itemId !== undefined) {
        const messageKey = `${turnId}\u0000${itemId}`;
        const forwarded = forwardedMessageText.get(messageKey) ?? "";
        const text = readString(item, "text") ?? "";
        const trailing = text.startsWith(forwarded) ? text.slice(forwarded.length) : "";
        if (trailing !== "") {
          if (readString(item, "phase") === "commentary")
            forwardProcessDelta(turnId, `commentary:${itemId}`, trailing);
          else if (state !== undefined) {
            state.text += trailing;
            state.onTextDelta?.(trailing);
          } else
            bufferTurnNotification(turnId, (buffer) => {
              buffer.notifications.push({ type: "text", delta: trailing });
            });
        }
        forwardedMessageText.delete(messageKey);
      }
      if (
        itemId !== undefined &&
        (state?.processItemKey?.startsWith(`reasoning:${itemId}:`) ||
          state?.processItemKey === `commentary:${itemId}`)
      ) {
        forwardProcessDelta(turnId, state.processItemKey, "\n\n", true);
      }
      if (itemId !== undefined) messagePhases.delete(messagePhaseKey(turnId, itemId));
      forwardProcessItem(turnId, item);
      return;
    }
    if (notification.method !== "turn/completed" || !isRecord(notification.params)) {
      return;
    }
    const threadId = readString(notification.params, "threadId");
    const turn = notification.params.turn;
    if (threadId === undefined || !isRecord(turn)) {
      return;
    }
    const completedTurnId = readString(turn, "id");
    const status = readString(turn, "status");
    if (
      completedTurnId === undefined ||
      (status !== "completed" && status !== "failed" && status !== "interrupted")
    ) {
      return;
    }
    const message = readString(turn.error, "message");
    const completion = {
      threadId,
      turnId: completedTurnId,
      status,
      ...(message === undefined
        ? {}
        : {
            error: {
              message,
              codexErrorInfo: isRecord(turn.error) ? turn.error.codexErrorInfo : undefined,
            },
          }),
    } satisfies Omit<CodexTurnResult, "text" | "usage">;
    const state = activeTurns.get(completedTurnId);
    if (state === undefined) {
      bufferTurnNotification(completedTurnId, (buffer) => {
        buffer.completion = completion;
      });
      return;
    }
    scheduleTurnCompletion(completion, state);
  };

  const failActiveTurns = (error: Error): void => {
    connectionFailure = error;
    for (const state of activeTurns.values()) {
      if (state.usageWaitTimer !== undefined) clearTimeout(state.usageWaitTimer);
      state.cleanup();
      for (const reply of state.toolReplies.values()) reply.reject(error);
      state.toolReplies.clear();
      state.toolResults.clear();
      state.reject(error);
    }
    activeTurns.clear();
    for (const pending of startingTurns) {
      pending.cleanup();
      pending.reject(error);
    }
    startingTurns.clear();
    for (const registration of registrations.values()) registration.resolve();
    registrations.clear();
    bufferedTurnNotifications.clear();
    messagePhases.clear();
    forwardedMessageText.clear();
    forwardedProcessItems.clear();
  };
  const handlers: JsonRpcClientOptions = {
    onNotification,
    onRequest: async (request) => {
      if (request.method !== "item/tool/call")
        return defaultServerRequest(request, options.onApproval);
      await Promise.resolve();
      const params = request.params;
      const turnId = readString(params, "turnId");
      const threadId = readString(params, "threadId");
      const callId = readString(params, "callId");
      const tool = readString(params, "tool");
      if (turnId !== undefined && threadId !== undefined && !activeTurns.has(turnId)) {
        registerIncomingTurn(turnId, threadId);
        await registrations.get(turnId)?.ready;
      }
      const state = turnId === undefined ? undefined : activeTurns.get(turnId);
      if (
        state === undefined ||
        state.threadId !== threadId ||
        threadId === undefined ||
        callId === undefined ||
        tool === undefined ||
        !isRecord(params)
      ) {
        throw new TiduError("INTERNAL_ERROR", "Invalid caller tool request from Codex.");
      }
      const completed = state.toolResults.get(callId);
      if (completed !== undefined) {
        state.toolResults.delete(callId);
        return completed;
      }
      if (!state.resumes.has(callId) && !state.toolCalls.some((call) => call.callId === callId))
        state.toolCalls.push({
          callId,
          tool,
          namespace: readString(params, "namespace") ?? null,
          arguments: params.arguments,
        });
      return new Promise<CodexToolReply>((resolve, reject) => {
        state.toolReplies.set(callId, { resolve, reject });
        yieldCallerTools(state);
      });
    },
    onClose: failActiveTurns,
  };
  const client: JsonRpcClient =
    options.transportFactory === undefined
      ? createStdioJsonRpcClient(
          { ...createCodexAppServerLaunch(options), workingDirectory: options.workingDirectory },
          handlers,
        )
      : options.transportFactory(handlers);

  const requireInitialized = (): void => {
    if (connectionFailure !== undefined) throw connectionFailure;
    if (!initialized) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Codex app-server is not initialized.");
    }
  };

  return {
    initialize: async (): Promise<void> => {
      if (initialized) {
        return;
      }
      await client.request("initialize", {
        clientInfo: {
          name: "ai_tidu9",
          title: "九门赛博提督",
          version: "0.2.0-alpha.1",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      });
      client.notify("initialized");
      initialized = true;
    },
    startThread: async (
      modelOverride?: string,
      callerTools?: readonly Record<string, unknown>[],
      webSearchMode: "disabled" | "cached" | "live" = "disabled",
    ): Promise<CodexThread> => {
      requireInitialized();
      const requestedModel = modelOverride ?? options.model;
      const response = await client.request<Record<string, unknown>>("thread/start", {
        cwd: options.workingDirectory,
        model: requestedModel ?? null,
        approvalPolicy: "on-request",
        sandbox: options.sandbox ?? "workspace-write",
        ephemeral: options.ephemeral ?? false,
        ...(callerTools === undefined
          ? {}
          : {
              dynamicTools: callerTools,
              experimentalRawEvents: true,
              developerInstructions:
                "Use the registered tidu_caller_tool_* tools to carry out the user's task, including reading workspace files, running commands, editing files, and verifying changes when those tools are available. Each tool description identifies its original caller name. These are executable tools: the calling client performs each requested action in its workspace under its current permissions, sandbox, and approval rules, then returns the real result. Request the registered alias instead of the original name. The inference process's local tools are disabled because execution belongs to the calling client; this does not prohibit using the registered tools. Report a permission restriction only when the caller's current policy or a real tool result establishes it.",
              config: {
                "features.shell_tool": false,
                "features.apply_patch_freeform": false,
                "features.view_image": false,
                "features.multi_agent": false,
                "features.multi_agent_v2": false,
                "features.goals": false,
                "features.apps": false,
                "agents.enabled": false,
                web_search: webSearchMode,
              },
            }),
      });
      const thread = response.thread;
      const id = readString(thread, "id");
      const model =
        readString(response, "model") ?? readString(thread, "model") ?? requestedModel ?? undefined;
      if (id === undefined) {
        throw new TiduError("INTERNAL_ERROR", "Codex returned an invalid thread response.");
      }
      if (model === undefined || model.trim() === "") {
        throw new TiduError(
          "INTERNAL_ERROR",
          "Codex did not report the active model configuration.",
        );
      }
      return { id, model };
    },
    readAccount: async (): Promise<CodexAccountSummary | null> => {
      requireInitialized();
      const response = await client.request<Record<string, unknown>>("account/read", {
        refreshToken: false,
      });
      if (!isRecord(response.account)) return null;
      const account = response.account;
      const accountType = readString(account, "type");
      const type =
        accountType === "chatgpt" || accountType === "apiKey" || accountType === "amazonBedrock"
          ? accountType
          : "unknown";
      return {
        type,
        email: type === "chatgpt" ? (readString(account, "email") ?? null) : null,
        plan: type === "chatgpt" ? (readString(account, "planType") ?? null) : null,
      };
    },
    readUsage: async (): Promise<CodexUsageSummary> => {
      requireInitialized();
      const [limitsResult, usageResult] = await Promise.allSettled([
        client.request<Record<string, unknown>>("account/rateLimits/read", undefined),
        client.request<Record<string, unknown>>("account/usage/read", undefined),
      ]);
      if (limitsResult.status === "rejected" && usageResult.status === "rejected") {
        throw limitsResult.reason;
      }
      const limits = limitsResult.status === "fulfilled" ? limitsResult.value : {};
      const usage = usageResult.status === "fulfilled" ? usageResult.value : {};
      const byId = isRecord(limits.rateLimitsByLimitId)
        ? limits.rateLimitsByLimitId.codex
        : undefined;
      const snapshot = isRecord(byId) ? byId : limits.rateLimits;
      const resetCredits = limits.rateLimitResetCredits;
      const buckets = Array.isArray(usage.dailyUsageBuckets)
        ? usage.dailyUsageBuckets
            .filter(isRecord)
            .map((bucket) => ({
              date: readString(bucket, "startDate") ?? "",
              tokens: readNumber(bucket, "tokens"),
            }))
            .filter(
              (bucket): bucket is { date: string; tokens: number } =>
                bucket.date !== "" && bucket.tokens !== null,
            )
        : [];
      return {
        limitId: readString(snapshot, "limitId") ?? null,
        primary: readWindow(isRecord(snapshot) ? snapshot.primary : null),
        secondary: readWindow(isRecord(snapshot) ? snapshot.secondary : null),
        creditBalance: readString(isRecord(snapshot) ? snapshot.credits : null, "balance") ?? null,
        availableResetCredits: readNumber(resetCredits, "availableCount"),
        lifetimeTokens: readNumber(usage.summary, "lifetimeTokens"),
        dailyTokens: buckets,
      };
    },
    prompt: async (
      threadId: string,
      input: readonly CodexTurnInput[],
      signal?: AbortSignal,
      onTextDelta?: (delta: string) => void,
      reasoningEffort?: CodexReasoningEffort,
      onProcessDelta?: (delta: string, source?: CodexProcessDeltaSource) => void,
      historyItems: readonly Record<string, unknown>[] = [],
      outputSchema?: Record<string, unknown>,
      onUsageUpdate?: (usage: NonNullable<CodexTurnResult["usage"]>) => void,
      reasoningSummary: CodexReasoningSummary = "auto",
      onNativeItem?: (item: Record<string, unknown>) => void,
    ): Promise<CodexTurnResult> => {
      requireInitialized();
      const outputsById = new Map<string, Record<string, unknown>>();
      const outputTypes = new Set([
        "function_call_output",
        "custom_tool_call_output",
        "tool_search_output",
      ]);
      for (const item of historyItems) {
        if (!outputTypes.has(String(item.type))) continue;
        if (typeof item.call_id !== "string") {
          if (
            item.type !== "function_call_output" ||
            typeof item.name !== "string" ||
            item.name.trim() === ""
          )
            throw new TiduError(
              "CONFIGURATION_INVALID",
              "Standalone caller results require their original function name.",
            );
          continue;
        }
        const previous = outputsById.get(item.call_id);
        if (previous !== undefined && callerPayloadKey(previous) !== callerPayloadKey(item))
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "Conflicting caller results use the same call ID.",
          );
        outputsById.set(item.call_id, item);
      }
      const outputs = [...outputsById.values()];
      const context = historyItems.filter(
        (item) => !outputTypes.has(String(item.type)) || typeof item.call_id !== "string",
      );
      const key = callerPayloadKey({
        input,
        outputs: [...outputs].sort((left, right) =>
          String(left.call_id).localeCompare(String(right.call_id)),
        ),
        context,
        reasoningEffort,
        outputSchema,
        reasoningSummary,
      });
      const threadStates = [...activeTurns.values()].filter((state) => state.threadId === threadId);
      const claims = new Set(
        threadStates.flatMap((state) =>
          outputs.flatMap((item) => {
            const claimed = state.resumes.get(String(item.call_id));
            return claimed === undefined ? [] : [claimed];
          }),
        ),
      );
      if (claims.size > 1)
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          "Caller results belong to different batches.",
        );
      const previousClaim = [...claims][0];
      if (previousClaim !== undefined) {
        if (
          previousClaim.key !== key &&
          (!previousClaim.failed || previousClaim.steered || previousClaim.injected)
        )
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "Caller results conflict with a batch already being resumed.",
          );
        if (!previousClaim.failed) return previousClaim.promise;
      }
      const pending = threadStates.find(
        (state) =>
          state.yielded &&
          outputs.some((item) => state.toolCalls.some((call) => call.callId === item.call_id)),
      );
      if (pending !== undefined) {
        const matched = outputsById;
        if (
          matched.size !== pending.toolCalls.length ||
          !pending.toolCalls.every((call) => matched.has(call.callId))
        )
          throw new TiduError(
            "CONFIGURATION_INVALID",
            "All pending caller tool results are required, without results from other batches.",
          );
        const replies = [...matched].map(([callId, item]) => {
          const output =
            item.type === "tool_search_output" ? JSON.stringify(item.tools ?? []) : item.output;
          const contentItems: CodexToolReply["contentItems"] = Array.isArray(output)
            ? output.map((part: unknown) => {
                if (
                  isRecord(part) &&
                  part.type === "input_image" &&
                  typeof part.image_url === "string"
                )
                  return {
                    type: "inputImage" as const,
                    imageUrl: part.image_url,
                  };
                if (
                  isRecord(part) &&
                  part.type === "input_audio" &&
                  typeof part.audio_url === "string"
                )
                  return {
                    type: "inputAudio" as const,
                    audioUrl: part.audio_url,
                  };
                return {
                  type: "inputText" as const,
                  text:
                    isRecord(part) && typeof part.text === "string"
                      ? part.text
                      : JSON.stringify(part),
                };
              })
            : [
                {
                  type: "inputText",
                  text: typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
                },
              ];
          return {
            callId,
            value: { contentItems, success: item.is_error !== true },
          };
        });
        const snapshot = { ...pending };
        let accept!: (result: CodexTurnResult) => void;
        let decline!: (error: Error) => void;
        const promise = new Promise<CodexTurnResult>((resolve, reject) => {
          accept = resolve;
          decline = reject;
        });
        const claim: CallerResume = {
          key,
          promise,
          steered: previousClaim?.key === key && previousClaim.steered === true,
          injected: previousClaim?.key === key && previousClaim.injected === true,
        };
        const abort = (): void => {
          if (activeTurns.get(pending.turnId) !== pending) return;
          activeTurns.delete(pending.turnId);
          retireTurn(pending.turnId);
          clearTurnProcessItems(pending.turnId);
          if (pending.usageWaitTimer !== undefined) clearTimeout(pending.usageWaitTimer);
          pending.cleanup();
          const error = new DOMException("Codex turn cancelled.", "AbortError");
          for (const reply of pending.toolReplies.values()) reply.reject(error);
          pending.toolReplies.clear();
          pending.toolResults.clear();
          void client
            .request("turn/interrupt", { threadId, turnId: pending.turnId })
            .catch(() => undefined);
          decline(error);
        };
        pending.cleanup();
        Object.assign(pending, {
          resolve: accept,
          reject: decline,
          text: "",
          toolCalls: [],
          progressItems: [],
          usage: null,
          yielded: false,
          modelResponseCompleted: false,
          hasTurnAggregateUsage: false,
          processItemKey: undefined,
          onTextDelta,
          onProcessDelta,
          onNativeItem,
          onUsageUpdate,
          cleanup: () => signal?.removeEventListener("abort", abort),
        });
        for (const call of snapshot.toolCalls) pending.resumes.set(call.callId, claim);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return promise;
        }
        void (async () => {
          if (input.length > 0 && !claim.steered) {
            await client.request(
              "turn/steer",
              { threadId, expectedTurnId: pending.turnId, input },
              signal,
            );
            claim.steered = true;
          }
          if (activeTurns.get(pending.turnId) !== pending) return;
          if (context.length > 0 && !claim.injected) {
            await client.request("thread/inject_items", { threadId, items: context }, signal);
            claim.injected = true;
          }
          if (activeTurns.get(pending.turnId) !== pending) return;
          for (const { callId, value } of replies) {
            const reply = pending.toolReplies.get(callId);
            if (reply === undefined) pending.toolResults.set(callId, value);
            else {
              pending.toolReplies.delete(callId);
              reply.resolve(value);
            }
          }
        })().catch((error: Error) => {
          if (activeTurns.get(pending.turnId) !== pending) return;
          pending.cleanup();
          Object.assign(pending, snapshot);
          claim.failed = true;
          decline(error);
        });
        return promise;
      }
      if (threadStates.length > 0)
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          "The native thread already has an active turn; caller results must match its pending batch.",
        );
      if (
        outputs.some(
          (output) =>
            !historyItems.some(
              (item) =>
                item.call_id === output.call_id &&
                ["function_call", "custom_tool_call", "tool_search_call"].includes(
                  String(item.type),
                ),
            ),
        )
      )
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          "Caller tool results require their matching calls in the supplied history.",
        );
      // An idle thread can sample restored history without adding another user message.
      if (
        (input.length === 0 && historyItems.length === 0) ||
        (input.length > 0 && input.every((item) => item.type === "text" && item.text.trim() === ""))
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Codex turn input cannot be empty.");
      }
      if (historyItems.length > 0) {
        await client.request("thread/inject_items", { threadId, items: historyItems }, signal);
      }
      if (signal?.aborted) throw new DOMException("Codex turn cancelled.", "AbortError");
      return new Promise<CodexTurnResult>((resolve, reject) => {
        let cancelled = false;
        let registeredState: TurnState | undefined;
        const abort = (): void => {
          cancelled = true;
          const active = registeredState;
          if (active !== undefined && activeTurns.get(active.turnId) === active) {
            activeTurns.delete(active.turnId);
            retireTurn(active.turnId);
            clearTurnProcessItems(active.turnId);
            if (active.usageWaitTimer !== undefined) clearTimeout(active.usageWaitTimer);
            active.cleanup();
            for (const reply of active.toolReplies.values())
              reply.reject(new DOMException("Codex turn cancelled.", "AbortError"));
            active.toolReplies.clear();
            active.toolResults.clear();
            void client
              .request("turn/interrupt", { threadId, turnId: active.turnId })
              .catch(() => undefined);
          }
          reject(new DOMException("Codex turn cancelled.", "AbortError"));
        };
        const pendingStart = {
          threadId,
          reject,
          cleanup: () => signal?.removeEventListener("abort", abort),
        };
        startingTurns.add(pendingStart);
        signal?.addEventListener("abort", abort, { once: true });
        // Keep observing the native acknowledgement after local cancellation so its turn can be interrupted.
        void client
          .request<Record<string, unknown>>("turn/start", {
            threadId,
            input,
            approvalPolicy: "on-request",
            effort: reasoningEffort ?? options.reasoningEffort ?? null,
            summary: reasoningSummary,
            outputSchema: outputSchema ?? null,
          })
          .then((response) => {
            const turnId = readString(response.turn, "id");
            if (turnId === undefined)
              throw new TiduError("INTERNAL_ERROR", "Codex returned an invalid turn response.");
            if (cancelled || connectionFailure !== undefined) {
              retireTurn(turnId);
              void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
              return;
            }
            const state: TurnState = {
              threadId,
              turnId,
              yielded: false,
              resumes: new Map(),
              toolReplies: new Map(),
              toolResults: new Map(),
              modelResponseCompleted: false,
              responseWaiters: [],
              progressItems: [],
              onNativeItem,
              toolCalls: [],
              text: "",
              resolve,
              reject,
              cleanup: () => {
                signal?.removeEventListener("abort", abort);
                state.responseWaiters.splice(0).forEach((resolve) => {
                  resolve();
                });
              },
              onTextDelta,
              onProcessDelta,
              usage: null,
              hasTurnAggregateUsage: false,
              onUsageUpdate,
            };
            registeredState = state;
            activeTurns.set(turnId, state);
            registrations.get(turnId)?.resolve();
            registrations.delete(turnId);
            if (signal?.aborted) {
              abort();
              return;
            }
            const buffered = bufferedTurnNotifications.get(turnId);
            if (buffered === undefined) return;
            bufferedTurnNotifications.delete(turnId);
            state.modelResponseCompleted = buffered.modelResponseCompleted === true;
            for (const notification of buffered.notifications) {
              if (notification.type === "native") {
                state.progressItems.push(notification.item);
                state.onNativeItem?.(notification.item);
              } else if (notification.type === "text") {
                state.text += notification.delta;
                state.onTextDelta?.(notification.delta);
              } else if (notification.type === "tool") {
                if (!state.toolCalls.some((call) => call.callId === notification.call.callId))
                  state.toolCalls.push(notification.call);
              } else {
                forwardProcessDelta(
                  turnId,
                  notification.itemKey,
                  notification.delta,
                  notification.separator,
                );
              }
            }
            if (buffered.usage !== undefined) {
              state.usage = buffered.usage;
              state.hasTurnAggregateUsage = buffered.hasTurnAggregateUsage === true;
              state.onUsageUpdate?.(buffered.usage);
            }
            if (buffered.completion !== undefined)
              scheduleTurnCompletion(buffered.completion, state);
          })
          .catch((error: Error) => {
            pendingStart.cleanup();
            reject(error);
          })
          .finally(() => {
            startingTurns.delete(pendingStart);
            if (registeredState === undefined) pendingStart.cleanup();
            if (![...startingTurns].some((pending) => pending.threadId === threadId)) {
              for (const [turnId, registration] of registrations) {
                if (registration.threadId !== threadId) continue;
                registration.resolve();
                registrations.delete(turnId);
                bufferedTurnNotifications.delete(turnId);
              }
            }
          });
      });
    },
    cancel: async (threadId: string, turnId: string): Promise<void> => {
      requireInitialized();
      await client.request("turn/interrupt", { threadId, turnId });
    },
    close: async (): Promise<void> => {
      failActiveTurns(new TiduError("INTERNAL_ERROR", "Codex connection closed."));
      await client.close();
    },
  };
};

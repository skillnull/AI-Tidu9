import {
  type CodexHostInspectionOptions,
  createCodexAppServerLaunch,
} from "../accounts/codex-host.js";
import { TiduError } from "../core/index.js";
import {
  createStdioJsonRpcClient,
  type JsonRpcClient,
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
    onProcessDelta?: (delta: string) => void,
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
  /** Whether the current model response reached its official completion boundary. */
  modelResponseCompleted: boolean;
  /** Dynamic requests waiting for the complete model response and its usage. */
  responseWaiters: Array<() => void>;
  /** One shared interruption after all model-emitted calls have been collected. */
  toolInterruption?: Promise<unknown>;
  /** Streams completed native progress before subsequent text or tool requests. */
  onNativeItem?: (item: Record<string, unknown>) => void;
  /** Completed model items that can be durably forwarded without flattening their phase. */
  progressItems: Record<string, unknown>[];
  /** Caller-owned tool requests captured before interrupting delegated execution. */
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
  onProcessDelta?: (delta: string) => void;
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

interface BufferedTurnNotifications {
  /** A model response boundary received before local turn registration. */
  modelResponseCompleted?: boolean;
  /** Native progress completed before the turn-start response was registered. */
  nativeItems?: Record<string, unknown>[];
  /** Text deltas received before the turn was registered locally. */
  deltas: string[];
  /** Public process deltas received before the turn was registered locally. */
  processDeltas: Array<{ itemKey: string; delta: string }>;
  /** Terminal result received before the turn was registered locally. */
  completion?: Omit<CodexTurnResult, "text" | "usage">;
  /** Token usage received before the turn was registered locally. */
  usage?: NonNullable<CodexTurnResult["usage"]>;
  /** Whether buffered usage is the authoritative turn aggregate. */
  hasTurnAggregateUsage?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  const bufferedTurnNotifications = new Map<string, BufferedTurnNotifications>();
  const messagePhases = new Map<string, CodexMessagePhase>();
  const forwardedMessageText = new Map<string, string>();
  const forwardedProcessItems = new Set<string>();
  let initialized = false;

  const bufferTurnNotification = (
    turnId: string,
    update: (buffer: BufferedTurnNotifications) => void,
  ): void => {
    const buffer = bufferedTurnNotifications.get(turnId) ?? {
      deltas: [],
      processDeltas: [],
    };
    update(buffer);
    bufferedTurnNotifications.set(turnId, buffer);
    if (bufferedTurnNotifications.size > 32) {
      const oldestTurnId = bufferedTurnNotifications.keys().next().value;
      if (oldestTurnId !== undefined) bufferedTurnNotifications.delete(oldestTurnId);
    }
  };

  const forwardProcessDelta = (turnId: string, itemKey: string, delta: string): void => {
    const state = activeTurns.get(turnId);
    if (state === undefined) {
      bufferTurnNotification(turnId, (buffer) => buffer.processDeltas.push({ itemKey, delta }));
      return;
    }
    if (state.processItemKey !== undefined && state.processItemKey !== itemKey) {
      state.onProcessDelta?.("\n\n");
    }
    state.processItemKey = delta === "\n\n" ? undefined : itemKey;
    state.onProcessDelta?.(delta);
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
    forwardProcessDelta(turnId, `activity:${itemId}:${String(descriptions.length - 1)}`, "\n\n");
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
  };

  const completeTurn = (
    completion: Omit<CodexTurnResult, "text" | "usage">,
    state: TurnState,
  ): void => {
    if (state.usageWaitTimer !== undefined) clearTimeout(state.usageWaitTimer);
    state.pendingCompletion = undefined;
    state.usageWaitTimer = undefined;
    activeTurns.delete(completion.turnId);
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
        if (turnAggregate) buffer.modelResponseCompleted = true;
      });
      return;
    }
    if (!state.hasTurnAggregateUsage || turnAggregate) {
      const usageChanged = !tokenUsageMatches(state.usage, usage);
      state.usage = usage;
      if (usageChanged) state.onUsageUpdate?.(usage);
    }
    if (turnAggregate) state.hasTurnAggregateUsage = true;
    if (turnAggregate) {
      state.modelResponseCompleted = true;
      state.responseWaiters.splice(0).forEach((resolve) => {
        resolve();
      });
    }
    if (state.pendingCompletion !== undefined && state.hasTurnAggregateUsage) {
      completeTurn(state.pendingCompletion, state);
    }
  };

  const onNotification = (notification: JsonRpcNotification): void => {
    options.onEvent?.(notification);
    const turnId = readString(notification.params, "turnId");
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
        if (state !== undefined && !state.toolCalls.some((call) => call.callId === item.call_id)) {
          try {
            state.toolCalls.push({
              callId: item.call_id,
              tool: item.name,
              namespace: readString(item, "namespace") ?? null,
              arguments: JSON.parse(item.arguments) as unknown,
            });
          } catch {
            /* The official tool handler reports malformed arguments as a failure. */
          }
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
            buffer.nativeItems ??= [];
            buffer.nativeItems.push(item);
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
          messagePhases.set(itemId, phase);
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
      const usage = readTurnTokenUsage(notification.params.usage);
      if (usage !== null) updateTurnUsage(turnId, usage, false);
      const state = activeTurns.get(turnId);
      if (state !== undefined) {
        state.modelResponseCompleted = true;
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
      const phase = itemId === undefined ? undefined : messagePhases.get(itemId);
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
        bufferTurnNotification(turnId, (buffer) => buffer.deltas.push(delta));
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
              buffer.deltas.push(trailing);
            });
        }
        forwardedMessageText.delete(messageKey);
      }
      if (
        itemId !== undefined &&
        (state?.processItemKey?.startsWith(`reasoning:${itemId}:`) ||
          state?.processItemKey === `commentary:${itemId}`)
      ) {
        state.onProcessDelta?.("\n\n");
        state.processItemKey = undefined;
      }
      if (itemId !== undefined) messagePhases.delete(itemId);
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
    const state = activeTurns.get(completedTurnId);
    if (state === undefined) {
      bufferTurnNotification(completedTurnId, (buffer) => {
        buffer.completion = { threadId, turnId: completedTurnId, status };
      });
      return;
    }
    scheduleTurnCompletion({ threadId, turnId: completedTurnId, status }, state);
  };

  const launch = createCodexAppServerLaunch(options);
  const failActiveTurns = (error: Error): void => {
    for (const state of activeTurns.values()) {
      if (state.usageWaitTimer !== undefined) clearTimeout(state.usageWaitTimer);
      state.cleanup();
      state.reject(error);
    }
    activeTurns.clear();
    bufferedTurnNotifications.clear();
    messagePhases.clear();
    forwardedMessageText.clear();
    forwardedProcessItems.clear();
  };
  const client: JsonRpcClient = createStdioJsonRpcClient(
    { ...launch, workingDirectory: options.workingDirectory },
    {
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
        const state = turnId === undefined ? undefined : activeTurns.get(turnId);
        if (
          state === undefined ||
          threadId === undefined ||
          callId === undefined ||
          tool === undefined ||
          !isRecord(params)
        ) {
          throw new TiduError("INTERNAL_ERROR", "Invalid caller tool request from Codex.");
        }
        if (!state.toolCalls.some((call) => call.callId === callId))
          state.toolCalls.push({
            callId,
            tool,
            namespace: readString(params, "namespace") ?? null,
            arguments: params.arguments,
          });
        // Yield the request to the caller. Never acknowledge it as executed or run it here.
        if (!state.modelResponseCompleted)
          await new Promise<void>((resolve) => {
            state.responseWaiters.push(resolve);
          });
        if (activeTurns.get(turnId as string) !== state)
          return { contentItems: [], success: false };
        state.toolInterruption ??= client.request("turn/interrupt", { threadId, turnId });
        await state.toolInterruption;
        return { contentItems: [], success: false };
      },
      onClose: failActiveTurns,
    },
  );

  const requireInitialized = (): void => {
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
                "Tools belong to the calling client. Use only the registered tidu_caller_tool_* names; their descriptions identify the original caller tools. The client executes them under its own permissions and returns real results. Do not invoke the original tool names or execute commands or edit files in this delegated thread.",
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
      const [limits, usage] = await Promise.all([
        client.request<Record<string, unknown>>("account/rateLimits/read", undefined),
        client.request<Record<string, unknown>>("account/usage/read", undefined),
      ]);
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
      onProcessDelta?: (delta: string) => void,
      historyItems: readonly Record<string, unknown>[] = [],
      outputSchema?: Record<string, unknown>,
      onUsageUpdate?: (usage: NonNullable<CodexTurnResult["usage"]>) => void,
      reasoningSummary: CodexReasoningSummary = "auto",
      onNativeItem?: (item: Record<string, unknown>) => void,
    ): Promise<CodexTurnResult> => {
      requireInitialized();
      if (
        input.length === 0 ||
        input.every((item) => item.type === "text" && item.text.trim() === "")
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Codex turn input cannot be empty.");
      }
      if (historyItems.length > 0) {
        await client.request("thread/inject_items", { threadId, items: historyItems }, signal);
      }
      const response = await client.request<Record<string, unknown>>(
        "turn/start",
        {
          threadId,
          input,
          approvalPolicy: "on-request",
          effort: reasoningEffort ?? options.reasoningEffort ?? null,
          summary: reasoningSummary,
          outputSchema: outputSchema ?? null,
        },
        signal,
      );
      const turn = response.turn;
      const turnId = readString(turn, "id");
      if (turnId === undefined) {
        throw new TiduError("INTERNAL_ERROR", "Codex returned an invalid turn response.");
      }
      return new Promise<CodexTurnResult>((resolve, reject) => {
        const abort = (): void => {
          const active = activeTurns.get(turnId);
          if (active === undefined) return;
          activeTurns.delete(turnId);
          clearTurnProcessItems(turnId);
          if (active.usageWaitTimer !== undefined) clearTimeout(active.usageWaitTimer);
          active.cleanup();
          void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          active.reject(new DOMException("Codex turn cancelled.", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const state: TurnState = {
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
        activeTurns.set(turnId, state);
        if (signal?.aborted) {
          abort();
          return;
        }
        const buffered = bufferedTurnNotifications.get(turnId);
        if (buffered === undefined) return;
        bufferedTurnNotifications.delete(turnId);
        state.modelResponseCompleted = buffered.modelResponseCompleted === true;
        for (const item of buffered.nativeItems ?? []) {
          state.progressItems.push(item);
          state.onNativeItem?.(item);
        }
        for (const delta of buffered.deltas) {
          state.text += delta;
          state.onTextDelta?.(delta);
        }
        for (const processDelta of buffered.processDeltas) {
          forwardProcessDelta(turnId, processDelta.itemKey, processDelta.delta);
        }
        if (buffered.usage !== undefined) {
          state.usage = buffered.usage;
          state.hasTurnAggregateUsage = buffered.hasTurnAggregateUsage === true;
          state.onUsageUpdate?.(buffered.usage);
        }
        if (buffered.completion !== undefined) scheduleTurnCompletion(buffered.completion, state);
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

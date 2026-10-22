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
  /** Per-turn token usage reported by the official app-server. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
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
  startThread: () => Promise<CodexThread>;
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
  ) => Promise<CodexTurnResult>;
  /** Interrupts one active turn. */
  cancel: (threadId: string, turnId: string) => Promise<void>;
  /** Terminates the delegated app-server process. */
  close: () => Promise<void>;
}

interface TurnState {
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
}

interface BufferedTurnNotifications {
  /** Text deltas received before the turn was registered locally. */
  deltas: string[];
  /** Public process deltas received before the turn was registered locally. */
  processDeltas: Array<{ itemKey: string; delta: string }>;
  /** Terminal result received before the turn was registered locally. */
  completion?: Omit<CodexTurnResult, "text" | "usage">;
  /** Token usage received before the turn was registered locally. */
  usage?: NonNullable<CodexTurnResult["usage"]>;
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
    state.processItemKey = itemKey;
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
  };

  const clearTurnProcessItems = (turnId: string): void => {
    const prefix = `${turnId}\u0000`;
    for (const processItemKey of forwardedProcessItems) {
      if (processItemKey.startsWith(prefix)) forwardedProcessItems.delete(processItemKey);
    }
  };

  const completeTurn = (
    completion: Omit<CodexTurnResult, "text" | "usage">,
    state: TurnState,
  ): void => {
    activeTurns.delete(completion.turnId);
    clearTurnProcessItems(completion.turnId);
    state.cleanup();
    state.resolve({ ...completion, text: state.text, usage: state.usage });
  };

  const onNotification = (notification: JsonRpcNotification): void => {
    options.onEvent?.(notification);
    const turnId = readString(notification.params, "turnId");
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
      notification.method === "thread/tokenUsage/updated" &&
      turnId !== undefined &&
      isRecord(notification.params) &&
      isRecord(notification.params.tokenUsage)
    ) {
      const tokenUsage = notification.params.tokenUsage;
      const last = isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage.total;
      const inputTokens = readNumber(last, "inputTokens");
      const outputTokens = readNumber(last, "outputTokens");
      const totalTokens = readNumber(last, "totalTokens");
      if (inputTokens !== null && outputTokens !== null && totalTokens !== null) {
        const usage = { inputTokens, outputTokens, totalTokens };
        const state = activeTurns.get(turnId);
        if (state === undefined) {
          bufferTurnNotification(turnId, (buffer) => {
            buffer.usage = usage;
          });
        } else {
          state.usage = usage;
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta" && turnId !== undefined) {
      const state = activeTurns.get(turnId);
      const delta = readString(notification.params, "delta");
      const itemId = readString(notification.params, "itemId");
      const phase = itemId === undefined ? undefined : messagePhases.get(itemId);
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
    completeTurn({ threadId, turnId: completedTurnId, status }, state);
  };

  const launch = createCodexAppServerLaunch(options);
  const client: JsonRpcClient = createStdioJsonRpcClient(
    { ...launch, workingDirectory: options.workingDirectory },
    {
      onNotification,
      onRequest: (request) => defaultServerRequest(request, options.onApproval),
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
          experimentalApi: false,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      });
      client.notify("initialized");
      initialized = true;
    },
    startThread: async (): Promise<CodexThread> => {
      requireInitialized();
      const response = await client.request<Record<string, unknown>>("thread/start", {
        cwd: options.workingDirectory,
        model: options.model ?? null,
        approvalPolicy: "on-request",
        sandbox: options.sandbox ?? "workspace-write",
        ephemeral: options.ephemeral ?? false,
      });
      const thread = response.thread;
      const id = readString(thread, "id");
      const model =
        readString(response, "model") ?? readString(thread, "model") ?? options.model ?? undefined;
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
          void client.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
          activeTurns.delete(turnId);
          reject(new TiduError("INTERNAL_ERROR", "Codex turn cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const state: TurnState = {
          text: "",
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", abort),
          onTextDelta,
          onProcessDelta,
          usage: null,
        };
        activeTurns.set(turnId, state);
        const buffered = bufferedTurnNotifications.get(turnId);
        if (buffered === undefined) return;
        bufferedTurnNotifications.delete(turnId);
        for (const delta of buffered.deltas) {
          state.text += delta;
          state.onTextDelta?.(delta);
        }
        for (const processDelta of buffered.processDeltas) {
          if (state.processItemKey !== undefined && state.processItemKey !== processDelta.itemKey) {
            state.onProcessDelta?.("\n\n");
          }
          state.processItemKey = processDelta.itemKey;
          state.onProcessDelta?.(processDelta.delta);
        }
        if (buffered.usage !== undefined) state.usage = buffered.usage;
        if (buffered.completion !== undefined) completeTurn(buffered.completion, state);
      });
    },
    cancel: async (threadId: string, turnId: string): Promise<void> => {
      requireInitialized();
      await client.request("turn/interrupt", { threadId, turnId });
    },
    close: async (): Promise<void> => {
      for (const state of activeTurns.values()) {
        state.cleanup();
        state.reject(new TiduError("INTERNAL_ERROR", "Codex connection closed."));
      }
      activeTurns.clear();
      bufferedTurnNotifications.clear();
      messagePhases.clear();
      forwardedProcessItems.clear();
      await client.close();
    },
  };
};

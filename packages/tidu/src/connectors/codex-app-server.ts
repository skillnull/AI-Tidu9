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
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}

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
    text: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
    reasoningEffort?: CodexReasoningEffort,
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
  /** Latest per-turn token usage reported by the official app-server. */
  usage: CodexTurnResult["usage"];
}

interface BufferedTurnNotifications {
  /** Text deltas received before the turn was registered locally. */
  deltas: string[];
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
  let initialized = false;

  const bufferTurnNotification = (
    turnId: string,
    update: (buffer: BufferedTurnNotifications) => void,
  ): void => {
    const buffer = bufferedTurnNotifications.get(turnId) ?? { deltas: [] };
    update(buffer);
    bufferedTurnNotifications.set(turnId, buffer);
    if (bufferedTurnNotifications.size > 32) {
      const oldestTurnId = bufferedTurnNotifications.keys().next().value;
      if (oldestTurnId !== undefined) bufferedTurnNotifications.delete(oldestTurnId);
    }
  };

  const completeTurn = (
    completion: Omit<CodexTurnResult, "text" | "usage">,
    state: TurnState,
  ): void => {
    activeTurns.delete(completion.turnId);
    state.cleanup();
    state.resolve({ ...completion, text: state.text, usage: state.usage });
  };

  const onNotification = (notification: JsonRpcNotification): void => {
    options.onEvent?.(notification);
    const turnId = readString(notification.params, "turnId");
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
      if (state !== undefined && delta !== undefined) {
        state.text += delta;
        state.onTextDelta?.(delta);
      } else if (delta !== undefined) {
        bufferTurnNotification(turnId, (buffer) => buffer.deltas.push(delta));
      }
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
        clientInfo: { name: "ai_tidu9", title: "九门赛博提督", version: "0.2.0-alpha.1" },
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
      text: string,
      signal?: AbortSignal,
      onTextDelta?: (delta: string) => void,
      reasoningEffort?: CodexReasoningEffort,
    ): Promise<CodexTurnResult> => {
      requireInitialized();
      if (text.trim() === "") {
        throw new TiduError("CONFIGURATION_INVALID", "Codex prompt cannot be empty.");
      }
      const response = await client.request<Record<string, unknown>>(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          approvalPolicy: "on-request",
          effort: reasoningEffort ?? options.reasoningEffort ?? null,
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
      await client.close();
    },
  };
};

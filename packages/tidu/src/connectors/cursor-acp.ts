import {
  type CursorHostInspectionOptions,
  createCursorAcpLaunch,
} from "../accounts/cursor-host.js";
import { TiduError } from "../core/index.js";
import {
  createStdioJsonRpcClient,
  type JsonRpcClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./json-rpc.js";

export type CursorPermissionDecision = "allow-always" | "allow-once" | "reject-once";
export type CursorAgentMode = "agent" | "ask" | "plan";

export interface CursorAcpEvent {
  /** ACP or Cursor extension method name. */
  method: string;
  /** Untrusted event payload supplied by Cursor Agent. */
  params: unknown;
}

export interface CursorAcpModel {
  /** Provider-owned model identifier required by Cursor ACP execution. */
  id: string;
  /** Provider-published model name intended for user interfaces. */
  name: string;
}

export interface CursorAcpOptions extends CursorHostInspectionOptions {
  /** Working directory used when creating ACP sessions. */
  workingDirectory: string;
  /** Initial Cursor Agent mode. */
  mode?: CursorAgentMode;
  /** Cursor-owned model ID to select for newly created sessions. */
  requestedModel?: string;
  /** Optional notification observer for streaming UI integration. */
  onEvent?: (event: CursorAcpEvent) => void;
  /** Public model thought summaries forwarded as native reasoning progress. */
  onProcessDelta?: (delta: string) => void;
  /** Per-request ACP deadline; null waits for Cursor's official terminal response. */
  requestTimeoutMilliseconds?: number | null;
  /** Explicit reviewer for Cursor tool permission requests. */
  onPermission?: (request: JsonRpcServerRequest) => Promise<CursorPermissionDecision>;
  /** Explicit handler for Cursor blocking extension methods. */
  onInteraction?: (request: JsonRpcServerRequest) => Promise<unknown>;
}

export interface CursorAcpSession {
  /** Cursor ACP session identifier used for prompts and resume. */
  id: string;
  /** Model ID selected for this session, when Cursor reports it. */
  model: string | null;
  /** Models that this ACP session explicitly allows. */
  availableModels: readonly CursorAcpModel[];
}

export interface CursorAcpPromptResult {
  /** Session that handled the prompt. */
  sessionId: string;
  /** ACP stop reason returned by Cursor. */
  stopReason: string;
  /** Concatenated Agent message chunks. */
  text: string;
}

export interface CursorAcpClient {
  /** Negotiates ACP capabilities and authenticates with Cursor-owned login. */
  initialize: (signal?: AbortSignal) => Promise<void>;
  /** Creates a new Cursor Agent session. */
  createSession: (signal?: AbortSignal) => Promise<CursorAcpSession>;
  /** Sends a prompt and waits for the ACP terminal response. */
  prompt: (
    sessionId: string,
    text: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ) => Promise<CursorAcpPromptResult>;
  /** Cancels active work for a session. */
  cancel: (sessionId: string) => Promise<void>;
  /** Terminates the delegated Cursor Agent process. */
  close: () => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

const readCurrentModel = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const directModel =
    readString(value, "currentModelId") ??
    readString(value, "currentModel") ??
    readString(value, "model");
  if (directModel !== undefined) return directModel;
  const models = value.models;
  if (isRecord(models)) {
    const currentId =
      readString(models, "currentModelId") ?? readString(models, "current_model_id");
    if (currentId !== undefined) return currentId;
  }
  if (!Array.isArray(value.configOptions)) return undefined;
  for (const option of value.configOptions) {
    if (!isRecord(option)) continue;
    const id = readString(option, "id") ?? readString(option, "category");
    if (id === undefined || !/model/iu.test(id)) continue;
    const current = option.currentValue;
    if (typeof current === "string" && current.trim() !== "") return current;
    if (isRecord(current)) {
      const currentValue = readString(current, "value") ?? readString(current, "modelId");
      if (currentValue !== undefined) return currentValue;
    }
  }
  return undefined;
};

const readModelConfigOption = (
  value: unknown,
):
  | {
      configId: string;
      type: string;
      currentValue: string | undefined;
      models: readonly CursorAcpModel[];
    }
  | undefined => {
  if (!isRecord(value) || !Array.isArray(value.configOptions)) return undefined;
  for (const option of value.configOptions) {
    if (!isRecord(option)) continue;
    const configId = readString(option, "configId") ?? readString(option, "id");
    const category = readString(option, "category");
    if (configId === undefined || (category !== "model" && !/model/iu.test(configId))) continue;
    const models = Array.isArray(option.options)
      ? option.options.flatMap((candidate) => {
          if (!isRecord(candidate)) return [];
          const id =
            readString(candidate, "modelId") ??
            readString(candidate, "value") ??
            readString(candidate, "id");
          if (id === undefined) return [];
          const publishedName = readString(candidate, "name")?.trim();
          return [
            {
              id,
              name: publishedName === "" || publishedName === undefined ? id : publishedName,
            },
          ];
        })
      : [];
    return {
      configId,
      type: readString(option, "type") ?? "select",
      currentValue: readString(option, "currentValue"),
      models,
    };
  }
  return undefined;
};

export const createCursorAcpClient = (options: CursorAcpOptions): CursorAcpClient => {
  const messageChunks = new Map<string, string>();
  const textDeltaListeners = new Map<string, (delta: string) => void>();
  let initialized = false;
  let initializedModel: string | undefined;
  const launch = createCursorAcpLaunch(options);

  const handleRequest = async (request: JsonRpcServerRequest): Promise<unknown> => {
    if (request.method === "session/request_permission") {
      const decision =
        options.onPermission === undefined ? "reject-once" : await options.onPermission(request);
      return { outcome: { outcome: "selected", optionId: decision } };
    }
    if (request.method === "cursor/ask_question" || request.method === "cursor/create_plan") {
      if (options.onInteraction === undefined) {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          `Cursor interaction requires an explicit handler: ${request.method}`,
        );
      }
      return options.onInteraction(request);
    }
    throw new TiduError(
      "CONFIGURATION_INVALID",
      `Unsupported Cursor ACP request: ${request.method}`,
    );
  };

  const handleNotification = (notification: JsonRpcNotification): void => {
    options.onEvent?.(notification);
    if (notification.method !== "session/update" || !isRecord(notification.params)) {
      return;
    }
    const sessionId = readString(notification.params, "sessionId");
    const update = notification.params.update;
    if (sessionId === undefined || !isRecord(update)) {
      return;
    }
    if (!isRecord(update.content)) return;
    const text = readString(update.content, "text");
    if (text === undefined) return;
    const updateType = readString(update, "sessionUpdate")?.toLowerCase() ?? "";
    if (updateType.includes("thought") || updateType.includes("reasoning")) {
      options.onProcessDelta?.(text);
      return;
    }
    messageChunks.set(sessionId, `${messageChunks.get(sessionId) ?? ""}${text}`);
    textDeltaListeners.get(sessionId)?.(text);
  };

  const client: JsonRpcClient = createStdioJsonRpcClient(
    { ...launch, workingDirectory: options.workingDirectory },
    {
      onNotification: handleNotification,
      onRequest: handleRequest,
      requestTimeoutMilliseconds: options.requestTimeoutMilliseconds ?? null,
    },
  );

  const requireInitialized = (): void => {
    if (!initialized) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Cursor ACP is not initialized.");
    }
  };

  return {
    initialize: async (signal?: AbortSignal): Promise<void> => {
      if (initialized) {
        return;
      }
      const initializeResponse = await client.request<unknown>(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "ai_tidu9", version: "0.2.0-alpha.1" },
        },
        signal,
      );
      initializedModel = readCurrentModel(initializeResponse);
      await client.request("authenticate", { methodId: "cursor_login" }, signal);
      initialized = true;
    },
    createSession: async (signal?: AbortSignal): Promise<CursorAcpSession> => {
      requireInitialized();
      const response = await client.request<Record<string, unknown>>(
        "session/new",
        {
          cwd: options.workingDirectory,
          mcpServers: [],
        },
        signal,
      );
      const id = readString(response, "sessionId");
      if (id === undefined) {
        throw new TiduError("INTERNAL_ERROR", "Cursor ACP returned an invalid session response.");
      }
      if (options.mode !== undefined && options.mode !== "agent") {
        await client.request("session/set_mode", { sessionId: id, modeId: options.mode }, signal);
      }
      const sessionModel = readCurrentModel(response);
      let selectedModel = sessionModel ?? initializedModel ?? null;
      const initialModelOption = readModelConfigOption(response);
      if (options.requestedModel !== undefined && options.requestedModel !== sessionModel) {
        const modelOption = initialModelOption;
        if (modelOption === undefined) {
          throw new TiduError(
            "CONFIGURATION_INVALID",
            "Cursor ACP did not expose a model selection option for this session.",
          );
        }
        if (
          modelOption.models.length > 0 &&
          !modelOption.models.some((candidate) => candidate.id === options.requestedModel)
        ) {
          const availableModels = modelOption.models
            .slice(0, 12)
            .map((candidate) => candidate.id)
            .join(", ");
          throw new TiduError(
            "CONFIGURATION_INVALID",
            `Cursor ACP does not offer the configured model ${options.requestedModel}. Session options: ${availableModels}.`,
          );
        }
        const updateResponse = await client.request<unknown>(
          "session/set_config_option",
          {
            sessionId: id,
            configId: modelOption.configId,
            type: modelOption.type,
            value: options.requestedModel,
          },
          signal,
        );
        const confirmedModel = readCurrentModel(updateResponse);
        if (confirmedModel === undefined) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            `Cursor ACP did not confirm that model ${options.requestedModel} was selected.`,
          );
        }
        if (confirmedModel !== options.requestedModel) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            `Cursor ACP confirmed model ${confirmedModel} instead of configured model ${options.requestedModel}.`,
          );
        }
        selectedModel = confirmedModel;
      }
      if (options.requestedModel !== undefined && selectedModel !== options.requestedModel) {
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          `Cursor ACP did not confirm configured model ${options.requestedModel} for this session.`,
        );
      }
      return {
        id,
        model: selectedModel,
        availableModels: initialModelOption?.models ?? [],
      };
    },
    prompt: async (
      sessionId: string,
      text: string,
      signal?: AbortSignal,
      onTextDelta?: (delta: string) => void,
    ): Promise<CursorAcpPromptResult> => {
      requireInitialized();
      if (text.trim() === "") {
        throw new TiduError("CONFIGURATION_INVALID", "Cursor prompt cannot be empty.");
      }
      messageChunks.set(sessionId, "");
      if (onTextDelta !== undefined) textDeltaListeners.set(sessionId, onTextDelta);
      try {
        const response = await client.request<Record<string, unknown>>(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text }] },
          signal,
        );
        return {
          sessionId,
          stopReason: readString(response, "stopReason") ?? "unknown",
          text: messageChunks.get(sessionId) ?? "",
        };
      } finally {
        textDeltaListeners.delete(sessionId);
        messageChunks.delete(sessionId);
      }
    },
    cancel: async (sessionId: string): Promise<void> => {
      requireInitialized();
      await client.request("session/cancel", { sessionId });
    },
    close: async (): Promise<void> => {
      messageChunks.clear();
      textDeltaListeners.clear();
      await client.close();
    },
  };
};

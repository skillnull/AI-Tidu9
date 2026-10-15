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

export interface CursorAcpOptions extends CursorHostInspectionOptions {
  /** Working directory used when creating ACP sessions. */
  workingDirectory: string;
  /** Initial Cursor Agent mode. */
  mode?: CursorAgentMode;
  /** Optional notification observer for streaming UI integration. */
  onEvent?: (event: CursorAcpEvent) => void;
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
  initialize: () => Promise<void>;
  /** Creates a new Cursor Agent session. */
  createSession: () => Promise<CursorAcpSession>;
  /** Sends a prompt and waits for the ACP terminal response. */
  prompt: (sessionId: string, text: string, signal?: AbortSignal) => Promise<CursorAcpPromptResult>;
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

export const createCursorAcpClient = (options: CursorAcpOptions): CursorAcpClient => {
  const messageChunks = new Map<string, string>();
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
    if (update.sessionUpdate !== "agent_message_chunk" || !isRecord(update.content)) {
      return;
    }
    const text = readString(update.content, "text");
    if (text !== undefined) {
      messageChunks.set(sessionId, `${messageChunks.get(sessionId) ?? ""}${text}`);
    }
  };

  const client: JsonRpcClient = createStdioJsonRpcClient(
    { ...launch, workingDirectory: options.workingDirectory },
    { onNotification: handleNotification, onRequest: handleRequest },
  );

  const requireInitialized = (): void => {
    if (!initialized) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Cursor ACP is not initialized.");
    }
  };

  return {
    initialize: async (): Promise<void> => {
      if (initialized) {
        return;
      }
      const initializeResponse = await client.request<unknown>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "ai-tidu9", version: "0.2.0-alpha.1" },
      });
      initializedModel = readCurrentModel(initializeResponse);
      await client.request("authenticate", { methodId: "cursor_login" });
      initialized = true;
    },
    createSession: async (): Promise<CursorAcpSession> => {
      requireInitialized();
      const response = await client.request<Record<string, unknown>>("session/new", {
        cwd: options.workingDirectory,
        mcpServers: [],
      });
      const id = readString(response, "sessionId");
      if (id === undefined) {
        throw new TiduError("INTERNAL_ERROR", "Cursor ACP returned an invalid session response.");
      }
      if (options.mode !== undefined && options.mode !== "agent") {
        await client.request("session/set_mode", { sessionId: id, modeId: options.mode });
      }
      return { id, model: readCurrentModel(response) ?? initializedModel ?? null };
    },
    prompt: async (
      sessionId: string,
      text: string,
      signal?: AbortSignal,
    ): Promise<CursorAcpPromptResult> => {
      requireInitialized();
      if (text.trim() === "") {
        throw new TiduError("CONFIGURATION_INVALID", "Cursor prompt cannot be empty.");
      }
      messageChunks.set(sessionId, "");
      const response = await client.request<Record<string, unknown>>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        signal,
      );
      const stopReason = readString(response, "stopReason") ?? "unknown";
      const result = {
        sessionId,
        stopReason,
        text: messageChunks.get(sessionId) ?? "",
      };
      messageChunks.delete(sessionId);
      return result;
    },
    cancel: async (sessionId: string): Promise<void> => {
      requireInitialized();
      await client.request("session/cancel", { sessionId });
    },
    close: async (): Promise<void> => {
      messageChunks.clear();
      await client.close();
    },
  };
};

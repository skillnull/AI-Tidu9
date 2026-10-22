import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexHostInspectionOptions,
  inspectCodexHostLogin,
  inspectCodexHostLoginAsync,
} from "../accounts/codex-host.js";
import { inspectCursorHostLoginAsync } from "../accounts/cursor-host.js";
import {
  type CodexAccountSummary,
  type CodexAgentClient,
  type CodexReasoningEffort,
  type CodexThread,
  type CodexTurnInput,
  type CodexTurnResult,
  type CodexUsageSummary,
  createCodexAgentClient,
} from "../connectors/codex-app-server.js";
import { type CursorAcpModel, createCursorAcpClient } from "../connectors/cursor-acp.js";
import { TiduError } from "../core/index.js";
import type { ModelProvider, ProviderExecutionRequest, ProviderExecutionResult } from "./index.js";

const CURSOR_DISCOVERY_TIMEOUT_MILLISECONDS = 15_000;
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const imageTypes = new Set(["image", "image_url", "input_image", "localImage"]);

const containsImageContent = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some((item) => containsImageContent(item));
  if (!isRecord(value)) return false;
  if (typeof value.type === "string" && imageTypes.has(value.type)) return true;
  return containsImageContent(value.content);
};

const structuredOutputFormat = (
  request: ProviderExecutionRequest,
): Record<string, unknown> | undefined => {
  if (isRecord(request.body.response_format)) return request.body.response_format;
  if (isRecord(request.body.text) && isRecord(request.body.text.format)) {
    return request.body.text.format;
  }
  return undefined;
};

export const findUnsupportedHostBridgeRequest = (
  request: ProviderExecutionRequest,
  imageInputSupported = false,
): ProviderExecutionResult | undefined => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  if (!imageInputSupported && containsImageContent(conversation)) {
    return {
      kind: "json",
      statusCode: 400,
      body: {
        error: {
          code: "host_bridge_image_unsupported",
          message: "The selected host bridge does not support image input.",
          type: "invalid_request_error",
        },
      },
    };
  }
  return undefined;
};

const readImageTurnInput = (value: Record<string, unknown>): CodexTurnInput | undefined => {
  if (value.type === "localImage" && typeof value.path === "string" && value.path !== "") {
    return { type: "localImage", path: value.path };
  }
  const imageUrlValue = value.image_url;
  const url =
    typeof value.url === "string"
      ? value.url
      : typeof imageUrlValue === "string"
        ? imageUrlValue
        : isRecord(imageUrlValue) && typeof imageUrlValue.url === "string"
          ? imageUrlValue.url
          : undefined;
  if (url === undefined || url === "") return undefined;
  return url.startsWith("/") ? { type: "localImage", path: url } : { type: "image", url };
};

const summarizeImageContent = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => summarizeImageContent(item));
  if (!isRecord(value)) return value;
  if (typeof value.type === "string" && imageTypes.has(value.type)) {
    return { type: value.type, attachedSeparately: true };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, summarizeImageContent(child)]),
  );
};

export const requestPrompt = (request: ProviderExecutionRequest): string => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const availableCapabilities = request.routing?.availableCapabilities;
  const completedCapabilities = request.routing?.completedCapabilities ?? [];
  const requiredCapabilities = request.routing?.requiredCapabilities ?? [];
  const effectiveCapabilities = new Set([
    ...(availableCapabilities ?? []),
    ...completedCapabilities,
  ]);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !effectiveCapabilities.has(capability),
  );
  const instructions = [
    "Answer this single model request using the conversation and instructions supplied below.",
    "Give concise, concrete progress updates while working, then provide the final result.",
    "Never attribute a route or capability limitation to the user unless the conversation explicitly contains that restriction.",
  ];
  if (availableCapabilities?.includes("code") === true) {
    instructions.push(
      "Use the delegated Codex host's workspace tools when the request requires reading, changing, or verifying local files. Preserve the host's normal approval and sandbox rules.",
    );
  }
  if (missingCapabilities.length > 0) {
    instructions.push(
      `The current configured route does not provide these required capabilities: ${missingCapabilities.join(", ")}. Explain the limitation briefly and helpfully in the user's language. Recommend enabling a capable primary or secondary model. Do not pretend the requested action was completed.`,
    );
  }
  const outputFormat = structuredOutputFormat(request);
  if (outputFormat?.type === "json_object") {
    instructions.push("Return a valid JSON object only, with no markdown fences or extra text.");
  } else if (outputFormat?.type === "json_schema") {
    instructions.push(
      `Return one valid JSON object matching this requested JSON format, with no markdown fences or extra text: ${JSON.stringify(outputFormat)}`,
    );
  }
  const callerInstructions =
    typeof request.body.instructions === "string" && request.body.instructions.trim() !== ""
      ? `\n\nCaller instructions:\n${request.body.instructions}`
      : "";
  return `${instructions.join(" ")}${callerInstructions}\n\nConversation:\n${JSON.stringify(summarizeImageContent(conversation))}`;
};

export const requestTurnInput = (
  request: ProviderExecutionRequest,
): {
  /** Native app-server input items for the active user turn. */
  input: readonly CodexTurnInput[];
  /** Earlier official conversation items injected before the active turn. */
  historyItems: readonly Record<string, unknown>[];
} => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const conversationItems = Array.isArray(conversation) ? conversation.filter(isRecord) : [];
  const messages = conversationItems.filter(
    (item): item is Record<string, unknown> => typeof item.role === "string",
  );
  let lastUserIndex = -1;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    if (messages[messageIndex]?.role === "user") {
      lastUserIndex = messageIndex;
      break;
    }
  }
  const activeContent =
    lastUserIndex >= 0
      ? messages[lastUserIndex]?.content
      : typeof conversation === "string"
        ? conversation
        : conversation;
  const input: CodexTurnInput[] = [];
  const collectActiveInput = (value: unknown): void => {
    if (typeof value === "string") {
      if (value !== "") input.push({ type: "text", text: value, text_elements: [] });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectActiveInput(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string" && imageTypes.has(value.type)) {
      const imageInput = readImageTurnInput(value);
      if (imageInput !== undefined) input.push(imageInput);
      return;
    }
    if (
      (value.type === "text" || value.type === "input_text" || value.type === "output_text") &&
      typeof value.text === "string"
    ) {
      collectActiveInput(value.text);
      return;
    }
    collectActiveInput(value.content);
  };
  collectActiveInput(activeContent);
  const normalizeHistoryMessage = (message: Record<string, unknown>): Record<string, unknown> => {
    const role = typeof message.role === "string" ? message.role : "user";
    const content = Array.isArray(message.content) ? message.content : [message.content];
    const normalizedContent = content.flatMap((part): Record<string, unknown>[] => {
      if (typeof part === "string") {
        return [{ type: role === "assistant" ? "output_text" : "input_text", text: part }];
      }
      if (!isRecord(part)) return [];
      if (typeof part.type === "string" && imageTypes.has(part.type)) {
        const imageInput = readImageTurnInput(part);
        if (imageInput?.type === "image") {
          return [{ type: "input_image", image_url: imageInput.url }];
        }
        return imageInput?.type === "localImage"
          ? [{ type: "input_image", image_url: `file://${imageInput.path}` }]
          : [];
      }
      if (typeof part.text === "string") {
        return [
          {
            ...part,
            type: role === "assistant" ? "output_text" : "input_text",
            text: part.text,
          },
        ];
      }
      return [part];
    });
    return { type: "message", role, content: normalizedContent };
  };
  const historyItems: Record<string, unknown>[] = [];
  if (typeof request.body.instructions === "string" && request.body.instructions !== "") {
    historyItems.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: request.body.instructions }],
    });
  }
  if (lastUserIndex >= 0) {
    if (request.protocol === "chat-completions") {
      historyItems.push(...messages.slice(0, lastUserIndex).map(normalizeHistoryMessage));
    } else {
      const activeUserMessage = messages[lastUserIndex];
      const activeItemIndex = conversationItems.indexOf(
        activeUserMessage as Record<string, unknown>,
      );
      historyItems.push(
        ...conversationItems
          .slice(0, activeItemIndex)
          .map((item) => (typeof item.role === "string" ? normalizeHistoryMessage(item) : item)),
      );
    }
  }
  if (input.length === 0) input.push({ type: "text", text: " ", text_elements: [] });
  return { input, historyItems };
};

export const requireValidHostModelText = (
  request: ProviderExecutionRequest,
  text: string,
): string => {
  if (text.trim() === "") throw new Error("The host model returned an empty response.");
  const outputFormat = structuredOutputFormat(request);
  if (outputFormat?.type !== "json_object" && outputFormat?.type !== "json_schema") return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("The host model did not return valid JSON for the requested output format.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("The host model did not return a JSON object for the requested output format.");
  }
  return text;
};

const responseModel = (request: ProviderExecutionRequest): string =>
  typeof request.body.model === "string" ? request.body.model : request.virtualModelId;

const requestReasoningEffort = (request: ProviderExecutionRequest): CodexReasoningEffort => {
  const reasoning = isRecord(request.body.reasoning) ? request.body.reasoning.effort : undefined;
  const candidate = reasoning ?? request.body.reasoning_effort;
  return typeof candidate === "string" &&
    CODEX_REASONING_EFFORTS.has(candidate as CodexReasoningEffort)
    ? (candidate as CodexReasoningEffort)
    : "medium";
};

const createResponse = (
  request: ProviderExecutionRequest,
  text: string,
  responseId = `tidu_${randomUUID()}`,
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null,
  createdAt = Math.floor(Date.now() / 1_000),
): unknown => {
  if (request.protocol === "chat-completions") {
    return {
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseModel(request),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      ...(usage == null
        ? {}
        : {
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
            },
          }),
    };
  }
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    completed_at: Math.floor(Date.now() / 1_000),
    error: null,
    incomplete_details: null,
    model: responseModel(request),
    output: [
      {
        id: `${responseId}_message`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...(usage == null
      ? {}
      : {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        }),
  };
};

export const createLiveJsonStream = (
  request: ProviderExecutionRequest,
  run: (
    onTextDelta: (delta: string) => void,
    onProcessDelta: (delta: string) => void,
  ) => Promise<
    | string
    | {
        /** Complete assistant text returned by the host. */
        text: string;
        /** Provider-authoritative token usage, when available. */
        usage: CodexTurnResult["usage"];
      }
  >,
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let firstChatDelta = true;
      const write = (event: string): boolean => {
        if (!streamOpen) return false;
        controller.enqueue(encoder.encode(event));
        return true;
      };
      const close = (): void => {
        if (!streamOpen) return;
        streamOpen = false;
        controller.close();
      };
      const emitTextDelta = (delta: string): void => {
        if (request.protocol === "chat-completions") {
          if (
            !write(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1_000),
                model: responseModel(request),
                choices: [
                  {
                    index: 0,
                    delta: {
                      ...(firstChatDelta ? { role: "assistant" } : {}),
                      content: delta,
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            )
          ) {
            return;
          }
          firstChatDelta = false;
          return;
        }
        write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
        );
      };
      const emitProcessDelta = (delta: string): void => {
        if (request.protocol !== "responses" || delta === "") return;
        write(
          `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta })}\n\n`,
        );
      };
      void run(emitTextDelta, emitProcessDelta)
        .then((result) => {
          if (!streamOpen) return;
          const text = typeof result === "string" ? result : result.text;
          const usage = typeof result === "string" ? null : result.usage;
          if (request.protocol === "chat-completions") {
            write(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1_000),
                model: responseModel(request),
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`,
            );
          } else {
            write(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: createResponse(request, text, responseId, usage, createdAt),
              })}\n\n`,
            );
          }
          if (!write("data: [DONE]\n\n")) return;
          close();
        })
        .catch((error: unknown) => {
          if (!streamOpen) return;
          const message = error instanceof Error ? error.message : "The host model failed.";
          if (request.protocol === "chat-completions") {
            write(
              `data: ${JSON.stringify({ error: { code: "host_model_failed", message: message.slice(0, 240), type: "server_error" } })}\n\n`,
            );
          } else {
            write(
              `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: responseId, object: "response", status: "failed", model: responseModel(request), output: [], error: { code: "host_model_failed", message: message.slice(0, 240) } } })}\n\n`,
            );
          }
          if (!write("data: [DONE]\n\n")) return;
          close();
        });
    },
    cancel() {
      streamOpen = false;
    },
  });
};

export const requireCompletedCursorPrompt = (
  model: string | null,
  result: { readonly stopReason: string; readonly text: string },
): string => {
  const modelName = model ?? "current";
  if (result.stopReason !== "end_turn") {
    throw new Error(`Cursor model ${modelName} stopped with ${result.stopReason}.`);
  }
  if (result.text.trim() === "") {
    throw new Error(`Cursor model ${modelName} returned an empty response.`);
  }
  return result.text;
};

export const cursorCapabilitiesForModel = (modelId: string): readonly string[] => {
  const capabilities = ["text", "structured-output"];
  const parameterBlock = /\[([^\]]*)\]$/u.exec(modelId)?.[1] ?? "";
  const parameters = new Map(
    parameterBlock.split(",").flatMap((entry): [string, string][] => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex < 1) return [];
      return [
        [
          entry.slice(0, separatorIndex).trim().toLowerCase(),
          entry
            .slice(separatorIndex + 1)
            .trim()
            .toLowerCase(),
        ],
      ];
    }),
  );
  const reasoningEnabled = ["thinking", "reasoning", "reasoning_effort", "effort"].some(
    (parameter) => {
      const value = parameters.get(parameter);
      return value !== undefined && value !== "false" && value !== "none";
    },
  );
  if (reasoningEnabled) capabilities.push("reasoning");
  capabilities.push("code");
  const contextMatch = /^(\d+)([km])?$/u.exec(parameters.get("context") ?? "");
  if (contextMatch !== null) {
    const contextAmount = Number(contextMatch[1]);
    const contextMultiplier =
      contextMatch[2] === "m" ? 1_000_000 : contextMatch[2] === "k" ? 1_000 : 1;
    if (contextAmount * contextMultiplier >= 100_000) capabilities.push("long-context");
  }
  return capabilities;
};

export const createCursorModelCatalog = (
  currentModel: string,
  availableModels: readonly CursorAcpModel[],
) => {
  const publishedModels = availableModels.map((model) => ({
    id: model.id,
    name: model.name,
    capabilities: cursorCapabilitiesForModel(model.id),
    capabilitySource: "provider-catalog" as const,
  }));
  return publishedModels.some((candidate) => candidate.id === currentModel)
    ? publishedModels
    : [
        {
          id: currentModel,
          name: currentModel.replace(/\[[^\]]*\]$/u, ""),
          capabilities: cursorCapabilitiesForModel(currentModel),
          capabilitySource: "provider-catalog" as const,
        },
        ...publishedModels,
      ];
};

interface CodexClientSession {
  /** Initialized long-lived official Codex app-server client. */
  client: CodexAgentClient;
  /** First empty thread created during model discovery and reused by the first request. */
  initialThread?: CodexThread;
  /** Model identifier explicitly confirmed by the Codex host for this session. */
  model: string;
}

const createCodexClientSession = async (
  model?: string,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<CodexClientSession> => {
  const client = createCodexAgentClient({
    ...hostOptions,
    workingDirectory: process.cwd(),
    ...(model === undefined ? {} : { model }),
    modelProvider: hostOptions.modelProvider ?? "openai",
    ephemeral: true,
    sandbox: "workspace-write",
  });
  try {
    await client.initialize();
    const initialThread = await client.startThread();
    return {
      client,
      initialThread,
      model: initialThread.model,
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

const closeCodexClientSession = async (session: CodexClientSession): Promise<void> => {
  await session.client.close().catch(() => undefined);
};

const requireCodexSessionModel = (session: CodexClientSession, requestedModel: string): string => {
  const confirmedModel = session.model;
  if (confirmedModel !== requestedModel) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      `Codex host confirmed model ${confirmedModel} instead of configured model ${requestedModel}.`,
    );
  }
  return confirmedModel;
};

const runCodexTurn = async (
  session: CodexClientSession,
  request: ProviderExecutionRequest,
  onTextDelta?: (delta: string) => void,
  onProcessDelta?: (delta: string) => void,
): Promise<CodexTurnResult> => {
  const thread = session.initialThread ?? (await session.client.startThread());
  session.initialThread = undefined;
  if (thread.model !== session.model) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      `Codex host confirmed model ${thread.model} instead of session model ${session.model}.`,
    );
  }
  const turnPayload = requestTurnInput(request);
  const outputFormat = structuredOutputFormat(request);
  const outputSchema =
    outputFormat?.type === "json_schema" && isRecord(outputFormat.schema)
      ? outputFormat.schema
      : outputFormat?.type === "json_object"
        ? { type: "object" }
        : undefined;
  const result = await session.client.prompt(
    thread.id,
    turnPayload.input,
    request.signal,
    onTextDelta,
    requestReasoningEffort(request),
    onProcessDelta,
    turnPayload.historyItems,
    outputSchema,
  );
  if (result.status !== "completed") {
    throw new Error("The current host model did not complete the request.");
  }
  return { ...result, text: requireValidHostModelText(request, result.text) };
};

const reportCodexExecution = (
  request: ProviderExecutionRequest,
  model: string,
  usage: CodexTurnResult["usage"],
): void => {
  request.onExecutionReceipt?.({
    host: request.routing?.host ?? "codex",
    model,
    role: request.routing?.role ?? "main",
    capabilities:
      request.routing?.availableCapabilities ?? request.routing?.requiredCapabilities ?? [],
    usage,
  });
};

export interface CodexHostConfiguration {
  /** Effective model selected by the Codex app-server for a new thread. */
  model: string;
  /** Non-secret account metadata reported by the Codex app-server. */
  account: CodexAccountSummary | null;
}

export interface CodexHostAccountReport {
  /** Host-owned, non-secret account metadata. */
  account: CodexAccountSummary | null;
  /** Official account quota and token totals, or null when unavailable. */
  usage: CodexUsageSummary | null;
}

export const inspectCodexHostAccountReport = async (
  timeoutMilliseconds = 15_000,
): Promise<CodexHostAccountReport | null> => {
  if (!(await inspectCodexHostLoginAsync({ timeoutMilliseconds })).reusable) return null;
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-account-report-"));
  const client = createCodexAgentClient({
    workingDirectory,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        const account = await client.readAccount().catch(() => null);
        const usage = await client.readUsage().catch(() => null);
        return { account, usage };
      })(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.close().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const inspectCodexHostConfiguration = async (
  modelOverride?: string,
): Promise<CodexHostConfiguration | undefined> => {
  if (!inspectCodexHostLogin().reusable) {
    return undefined;
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-discovery-"));
  const client = createCodexAgentClient({
    workingDirectory,
    model: modelOverride,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  let model: string;
  let account: CodexAccountSummary | null = null;
  try {
    await client.initialize();
    model = (await client.startThread()).model;
    account = await client.readAccount().catch(() => null);
  } catch {
    return undefined;
  } finally {
    try {
      await client.close().catch(() => undefined);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { model, account };
};

export const createCodexHostModelProvider = async (
  modelOverride?: string,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<ModelProvider | undefined> => {
  if (!inspectCodexHostLogin(hostOptions).reusable) return undefined;
  let initialSession: CodexClientSession;
  try {
    initialSession = await createCodexClientSession(modelOverride, hostOptions);
  } catch {
    return undefined;
  }
  const initialModel = initialSession.initialThread?.model;
  if (initialModel === undefined) {
    await closeCodexClientSession(initialSession);
    return undefined;
  }
  if (modelOverride !== undefined && initialModel !== modelOverride) {
    await closeCodexClientSession(initialSession);
    return undefined;
  }
  const sessions = new Map<string, Promise<CodexClientSession>>();
  const initialSessionPromise = Promise.resolve(initialSession);
  sessions.set(initialModel, initialSessionPromise);
  const resolveSession = (request: ProviderExecutionRequest): Promise<CodexClientSession> => {
    const requestedModel =
      request.routing?.targetModel ??
      (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
        ? request.body.model
        : (modelOverride ?? initialModel));
    const current = sessions.get(requestedModel);
    if (current !== undefined) return current;
    const created = createCodexClientSession(requestedModel, hostOptions)
      .then(async (session) => {
        try {
          requireCodexSessionModel(session, requestedModel);
          return session;
        } catch (error) {
          await closeCodexClientSession(session);
          throw error;
        }
      })
      .catch((error: unknown) => {
        sessions.delete(requestedModel);
        throw error;
      });
    sessions.set(requestedModel, created);
    return created;
  };

  return {
    descriptor: { type: "codex-host", model: initialModel },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const unsupported = findUnsupportedHostBridgeRequest(request, true);
      if (unsupported !== undefined) return unsupported;
      const sessionPromise = resolveSession(request);
      const session = await sessionPromise;
      const requestedModel =
        request.routing?.targetModel ??
        (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
          ? request.body.model
          : (modelOverride ?? initialModel));
      const upstreamModel = requireCodexSessionModel(session, requestedModel);
      request.onModelConfirmed?.(upstreamModel);
      const invalidateFailedSession = async (): Promise<void> => {
        if (request.signal?.aborted) return;
        for (const [model, candidate] of sessions) {
          if (candidate === sessionPromise) sessions.delete(model);
        }
        await closeCodexClientSession(session);
      };
      try {
        if (request.body.stream === true) {
          return {
            kind: "stream",
            statusCode: 200,
            upstreamModel,
            stream: createLiveJsonStream(request, async (onTextDelta, onProcessDelta) => {
              try {
                const result = await runCodexTurn(session, request, onTextDelta, onProcessDelta);
                reportCodexExecution(request, upstreamModel, result.usage);
                return { text: result.text, usage: result.usage };
              } catch (error) {
                await invalidateFailedSession();
                throw error;
              }
            }),
          };
        }
        const result = await runCodexTurn(session, request);
        reportCodexExecution(request, upstreamModel, result.usage);
        return {
          kind: "json",
          statusCode: 200,
          upstreamModel,
          body: createResponse(request, result.text, undefined, result.usage),
        };
      } catch (error) {
        await invalidateFailedSession();
        throw error;
      }
    },
    close: async () => {
      const settledSessions = await Promise.allSettled(new Set(sessions.values()));
      const uniqueSessions = new Set(
        settledSessions.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      );
      await Promise.all([...uniqueSessions].map((session) => closeCodexClientSession(session)));
      sessions.clear();
    },
  };
};

export const createCursorHostModelProvider = async (): Promise<ModelProvider | undefined> => {
  if (!(await inspectCursorHostLoginAsync()).reusable) {
    return undefined;
  }
  const discoveryDirectory = await mkdtemp(join(tmpdir(), "tidu-cursor-model-discovery-"));
  const discoveryClient = createCursorAcpClient({
    workingDirectory: discoveryDirectory,
    mode: "ask",
  });
  let model: string | null = null;
  let availableModels: readonly CursorAcpModel[] = [];
  const discoverySignal = AbortSignal.timeout(CURSOR_DISCOVERY_TIMEOUT_MILLISECONDS);
  try {
    await discoveryClient.initialize(discoverySignal);
    const session = await discoveryClient.createSession(discoverySignal);
    model = session.model;
    availableModels = session.availableModels;
  } catch {
    return undefined;
  } finally {
    try {
      await discoveryClient.close().catch(() => undefined);
    } finally {
      await rm(discoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (model === null) return undefined;
  const models = createCursorModelCatalog(model, availableModels);
  return {
    descriptor: { type: "cursor-host", model },
    listModels: async () => models,
    execute: async (request): Promise<ProviderExecutionResult> => {
      const unsupported = findUnsupportedHostBridgeRequest(request);
      if (unsupported !== undefined) return unsupported;
      const requestedModel =
        request.routing?.targetModel ??
        (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
          ? request.body.model
          : undefined);
      if (
        requestedModel !== undefined &&
        !models.some((candidate) => candidate.id === requestedModel)
      ) {
        return {
          kind: "json",
          statusCode: 400,
          body: {
            error: {
              code: "cursor_model_unavailable",
              message: `Configured Cursor model ${requestedModel} is not available in the current Cursor catalog.`,
              type: "invalid_request_error",
            },
          },
        };
      }
      const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
      const client = createCursorAcpClient({
        workingDirectory,
        mode: "ask",
        requestedModel,
        onProcessDelta: request.onProcessDelta,
      });
      const closeClient = async (): Promise<void> => {
        try {
          await client.close();
        } finally {
          await rm(workingDirectory, { recursive: true, force: true });
        }
      };
      const createConfirmedSession = async () => {
        await client.initialize(request.signal);
        const session = await client.createSession(request.signal);
        if (session.model === null) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "Cursor ACP did not confirm the model selected for this session.",
          );
        }
        return { ...session, model: session.model };
      };
      const run = async (
        session: Awaited<ReturnType<typeof createConfirmedSession>>,
        onTextDelta?: (delta: string) => void,
      ): Promise<string> => {
        const result = await client.prompt(
          session.id,
          requestPrompt(request),
          request.signal,
          onTextDelta,
        );
        return requireValidHostModelText(
          request,
          requireCompletedCursorPrompt(session.model, result),
        );
      };
      let session: Awaited<ReturnType<typeof createConfirmedSession>>;
      try {
        session = await createConfirmedSession();
        request.onModelConfirmed?.(session.model);
      } catch (error) {
        await closeClient().catch(() => undefined);
        throw error;
      }
      if (request.body.stream === true) {
        return {
          kind: "stream",
          statusCode: 200,
          upstreamModel: session.model,
          stream: createLiveJsonStream(request, async (onTextDelta) => {
            try {
              const text = await run(session, onTextDelta);
              request.onExecutionReceipt?.({
                host: request.routing?.host ?? "cursor",
                model: session.model,
                role: request.routing?.role ?? "main",
                capabilities:
                  request.routing?.availableCapabilities ??
                  request.routing?.requiredCapabilities ??
                  [],
                usage: null,
              });
              return text;
            } finally {
              await closeClient();
            }
          }),
        };
      }
      try {
        const text = await run(session);
        request.onExecutionReceipt?.({
          host: request.routing?.host ?? "cursor",
          model: session.model,
          role: request.routing?.role ?? "main",
          capabilities:
            request.routing?.availableCapabilities ?? request.routing?.requiredCapabilities ?? [],
          usage: null,
        });
        return {
          kind: "json",
          statusCode: 200,
          upstreamModel: session.model,
          body: createResponse(request, text),
        };
      } finally {
        try {
          await client.close();
        } finally {
          await rm(workingDirectory, { recursive: true, force: true });
        }
      }
    },
  };
};

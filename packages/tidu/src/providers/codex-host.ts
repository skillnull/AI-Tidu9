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
  type CodexTurnResult,
  type CodexUsageSummary,
  createCodexAgentClient,
} from "../connectors/codex-app-server.js";
import { type CursorAcpModel, createCursorAcpClient } from "../connectors/cursor-acp.js";
import { requestRequiresToolExecution } from "../openai/index.js";
import type { ModelProvider, ProviderExecutionRequest, ProviderExecutionResult } from "./index.js";

const CODEX_TURN_TIMEOUT_MILLISECONDS = 5 * 60_000;
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

const imageTypes = new Set(["image", "image_url", "input_image"]);

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
): ProviderExecutionResult | undefined => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  if (containsImageContent(conversation)) {
    return {
      kind: "json",
      statusCode: 400,
      body: {
        error: {
          code: "host_bridge_image_unsupported",
          message: "The Codex and Cursor text bridge does not support image input.",
          type: "invalid_request_error",
        },
      },
    };
  }
  if (requestRequiresToolExecution(request.body)) {
    return {
      kind: "json",
      statusCode: 400,
      body: {
        error: {
          code: "host_bridge_tools_unsupported",
          message: "The Codex and Cursor text bridge cannot satisfy a required tool call.",
          type: "invalid_request_error",
        },
      },
    };
  }
  return undefined;
};

export const requestPrompt = (request: ProviderExecutionRequest): string => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const instructions = [
    "Answer this single model request using the conversation and instructions supplied below.",
    "Do not use tools, access files, or perform actions. Return only the assistant response.",
  ];
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
  return `${instructions.join(" ")}${callerInstructions}\n\nConversation:\n${JSON.stringify(conversation)}`;
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
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
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
    status: "completed",
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
  run: (onTextDelta: (delta: string) => void) => Promise<string>,
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
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
      void run((delta) => {
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
      })
        .then((text) => {
          if (!streamOpen) return;
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
                response: createResponse(request, text, responseId),
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
  /** Temporary read-only working directory owned by this session. */
  workingDirectory: string;
  /** First empty thread created during model discovery and reused by the first request. */
  initialThread?: CodexThread;
}

const createCodexClientSession = async (
  model?: string,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<CodexClientSession> => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
  const client = createCodexAgentClient({
    ...hostOptions,
    workingDirectory,
    ...(model === undefined ? {} : { model }),
    modelProvider: hostOptions.modelProvider ?? "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  try {
    await client.initialize();
    return {
      client,
      workingDirectory,
      initialThread: await client.startThread(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const closeCodexClientSession = async (session: CodexClientSession): Promise<void> => {
  await session.client.close().catch(() => undefined);
  await rm(session.workingDirectory, { recursive: true, force: true }).catch(() => undefined);
};

const runCodexTurn = async (
  session: CodexClientSession,
  request: ProviderExecutionRequest,
  onTextDelta?: (delta: string) => void,
): Promise<CodexTurnResult> => {
  const thread = session.initialThread ?? (await session.client.startThread());
  session.initialThread = undefined;
  const signal =
    request.signal === undefined
      ? AbortSignal.timeout(CODEX_TURN_TIMEOUT_MILLISECONDS)
      : AbortSignal.any([request.signal, AbortSignal.timeout(CODEX_TURN_TIMEOUT_MILLISECONDS)]);
  const result = await session.client.prompt(
    thread.id,
    requestPrompt(request),
    signal,
    onTextDelta,
    requestReasoningEffort(request),
  );
  if (result.status !== "completed") {
    throw new Error("The current host model did not complete the request.");
  }
  return { ...result, text: requireValidHostModelText(request, result.text) };
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
  const sessions = new Map<string, Promise<CodexClientSession>>();
  const initialSessionPromise = Promise.resolve(initialSession);
  sessions.set(initialModel, initialSessionPromise);
  if (modelOverride !== undefined) {
    sessions.set(modelOverride, initialSessionPromise);
  }
  const resolveSession = (request: ProviderExecutionRequest): Promise<CodexClientSession> => {
    const requestedModel =
      request.routing?.targetModel ??
      (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
        ? request.body.model
        : (modelOverride ?? initialModel));
    const current = sessions.get(requestedModel);
    if (current !== undefined) return current;
    const created = createCodexClientSession(requestedModel, hostOptions).catch(
      (error: unknown) => {
        sessions.delete(requestedModel);
        throw error;
      },
    );
    sessions.set(requestedModel, created);
    return created;
  };

  return {
    descriptor: { type: "codex-host", model: initialModel },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const unsupported = findUnsupportedHostBridgeRequest(request);
      if (unsupported !== undefined) return unsupported;
      const sessionPromise = resolveSession(request);
      const session = await sessionPromise;
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
            stream: createLiveJsonStream(request, async (onTextDelta) => {
              try {
                return (await runCodexTurn(session, request, onTextDelta)).text;
              } catch (error) {
                await invalidateFailedSession();
                throw error;
              }
            }),
          };
        }
        const result = await runCodexTurn(session, request);
        return {
          kind: "json",
          statusCode: 200,
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
      const client = createCursorAcpClient({ workingDirectory, mode: "ask", requestedModel });
      const closeClient = async (): Promise<void> => {
        try {
          await client.close();
        } finally {
          await rm(workingDirectory, { recursive: true, force: true });
        }
      };
      const run = async (onTextDelta?: (delta: string) => void): Promise<string> => {
        await client.initialize(request.signal);
        const session = await client.createSession(request.signal);
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
      if (request.body.stream === true) {
        return {
          kind: "stream",
          statusCode: 200,
          stream: createLiveJsonStream(request, async (onTextDelta) => {
            try {
              return await run(onTextDelta);
            } finally {
              await closeClient();
            }
          }),
        };
      }
      try {
        return {
          kind: "json",
          statusCode: 200,
          body: createResponse(request, await run()),
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

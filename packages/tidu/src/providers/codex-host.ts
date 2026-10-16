import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexHostLogin } from "../accounts/codex-host.js";
import { inspectCursorHostLogin } from "../accounts/cursor-host.js";
import {
  type CodexAccountSummary,
  type CodexAgentClient,
  type CodexThread,
  type CodexUsageSummary,
  createCodexAgentClient,
} from "../connectors/codex-app-server.js";
import { createCursorAcpClient } from "../connectors/cursor-acp.js";
import type { ModelProvider, ProviderExecutionRequest, ProviderExecutionResult } from "./index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestPrompt = (request: ProviderExecutionRequest): string => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const instructions = [
    "Answer this single model request using the conversation and instructions supplied below.",
    "Do not use tools, access files, or perform actions. Return only the assistant response.",
  ];
  if (
    isRecord(request.body.response_format) &&
    request.body.response_format.type === "json_object"
  ) {
    instructions.push("Return a valid JSON object only, with no markdown fences or extra text.");
  }
  return `${instructions.join(" ")}\n\nConversation:\n${JSON.stringify(conversation)}`;
};

const responseModel = (request: ProviderExecutionRequest): string =>
  typeof request.body.model === "string" ? request.body.model : request.virtualModelId;

const createResponse = (
  request: ProviderExecutionRequest,
  text: string,
  responseId = `tidu_${randomUUID()}`,
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
  };
};

const createLiveJsonStream = (
  request: ProviderExecutionRequest,
  run: (onTextDelta: (delta: string) => void) => Promise<string>,
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let firstChatDelta = true;
      const write = (event: string): void => controller.enqueue(encoder.encode(event));
      void run((delta) => {
        if (request.protocol === "chat-completions") {
          write(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1_000),
              model: responseModel(request),
              choices: [
                {
                  index: 0,
                  delta: { ...(firstChatDelta ? { role: "assistant" } : {}), content: delta },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          firstChatDelta = false;
          return;
        }
        write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
        );
      })
        .then((text) => {
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
          write("data: [DONE]\n\n");
          controller.close();
        })
        .catch((error: unknown) => controller.error(error));
    },
  });
};

const createJsonStream = (
  request: ProviderExecutionRequest,
  text: string,
): ReadableStream<Uint8Array> =>
  createLiveJsonStream(request, async (onTextDelta) => {
    onTextDelta(text);
    return text;
  });

interface CodexClientSession {
  /** Initialized long-lived official Codex app-server client. */
  client: CodexAgentClient;
  /** Temporary read-only working directory owned by this session. */
  workingDirectory: string;
  /** First empty thread created during model discovery and reused by the first request. */
  initialThread?: CodexThread;
}

const createCodexClientSession = async (model?: string): Promise<CodexClientSession> => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
  const client = createCodexAgentClient({
    workingDirectory,
    ...(model === undefined ? {} : { model }),
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  try {
    await client.initialize();
    return { client, workingDirectory, initialThread: await client.startThread() };
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
): Promise<string> => {
  const thread = session.initialThread ?? (await session.client.startThread());
  session.initialThread = undefined;
  const result = await session.client.prompt(
    thread.id,
    requestPrompt(request),
    request.signal,
    onTextDelta,
  );
  if (result.status !== "completed") {
    throw new Error("The current host model did not complete the request.");
  }
  return result.text;
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

export const inspectCodexHostAccountReport = async (): Promise<CodexHostAccountReport | null> => {
  if (!inspectCodexHostLogin().reusable) return null;
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-account-report-"));
  const client = createCodexAgentClient({
    workingDirectory,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  try {
    await client.initialize();
    const account = await client.readAccount().catch(() => null);
    const usage = await client.readUsage().catch(() => null);
    return { account, usage };
  } finally {
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
): Promise<ModelProvider | undefined> => {
  if (!inspectCodexHostLogin().reusable) return undefined;
  let initialSession: CodexClientSession;
  try {
    initialSession = await createCodexClientSession(modelOverride);
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
  if (modelOverride !== undefined) sessions.set(modelOverride, initialSessionPromise);

  const resolveSession = (request: ProviderExecutionRequest): Promise<CodexClientSession> => {
    const requestedModel =
      request.routing?.targetModel ??
      (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
        ? request.body.model
        : (modelOverride ?? initialModel));
    const current = sessions.get(requestedModel);
    if (current !== undefined) return current;
    const created = createCodexClientSession(requestedModel).catch((error: unknown) => {
      sessions.delete(requestedModel);
      throw error;
    });
    sessions.set(requestedModel, created);
    return created;
  };

  return {
    descriptor: { type: "codex-host", model: initialModel },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const session = await resolveSession(request);
      if (request.body.stream === true) {
        return {
          kind: "stream",
          statusCode: 200,
          stream: createLiveJsonStream(request, (onTextDelta) =>
            runCodexTurn(session, request, onTextDelta),
          ),
        };
      }
      const text = await runCodexTurn(session, request);
      return {
        kind: "json",
        statusCode: 200,
        body: createResponse(request, text),
      };
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
  if (!inspectCursorHostLogin().reusable) {
    return undefined;
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-cursor-model-discovery-"));
  const client = createCursorAcpClient({ workingDirectory, mode: "ask" });
  let model: string | undefined;
  try {
    await client.initialize();
    model = (await client.createSession()).model ?? undefined;
  } catch {
    return undefined;
  } finally {
    try {
      await client.close().catch(() => undefined);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (model === undefined) return undefined;
  return {
    descriptor: { type: "cursor-host", model },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
      const client = createCursorAcpClient({ workingDirectory, mode: "ask" });
      try {
        await client.initialize();
        const session = await client.createSession();
        const result = await client.prompt(session.id, requestPrompt(request), request.signal);
        if (result.text.trim() === "") {
          throw new Error("The current Cursor model returned an empty response.");
        }
        if (request.body.stream === true) {
          return {
            kind: "stream",
            statusCode: 200,
            stream: createJsonStream(request, result.text),
          };
        }
        return {
          kind: "json",
          statusCode: 200,
          body: createResponse(request, result.text),
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

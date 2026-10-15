import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexHostLogin } from "../accounts/codex-host.js";
import { inspectCursorHostLogin } from "../accounts/cursor-host.js";
import {
  type CodexAccountSummary,
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

const createResponse = (request: ProviderExecutionRequest, text: string): unknown => {
  const responseId = `tidu_${randomUUID()}`;
  if (request.protocol === "chat-completions") {
    return {
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.virtualModelId,
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
    model: request.virtualModelId,
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

const createJsonStream = (
  request: ProviderExecutionRequest,
  text: string,
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
  const encoder = new TextEncoder();
  const events =
    request.protocol === "chat-completions"
      ? [
          {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.virtualModelId,
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
            ],
          },
          {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: request.virtualModelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`)
      : [
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: createResponse(request, text) })}\n\n`,
        ];
  events.push("data: [DONE]\n\n");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
};

const runCodexTurn = async (request: ProviderExecutionRequest, model?: string): Promise<string> => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
  const client = createCodexAgentClient({
    workingDirectory,
    ...(model === undefined ? {} : { model }),
    ephemeral: true,
    sandbox: "read-only",
  });
  try {
    await client.initialize();
    const thread = await client.startThread();
    const result = await client.prompt(thread.id, requestPrompt(request), request.signal);
    if (result.status !== "completed") {
      throw new Error("The current host model did not complete the request.");
    }
    return result.text;
  } finally {
    try {
      await client.close();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
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
  const configuration = await inspectCodexHostConfiguration(modelOverride);
  if (configuration === undefined) return undefined;

  return {
    descriptor: { type: "codex-host", model: configuration.model },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const text = await runCodexTurn(request, modelOverride);
      if (request.body.stream === true) {
        return { kind: "stream", statusCode: 200, stream: createJsonStream(request, text) };
      }
      return { kind: "json", statusCode: 200, body: createResponse(request, text) };
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
        return { kind: "json", statusCode: 200, body: createResponse(request, result.text) };
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

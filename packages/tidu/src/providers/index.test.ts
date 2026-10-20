import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TiduError } from "../core/index.js";
import {
  createCodexHostModelProvider,
  createCursorModelCatalog,
  createLiveJsonStream,
  findUnsupportedHostBridgeRequest,
  requestPrompt,
  requireCompletedCursorPrompt,
  requireValidHostModelText,
} from "./codex-host.js";
import {
  createCatalogModelRouter,
  createOllamaProvider,
  createOpenAiCompatibleProvider,
  createProviderFromEnvironment,
  discoverOllamaModels,
  type ModelProvider,
} from "./index.js";

const readStreamText = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const createFakeCodexProviderCommand = (directory: string): string => {
  const executable = join(directory, "fake-codex-provider");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
const fs = require("node:fs");
fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "start\\n");
let turnCount = 0;
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "thread/start") send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-1" }, model: "gpt-test" } });
  else if (request.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "effort:" + request.params.effort + "\\n");
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "item-1", delta: request.params.effort + "-result" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  }
  else send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
};

interface TestServer {
  /** Loopback origin allocated for the test server. */
  origin: string;
  /** Closes the server and releases its socket. */
  close: () => Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const startTestServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
};

test("publishes only text-contract capabilities for Cursor ACP models", () => {
  assert.deepEqual(createCursorModelCatalog("cursor-default", ["cursor-default", "cursor-fast"]), [
    {
      id: "cursor-default",
      name: "cursor-default",
      capabilities: ["text", "structured-output", "code"],
      capabilitySource: "provider-catalog",
    },
    {
      id: "cursor-fast",
      name: "cursor-fast",
      capabilities: ["text", "structured-output", "code"],
      capabilitySource: "provider-catalog",
    },
  ]);
  assert.deepEqual(createCursorModelCatalog("cursor-current", ["cursor-fast"])[0], {
    id: "cursor-current",
    name: "cursor-current",
    capabilities: ["text", "structured-output", "code"],
    capabilitySource: "provider-catalog",
  });
});

test("preserves Responses instructions and JSON format constraints in host prompts", () => {
  const request = {
    protocol: "responses" as const,
    body: {
      model: "ai-tidu9-config",
      instructions: "Use the caller's requested field names.",
      input: "Summarize the result.",
      text: {
        format: {
          type: "json_schema",
          name: "summary",
          schema: { type: "object", required: ["summary"] },
        },
      },
    },
    virtualModelId: "ai-tidu9-config",
  };
  const prompt = requestPrompt(request);

  assert.match(prompt, /Caller instructions:\nUse the caller's requested field names\./u);
  assert.match(prompt, /"type":"json_schema"/u);
  assert.match(prompt, /"required":\["summary"\]/u);
  assert.equal(requireValidHostModelText(request, '{"summary":"done"}'), '{"summary":"done"}');
  assert.throws(() => requireValidHostModelText(request, "not json"), /did not return valid JSON/u);
});

test("fails closed for image and tool requests unsupported by host text bridges", () => {
  const baseRequest = {
    protocol: "responses" as const,
    virtualModelId: "ai-tidu9-config",
  };
  const imageResult = findUnsupportedHostBridgeRequest({
    ...baseRequest,
    body: {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,test" }],
        },
      ],
    },
  });
  const toolResult = findUnsupportedHostBridgeRequest({
    ...baseRequest,
    body: {
      input: "Use a tool.",
      tools: [{ type: "function", name: "lookup" }],
      tool_choice: "auto",
    },
  });
  const disabledToolResult = findUnsupportedHostBridgeRequest({
    ...baseRequest,
    body: {
      input: "Do not use a tool.",
      tools: [{ type: "function", name: "lookup" }],
      tool_choice: "none",
    },
  });

  assert.equal(imageResult?.statusCode, 400);
  assert.match(JSON.stringify(imageResult), /host_bridge_image_unsupported/u);
  assert.equal(toolResult?.statusCode, 400);
  assert.match(JSON.stringify(toolResult), /host_bridge_tools_unsupported/u);
  assert.equal(disabledToolResult, undefined);
});

test("reuses one Codex model session while forwarding effort and live deltas per turn", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-codex-provider-"));
  const codexHomeDirectory = join(temporaryDirectory, "codex-home");
  const processLog = join(temporaryDirectory, "provider.log");
  mkdirSync(codexHomeDirectory, { recursive: true });
  const command = createFakeCodexProviderCommand(temporaryDirectory);
  const provider = await createCodexHostModelProvider(undefined, {
    codexHomeDirectory,
    command,
    environment: { TIDU_CODEX_PROVIDER_TEST_LOG: processLog },
  });
  try {
    assert.notEqual(provider, undefined);
    if (provider === undefined) throw new Error("Expected a Codex host provider.");
    const lowResult = await provider.execute({
      protocol: "responses",
      body: {
        model: "ai-tidu9-config",
        input: "low request",
        reasoning: { effort: "low" },
      },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(lowResult.kind, "json");
    assert.match(JSON.stringify(lowResult), /low-result/u);

    const highResult = await provider.execute({
      protocol: "responses",
      body: {
        model: "ai-tidu9-config",
        input: "high request",
        reasoning: { effort: "high" },
        stream: true,
      },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(highResult.kind, "stream");
    if (highResult.kind !== "stream") throw new Error("Expected a streaming provider result.");
    const streamBody = await readStreamText(highResult.stream);
    assert.match(streamBody, /response\.output_text\.delta/u);
    assert.match(streamBody, /high-result/u);
    assert.match(streamBody, /response\.completed/u);
    assert.match(streamBody, /data: \[DONE\]/u);

    await provider.close?.();
    assert.deepEqual(readFileSync(processLog, "utf8").trim().split("\n"), [
      "start",
      "effort:low",
      "effort:high",
    ]);
  } finally {
    await provider?.close?.();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rejects Cursor prompts unless ACP reports a non-empty end_turn", () => {
  assert.equal(
    requireCompletedCursorPrompt("cursor-model", {
      stopReason: "end_turn",
      text: "complete response",
    }),
    "complete response",
  );
  assert.throws(
    () =>
      requireCompletedCursorPrompt("cursor-model", {
        stopReason: "cancelled",
        text: "partial response",
      }),
    /stopped with cancelled/u,
  );
  assert.throws(
    () =>
      requireCompletedCursorPrompt("cursor-model", {
        stopReason: "end_turn",
        text: "  ",
      }),
    /returned an empty response/u,
  );
});

test("terminates failed host streams with response.failed and DONE", async () => {
  const stream = createLiveJsonStream(
    {
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "hello", stream: true },
      virtualModelId: "ai-tidu9-config",
    },
    async (onTextDelta) => {
      onTextDelta("partial");
      throw new Error("Cursor model cursor-test stopped with cancelled.");
    },
  );
  const body = await readStreamText(stream);

  assert.match(body, /event: response\.output_text\.delta/u);
  assert.match(body, /event: response\.failed/u);
  assert.match(body, /host_model_failed/u);
  assert.match(body, /data: \[DONE\]/u);
  assert.doesNotMatch(body, /event: response\.completed/u);
});

test("ignores late host deltas and failures after the consumer cancels the stream", async () => {
  let emitDelta: (delta: string) => void = () => undefined;
  let rejectRun: (reason: Error) => void = () => undefined;
  const runResult = new Promise<string>((_resolve, reject) => {
    rejectRun = reject;
  });
  const stream = createLiveJsonStream(
    {
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "hello", stream: true },
      virtualModelId: "ai-tidu9-config",
    },
    (onTextDelta) => {
      emitDelta = onTextDelta;
      onTextDelta("first");
      return runResult;
    },
  );
  const reader = stream.getReader();
  const firstChunk = await reader.read();

  assert.equal(firstChunk.done, false);
  assert.match(new TextDecoder().decode(firstChunk.value), /first/u);
  await reader.cancel("test cancellation");
  assert.doesNotThrow(() => emitDelta("late"));
  rejectRun(new Error("late host failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("routes official catalog models separately from company and virtual models", async () => {
  const calls: string[] = [];
  const createProvider = (label: string): ModelProvider => ({
    descriptor: { type: "openai-compatible", model: `${label}-upstream` },
    execute: async (request) => {
      calls.push(`${label}:${String(request.body.model)}`);
      return { kind: "json", statusCode: 200, body: { label } };
    },
  });
  const router = createCatalogModelRouter({
    defaultProvider: createProvider("company"),
    officialProvider: createProvider("official"),
  });

  for (const [model, modelSource] of [
    ["ai-tidu9-config", "company"],
    ["company-service-model", "company"],
    ["gpt-official", "official"],
  ] as const) {
    await router.execute({
      protocol: "responses",
      body: { model, input: "hello" },
      virtualModelId: "ai-tidu9-config",
      routing: { modelSource },
    });
  }

  assert.deepEqual(calls, [
    "company:ai-tidu9-config",
    "company:company-service-model",
    "official:gpt-official",
  ]);
});

test("forwards OpenAI-compatible requests without exposing provider identity", async () => {
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedPath = request.url ?? "";
      receivedAuthorization = request.headers.authorization ?? "";
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-upstream",
          object: "chat.completion",
          model: "upstream-model",
          choices: [],
        }),
      );
    });
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${server.origin}/v1`,
      model: "upstream-model",
      apiKey: "test-only-secret",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
      },
      virtualModelId: "ai-tidu9-config",
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.kind, "json");
    if (result.kind !== "json") {
      throw new Error("Expected a JSON provider result.");
    }
    assert.equal(receivedPath, "/v1/chat/completions");
    assert.equal(receivedAuthorization, "Bearer test-only-secret");
    assert.equal(receivedBody.model, "upstream-model");
    assert.equal((result.body as { model: string }).model, "ai-tidu9-config");
    assert.deepEqual(provider.descriptor, {
      type: "openai-compatible",
      model: "upstream-model",
    });
    assert.equal("apiKey" in provider.descriptor, false);
    assert.equal("baseUrl" in provider.descriptor, false);
  } finally {
    await server.close();
  }
});

test("preserves provider-specific API versions in compatible base URLs", async () => {
  let receivedPath = "";
  const server = await startTestServer((request, response) => {
    void readBody(request).then(() => {
      receivedPath = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [] }));
    });
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${server.origin}/api/v4`,
      model: "provider-model",
    });
    await provider.execute({
      protocol: "chat-completions",
      body: { messages: [{ role: "user", content: "hello" }] },
      virtualModelId: "virtual-model",
    });
    assert.equal(receivedPath, "/api/v4/chat/completions");
  } finally {
    await server.close();
  }
});

test("preserves capabilities and prices published by a compatible model catalog", async () => {
  const server = await startTestServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          {
            id: "company-vision",
            name: "Company Vision",
            capabilities: ["text", "vision"],
            inputCostPerMillionTokens: 0.2,
            outputCostPerMillionTokens: 0.8,
          },
        ],
      }),
    );
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: server.origin,
      model: "company-vision",
    });
    assert.deepEqual(await provider.listModels?.(), [
      {
        id: "company-vision",
        name: "Company Vision",
        capabilities: ["text", "vision"],
        capabilitySource: "company-published",
        inputCostPerMillionTokens: 0.2,
        outputCostPerMillionTokens: 0.8,
      },
    ]);
  } finally {
    await server.close();
  }
});

test("translates Ollama chat and Responses payloads into the virtual model contract", async () => {
  const receivedBodies: Record<string, unknown>[] = [];
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "qwen-test",
          done: true,
          message: { role: "assistant", content: "local result" },
          prompt_eval_count: 7,
          eval_count: 3,
        }),
      );
    });
  });

  try {
    const provider = createOllamaProvider({
      baseUrl: server.origin,
      model: "qwen-test",
    });
    const chat = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
      },
      virtualModelId: "ai-tidu9-config",
    });
    const responses = await provider.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "hello again" },
      virtualModelId: "ai-tidu9-config",
    });

    assert.equal(chat.kind, "json");
    assert.equal(responses.kind, "json");
    if (chat.kind !== "json" || responses.kind !== "json") {
      throw new Error("Expected JSON provider results.");
    }
    assert.equal(chat.statusCode, 200);
    assert.equal((chat.body as { model: string }).model, "ai-tidu9-config");
    assert.deepEqual((chat.body as { usage: unknown }).usage, {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
    assert.equal(responses.statusCode, 200);
    assert.equal((responses.body as { model: string }).model, "ai-tidu9-config");
    assert.equal((responses.body as { output_text: string }).output_text, "local result");
    assert.equal(receivedBodies.length, 2);
    assert.equal(receivedBodies[0]?.model, "qwen-test");
    assert.equal(receivedBodies[0]?.stream, false);
    assert.deepEqual(receivedBodies[1]?.messages, [{ role: "user", content: "hello again" }]);
  } finally {
    await server.close();
  }
});

test("normalizes Ollama function calls and tool-result continuation messages", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          done: true,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-next",
                function: { name: "lookup", arguments: { city: "Beijing" } },
              },
            ],
          },
        }),
      );
    });
  });

  try {
    const provider = createOllamaProvider({
      baseUrl: server.origin,
      model: "qwen-test",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-previous",
                type: "function",
                function: { name: "lookup", arguments: '{"city":"Shanghai"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-previous", content: "sunny" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      },
      virtualModelId: "ai-tidu9-config",
    });

    assert.equal(result.kind, "json");
    if (result.kind !== "json") {
      throw new Error("Expected a JSON provider result.");
    }
    const resultBody = result.body as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: null;
          tool_calls: Array<{ function: { arguments: string } }>;
        };
      }>;
    };
    assert.equal(resultBody.choices[0]?.finish_reason, "tool_calls");
    assert.equal(resultBody.choices[0]?.message.content, null);
    assert.equal(
      resultBody.choices[0]?.message.tool_calls[0]?.function.arguments,
      '{"city":"Beijing"}',
    );
    assert.equal(Array.isArray(receivedBody.tools), true);
    const messages = receivedBody.messages as Array<Record<string, unknown>>;
    assert.equal((messages[1] as { tool_name?: string }).tool_name, "lookup");
  } finally {
    await server.close();
  }
});

test("streams OpenAI-compatible SSE while preserving the virtual model identity", async () => {
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      assert.equal(body.stream, true);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"id":"chatcmpl-upstream","model":"upstream-model","choices":[{"delta":{"content":"hello"}}]}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${server.origin}/v1`,
      model: "upstream-model",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      virtualModelId: "ai-tidu9-config",
    });

    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.match(events, /"model":"ai-tidu9-config"/u);
    assert.doesNotMatch(events, /upstream-model/u);
    assert.match(events, /data: \[DONE\]/u);
  } finally {
    await server.close();
  }
});

test("streams Ollama text and function calls as Chat Completions SSE", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({ message: { role: "assistant", content: "working" }, done: false })}\n`,
      );
      response.end(
        `${JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "lookup", arguments: { city: "Shanghai" } } }],
          },
          done: true,
          prompt_eval_count: 5,
          eval_count: 2,
        })}\n`,
      );
    });
  });

  try {
    const provider = createOllamaProvider({
      baseUrl: server.origin,
      model: "qwen-test",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "weather" }],
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
      },
      virtualModelId: "ai-tidu9-config",
    });

    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.equal(receivedBody.stream, true);
    assert.equal(Array.isArray(receivedBody.tools), true);
    assert.match(events, /chat\.completion\.chunk/u);
    assert.match(events, /"model":"ai-tidu9-config"/u);
    assert.match(events, /"name":"lookup"/u);
    assert.match(events, /"finish_reason":"tool_calls"/u);
    assert.match(events, /data: \[DONE\]/u);
  } finally {
    await server.close();
  }
});

test("streams Ollama text as Responses events", async () => {
  const server = await startTestServer((request, response) => {
    void readBody(request).then(() => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        `${JSON.stringify({
          message: { role: "assistant", content: "local response" },
          done: true,
          prompt_eval_count: 4,
          eval_count: 2,
        })}\n`,
      );
    });
  });

  try {
    const provider = createOllamaProvider({
      baseUrl: server.origin,
      model: "qwen-test",
    });
    const result = await provider.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "hello", stream: true },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.match(events, /event: response\.created/u);
    assert.match(events, /event: response\.output_text\.delta/u);
    assert.match(events, /event: response\.completed/u);
    assert.match(events, /"model":"ai-tidu9-config"/u);
  } finally {
    await server.close();
  }
});

test("creates providers from minimal environment configuration", () => {
  const ollama = createProviderFromEnvironment({
    TIDU_PROVIDER: "ollama",
    TIDU_PROVIDER_MODEL: "qwen-test",
  });
  assert.deepEqual(ollama?.descriptor, { type: "ollama", model: "qwen-test" });

  const compatible = createProviderFromEnvironment({
    TIDU_PROVIDER: "openai-compatible",
    TIDU_PROVIDER_MODEL: "gpt-test",
    TIDU_PROVIDER_API_KEY: "runtime-only-secret",
  });
  assert.deepEqual(compatible?.descriptor, {
    type: "openai-compatible",
    model: "gpt-test",
  });
  assert.equal(createProviderFromEnvironment({}), undefined);
});

test("discovers installed models from a running Ollama service", async () => {
  const server = await startTestServer((request, response) => {
    assert.equal(request.url, "/api/tags");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        models: [
          { name: "qwen3:30b", model: "qwen3:30b" },
          { name: "qwen2.5-coder:1.5b-base" },
          { model: "qwen3:30b" },
        ],
      }),
    );
  });

  try {
    assert.deepEqual(await discoverOllamaModels({ baseUrl: server.origin }), [
      "qwen3:30b",
      "qwen2.5-coder:1.5b-base",
    ]);
  } finally {
    await server.close();
  }
});

test("publishes only Ollama capabilities that the adapter forwards", async () => {
  const server = await startTestServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ model: "qwen-vision" }] }));
      return;
    }
    assert.equal(request.url, "/api/show");
    void readBody(request).then((body) => {
      assert.equal(body.model, "qwen-vision");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          capabilities: ["completion", "vision", "tools", "thinking"],
        }),
      );
    });
  });

  try {
    const provider = createOllamaProvider({
      baseUrl: server.origin,
      model: "qwen-vision",
    });
    assert.deepEqual(await provider.listModels?.(), [
      {
        id: "qwen-vision",
        name: "qwen-vision",
        capabilities: ["text", "vision", "tool-use"],
        capabilitySource: "provider-catalog",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("rejects unsafe or incomplete provider environment configuration", () => {
  assert.throws(
    () => createProviderFromEnvironment({ TIDU_PROVIDER: "ollama" }),
    (error) => error instanceof TiduError && error.code === "CONFIGURATION_INVALID",
  );
  assert.throws(
    () =>
      createProviderFromEnvironment({
        TIDU_PROVIDER: "openai-compatible",
        TIDU_PROVIDER_MODEL: "gpt-test",
        TIDU_PROVIDER_BASE_URL: "http://models.example.com/v1",
      }),
    (error) => error instanceof TiduError && error.code === "CONFIGURATION_INVALID",
  );
});

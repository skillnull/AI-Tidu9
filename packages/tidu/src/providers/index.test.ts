import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TiduError } from "../core/index.js";
import {
  createCodexHostModelProvider,
  createCursorHostModelProvider,
  createCursorModelCatalog,
  createLiveJsonStream,
  cursorRoutableCapabilitiesForModel,
  requestCursorPromptContent,
  requestPrompt,
  requestTurnInput,
  requireCompletedCursorPrompt,
  requireValidHostModelText,
  resolveCursorHeadlessModel,
} from "./codex-host.js";
import { createLocalGitProvider } from "./git-local.js";
import {
  createCatalogModelRouter,
  createOllamaProvider,
  createOpenAiCompatibleProvider,
  createProviderFromEnvironment,
  discoverOllamaModels,
  type ModelProvider,
  type ProviderExecutionRequest,
} from "./index.js";

const readStreamText = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const createCommitRequest = (text: string): ProviderExecutionRequest => ({
  protocol: "responses",
  body: { model: "ai-tidu9", input: text },
  virtualModelId: "ai-tidu9",
});

test("executes Git requests locally without invoking the model provider", async () => {
  const repository = mkdtempSync(join(tmpdir(), "tidu-clean-commit-"));
  try {
    const runGit = (...argumentsList: string[]): void => {
      execFileSync("git", argumentsList, { cwd: repository, stdio: "ignore" });
    };
    runGit("init", "--quiet");
    runGit("config", "user.name", "AI-Tidu9 Test");
    runGit("config", "user.email", "test@example.invalid");
    const checkMarker = join(repository, ".git", "check-ran");
    writeFileSync(
      join(repository, "package.json"),
      JSON.stringify({
        scripts: {
          check: "node -e \"require('node:fs').writeFileSync('.git/check-ran', 'passed')\"",
        },
      }),
    );
    writeFileSync(join(repository, "tracked.txt"), "initial\n");
    runGit("add", "package.json", "tracked.txt");
    runGit("commit", "--quiet", "-m", "test: initialize");

    let modelCalls = 0;
    const modelProvider: ModelProvider = {
      descriptor: { type: "openai-compatible", model: "model-test" },
      execute: async () => {
        modelCalls += 1;
        return { kind: "json", statusCode: 200, body: { delegated: true } };
      },
    };
    const provider = createLocalGitProvider(modelProvider, repository);
    const cleanResult = await provider.execute(createCommitRequest("提交"));
    assert.match(JSON.stringify(cleanResult), /没有更新要提交/u);
    assert.equal(modelCalls, 0);

    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const commitResult = await provider.execute(
      createCommitRequest("提交代码\nfix: update tracked file"),
    );
    assert.match(JSON.stringify(commitResult), /已提交/u);
    assert.equal(
      execFileSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      "fix: update tracked file",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }),
      "",
    );
    assert.equal(readFileSync(checkMarker, "utf8"), "passed");
    assert.equal(modelCalls, 0);

    rmSync(checkMarker, { force: true });
    const repeatedCommitResult = await provider.execute(createCommitRequest("提交代码"));
    assert.match(JSON.stringify(repeatedCommitResult), /没有更新要提交/u);
    assert.equal(existsSync(checkMarker), false);
    assert.equal(modelCalls, 0);

    const committedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(repository, "package.json"),
      JSON.stringify({ scripts: { check: 'node -e "process.exit(1)"' } }),
    );
    writeFileSync(join(repository, "tracked.txt"), "blocked\n");
    const blockedCommitResult = await provider.execute(
      createCommitRequest("提交代码\nfix: must not commit"),
    );
    assert.match(JSON.stringify(blockedCommitResult), /Git 命令执行失败/u);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
      committedHead,
    );
    assert.equal(modelCalls, 0);

    const statusRequest = createCommitRequest("git status");
    const statusResult = await provider.execute({
      ...statusRequest,
      body: { ...statusRequest.body, stream: true },
    });
    assert.equal(statusResult.kind, "stream");
    if (statusResult.kind === "stream") {
      assert.match(await readStreamText(statusResult.stream), /response\.completed/u);
    }
    assert.equal(modelCalls, 0);

    const unsupportedResult = await provider.execute(createCommitRequest("请提交并推送"));
    assert.match(JSON.stringify(unsupportedResult), /未识别 Git 操作/u);
    assert.equal(modelCalls, 0);

    await provider.execute(createCommitRequest("解释这段代码"));
    assert.equal(modelCalls, 1);

    await provider.execute({
      protocol: "responses",
      body: {
        model: "ai-tidu9",
        input: [
          { role: "user", content: "git status" },
          { role: "assistant", content: "already completed" },
        ],
      },
      virtualModelId: "ai-tidu9",
    });
    assert.equal(modelCalls, 2);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const createFakeCodexProviderCommand = (directory: string): string => {
  const executable = join(directory, "fake-codex-provider");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
const fs = require("node:fs");
fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "start\\n");
let turnCount = 0;
let threadCount = 0;
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "thread/start") {
    threadCount += 1;
    const requestedModel = request.params.model;
    const confirmedModel = process.env.TIDU_CODEX_PROVIDER_IGNORE_REQUESTED_MODEL === "true"
      ? "gpt-test"
      : requestedModel || (threadCount === 1 ? "gpt-test" : "ai-tidu9-config");
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "threadModel:" + JSON.stringify(requestedModel) + "\\n");
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-" + threadCount }, model: confirmedModel } });
  }
  else if (request.method === "thread/inject_items") {
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "history:" + JSON.stringify(request.params.items) + "\\n");
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
  else if (request.method === "turn/start") {
    turnCount += 1;
    const turnId = "turn-" + turnCount;
    const exitOnceMarker = process.env.TIDU_CODEX_PROVIDER_EXIT_ONCE_MARKER;
    if (exitOnceMarker && !fs.existsSync(exitOnceMarker)) {
      fs.writeFileSync(exitOnceMarker, "exited\\n");
      process.exit(0);
    }
    const finalText = request.params.outputSchema
      ? JSON.stringify({ result: request.params.effort + "-result" })
      : request.params.effort + "-result";
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "effort:" + request.params.effort + "\\n");
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "summary:" + request.params.summary + "\\n");
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "input:" + JSON.stringify(request.params.input) + "\\n");
    fs.appendFileSync(process.env.TIDU_CODEX_PROVIDER_TEST_LOG, "outputSchema:" + JSON.stringify(request.params.outputSchema) + "\\n");
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
    if (process.env.TIDU_CODEX_PROVIDER_DELAY_FIRST_TURN === "true" && turnCount === 1) return;
    if (request.params.input.some((item) => item.type === "image" || item.type === "localImage")) {
      const userMessage = { type: "userMessage", id: "user-" + turnId, clientId: null, content: request.params.input };
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: userMessage } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId, completedAtMs: Date.now(), item: userMessage } });
    }
    if (request.params.summary === "auto") send({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId, itemId: "reasoning-1", summaryIndex: 0, delta: "reasoning-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "commandExecution", id: "command-1", command: "npm test" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "fileChange", id: "file-1", changes: [{ path: "src/index.ts" }] } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "webSearch", id: "search-1", query: "official docs" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "commentary-1", delta: "working-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "final-1", text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "final-1", delta: finalText } });
    send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 } } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
  }
  else if (request.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
  else send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
};

const createFakeCursorProviderCommand = (directory: string): string => {
  const executable = join(directory, "fake-cursor-provider");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status") { console.log("Authenticated"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Agent Client Protocol ACP"); process.exit(0); }
if (args[0] === "--list-models") { console.log("cursor-text-model - Cursor Text (default)"); process.exit(0); }
if (args[0] !== "acp") {
  if (!args.includes("--print") || !args.includes("--trust") || args[args.indexOf("--mode") + 1] !== "ask" || args[args.indexOf("--output-format") + 1] !== "stream-json" || args[args.indexOf("--model") + 1] !== "cursor-text-model") {
    console.error("unexpected Cursor headless arguments");
    process.exit(2);
  }
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "thinking", subtype: "delta", text: "分析普通文本请求" });
    send({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { searchToolCall: { args: { query: "公开资料" } } } });
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Cursor 中文回答" }] } });
    send({ type: "result", subtype: "success", is_error: false, result: "Cursor 中文回答", usage: { inputTokens: 21, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2 } });
  });
  return;
}
let selectedModel = "cursor-text-model";
if (process.env.TIDU_CURSOR_PROVIDER_TEST_LOG) {
  require("node:fs").appendFileSync(process.env.TIDU_CURSOR_PROVIDER_TEST_LOG, "acpProcess\\n");
}
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { agentCapabilities: { promptCapabilities: { image: true } } } });
  else if (request.method === "authenticate") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-1", configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "cursor-text-model", name: "Cursor Text" }] }] } });
  else if (request.method === "session/set_config_option") {
    selectedModel = request.params.value;
    send({ jsonrpc: "2.0", id: request.id, result: { configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel }] } });
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

test("publishes only capabilities routable through the Cursor model path", () => {
  assert.deepEqual(
    createCursorModelCatalog(
      "cursor-default",
      [
        { id: "cursor-default", name: "Cursor Default" },
        {
          id: "cursor-fast",
          name: "Cursor Fast",
          capabilities: ["vision", "vendor-capability", "vision"],
        },
      ],
      { imageInput: true },
    ),
    [
      {
        id: "cursor-default",
        name: "Cursor Default",
        capabilities: ["text", "vision"],
        capabilitySource: "effective-route",
      },
      {
        id: "cursor-fast",
        name: "Cursor Fast",
        capabilities: ["text", "vision"],
        capabilitySource: "effective-route",
      },
    ],
  );
  assert.deepEqual(
    createCursorModelCatalog("cursor-current[reasoning=high]", [
      { id: "cursor-fast", name: "Cursor Fast" },
    ])[0],
    {
      id: "cursor-current[reasoning=high]",
      name: "cursor-current",
      capabilities: ["text", "reasoning"],
      capabilitySource: "effective-route",
    },
  );
  assert.deepEqual(
    createCursorModelCatalog("gemini-3.5-flash[]", [
      { id: "gemini-3.5-flash[]", name: "gemini-3.5-flash" },
    ])[0],
    {
      id: "gemini-3.5-flash[]",
      name: "gemini-3.5-flash",
      capabilities: ["text"],
      capabilitySource: "effective-route",
    },
  );
  assert.deepEqual(createCursorModelCatalog("cursor-current", [])[0], {
    id: "cursor-current",
    name: "cursor-current",
    capabilities: ["text"],
    capabilitySource: "effective-route",
  });
  assert.deepEqual(
    cursorRoutableCapabilitiesForModel("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", {
      imageInput: true,
    }),
    ["text", "reasoning", "vision", "long-context"],
  );
  assert.deepEqual(
    cursorRoutableCapabilitiesForModel("claude-sonnet-4[thinking=false,context=200k]", {
      imageInput: false,
    }),
    ["text", "long-context"],
  );
  const headlessModels = [
    { id: "grok-4.7-high-fast", name: "Grok 4.7 High Fast", default: false },
    { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol", default: false },
    { id: "claude-4.6-sonnet-medium-thinking", name: "Claude Sonnet 4.6", default: false },
    { id: "claude-4-sonnet", name: "Claude Sonnet 4", default: false },
  ];
  assert.equal(
    resolveCursorHeadlessModel(
      "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
      headlessModels,
    ),
    "grok-4.7-high-fast",
  );
  assert.equal(
    resolveCursorHeadlessModel(
      "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
      headlessModels,
    ),
    "gpt-5.6-sol-medium",
  );
  assert.equal(
    resolveCursorHeadlessModel(
      "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]",
      headlessModels,
    ),
    "claude-4.6-sonnet-medium-thinking",
  );
  assert.equal(
    resolveCursorHeadlessModel("claude-sonnet-4[thinking=false,context=200k]", headlessModels),
    "claude-4-sonnet",
  );
  assert.equal(
    resolveCursorHeadlessModel("unavailable-model[reasoning=high]", headlessModels),
    undefined,
  );
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
    routing: {
      requiredCapabilities: ["code", "text"],
      availableCapabilities: ["code", "text"],
    },
  };
  const prompt = requestPrompt(request);

  assert.match(prompt, /Caller instructions:\nUse the caller's requested field names\./u);
  assert.match(prompt, /"type":"json_schema"/u);
  assert.match(prompt, /"required":\["summary"\]/u);
  assert.match(prompt, /delegated Codex host's workspace tools/u);
  assert.match(prompt, /approval and sandbox rules/u);
  assert.doesNotMatch(prompt, /Do not use tools/u);
  assert.match(
    requestPrompt({
      ...request,
      routing: {
        requiredCapabilities: ["text"],
        availableCapabilities: ["text"],
      },
    }),
    /no delegated workspace capability/u,
  );
  assert.equal(requireValidHostModelText(request, '{"summary":"done"}'), '{"summary":"done"}');
  assert.throws(() => requireValidHostModelText(request, "not json"), /did not return valid JSON/u);
});

test("passes images through host adapters without a static capability rejection", async () => {
  const baseRequest = {
    protocol: "responses" as const,
    virtualModelId: "ai-tidu9-config",
  };
  const imageRequest = {
    ...baseRequest,
    body: {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,test" }],
        },
      ],
    },
  };
  assert.deepEqual(requestTurnInput(imageRequest).input, [
    { type: "image", url: "data:image/png;base64,test" },
  ]);
  assert.deepEqual(await requestCursorPromptContent(imageRequest), [
    {
      type: "text",
      text: requestPrompt(imageRequest),
    },
    { type: "image", mimeType: "image/png", data: "test" },
  ]);
  assert.deepEqual(
    (
      await requestCursorPromptContent({
        ...baseRequest,
        body: {
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "data:image/avif;base64,dGVzdA==",
                },
              ],
            },
          ],
        },
      })
    )[1],
    { type: "image", mimeType: "image/avif", data: "dGVzdA==" },
  );
});

test("preserves phased Responses history when a user steers the same turn", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          type: "message",
          id: "user-original",
          role: "user",
          content: [{ type: "input_text", text: "original request" }],
        },
        {
          type: "message",
          id: "commentary-1",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "existing progress" }],
        },
        {
          type: "message",
          id: "user-steer",
          role: "user",
          content: [{ type: "input_text", text: "keep the earlier content" }],
        },
      ],
    },
  });

  assert.deepEqual(turn.input, [
    { type: "text", text: "keep the earlier content", text_elements: [] },
  ]);
  assert.equal(turn.historyItems.length, 2);
  assert.deepEqual(turn.historyItems[1], {
    type: "message",
    id: "commentary-1",
    status: "completed",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "existing progress" }],
  });
});

test("does not replay an old user message when Responses continuation items follow it", () => {
  const conversation = [
    {
      type: "message",
      id: "user-original",
      role: "user",
      content: [{ type: "input_text", text: "original request" }],
    },
    {
      type: "message",
      id: "commentary-1",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "existing progress" }],
    },
    { type: "function_call", id: "call-1", call_id: "call-1", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "tool result" },
  ];
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: { input: conversation },
  });

  assert.deepEqual(turn.input, [
    {
      type: "text",
      text: "Continue from the supplied conversation.",
      text_elements: [],
    },
  ]);
  assert.equal(turn.historyItems.length, conversation.length);
  assert.equal(turn.historyItems[1]?.phase, "commentary");
  assert.equal(turn.historyItems.at(-1)?.type, "function_call_output");
});

test("executes text-only Cursor requests through headless streaming with real usage", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-cursor-provider-"));
  const processLog = join(temporaryDirectory, "cursor-provider.log");
  try {
    const provider = await createCursorHostModelProvider({
      command: createFakeCursorProviderCommand(temporaryDirectory),
      environment: { ...process.env, TIDU_CURSOR_PROVIDER_TEST_LOG: processLog },
    });
    assert.notEqual(provider, undefined);
    assert.deepEqual(await provider?.listModels?.(), [
      {
        id: "cursor-text-model",
        name: "Cursor Text",
        capabilities: ["text", "vision"],
        capabilitySource: "effective-route",
      },
    ]);
    const receipts: unknown[] = [];
    const streamConfirmedModels: string[] = [];
    const result = await provider?.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "解释数据库部署", stream: true },
      virtualModelId: "ai-tidu9-config",
      routing: {
        host: "cursor",
        role: "specialist",
        targetModel: "cursor-text-model",
        requiredCapabilities: ["text"],
        availableCapabilities: ["text"],
      },
      onModelConfirmed: (model) => streamConfirmedModels.push(model),
      onExecutionReceipt: (receipt) => receipts.push(receipt),
    });
    assert.equal(result?.kind, "stream");
    if (result?.kind !== "stream") throw new Error("Expected a Cursor response stream.");
    assert.deepEqual(streamConfirmedModels, []);
    const events = await readStreamText(result.stream);
    assert.deepEqual(streamConfirmedModels, ["cursor-text-model"]);
    assert.match(events, /分析普通文本请求/u);
    assert.match(events, /Cursor 正在调用 searchToolCall：公开资料/u);
    assert.match(events, /Cursor 中文回答/u);
    assert.match(events, /"input_tokens":21/u);
    assert.match(events, /"cached_tokens":8/u);
    assert.match(events, /"cache_write_tokens":2/u);
    assert.deepEqual(receipts, [
      {
        host: "cursor",
        model: "cursor-text-model",
        role: "specialist",
        capabilities: ["text"],
        usage: {
          inputTokens: 21,
          outputTokens: 5,
          totalTokens: 26,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 2,
        },
      },
    ]);
    const processDeltas: string[] = [];
    const nonStreamingConfirmedModels: string[] = [];
    const nonStreamingResult = await provider?.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "继续解释数据库部署" },
      virtualModelId: "ai-tidu9-config",
      routing: {
        host: "cursor",
        role: "specialist",
        targetModel: "cursor-text-model",
        requiredCapabilities: ["text"],
        availableCapabilities: ["text"],
      },
      onModelConfirmed: (model) => nonStreamingConfirmedModels.push(model),
      onProcessDelta: (delta) => processDeltas.push(delta),
    });
    assert.equal(nonStreamingResult?.kind, "json");
    assert.match(processDeltas.join(""), /分析普通文本请求/u);
    assert.match(processDeltas.join(""), /Cursor 正在调用 searchToolCall：公开资料/u);
    assert.deepEqual(nonStreamingConfirmedModels, ["cursor-text-model"]);
    assert.equal(readFileSync(processLog, "utf8"), "acpProcess\n");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
    const lowProcessDeltas: string[] = [];
    const lowResult = await provider.execute({
      protocol: "responses",
      body: {
        model: "ai-tidu9-config",
        input: "low request",
        reasoning: { effort: "low" },
      },
      virtualModelId: "ai-tidu9-config",
      onProcessDelta: (delta) => lowProcessDeltas.push(delta),
    });
    assert.equal(lowResult.kind, "json");
    assert.equal(lowResult.upstreamModel, "gpt-test");
    assert.match(JSON.stringify(lowResult), /low-result/u);
    assert.match(lowProcessDeltas.join(""), /reasoning-/u);
    assert.match(lowProcessDeltas.join(""), /working-/u);

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
    assert.equal(highResult.upstreamModel, "gpt-test");
    if (highResult.kind !== "stream") throw new Error("Expected a streaming provider result.");
    const streamBody = await readStreamText(highResult.stream);
    assert.match(streamBody, /response\.reasoning_summary_text\.delta/u);
    assert.match(streamBody, /reasoning-/u);
    assert.match(streamBody, /working-/u);
    assert.match(streamBody, /运行命令 `npm test`/u);
    assert.match(streamBody, /编辑文件 `src\/index\.ts`/u);
    assert.match(streamBody, /搜索网页 `official docs`/u);
    assert.match(streamBody, /response\.output_text\.delta/u);
    assert.match(streamBody, /high-result/u);
    assert.match(streamBody, /response\.completed/u);
    assert.match(streamBody, /"created_at":\d+/u);
    assert.match(streamBody, /"completed_at":\d+/u);
    assert.match(streamBody, /"input_tokens":11/u);
    assert.match(streamBody, /"cached_tokens":3/u);
    assert.match(streamBody, /"cache_write_tokens":2/u);
    assert.match(streamBody, /"output_tokens":4/u);
    assert.match(streamBody, /"reasoning_tokens":1/u);
    assert.match(streamBody, /"total_tokens":15/u);
    assert.match(streamBody, /data: \[DONE\]/u);

    const imageResult = await provider.execute({
      protocol: "responses",
      body: {
        model: "ai-tidu9-config",
        instructions: "Preserve official input.",
        text: {
          format: {
            type: "json_schema",
            name: "image_result",
            schema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
              additionalProperties: false,
            },
          },
        },
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "previous question" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "previous answer" }],
          },
          {
            role: "user",
            content: [
              { type: "input_text", text: "inspect" },
              { type: "input_image", image_url: "data:image/png;base64,test" },
            ],
          },
        ],
      },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(imageResult.statusCode, 200);

    await provider.close?.();
    const processLogText = readFileSync(processLog, "utf8");
    assert.match(processLogText, /effort:low/u);
    assert.match(processLogText, /effort:high/u);
    assert.match(processLogText, /summary:auto/u);
    assert.match(processLogText, /"type":"image","url":"data:image\/png;base64,test"/u);
    assert.match(processLogText, /"role":"developer"/u);
    assert.match(processLogText, /Preserve official input\./u);
    assert.match(processLogText, /previous question/u);
    assert.match(processLogText, /previous answer/u);
    assert.match(processLogText, /outputSchema:\{"type":"object"/u);
    assert.match(processLogText, /threadModel:null/u);
    assert.match(processLogText, /threadModel:"gpt-test"/u);
    assert.doesNotMatch(processLogText, /Caller instructions:/u);
    assert.doesNotMatch(processLogText, /Conversation:/u);
  } finally {
    await provider?.close?.();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("keeps the shared Codex connection usable after one turn is cancelled", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-codex-cancel-"));
  const codexHomeDirectory = join(temporaryDirectory, "codex-home");
  const processLog = join(temporaryDirectory, "provider.log");
  mkdirSync(codexHomeDirectory, { recursive: true });
  const provider = await createCodexHostModelProvider(undefined, {
    codexHomeDirectory,
    command: createFakeCodexProviderCommand(temporaryDirectory),
    environment: {
      TIDU_CODEX_PROVIDER_TEST_LOG: processLog,
      TIDU_CODEX_PROVIDER_DELAY_FIRST_TURN: "true",
    },
  });
  try {
    assert.notEqual(provider, undefined);
    if (provider === undefined) throw new Error("Expected a Codex host provider.");
    const controller = new AbortController();
    const firstResult = await provider.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "wait", stream: true },
      virtualModelId: "ai-tidu9-config",
      signal: controller.signal,
    });
    assert.equal(firstResult.kind, "stream");
    if (firstResult.kind !== "stream") throw new Error("Expected a streaming result.");
    setTimeout(() => controller.abort(), 50).unref();
    assert.match(await readStreamText(firstResult.stream), /Codex turn cancelled/u);

    const secondResult = await provider.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "continue" },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(secondResult.kind, "json");
    assert.match(JSON.stringify(secondResult), /medium-result/u);
    assert.equal(readFileSync(processLog, "utf8").match(/^start$/gmu)?.length, 1);
  } finally {
    await provider?.close?.();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("recreates a closed Codex connection before any visible output", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-codex-reconnect-"));
  const codexHomeDirectory = join(temporaryDirectory, "codex-home");
  const processLog = join(temporaryDirectory, "provider.log");
  const exitOnceMarker = join(temporaryDirectory, "exit-once.marker");
  mkdirSync(codexHomeDirectory, { recursive: true });
  const provider = await createCodexHostModelProvider(undefined, {
    codexHomeDirectory,
    command: createFakeCodexProviderCommand(temporaryDirectory),
    environment: {
      TIDU_CODEX_PROVIDER_TEST_LOG: processLog,
      TIDU_CODEX_PROVIDER_EXIT_ONCE_MARKER: exitOnceMarker,
    },
  });
  try {
    assert.notEqual(provider, undefined);
    if (provider === undefined) throw new Error("Expected a Codex host provider.");
    const result = await provider.execute({
      protocol: "responses",
      body: { model: "ai-tidu9-config", input: "recover", stream: true },
      virtualModelId: "ai-tidu9-config",
    });
    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") throw new Error("Expected a streaming result.");
    const events = await readStreamText(result.stream);
    assert.match(events, /response\.completed/u);
    assert.match(events, /medium-result/u);
    assert.equal(readFileSync(processLog, "utf8").match(/^start$/gmu)?.length, 2);
  } finally {
    await provider?.close?.();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rejects a Codex provider when the host does not confirm the configured model", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-codex-model-mismatch-"));
  const codexHomeDirectory = join(temporaryDirectory, "codex-home");
  const processLog = join(temporaryDirectory, "provider.log");
  mkdirSync(codexHomeDirectory, { recursive: true });
  const command = createFakeCodexProviderCommand(temporaryDirectory);
  try {
    const provider = await createCodexHostModelProvider("configured-model", {
      codexHomeDirectory,
      command,
      environment: {
        TIDU_CODEX_PROVIDER_TEST_LOG: processLog,
        TIDU_CODEX_PROVIDER_IGNORE_REQUESTED_MODEL: "true",
      },
    });
    assert.equal(provider, undefined);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rejects a later Codex target when the host confirms a different model", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-codex-target-mismatch-"));
  const codexHomeDirectory = join(temporaryDirectory, "codex-home");
  const processLog = join(temporaryDirectory, "provider.log");
  mkdirSync(codexHomeDirectory, { recursive: true });
  const command = createFakeCodexProviderCommand(temporaryDirectory);
  const provider = await createCodexHostModelProvider(undefined, {
    codexHomeDirectory,
    command,
    environment: {
      TIDU_CODEX_PROVIDER_TEST_LOG: processLog,
      TIDU_CODEX_PROVIDER_IGNORE_REQUESTED_MODEL: "true",
    },
  });
  try {
    assert.notEqual(provider, undefined);
    if (provider === undefined) throw new Error("Expected a Codex host provider.");
    await assert.rejects(
      () =>
        provider.execute({
          protocol: "responses",
          body: { model: "ai-tidu9-config", input: "test" },
          virtualModelId: "ai-tidu9-config",
          routing: { targetModel: "configured-model" },
        }),
      /confirmed model gpt-test instead of configured model configured-model/iu,
    );
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

test("includes provider-reported usage in streamed host chat completions", async () => {
  const stream = createLiveJsonStream(
    {
      protocol: "chat-completions",
      body: {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      virtualModelId: "ai-tidu9-config",
    },
    async (onTextDelta) => {
      onTextDelta("hello");
      return {
        text: "hello",
        usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
      };
    },
  );
  const body = await readStreamText(stream);

  assert.match(body, /"usage":\{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11\}/u);
  assert.match(body, /data: \[DONE\]/u);
});

test("keeps reported usage when either host stream protocol fails", async () => {
  for (const protocol of ["responses", "chat-completions"] as const) {
    const stream = createLiveJsonStream(
      { protocol, virtualModelId: "tidu", body: { stream: true } },
      async () => {
        throw new Error("Fixture failed");
      },
      () => ({ inputTokens: 12, outputTokens: 3, totalTokens: 15 }),
    );
    const body = await readStreamText(stream);
    assert.match(body, /Fixture failed/u);
    assert.match(body, /"total_tokens":15/u);
    assert.match(body, /data: \[DONE\]/u);
  }
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
          {
            id: "company-reasoning",
            name: "Company Reasoning",
            capabilities: ["text", "reasoning", "tool-use"],
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
      {
        id: "company-reasoning",
        name: "Company Reasoning",
        capabilities: ["text", "reasoning", "tool-use"],
        capabilitySource: "company-published",
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

test("publishes only Ollama capabilities routable through the adapter", async () => {
  const server = await startTestServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [{ model: "qwen-vision" }, { model: "qwen-tools" }],
        }),
      );
      return;
    }
    assert.equal(request.url, "/api/show");
    void readBody(request).then((body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          capabilities:
            body.model === "qwen-vision"
              ? ["completion", "vision", "thinking"]
              : ["completion", "tools"],
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
        capabilities: ["text", "vision"],
        capabilitySource: "effective-route",
      },
      {
        id: "qwen-tools",
        name: "qwen-tools",
        capabilities: ["text", "tool-use"],
        capabilitySource: "effective-route",
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

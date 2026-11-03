import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { configureCodexClient, switchCodexClientConfiguration } from "../clients/configuration.js";
import { createCodexHostModelProvider, createLiveJsonStream } from "../providers/codex-host.js";
import { startLocalRuntime } from "../runtime/index.js";
import { createStdioJsonRpcClient, type JsonRpcNotification } from "./json-rpc.js";

test("official stdio accepts requests above 64 MiB directly and through the client proxy", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-large-frame-"));
  const padding = "x".repeat(65 * 1024 * 1024);
  try {
    for (const proxied of [false, true]) {
      const home = join(directory, proxied ? "proxy" : "official");
      await mkdir(home);
      const client = createStdioJsonRpcClient({
        command: proxied
          ? process.execPath
          : (process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex"),
        arguments: proxied
          ? [
              ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
              fileURLToPath(
                new URL(
                  `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
                  import.meta.url,
                ),
              ),
              "app-server",
            ]
          : ["app-server"],
        environment: {
          PATH: process.env.PATH,
          CODEX_HOME: home,
          TIDU_CODEX_REAL_COMMAND: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
        },
        workingDirectory: directory,
      });
      try {
        await client.request("initialize", {
          clientInfo: { name: "stdio_frame_test", version: "1" },
        });
        client.notify("initialized");
        // Unknown fields are ignored by the method, after the complete frame is read.
        const account = await client.request<{ account: unknown }>("account/read", {
          refreshToken: false,
          padding,
        });
        assert.equal(account.account, null);
        const next = await client.request<{ account: unknown }>("account/read", {
          refreshToken: false,
        });
        assert.equal(next.account, null);
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("official Codex retries a disconnected managed response with native reconnect notifications", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-retry-"));
  let attempts = 0;
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    discoverHostProvider: false,
    provider: {
      descriptor: { type: "codex-host", model: "fixture" },
      execute: async (request) => {
        attempts += 1;
        request.onExecutionReceipt?.({
          host: "codex",
          model: "primary-fixture",
          role: "worker",
          capabilities: ["text"],
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        });
        request.onExecutionReceipt?.({
          host: "cursor",
          model: "secondary-fixture",
          role: "specialist",
          capabilities: ["text"],
          usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
        });
        return {
          kind: "stream",
          statusCode: 200,
          upstreamModel: "primary-fixture",
          stream: createLiveJsonStream(request, async () => {
            if (attempts === 1) throw new Error("Fixture upstream stream disconnected");
            return {
              text: "Fixture recovered",
              usage: { inputTokens: 19, outputTokens: 5, totalTokens: 24 },
            };
          }),
        };
      },
    },
  });
  try {
    // Compare the previous managed overrides with the generated native-default configuration.
    for (const disableRetries of [true, false]) {
      attempts = 0;
      const home = join(directory, disableRetries ? "disabled" : "native");
      await configureCodexClient({
        endpoint: runtime.origin,
        codexHomeDirectory: home,
        verifyRuntime: false,
      });
      await writeFile(
        join(home, "config.toml"),
        await readFile(join(home, "ai-tidu9.config.toml")),
      );
      const notifications: JsonRpcNotification[] = [];
      let completeTurn: ((params: unknown) => void) | undefined;
      const completion = new Promise<unknown>((resolve) => {
        completeTurn = resolve;
      });
      const client = createStdioJsonRpcClient(
        {
          command: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex",
          arguments: [
            ...(disableRetries
              ? [
                  "-c",
                  "model_providers.ai_tidu9.stream_max_retries=0",
                  "-c",
                  "model_providers.ai_tidu9.request_max_retries=0",
                ]
              : []),
            "app-server",
          ],
          environment: { PATH: process.env.PATH, CODEX_HOME: home },
          workingDirectory: directory,
        },
        {
          onNotification: (notification) => {
            notifications.push(notification);
            if (notification.method === "turn/completed") completeTurn?.(notification.params);
          },
        },
      );
      try {
        await client.request("initialize", {
          clientInfo: { name: "tidu_retry_test", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
        const thread = await client.request<{ thread: { id: string } }>("thread/start", {
          model: "ai-tidu9-config",
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
        });
        await client.request("turn/start", {
          threadId: thread.thread.id,
          input: [{ type: "text", text: "检查重试" }],
        });
        const terminal = JSON.stringify(await completion);
        assert.match(terminal, disableRetries ? /"status":"failed"/u : /"status":"completed"/u);
        assert.equal(attempts, disableRetries ? 1 : 2);
        if (!disableRetries) {
          const reconnect = notifications.filter((notification) => notification.method === "error");
          assert.match(JSON.stringify(reconnect), /Reconnecting/u);
          assert.match(JSON.stringify(reconnect), /"willRetry":true/u);
          const text = JSON.stringify(
            notifications.filter((notification) => notification.method === "item/completed"),
          );
          assert.match(text, /Fixture recovered/u);
          assert.match(text, /总：入 19 · 出 5 · 合 24/u);
          assert.match(text, /Codex：入 12 · 出 3 · 合 15/u);
          assert.match(text, /Cursor：入 7 · 出 2 · 合 9/u);
        }
      } finally {
        await client.close();
      }
    }
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native retry resumes a terminal failed chat after the managed proxy restarts", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-terminal-retry-"));
  const fixture = { recovered: false, attempts: 0 };
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    discoverHostProvider: false,
    provider: {
      descriptor: { type: "codex-host", model: "fixture" },
      execute: async (request) => ({
        kind: "stream",
        statusCode: 200,
        stream: createLiveJsonStream(request, async () => {
          fixture.attempts += 1;
          if (!fixture.recovered) throw new Error("Fixture stream temporarily unavailable.");
          return { text: "Recovered after manual retry.", usage: null };
        }),
      }),
    },
  });
  await configureCodexClient({
    endpoint: runtime.origin,
    codexHomeDirectory: directory,
    verifyRuntime: false,
  });
  await writeFile(
    join(directory, "config.toml"),
    await readFile(join(directory, "ai-tidu9.config.toml")),
  );
  let complete: ((params: unknown) => void) | undefined;
  const notifications: JsonRpcNotification[] = [];
  const createClient = () =>
    createStdioJsonRpcClient(
      {
        command: process.execPath,
        arguments: [
          ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
          fileURLToPath(
            new URL(
              `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
              import.meta.url,
            ),
          ),
          "app-server",
        ],
        environment: {
          PATH: process.env.PATH,
          CODEX_HOME: directory,
          TIDU_CODEX_REAL_COMMAND: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
        },
        workingDirectory: directory,
      },
      {
        onNotification: (notification) => {
          notifications.push(notification);
          if (notification.method === "turn/completed") complete?.(notification.params);
        },
      },
    );
  let client = createClient();
  const initialize = async () => {
    await client.request("initialize", {
      clientInfo: { name: "tidu_terminal_retry_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
  };
  const runTurn = async (threadId: string, input: readonly unknown[]) => {
    const terminal = new Promise<unknown>((resolve) => {
      complete = resolve;
    });
    await client.request("turn/start", { threadId, input });
    return terminal;
  };
  try {
    await initialize();
    const started = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const failed = await runTurn(started.thread.id, [{ type: "text", text: "检查终态后重试" }]);
    assert.match(JSON.stringify(failed), /"status":"failed"/u);
    assert.ok(fixture.attempts > 1);
    assert.ok(
      notifications.some(
        (notification) =>
          notification.method === "error" &&
          (notification.params as { willRetry?: boolean }).willRetry === true,
      ),
    );
    await client.close();
    fixture.recovered = true;
    client = createClient();
    await initialize();
    const resumed = await client.request<{ thread: { id: string } }>("thread/resume", {
      threadId: started.thread.id,
    });
    assert.equal(resumed.thread.id, started.thread.id);
    const retried = await runTurn(started.thread.id, []);
    assert.match(JSON.stringify(retried), /"status":"completed"/u);
    assert.match(JSON.stringify(retried), /Recovered after manual retry\./u);
    const saved = await client.request<{ thread: { turns: { status: string }[] } }>("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    assert.deepEqual(
      saved.thread.turns.map((turn) => turn.status),
      ["failed", "completed"],
    );
  } finally {
    await client.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("compaction preserves native user-message timing and paginated history through the proxy", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-compaction-history-"));
  const executable = process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex";
  let modelCalls = 0;
  const compaction: { release?: () => void } = {};
  const releaseCompaction = () => {
    const release = compaction.release;
    compaction.release = undefined;
    release?.();
    return release !== undefined;
  };
  const modelServer = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const call = ++modelCalls;
    const finish = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, payload: Record<string, unknown>) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      };
      const item = {
        type: "message",
        id: `compaction_message_${call}`,
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: call === 2 ? "Compaction fixture summary." : `Fixture answer ${call}.`,
            annotations: [],
          },
        ],
      };
      send("response.created", {
        response: {
          id: `response_${call}`,
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
      send("response.output_item.added", { output_index: 0, item });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: `response_${call}`,
          object: "response",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: call === 1 ? 5500 : 100,
            output_tokens: 10,
            total_tokens: call === 1 ? 5510 : 110,
          },
        },
      });
      response.end();
    };
    if (call === 2) compaction.release = finish;
    else finish();
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const waitFor = async (matches: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!matches()) {
      if (Date.now() >= deadline) throw new Error("Compaction fixture event did not arrive.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  type HistoryTurn = {
    id: string;
    items: {
      id: string;
      type: string;
      content?: { type: string; text?: string }[];
    }[];
  };
  let directSequence: string[] | undefined;
  try {
    for (const proxied of [false, true]) {
      modelCalls = 0;
      compaction.release = undefined;
      const home = join(directory, proxied ? "proxy" : "direct");
      await mkdir(home);
      await writeFile(
        join(home, "config.toml"),
        [
          'model="gpt-5.1-codex"',
          'model_provider="fixture"',
          "model_context_window=8000",
          "model_auto_compact_token_limit=4000",
          "[model_providers.fixture]",
          'name="fixture"',
          `base_url="http://127.0.0.1:${address.port}/v1"`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
        ].join("\n"),
      );
      const notifications: JsonRpcNotification[] = [];
      const createClient = () =>
        createStdioJsonRpcClient(
          {
            command: proxied ? process.execPath : executable,
            arguments: proxied
              ? [
                  ...(import.meta.url.endsWith(".ts")
                    ? ["--import", import.meta.resolve("tsx")]
                    : []),
                  fileURLToPath(
                    new URL(
                      `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
                      import.meta.url,
                    ),
                  ),
                  "app-server",
                ]
              : ["app-server"],
            environment: {
              PATH: process.env.PATH,
              CODEX_HOME: home,
              TIDU_CODEX_REAL_COMMAND: executable,
              TIDU_CODEX_RECOVERY_PROVIDER: "fixture",
            },
            workingDirectory: directory,
          },
          {
            onNotification: (notification) => notifications.push(notification),
          },
        );
      let client = createClient();
      const initialize = async () => {
        await client.request("initialize", {
          clientInfo: { name: "compaction_history_test", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
      };
      const itemEvents = () =>
        notifications
          .filter(
            (notification) =>
              notification.method === "item/started" || notification.method === "item/completed",
          )
          .map((notification) => ({
            method: notification.method,
            ...(notification.params as {
              threadId: string;
              turnId: string;
              item: HistoryTurn["items"][number];
            }),
          }));
      try {
        await initialize();
        const started = await client.request<{ thread: { id: string } }>("thread/start", {
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
          persistExtendedHistory: true,
        });
        const threadId = started.thread.id;
        const first = await client.request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [{ type: "text", text: "First fixture question" }],
        });
        await waitFor(() => notifications.some((event) => event.method === "turn/completed"));
        assert.equal(itemEvents()[0]?.item.type, "userMessage");
        notifications.length = 0;
        const second = await client.request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [{ type: "text", text: "Question during compaction" }],
        });
        await waitFor(
          () =>
            compaction.release !== undefined &&
            itemEvents().some((event) => event.item.type === "contextCompaction"),
        );
        assert.equal(
          itemEvents().some((event) => event.item.type === "userMessage"),
          false,
        );
        const before = await client.request<{ data: HistoryTurn[] }>("thread/turns/list", {
          threadId,
          itemsView: "full",
          limit: 10,
        });
        assert.deepEqual(before.data.find((turn) => turn.id === second.turn.id)?.items, []);
        assert.ok(
          before.data
            .find((turn) => turn.id === first.turn.id)
            ?.items.some((item) => item.type === "userMessage"),
        );
        assert.ok(releaseCompaction());
        await waitFor(() => notifications.some((event) => event.method === "turn/completed"));
        assert.equal(modelCalls, 3);
        const events = itemEvents();
        assert.ok(
          events.every((event) => event.threadId === threadId && event.turnId === second.turn.id),
        );
        const sequence = events.map((event) => `${event.method}:${event.item.type}`);
        assert.deepEqual(sequence, [
          "item/started:contextCompaction",
          "item/completed:contextCompaction",
          "item/started:userMessage",
          "item/completed:userMessage",
          "item/started:agentMessage",
          "item/completed:agentMessage",
        ]);
        if (proxied) assert.deepEqual(sequence, directSequence);
        else directSequence = sequence;
        const completedUser = events.filter(
          (event) => event.method === "item/completed" && event.item.type === "userMessage",
        );
        assert.equal(completedUser.length, 1);
        assert.equal(completedUser[0]?.item.content?.[0]?.text, "Question during compaction");
        const page = await client.request<{
          data: HistoryTurn[];
          nextCursor: string | null;
        }>("thread/turns/list", { threadId, itemsView: "full", limit: 1 });
        assert.equal(page.data.length, 1);
        assert.equal(page.data[0]?.id, second.turn.id);
        assert.deepEqual(
          page.data[0]?.items.map((item) => item.type),
          ["contextCompaction", "userMessage", "agentMessage"],
        );
        assert.ok(page.nextCursor);
        const older = await client.request<{
          data: HistoryTurn[];
          nextCursor: string | null;
        }>("thread/turns/list", {
          threadId,
          itemsView: "full",
          limit: 1,
          cursor: page.nextCursor,
        });
        assert.equal(older.data.length, 1);
        assert.equal(older.data[0]?.id, first.turn.id);
        assert.equal(older.nextCursor, null);
        const expectedTurns = [...older.data, ...page.data].map((turn) => ({
          id: turn.id,
          items: turn.items,
        }));
        await client.close();
        client = createClient();
        await initialize();
        const reopened = await client.request<{
          thread: { turns: HistoryTurn[] };
        }>("thread/resume", { threadId });
        assert.deepEqual(
          reopened.thread.turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
          expectedTurns,
        );
        assert.equal(modelCalls, 3);
      } finally {
        releaseCompaction();
        await client.close();
      }
    }
  } finally {
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("one native chat uses the selected mode on every new turn", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-mode-history-"));
  const codexHomeDirectory = join(directory, ".codex");
  let officialRequests = 0;
  let holdNextOfficialRequest = false;
  const officialRequestModels: string[] = [];
  const officialRequestPaths: string[] = [];
  const officialServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof requestBody === "object" &&
      requestBody !== null &&
      "model" in requestBody &&
      typeof requestBody.model === "string"
    ) {
      officialRequestModels.push(requestBody.model);
      officialRequestPaths.push(request.url ?? "");
    }
    officialRequests += 1;
    const responseId = `official-response-${officialRequests}`;
    const item = {
      type: "message",
      id: `official-message-${officialRequests}`,
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "output_text",
          text: `Official round ${officialRequests}`,
          annotations: [],
        },
      ],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, payload: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    send("response.created", {
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
      },
    });
    if (holdNextOfficialRequest) {
      holdNextOfficialRequest = false;
      const reasoning = {
        type: "reasoning",
        id: `official-cancel-reasoning-${officialRequests}`,
        summary: [{ type: "summary_text", text: "Official cancellation fixture" }],
      };
      send("response.output_item.added", { output_index: 0, item: reasoning });
      send("response.output_item.done", { output_index: 0, item: reasoning });
      return;
    }
    send("response.output_item.added", { output_index: 0, item });
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", {
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => officialServer.listen(0, "127.0.0.1", resolve));
  const officialAddress = officialServer.address();
  assert.ok(officialAddress !== null && typeof officialAddress !== "string");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    discoverHostProvider: false,
    provider: {
      descriptor: { type: "codex-host", model: "gpt-6.1-sol" },
      execute: async (request) => ({
        kind: "stream",
        statusCode: 200,
        upstreamModel: "gpt-6.1-sol",
        stream: createLiveJsonStream(request, async () => ({
          text: "Managed round",
          usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
        })),
      }),
    },
  });
  await mkdir(codexHomeDirectory, { recursive: true });
  await writeFile(
    join(codexHomeDirectory, "config.toml"),
    [
      'model = "gpt-6.1-sol"',
      'model_provider = "official_fixture"',
      "[model_providers.official_fixture]",
      'name = "Official fixture"',
      `base_url = "http://127.0.0.1:${officialAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(codexHomeDirectory, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6.1-sol",
          display_name: "Official fixture",
          description: "Official history fixture",
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "medium" }],
          supports_search_tool: true,
          tool_mode: "code_mode_only",
          context_window: 128000,
          visibility: "list",
          supported_in_api: true,
        },
      ],
    }),
  );
  await configureCodexClient({
    endpoint: runtime.origin,
    codexHomeDirectory,
    verifyRuntime: false,
  });
  const initializeClient = async () => {
    const notifications: JsonRpcNotification[] = [];
    let notify: (() => void) | undefined;
    const client = createStdioJsonRpcClient(
      {
        command: process.execPath,
        arguments: [
          ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
          fileURLToPath(
            new URL(
              `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
              import.meta.url,
            ),
          ),
          "app-server",
        ],
        environment: {
          PATH: process.env.PATH,
          CODEX_HOME: codexHomeDirectory,
          TIDU_CODEX_REAL_COMMAND: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex",
        },
        workingDirectory: directory,
      },
      {
        onNotification: (notification) => {
          notifications.push(notification);
          notify?.();
        },
      },
    );
    await client.request("initialize", {
      clientInfo: { name: "tidu_mode_history_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const waitFor = async (matches: () => boolean) => {
      while (!matches())
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Mode-switch fixture event did not arrive after ${officialRequests} official requests: ${JSON.stringify(notifications.slice(-12))}`,
                ),
              ),
            10_000,
          );
          notify = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
    };
    const runTurn = async (threadId: string, text: string, model?: string) => {
      const offset = notifications.length;
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        ...(model === undefined ? {} : { model }),
      });
      await waitFor(() =>
        notifications
          .slice(offset)
          .some((notification) => notification.method === "turn/completed"),
      );
      return notifications.slice(offset);
    };
    return { client, notifications, runTurn, waitFor };
  };
  let session = await initializeClient();
  try {
    const started = await session.client.request<{
      thread: { id: string; modelProvider: string };
    }>("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = started.thread.id;
    assert.equal(started.thread.modelProvider, "official_fixture");
    const firstOfficial = await session.runTurn(threadId, "Official first round");
    assert.doesNotMatch(JSON.stringify(firstOfficial), /总：/u);
    const cancellationOffset = session.notifications.length;
    holdNextOfficialRequest = true;
    const cancelledOfficial = await session.client.request<{
      turn: { id: string };
    }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "Official cancelled round" }],
    });
    const cancellationDeadline = Date.now() + 5_000;
    while (officialRequests < 2) {
      if (Date.now() >= cancellationDeadline)
        throw new Error("Official cancellation fixture request did not start.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const runningSwitchOffset = session.notifications.length;
    await switchCodexClientConfiguration({ mode: "ai-tidu9", codexHomeDirectory, request: fetch });
    const runningThread = await session.client.request<{ thread: { modelProvider: string } }>(
      "thread/read",
      { threadId },
    );
    assert.equal(runningThread.thread.modelProvider, "official_fixture");
    await session.client.request("turn/interrupt", {
      threadId,
      turnId: cancelledOfficial.turn.id,
    });
    await session.waitFor(() =>
      session.notifications
        .slice(cancellationOffset)
        .some(
          (notification) =>
            notification.method === "turn/completed" &&
            JSON.stringify(notification.params).includes(cancelledOfficial.turn.id),
        ),
    );
    await session.waitFor(() =>
      session.notifications
        .slice(runningSwitchOffset)
        .some(
          (notification) =>
            notification.method === "thread/settings/updated" &&
            (notification.params as { threadSettings?: { modelProvider?: string } }).threadSettings
              ?.modelProvider === "ai_tidu9",
        ),
    );
    await session.client.close();

    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request: fetch,
    });
    session = await initializeClient();
    const managedResume = await session.client.request<{
      thread: {
        id: string;
        model: string;
        modelProvider: string;
        turns: { id: string; items: { text?: string }[] }[];
      };
    }>("thread/resume", { threadId });
    assert.equal(managedResume.thread.id, threadId);
    assert.equal(managedResume.thread.modelProvider, "ai_tidu9");
    assert.equal(managedResume.thread.model, "ai-tidu9-config");
    const cancelledHistory = JSON.stringify(
      managedResume.thread.turns.find((turn) => turn.id === cancelledOfficial.turn.id),
    );
    assert.doesNotMatch(cancelledHistory, /总：/u);
    const firstManaged = await session.runTurn(threadId, "Managed round");
    assert.match(JSON.stringify(firstManaged), /总：入 11 · 出 3 · 合 14/u);
    await session.client.close();

    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    session = await initializeClient();
    const officialResume = await session.client.request<{
      thread: { id: string; modelProvider: string };
    }>("thread/resume", { threadId });
    assert.equal(officialResume.thread.id, threadId);
    assert.equal(officialResume.thread.modelProvider, "official_fixture");
    const secondOfficial = await session.runTurn(threadId, "Official second round");
    assert.doesNotMatch(JSON.stringify(secondOfficial), /总：/u);
    await session.client.close();

    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request: fetch,
    });
    session = await initializeClient();
    const secondManagedResume = await session.client.request<{
      thread: { id: string; modelProvider: string };
    }>("thread/resume", { threadId });
    assert.equal(secondManagedResume.thread.id, threadId);
    assert.equal(secondManagedResume.thread.modelProvider, "ai_tidu9");
    const secondManaged = await session.runTurn(threadId, "Managed second round");
    assert.match(JSON.stringify(secondManaged), /总：入 11 · 出 3 · 合 14/u);
    const saved = await session.client.request<{
      thread: { id: string; turns: unknown[] };
    }>("thread/read", { threadId, includeTurns: true });
    assert.equal(saved.thread.id, threadId);
    assert.equal(saved.thread.turns.length, 5);

    const managedStarted = await session.client.request<{
      thread: { id: string; model: string; modelProvider: string };
    }>("thread/start", {
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    assert.equal(managedStarted.thread.modelProvider, "ai_tidu9");
    assert.equal(managedStarted.thread.model, "ai-tidu9-config");
    const managedOriginThreadId = managedStarted.thread.id;
    const managedOriginFirst = await session.runTurn(managedOriginThreadId, "Managed origin round");
    assert.match(JSON.stringify(managedOriginFirst), /总：入 11 · 出 3 · 合 14/u);
    await session.client.close();

    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    session = await initializeClient();
    const managedOriginOfficial = await session.client.request<{
      thread: { id: string; model: string; modelProvider: string };
    }>("thread/resume", { threadId: managedOriginThreadId });
    assert.equal(managedOriginOfficial.thread.modelProvider, "official_fixture");
    assert.equal(managedOriginOfficial.thread.model, "gpt-6.1-sol");
    const managedOriginOfficialTurn = await session.runTurn(
      managedOriginThreadId,
      "Managed origin official round",
    );
    assert.doesNotMatch(JSON.stringify(managedOriginOfficialTurn), /总：/u);
    await session.client.close();

    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request: fetch,
    });
    session = await initializeClient();
    const managedOriginResume = await session.client.request<{
      thread: { id: string; model: string; modelProvider: string };
    }>("thread/resume", { threadId: managedOriginThreadId });
    assert.equal(managedOriginResume.thread.modelProvider, "ai_tidu9");
    assert.equal(managedOriginResume.thread.model, "ai-tidu9-config");
    const managedOriginSecond = await session.runTurn(
      managedOriginThreadId,
      "Managed origin second round",
    );
    assert.match(JSON.stringify(managedOriginSecond), /总：入 11 · 出 3 · 合 14/u);
    await switchCodexClientConfiguration({ mode: "official", codexHomeDirectory });
    await session.waitFor(() =>
      session.notifications.some(
        (notification) =>
          notification.method === "thread/settings/updated" &&
          (notification.params as { threadSettings?: { model?: string } }).threadSettings?.model ===
            "gpt-6.1-sol",
      ),
    );
    const liveOfficial = await session.runTurn(
      managedOriginThreadId,
      "Live official round",
      "ai-tidu9-config",
    );
    assert.doesNotMatch(JSON.stringify(liveOfficial), /总：/u);
    const officialCatalog = await session.client.request<{
      data: { id: string; isDefault: boolean }[];
    }>("model/list", {});
    assert.equal(officialCatalog.data.find((model) => model.isDefault)?.id, "gpt-6.1-sol");
    const managedOffset = session.notifications.length;
    await switchCodexClientConfiguration({ mode: "ai-tidu9", codexHomeDirectory, request: fetch });
    await session.waitFor(() =>
      session.notifications
        .slice(managedOffset)
        .some(
          (notification) =>
            notification.method === "thread/settings/updated" &&
            (notification.params as { threadSettings?: { model?: string } }).threadSettings
              ?.model === "ai-tidu9-config",
        ),
    );
    const liveManaged = await session.runTurn(
      managedOriginThreadId,
      "Live managed round",
      "gpt-6.1-sol",
    );
    assert.match(JSON.stringify(liveManaged), /总：入 11 · 出 3 · 合 14/u);
    const managedCatalog = await session.client.request<{
      data: { id: string; isDefault: boolean }[];
    }>("model/list", {});
    assert.equal(managedCatalog.data.find((model) => model.isDefault)?.id, "ai-tidu9-config");
    assert.ok(officialRequests >= 3);
    assert.doesNotMatch(
      JSON.stringify(officialRequestModels),
      /ai-tidu9-config/u,
      JSON.stringify(officialRequestPaths),
    );
  } finally {
    await session.client.close();
    await runtime.close();
    officialServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      officialServer.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

// Render the installed native stopped-status component with its actual duration formatter.
// This reads bundled application code only and never accesses desktop accounts or UI state.
const renderNativeStoppedStatus = async (durationMs: number): Promise<string | undefined> => {
  const archivePath = process.env.TIDU_CODEX_APP_ASAR;
  if (archivePath === undefined) return undefined;
  const archive = await readFile(archivePath);
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString()) as {
    files: Record<
      string,
      {
        files: Record<string, { files: Record<string, { offset: string; size: number }> }>;
      }
    >;
  };
  const files = header.files.webview?.files.assets?.files;
  assert.ok(files);
  const asset = (prefix: string): string => {
    const name = Object.keys(files).find((name) => name.startsWith(prefix) && name.endsWith(".js"));
    assert.ok(name);
    const entry = files[name];
    assert.ok(entry);
    const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset);
    return archive.subarray(offset, offset + entry.size).toString();
  };
  const initial = asset("app-initial-");
  const formatter = /function ([\w$]+)\(e,t\)\{return ([\w$]+)\(e,\{locale:t,underOneSecond:/u.exec(
    initial,
  );
  assert.ok(formatter?.[1] && formatter[2]);
  const formatterStart = initial.indexOf(`function ${formatter[2]}(`);
  const formatterEnd = initial.indexOf("}var ", formatter.index) + 1;
  const formatCode = initial.slice(formatterStart, formatterEnd);
  const cacheName = /([\w$]+)\.get\(r\)/u.exec(formatCode)?.[1];
  assert.ok(cacheName);
  const worked = asset("worked-for-item-content-")
    .replace(/import\{[^;]+;/gu, "")
    .replace(/export\{[^;]+;/gu, "");
  const stoppedLabel = /"localConversation.userStoppedAfter":`([^`]+)`/u.exec(asset("zh-CN-"))?.[1];
  assert.ok(stoppedLabel);
  const context = {
    React,
    jsxRuntime,
    stoppedLabel,
    NativeWorkedFor: undefined as
      | React.ComponentType<{
          status: string;
          startedAtMs: number;
          completedAtMs: number;
        }>
      | undefined,
  };
  runInNewContext(
    `${formatCode}\n${cacheName}=new Map();\n${worked}\nS={c:size=>Array(size).fill(Symbol.for("react.memo_cache_sentinel"))};C=React;w=jsxRuntime;o=t=()=>({locale:"zh-CN"});m=()=>{};h=${formatter[1]};n=r=(...values)=>values.filter(Boolean).join(" ");s=c=props=>stoppedLabel.replace("{time}",props.values.time);NativeWorkedFor=v;`,
    context,
  );
  assert.ok(context.NativeWorkedFor);
  return renderToStaticMarkup(
    React.createElement(context.NativeWorkedFor, {
      status: "stopped",
      startedAtMs: 0,
      completedAtMs: durationMs,
    }),
  );
};

// Opt in with an official Codex executable. This host uses an isolated home and a local fixture,
// never an account, a private conversation, or an upstream model.
test("official Codex persists cancelled gateway activities and receives completed token usage", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 20_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-codex-protocol-"));
  const notifications: JsonRpcNotification[] = [];
  let notify: (() => void) | undefined;
  let completeFixture = false;
  const waitFor = async (matches: () => boolean): Promise<void> => {
    while (!matches())
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Codex fixture event was not received.")),
          5_000,
        );
        notify = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
  };
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    provider: {
      descriptor: { type: "codex-host", model: "fixture" },
      execute: async (request) => ({
        kind: "stream",
        statusCode: 200,
        stream: createLiveJsonStream(request, async (onTextDelta, onProcessDelta) => {
          onProcessDelta("读取文件 `src/example.ts`\n\n");
          onProcessDelta("运行命令 `npm test`\n\n");
          if (completeFixture) {
            onTextDelta("Fixture complete");
            return {
              text: "Fixture complete",
              usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
            };
          }
          return new Promise<string>((_resolveFixture, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Fixture cancelled", "AbortError")),
              { once: true },
            );
          });
        }),
      }),
    },
  });
  const client = createStdioJsonRpcClient(
    {
      command: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex",
      arguments: [
        "--config",
        'model_provider="fixture"',
        "--config",
        `model_providers.fixture={name="fixture",base_url="${runtime.origin}/v1/hosts/codex",wire_api="responses",requires_openai_auth=false}`,
        "app-server",
      ],
      environment: { PATH: process.env.PATH, CODEX_HOME: directory },
      workingDirectory: directory,
    },
    {
      onNotification: (notification) => {
        notifications.push(notification);
        notify?.();
      },
    },
  );
  try {
    await client.request("initialize", {
      clientInfo: { name: "tidu_protocol_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const started = await client.request<{ thread: { id: string } }>("thread/start", {
      model: "ai-tidu9-config",
      modelProvider: "fixture",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
      persistExtendedHistory: true,
    });
    const turn = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Protocol fixture" }],
    });
    await waitFor(
      () =>
        notifications.filter((notification) => notification.method === "item/completed").length >=
        3,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.request("turn/interrupt", {
      threadId: started.thread.id,
      turnId: turn.turn.id,
    });
    await waitFor(() =>
      notifications.some((notification) => notification.method === "turn/completed"),
    );
    const saved = await client.request<{
      thread: {
        turns: {
          status: string;
          durationMs: number;
          items: { type: string; summary?: string[] }[];
        }[];
      };
    }>("thread/read", { threadId: started.thread.id, includeTurns: true });
    const savedTurn = saved.thread.turns[0];
    assert.equal(savedTurn?.status, "interrupted");
    assert.ok((savedTurn?.durationMs ?? 0) >= 1_000);
    assert.deepEqual(
      savedTurn?.items
        .filter((item) => item.type === "reasoning" && item.summary?.length)
        .map((item) => item.summary?.join("")),
      ["读取文件 `src/example.ts`", "运行命令 `npm test`"],
    );
    completeFixture = true;
    notifications.length = 0;
    await client.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Complete protocol fixture" }],
    });
    await waitFor(() =>
      notifications.some((notification) => notification.method === "turn/completed"),
    );
    const usage = notifications.find(
      (notification) => notification.method === "thread/tokenUsage/updated",
    )?.params as { tokenUsage?: { last?: { totalTokens?: number } } } | undefined;
    assert.equal(usage?.tokenUsage?.last?.totalTokens, 15);
  } finally {
    await client.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("official caller executes delegated commands as native command items and returns real results", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-caller-tools-"));
  const command = process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex";
  let modelRequests = 0;
  let receivedToolOutput = false;
  let cancelFixture = false;
  let waitingFixture = false;
  let cancellationRequests = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      input?: { type?: string; output?: unknown; content?: unknown }[];
      tools?: Record<string, unknown>[];
    };
    modelRequests += 1;
    if (cancelFixture) cancellationRequests += 1;
    const runningFixture = cancelFixture && cancellationRequests > 1;
    receivedToolOutput =
      body.input?.some(
        (item) =>
          item.type === "function_call_output" &&
          JSON.stringify(item.output).includes("native-fixture-content"),
      ) ?? false;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, payload: Record<string, unknown>): void => {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    };
    if (waitingFixture) {
      send("response.created", {
        response: {
          id: "waiting_response",
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
      const item = {
        type: "reasoning",
        id: "waiting_reasoning",
        summary: [{ type: "summary_text", text: "Waiting for the fixture model." }],
      };
      send("response.output_item.added", { output_index: 0, item });
      send("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      send("response.reasoning_summary_text.delta", {
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        delta: "Waiting for the fixture model.",
      });
      send("response.reasoning_summary_text.done", {
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        text: "Waiting for the fixture model.",
      });
      send("response.reasoning_summary_part.done", {
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        part: item.summary[0],
      });
      send("response.output_item.done", { output_index: 0, item });
      return;
    }
    const output: Record<string, unknown>[] =
      receivedToolOutput && !cancelFixture
        ? [
            {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: "Native fixture verified.",
                  annotations: [],
                },
              ],
            },
          ]
        : [
            {
              type: "reasoning",
              id: `rs_fixture_${modelRequests}`,
              summary: [
                { type: "summary_text", text: "Inspect the fixture file." },
                { type: "summary_text", text: "Verify the fixture content." },
              ],
              encrypted_content: null,
            },
            {
              type: "message",
              id: `comment_fixture_${modelRequests}`,
              role: "assistant",
              phase: "commentary",
              content: [
                {
                  type: "output_text",
                  text: "Reading the fixture.",
                  annotations: [],
                },
              ],
            },
            {
              type: "function_call",
              id: `fc_fixture_${modelRequests}`,
              name: "tidu_caller_tool_0",
              call_id: runningFixture
                ? "call_fixture_cancel"
                : cancelFixture
                  ? "call_fixture_read_before_cancel"
                  : "call_fixture_native",
              arguments: JSON.stringify({
                cmd: runningFixture ? "sleep 20" : "cat fixture.txt",
                max_output_tokens: 1000,
                yield_time_ms: 10000,
              }),
            },
          ];
    if (!receivedToolOutput && !cancelFixture) {
      output.push({
        type: "function_call",
        id: "fc_parallel_fixture",
        name: "tidu_caller_tool_0",
        call_id: "call_parallel_fixture",
        arguments: JSON.stringify({
          cmd: "printf 'native-edit-content\\n' > edited-fixture.txt && cat second-fixture.txt",
          max_output_tokens: 1000,
        }),
      });
    }
    send("response.created", {
      response: {
        id: `resp_fixture_${modelRequests}`,
        object: "response",
        status: "in_progress",
        output: [],
      },
    });
    output.forEach((item, outputIndex) => {
      send("response.output_item.added", { output_index: outputIndex, item });
      if (item.type === "reasoning" && Array.isArray(item.summary)) {
        item.summary.forEach((part: { type: string; text: string }, summaryIndex) => {
          const identity = {
            item_id: item.id,
            output_index: outputIndex,
            summary_index: summaryIndex,
          };
          send("response.reasoning_summary_part.added", {
            ...identity,
            part: { type: "summary_text", text: "" },
          });
          send("response.reasoning_summary_text.delta", {
            ...identity,
            delta: part.text,
          });
          send("response.reasoning_summary_text.done", {
            ...identity,
            text: part.text,
          });
          send("response.reasoning_summary_part.done", { ...identity, part });
        });
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        const identity = {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
        };
        send("response.content_part.added", {
          ...identity,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send("response.output_text.delta", {
          ...identity,
          delta: item.content[0].text,
        });
        send("response.output_text.done", {
          ...identity,
          text: item.content[0].text,
        });
        send("response.content_part.done", {
          ...identity,
          part: item.content[0],
        });
      }
      send("response.output_item.done", { output_index: outputIndex, item });
    });
    send("response.completed", {
      response: {
        id: `resp_fixture_${modelRequests}`,
        object: "response",
        status: "completed",
        output,
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const wrapper = join(directory, "fixture-host");
  // The synthetic login status applies only to this isolated local model fixture.
  await writeFile(
    wrapper,
    `#!/usr/bin/env node\nconst {spawn}=require("node:child_process");\nif(process.argv[2]==="login"){console.log("Logged in to fixture");process.exit(0)}\nconst child=spawn(${JSON.stringify(command)},["-c",${JSON.stringify(`model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false}`)},...process.argv.slice(2)],{stdio:"inherit"});\nprocess.on("SIGTERM",()=>child.kill("SIGTERM"));child.on("exit",code=>process.exit(code??1));\n`,
  );
  await chmod(wrapper, 0o700);
  await writeFile(join(directory, "fixture.txt"), "native-fixture-content\n");
  await writeFile(join(directory, "second-fixture.txt"), "native-second-content\n");
  const provider = await createCodexHostModelProvider("fixture", {
    command: wrapper,
    codexHomeDirectory: directory,
    modelProvider: "fixture",
  });
  assert.ok(provider);
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    provider,
  });
  const notifications: JsonRpcNotification[] = [];
  let notify: (() => void) | undefined;
  await mkdir(join(directory, "caller"));
  const createCaller = () =>
    createStdioJsonRpcClient(
      {
        command: process.execPath,
        arguments: [
          ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
          fileURLToPath(
            new URL(
              `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
              import.meta.url,
            ),
          ),
          "-c",
          'model_provider="fixture"',
          "-c",
          `model_providers.fixture={name="fixture",base_url="${runtime.origin}/v1/hosts/codex",wire_api="responses",requires_openai_auth=false}`,
          "app-server",
        ],
        environment: {
          PATH: process.env.PATH,
          CODEX_HOME: join(directory, "caller"),
          TIDU_CODEX_REAL_COMMAND: command,
          TIDU_CODEX_RECOVERY_PROVIDER: "fixture",
        },
        workingDirectory: directory,
      },
      {
        onNotification: (notification) => {
          notifications.push(notification);
          notify?.();
        },
      },
    );
  let caller = createCaller();
  try {
    await caller.request("initialize", {
      clientInfo: { name: "tidu_native_caller_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    caller.notify("initialized");
    const started = await caller.request<{ thread: { id: string } }>("thread/start", {
      model: "ai-tidu9-config",
      modelProvider: "fixture",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      persistExtendedHistory: true,
    });
    await caller.request("thread/inject_items", {
      threadId: started.thread.id,
      items: ["user", "assistant"].map((role) => ({
        type: "message",
        role,
        content: [
          {
            type: role === "assistant" ? "output_text" : "input_text",
            text: "fixture context ".repeat(40_000),
          },
        ],
      })),
    });
    await caller.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Read the fixture file and report its content." }],
    });
    const waitFor = async (matches: () => boolean): Promise<void> => {
      while (!matches()) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Native fixture event missing after ${modelRequests} model calls: ${JSON.stringify(notifications.slice(-12))}`,
                ),
              ),
            10_000,
          );
          notify = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
      }
    };
    await waitFor(() =>
      notifications.some((notification) => notification.method === "turn/completed"),
    );
    const saved = await caller.request<{
      thread: {
        turns: {
          status: string;
          items: {
            type: string;
            id: string;
            command?: string;
            aggregatedOutput?: string;
            phase?: string;
            text?: string;
            summary?: string[];
          }[];
        }[];
      };
    }>("thread/read", { threadId: started.thread.id, includeTurns: true });
    const turn = saved.thread.turns[0];
    assert.equal(
      turn?.status,
      "completed",
      JSON.stringify(notifications.filter((notification) => notification.method === "error")),
    );
    assert.equal(modelRequests, 2);
    assert.equal(receivedToolOutput, true);
    assert.equal(
      await readFile(join(directory, "edited-fixture.txt"), "utf8"),
      "native-edit-content\n",
    );
    const executed = turn?.items.filter((item) => item.type === "commandExecution");
    assert.equal(executed?.length, 2);
    assert.match(
      executed?.find((item) => item.command?.includes("cat fixture.txt"))?.aggregatedOutput ?? "",
      /native-fixture-content/u,
    );
    assert.equal(executed?.filter((item) => item.command?.includes("cat fixture.txt")).length, 1);
    assert.equal(
      executed?.filter((item) => item.command?.includes("cat second-fixture.txt")).length,
      1,
    );
    const reasoning = turn?.items.filter((item) => item.type === "reasoning");
    assert.equal(reasoning?.length, 1, JSON.stringify(turn));
    assert.deepEqual(reasoning?.[0]?.summary, [
      "Inspect the fixture file.",
      "Verify the fixture content.",
    ]);
    const commentary = turn?.items.filter(
      (item) => item.type === "agentMessage" && item.phase === "commentary",
    );
    assert.equal(commentary?.length, 1, JSON.stringify(turn));
    assert.equal(commentary?.[0]?.text, "Reading the fixture.");
    const reasoningDeltas = notifications
      .filter((notification) => notification.method === "item/reasoning/summaryTextDelta")
      .map((notification) => {
        const { itemId, summaryIndex, delta } = notification.params as {
          itemId: string;
          summaryIndex: number;
          delta: string;
        };
        return { itemId, summaryIndex, delta };
      });
    assert.deepEqual(reasoningDeltas, [
      {
        itemId: reasoning?.[0]?.id,
        summaryIndex: 0,
        delta: "Inspect the fixture file.",
      },
      {
        itemId: reasoning?.[0]?.id,
        summaryIndex: 1,
        delta: "Verify the fixture content.",
      },
    ]);
    const answer =
      turn?.items.find((item) => item.type === "agentMessage" && item.phase === "final_answer")
        ?.text ?? "";
    assert.match(answer, /Native fixture verified\./u);
    assert.match(answer, /(?:合|total) 30/u);
    cancelFixture = true;
    notifications.length = 0;
    const cancellable = await caller.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Run the cancellation fixture." }],
    });
    await waitFor(() =>
      notifications.some((notification) => {
        const params = notification.params as {
          item?: { type?: string; status?: string; command?: string };
        };
        return (
          notification.method === "item/started" &&
          params.item?.type === "commandExecution" &&
          params.item.status === "inProgress" &&
          params.item.command?.includes("sleep 20")
        );
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await caller.request("turn/interrupt", {
      threadId: started.thread.id,
      turnId: cancellable.turn.id,
    });
    await waitFor(() =>
      notifications.some((notification) => notification.method === "turn/completed"),
    );
    const cancelled = await caller.request<{
      thread: {
        turns: {
          status: string;
          durationMs: number;
          items: {
            type: string;
            command?: string;
            summary?: string[];
            text?: string;
            aggregatedOutput?: string;
          }[];
        }[];
      };
    }>("thread/read", { threadId: started.thread.id, includeTurns: true });
    const cancelledTurn = cancelled.thread.turns.at(-1);
    assert.equal(cancelledTurn?.status, "interrupted");
    assert.ok((cancelledTurn?.durationMs ?? 0) >= 1_000);
    assert.ok(
      cancelledTurn?.items.some(
        (item) => item.type === "commandExecution" && item.command?.includes("cat fixture.txt"),
      ),
      JSON.stringify(cancelledTurn),
    );
    assert.ok(
      cancelledTurn?.items.some(
        (item) =>
          item.type === "commandExecution" &&
          item.command === "sleep 20" &&
          item.aggregatedOutput?.includes("aborted by user"),
      ),
    );
    assert.ok(
      cancelledTurn?.items.some(
        (item) => item.type === "agentMessage" && item.text === "总：入 24 · 出 6 · 合 30",
      ),
    );
    assert.ok(
      cancelledTurn?.items.some(
        (item) => item.type === "reasoning" && item.summary?.includes("Inspect the fixture file."),
      ),
    );
    const requestsBeforeReopen = modelRequests;
    const pages = await caller.request<{
      data: {
        id: string;
        items: { type: string; command?: string; text?: string }[];
      }[];
    }>("thread/turns/list", {
      threadId: started.thread.id,
      itemsView: "full",
      limit: 10,
    });
    assert.ok(
      pages.data
        .find((turn) => turn.id === cancellable.turn.id)
        ?.items.some((item) => item.command?.includes("sleep 20")),
    );
    const itemPage = await caller.request<{
      data: { item: { id: string; text?: string; command?: string } }[];
    }>("thread/items/list", {
      threadId: started.thread.id,
      turnId: cancellable.turn.id,
      limit: 100,
    });
    assert.ok(itemPage.data.some((entry) => entry.item.command?.includes("sleep 20")));
    assert.ok(itemPage.data.some((entry) => entry.item.text === "总：入 24 · 出 6 · 合 30"));
    const itemRead = await caller.request<{ data: { item: { id: string } }[] }>(
      "thread/items/read",
      {
        threadId: started.thread.id,
        turnId: cancellable.turn.id,
        itemIds: ["call_fixture_cancel", `tidu_usage_${cancellable.turn.id}`],
      },
    );
    assert.equal(itemRead.data.length, 2);
    await caller.close();
    caller = createCaller();
    await caller.request("initialize", {
      clientInfo: { name: "tidu_native_reopen_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    caller.notify("initialized");
    const reopened = await caller.request<{
      thread: {
        turns: {
          id: string;
          durationMs: number;
          items: { type: string; command?: string; text?: string }[];
        }[];
      };
    }>("thread/resume", { threadId: started.thread.id });
    const reopenedTurn = reopened.thread.turns.at(-1);
    assert.equal(modelRequests, requestsBeforeReopen);
    assert.ok((reopenedTurn?.durationMs ?? 0) >= 1000);
    assert.ok(
      reopenedTurn?.items.some(
        (item) => item.type === "commandExecution" && item.command?.includes("sleep 20"),
      ),
      JSON.stringify(reopened),
    );
    assert.ok(
      reopenedTurn?.items.some(
        (item) => item.type === "agentMessage" && item.text === "总：入 24 · 出 6 · 合 30",
      ),
    );
    const stoppedHtml = await renderNativeStoppedStatus(reopenedTurn?.durationMs ?? 0);
    if (stoppedHtml !== undefined) {
      assert.match(stoppedHtml, /你在.*秒.*后停止了/u);
      assert.doesNotMatch(stoppedHtml, /\b0秒|\b0s/u);
    }
    waitingFixture = true;
    notifications.length = 0;
    const waiting = await caller.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Wait for the fixture model." }],
    });
    await waitFor(() =>
      notifications.some(
        (notification) =>
          notification.method === "item/reasoning/summaryTextDelta" &&
          JSON.stringify(notification.params).includes("Waiting for the fixture model."),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await caller.request("turn/interrupt", {
      threadId: started.thread.id,
      turnId: waiting.turn.id,
    });
    await waitFor(() =>
      notifications.some((notification) => notification.method === "turn/completed"),
    );
    assert.ok(
      notifications.some(
        (notification) =>
          notification.method === "item/completed" &&
          JSON.stringify(notification.params).includes("总：未获取到"),
      ),
    );
    await caller.close();
    caller = createCaller();
    await caller.request("initialize", {
      clientInfo: { name: "tidu_early_cancel_reopen", version: "1" },
      capabilities: { experimentalApi: true },
    });
    caller.notify("initialized");
    const earlyReopened = await caller.request<{
      thread: {
        turns: {
          durationMs: number;
          items: { type: string; text?: string }[];
        }[];
      };
    }>("thread/resume", { threadId: started.thread.id });
    const earlyTurn = earlyReopened.thread.turns.at(-1);
    assert.ok(
      earlyTurn?.items.some((item) => item.type === "agentMessage" && item.text === "总：未获取到"),
    );
    const earlyStoppedHtml = await renderNativeStoppedStatus(earlyTurn?.durationMs ?? 0);
    if (earlyStoppedHtml !== undefined) {
      assert.match(earlyStoppedHtml, /你在.*秒.*后停止了/u);
      assert.doesNotMatch(earlyStoppedHtml, /\b0秒|\b0s/u);
    }
  } finally {
    await caller.close();
    await runtime.close();
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

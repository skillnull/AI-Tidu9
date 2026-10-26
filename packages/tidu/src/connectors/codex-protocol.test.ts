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

import { createCodexHostModelProvider, createLiveJsonStream } from "../providers/codex-host.js";
import { startLocalRuntime } from "../runtime/index.js";
import { createStdioJsonRpcClient, type JsonRpcNotification } from "./json-rpc.js";

// Render the installed native stopped-status component with its actual duration formatter.
// This reads bundled application code only and never accesses desktop accounts or UI state.
const renderNativeStoppedStatus = async (durationMs: number): Promise<string | undefined> => {
  const archivePath = process.env.TIDU_CODEX_APP_ASAR;
  if (archivePath === undefined) return undefined;
  const archive = await readFile(archivePath);
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString()) as {
    files: Record<
      string,
      { files: Record<string, { files: Record<string, { offset: string; size: number }> }> }
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
      | React.ComponentType<{ status: string; startedAtMs: number; completedAtMs: number }>
      | undefined,
  };
  runInNewContext(
    `${formatCode}\n${cacheName}=new Map();\n${worked}\nS={c:size=>Array(size).fill(Symbol.for("react.memo_cache_sentinel"))};C=React;w=jsxRuntime;o=()=>({locale:"zh-CN"});m=()=>{};h=${formatter[1]};n=(...values)=>values.filter(Boolean).join(" ");s=props=>stoppedLabel.replace("{time}",props.values.time);NativeWorkedFor=v;`,
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
    await client.request("turn/interrupt", { threadId: started.thread.id, turnId: turn.turn.id });
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
      input?: { type?: string; output?: unknown }[];
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
        response: { id: "waiting_response", object: "response", status: "in_progress", output: [] },
      });
      const item = {
        type: "reasoning",
        id: "waiting_reasoning",
        summary: [{ type: "summary_text", text: "Waiting for the fixture model." }],
      };
      send("response.output_item.added", { output_index: 0, item });
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
              content: [{ type: "output_text", text: "Native fixture verified.", annotations: [] }],
            },
          ]
        : [
            {
              type: "reasoning",
              id: `rs_fixture_${modelRequests}`,
              summary: [{ type: "summary_text", text: "Inspect the fixture file." }],
              encrypted_content: null,
            },
            {
              type: "message",
              id: `comment_fixture_${modelRequests}`,
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "Reading the fixture.", annotations: [] }],
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
    if (!receivedToolOutput && !cancelFixture)
      output.push({
        type: "function_call",
        id: "fc_parallel_fixture",
        name: "tidu_caller_tool_0",
        call_id: "call_parallel_fixture",
        arguments: JSON.stringify({ cmd: "cat second-fixture.txt", max_output_tokens: 1000 }),
      });
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
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0, provider });
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
      sandbox: "read-only",
      persistExtendedHistory: true,
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
              reject(new Error(`Native fixture event missing after ${modelRequests} model calls.`)),
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
            command?: string;
            aggregatedOutput?: string;
            phase?: string;
            text?: string;
          }[];
        }[];
      };
    }>("thread/read", { threadId: started.thread.id, includeTurns: true });
    const turn = saved.thread.turns[0];
    assert.equal(turn?.status, "completed");
    assert.equal(modelRequests, 2);
    assert.equal(receivedToolOutput, true);
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
    assert.ok(
      turn?.items.some(
        (item) =>
          item.type === "agentMessage" &&
          item.phase === "commentary" &&
          item.text === "Reading the fixture.",
      ),
    );
    const answer =
      turn?.items.find((item) => item.type === "agentMessage" && item.phase === "final_answer")
        ?.text ?? "";
    assert.match(answer, /Native fixture verified\./u);
    assert.match(answer, /(?:合计|total) 30/u);
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
        (item) => item.type === "agentMessage" && item.text === "Token：输入 24 · 输出 6 · 合计 30",
      ),
    );
    assert.ok(
      cancelledTurn?.items.some(
        (item) => item.type === "reasoning" && item.summary?.includes("Inspect the fixture file."),
      ),
    );
    const requestsBeforeReopen = modelRequests;
    const pages = await caller.request<{
      data: { id: string; items: { type: string; command?: string; text?: string }[] }[];
    }>("thread/turns/list", { threadId: started.thread.id, itemsView: "full", limit: 10 });
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
    assert.ok(
      itemPage.data.some((entry) => entry.item.text === "Token：输入 24 · 输出 6 · 合计 30"),
    );
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
        (item) => item.type === "agentMessage" && item.text === "Token：输入 24 · 输出 6 · 合计 30",
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
          notification.method === "item/completed" &&
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
          JSON.stringify(notification.params).includes("Token：未获取到"),
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
      thread: { turns: { durationMs: number; items: { type: string; text?: string }[] }[] };
    }>("thread/resume", { threadId: started.thread.id });
    const earlyTurn = earlyReopened.thread.turns.at(-1);
    assert.ok(
      earlyTurn?.items.some(
        (item) => item.type === "agentMessage" && item.text === "Token：未获取到",
      ),
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
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

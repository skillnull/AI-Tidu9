import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexAgentClient } from "./codex-app-server.js";
import { createCursorAcpClient } from "./cursor-acp.js";

const createFakeAgent = (
  root: string,
  setModelResponse: "confirmed" | "missing" | "mismatched" = "confirmed",
): string => {
  const executable = join(root, "fake-agent");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
if (args[0] === "status") { console.log("Authenticated"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Agent Client Protocol ACP"); process.exit(0); }
const mode = args[0] === "app-server" ? "codex" : "cursor";
let selectedModel = "auto-smart";
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "authenticate") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "thread/start") send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-1" }, model: "gpt-test" } });
  else if (request.method === "turn/start") {
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-1" } } });
    send({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", summaryIndex: 0, delta: "reasoning-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "commentary-1", delta: "working-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "commandExecution", id: "command-1", command: "rg process src", cwd: ".", processId: null, source: "agent", status: "inProgress", commandActions: [{ type: "search", command: "rg process src", query: "process", path: "src" }], aggregatedOutput: null, exitCode: null, durationMs: null } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "fileChange", id: "file-1", changes: [{ path: "src/index.ts", kind: "update", diff: "" }], status: "completed" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "webSearch", id: "web-1", query: "Responses API events", action: { type: "search", query: "Responses API events", queries: null }, results: null } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "contextCompaction", id: "compact-1" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "agentMessage", id: "future-1", text: "", phase: "future_answer", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "future-1", delta: "future-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: Date.now(), item: { type: "agentMessage", id: "final-1", text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "final-1", delta: request.params.effort + "-codex-result" } });
    send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
  else if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-1", configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "auto-smart", name: "Auto Balance" }, { value: "cursor-fast", name: "Cursor Fast" }, { value: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]", name: "claude-opus-5" }] }] } });
  else if (request.method === "session/set_config_option") {
    selectedModel = request.params.value;
    const responseMode = ${JSON.stringify(setModelResponse)};
    const result = responseMode === "missing"
      ? {}
      : { configOptions: [{ configId: "model", category: "model", type: "select", currentValue: responseMode === "mismatched" ? "different-model" : selectedModel }] };
    send({ jsonrpc: "2.0", id: request.id, result });
  }
  else if (request.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "future_answer_chunk", content: { type: "text", text: "future-" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cursor-result" } } } });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
  }
  else send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  return executable;
};

test("Codex app-server adapter negotiates, streams, and completes a turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-adapter-"));
  try {
    const command = createFakeAgent(root);
    const client = createCodexAgentClient({
      command,
      workingDirectory: root,
      reasoningEffort: "low",
    });
    await client.initialize();
    const thread = await client.startThread();
    const deltas: string[] = [];
    const processDeltas: string[] = [];
    const result = await client.prompt(
      thread.id,
      [{ type: "text", text: "test" }],
      undefined,
      (delta) => deltas.push(delta),
      undefined,
      (delta) => processDeltas.push(delta),
    );
    assert.deepEqual(result, {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "future-low-codex-result",
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });
    assert.deepEqual(deltas, ["future-", "low-codex-result"]);
    assert.deepEqual(processDeltas, [
      "reasoning-",
      "\n\n",
      "working-",
      "\n\n",
      "在 `src` 中搜索 `process`",
      "\n\n",
      "编辑文件 `src/index.ts`",
      "\n\n",
      "搜索网页 `Responses API events`",
      "\n\n",
      "上下文已自动压缩",
    ]);
    const highDeltas: string[] = [];
    const highResult = await client.prompt(
      thread.id,
      [{ type: "text", text: "test high" }],
      undefined,
      (delta) => highDeltas.push(delta),
      "high",
    );
    assert.equal(highResult.text, "future-high-codex-result");
    assert.deepEqual(highDeltas, ["future-", "high-codex-result"]);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP adapter reuses official login and preserves Agent output", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-adapter-"));
  try {
    const command = createFakeAgent(root);
    const processDeltas: string[] = [];
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      onProcessDelta: (delta) => processDeltas.push(delta),
    });
    await client.initialize();
    const session = await client.createSession();
    const deltas: string[] = [];
    const result = await client.prompt(session.id, "test", undefined, (delta) =>
      deltas.push(delta),
    );
    assert.deepEqual(result, {
      sessionId: "session-1",
      stopReason: "end_turn",
      text: "future-cursor-result",
    });
    assert.deepEqual(deltas, ["future-", "cursor-result"]);
    assert.deepEqual(processDeltas, ["thinking"]);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP preserves a provider-owned parameterized model ID end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-parameterized-model-"));
  const requestedModel = "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]";
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel,
    });
    await client.initialize();
    const session = await client.createSession();
    assert.equal(session.model, requestedModel);
    assert.deepEqual(
      session.availableModels.find((candidate) => candidate.id === requestedModel),
      { id: requestedModel, name: "claude-opus-5" },
    );
    assert.equal((await client.prompt(session.id, "test")).text, "future-cursor-result");
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP adapter applies the configured session model", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-adapter-"));
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    const session = await client.createSession();
    assert.equal(session.model, "cursor-fast");
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP rejects a model change without an explicit host confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-unconfirmed-"));
  try {
    const command = createFakeAgent(root, "missing");
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    await assert.rejects(() => client.createSession(), /did not confirm/iu);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP rejects a host-confirmed model that differs from configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-mismatch-"));
  try {
    const command = createFakeAgent(root, "mismatched");
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    await assert.rejects(
      () => client.createSession(),
      /confirmed model different-model instead of configured model cursor-fast/iu,
    );
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

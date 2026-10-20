import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexAgentClient } from "./codex-app-server.js";
import { createCursorAcpClient } from "./cursor-acp.js";

const createFakeAgent = (root: string): string => {
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
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: request.params.effort + "-codex-result" } });
    send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  }
  else if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-1", configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "auto-smart" }, { value: "cursor-fast" }, { value: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]" }] }] } });
  else if (request.method === "session/set_config_option") { selectedModel = request.params.value; send({ jsonrpc: "2.0", id: request.id, result: { configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel }] } }); }
  else if (request.method === "session/prompt") {
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
    const result = await client.prompt(thread.id, "test", undefined, (delta) => deltas.push(delta));
    assert.deepEqual(result, {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "low-codex-result",
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });
    assert.deepEqual(deltas, ["low-codex-result"]);
    const highDeltas: string[] = [];
    const highResult = await client.prompt(
      thread.id,
      "test high",
      undefined,
      (delta) => highDeltas.push(delta),
      "high",
    );
    assert.equal(highResult.text, "high-codex-result");
    assert.deepEqual(highDeltas, ["high-codex-result"]);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP adapter reuses official login and preserves Agent output", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-adapter-"));
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({ command, workingDirectory: root });
    await client.initialize();
    const session = await client.createSession();
    const deltas: string[] = [];
    const result = await client.prompt(session.id, "test", undefined, (delta) =>
      deltas.push(delta),
    );
    assert.deepEqual(result, {
      sessionId: "session-1",
      stopReason: "end_turn",
      text: "cursor-result",
    });
    assert.deepEqual(deltas, ["cursor-result"]);
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
    assert.equal(session.availableModels.includes(requestedModel), true);
    assert.equal((await client.prompt(session.id, "test")).text, "cursor-result");
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

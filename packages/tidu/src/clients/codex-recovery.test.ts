import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexRecoveryRecords, recoverCodexTurn } from "./codex-recovery.js";

const turnId = "cancelled-fixture";
const records = [
  {
    timestamp: "2026-10-26T00:00:00.100Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId },
  },
  {
    timestamp: "2026-10-26T00:00:00.200Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "last-command",
      arguments: '{"cmd":"sleep 20"}',
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  },
  {
    type: "token_usage_record",
    payload: {
      turn_id: turnId,
      turn_token_usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30 },
    },
  },
  {
    timestamp: "2026-10-26T00:00:01.500Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "last-command",
      output: "Wall time: 1.3 seconds\naborted by user",
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  },
  {
    timestamp: "2026-10-26T00:00:01.662Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: turnId, duration_ms: 1562 },
  },
  {
    type: "token_usage_record",
    payload: {
      turn_id: "another-turn",
      turn_token_usage: { input_tokens: 240, output_tokens: 60, total_tokens: 300 },
    },
  },
];

test("restores the real aborted command, exact turn usage, and duration without duplicate items", () => {
  const recovered = recoverCodexTurn(
    { id: turnId, status: "interrupted", durationMs: 0, items: [] },
    records,
    "/fixture",
  );
  assert.equal(recovered.turn.durationMs, 1562);
  const items = recovered.turn.items as Record<string, unknown>[];
  assert.equal(items[0]?.command, "sleep 20");
  assert.equal(items[0]?.status, "failed");
  assert.equal(items[0]?.exitCode, null);
  assert.equal(items[0]?.aggregatedOutput, "Wall time: 1.3 seconds\naborted by user");
  assert.equal(items[1]?.text, "Token：输入 24 · 输出 6 · 合计 30");
  assert.deepEqual(recoverCodexTurn(recovered.turn, records, "/fixture").completedItems, []);
});

test("does not invent an executed command from a call without an abort result", () => {
  const recovered = recoverCodexTurn(
    { id: turnId, status: "interrupted", items: [] },
    records.slice(0, 2),
    "/fixture",
  );
  const items = recovered.turn.items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, "Token：未获取到");
});

test("appends token usage to an existing partial answer without hiding it or duplicating final messages", () => {
  const original = {
    id: "partial",
    type: "agentMessage",
    phase: "final_answer",
    text: "The partial answer stays visible.",
  };
  const recovered = recoverCodexTurn(
    { id: turnId, status: "interrupted", items: [original] },
    records,
    "/fixture",
  );
  const answers = (recovered.turn.items as Record<string, unknown>[]).filter(
    (item) => item.type === "agentMessage",
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.id, "partial");
  assert.equal(
    answers[0]?.text,
    "The partial answer stays visible.\n\nToken：输入 24 · 输出 6 · 合计 30",
  );
  assert.deepEqual(recoverCodexTurn(recovered.turn, records, "/fixture").completedItems, []);
});

test("keeps the cancelled command but creates no token message for officially reported zero usage", () => {
  const zeroRecords = records.map((record) =>
    record.type === "token_usage_record"
      ? {
          ...record,
          payload: {
            ...record.payload,
            turn_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        }
      : record,
  );
  const recovered = recoverCodexTurn(
    { id: turnId, status: "interrupted", items: [] },
    zeroRecords,
    "/fixture",
  );
  assert.equal((recovered.turn.items as Record<string, unknown>[]).length, 1);
  assert.equal((recovered.turn.items as Record<string, unknown>[])[0]?.command, "sleep 20");
});

test("places a failed provider error in the answer before token usage", () => {
  const failureRecords = [
    ...records,
    {
      timestamp: "2026-10-26T00:00:01.700Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        error: {
          message: JSON.stringify({
            error: {
              code: "invalid_tools",
              message: "tools contains unsupported definitions: .",
            },
          }),
        },
      },
    },
  ];
  const recovered = recoverCodexTurn(
    { id: turnId, status: "failed", items: [] },
    failureRecords,
    "/fixture",
  );
  const messages = (recovered.turn.items as Record<string, unknown>[]).filter(
    (item) => item.type === "agentMessage",
  );
  assert.equal(messages.length, 1);
  assert.equal(
    messages[0]?.text,
    "tools contains unsupported definitions: .\n\nToken：输入 24 · 输出 6 · 合计 30",
  );
  assert.deepEqual(recoverCodexTurn(recovered.turn, failureRecords, "/fixture").completedItems, []);
});

test("reads and caches only bounded recovery evidence without creating storage or changing official history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-recovery-"));
  try {
    await mkdir(join(directory, "sessions"));
    const path = join(directory, "sessions", "fixture.jsonl");
    const content = `${"x".repeat(8 * 1024 * 1024 + 100)}\n${JSON.stringify({ type: "response_item", payload: { type: "message", content: "private-prompt-fixture" } })}\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(path, content);
    const before = await stat(path);
    const loaded = await readCodexRecoveryRecords(path, directory);
    assert.doesNotMatch(JSON.stringify(loaded), /private-prompt-fixture/u);
    assert.equal(loaded, await readCodexRecoveryRecords(path, directory));
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.equal(await readFile(path, "utf8"), content);
    assert.deepEqual(await readdir(directory), ["sessions"]);
    assert.deepEqual(await readdir(join(directory, "sessions")), ["fixture.jsonl"]);
    assert.equal(
      recoverCodexTurn({ id: turnId, status: "interrupted", items: [] }, loaded, "/fixture")
        .completedItems.length,
      2,
    );
    await writeFile(join(directory, "auth.json"), "{}");
    await symlink(join(directory, "auth.json"), join(directory, "sessions", "invalid.jsonl"));
    await assert.rejects(
      readCodexRecoveryRecords(join(directory, "sessions", "invalid.jsonl"), directory),
      /official session JSONL/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

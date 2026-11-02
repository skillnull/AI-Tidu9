import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatResponseTokenFooter } from "../runtime/response-usage.js";
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
      turn_token_usage: {
        input_tokens: 24,
        output_tokens: 6,
        total_tokens: 30,
      },
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
      turn_token_usage: {
        input_tokens: 240,
        output_tokens: 60,
        total_tokens: 300,
      },
    },
  },
];

test("does not rewrite failed history with another error or token block", () => {
  for (const chinese of [false, true]) {
    const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
    const footer = formatResponseTokenFooter(
      {
        usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
        complete: true,
        models: [
          {
            host: "codex",
            model: "primary",
            role: "main",
            usage,
            complete: true,
          },
          {
            host: "cursor",
            model: "secondary",
            role: "secondary",
            usage,
            complete: true,
          },
        ],
      },
      chinese,
    );
    const turn = {
      id: turnId,
      status: "failed",
      items: [
        {
          type: "agentMessage",
          id: "answer",
          phase: "final_answer",
          text: `Partial answer\n\n${footer}`,
        },
      ],
    };
    const failureRecords = [
      ...records,
      {
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          error: { message: "Fixture failure" },
        },
      },
    ];
    const recovered = recoverCodexTurn(turn, failureRecords, "/workspace");
    const text = (recovered.turn.items as Record<string, unknown>[])[0]?.text;
    assert.equal(text, `Partial answer\n\n${footer}`);
    assert.deepEqual(
      recoverCodexTurn(recovered.turn, failureRecords, "/workspace").turn,
      recovered.turn,
    );
  }
});

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
            turn_token_usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
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

test("leaves failed provider errors to the native failed state", () => {
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
  assert.equal(messages.length, 0);
  assert.deepEqual(recoverCodexTurn(recovered.turn, failureRecords, "/fixture").completedItems, []);
});

test("does not add managed token presentation to an official turn in a mixed-mode chat", () => {
  const officialRecords = [
    {
      type: "turn_context",
      payload: {
        turn_id: turnId,
        model_provider: "openai",
        model: "official-model",
        private_field: "not-read",
      },
    },
    ...records,
  ];
  const turn = { id: turnId, status: "interrupted", durationMs: 0, items: [] };
  assert.deepEqual(
    recoverCodexTurn(turn, officialRecords, "/fixture", "ai_tidu9", "ai-tidu9-config"),
    {
      turn,
      completedItems: [],
    },
  );
  assert.match(
    JSON.stringify(
      recoverCodexTurn(turn, officialRecords, "/fixture", "openai", "official-model").turn,
    ),
    /Token：输入 24/u,
  );
  assert.deepEqual(
    recoverCodexTurn(
      turn,
      [
        {
          type: "turn_context",
          payload: { turn_id: turnId, model: "official-model" },
        },
        ...records,
      ],
      "/fixture",
      "ai_tidu9",
      "ai-tidu9-config",
    ),
    { turn, completedItems: [] },
  );
  const sharedModelRecords = [
    {
      type: "turn_context",
      payload: { turn_id: turnId, model: "shared-model" },
    },
    ...records,
  ];
  assert.deepEqual(
    recoverCodexTurn(turn, sharedModelRecords, "/fixture", "ai_tidu9", "shared-model"),
    { turn, completedItems: [] },
  );
  assert.match(
    JSON.stringify(
      recoverCodexTurn(turn, sharedModelRecords, "/fixture", "ai_tidu9", "shared-model", true).turn,
    ),
    /Token：输入 24/u,
  );
});

test("reads and caches only bounded recovery evidence without creating storage or changing official history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-recovery-"));
  try {
    await mkdir(join(directory, "sessions"));
    const path = join(directory, "sessions", "fixture.jsonl");
    const content = `${"x".repeat(8 * 1024 * 1024 + 100)}\n${JSON.stringify({ type: "response_item", payload: { type: "message", content: "private-prompt-fixture" } })}\n${JSON.stringify({ type: "turn_context", payload: { turn_id: turnId, model_provider: "ai_tidu9", model: "ai-tidu9-config", private_field: "private-context-fixture" } })}\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(path, content);
    const before = await stat(path);
    const loaded = await readCodexRecoveryRecords(path, directory);
    assert.doesNotMatch(JSON.stringify(loaded), /private-prompt-fixture/u);
    assert.doesNotMatch(JSON.stringify(loaded), /private-context-fixture/u);
    assert.match(JSON.stringify(loaded), /model_provider/u);
    assert.match(JSON.stringify(loaded), /ai-tidu9-config/u);
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

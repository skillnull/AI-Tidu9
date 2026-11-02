import assert from "node:assert/strict";
import test from "node:test";
import {
  createResponseUsageLedger,
  formatResponseTokenFooter,
  type ResponseModelUsage,
} from "./response-usage.js";

const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };

const models = [
  { host: "cursor", model: "secondary-fixture", role: "secondary", usage, complete: true },
  { host: "codex", model: "primary-fixture", role: "main", usage, complete: true },
] as const satisfies readonly ResponseModelUsage[];

test("counts parallel tool calls once and separates the next user turn", () => {
  const ledger = createResponseUsageLedger();
  const first = ledger.begin([{ role: "user", content: "fixture" }]);
  first.finish(
    [
      { type: "function_call", call_id: "first" },
      { type: "function_call", call_id: "parallel" },
    ],
    usage,
  );
  const resumed = ledger.begin([
    { role: "user", content: "fixture" },
    { type: "function_call_output", call_id: "first" },
    { type: "function_call_output", call_id: "parallel" },
  ]);
  assert.equal(resumed.snapshot(usage).usage?.totalTokens, 30);
  assert.equal(resumed.snapshot(usage).complete, true);
  const nextTurn = ledger.begin([
    { role: "user", content: "fixture" },
    { type: "function_call_output", call_id: "first" },
    { role: "user", content: "new turn" },
  ]);
  assert.equal(nextTurn.snapshot(usage).usage?.totalTokens, 15);
  resumed.finish([], usage);
  assert.equal(
    ledger.begin([{ type: "function_call_output", call_id: "first" }]).snapshot(usage).complete,
    false,
  );
});

test("shows retrieved usage, labels unavailable counts, and hides confirmed zero consumption", () => {
  assert.equal(
    formatResponseTokenFooter({ usage: null, complete: false }, true),
    "Token：未获取到",
  );
  assert.equal(
    formatResponseTokenFooter({ usage: null, complete: false }, false),
    "Tokens: not retrieved",
  );
  assert.equal(
    formatResponseTokenFooter({ usage, complete: false }, true),
    "Token：输入 12 · 输出 3 · 合计 15",
  );
  assert.equal(
    formatResponseTokenFooter(
      { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, complete: true },
      true,
    ),
    "",
  );
  assert.equal(
    formatResponseTokenFooter({ usage, complete: true }, false),
    "Token: input 12 · output 3 · total 15",
  );
});

test("accumulates each model across three rounds without counting parallel tool outputs twice", () => {
  const ledger = createResponseUsageLedger();
  const roundUsage = { inputTokens: 24, outputTokens: 6, totalTokens: 30 };
  const input = [{ role: "user", content: "fixture" }];
  const outputs = [
    { type: "function_call_output", call_id: "first" },
    { type: "function_call_output", call_id: "parallel" },
  ];
  ledger.begin(input).finish(
    outputs.map((output) => ({ ...output, type: "function_call" })),
    roundUsage,
    models,
  );
  const second = ledger.begin([...input, ...outputs]);
  assert.equal(second.snapshot(roundUsage, models).usage?.totalTokens, 60);
  assert.deepEqual(
    second.snapshot(roundUsage, models).models?.map((model) => model.usage?.totalTokens),
    [30, 30],
  );
  second.finish([{ type: "function_call", call_id: "second" }], roundUsage, models);
  const third = ledger.begin([
    ...input,
    ...outputs,
    { type: "function_call_output", call_id: "second" },
  ]);
  const snapshot = third.snapshot(roundUsage, models);
  assert.equal(snapshot.usage?.totalTokens, 90);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    snapshot.models?.map((model) => [model.role, model.usage]),
    [
      ["main", { inputTokens: 36, outputTokens: 9, totalTokens: 45 }],
      ["secondary", { inputTokens: 36, outputTokens: 9, totalTokens: 45 }],
    ],
  );
  third.finish([], roundUsage, models);
  assert.equal(
    ledger.begin([{ role: "user", content: "next turn" }]).snapshot(roundUsage, models).usage
      ?.totalTokens,
    30,
  );
  assert.equal(ledger.begin(outputs).snapshot(null).usage, null);
});

test("formats primary and secondary input, output, and total independently in both languages", () => {
  const snapshot = createResponseUsageLedger()
    .begin([])
    .snapshot({ inputTokens: 24, outputTokens: 6, totalTokens: 30 }, models);
  assert.equal(
    formatResponseTokenFooter(snapshot, true),
    [
      "Token：输入 24 · 输出 6 · 合计 30",
      "Codex：输入 12 · 输出 3 · 合计 15",
      "副模型 Cursor (secondary-fixture)：输入 12 · 输出 3 · 合计 15",
    ].join("\n\n"),
  );
  assert.equal(
    formatResponseTokenFooter(snapshot, false),
    [
      "Token: input 24 · output 6 · total 30",
      "Codex: input 12 · output 3 · total 15",
      "Secondary Cursor (secondary-fixture): input 12 · output 3 · total 15",
    ].join("\n\n"),
  );
});

test("keeps missing model usage distinct from zero and marks partially reported models", () => {
  const ledger = createResponseUsageLedger();
  const primary = models[1];
  const secondary = models[0];
  ledger
    .begin([])
    .finish([{ type: "function_call", call_id: "missing" }], usage, [
      primary,
      { ...secondary, usage: null, complete: false },
    ]);
  const snapshot = ledger
    .begin([{ type: "function_call_output", call_id: "missing" }])
    .snapshot(usage, [secondary]);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.models?.find((model) => model.role === "secondary")?.complete, false);
  assert.match(
    formatResponseTokenFooter(snapshot, true),
    /副模型 Cursor \(secondary-fixture\)：.*合计 15（部分统计）/u,
  );
  assert.match(
    formatResponseTokenFooter(snapshot, false),
    /Secondary Cursor \(secondary-fixture\): .*total 15 \(partial\)/u,
  );
  const missing = ledger.begin([]).snapshot(usage, [
    { ...primary, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    { ...secondary, usage: null, complete: false },
  ]);
  const footer = formatResponseTokenFooter(missing, true);
  assert.doesNotMatch(footer, /Codex/u);
  assert.match(footer, /副模型 Cursor \(secondary-fixture\)：未获取到/u);
});

test("deduplicates one host execution even when adapter roles differ", () => {
  const snapshot = createResponseUsageLedger()
    .begin([])
    .snapshot(usage, [
      { ...models[1], model: "shared" },
      { ...models[0], model: "shared" },
      { ...models[0], host: "codex", model: "shared" },
    ]);
  assert.equal(snapshot.models?.length, 2);
  assert.equal(snapshot.models?.find((model) => model.host === "codex")?.role, "main");
});

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
  assert.equal(formatResponseTokenFooter({ usage: null, complete: false }, true), "总：未获取到");
  assert.equal(
    formatResponseTokenFooter({ usage: null, complete: false }, false),
    "Total: not retrieved",
  );
  assert.equal(
    formatResponseTokenFooter({ usage, complete: false }, true),
    "总：入 12 · 出 3 · 合 15",
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
    "Total: input 12 · output 3 · total 15",
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

test("usage history combinations retain every round without counting ancestors twice", () => {
  let combinations = 0;
  for (const fullHistory of [false, true])
    for (const kind of ["function", "custom_tool", "tool_search"])
      for (const batch of [1, 2])
        for (const rounds of [1, 2, 3, 5])
          for (const availability of ["known", "missing", "zero"]) {
            const ledger = createResponseUsageLedger();
            const original = [{ role: "user", content: "fixture" }];
            const history: Record<string, unknown>[] = [...original];
            let pending: Record<string, unknown>[] = [];
            for (let round = 0; round < rounds; round += 1) {
              const current =
                availability === "missing" && round === 0
                  ? null
                  : availability === "zero"
                    ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
                    : usage;
              const modelUsage: ResponseModelUsage[] = [
                { ...models[1], usage: current, complete: current !== null },
              ];
              const turn = ledger.begin(fullHistory || round === 0 ? history : pending);
              const snapshot = turn.snapshot(current, modelUsage);
              const expectedRounds = availability === "missing" ? round : round + 1;
              assert.equal(
                snapshot.usage?.totalTokens ?? 0,
                availability === "zero" ? 0 : expectedRounds * usage.totalTokens,
                JSON.stringify({ fullHistory, kind, batch, rounds, availability, round }),
              );
              assert.equal(snapshot.complete, availability !== "missing");
              assert.equal(snapshot.models?.[0]?.complete, availability !== "missing");
              if (round === rounds - 1) turn.finish([], current, modelUsage);
              else {
                const calls = Array.from({ length: batch }, (_unused, index) => ({
                  type: kind === "custom_tool" ? "custom_tool_call" : `${kind}_call`,
                  call_id: `call-${round}-${index}`,
                }));
                turn.finish(calls, current, modelUsage);
                pending = calls.map((call) => ({
                  type: kind === "tool_search" ? "tool_search_output" : `${call.type}_output`,
                  call_id: call.call_id,
                  output: "fixture result",
                }));
                history.push(...calls, ...pending);
              }
            }
            assert.equal(ledger.begin(pending).snapshot(null).usage, null);
            combinations += 1;
          }
  assert.equal(combinations, 144);
});

test("late duplicate batches cannot change ancestry or revive a completed turn", () => {
  let combinations = 0;
  for (const fullHistory of [false, true])
    for (const kind of ["function", "custom_tool", "tool_search"])
      for (const batch of [1, 2])
        for (const timing of ["before-next", "after-next", "after-final"]) {
          const ledger = createResponseUsageLedger();
          const calls = (round: number) =>
            Array.from({ length: batch }, (_unused, index) => ({
              type: `${kind}_call`,
              call_id: `${round}-${index}`,
            }));
          const outputs = (round: number) =>
            calls(round).map((call) => ({
              type: kind === "tool_search" ? "tool_search_output" : `${call.type}_output`,
              call_id: call.call_id,
            }));
          ledger.begin([]).finish(calls(0), usage, models);
          const first = ledger.begin(outputs(0));
          const duplicate = ledger.begin(outputs(0));
          first.finish(calls(1), usage, models);
          if (timing === "before-next") duplicate.finish([...calls(1)].reverse(), usage, models);
          ledger.begin(outputs(1)).finish(calls(2), usage, models);
          if (timing === "after-next") duplicate.finish([...calls(1)].reverse(), usage, models);
          const final = ledger.begin(
            fullHistory ? [...outputs(0), ...outputs(1), ...outputs(2)] : outputs(2),
          );
          assert.equal(
            final.snapshot(usage, models).usage?.totalTokens,
            usage.totalTokens * 4,
            JSON.stringify({ fullHistory, kind, batch, timing }),
          );
          assert.equal(final.snapshot(usage, models).complete, true);
          final.finish([], usage, models);
          if (timing === "after-final") duplicate.finish(calls(1), usage, models);
          assert.equal(ledger.begin(outputs(1)).snapshot(null).usage, null);
          combinations += 1;
        }
  assert.equal(combinations, 36);
});

test("a failed or cancelled duplicate cannot release another delivery's usage ancestry", () => {
  let combinations = 0;
  for (const fullHistory of [false, true])
    for (const batch of [1, 2])
      for (const cancelFirst of [false, true])
        for (const partialUsage of [null, usage]) {
          const ledger = createResponseUsageLedger();
          const first = Array.from({ length: batch }, (_unused, index) => ({
            type: "function_call",
            call_id: `first-${index}`,
          }));
          const outputs = first.map((call) => ({
            type: "function_call_output",
            call_id: call.call_id,
          }));
          ledger.begin([]).finish(first, usage, models);
          const successful = ledger.begin(outputs);
          const cancelled = ledger.begin(outputs);
          if (cancelFirst) cancelled.finish([], partialUsage, models, false);
          successful.finish([{ type: "function_call", call_id: "second" }], usage, models);
          if (!cancelFirst) cancelled.finish([], partialUsage, models, false);
          const finalOutput = { type: "function_call_output", call_id: "second" };
          const final = ledger.begin(fullHistory ? [...outputs, finalOutput] : [finalOutput]);
          assert.equal(final.snapshot(usage, models).usage?.totalTokens, usage.totalTokens * 3);
          assert.equal(final.snapshot(usage, models).complete, true);
          final.finish([], usage, models);
          assert.equal(ledger.begin(outputs).snapshot(null).usage, null);
          combinations += 1;
        }
  assert.equal(combinations, 16);
});

test("long output-only chains retain totals when older correlations leave the bounded window", () => {
  const ledger = createResponseUsageLedger();
  const history: Record<string, unknown>[] = [];
  let pending: Record<string, unknown>[] = [];
  for (let round = 0; round < 2_010; round += 1) {
    const turn = ledger.begin(pending);
    const call = { type: "function_call", call_id: `long-${round}` };
    turn.finish([call], usage);
    pending = [{ type: "function_call_output", call_id: call.call_id }];
    history.push(...pending);
  }
  assert.equal(ledger.begin(pending).snapshot(usage).usage?.totalTokens, usage.totalTokens * 2_011);
  const replay = ledger.begin(history).snapshot(usage);
  assert.equal(replay.usage?.totalTokens, usage.totalTokens * 2_011);
  assert.equal(replay.complete, false);
});

test("formats host totals before the overall total without model names or roles", () => {
  const snapshot = createResponseUsageLedger()
    .begin([])
    .snapshot({ inputTokens: 24, outputTokens: 6, totalTokens: 30 }, models);
  assert.equal(
    formatResponseTokenFooter(snapshot, true),
    [
      "Codex：入 12 · 出 3 · 合 15",
      "Cursor：入 12 · 出 3 · 合 15",
      "总：入 24 · 出 6 · 合 30",
    ].join("  \n"),
  );
  assert.equal(
    formatResponseTokenFooter(snapshot, false),
    [
      "Codex: input 12 · output 3 · total 15",
      "Cursor: input 12 · output 3 · total 15",
      "Total: input 24 · output 6 · total 30",
    ].join("  \n"),
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
  assert.match(formatResponseTokenFooter(snapshot, true), /Cursor：.*合 15（部分统计）/u);
  assert.match(formatResponseTokenFooter(snapshot, false), /Cursor: .*total 15 \(partial\)/u);
  const missing = ledger.begin([]).snapshot(usage, [
    { ...primary, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    { ...secondary, usage: null, complete: false },
  ]);
  const footer = formatResponseTokenFooter(missing, true);
  assert.doesNotMatch(footer, /Codex/u);
  assert.match(footer, /Cursor：未获取到/u);
});

test("aggregates multiple models on one host without exposing parameterized IDs", () => {
  const snapshot = createResponseUsageLedger()
    .begin([])
    .snapshot({ inputTokens: 36, outputTokens: 9, totalTokens: 45 }, [
      models[1],
      { ...models[0], model: "fixture[context=256k,reasoning_effort=high,fast=true]" },
      { ...models[0], model: "another-fixture", role: "main" },
    ]);
  assert.equal(
    formatResponseTokenFooter(snapshot, true),
    [
      "Codex：入 12 · 出 3 · 合 15",
      "Cursor：入 24 · 出 6 · 合 30",
      "总：入 36 · 出 9 · 合 45",
    ].join("  \n"),
  );
});

test("keeps partial and unavailable consumption distinct when grouping one host", () => {
  assert.equal(
    formatResponseTokenFooter(
      {
        usage,
        complete: false,
        models: [models[0], { ...models[0], model: "unreported", usage: null, complete: false }],
      },
      true,
    ),
    "Cursor：入 12 · 出 3 · 合 15（部分统计）  \n总：入 12 · 出 3 · 合 15",
  );
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

import assert from "node:assert/strict";
import test from "node:test";
import { createResponseUsageLedger, formatResponseTokenFooter } from "./response-usage.js";

const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };

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

import assert from "node:assert/strict";
import test from "node:test";

import { requestTurnInput } from "./codex-host.js";

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
    {
      type: "function_call",
      id: "call-1",
      call_id: "call-1",
      name: "inspect",
      arguments: "{}",
    },
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

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
  assert.deepEqual(turn.historyItems[0], {
    type: "message",
    id: "user-original",
    role: "user",
    content: [{ type: "input_text", text: "original request" }],
  });
  assert.deepEqual(turn.historyItems[1], {
    type: "message",
    id: "commentary-1",
    status: "completed",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "existing progress" }],
  });
});

test("keeps original images in history while a steer supplies new text and images", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          type: "message",
          id: "user-original",
          role: "user",
          content: [
            { type: "input_text", text: "inspect the original image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,b3JpZ2luYWw=",
            },
          ],
        },
        {
          type: "message",
          id: "commentary-1",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "existing image progress" }],
        },
        {
          type: "message",
          id: "user-steer",
          role: "user",
          content: [
            { type: "input_text", text: "compare it with this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,c3RlZXI=",
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(turn.input, [
    { type: "text", text: "compare it with this image", text_elements: [] },
    { type: "image", url: "data:image/png;base64,c3RlZXI=" },
  ]);
  assert.deepEqual(turn.historyItems[0], {
    type: "message",
    id: "user-original",
    role: "user",
    content: [
      { type: "input_text", text: "inspect the original image" },
      { type: "input_image", image_url: "data:image/png;base64,b3JpZ2luYWw=" },
    ],
  });
  assert.equal(turn.historyItems[1]?.phase, "commentary");
});

test("preserves every earlier steer while only the newest guidance is active input", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "original request" }],
        },
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "first progress" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "first steer" }],
        },
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "second progress" }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "second steer" }],
        },
      ],
    },
  });

  assert.deepEqual(turn.input, [{ type: "text", text: "second steer", text_elements: [] }]);
  assert.deepEqual(
    turn.historyItems.map((item) => ({
      role: item.role,
      phase: item.phase,
      content: item.content,
    })),
    [
      {
        role: "user",
        phase: undefined,
        content: [{ type: "input_text", text: "original request" }],
      },
      {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "first progress" }],
      },
      {
        role: "user",
        phase: undefined,
        content: [{ type: "input_text", text: "first steer" }],
      },
      {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "second progress" }],
      },
    ],
  );
});

test("keeps completed tool context when guidance is added before the final answer", () => {
  const conversation = [
    {
      type: "message",
      id: "user-original",
      role: "user",
      content: [{ type: "input_text", text: "inspect the project" }],
    },
    {
      type: "function_call",
      id: "call-item",
      call_id: "call-id",
      name: "inspect",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call-id",
      output: "inspection result",
    },
    {
      type: "message",
      id: "user-steer",
      role: "user",
      content: [{ type: "input_text", text: "focus the answer on tests" }],
    },
  ];
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: { input: conversation },
  });

  assert.deepEqual(turn.input, [
    { type: "text", text: "focus the answer on tests", text_elements: [] },
  ]);
  assert.deepEqual(turn.historyItems, conversation.slice(0, -1));
});

test("keeps the completed answer when a later turn asks a follow-up question", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          type: "message",
          id: "user-original",
          role: "user",
          content: [{ type: "input_text", text: "first question" }],
        },
        {
          type: "message",
          id: "answer-original",
          status: "completed",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "first answer" }],
        },
        {
          type: "message",
          id: "user-follow-up",
          role: "user",
          content: [{ type: "input_text", text: "follow-up question" }],
        },
      ],
    },
  });

  assert.deepEqual(turn.input, [{ type: "text", text: "follow-up question", text_elements: [] }]);
  assert.deepEqual(turn.historyItems[1], {
    type: "message",
    id: "answer-original",
    status: "completed",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "first answer" }],
  });
});

test("replays public summaries as text without unverifiable native reasoning state", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first question" }],
        },
        {
          type: "reasoning",
          id: "rs-private",
          summary: [
            { type: "summary_text", text: "Checked the reusable context." },
            { type: "summary_text", text: "Verified the earlier result." },
          ],
          encrypted_content: "provider-private-ciphertext",
        },
        {
          type: "compaction",
          encrypted_content: "provider-private-compaction",
        },
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          encrypted_content: "provider-private-message",
          content: [{ type: "output_text", text: "first answer" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "follow-up question" }],
        },
      ],
    },
  });

  assert.deepEqual(turn.input, [{ type: "text", text: "follow-up question", text_elements: [] }]);
  assert.deepEqual(turn.historyItems, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "first question" }],
    },
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "output_text", text: "Checked the reusable context." },
        { type: "output_text", text: "Verified the earlier result." },
      ],
    },
    {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "first answer" }],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(turn.historyItems),
    /encrypted_content|ciphertext|compaction|rs-private|"type":"reasoning"/u,
  );
});

test("replays hosted tool evidence without importing hosted execution state", () => {
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        {
          type: "web_search_call",
          id: "hosted-search",
          action: { query: "public fixture" },
          encrypted_content: "private",
        },
        {
          type: "function_call",
          call_id: "caller-call",
          name: "inspect",
          arguments: "{}",
          encrypted_function_args: "private",
        },
        {
          type: "function_call_output",
          call_id: "caller-call",
          output: "inspected",
        },
        { role: "user", content: "continue" },
      ],
    },
  });
  assert.equal(turn.historyItems[0]?.type, "message");
  assert.match(JSON.stringify(turn.historyItems[0]?.content), /public fixture/u);
  assert.equal(turn.historyItems[1]?.type, "function_call");
  assert.equal(turn.historyItems[2]?.output, "inspected");
  assert.doesNotMatch(JSON.stringify(turn.historyItems), /encrypted|private/u);
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

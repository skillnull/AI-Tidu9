import assert from "node:assert/strict";
import test from "node:test";

import { createPortableCodexResponsesInput, requestTurnInput } from "./codex-host.js";

test("preserves caller tool results through the runtime privacy boundary", () => {
  const outputs = [
    { type: "function_call_output", call_id: "function-call", output: "function result" },
    { type: "custom_tool_call_output", call_id: "custom-call", output: "custom result" },
    { type: "tool_search_output", call_id: "search-call", tools: [] },
  ];
  assert.deepEqual(
    createPortableCodexResponsesInput(
      outputs.map((item) => ({ ...item, encrypted_content: "fixture-private-state" })),
    ),
    outputs,
  );
});

test("preserves structured caller tool pairs when replaying complete portable history", () => {
  const callerItems = [
    {
      type: "function_call",
      call_id: "function-call",
      name: "inspect",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "function-call", output: "function result" },
    {
      type: "custom_tool_call",
      call_id: "custom-call",
      name: "inspect_custom",
      input: "inspect",
    },
    { type: "custom_tool_call_output", call_id: "custom-call", output: "custom result" },
    {
      type: "tool_search_call",
      call_id: "search-call",
      execution: "client",
      arguments: { queries: ["inspect"] },
    },
    {
      type: "tool_search_output",
      call_id: "search-call",
      tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
    },
  ];
  const portableItems = createPortableCodexResponsesInput(
    callerItems.map((item) => ({ ...item, encrypted_content: "fixture-private-state" })),
  );
  assert.ok(Array.isArray(portableItems));
  const turn = requestTurnInput({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: {
      input: [
        { role: "user", content: [{ type: "input_text", text: "original request" }] },
        ...portableItems,
      ],
    },
  });

  assert.deepEqual(turn.input, []);
  assert.deepEqual(turn.historyItems.slice(1), callerItems);
  assert.doesNotMatch(JSON.stringify(turn.historyItems), /fixture-private-state/u);
});

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

  assert.deepEqual(turn.input, []);
  assert.equal(turn.historyItems.length, conversation.length);
  assert.equal(turn.historyItems[1]?.phase, "commentary");
  assert.equal(turn.historyItems.at(-1)?.type, "function_call_output");
});

test("keeps new user text and images active when non-execution context follows them", () => {
  const previousItems = [
    { type: "function_call", call_id: "earlier-call", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "earlier-call", output: "earlier result" },
  ];
  const currentUser = {
    role: "user",
    content: [
      { type: "input_text", text: "inspect this image" },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    ],
  };
  const contextCases = [
    {
      suffix: [{ role: "developer", content: "current context" }],
      history: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "current context" }],
        },
      ],
    },
    {
      suffix: [{ role: "system", content: "current context" }],
      history: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "current context" }],
        },
      ],
    },
    {
      suffix: [{ type: "compaction", encrypted_content: "fixture-private-compaction" }],
      history: [],
    },
    {
      suffix: [{ type: "context_compaction", encrypted_content: "fixture-private-compaction" }],
      history: [],
    },
  ];

  for (const context of contextCases) {
    const turn = requestTurnInput({
      protocol: "responses",
      virtualModelId: "ai-tidu9-config",
      body: { input: [...previousItems, currentUser, ...context.suffix] },
    });

    assert.deepEqual(turn.input, [
      { type: "text", text: "inspect this image", text_elements: [] },
      { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
    ]);
    assert.deepEqual(turn.historyItems, [...previousItems, ...context.history]);
    assert.doesNotMatch(JSON.stringify(turn.historyItems), /fixture-private-compaction/u);
  }
});

test("does not reactivate a user after execution evidence followed by client context", () => {
  const executionItems = [
    {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "existing progress" }],
    },
    { type: "function_call", call_id: "function-call", name: "inspect", arguments: "{}" },
    { type: "custom_tool_call", call_id: "custom-call", name: "inspect", input: "inspect" },
    { type: "function_call_output", call_id: "function-call", output: "existing result" },
    { type: "custom_tool_call_output", call_id: "custom-call", output: "existing result" },
    { type: "tool_search_output", call_id: "search-call", tools: [] },
  ];

  for (const execution of executionItems) {
    const turn = requestTurnInput({
      protocol: "responses",
      virtualModelId: "ai-tidu9-config",
      body: {
        input: [
          { role: "user", content: "original request" },
          execution,
          { role: "developer", content: "current context" },
        ],
      },
    });

    assert.deepEqual(turn.input, []);
    assert.equal(turn.historyItems[0]?.role, "user");
    assert.equal(turn.historyItems.at(-1)?.role, "developer");
  }
});

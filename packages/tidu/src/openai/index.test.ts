import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultConfiguration } from "../config/index.js";
import {
  createOpenAiModel,
  createProviderOpenAiModel,
  validateChatCompletionRequest,
  validateResponsesRequest,
} from "./index.js";

test("creates an attributed OpenAI-compatible virtual model", () => {
  assert.deepEqual(createOpenAiModel(createDefaultConfiguration(), "2026-10-12T00:00:00.000Z"), {
    id: "ai-tidu9-config",
    created: 1_791_763_200,
    object: "model",
    owned_by: "AI-Tidu9",
    display_name: "九门赛博提督",
  });
});

test("creates a safe public identifier for a configured company service", () => {
  assert.deepEqual(
    createProviderOpenAiModel(
      { type: "openai-compatible", model: "Company/Model V2" },
      "2026-10-12T00:00:00.000Z",
    ),
    {
      id: "company-company-model-v2",
      created: 1_791_763_200,
      object: "model",
      owned_by: "AI-Tidu9 company service",
      display_name: "Company/Model V2",
    },
  );
  assert.equal(
    createProviderOpenAiModel(
      { type: "codex-host", model: "official-model" },
      "2026-10-12T00:00:00.000Z",
    ),
    undefined,
  );
});

test("validates chat-completions and responses requests without reading content", () => {
  assert.equal(
    validateChatCompletionRequest(
      { model: "ai-tidu9-config", messages: [{ role: "user", content: "hello" }] },
      "ai-tidu9-config",
    ).valid,
    true,
  );
  assert.equal(
    validateResponsesRequest({ model: "ai-tidu9-config", input: "hello" }, "ai-tidu9-config").valid,
    true,
  );
  assert.equal(
    validateChatCompletionRequest({ model: "other", messages: [] }, "ai-tidu9-config").error?.error
      .code,
    "model_not_found",
  );
});

test("validates baseline function tools and tool-result messages", () => {
  const chatTool = {
    type: "function",
    function: {
      name: "lookup_weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  };
  assert.equal(
    validateChatCompletionRequest(
      {
        model: "ai-tidu9-config",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Shanghai"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "sunny" },
        ],
        tools: [chatTool],
        tool_choice: "auto",
      },
      "ai-tidu9-config",
    ).valid,
    true,
  );
  assert.equal(
    validateResponsesRequest(
      {
        model: "ai-tidu9-config",
        input: [{ role: "user", content: "weather" }],
        tools: [
          {
            type: "function",
            name: "lookup_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        tool_choice: { type: "function", name: "lookup_weather" },
      },
      "ai-tidu9-config",
    ).valid,
    true,
  );
  assert.equal(
    validateChatCompletionRequest(
      {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "weather" }],
        tools: [{ type: "function", function: { name: "invalid name" } }],
      },
      "ai-tidu9-config",
    ).error?.error.code,
    "invalid_tools",
  );
  assert.equal(
    validateChatCompletionRequest(
      {
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "weather" }],
        tools: [chatTool],
        tool_choice: { type: "function", function: { name: "missing_tool" } },
      },
      "ai-tidu9-config",
    ).error?.error.code,
    "invalid_tool_choice",
  );
});

test("accepts Responses custom tools used by coding-agent clients", () => {
  assert.equal(
    validateResponsesRequest(
      {
        model: "ai-tidu9-config",
        input: "Inspect the workspace.",
        tools: [
          {
            type: "custom",
            name: "shell",
            description: "Run a shell command.",
            format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
          },
          {
            type: "namespace",
            name: "workspace",
            tools: [{ type: "function", name: "read_file", parameters: {} }],
          },
          { type: "web_search", search_context_size: "medium" },
          { type: "tool_search" },
        ],
        tool_choice: "auto",
      },
      "ai-tidu9-config",
    ).valid,
    true,
  );
});

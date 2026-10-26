import assert from "node:assert/strict";
import test from "node:test";
import { createCallerToolCatalog } from "./caller-tools.js";

test("isolates delegated names and restores native function and custom caller tools", () => {
  const catalog = createCallerToolCatalog({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      tools: [
        {
          type: "function",
          name: "exec_command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
        { type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }] },
        { type: "web_search", external_web_access: false },
      ],
    },
  });
  assert.ok(catalog);
  assert.equal(catalog.webSearchMode, "cached");
  assert.deepEqual(
    catalog.definitions.map((tool) => tool.name),
    ["tidu_caller_tool_0", "tidu_caller_tool_1"],
  );
  const command = catalog.outputItem({
    callId: "call-1",
    namespace: null,
    tool: "tidu_caller_tool_0",
    arguments: { cmd: "cat fixture.ts" },
  });
  assert.equal(command.type, "function_call");
  assert.equal(command.name, "exec_command");
  assert.deepEqual(JSON.parse(command.arguments as string), { cmd: "cat fixture.ts" });
  const patch = catalog.outputItem({
    callId: "call-2",
    namespace: null,
    tool: "tidu_caller_tool_1",
    arguments: { input: "*** Begin Patch\n*** End Patch" },
  });
  assert.equal(patch.type, "custom_tool_call");
  assert.equal(patch.name, "apply_patch");
  assert.equal(patch.namespace, "functions");
  assert.equal(patch.input, "*** Begin Patch\n*** End Patch");
  assert.throws(
    () =>
      catalog.outputItem({
        callId: "unknown",
        namespace: null,
        tool: "exec_command",
        arguments: {},
      }),
    /did not declare/u,
  );
});

test("tool_choice none exposes no delegated or native search tools", () => {
  const catalog = createCallerToolCatalog({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      tool_choice: "none",
      tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }],
    },
  });
  assert.deepEqual(catalog?.definitions, []);
  assert.equal(catalog?.webSearchMode, "disabled");
});

test("does not create a delegated catalog for Codex compaction with no tools", () => {
  assert.equal(
    createCallerToolCatalog({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "Compact the current context.", tools: [], tool_choice: "auto" },
    }),
    undefined,
  );
});

test("rejects ambiguous caller tool names instead of choosing a handler", () => {
  assert.throws(
    () =>
      createCallerToolCatalog({
        protocol: "responses",
        virtualModelId: "tidu",
        body: {
          tools: [
            { type: "function", name: "duplicate" },
            { type: "custom", name: "duplicate" },
          ],
        },
      }),
    /Duplicate/u,
  );
});

test("preserves native tool-search calls and translates returned history to delegated aliases", () => {
  const catalog = createCallerToolCatalog({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      tools: [
        { type: "tool_search", parameters: { type: "object" } },
        { type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }] },
      ],
    },
  });
  assert.ok(catalog);
  const search = catalog.outputItem({
    callId: "search",
    namespace: null,
    tool: "tidu_caller_tool_0",
    arguments: { query: "file" },
  });
  assert.equal(search.type, "tool_search_call");
  assert.equal(search.execution, "client");
  const patch = catalog.outputItem({
    callId: "patch",
    namespace: null,
    tool: "tidu_caller_tool_1",
    arguments: { input: "fixture patch" },
  });
  const history = catalog.historyItems([
    search,
    { type: "tool_search_output", call_id: "search", tools: [] },
    patch,
    { type: "custom_tool_call_output", call_id: "patch", output: "real patch result" },
  ]);
  assert.equal(history[0]?.name, "tidu_caller_tool_0");
  assert.equal(history[1]?.type, "function_call_output");
  assert.equal(history[1]?.output, "[]");
  assert.equal(history[2]?.namespace, undefined);
  assert.deepEqual(JSON.parse(history[2]?.arguments as string), { input: "fixture patch" });
  assert.equal(history[3]?.name, "tidu_caller_tool_1");
  assert.equal(history[3]?.output, "real patch result");
});

test("rejects unsupported tool-choice restrictions instead of silently ignoring them", () => {
  assert.throws(
    () =>
      createCallerToolCatalog({
        protocol: "responses",
        virtualModelId: "tidu",
        body: {
          tool_choice: { type: "function", name: "only_this" },
          tools: [{ type: "function", name: "only_this" }],
        },
      }),
    /tool_choice/u,
  );
});

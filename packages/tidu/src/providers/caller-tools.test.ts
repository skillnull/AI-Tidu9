import assert from "node:assert/strict";
import test from "node:test";
import { createCallerToolCatalog, normalizeCallerToolInput } from "./caller-tools.js";

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

test("preserves named bootstrap outputs independently of declared tool kinds", () => {
  for (const tool of [
    { type: "function", name: "inspect" },
    { type: "custom", name: "inspect" },
    { type: "tool_search" },
  ]) {
    const catalog = createCallerToolCatalog({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { tools: [tool] },
    });
    assert.ok(catalog);
    const bootstrap = {
      type: "function_call_output",
      name: "bootstrap",
      namespace: "context",
      output: [{ type: "input_text", text: "Saved context." }],
      retain: true,
    };
    assert.deepEqual(catalog.historyItems([bootstrap]), [bootstrap], tool.type);
  }
});

test("pairs every position in all 39 ordered function custom and search compositions", () => {
  const kinds = ["function", "custom", "tool_search"] as const;
  let verified = 0;
  const verify = (composition: readonly (typeof kinds)[number][]) => {
    const tools = composition.map((kind, index) =>
      kind === "tool_search"
        ? {
            type: "namespace",
            name: `group${index}`,
            tools: [{ type: "tool_search" }],
          }
        : {
            type: "namespace",
            name: `group${index}`,
            tools: [{ type: kind, name: "inspect", defer_loading: true }],
          },
    );
    const catalog = createCallerToolCatalog({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { tools },
    });
    assert.ok(catalog);
    assert.equal(catalog.definitions.length, composition.length);
    const calls = composition.map((kind, index) => {
      assert.equal(catalog.definitions[index]?.name, `tidu_caller_tool_${index}`);
      const call = catalog.outputItem({
        callId: `position-${index}`,
        namespace: null,
        tool: `tidu_caller_tool_${index}`,
        arguments: kind === "custom" ? { input: `custom-${index}` } : { query: `query-${index}` },
      });
      assert.equal(call.namespace, `group${index}`);
      assert.equal(
        call.type,
        kind === "custom"
          ? "custom_tool_call"
          : kind === "tool_search"
            ? "tool_search_call"
            : "function_call",
      );
      return call;
    });
    const history = catalog.historyItems(
      calls.flatMap((call, index) => [
        call,
        composition[index] === "tool_search"
          ? {
              type: "tool_search_output",
              call_id: call.call_id,
              tools: [{ type: "function", name: `discovered-${index}` }],
            }
          : {
              type:
                composition[index] === "custom"
                  ? "custom_tool_call_output"
                  : "function_call_output",
              call_id: call.call_id,
              output: `result-${index}`,
            },
      ]),
    );
    composition.forEach((kind, index) => {
      assert.equal(history[index * 2]?.name, `tidu_caller_tool_${index}`);
      assert.equal(history[index * 2 + 1]?.name, `tidu_caller_tool_${index}`);
      assert.equal(history[index * 2 + 1]?.call_id, calls[index]?.call_id);
      assert.equal(
        history[index * 2 + 1]?.output,
        kind === "tool_search"
          ? JSON.stringify([{ type: "function", name: `discovered-${index}` }])
          : `result-${index}`,
      );
    });
    verified += 1;
  };
  for (const first of kinds) {
    verify([first]);
    for (const second of kinds) {
      verify([first, second]);
      for (const third of kinds) verify([first, second, third]);
    }
  }
  assert.equal(verified, 39);
});

test("normalizes equal results regardless of field order and rejects conflicting or missing IDs", () => {
  for (const type of ["function_call_output", "custom_tool_call_output", "tool_search_output"]) {
    const first =
      type === "tool_search_output"
        ? { type, call_id: "call", tools: [{ type: "function", name: "inspect" }] }
        : { type, call_id: "call", output: { content: "result", success: true } };
    const reordered =
      type === "tool_search_output"
        ? { tools: [{ name: "inspect", type: "function" }], call_id: "call", type }
        : { output: { success: true, content: "result" }, call_id: "call", type };
    assert.deepEqual(normalizeCallerToolInput([first, reordered]), [first]);
    assert.throws(
      () =>
        normalizeCallerToolInput([
          first,
          type === "tool_search_output"
            ? { ...first, tools: [] }
            : { ...first, output: "different" },
        ]),
      /Conflicting caller tool results/u,
    );
    assert.throws(() => normalizeCallerToolInput([{ type, output: "Unowned." }]), /call_id/u);
  }
  for (const identifier of [{}, { call_id: null }]) {
    const bootstrap = {
      type: "function_call_output",
      name: "bootstrap",
      namespace: "context",
      retain: true,
      output: "Context.",
      ...identifier,
    };
    assert.deepEqual(normalizeCallerToolInput([bootstrap]), [bootstrap]);
  }
});

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startTiduMcpServer } from "./mcp-server.js";

const exchange = async (messages: readonly Record<string, unknown>[]): Promise<unknown[]> => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const server = startTiduMcpServer({ input, output });
  for (const message of messages) {
    input.write(`${JSON.stringify(message)}\n`);
  }
  input.end();
  await server.completed;
  await new Promise((resolve) => setImmediate(resolve));
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
};

test("MCP server negotiates and lists bounded tools", async () => {
  const responses = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(responses.length, 2);
  assert.equal(
    (responses[0] as { result: { serverInfo: { name: string } } }).result.serverInfo.name,
    "ai-tidu9",
  );
  assert.deepEqual(
    (responses[1] as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    ),
    ["get_tidu_status", "route_tidu_task"],
  );
});

test("MCP server reports malformed input without leaking state", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const server = startTiduMcpServer({ input, output });
  input.end("not-json\n");
  await server.completed;
  assert.match(text, /Parse error/u);
});

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { TiduChannelGateway } from "../channels/index.js";
import { startTiduMcpServer } from "./mcp-server.js";

const exchange = async (
  messages: readonly Record<string, unknown>[],
  channelGateway?: TiduChannelGateway,
): Promise<unknown[]> => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const server = startTiduMcpServer({ input, output, channelGateway });
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
  assert.match(
    (responses[0] as { result: { instructions: string } }).result.instructions,
    /Agent runtime, not an MCP tool collection/u,
  );
  assert.deepEqual(
    (responses[1] as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    ),
    ["get_tidu_status", "route_tidu_task", "list_tidu_channels", "route_tidu_channel"],
  );
});

test("MCP server exposes explicit dual-channel routing for plugins and Cursor", async () => {
  const channelGateway: TiduChannelGateway = {
    list: async () => [
      {
        id: "tidu",
        name: "九门赛博提督",
        kind: "virtual",
        available: true,
        model: "ai-tidu9-config",
        authority: "tidu-runtime",
        detail: "Runtime ready.",
      },
    ],
    run: async (request) => ({
      channel: request.channel,
      model: request.model ?? "ai-tidu9-config",
      text: `routed:${request.input}`,
    }),
  };
  const responses = await exchange(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_tidu_channels", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "route_tidu_channel",
          arguments: { channel: "tidu", input: "work" },
        },
      },
    ],
    channelGateway,
  );
  assert.equal(
    (responses[0] as { result: { structuredContent: { channels: unknown[] } } }).result
      .structuredContent.channels.length,
    1,
  );
  assert.equal(
    (responses[1] as { result: { structuredContent: { text: string } } }).result.structuredContent
      .text,
    "routed:work",
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

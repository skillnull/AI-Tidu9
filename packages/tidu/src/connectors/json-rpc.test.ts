import assert from "node:assert/strict";
import test from "node:test";

import { createStdioJsonRpcClient } from "./json-rpc.js";

const CHILD_SOURCE = String.raw`
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "echo") send({ jsonrpc: "2.0", id: request.id, result: request.params });
  if (request.method === "notify-me") {
    send({ jsonrpc: "2.0", method: "progress", params: { ok: true } });
    send({ jsonrpc: "2.0", id: request.id, result: true });
  }
});
`;

test("stdio JSON-RPC correlates requests and notifications", async () => {
  const notifications: string[] = [];
  const client = createStdioJsonRpcClient(
    { command: process.execPath, arguments: ["-e", CHILD_SOURCE], environment: process.env },
    { onNotification: (event) => notifications.push(event.method) },
  );
  try {
    assert.deepEqual(await client.request("echo", { value: 9 }), { value: 9 });
    assert.equal(await client.request("notify-me", {}), true);
    assert.deepEqual(notifications, ["progress"]);
  } finally {
    await client.close();
  }
});

test("stdio JSON-RPC rejects cancelled work", async () => {
  const client = createStdioJsonRpcClient({
    command: process.execPath,
    arguments: ["-e", CHILD_SOURCE],
    environment: process.env,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request("never", {}, controller.signal), /cancelled/u);
  await client.close();
});

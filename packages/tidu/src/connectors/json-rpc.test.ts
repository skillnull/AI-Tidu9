import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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

const CLOSED_INPUT_CHILD_SOURCE = String.raw`
require("node:fs").closeSync(0);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready", params: {} }) + "\n");
setTimeout(() => undefined, 10_000);
`;

const EXITING_CHILD_SOURCE = `
process.exit(7);
`;

test("cleans owned descendants after their protocol parent exits", {
  skip: process.platform === "win32",
  timeout: 5000,
}, async () => {
  const descendantSource =
    "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
  const parentSource = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','inherit','inherit','ipc']});const ready=new Promise(resolve=>child.once('message',resolve));require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{const message=JSON.parse(line);await ready;process.stdout.write(JSON.stringify({id:message.id,result:{processId:child.pid}})+'\\n');if(message.method==='exit')process.exit(0);});`;
  const client = createStdioJsonRpcClient({
    command: process.execPath,
    arguments: ["-e", parentSource],
    environment: { PATH: process.env.PATH },
  });
  let descendantId: number | undefined;
  try {
    descendantId = (await client.request<{ processId: number }>("initialize", {})).processId;
    await client.request("exit", {});
    await client.close();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        process.kill(descendantId, 0);
      } catch {
        break;
      }
      await delay(5);
    }
    assert.throws(() => process.kill(descendantId as number, 0), /ESRCH/u);
  } finally {
    if (descendantId !== undefined) {
      try {
        process.kill(descendantId, "SIGKILL");
      } catch {}
    }
    await client.close();
  }
});

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

test("stdio JSON-RPC exchanges messages above 64 MiB without a default byte cap", async () => {
  const launch = {
    command: process.execPath,
    arguments: ["-e", CHILD_SOURCE],
    environment: process.env,
  };
  const client = createStdioJsonRpcClient(launch);
  const bounded = createStdioJsonRpcClient(launch, { maximumMessageBytes: 1024 });
  try {
    const text = "历史与附件".repeat(4_600_000);
    assert.ok(Buffer.byteLength(text) > 64 * 1024 * 1024);
    assert.equal((await client.request<{ text: string }>("echo", { text })).text, text);
    await assert.rejects(bounded.request("echo", { text }), /message exceeds the limit/u);
    assert.equal(await bounded.request("echo", "still connected"), "still connected");
  } finally {
    await Promise.all([client.close(), bounded.close()]);
  }
});

test("stdio JSON-RPC reports the actual size failure for oversized incoming messages", async () => {
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: [
        "-e",
        `process.stdin.once('data',()=>process.stdout.write(JSON.stringify({id:1,result:'x'.repeat(2048)})+'\\n'))`,
      ],
      environment: process.env,
    },
    { maximumMessageBytes: 1024 },
  );
  try {
    await assert.rejects(client.request("large-reply", {}), /message exceeds the limit/u);
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

test("stdio JSON-RPC rejects writes after the child closes its input", async () => {
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: ["-e", CLOSED_INPUT_CHILD_SOURCE],
      environment: process.env,
    },
    {
      onNotification: (notification) => {
        if (notification.method === "ready") markReady();
      },
      requestTimeoutMilliseconds: 1_000,
    },
  );

  try {
    await ready;
    await assert.rejects(client.request("echo", {}), /EPIPE|closed/iu);
  } finally {
    await client.close();
  }
  assert.equal(client.process.exitCode !== null || client.process.signalCode !== null, true);
});

test("stdio JSON-RPC reports a terminal child exit exactly once", async () => {
  const closeErrors: Error[] = [];
  let observeClose = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    observeClose = resolve;
  });
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: ["-e", EXITING_CHILD_SOURCE],
      environment: process.env,
    },
    {
      onClose: (error) => {
        closeErrors.push(error);
        observeClose();
      },
    },
  );
  await closed;
  await client.close();
  assert.equal(closeErrors.length, 1);
  assert.match(closeErrors[0]?.message ?? "", /exited with code 7/u);
});

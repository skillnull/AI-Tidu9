import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexAgentClient } from "./codex-app-server.js";
import { createCursorAcpClient } from "./cursor-acp.js";
import { runCursorHeadless } from "./cursor-headless.js";

const createFakeAgent = (
  root: string,
  setModelResponse: "confirmed" | "missing" | "mismatched" = "confirmed",
  usageFailure: "limits" | "usage" | "both" | "none" = "none",
): string => {
  const executable = join(root, "fake-agent");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
if (args[0] === "status") { console.log("Authenticated"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Agent Client Protocol ACP"); process.exit(0); }
const mode = args[0] === "app-server" ? "codex" : "cursor";
let selectedModel = "auto-smart";
let turnCount = 0;
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { agentCapabilities: { promptCapabilities: { image: true, audio: false, embeddedContext: false } } } });
  else if (request.method === "authenticate") send({ jsonrpc: "2.0", id: request.id, result: {} });
  else if (request.method === "account/rateLimits/read" || request.method === "account/usage/read") {
    const failure = ${JSON.stringify(usageFailure)};
    const limits = request.method === "account/rateLimits/read";
    if (failure === "both" || failure === (limits ? "limits" : "usage")) send({ id: request.id, error: { code: -32601, message: "Unavailable" } });
    else send({ id: request.id, result: limits ? { rateLimits: { limitId: "codex", primary: { usedPercent: 25, resetsAt: 2000000000 }, secondary: { usedPercent: 50 } }, rateLimitResetCredits: { availableCount: 0 } } : { summary: { lifetimeTokens: 42 }, dailyUsageBuckets: [{ startDate: "2026-01-01", tokens: 42 }] } });
  }
  else if (request.method === "thread/start") send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-1" }, model: "gpt-test" } });
  else if (request.method === "turn/start") {
    process.stdout.cork();
    const turnId = "turn-" + (++turnCount);
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } } });
    if (request.params.input.some((item) => item.type === "localImage")) {
      const userMessage = { type: "userMessage", id: "user-1", clientId: null, content: [{ type: "text", text: "test", text_elements: [] }, { type: "localImage", path: "/tmp/input.png" }] };
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: userMessage } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId, completedAtMs: Date.now(), item: userMessage } });
    }
    if (request.params.summary === "auto") send({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId, itemId: "reasoning:1", summaryIndex: 0, delta: "reasoning-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "commentary-1", delta: "working-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: "command-1", command: "rg process src", cwd: ".", processId: null, source: "agent", status: "inProgress", commandActions: [{ type: "search", command: "rg process src", query: "process", path: "src" }], aggregatedOutput: null, exitCode: null, durationMs: null } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", turnId, item: { type: "fileChange", id: "file-1", changes: [{ path: "src/index.ts", kind: "update", diff: "" }], status: "completed" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "webSearch", id: "web-1", query: "Responses API events", action: { type: "search", query: "Responses API events", queries: null }, results: null } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "contextCompaction", id: "compact-1" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "future-1", text: "", phase: "future_answer", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "future-1", delta: "future-" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "final-1", text: "", phase: "final_answer", memoryCitation: null, delivery: null, questions: null } } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "final-1", delta: request.params.effort + "-codex-result" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
    process.stdout.uncork();
    setTimeout(() => send({ jsonrpc: "2.0", method: "rawResponse/completed", params: { threadId: "thread-1", turnId, responseId: "response-1", usage: { inputTokens: 7, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 9 }, usageMetadata: null } }), 5);
    setTimeout(() => send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { inputTokens: 11, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 15 } } } }), 10);
  }
  else if (request.method === "session/new") send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-1", configOptions: [{ configId: "model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "auto-smart", name: "Auto Balance" }, { value: "cursor-fast", name: "Cursor Fast" }, { value: "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]", name: "claude-opus-5" }] }] } });
  else if (request.method === "session/set_config_option") {
    selectedModel = request.params.value;
    const responseMode = ${JSON.stringify(setModelResponse)};
    const result = responseMode === "missing"
      ? {}
      : { configOptions: [{ configId: "model", category: "model", type: "select", currentValue: responseMode === "mismatched" ? "different-model" : selectedModel }] };
    send({ jsonrpc: "2.0", id: request.id, result });
  }
  else if (request.method === "session/prompt") {
    const promptHasImage = request.params.prompt.some((part) => part.type === "image");
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "future_answer_chunk", content: { type: "text", text: "future-" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: promptHasImage ? "cursor-image-result" : "cursor-result" } } } });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 } } });
  }
  else send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`;
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  return executable;
};

const createFakeCursorHeadlessAgent = (
  root: string,
  resultState: "success" | "error" = "success",
): string => {
  const executable = join(root, "fake-cursor-headless");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--print") || !args.includes("--trust") || args[args.indexOf("--mode") + 1] !== "ask" || args[args.indexOf("--output-format") + 1] !== "stream-json" || args[args.indexOf("--model") + 1] !== "cursor-test-model") {
  console.error("unexpected Cursor headless arguments");
  process.exit(2);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  send({ type: "thinking", subtype: "delta", text: "分析" });
  send({ type: "thinking", subtype: "delta", text: "请求" });
  send({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { readToolCall: { args: { path: "README.md" } } } });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: prompt.trim() + "：完成" }] } });
  send({ type: "result", subtype: ${JSON.stringify(resultState)}, is_error: ${resultState === "error"}, result: prompt.trim() + "：完成", usage: { inputTokens: 21, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2 } });
});
`;
  writeFileSync(executable, source);
  chmodSync(executable, 0o700);
  return executable;
};

test("keeps quota and reset counts when the optional usage endpoint fails", async () => {
  for (const failure of ["limits", "usage", "both", "none"] as const) {
    const root = mkdtempSync(join(tmpdir(), "tidu-codex-quota-"));
    const client = createCodexAgentClient({
      command: createFakeAgent(root, "confirmed", failure),
      workingDirectory: root,
    });
    try {
      await client.initialize();
      if (failure === "both") {
        await assert.rejects(client.readUsage(), /Unavailable/u);
        continue;
      }
      const usage = await client.readUsage();
      assert.equal(usage.primary?.usedPercent ?? null, failure === "limits" ? null : 25);
      assert.equal(usage.availableResetCredits, failure === "limits" ? null : 0);
      assert.equal(usage.lifetimeTokens, failure === "usage" ? null : 42);
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Codex app-server adapter negotiates, streams, and completes a turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-adapter-"));
  try {
    const command = createFakeAgent(root);
    const client = createCodexAgentClient({
      command,
      workingDirectory: root,
      reasoningEffort: "low",
    });
    await client.initialize();
    const thread = await client.startThread();
    const deltas: string[] = [];
    const processDeltas: string[] = [];
    const processSources: unknown[] = [];
    const usageUpdates: unknown[] = [];
    const result = await client.prompt(
      thread.id,
      [
        { type: "text", text: "test" },
        { type: "localImage", path: join(root, "input.png") },
      ],
      undefined,
      (delta) => deltas.push(delta),
      undefined,
      (delta, source) => {
        processDeltas.push(delta);
        processSources.push(source);
      },
      [],
      undefined,
      (usage) => usageUpdates.push(usage),
    );
    assert.deepEqual(result, {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      text: "future-low-codex-result",
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
        reasoningTokens: 1,
      },
    });
    assert.deepEqual(deltas, ["future-", "low-codex-result"]);
    assert.deepEqual(processDeltas, [
      "读取图片内容",
      "\n\n",
      "reasoning-",
      "\n\n",
      "working-",
      "\n\n",
      "在 `src` 中搜索 `process`",
      "\n\n",
      "编辑文件 `src/index.ts`",
      "\n\n",
      "搜索网页 `Responses API events`",
      "\n\n",
      "上下文已自动压缩",
      "\n\n",
    ]);
    assert.deepEqual(processSources[2], {
      type: "reasoning",
      itemId: "reasoning:1",
      summaryIndex: 0,
    });
    assert.deepEqual(usageUpdates, [
      {
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        reasoningTokens: 1,
      },
      {
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 2,
        reasoningTokens: 1,
      },
    ]);
    const highDeltas: string[] = [];
    const highResult = await client.prompt(
      thread.id,
      [{ type: "text", text: "test high" }],
      undefined,
      (delta) => highDeltas.push(delta),
      "high",
    );
    assert.equal(highResult.text, "future-high-codex-result");
    assert.deepEqual(highDeltas, ["future-", "high-codex-result"]);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter forwards prompts above 64 MiB without a separate byte cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-large-frame-"));
  const client = createCodexAgentClient({
    command: createFakeAgent(root),
    workingDirectory: root,
    reasoningEffort: "low",
  });
  try {
    await client.initialize();
    const thread = await client.startThread();
    const result = await client.prompt(thread.id, [
      { type: "text", text: "x".repeat(65 * 1024 * 1024) },
    ]);
    assert.equal(result.status, "completed");
    assert.equal(result.text, "future-low-codex-result");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolates agent-message phases across concurrent Codex turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-phase-isolation-"));
  const command = join(root, "phase-agent");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='login'&&args[1]==='status'){console.log('Logged in');process.exit(0);}
const readline=require('node:readline').createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let turnCount=0;let threadCount=0;
readline.on('line',line=>{const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{}});
else if(request.method==='thread/start')send({id:request.id,result:{thread:{id:'thread-'+(++threadCount)},model:'gpt-test'}});
else if(request.method==='turn/start'){
 turnCount+=1;const turnId='turn-'+turnCount;send({id:request.id,result:{turn:{id:turnId}}});
 send({method:'turn/started',params:{threadId:request.params.threadId,turn:{id:turnId,status:'inProgress'}}});
 send({method:'item/started',params:{threadId:request.params.threadId,turnId,item:{type:'agentMessage',id:'shared-message',text:'',phase:turnCount===1?'commentary':'final_answer'}}});
 if(turnCount===2){
  send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'shared-message',delta:'first-commentary'}});
  send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'shared-message',text:'first-commentary',phase:'commentary'}}});
  send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  send({method:'rawResponse/completed',params:{threadId:'thread-1',turnId:'turn-1',usage:{inputTokens:1,outputTokens:1,totalTokens:2}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-2',turnId:'turn-2',itemId:'shared-message',delta:'second-final'}});
  send({method:'item/completed',params:{threadId:'thread-2',turnId:'turn-2',item:{type:'agentMessage',id:'shared-message',text:'second-final',phase:'final_answer'}}});
  send({method:'turn/completed',params:{threadId:'thread-2',turn:{id:'turn-2',status:'completed'}}});
  send({method:'rawResponse/completed',params:{threadId:'thread-2',turnId:'turn-2',usage:{inputTokens:1,outputTokens:1,totalTokens:2}}});
 }
}});`,
  );
  chmodSync(command, 0o700);
  const client = createCodexAgentClient({ command, workingDirectory: root });
  try {
    await client.initialize();
    const thread = await client.startThread();
    const firstProcess: string[] = [];
    const firstTurn = client.prompt(
      thread.id,
      [{ type: "text", text: "first" }],
      undefined,
      undefined,
      undefined,
      (delta) => firstProcess.push(delta),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const secondThread = await client.startThread();
    const secondTurn = client.prompt(secondThread.id, [{ type: "text", text: "second" }]);
    const [firstResult, secondResult] = await Promise.all([firstTurn, secondTurn]);

    assert.equal(firstResult.text, "");
    assert.deepEqual(firstProcess, ["first-commentary", "\n\n"]);
    assert.equal(secondResult.text, "second-final");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns parallel caller results to sequential native RPCs without restarting the turn", {
  timeout: 5000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-tool-continuation-"));
  const command = join(root, "tool-agent");
  writeFileSync(
    command,
    `#!/usr/bin/env node
if (process.argv[2] === "login" && process.argv[3] === "status") { console.log("Logged in to fixture"); process.exit(0); }
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const params = { threadId: "tool-thread", turnId: "tool-turn" };
const requests = [];
const outputs = [];
const tool = (callId) => ({ type: "function_call", call_id: callId, name: "inspect", arguments: "{}" });
const requestTool = (callId) => send({ id: callId, method: "item/tool/call", params: { ...params, callId, tool: "inspect", arguments: {} } });
const response = (callIds) => {
  for (const callId of callIds) send({ method: "rawResponseItem/completed", params: { ...params, item: tool(callId) } });
  send({ method: "rawResponse/completed", params: { ...params, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } } });
  requestTool(callIds[0]);
};
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method) requests.push({ method: request.method, params: request.params });
  if (request.method === "initialize") send({ id: request.id, result: {} });
  else if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "tool-thread" }, model: "gpt-test" } });
  else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "tool-turn" } } });
    send({ method: "turn/started", params: { threadId: params.threadId, turn: { id: params.turnId, status: "inProgress" } } });
    response(["call-first", "call-second"]);
  } else if (request.method === "turn/steer") send({ id: request.id, result: { turnId: "tool-turn" } });
  else if (request.id && request.result) {
    outputs.push({ callId: request.id, ...request.result });
    if (request.id === "call-first") requestTool("call-second");
    else if (request.id === "call-second") {
      send({ method: "thread/tokenUsage/updated", params: { ...params, tokenUsage: { last: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } } } });
      send({ method: "rawResponseItem/completed", params: { ...params, item: tool("call-third") } });
      requestTool("call-third");
      setTimeout(() => {
        send({ method: "rawResponseItem/completed", params: { ...params, item: tool("call-fourth") } });
        send({ method: "rawResponse/completed", params: { ...params, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });
      }, 20);
    } else if (request.id === "call-third") requestTool("call-fourth");
    else if (request.id === "call-fourth") {
      send({ method: "item/agentMessage/delta", params: { ...params, itemId: "final", delta: JSON.stringify({ requests, outputs }) } });
      send({ method: "thread/tokenUsage/updated", params: { ...params, tokenUsage: { last: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } } });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "completed" } } });
    }
  } else if (request.id) send({ id: request.id, error: { message: "Unexpected native request: " + request.method } });
});`,
  );
  chmodSync(command, 0o700);
  const client = createCodexAgentClient({ command, workingDirectory: root });
  try {
    await client.initialize();
    const thread = await client.startThread("gpt-test", []);
    const first = await client.prompt(thread.id, [{ type: "text", text: "Inspect and verify." }]);
    assert.deepEqual(
      first.toolCalls?.map((call) => call.callId),
      ["call-first", "call-second"],
    );
    assert.equal(first.usage?.totalTokens, 8);
    await assert.rejects(
      client.prompt(thread.id, [], undefined, undefined, undefined, undefined, [
        {
          type: "function_call_output",
          call_id: "call-first",
          output: "incomplete",
        },
      ]),
      /All pending caller tool results/u,
    );
    const second = await client.prompt(
      thread.id,
      [{ type: "text", text: "Keep the same scope." }],
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          type: "function_call_output",
          call_id: "call-first",
          output: "first result",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call-second",
          output: "second result",
          is_error: true,
        },
      ],
    );
    assert.equal(second.turnId, first.turnId);
    assert.deepEqual(
      second.toolCalls?.map((call) => call.callId),
      ["call-third", "call-fourth"],
    );
    assert.equal(second.usage?.totalTokens, 10);
    const completed = await client.prompt(
      thread.id,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          type: "function_call_output",
          call_id: "call-third",
          output: "verified",
        },
        {
          type: "function_call_output",
          call_id: "call-fourth",
          output: "final verification",
        },
      ],
    );
    const observed = JSON.parse(completed.text) as {
      requests: { method: string; params: Record<string, unknown> }[];
      outputs: {
        callId: string;
        contentItems: { type: string; text: string }[];
        success: boolean;
      }[];
    };
    assert.equal(completed.turnId, first.turnId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.usage?.totalTokens, 3);
    assert.equal(observed.requests.filter((request) => request.method === "turn/start").length, 1);
    assert.equal(
      observed.requests.filter((request) => request.method === "turn/interrupt").length,
      0,
    );
    assert.equal(
      observed.requests.filter((request) => request.method === "thread/inject_items").length,
      0,
    );
    assert.deepEqual(observed.requests.find((request) => request.method === "turn/steer")?.params, {
      threadId: thread.id,
      expectedTurnId: first.turnId,
      input: [{ type: "text", text: "Keep the same scope." }],
    });
    assert.deepEqual(observed.outputs, [
      {
        callId: "call-first",
        contentItems: [{ type: "inputText", text: "first result" }],
        success: true,
      },
      {
        callId: "call-second",
        contentItems: [{ type: "inputText", text: "second result" }],
        success: false,
      },
      {
        callId: "call-third",
        contentItems: [{ type: "inputText", text: "verified" }],
        success: true,
      },
      {
        callId: "call-fourth",
        contentItems: [{ type: "inputText", text: "final verification" }],
        success: true,
      },
    ]);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("replays early native items and process deltas in arrival order", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-early-events-"));
  const command = join(root, "early-agent");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") { console.log("Logged in"); process.exit(0); }
const readline = require("node:readline").createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  else if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-early" }, model: "gpt-test" } });
  else if (request.method === "turn/start") {
    const params = { threadId: "thread-early", turnId: "turn-early" };
    send({ method: "turn/started", params: { threadId: params.threadId, turn: { id: params.turnId, status: "inProgress" } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { ...params, itemId: "rs-early", summaryIndex: 0, delta: "Inspect the fixture." } });
    send({ method: "rawResponseItem/completed", params: { ...params, item: { id: "rs-early", type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the fixture." }] } } });
    send({ method: "item/started", params: { ...params, item: { id: "msg-early", type: "agentMessage", phase: "commentary", text: "" } } });
    send({ method: "item/agentMessage/delta", params: { ...params, itemId: "msg-early", delta: "Reading the fixture." } });
    send({ method: "rawResponseItem/completed", params: { ...params, item: { id: "msg-early", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Reading the fixture." }] } } });
    send({ method: "item/agentMessage/delta", params: { ...params, itemId: "msg-final", delta: "Done." } });
    send({ method: "turn/completed", params: { threadId: "thread-early", turn: { id: "turn-early", status: "completed" } } });
    send({ id: request.id, result: { turn: { id: "turn-early" } } });
  }
});`,
  );
  chmodSync(command, 0o700);
  const client = createCodexAgentClient({ command, workingDirectory: root });
  try {
    await client.initialize();
    const thread = await client.startThread();
    const received: string[] = [];
    const result = await client.prompt(
      thread.id,
      [{ type: "text", text: "fixture" }],
      undefined,
      (delta) => received.push(`text:${delta}`),
      undefined,
      (delta, source) => {
        if (!source?.separator) received.push(`process:${delta}`);
      },
      [],
      undefined,
      undefined,
      "auto",
      (item) => received.push(`native:${String(item.id)}`),
    );
    assert.equal(result.text, "Done.");
    assert.deepEqual(received, [
      "process:Inspect the fixture.",
      "native:rs-early",
      "process:Reading the fixture.",
      "native:msg-early",
      "text:Done.",
    ]);
    assert.deepEqual(
      result.progressItems?.map((item) => item.id),
      ["rs-early", "msg-early"],
    );
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP adapter reuses official login and preserves Agent output", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-adapter-"));
  try {
    const command = createFakeAgent(root);
    const processDeltas: string[] = [];
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      onProcessDelta: (delta) => processDeltas.push(delta),
    });
    assert.deepEqual(await client.initialize(), { imageInput: true });
    const session = await client.createSession();
    const deltas: string[] = [];
    const result = await client.prompt(session.id, "test", undefined, (delta) =>
      deltas.push(delta),
    );
    assert.deepEqual(result, {
      sessionId: "session-1",
      stopReason: "end_turn",
      text: "future-cursor-result",
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    });
    assert.deepEqual(deltas, ["future-", "cursor-result"]);
    assert.deepEqual(processDeltas, ["thinking"]);
    const imageResult = await client.prompt(session.id, [
      { type: "text", text: "inspect" },
      { type: "image", mimeType: "image/png", data: "dGVzdA==" },
    ]);
    assert.equal(imageResult.text, "future-cursor-image-result");
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor headless reports usage before rejecting a failed terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-failed-usage-"));
  try {
    const usageUpdates: unknown[] = [];
    await assert.rejects(
      runCursorHeadless({
        command: createFakeCursorHeadlessAgent(root, "error"),
        environment: process.env,
        workingDirectory: root,
        model: "cursor-test-model",
        prompt: "fixture",
        onUsageUpdate: (usage) => usageUpdates.push(usage),
      }),
    );
    assert.deepEqual(usageUpdates, [
      {
        inputTokens: 21,
        outputTokens: 5,
        totalTokens: 26,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 2,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor headless adapter preserves process boundaries and terminal token usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-headless-"));
  try {
    const processDeltas: string[] = [];
    const textDeltas: string[] = [];
    const result = await runCursorHeadless({
      command: createFakeCursorHeadlessAgent(root),
      environment: process.env,
      workingDirectory: root,
      model: "cursor-test-model",
      prompt: "测试请求",
      onProcessDelta: (delta) => processDeltas.push(delta),
      onTextDelta: (delta) => textDeltas.push(delta),
    });

    assert.deepEqual(processDeltas, [
      "分析",
      "请求",
      "\n\n",
      "Cursor 正在调用 readToolCall：README.md",
      "\n\n",
    ]);
    assert.deepEqual(textDeltas, ["测试请求：完成"]);
    assert.deepEqual(result, {
      text: "测试请求：完成",
      usage: {
        inputTokens: 21,
        outputTokens: 5,
        totalTokens: 26,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 2,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor headless adapter reports spawn failures without crashing the process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-headless-missing-"));
  try {
    await assert.rejects(
      runCursorHeadless({
        command: join(root, "missing-cursor-agent"),
        environment: process.env,
        workingDirectory: root,
        model: "cursor-test-model",
        prompt: "测试请求",
      }),
      /ENOENT|no such file/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP preserves a provider-owned parameterized model ID end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-parameterized-model-"));
  const requestedModel = "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]";
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel,
    });
    await client.initialize();
    const session = await client.createSession();
    assert.equal(session.model, requestedModel);
    assert.deepEqual(
      session.availableModels.find((candidate) => candidate.id === requestedModel),
      { id: requestedModel, name: "claude-opus-5" },
    );
    assert.equal((await client.prompt(session.id, "test")).text, "future-cursor-result");
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP adapter applies the configured session model", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-adapter-"));
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    const session = await client.createSession();
    assert.equal(session.model, "cursor-fast");
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP asks the host to resolve a configured model even when discovery is stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-dynamic-model-"));
  try {
    const command = createFakeAgent(root);
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "newly-published-model",
    });
    await client.initialize();
    const session = await client.createSession();
    assert.equal(session.model, "newly-published-model");
    assert.equal(
      session.availableModels.some((candidate) => candidate.id === "newly-published-model"),
      false,
    );
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP rejects a model change without an explicit host confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-unconfirmed-"));
  try {
    const command = createFakeAgent(root, "missing");
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    await assert.rejects(() => client.createSession(), /did not confirm/iu);
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor ACP rejects a host-confirmed model that differs from configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-cursor-model-mismatch-"));
  try {
    const command = createFakeAgent(root, "mismatched");
    const client = createCursorAcpClient({
      command,
      workingDirectory: root,
      requestedModel: "cursor-fast",
    });
    await client.initialize();
    await assert.rejects(
      () => client.createSession(),
      /confirmed model different-model instead of configured model cursor-fast/iu,
    );
    await client.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

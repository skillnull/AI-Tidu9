import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCodexClientProxy } from "./codex-client-proxy.js";

test("preserves exact approval decisions and leaves official direct-mode history unchanged", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-relay-gate-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const lines=require('node:readline').createInterface({input:process.stdin});
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
lines.on('line',line=>{const message=JSON.parse(line);
if(message.method==='fixture/approval')send({id:99,method:'item/commandExecution/requestApproval',params:{command:'fixture-only',gate:'unchanged'}});
else if(message.id===99)send({id:'client-request',result:message.result});
else if(message.method==='thread/read')send({id:message.id,result:{thread:{id:'official',modelProvider:'openai',path:'/not-a-session/auth.json',turns:[{id:'stopped',status:'interrupted',durationMs:0,items:[]}]}}});});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let errorText = "";
  errors.on("data", (chunk) => {
    errorText += String(chunk);
  });
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: {
      command: process.execPath,
      arguments: [fixture],
      environment: { PATH: process.env.PATH, CODEX_HOME: directory },
    },
    input,
    output,
    errorOutput: errors,
  });
  try {
    input.write(
      `${JSON.stringify({ id: "client-request", method: "fixture/approval", params: {} })}\n`,
    );
    const approval = JSON.parse((await messages.next()).value ?? "null");
    assert.deepEqual(approval, {
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture-only", gate: "unchanged" },
    });
    input.write(`${JSON.stringify({ id: 99, result: { decision: "decline" } })}\n`);
    assert.deepEqual(JSON.parse((await messages.next()).value ?? "null"), {
      id: "client-request",
      result: { decision: "decline" },
    });
    input.write(
      `${JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "official" } })}\n`,
    );
    const response = JSON.parse((await messages.next()).value ?? "null");
    assert.equal(response.result.thread.turns[0].durationMs, 0);
    assert.deepEqual(response.result.thread.turns[0].items, []);
    assert.equal(errorText, "");
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes late retrieved usage and removes the footer when a separate cancelled turn reports zero", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-relay-usage-"));
  await mkdir(join(directory, "sessions"));
  const session = join(directory, "sessions", "fixture.jsonl");
  await writeFile(session, "");
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const fs=require('node:fs');const session=${JSON.stringify(session)};const cwd=${JSON.stringify(directory)};
const turns=[];const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');const record=payload=>fs.appendFileSync(session,JSON.stringify(payload)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);const params=message.params||{};
const thread={id:'managed',modelProvider:'ai_tidu9',path:session,cwd,turns};
if(message.method==='thread/start'||message.method==='thread/read')send({id:message.id,result:{thread}});
else if(message.method==='thread/items/list')send({id:message.id,result:{data:[],nextCursor:null}});
else if(message.method==='fixture/cancel'){
 const turn={id:params.turnId,status:'interrupted',durationMs:1100,items:[]};turns.push(turn);
 record({type:'event_msg',timestamp:new Date(Date.now()-1100).toISOString(),payload:{type:'task_started',turn_id:turn.id}});
 record({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'turn_aborted',turn_id:turn.id,duration_ms:1100}});
 send({method:'turn/started',params:{threadId:'managed',turn:{id:turn.id,status:'inProgress'}}});
 send({method:'turn/completed',params:{threadId:'managed',turn}});send({id:message.id,result:{}});
}else if(message.method==='fixture/usage'){
 const usage=params.zero?{input_tokens:0,output_tokens:0,total_tokens:0}:{input_tokens:12,output_tokens:3,total_tokens:15};
 record({type:'token_usage_record',payload:{turn_id:params.turnId,turn_token_usage:usage}});
 send({method:'thread/tokenUsage/updated',params:{threadId:'managed',turnId:params.turnId,tokenUsage:{last:usage}}});send({id:message.id,result:{}});
}});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let errorText = "";
  errors.on("data", (chunk) => {
    errorText += String(chunk);
  });
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: {
      command: process.execPath,
      arguments: [fixture],
      environment: { PATH: process.env.PATH, CODEX_HOME: directory },
    },
    input,
    output,
    errorOutput: errors,
  });
  const until = async (
    matches: (message: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([
          messages.next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Native usage fixture event missing.")),
              3000,
            );
          }),
        ]);
        const message = JSON.parse(line.value ?? "null") as Record<string, unknown>;
        if (matches(message)) return message;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };
  const send = (id: number, method: string, params: unknown) =>
    input.write(`${JSON.stringify({ id, method, params })}\n`);
  try {
    send(1, "thread/start", {});
    await until((message) => message.id === 1);
    send(2, "fixture/cancel", { turnId: "known" });
    await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("Token：未获取到"),
    );
    await until((message) => message.method === "turn/completed");
    send(3, "fixture/usage", { turnId: "known" });
    await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("Token：输入 12 · 输出 3 · 合计 15"),
    );
    send(4, "fixture/cancel", { turnId: "zero" });
    await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("Token：未获取到"),
    );
    await until((message) => message.method === "turn/completed");
    send(5, "fixture/usage", { turnId: "zero", zero: true });
    const hidden = await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("tidu_usage_zero"),
    );
    assert.equal((hidden.params as { item: { text: string } }).item.text, "");
    assert.equal(errorText, "");
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

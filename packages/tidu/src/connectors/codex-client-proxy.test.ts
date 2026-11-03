import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  type CodexActiveSelection,
  createCodexClientProxy,
  readCodexActiveSelection,
} from "./codex-client-proxy.js";

test("reads only the active top-level Codex model selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-selection-"));
  try {
    await writeFile(
      join(directory, "config.toml"),
      [
        'model = "official-default"',
        "model_provider = 'openai' # current mode",
        "[model_providers.ai_tidu9]",
        'model = "must-not-leak-from-table"',
      ].join("\n"),
    );
    assert.deepEqual(readCodexActiveSelection(directory), {
      modelProvider: "openai",
      model: "official-default",
    });
    assert.deepEqual(
      readCodexActiveSelection(directory, [
        "-c",
        'model_provider="fixture"',
        '--config=model="override-model"',
      ]),
      { modelProvider: "fixture", model: "override-model" },
    );
    await writeFile(
      join(directory, ".ai-tidu9-profile-state.json"),
      JSON.stringify({
        owner: "AI-Tidu9",
        officialModel: "official-resume-model",
      }),
    );
    await writeFile(
      join(directory, "config.toml"),
      ['model = "ai-tidu9-config"', 'model_provider = "ai_tidu9"'].join("\n"),
    );
    assert.deepEqual(readCodexActiveSelection(directory), {
      modelProvider: "ai_tidu9",
      model: "ai-tidu9-config",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the current mode for each new turn in the same Codex chat", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-mode-turn-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const defaults={ai_tidu9:'managed-default',openai:'official-default'};let thread={id:'same-chat',modelProvider:'ai_tidu9',model:'managed-model'};
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);const params=message.params||{};
if(message.method==='thread/start'||message.method==='thread/resume'||message.method==='thread/fork'){const previous=thread.modelProvider;const modelProvider=params.modelProvider||previous;const model=Object.prototype.hasOwnProperty.call(params,'model')?params.model:(modelProvider===previous?thread.model:defaults[modelProvider]);thread={...thread,id:message.method==='thread/fork'?'forked-chat':thread.id,modelProvider,model};send({id:message.id,result:{thread,model:thread.model,modelProvider:thread.modelProvider}});}
else if(message.method==='thread/read')send({id:message.id,result:{thread}});
else if(message.method==='thread/unsubscribe')send({id:message.id,result:{status:'unsubscribed'}});
else if(['turn/start','review/start','thread/compact/start','thread/queue/start','thread/realtime/start'].includes(message.method))send({id:message.id,result:{turn:{id:'turn-'+Date.now()},effectiveProvider:thread.modelProvider,effectiveModel:thread.model,receivedParams:params}});
});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  let selection: CodexActiveSelection = {
    modelProvider: "ai_tidu9",
    model: "managed-model",
  };
  const proxy = createCodexClientProxy({
    launch: {
      command: process.execPath,
      arguments: [fixture],
      environment: { PATH: process.env.PATH, CODEX_HOME: directory },
    },
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => selection,
  });
  const request = async (id: number, method: string, params: unknown) => {
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const message = JSON.parse((await messages.next()).value ?? "null");
      if (message.id === id) return message;
    }
  };
  try {
    const started = await request(1, "thread/start", {});
    assert.equal(started.result.thread.id, "same-chat");
    assert.equal(started.result.thread.modelProvider, "ai_tidu9");
    selection = { modelProvider: "ai_tidu9" };
    const unchangedResume = await request(10, "thread/resume", {
      threadId: "same-chat",
    });
    assert.equal(unchangedResume.result.thread.model, "managed-model");

    selection = { modelProvider: "openai" };
    const officialResume = await request(11, "thread/resume", {
      threadId: "same-chat",
      model: "managed-model",
    });
    assert.equal(officialResume.result.thread.modelProvider, "openai");
    assert.equal(officialResume.result.thread.model, "official-default");

    selection = { modelProvider: "openai", model: "official-model" };
    const originalInput = [
      { type: "text", text: "official round" },
      { type: "image", url: "data:image/png;base64,fixture" },
    ];
    const officialTurn = await request(2, "turn/start", {
      threadId: "same-chat",
      input: originalInput,
      approvalPolicy: "on-request",
    });
    assert.equal(officialTurn.result.effectiveProvider, "openai");
    assert.equal(officialTurn.result.effectiveModel, "official-model");
    assert.deepEqual(officialTurn.result.receivedParams.input, originalInput);
    assert.equal(officialTurn.result.receivedParams.approvalPolicy, "on-request");

    selection = { modelProvider: "openai", model: "official-model-2" };
    const changedOfficialModel = await request(4, "turn/start", {
      threadId: "same-chat",
      input: [{ type: "text", text: "same provider, new model" }],
    });
    assert.equal(changedOfficialModel.result.effectiveProvider, "openai");
    assert.equal(changedOfficialModel.result.effectiveModel, "official-model-2");

    selection = { modelProvider: "ai_tidu9", model: "managed-model" };
    const managedTurn = await request(3, "turn/start", {
      threadId: "same-chat",
      model: "official-model-2",
      collaborationMode: {
        mode: "default",
        settings: { model: "official-model-2", developer_instructions: null },
      },
      input: [{ type: "text", text: "managed round" }],
    });
    assert.equal(managedTurn.result.effectiveProvider, "ai_tidu9");
    assert.equal(managedTurn.result.effectiveModel, "managed-model");
    assert.equal(managedTurn.result.receivedParams.model, "managed-model");
    assert.equal(
      managedTurn.result.receivedParams.collaborationMode.settings.model,
      "managed-model",
    );

    const executionMethods = [
      "review/start",
      "thread/compact/start",
      "thread/queue/start",
      "thread/realtime/start",
    ];
    let requestId = 20;
    for (const method of executionMethods) {
      selection = { modelProvider: "openai", model: `model-for-${method}` };
      const response = await request(requestId, method, {
        threadId: "same-chat",
      });
      assert.equal(response.result.effectiveProvider, "openai");
      assert.equal(response.result.effectiveModel, `model-for-${method}`);
      requestId += 1;
    }
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps native effort options and official account metadata available in managed mode", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-settings-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `#!/usr/bin/env node
const official=process.argv.includes('model_provider="openai"');
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.id===undefined)return;
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='account/read')send({id:message.id,result:{account:official?{type:'chatgpt',email:null,planType:'plus'}:null,requiresOpenaiAuth:official}});
else if(message.method==='account/rateLimits/read')setTimeout(()=>send({id:message.id,result:{rateLimits:official?{primary:{usedPercent:25}}:null,rateLimitResetCredits:{availableCount:0}}}),40);
else if(message.method==='account/usage/read')send({id:message.id,result:{summary:{lifetimeTokens:official?42:0}}});
else if(message.method==='fixture/limits'){send({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:null,secondary:null}}});send({id:message.id,result:{}});}
else send({id:message.id,error:{message:'Unexpected forwarded request'}});
});`,
  );
  await chmod(fixture, 0o700);
  await writeFile(
    join(directory, ".ai-tidu9-model-catalog.json"),
    JSON.stringify({
      models: [
        {
          slug: "managed-model",
          display_name: "AI-Tidu9",
          visibility: "list",
          supported_in_api: true,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "high", description: "Thorough" },
          ],
        },
      ],
    }),
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  let selection: CodexActiveSelection = { modelProvider: "ai_tidu9", model: "managed-model" };
  const proxy = createCodexClientProxy({
    launch: {
      command: fixture,
      arguments: [],
      environment: { PATH: process.env.PATH, CODEX_HOME: directory },
    },
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => selection,
  });
  const request = async (id: number, method: string) => {
    input.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    return JSON.parse((await messages.next()).value);
  };
  try {
    const catalog = await request(1, "model/list");
    assert.deepEqual(catalog.result.data[0].supportedReasoningEfforts, [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Thorough" },
    ]);
    assert.equal((await request(2, "account/read")).result.account?.type, "chatgpt");
    const limits = (await request(3, "account/rateLimits/read")).result;
    assert.equal(limits.rateLimits?.primary.usedPercent, 25);
    assert.equal(limits.rateLimitResetCredits.availableCount, 0);
    assert.equal((await request(4, "account/usage/read")).result.summary.lifetimeTokens, 42);
    assert.equal((await request(5, "fixture/limits")).id, 5);
    const managedUpdate = JSON.parse((await messages.next()).value);
    assert.equal(managedUpdate.method, "account/rateLimits/updated");
    assert.equal(managedUpdate.params.rateLimits.primary.usedPercent, 25);
    selection = { modelProvider: "openai", model: "official-model" };
    input.write(`${JSON.stringify({ id: 6, method: "fixture/limits", params: {} })}\n`);
    const officialUpdate = JSON.parse((await messages.next()).value);
    assert.equal(officialUpdate.params.rateLimits.primary, null);
    assert.equal(JSON.parse((await messages.next()).value).id, 6);
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes native model settings after a mode switch without another user message", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-model-display-"));
  const configurationPath = join(directory, "config.toml");
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(configurationPath, 'model_provider = "openai"\nmodel = "official-model"\n');
  await writeFile(
    fixture,
    `let thread={id:'display-chat',modelProvider:'openai',model:'official-model'};
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line),params=message.params||{};
if(message.method==='thread/start'||message.method==='thread/resume'){thread={...thread,modelProvider:params.modelProvider,model:params.model};send({id:message.id,result:{thread,model:thread.model,modelProvider:thread.modelProvider}});}
else if(message.method==='thread/settings/update')send({id:message.id,result:null});
else if(message.method==='thread/unsubscribe')send({id:message.id,result:{status:'unsubscribed'}});
});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
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
    input.write(`${JSON.stringify({ id: 1, method: "thread/start", params: {} })}\n`);
    assert.equal(JSON.parse((await messages.next()).value).result.thread.model, "official-model");
    for (const selection of [
      { modelProvider: "ai_tidu9", model: "ai-tidu9-config" },
      { modelProvider: "openai", model: "official-model" },
    ]) {
      await writeFile(
        configurationPath,
        `model_provider = "${selection.modelProvider}"\nmodel = "${selection.model}"\n`,
      );
      const notification = JSON.parse((await messages.next()).value);
      assert.equal(notification.method, "thread/settings/updated");
      assert.deepEqual(notification.params.threadSettings, selection);
    }
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("recovers an earlier managed turn after the same chat switches back to official mode", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-mixed-reopen-"));
  await mkdir(join(directory, "sessions"));
  const session = join(directory, "sessions", "mixed.jsonl");
  const records = [
    {
      type: "event_msg",
      timestamp: new Date(Date.now() - 1500).toISOString(),
      payload: { type: "task_started", turn_id: "managed-turn" },
    },
    {
      type: "token_usage_record",
      payload: {
        turn_id: "managed-turn",
        turn_token_usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
        },
      },
    },
    {
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: {
        type: "turn_aborted",
        turn_id: "managed-turn",
        duration_ms: 1500,
      },
    },
    {
      type: "event_msg",
      timestamp: new Date(Date.now() - 700).toISOString(),
      payload: { type: "task_started", turn_id: "official-turn" },
    },
    {
      type: "token_usage_record",
      payload: {
        turn_id: "official-turn",
        turn_token_usage: {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 25,
        },
      },
    },
    {
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: {
        type: "turn_aborted",
        turn_id: "official-turn",
        duration_ms: 700,
      },
    },
  ];
  await writeFile(session, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await writeFile(
    join(directory, ".ai-tidu9-turn-providers.jsonl"),
    `${[
      {
        threadId: "mixed-chat",
        turnId: "managed-turn",
        modelProvider: "ai_tidu9",
        model: "official-compatible-model",
      },
      {
        threadId: "mixed-chat",
        turnId: "official-turn",
        modelProvider: "openai",
        model: "official-compatible-model",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
const turns=[{id:'managed-turn',status:'interrupted',durationMs:0,items:[]},{id:'official-turn',status:'interrupted',durationMs:0,items:[]}];
if(message.method==='thread/read')send({id:message.id,result:{thread:{id:'mixed-chat',modelProvider:'openai',model:'official-compatible-model',path:${JSON.stringify(session)},cwd:${JSON.stringify(directory)},turns}}});
else if(message.method==='thread/turns/list')send({id:message.id,result:{data:turns,nextCursor:null}});
else if(message.method==='thread/items/list')send({id:message.id,result:{data:[],nextCursor:null}});});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
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
      `${JSON.stringify({ id: 1, method: "thread/read", params: { threadId: "mixed-chat", includeTurns: true } })}\n`,
    );
    const response = JSON.parse((await messages.next()).value ?? "null") as {
      result: {
        thread: { turns: { id: string; items: { text?: string }[] }[] };
      };
    };
    const managed = response.result.thread.turns.find((turn) => turn.id === "managed-turn");
    const official = response.result.thread.turns.find((turn) => turn.id === "official-turn");
    assert.match(JSON.stringify(managed), /总：入 12 · 出 3 · 合 15/u);
    assert.doesNotMatch(JSON.stringify(official), /总：/u);

    input.write(
      `${JSON.stringify({ id: 2, method: "thread/turns/list", params: { threadId: "mixed-chat" } })}\n`,
    );
    const turnPage = JSON.parse((await messages.next()).value ?? "null") as {
      result: { data: { id: string; items: { text?: string }[] }[] };
    };
    assert.match(
      JSON.stringify(turnPage.result.data.find((turn) => turn.id === "managed-turn")),
      /总：入 12 · 出 3 · 合 15/u,
    );
    assert.doesNotMatch(
      JSON.stringify(turnPage.result.data.find((turn) => turn.id === "official-turn")),
      /总：/u,
    );

    input.write(
      `${JSON.stringify({ id: 3, method: "thread/items/list", params: { threadId: "mixed-chat", turnId: "managed-turn", sortDirection: "asc" } })}\n`,
    );
    const managedItems = JSON.parse((await messages.next()).value ?? "null");
    assert.match(JSON.stringify(managedItems), /总：入 12 · 出 3 · 合 15/u);
    input.write(
      `${JSON.stringify({ id: 4, method: "thread/items/list", params: { threadId: "mixed-chat", turnId: "official-turn", sortDirection: "asc" } })}\n`,
    );
    const officialItems = JSON.parse((await messages.next()).value ?? "null");
    assert.doesNotMatch(JSON.stringify(officialItems), /总：/u);
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
        JSON.stringify(message.params).includes("总：未获取到"),
    );
    await until((message) => message.method === "turn/completed");
    send(3, "fixture/usage", { turnId: "known" });
    await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("总：入 12 · 出 3 · 合 15"),
    );
    send(4, "fixture/cancel", { turnId: "zero" });
    await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("总：未获取到"),
    );
    await until((message) => message.method === "turn/completed");
    send(5, "fixture/usage", { turnId: "zero", zero: true });
    const hidden = await until(
      (message) =>
        message.method === "item/completed" &&
        JSON.stringify(message.params).includes("tidu_usage_zero"),
    );
    assert.equal((hidden.params as { item: { text: string } }).item.text, "");
    const ownership = (await readFile(join(directory, ".ai-tidu9-turn-providers.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      ownership.map((entry) => Object.keys(entry).sort()),
      [
        ["modelProvider", "threadId", "turnId"],
        ["modelProvider", "threadId", "turnId"],
      ],
    );
    assert.doesNotMatch(JSON.stringify(ownership), /Token|fixture\/cancel|private/u);
    assert.equal(errorText, "");
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds proxy-only metadata reads and preserves official request flow", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-metadata-timeout-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
let thread={id:'official-chat',modelProvider:'ai_tidu9',model:'managed-model'};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='thread/read'){return;}
if(message.method==='thread/resume'){thread={...thread,modelProvider:message.params.modelProvider,model:message.params.model};send({id:message.id,result:{thread}});}
else if(message.method==='turn/start')send({id:message.id,result:{continued:true,effectiveProvider:thread.modelProvider,effectiveModel:thread.model,receivedParams:message.params}});
});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let errorText = "";
  let outputText = "";
  errors.on("data", (chunk) => {
    errorText += String(chunk);
  });
  output.on("data", (chunk) => {
    outputText += String(chunk);
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
    internalRequestTimeoutMs: 200,
    resolveActiveSelection: () => ({
      modelProvider: "openai",
      model: "official-model",
    }),
  });
  const request = async (id: number, method: string, params: unknown) => {
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    while (true) {
      const message = JSON.parse((await messages.next()).value ?? "null");
      if (message.id === id) return message;
    }
  };
  try {
    const turn = await request(1, "turn/start", {
      threadId: "official-chat",
      input: [{ type: "text", text: "continue officially" }],
    });
    assert.equal(turn.result.continued, true);
    assert.equal(turn.result.effectiveProvider, "openai");
    assert.equal(turn.result.effectiveModel, "official-model");
    const resumed = await request(2, "thread/resume", {
      threadId: "official-chat",
    });
    assert.equal(resumed.result.thread.modelProvider, "openai");
    assert.equal(resumed.result.thread.model, "official-model");
    assert.doesNotMatch(errorText, /forwarding the official request unchanged/u);
    assert.doesNotMatch(errorText, /invalid client JSON-RPC/u);
    assert.doesNotMatch(outputText, /tidu_recovery_/u);
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("forwards approval decisions without waiting for mode synchronization", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-approval-priority-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
let thread={id:'same-chat',modelProvider:'ai_tidu9',model:'managed-model'};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='thread/resume'){setTimeout(()=>{thread={...thread,modelProvider:message.params.modelProvider,model:message.params.model};send({id:message.id,result:{thread}});},150);return;}
if(message.method==='turn/start'){send({id:message.id,result:{effectiveProvider:thread.modelProvider}});return;}
if(message.method===undefined&&message.id===99)send({method:'fixture/approvalReceived',params:{receivedAt:Date.now()}});
});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
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
    resolveActiveSelection: () => ({
      modelProvider: "openai",
      model: "official-model",
    }),
  });
  const startedAt = Date.now();
  input.write(
    `${JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "same-chat" } })}\n`,
  );
  input.write(`${JSON.stringify({ id: 99, result: { decision: "accept" } })}\n`);

  try {
    let approvalDelay: number | undefined;
    let turnDelay: number | undefined;
    while (approvalDelay === undefined || turnDelay === undefined) {
      const message = JSON.parse((await messages.next()).value ?? "null");
      if (message.method === "fixture/approvalReceived") {
        approvalDelay = Number(message.params.receivedAt) - startedAt;
      }
      if (message.id === 1) turnDelay = Date.now() - startedAt;
    }
    assert.ok(approvalDelay < turnDelay);
    assert.ok(turnDelay >= 100);
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

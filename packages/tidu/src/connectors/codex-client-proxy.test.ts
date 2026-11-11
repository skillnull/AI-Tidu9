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
import { createCodexThreadLinks } from "./codex-thread-links.js";

const createFixtureLaunch = async (fixture: string, directory: string) => {
  const source = await readFile(fixture, "utf8");
  await writeFile(fixture, `#!${process.execPath}\n${source}`);
  await chmod(fixture, 0o700);
  return {
    command: fixture,
    arguments: [],
    environment: { PATH: process.env.PATH, CODEX_HOME: directory },
  };
};

for (const modelProvider of ["openai", "ai_tidu9"]) {
  test(`preserves native tool, child-agent, and future event fields through ${modelProvider}`, {
    timeout: 10000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-event-transparency-"));
    const fixture = join(directory, "native-events.cjs");
    await writeFile(
      fixture,
      `const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);
if(request.method==='initialize')send({id:request.id,result:{futureInitialization:{supported:['next-version']}}});
else if(request.method==='fixture/emit'){for(const event of request.params.events)send(event);send({id:request.id,result:{provider:process.argv.find(value=>value.startsWith('model_provider=')),request,futureResult:{nested:[{enabled:null,count:0}]}}});}});`,
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const messages = createInterface({ input: output })[Symbol.asyncIterator]();
    const proxy = createCodexClientProxy({
      launch: await createFixtureLaunch(fixture, directory),
      input,
      output,
      errorOutput: errors,
      resolveActiveSelection: () => ({ modelProvider, model: "selected-model" }),
    });
    const identity = { threadId: "parent-thread", turnId: "parent-turn" };
    const extension = {
      schemaVersion: 19,
      nested: [{ flag: false, count: 0, nullable: null, text: "原生状态\n✓" }],
    };
    const notification = (method: string, params: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      method,
      params,
      futureEnvelope: extension,
    });
    const collab = (tool: string, status: string, agentStatus: string) => ({
      id: `collab-${tool}`,
      type: "collabAgentToolCall",
      tool,
      status,
      senderThreadId: "parent-thread",
      receiverThreadIds: ["child-thread"],
      prompt: "Inspect the fixture.",
      model: "child-model",
      reasoningEffort: "future-effort",
      agentsStates: {
        "child-thread": {
          status: agentStatus,
          message: agentStatus === "completed" ? "Verified." : null,
          futureAgentState: extension,
        },
      },
      futureItemFields: extension,
    });
    const events = [
      notification("item/started", {
        ...identity,
        item: {
          id: "command",
          type: "commandExecution",
          command: "inspect fixture",
          status: "inProgress",
          aggregatedOutput: "",
          futureCommand: extension,
        },
      }),
      notification("item/commandExecution/outputDelta", {
        ...identity,
        itemId: "command",
        delta: "first line\n\u001b[32mverified ✓\u001b[0m\n",
        futureChunk: extension,
      }),
      notification("item/commandExecution/outputDelta", {
        ...identity,
        itemId: "command",
        delta: "second independent chunk\n",
        futureChunk: extension,
      }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "command",
          type: "commandExecution",
          command: "inspect fixture",
          status: "completed",
          aggregatedOutput: "first line\nverified ✓\n",
          exitCode: 0,
          futureCommand: extension,
        },
      }),
      notification("item/started", {
        ...identity,
        item: {
          id: "second-command",
          type: "commandExecution",
          command: "verify fixture",
          status: "inProgress",
          aggregatedOutput: "",
          futureCommand: extension,
        },
      }),
      notification("item/commandExecution/outputDelta", {
        ...identity,
        itemId: "second-command",
        delta: "independent command output\n",
        futureChunk: extension,
      }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "second-command",
          type: "commandExecution",
          command: "verify fixture",
          status: "completed",
          aggregatedOutput: "independent command output\n",
          exitCode: 0,
          futureCommand: extension,
        },
      }),
      notification("item/started", {
        ...identity,
        item: {
          id: "reasoning",
          type: "reasoning",
          summary: ["First group.", "Second group."],
          futureReasoning: extension,
        },
      }),
      notification("item/reasoning/summaryTextDelta", {
        ...identity,
        itemId: "reasoning",
        summaryIndex: 0,
        delta: "First ",
        futureSummary: extension,
      }),
      notification("item/reasoning/summaryTextDelta", {
        ...identity,
        itemId: "reasoning",
        summaryIndex: 0,
        delta: "group.",
        futureSummary: extension,
      }),
      notification("item/reasoning/summaryTextDelta", {
        ...identity,
        itemId: "reasoning",
        summaryIndex: 1,
        delta: "Second group.",
        futureSummary: extension,
      }),
      notification("item/started", {
        ...identity,
        item: {
          id: "commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "",
          futureMessage: extension,
        },
      }),
      notification("item/agentMessage/delta", {
        ...identity,
        itemId: "commentary",
        delta: "First process paragraph.\n\n",
        futureDelta: extension,
      }),
      notification("item/agentMessage/delta", {
        ...identity,
        itemId: "commentary",
        delta: "Second process paragraph.",
        futureDelta: extension,
      }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "First process paragraph.\n\nSecond process paragraph.",
          futureMessage: extension,
        },
      }),
      notification("item/started", {
        ...identity,
        item: collab("spawnAgent", "inProgress", "pendingInit"),
      }),
      notification("item/completed", {
        ...identity,
        item: collab("spawnAgent", "completed", "running"),
      }),
      notification("item/started", {
        ...identity,
        item: {
          id: "child-start",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child-thread",
          agentPath: "/root/child",
          model: "child-model",
          reasoningEffort: "future-effort",
          futureActivity: extension,
        },
      }),
      notification("thread/status/changed", {
        threadId: "child-thread",
        status: { type: "active", activeFlags: ["future-status"] },
        futureStatus: extension,
      }),
      notification("item/started", { ...identity, item: collab("wait", "inProgress", "running") }),
      notification("item/completed", {
        ...identity,
        item: collab("wait", "completed", "completed"),
      }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "child-complete",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: "child-thread",
          agentPath: "/root/child",
          model: "child-model",
          reasoningEffort: "future-effort",
          futureActivity: extension,
        },
      }),
      notification("future/progress/changed", { ...identity, futurePayload: extension }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "future-item",
          type: "futureNativeItem",
          payload: extension,
          relationship: { parentThreadId: "parent-thread", childThreadId: "child-thread" },
        },
      }),
      notification("item/completed", {
        ...identity,
        item: {
          id: "final",
          type: "agentMessage",
          phase: "final_answer",
          text: "Verified.",
          futureMessage: extension,
        },
      }),
    ];
    try {
      input.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fixture" }, futureClient: extension } })}\n`,
      );
      assert.deepEqual(JSON.parse((await messages.next()).value ?? "null").result, {
        futureInitialization: { supported: ["next-version"] },
      });
      input.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const request = {
        id: 2,
        method: "fixture/emit",
        params: { threadId: "parent-thread", events, futureRequest: extension },
        futureRequestEnvelope: extension,
      };
      input.write(`${JSON.stringify(request)}\n`);
      const received = [];
      for (let index = 0; index < events.length; index += 1)
        received.push(JSON.parse((await messages.next()).value ?? "null"));
      assert.deepEqual(received, events);
      const response = JSON.parse((await messages.next()).value ?? "null");
      assert.equal(response.result.provider, `model_provider=${JSON.stringify(modelProvider)}`);
      assert.deepEqual(response.result.request, request);
      assert.deepEqual(response.result.futureResult, { nested: [{ enabled: null, count: 0 }] });
    } finally {
      await proxy.close();
      input.destroy();
      output.destroy();
      errors.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("preserves official model and effort extensions when a managed launch returns to official mode", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-model-extensions-"));
  const fixture = join(directory, "native-models.cjs");
  await writeFile(
    fixture,
    `const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id!==undefined)send({id:request.id,result:{}});});`,
  );
  const model = {
    slug: "official-model",
    display_name: "Official model",
    visibility: "list",
    supported_in_api: true,
    supports_personality: true,
    input_modalities: ["text", "image", "future-modality"],
    supported_reasoning_levels: [
      {
        effort: "future-effort",
        description: "Official effort.",
        futureEffort: { settings: [false, null] },
      },
    ],
    futureOfficialCapability: { schemaVersion: 2, modes: ["future-mode"] },
  };
  await writeFile(join(directory, "models_cache.json"), JSON.stringify({ models: [model] }));
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  let selection: CodexActiveSelection = { modelProvider: "ai_tidu9", model: "managed-model" };
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => selection,
  });
  try {
    input.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    await messages.next();
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
    selection = { modelProvider: "openai", model: "official-model" };
    input.write(`${JSON.stringify({ id: 2, method: "model/list", params: {} })}\n`);
    const response = JSON.parse((await messages.next()).value ?? "null");
    const item = response.result.data[0];
    assert.deepEqual(item.futureOfficialCapability, model.futureOfficialCapability);
    assert.deepEqual(
      item.supportedReasoningEfforts[0].futureEffort,
      model.supported_reasoning_levels[0]?.futureEffort,
    );
    assert.equal(item.supportsPersonality, true);
    assert.deepEqual(item.inputModalities, model.input_modalities);
    model.futureOfficialCapability.schemaVersion = 3;
    await writeFile(join(directory, "models_cache.json"), JSON.stringify({ models: [model] }));
    input.write(`${JSON.stringify({ id: 3, method: "model/list", params: {} })}\n`);
    assert.equal(
      JSON.parse((await messages.next()).value ?? "null").result.data[0].futureOfficialCapability
        .schemaVersion,
      3,
    );
    await writeFile(
      join(directory, "models_cache.json"),
      JSON.stringify({ models: [{ ...model, supports_personality: undefined }] }),
    );
    input.write(`${JSON.stringify({ id: 4, method: "model/list", params: {} })}\n`);
    assert.equal(
      "supportsPersonality" in JSON.parse((await messages.next()).value ?? "null").result.data[0],
      false,
      "An unknown official capability must not be replaced by a fabricated boolean.",
    );
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("rotates compatible managed harness workers at new turns while retaining native owners", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-harness-workers-"));
  const fixture = join(directory, "native-worker.cjs");
  const catalogPath = join(directory, ".ai-tidu9-model-catalog.json");
  const sourcePath = join(directory, "models_cache.json");
  const source = (template: string, clientVersion = "0.167.0") => ({
    client_version: clientVersion,
    models: [
      {
        slug: "official-source",
        display_name: "Official source",
        visibility: "list",
        supported_in_api: true,
        model_messages: {
          instructions_template: template,
          instructions_variables: { future_protocol: "retained" },
        },
        multi_agent_version: "v2",
      },
    ],
  });
  await writeFile(sourcePath, JSON.stringify(source("First harness.")));
  await writeFile(
    catalogPath,
    JSON.stringify({
      models: [
        {
          slug: "ai-tidu9-config",
          display_name: "AI-Tidu9",
          visibility: "list",
          supported_in_api: true,
          supports_parallel_tool_calls: false,
        },
      ],
    }),
  );
  await writeFile(
    join(directory, ".ai-tidu9-profile-state.json"),
    JSON.stringify({
      owner: "AI-Tidu9",
      profile: "ai-tidu9",
      model: "ai-tidu9-config",
      officialModel: "official-source",
    }),
  );
  await writeFile(
    fixture,
    `const {readFileSync}=require('node:fs');const {join}=require('node:path');
const provider=process.argv.includes('model_provider="openai"')?'openai':'ai_tidu9';
const catalog=JSON.parse(readFileSync(join(process.env.CODEX_HOME,'.ai-tidu9-model-catalog.json'),'utf8'));const harness=catalog.models[0].model_messages?.instructions_template;
let count=0;const turns=new Map();const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line),params=request.params||{};
const info={pid:process.pid,provider,harness};
if(request.method==='initialize')send({id:request.id,result:info});
else if(request.method==='thread/start'||request.method==='thread/fork'||request.method==='thread/resume'){const threadId=request.method==='thread/resume'?params.threadId:provider+'-'+process.pid+'-'+(++count);send({id:request.id,result:{...info,thread:{id:threadId,modelProvider:provider,model:params.model},modelProvider:provider,model:params.model}});}
else if(request.method==='turn/start'){const turnId='turn-'+process.pid+'-'+(++count);turns.set(params.threadId,turnId);send({method:'turn/started',params:{threadId:params.threadId,turn:{id:turnId,status:'inProgress'}}});send({id:request.id,result:{...info,turn:{id:turnId},receivedThreadId:params.threadId}});}
else if(request.method==='fixture/approval'){send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:params.threadId,...info}});send({id:request.id,result:info});}
else if(request.method===undefined&&request.id===99)send({method:'fixture/decision',params:{...info,decision:request.result}});
else if(request.method==='fixture/finish'){send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:turns.get(params.threadId),status:'completed'}}});send({id:request.id,result:info});}
else if(request.id!==undefined)send({id:request.id,result:info});});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const observed: Record<string, unknown>[] = [];
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    hostVersion: "0.167.0-alpha.3.2",
    resolveActiveSelection: () => ({ modelProvider: "ai_tidu9", model: "ai-tidu9-config" }),
  });
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    for (;;) {
      const message = JSON.parse((await messages.next()).value ?? "null");
      if (message.id === id) {
        assert.equal(message.error, undefined);
        return message.result;
      }
      observed.push(message);
    }
  };
  try {
    const primary = await request(1, "initialize");
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const first = await request(2, "thread/start");
    assert.equal(first.harness, "First harness.");
    const firstTurn = await request(3, "turn/start", {
      threadId: first.thread.id,
      input: [{ type: "text", text: "Keep running." }],
    });
    await request(4, "fixture/approval", { threadId: first.thread.id });
    const approval = observed.find(
      (message) => message.method === "item/commandExecution/requestApproval",
    );
    assert.ok(approval);
    await writeFile(sourcePath, JSON.stringify(source("Second harness.")));
    const second = await request(5, "thread/start");
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.harness, "Second harness.");
    assert.equal((await request(6, "fixture/pid", { threadId: first.thread.id })).pid, first.pid);
    input.write(`${JSON.stringify({ id: approval.id, result: { decision: "decline" } })}\n`);
    const decision = JSON.parse((await messages.next()).value ?? "null");
    assert.equal(decision.method, "fixture/decision");
    assert.equal(decision.params.pid, first.pid);
    assert.equal((await request(7, "account/read")).pid, primary.pid);
    assert.equal(
      (await request(8, "turn/interrupt", { threadId: first.thread.id, turnId: firstTurn.turn.id }))
        .pid,
      first.pid,
    );
    await writeFile(sourcePath, JSON.stringify(source("Incompatible harness.", "9.9.9")));
    const third = await request(9, "thread/start");
    assert.equal(third.pid, second.pid);
    assert.equal(third.harness, "Second harness.");
    await request(10, "fixture/finish", { threadId: first.thread.id });
    const resumed = await request(11, "turn/start", {
      threadId: first.thread.id,
      input: [{ type: "text", text: "Use the compatible worker." }],
    });
    assert.equal(resumed.pid, second.pid);
    assert.equal(resumed.harness, "Second harness.");
    assert.equal((await request(12, "account/read")).pid, primary.pid);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].slug, "ai-tidu9-config");
    assert.equal(catalog.models[0].supports_parallel_tool_calls, false);
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
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
    launch: await createFixtureLaunch(fixture, directory),
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
    `const official=process.argv.includes('model_provider="openai"');
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
    launch: await createFixtureLaunch(fixture, directory),
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
    assert.deepEqual((await request(0, "initialize")).result, {});
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
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

test("keeps account reads independent of mode synchronization and slow usage queries", {
  timeout: 10000,
}, async (context) => {
  for (const blockedMethod of ["thread/resume", "account/usage/read"]) {
    await context.test(blockedMethod, async () => {
      const directory = await mkdtemp(join(tmpdir(), "tidu-native-account-concurrency-"));
      const fixture = join(directory, "official-fixture.cjs");
      await writeFile(
        fixture,
        `const official=process.argv.includes('model_provider="openai"');
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);if(message.id===undefined)return;
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='account/read')send({id:message.id,result:{account:official?{type:'chatgpt'}:null,requiresOpenaiAuth:official}});
else if(message.method===${JSON.stringify(blockedMethod)})setTimeout(()=>send({id:message.id,result:{thread:{id:'same-chat',modelProvider:'ai_tidu9'},summary:{}}}),1000);
else send({id:message.id,result:{}});
});`,
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const errors = new PassThrough();
      const messages = createInterface({ input: output })[Symbol.asyncIterator]();
      const proxy = createCodexClientProxy({
        launch: await createFixtureLaunch(fixture, directory),
        input,
        output,
        errorOutput: errors,
        resolveActiveSelection: () => ({ modelProvider: "ai_tidu9" }),
      });
      const send = (id: number, method: string, params = {}) =>
        input.write(`${JSON.stringify({ id, method, params })}\n`);
      try {
        send(0, "initialize");
        assert.equal(JSON.parse((await messages.next()).value).id, 0);
        input.write(`${JSON.stringify({ method: "initialized" })}\n`);
        // Establish identity on the same native process before measuring queueing.
        send(1, "account/read");
        assert.equal(JSON.parse((await messages.next()).value).result.account.type, "chatgpt");
        send(2, blockedMethod === "thread/resume" ? "turn/start" : blockedMethod, {
          threadId: "same-chat",
        });
        send(3, "account/read");
        const first = JSON.parse((await messages.next()).value);
        assert.equal(first.id, 3, "account lookup must not wait behind unrelated requests");
        assert.equal(first.result.account.type, "chatgpt");
        if (blockedMethod === "account/usage/read") {
          send(4, "fixture/ping");
          assert.equal(JSON.parse((await messages.next()).value).id, 4);
        }
        assert.equal(JSON.parse((await messages.next()).value).id, 2);
      } finally {
        await proxy.close();
        input.destroy();
        output.destroy();
        errors.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("preserves the native usage error and concurrent account identity", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-account-failure-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const official=process.argv.includes('model_provider="openai"');
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);if(message.id===undefined)return;
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='account/usage/read'&&official)send({id:message.id,error:{code:-32603,message:'Usage unavailable'}});
else if(message.method==='account/read')setTimeout(()=>send({id:message.id,result:{account:official?{type:'chatgpt'}:null}}),100);
else send({id:message.id,result:{summary:{}}});
});`,
  );
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => ({ modelProvider: "ai_tidu9" }),
  });
  try {
    input.write(`${JSON.stringify({ id: 0, method: "initialize", params: {} })}\n`);
    assert.equal(JSON.parse((await messages.next()).value).id, 0);
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
    input.write(`${JSON.stringify({ id: 1, method: "account/usage/read", params: {} })}\n`);
    input.write(`${JSON.stringify({ id: 2, method: "account/read", params: {} })}\n`);
    const responses = [
      JSON.parse((await messages.next()).value),
      JSON.parse((await messages.next()).value),
    ];
    assert.deepEqual(responses.find((response) => response.id === 1)?.error, {
      code: -32603,
      message: "Usage unavailable",
    });
    assert.equal(responses.find((response) => response.id === 2)?.result.account?.type, "chatgpt");
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
    launch: await createFixtureLaunch(fixture, directory),
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

for (const approvalOrder of [
  ["openai", "ai_tidu9"],
  ["ai_tidu9", "openai"],
])
  for (const replyOrder of ["forward", "reverse"])
    test(`routes concurrent native approvals and loaded threads to their owning processes (${approvalOrder.join(" then ")}; ${replyOrder} replies)`, {
      timeout: 10000,
    }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "tidu-native-owner-routing-"));
      const fixture = join(directory, "official-fixture.cjs");
      await writeFile(
        fixture,
        `const provider=process.argv.includes('model_provider="openai"')?'openai':'ai_tidu9',threadId=provider+'-chat';let loaded=false;
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='initialized'&&provider==='ai_tidu9')send({method:'account/updated',params:{account:null}});
else if(message.method==='thread/start'){loaded=true;send({id:message.id,result:{thread:{id:threadId,modelProvider:provider},modelProvider:provider}});}
else if(message.method==='thread/loaded/list')send({id:message.id,result:{data:loaded?[threadId]:[]}});
else if(message.method==='fixture/approval')send({method:'fixture/approvalReady',params:{threadId,provider}});
else if(message.method==='fixture/releaseApproval')send({id:99,method:'item/commandExecution/requestApproval',params:{threadId,provider}});
else if(message.method===undefined&&message.id===99)send({method:'fixture/decision',params:{provider,decision:message.result}});
else if(message.method==='turn/interrupt')send({id:message.id,result:{provider}});
});`,
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const errors = new PassThrough();
      const messages = createInterface({ input: output })[Symbol.asyncIterator]();
      let selection: CodexActiveSelection = { modelProvider: "openai" };
      const proxy = createCodexClientProxy({
        launch: await createFixtureLaunch(fixture, directory),
        input,
        output,
        errorOutput: errors,
        resolveActiveSelection: () => selection,
      });
      const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
      const receive = async () => JSON.parse((await messages.next()).value);
      try {
        send({ id: 1, method: "initialize", params: {} });
        assert.equal((await receive()).id, 1);
        send({ id: 2, method: "thread/start", params: {} });
        assert.equal((await receive()).result.thread.id, "openai-chat");
        selection = { modelProvider: "ai_tidu9" };
        send({ id: 3, method: "thread/start", params: {} });
        assert.equal((await receive()).result.thread.id, "ai_tidu9-chat");
        send({ id: 4, method: "thread/loaded/list", params: {} });
        assert.deepEqual(
          new Set((await receive()).result.data),
          new Set(["openai-chat", "ai_tidu9-chat"]),
        );
        for (const threadId of ["openai-chat", "ai_tidu9-chat"])
          send({ method: "fixture/approval", params: { threadId } });
        const ready = [await receive(), await receive()];
        assert.ok(ready.every((message) => message.method === "fixture/approvalReady"));
        assert.deepEqual(
          new Set(ready.map((message) => message.params.provider)),
          new Set(["openai", "ai_tidu9"]),
        );
        const approvals = [];
        for (const provider of approvalOrder) {
          send({ method: "fixture/releaseApproval", params: { threadId: `${provider}-chat` } });
          const approval = await receive();
          assert.equal(approval.method, "item/commandExecution/requestApproval");
          assert.equal(approval.params.provider, provider);
          approvals.push(approval);
        }
        assert.notEqual(approvals[0].id, approvals[1].id);
        for (const approval of replyOrder === "reverse" ? approvals.reverse() : approvals)
          send({
            id: approval.id,
            result: {
              decision: approval.params.provider === "openai" ? "decline" : "acceptForSession",
            },
          });
        const receivedDecisions = [await receive(), await receive()];
        assert.ok(receivedDecisions.every((message) => message.method === "fixture/decision"));
        const decisions = receivedDecisions.map((message) => message.params);
        assert.deepEqual(
          new Set(decisions.map((entry) => entry.provider)),
          new Set(["openai", "ai_tidu9"]),
        );
        assert.deepEqual(decisions.find((entry) => entry.provider === "openai")?.decision, {
          decision: "decline",
        });
        assert.deepEqual(decisions.find((entry) => entry.provider === "ai_tidu9")?.decision, {
          decision: "acceptForSession",
        });
        selection = { modelProvider: "openai" };
        send({
          id: 5,
          method: "turn/interrupt",
          params: { threadId: "ai_tidu9-chat", turnId: "running-turn" },
        });
        assert.equal((await receive()).result.provider, "ai_tidu9");
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
    launch: await createFixtureLaunch(fixture, directory),
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
    launch: await createFixtureLaunch(fixture, directory),
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
    launch: await createFixtureLaunch(fixture, directory),
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
setTimeout(()=>{
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='thread/read'){return;}
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='thread/resume'){thread={...thread,modelProvider:message.params.modelProvider,model:message.params.model};send({id:message.id,result:{thread}});}
else if(message.method==='thread/turns/list')send({id:message.id,result:{data:[],nextCursor:null}});
else if(message.method==='turn/start')send({id:message.id,result:{continued:true,effectiveProvider:thread.modelProvider,effectiveModel:thread.model,receivedParams:message.params}});
});
},350);`,
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
    launch: await createFixtureLaunch(fixture, directory),
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
    // Initialize before starting bounded metadata calls, as the native client does.
    const initialized = await request(0, "initialize", {
      clientInfo: { name: "metadata_timeout_test", version: "1" },
    });
    assert.equal(initialized.error, undefined);
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
    // An unknown chat forces a thread/read that the fixture deliberately never answers.
    const page = await request(3, "thread/turns/list", { threadId: "unseen-chat" });
    assert.deepEqual(page.result, { data: [], nextCursor: null });
    assert.match(errorText, /could not derive paginated display/u);
    const turn = await request(1, "turn/start", {
      threadId: "official-chat",
      input: [{ type: "text", text: "continue officially" }],
    });
    assert.equal(turn.error, undefined);
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
    launch: await createFixtureLaunch(fixture, directory),
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

test("forwards interruption without waiting for another chat to resume", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidu-native-interrupt-priority-"));
  const fixture = join(directory, "official-fixture.cjs");
  await writeFile(
    fixture,
    `const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const message=JSON.parse(line);
if(message.method==='thread/resume'){send({method:'fixture/resuming',params:{}});setTimeout(()=>send({id:message.id,result:{thread:{id:'idle',modelProvider:'openai'}}}),300);}
else if(message.method==='turn/interrupt')send({id:message.id,result:{interrupted:true}});
else if(message.id!==undefined)send({id:message.id,result:{}});
});`,
  );
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => ({ modelProvider: "openai" }),
  });
  try {
    input.write(
      `${JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "idle" } })}\n`,
    );
    assert.equal(JSON.parse((await messages.next()).value).method, "fixture/resuming");
    input.write(
      `${JSON.stringify({ id: 2, method: "turn/interrupt", params: { threadId: "busy", turnId: "active" } })}\n`,
    );
    const interruption = JSON.parse((await messages.next()).value);
    assert.equal(interruption.id, 2);
    assert.equal(interruption.result.interrupted, true);
    assert.equal(JSON.parse((await messages.next()).value).id, 1);
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const shutdown of ["explicit", "pipe-error", "input-closed"])
  test(`closes a child that ignores termination after ${shutdown}`, {
    timeout: 5000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-relay-shutdown-"));
    const fixture = join(directory, "fixture.cjs");
    await writeFile(
      fixture,
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');});`,
    );
    const input = new PassThrough(),
      output = new PassThrough(),
      errors = new PassThrough();
    const messages = createInterface({ input: output })[Symbol.asyncIterator]();
    const proxy = createCodexClientProxy({
      launch: await createFixtureLaunch(fixture, directory),
      input,
      output,
      errorOutput: errors,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      input.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
      assert.equal(JSON.parse((await messages.next()).value).id, 1);
      if (shutdown === "pipe-error") proxy.process.stdin.emit("error", new Error("fixture EPIPE"));
      if (shutdown === "input-closed") input.end();
      const outcome = await Promise.race([
        proxy.close().then(() => "closed"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("hung"), 2000);
        }),
      ]);
      assert.equal(outcome, "closed");
      assert.ok(proxy.process.exitCode !== null || proxy.process.signalCode !== null);
    } finally {
      clearTimeout(timer);
      proxy.process.kill("SIGKILL");
      await proxy.close();
      input.destroy();
      output.destroy();
      errors.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("keeps initialization and account reads usable when continuation metadata is corrupt", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-relay-corrupt-index-"));
  const fixture = join(directory, "fixture.cjs");
  await writeFile(
    fixture,
    `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{ok:true}})+'\\n');});`,
  );
  const indexPath = join(directory, ".client-thread-links.json");
  await writeFile(indexPath, "{broken");
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => ({ modelProvider: "openai" }),
  });
  const ask = async (id: number, method: string, params = {}) => {
    input.write(`${JSON.stringify({ id, method, params })}\n`);
    return JSON.parse((await messages.next()).value);
  };
  try {
    assert.equal((await ask(1, "initialize")).result.ok, true);
    assert.equal((await ask(2, "account/read")).result.ok, true);
    assert.match(
      (await ask(3, "turn/interrupt", { threadId: "existing", turnId: "active" })).error.message,
      /continuation metadata is unavailable/u,
    );
    assert.match(
      (await ask(4, "turn/start", { threadId: "existing" })).error.message,
      /continuation metadata is unavailable/u,
    );
    assert.equal(await readFile(indexPath, "utf8"), "{broken");
    await writeFile(indexPath, "[]");
    assert.equal(
      (await ask(5, "turn/interrupt", { threadId: "existing", turnId: "active" })).result.ok,
      true,
    );
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reloads a continuation changed by another relay even when the selected provider is unchanged", {
  timeout: 5000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-relay-external-continuation-"));
  const fixture = join(directory, "fixture.cjs");
  await writeFile(
    fixture,
    `const loaded=new Set();const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line),params=message.params||{};if(message.method==='thread/resume'){loaded.add(params.threadId);send({id:message.id,result:{thread:{id:params.threadId,modelProvider:'openai'},modelProvider:'openai'}});}else if(message.method==='turn/start'){send(loaded.has(params.threadId)?{id:message.id,result:{receivedId:params.threadId}}:{id:message.id,error:{code:-32600,message:'thread not loaded'}});}});`,
  );
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = new PassThrough();
  const messages = createInterface({ input: output })[Symbol.asyncIterator]();
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => ({ modelProvider: "openai" }),
  });
  const ask = async (id: number, method: string) => {
    input.write(`${JSON.stringify({ id, method, params: { threadId: "original" } })}\n`);
    return JSON.parse((await messages.next()).value);
  };
  try {
    assert.equal((await ask(1, "thread/resume")).result.thread.id, "original");
    createCodexThreadLinks(directory).record("original", "continued-elsewhere");
    assert.equal((await ask(2, "turn/start")).result?.receivedId, "continued-elsewhere");
  } finally {
    await proxy.close();
    input.destroy();
    output.destroy();
    errors.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const transition of ["metadata-only", "unsubscribe", "closed"])
  test(`resumes a native thread before sending after ${transition}`, {
    timeout: 5000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-thread-lifecycle-"));
    const fixture = join(directory, "fixture.cjs");
    await writeFile(
      fixture,
      `let loaded=false,resumes=0;const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');const thread={id:'original',modelProvider:'openai'};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.method==='thread/resume'){loaded=true;resumes++;send({id:message.id,result:{thread,modelProvider:'openai'}});}else if(message.method==='thread/read')send({id:message.id,result:{thread}});else if(message.method==='thread/unsubscribe'){loaded=false;send({id:message.id,result:{status:'unsubscribed'}});}else if(message.method==='fixture/close'){loaded=false;send({method:'thread/closed',params:{threadId:'original'}});send({id:message.id,result:{}});}else if(message.method==='turn/start')send(loaded?{id:message.id,result:{resumes}}:{id:message.id,error:{code:-32600,message:'thread not loaded'}});});`,
    );
    const input = new PassThrough(),
      output = new PassThrough(),
      errors = new PassThrough();
    const messages = createInterface({ input: output })[Symbol.asyncIterator]();
    const proxy = createCodexClientProxy({
      launch: await createFixtureLaunch(fixture, directory),
      input,
      output,
      errorOutput: errors,
      resolveActiveSelection: () => ({ modelProvider: "openai" }),
    });
    let requestId = 0;
    const ask = async (method: string) => {
      const id = ++requestId;
      input.write(`${JSON.stringify({ id, method, params: { threadId: "original" } })}\n`);
      while (true) {
        const message = JSON.parse((await messages.next()).value);
        if (message.id === id) return message;
      }
    };
    try {
      if (transition === "metadata-only") await ask("thread/read");
      else {
        await ask("thread/resume");
        await ask(transition === "unsubscribe" ? "thread/unsubscribe" : "fixture/close");
      }
      assert.equal(
        (await ask("turn/start")).result?.resumes,
        transition === "metadata-only" ? 1 : 2,
      );
    } finally {
      await proxy.close();
      input.destroy();
      output.destroy();
      errors.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

interface OwnershipFixtureMessage {
  /** Request correlation identifier, when present. */
  id?: number;
  /** Native notification name, when present. */
  method?: string;
  /** Values returned by the fixture's requested operation. */
  result: {
    /** Physical thread returned by a start or resume. */
    thread: { id: string };
    /** Process that received the request. */
    pid: number;
    /** Provider owning that process. */
    provider: string;
    /** Provider confirmed while opening the thread. */
    modelProvider: string;
    /** Physical thread receiving a turn operation. */
    threadId: string;
  };
  /** Terminal request error after a worker exits. */
  error?: { code: number; message: string };
  /** Turn lifecycle carried by native notifications. */
  params: { turn: { id: string; status: string } };
}

const createOwnershipRelayFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-turn-ownership-"));
  const fixture = join(directory, "fixture.cjs");
  await writeFile(
    fixture,
    `const setting=process.argv.find(value=>value.startsWith('model_provider='));const provider=JSON.parse(setting.slice('model_provider='.length));
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line),params=message.params||{};
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='thread/start'||message.method==='thread/resume'){const threadId=params.threadId||provider+'-'+params.label;send({id:message.id,result:{thread:{id:threadId,modelProvider:provider},modelProvider:provider,pid:process.pid}});}
else if(message.method==='fixture/begin'){send({method:'turn/started',params:{threadId:params.threadId,turn:{id:params.turnId,status:'inProgress'}}});send({id:message.id,result:{}});}
else if(message.method==='fixture/exit')process.exit(0);
else if(message.method==='fixture/complete-exit')process.stdout.write(JSON.stringify({id:message.id,result:{provider,pid:process.pid}})+'\\n',()=>process.exit(0));
else if(message.method==='fixture/wait')return;
else if(message.method==='thread/read')send({id:message.id,result:{thread:{id:params.threadId,modelProvider:provider}}});
else if(message.id!==undefined)send({id:message.id,result:{provider,threadId:params.threadId,pid:process.pid}});
});`,
  );
  const input = new PassThrough(),
    output = new PassThrough(),
    errors = new PassThrough();
  let selection: CodexActiveSelection = { modelProvider: "openai" };
  const proxy = createCodexClientProxy({
    launch: await createFixtureLaunch(fixture, directory),
    input,
    output,
    errorOutput: errors,
    resolveActiveSelection: () => selection,
  });
  const waiting = new Map<number, { resolve: (message: OwnershipFixtureMessage) => void }>();
  const notifications: OwnershipFixtureMessage[] = [];
  const readers = createInterface({ input: output });
  readers.on("line", (line) => {
    const message = JSON.parse(line) as OwnershipFixtureMessage;
    const pending = message.id === undefined ? undefined : waiting.get(message.id);
    if (pending === undefined) notifications.push(message);
    else {
      waiting.delete(message.id as number);
      pending.resolve(message);
    }
  });
  let requestId = 0;
  const ask = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<OwnershipFixtureMessage>((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Fixture did not receive a terminal result for ${method}.`));
      }, 3000);
      waiting.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
      input.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return {
    ask,
    notifications,
    links: createCodexThreadLinks(directory),
    select: (modelProvider: string) => {
      selection = { modelProvider };
    },
    close: async () => {
      await proxy.close();
      readers.close();
      input.destroy();
      output.destroy();
      errors.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

for (const source of ["openai", "ai_tidu9"])
  for (const continuation of ["original", "new"])
    for (const operation of ["turn/interrupt", "turn/steer"])
      for (const peerExit of [false, true])
        test(`turn ownership matrix: source=${source} continuation=${continuation} op=${operation} peerExit=${peerExit}`, {
          timeout: 12000,
        }, async () => {
          const relay = await createOwnershipRelayFixture();
          try {
            await relay.ask("initialize");
            relay.select(source);
            const original = (await relay.ask("thread/start", { label: "source" })).result.thread
              .id;
            await relay.ask("fixture/begin", { threadId: original, turnId: "owned-turn" });
            const target = source === "openai" ? "ai_tidu9" : "openai";
            relay.select(target);
            const current = (await relay.ask("thread/start", { label: "target" })).result.thread.id;
            if (continuation === "new") relay.links.record(original, current);
            relay.select("auxiliary");
            const peer = (await relay.ask("thread/start", { label: "peer" })).result.thread.id;
            await relay.ask("fixture/begin", { threadId: peer, turnId: "peer-turn" });
            relay.select(target);
            if (peerExit) assert.ok((await relay.ask("fixture/exit", { threadId: peer })).error);
            const result = await relay.ask(operation, {
              threadId: original,
              ...(operation === "turn/steer"
                ? { expectedTurnId: "owned-turn", input: [{ type: "text", text: "continue" }] }
                : { turnId: "owned-turn" }),
            });
            assert.equal(result.result?.provider, source);
            assert.equal(result.result?.threadId, original);
          } finally {
            await relay.close();
          }
        });

for (const continuation of ["original", "new"])
  for (const operation of ["turn/interrupt", "turn/steer"])
    for (const replyBeforeExit of [false, true])
      test(`worker isolation matrix: continuation=${continuation} op=${operation} replyBeforeExit=${replyBeforeExit}`, {
        timeout: 12000,
      }, async () => {
        const relay = await createOwnershipRelayFixture();
        try {
          await relay.ask("initialize");
          const primary = (await relay.ask("thread/start", { label: "primary" })).result.thread.id;
          relay.select("ai_tidu9");
          const owner = await relay.ask("thread/start", { label: "owner" });
          const original = owner.result.thread.id;
          const control = (await relay.ask("thread/start", { label: "control" })).result.thread.id;
          await relay.ask("fixture/begin", { threadId: original, turnId: "worker-turn" });
          const pending = relay.ask("fixture/wait", { threadId: original });
          await relay.ask("fixture/barrier", { threadId: original });
          relay.select("openai");
          if (continuation === "new") relay.links.record(original, primary);
          const exit = relay.ask(replyBeforeExit ? "fixture/complete-exit" : "fixture/exit", {
            threadId: control,
          });
          const [pendingResult, exitResult] = await Promise.all([pending, exit]);
          assert.ok(pendingResult.error);
          if (replyBeforeExit) assert.equal(exitResult.result?.provider, "ai_tidu9");
          else assert.ok(exitResult.error);
          const interrupted = await relay.ask(operation, {
            threadId: original,
            ...(operation === "turn/steer"
              ? { expectedTurnId: "worker-turn", input: [{ type: "text", text: "continue" }] }
              : { turnId: "worker-turn" }),
          });
          assert.ok(interrupted.error);
          assert.equal((await relay.ask("account/read")).result?.provider, "openai");
          relay.select("ai_tidu9");
          const restarted = await relay.ask("thread/start", { label: "restarted" });
          assert.equal(restarted.result?.modelProvider, "ai_tidu9");
          assert.notEqual(restarted.result?.pid, owner.result.pid);
          assert.ok(
            relay.notifications.some(
              (message) =>
                message.method === "turn/completed" &&
                message.params.turn.id === "worker-turn" &&
                message.params.turn.status === "failed",
            ),
          );
        } finally {
          await relay.close();
        }
      });

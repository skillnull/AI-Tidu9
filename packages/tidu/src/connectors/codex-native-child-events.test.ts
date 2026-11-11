import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_HARNESS,
  refreshManagedCodexCatalog,
} from "../clients/codex-model-catalog.js";
import { createStdioJsonRpcClient, type JsonRpcNotification } from "./json-rpc.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const findAgentId = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    try {
      return findAgentId(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(findAgentId).find((item) => item !== undefined);
  if (!isRecord(value)) return undefined;
  if (typeof value.agent_id === "string") return value.agent_id;
  return Object.values(value)
    .map(findAgentId)
    .find((item) => item !== undefined);
};

test("official outer caller emits native child-agent lifecycle and completion through the relay", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-child-events-"));
  const home = join(directory, "native-home");
  await mkdir(home);
  const notifications: JsonRpcNotification[] = [];
  let childRequests = 0;
  let parentRequests = 0;
  let advertisedSpawn = false;
  let advertisedWait = false;
  let waitName = "wait";
  let waitNamespace: unknown;
  let waitParameters: Record<string, unknown> = {};
  let spawnDefinition: Record<string, unknown> | undefined;
  let nativeWaitOutput: unknown;
  const fixtureErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        input?: Record<string, unknown>[];
        tools?: Record<string, unknown>[];
      };
      const input = body.input ?? [];
      const lastUser = input.filter((item) => item.role === "user").at(-1);
      const isChild = JSON.stringify(lastUser).includes("Child fixture:");
      const spawnResult = input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_spawn_fixture",
      );
      const waitResult = input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_wait_fixture",
      );
      if (waitResult !== undefined) nativeWaitOutput = waitResult.output;
      const tools = (body.tools ?? []).flatMap((tool) =>
        Array.isArray(tool.tools)
          ? tool.tools.filter(isRecord).map((nested) => ({ ...nested, namespace: tool.name }))
          : [tool],
      );
      advertisedSpawn ||= tools.some((tool) => tool.name === "spawn_agent");
      spawnDefinition ??= tools.find((tool) => tool.name === "spawn_agent");
      const waitDefinition = tools.find(
        (tool) => tool.name === "wait" || tool.name === "wait_agent",
      );
      if (waitDefinition !== undefined) {
        advertisedWait = true;
        waitName = String(waitDefinition.name);
        waitNamespace = waitDefinition.namespace;
        waitParameters =
          isRecord(waitDefinition.parameters) && isRecord(waitDefinition.parameters.properties)
            ? waitDefinition.parameters.properties
            : {};
      }
      const message = (text: string) => ({
        id: `message-${parentRequests}-${childRequests}`,
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text, annotations: [] }],
      });
      let item: Record<string, unknown>;
      if (isChild) {
        childRequests += 1;
        item = message("CHILD_COMPLETE");
      } else {
        parentRequests += 1;
        if (!advertisedSpawn || !advertisedWait)
          item = message("Requested native agent tools are not advertised.");
        else if (spawnResult === undefined)
          item = {
            id: "spawn-item",
            type: "function_call",
            call_id: "call_spawn_fixture",
            name: "spawn_agent",
            ...(typeof spawnDefinition?.namespace === "string"
              ? { namespace: spawnDefinition.namespace }
              : {}),
            arguments: JSON.stringify({ message: "Child fixture: return CHILD_COMPLETE." }),
          };
        else if (waitResult === undefined) {
          const agentId = findAgentId(spawnResult.output);
          if (agentId === undefined)
            throw new Error(
              `Native spawn result did not supply an agent ID: ${JSON.stringify(spawnResult.output)}`,
            );
          const target =
            "ids" in waitParameters
              ? { ids: [agentId] }
              : "targets" in waitParameters
                ? { targets: [agentId] }
                : "agent_ids" in waitParameters
                  ? { agent_ids: [agentId] }
                  : "agent_id" in waitParameters
                    ? { agent_id: agentId }
                    : "target" in waitParameters
                      ? { target: agentId }
                      : {};
          item = {
            id: "wait-item",
            type: "function_call",
            call_id: "call_wait_fixture",
            name: waitName,
            ...(typeof waitNamespace === "string" ? { namespace: waitNamespace } : {}),
            arguments: JSON.stringify({ ...target, timeout_ms: 10000 }),
          };
        } else item = message("Parent fixture complete.");
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, payload: Record<string, unknown>) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      const responseId = `response-${parentRequests}-${childRequests}`;
      send("response.created", {
        response: { id: responseId, object: "response", status: "in_progress", output: [] },
      });
      send("response.output_item.added", { output_index: 0, item });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id: responseId,
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      });
      response.end();
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : "Fixture request failed.");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const item = {
        id: "fixture-failure",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: "The isolated fixture could not continue.",
            annotations: [],
          },
        ],
      };
      for (const event of [
        {
          type: "response.created",
          response: {
            id: "fixture-failure-response",
            object: "response",
            status: "in_progress",
            output: [],
          },
        },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "fixture-failure-response",
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: [
        ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
        fileURLToPath(
          new URL(
            `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        "-c",
        'model_provider="fixture"',
        "-c",
        `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false}`,
        "-c",
        'model="gpt-5.1-codex"',
        "-c",
        "features.multi_agent=true",
        "-c",
        "features.multi_agent_v2=false",
        "app-server",
      ],
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: home,
        TIDU_CODEX_REAL_COMMAND: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
      },
      workingDirectory: directory,
    },
    {
      onNotification: (notification) => {
        notifications.push(notification);
      },
    },
  );
  try {
    await client.request("initialize", {
      clientInfo: { name: "native-fixture", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const started = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: directory,
      model: "gpt-5.1-codex",
      modelProvider: "fixture",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    });
    const turn = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Parent fixture: delegate one check and await its result." }],
    });
    const deadline = Date.now() + 30000;
    while (
      !notifications.some(
        (notification) =>
          notification.method === "turn/completed" &&
          isRecord(notification.params) &&
          isRecord(notification.params.turn) &&
          notification.params.turn.id === turn.turn.id,
      )
    ) {
      if (Date.now() >= deadline)
        throw new Error(
          `Native child fixture did not complete: ${JSON.stringify({ parentRequests, childRequests, advertisedSpawn, advertisedWait, fixtureErrors })}`,
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(fixtureErrors, []);
    assert.equal(advertisedSpawn, true, "The official caller must expose native spawn_agent.");
    assert.equal(advertisedWait, true, "The official caller must expose a native agent wait tool.");
    assert.ok(
      childRequests > 0,
      "The official spawned child must independently reach the local model fixture.",
    );
    const items = notifications.flatMap<Record<string, unknown> & { method: string }>(
      (notification) =>
        isRecord(notification.params) && isRecord(notification.params.item)
          ? [{ method: notification.method, ...notification.params.item }]
          : [],
    );
    const spawns = items.filter(
      (item) => item.type === "collabAgentToolCall" && item.tool === "spawnAgent",
    );
    assert.deepEqual(
      spawns.map((item) => ({ method: item.method, id: item.id, status: item.status })),
      [
        { method: "item/started", id: "call_spawn_fixture", status: "inProgress" },
        { method: "item/completed", id: "call_spawn_fixture", status: "completed" },
      ],
    );
    const spawned = spawns[1];
    assert.ok(Array.isArray(spawned?.receiverThreadIds));
    const childId = spawned.receiverThreadIds[0];
    assert.equal(typeof childId, "string");
    assert.ok(
      notifications.some(
        (event) =>
          event.method === "turn/started" &&
          isRecord(event.params) &&
          event.params.threadId === childId,
      ),
    );
    assert.ok(
      notifications.some(
        (event) =>
          event.method === "turn/completed" &&
          isRecord(event.params) &&
          event.params.threadId === childId &&
          isRecord(event.params.turn) &&
          event.params.turn.status === "completed",
      ),
    );
    const childStates = notifications.flatMap((event) =>
      event.method === "thread/status/changed" &&
      isRecord(event.params) &&
      event.params.threadId === childId &&
      isRecord(event.params.status)
        ? [event.params.status.type]
        : [],
    );
    assert.ok(childStates.includes("active"), JSON.stringify(childStates));
    assert.equal(childStates.at(-1), "idle", JSON.stringify(childStates));
    const waits = items.filter(
      (item) => item.type === "collabAgentToolCall" && item.tool === "wait",
    );
    assert.deepEqual(
      waits.map((item) => ({ method: item.method, id: item.id, status: item.status })),
      [
        { method: "item/started", id: "call_wait_fixture", status: "inProgress" },
        { method: "item/completed", id: "call_wait_fixture", status: "completed" },
      ],
      JSON.stringify({ waitName, waitNamespace, waitParameters, nativeWaitOutput }),
    );
    const completed = waits.find(
      (item) => item.method === "item/completed" && item.status === "completed",
    );
    assert.ok(completed);
    assert.ok(isRecord(completed.agentsStates));
    assert.deepEqual(completed.agentsStates[childId], {
      status: "completed",
      message: "CHILD_COMPLETE",
    });
    assert.ok(items.indexOf(spawns[0] as (typeof items)[number]) < items.indexOf(spawned));
    assert.ok(items.indexOf(spawned) < items.indexOf(waits[0] as (typeof items)[number]));
    assert.ok(items.indexOf(waits[0] as (typeof items)[number]) < items.indexOf(completed));
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("the official managed worker samples with a freshly inherited complete harness catalog", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 60000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "native-managed-harness-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "native-home");
  await mkdir(home);
  const command = process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND as string;
  const environment = { PATH: process.env.PATH, CODEX_HOME: home };
  const version = execFileSync(command, ["--version"], { env: environment, encoding: "utf8" })
    .trim()
    .match(/^codex-cli\s+(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/iu)?.[1];
  assert.ok(version);
  const catalogPath = join(home, ".ai-tidu9-model-catalog.json");
  const model = {
    slug: "ai-tidu9-config",
    display_name: "AI-Tidu9",
    description: "AI-Tidu9 local Agent service",
    supported_reasoning_levels: [],
    ...DEFAULT_CODEX_HARNESS,
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    upgrade: null,
    default_reasoning_summary: "auto",
    support_verbosity: true,
    default_verbosity: "low",
    truncation_policy: { mode: "tokens", limit: 10000 },
    input_modalities: ["text", "image"],
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    supports_search_tool: true,
    web_search_tool_type: "text_and_image",
    context_window: 128000,
    max_context_window: 128000,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    use_responses_lite: false,
  };
  const instructions = "REFRESHED_NATIVE_HARNESS: preserve the current native tool contracts.";
  const sourceMessages = {
    ...(DEFAULT_CODEX_HARNESS.model_messages as Record<string, unknown>),
    instructions_template: instructions,
    future_protocol_section: { revision: 7, nested: { values: ["preserve", null, 19] } },
  };
  const sourceModel: Record<string, unknown> = { ...model };
  delete sourceModel.base_instructions;
  await writeFile(catalogPath, JSON.stringify({ models: [model] }));
  await writeFile(
    join(home, ".ai-tidu9-profile-state.json"),
    JSON.stringify({
      owner: "AI-Tidu9",
      profile: "ai-tidu9",
      model: model.slug,
      officialModel: "official-source",
    }),
  );
  await writeFile(
    join(home, "models_cache.json"),
    JSON.stringify({
      client_version: version.replace(/-.*/u, ""),
      models: [{ ...sourceModel, slug: "official-source", model_messages: sourceMessages }],
    }),
  );
  assert.equal((await readFile(catalogPath, "utf8")).includes(instructions), false);
  const refreshed = refreshManagedCodexCatalog({ codexHomeDirectory: home, hostVersion: version });
  assert.equal(refreshed.changed, true);
  assert.equal(typeof refreshed.fingerprint, "string");
  const inherited = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(inherited.models.length, 1);
  assert.equal(inherited.models[0].slug, model.slug);
  assert.equal(inherited.models[0].base_instructions, undefined);
  assert.deepEqual(inherited.models[0].model_messages, sourceMessages);
  const notifications: JsonRpcNotification[] = [];
  const sampled: Record<string, unknown>[] = [];
  const fixtureErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      sampled.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : "Invalid fixture request.");
    }
    const item = {
      id: "refreshed-harness-message",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "REFRESHED_HARNESS_COMPLETE", annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      {
        type: "response.created",
        response: { id: "harness-response", status: "in_progress", output: [] },
      },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "harness-response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: [
        ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
        fileURLToPath(
          new URL(
            `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        "-c",
        'model_provider="fixture"',
        "-c",
        `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false}`,
        "-c",
        `model=${JSON.stringify(model.slug)}`,
        "-c",
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        "app-server",
      ],
      environment: {
        ...environment,
        TIDU_CODEX_REAL_COMMAND: command,
        TIDU_CODEX_RECOVERY_PROVIDER: "fixture",
      },
      workingDirectory: directory,
    },
    { onNotification: (notification) => void notifications.push(notification) },
  );
  try {
    await client.request("initialize", {
      clientInfo: { name: "native-harness-fixture", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const started = await client.request<{ thread: { id: string; modelProvider: string } }>(
      "thread/start",
      {
        cwd: directory,
        model: model.slug,
        modelProvider: "fixture",
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ephemeral: true,
      },
    );
    assert.equal(started.thread.modelProvider, "fixture");
    const turn = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Sample the freshly refreshed managed harness once." }],
    });
    const deadline = Date.now() + 30000;
    let completed: JsonRpcNotification | undefined;
    while (completed === undefined) {
      completed = notifications.find(
        (notification) =>
          notification.method === "turn/completed" &&
          isRecord(notification.params) &&
          isRecord(notification.params.turn) &&
          notification.params.turn.id === turn.turn.id,
      );
      if (completed !== undefined) break;
      if (Date.now() >= deadline) throw new Error("Refreshed native managed turn did not finish.");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(fixtureErrors, []);
    assert.equal(sampled.length, 1);
    assert.equal(sampled[0]?.model, model.slug);
    const sample = sampled[0];
    const instructionTexts = [
      ...(typeof sample?.instructions === "string" ? [sample.instructions] : []),
      ...(Array.isArray(sample?.input)
        ? sample.input.flatMap((item: unknown) =>
            isRecord(item) && item.role === "developer" && Array.isArray(item.content)
              ? item.content.flatMap((part: unknown) =>
                  isRecord(part) && part.type === "input_text" && typeof part.text === "string"
                    ? [part.text]
                    : [],
                )
              : [],
          )
        : []),
    ];
    assert.deepEqual(
      instructionTexts.filter((text) => text === instructions),
      [instructions],
    );
    assert.ok(isRecord(completed.params) && isRecord(completed.params.turn));
    assert.equal(completed.params.turn.status, "completed");
    assert.ok(
      notifications.some(
        (event) =>
          event.method === "item/completed" &&
          isRecord(event.params) &&
          isRecord(event.params.item) &&
          event.params.item.type === "agentMessage" &&
          typeof event.params.item.text === "string" &&
          event.params.item.text.includes("REFRESHED_HARNESS_COMPLETE"),
      ),
    );
    assert.deepEqual(JSON.parse(await readFile(catalogPath, "utf8")), inherited);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

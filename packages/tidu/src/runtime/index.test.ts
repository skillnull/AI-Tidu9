import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentKernel, createInMemoryTaskCapsuleStore } from "../agent/index.js";
import { CONFIG_SCHEMA_VERSION } from "../config/index.js";
import type { ConfigCenterBootstrap } from "../config-center/index.js";
import { PRODUCT } from "../core/index.js";
import {
  CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  createCapabilityRuntime,
  defineCapabilityProvider,
} from "../ecosystem/index.js";
import {
  createEnterpriseControlPlane,
  createInMemoryEnterpriseStateRepository,
} from "../enterprise/index.js";
import type { ModelProvider } from "../providers/index.js";
import { createScalingControlPlane } from "../scaling/index.js";
import { IN_MEMORY_DATABASE_PATH, STORAGE_SCHEMA_VERSION } from "../storage/index.js";
import { startLocalRuntime } from "./index.js";

test("exposes bounded Agent task creation and control through the local API", async () => {
  const agentKernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: {
      understand: async (task) => ({
        objective: task.goal.objective,
        acceptanceCriteria: [...task.goal.acceptanceCriteria],
        constraints: [],
        assumptions: [],
        requiredCapabilities: [],
      }),
      plan: async () => ({
        revision: 1,
        steps: [{ id: "deliver", title: "Deliver", kind: "reason" }],
      }),
    },
    worker: { execute: async () => ({ summary: "Delivered" }) },
  });
  const runtime = await startLocalRuntime({
    agentKernel,
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const createResponse = await fetch(`${runtime.origin}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Complete a controlled task" }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      task: { taskId: string; status: string };
    };
    assert.equal(created.task.status, "created");

    const listResponse = await fetch(`${runtime.origin}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as {
      available: boolean;
      tasks: Array<{ taskId: string }>;
    };
    assert.equal(list.available, true);
    assert.deepEqual(
      list.tasks.map((task) => task.taskId),
      [created.task.taskId],
    );

    const resumeResponse = await fetch(
      `${runtime.origin}/api/tasks/${created.task.taskId}/control`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      },
    );
    assert.equal(resumeResponse.status, 200);
    assert.equal(
      ((await resumeResponse.json()) as { task: { status: string } }).task.status,
      "completed",
    );
  } finally {
    await runtime.close();
  }
});

test("routes Responses and Chat Completions hosts through the same Agent kernel", async () => {
  const agentKernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: {
      understand: async (task) => ({
        objective: task.goal.objective,
        acceptanceCriteria: [...task.goal.acceptanceCriteria],
        constraints: [],
        assumptions: [],
        requiredCapabilities: [],
      }),
      plan: async () => ({
        revision: 1,
        steps: [{ id: "deliver", title: "Deliver through the Agent kernel", kind: "reason" }],
      }),
    },
    worker: {
      execute: async ({ task }) => ({
        summary: `Agent completed: ${task.goal.objective}`,
        evidence: [
          {
            kind: "model",
            integrity: "reported",
            summary: "The shared Agent worker completed the goal.",
            supportsCriteria: [0],
          },
        ],
      }),
    },
    verifier: {
      verify: async ({ evidence }) => ({
        summary: "Shared Agent result verified.",
        criteria: [
          {
            criterionIndex: 0,
            accepted: true,
            reason: "The shared Agent emitted completion evidence.",
            evidenceIds: evidence.map((item) => item.id),
          },
        ],
      }),
    },
  });
  const runtime = await startLocalRuntime({
    agentKernel,
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const responsesResponse = await fetch(`${runtime.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ai-tidu9-config", input: "Responses host goal" }),
    });
    assert.equal(responsesResponse.status, 200);
    assert.match(await responsesResponse.text(), /Shared Agent result verified/u);

    const chatResponse = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "Chat host goal" }],
      }),
    });
    assert.equal(chatResponse.status, 200);
    assert.match(await chatResponse.text(), /Shared Agent result verified/u);

    const cursorResponse = await fetch(`${runtime.origin}/v1/hosts/cursor/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ai-tidu9-config", input: "Cursor host goal" }),
    });
    assert.equal(cursorResponse.status, 200);
    assert.match(await cursorResponse.text(), /Shared Agent result verified/u);

    const taskList = (await (await fetch(`${runtime.origin}/api/tasks`)).json()) as {
      tasks: Array<{ objective: string; originHost?: string }>;
    };
    assert.deepEqual(taskList.tasks.map((task) => task.objective).sort(), [
      "Chat host goal",
      "Cursor host goal",
      "Responses host goal",
    ]);
    assert.equal(
      taskList.tasks.find((task) => task.objective === "Cursor host goal")?.originHost,
      "cursor",
    );
  } finally {
    await runtime.close();
  }
});

test("exposes the shared capability-completion policy and bounded usage status", async () => {
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "main-model" },
    execute: async () => ({
      kind: "json",
      statusCode: 200,
      body: { choices: [{ message: { content: "{}" } }] },
    }),
  };
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
    provider,
  });
  try {
    const response = await fetch(`${runtime.origin}/api/capability-completion`);
    assert.equal(response.status, 200);
    const status = (await response.json()) as {
      available: boolean;
      operational: boolean;
      configuration: { enabled: boolean; specialists: unknown[] };
      hosts: string[];
      records: unknown[];
    };
    assert.equal(status.available, true);
    assert.equal(status.operational, false);
    assert.equal(status.configuration.enabled, true);
    assert.deepEqual(status.configuration.specialists, []);
    assert.deepEqual(status.hosts, ["codex", "cursor", "cli", "ollama", "openai-compatible"]);
    assert.deepEqual(status.records, []);
  } finally {
    await runtime.close();
  }
});

test("starts a loopback runtime with a verifiable health endpoint", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      product: PRODUCT.name,
      runtimeMode: "installed",
      scaling: { status: "disabled" },
      status: "ok",
      storage: {
        provider: "sqlite",
        schemaVersion: STORAGE_SCHEMA_VERSION,
        status: "ok",
      },
      version: PRODUCT.version,
    });
    const services = (await (await fetch(`${runtime.origin}/api/services`)).json()) as {
      mode: string;
      services: Array<{
        actions: string[];
        command: string;
        configurationPath: string;
        endpoint: string;
        id: string;
        lifecycle: string;
        logLocation: string;
        processId: number | null;
        proxyConfigurationPath: string | null;
        status: string;
        version: string;
      }>;
    };
    assert.equal(services.mode, "installed");
    assert.deepEqual(
      services.services.map(({ id, status }) => [id, status]),
      [["tidu:runtime-p", "running"]],
    );
    assert.deepEqual(services.services[0]?.actions, ["refresh", "restart", "stop"]);
    assert.equal(services.services[0]?.configurationPath, IN_MEMORY_DATABASE_PATH);
    assert.match(services.services[0]?.logLocation ?? "", /logs\/runtime\.log$/u);
    assert.equal(services.services[0]?.proxyConfigurationPath, null);
    assert.deepEqual(
      services.services.map(({ command, endpoint, lifecycle, processId, version }) => ({
        command,
        endpoint,
        lifecycle,
        processId,
        version,
      })),
      [
        {
          command: "tidu service start tidu:runtime-p",
          endpoint: runtime.origin,
          lifecycle: "managed",
          processId: process.pid,
          version: PRODUCT.version,
        },
      ],
    );
  } finally {
    await runtime.close();
  }
});

test("configures the complete Codex dual-channel entry from the local API", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tidu-runtime-codex-"));
  const executableDirectory = join(temporaryRoot, "bin");
  const codexHomeDirectory = join(temporaryRoot, "codex-home");
  const codexExecutable = join(executableDirectory, "codex");
  const originalEnvironment = {
    codexHome: process.env.CODEX_HOME,
    executablePath: process.env.PATH,
  };
  mkdirSync(executableDirectory, { recursive: true });
  mkdirSync(codexHomeDirectory, { recursive: true });
  writeFileSync(join(codexHomeDirectory, "config.toml"), 'model = "official-test"\n', {
    mode: 0o600,
  });
  writeFileSync(
    join(codexHomeDirectory, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "official-test",
          display_name: "Official Test",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    codexExecutable,
    '#!/bin/sh\nif [ "$2" = "get" ]; then exit 1; fi\nif [ "$2" = "add" ]; then exit 0; fi\nexit 1\n',
  );
  chmodSync(codexExecutable, 0o700);
  process.env.CODEX_HOME = codexHomeDirectory;
  process.env.PATH = `${executableDirectory}:${originalEnvironment.executablePath ?? ""}`;
  let providerFailure: Error | undefined;
  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: "official-test" },
    execute: async (request) => {
      if (providerFailure !== undefined) throw providerFailure;
      return {
        kind: "json",
        statusCode: 200,
        body: {
          id: "verified",
          object: "response",
          model: request.virtualModelId,
          output: [],
        },
      };
    },
  };
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    port: 0,
    provider,
  });

  try {
    const response = await fetch(`${runtime.origin}/api/clients/codex/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      activeMode: "official",
      connected: true,
      model: "ai-tidu9-config",
      profile: "ai-tidu9",
    });
    const statusResponse = await fetch(`${runtime.origin}/api/clients/codex/configuration`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
      activeMode: "official",
      endpoint: runtime.origin,
      installed: true,
      model: "ai-tidu9-config",
    });
    const modelSelectionResponse = await fetch(
      `${runtime.origin}/api/clients/codex/configuration`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ai-tidu9-config" }),
      },
    );
    assert.equal(modelSelectionResponse.status, 422);
    assert.match(
      JSON.stringify(await modelSelectionResponse.json()),
      /configuration mode must be official or ai-tidu9/iu,
    );
    const tiduModeResponse = await fetch(`${runtime.origin}/api/clients/codex/configuration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ai-tidu9" }),
    });
    assert.equal(tiduModeResponse.status, 200);
    assert.equal(
      ((await tiduModeResponse.json()) as { activeMode: string }).activeMode,
      "ai-tidu9",
    );
    const tiduConfiguration = readFileSync(join(codexHomeDirectory, "config.toml"), "utf8");
    assert.match(tiduConfiguration, /model = "ai-tidu9-config"/u);
    assert.match(tiduConfiguration, /model_provider = "ai_tidu9"/u);
    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as { models: { slug: string }[] };
    assert.deepEqual(
      catalog.models.map(({ slug }) => slug),
      ["ai-tidu9-config"],
    );
    const officialModeResponse = await fetch(`${runtime.origin}/api/clients/codex/configuration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "official" }),
    });
    assert.equal(officialModeResponse.status, 200);
    assert.equal(
      readFileSync(join(codexHomeDirectory, "config.toml"), "utf8"),
      'model = "official-test"\n',
    );
    providerFailure = new Error("official session expired");
    const failedSwitchResponse = await fetch(`${runtime.origin}/api/clients/codex/configuration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "ai-tidu9" }),
    });
    assert.equal(failedSwitchResponse.status, 503);
    const failedSwitch = (await failedSwitchResponse.json()) as {
      failureSource: string;
      nextSteps: string[];
      reason: string;
      reasonCode: string;
    };
    assert.equal(failedSwitch.failureSource, "official-codex");
    assert.equal(failedSwitch.reasonCode, "provider_request_failed");
    assert.match(failedSwitch.reason, /official session expired/u);
    assert.equal(
      failedSwitch.nextSteps.some((step) => step.includes("codex login status")),
      true,
    );
    assert.equal(
      readFileSync(join(codexHomeDirectory, "config.toml"), "utf8"),
      'model = "official-test"\n',
    );
  } finally {
    await runtime.close();
    if (originalEnvironment.codexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalEnvironment.codexHome;
    }
    process.env.PATH = originalEnvironment.executablePath;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects local Codex client configuration in enterprise deployments", async () => {
  const enterpriseControlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(),
  );
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    enterpriseControlPlane,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/api/clients/codex/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "PERSONAL_EDITION_ONLY" });
  } finally {
    await runtime.close();
  }
});

test("exposes capability providers through one bounded SDK API", async () => {
  const provider = defineCapabilityProvider({
    manifest: {
      id: "company.reviewer",
      name: "Company reviewer",
      version: "1.0.0",
      protocolVersion: CAPABILITY_PROVIDER_PROTOCOL_VERSION,
      kind: "agent",
      source: "enterprise",
      capabilities: ["code.review"],
      permissions: ["agent.delegate"],
      trust: "trusted",
    },
    invoke: async ({ input }) => ({ output: { reviewed: input } }),
  });
  const runtime = await startLocalRuntime({
    capabilityProviders: [provider],
    capabilityRuntime: createCapabilityRuntime({
      grantedPermissions: ["agent.delegate"],
    }),
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const listResponse = await fetch(`${runtime.origin}/v1/ecosystem/providers`);
    assert.equal(listResponse.status, 200);
    assert.equal(
      ((await listResponse.json()) as { providers: Array<{ id: string }> }).providers[0]?.id,
      "company.reviewer",
    );

    const invokeResponse = await fetch(
      `${runtime.origin}/v1/ecosystem/providers/company.reviewer/invoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "agent.delegate", input: "change" }),
      },
    );
    assert.equal(invokeResponse.status, 200);
    assert.deepEqual(await invokeResponse.json(), {
      output: { reviewed: "change" },
    });
  } finally {
    await runtime.close();
  }
});

test("prevents concurrent runtimes from owning the same persistent data", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-runtime-lock-"));
  const databasePath = join(temporaryDirectory, "AI-Tidu9", "tidu.db");
  const firstRuntime = await startLocalRuntime({ databasePath, port: 0 });

  try {
    await assert.rejects(
      startLocalRuntime({ databasePath, port: 0 }),
      (error) => error instanceof Error && error.message.includes("running personal runtime"),
    );
    await firstRuntime.close();
    const restartedRuntime = await startLocalRuntime({ databasePath, port: 0 });
    await restartedRuntime.close();
  } finally {
    await firstRuntime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("serves the local configuration center and its bootstrap API", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    port: 0,
  });

  try {
    const pageResponse = await fetch(runtime.origin);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html/u);
    assert.match(pageResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
    assert.equal(pageResponse.headers.get("x-frame-options"), "DENY");
    const page = await pageResponse.text();
    assert.match(page, /九门赛博提督/u);

    const assetPath = page.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1];
    assert.notEqual(assetPath, undefined);
    const assetResponse = await fetch(`${runtime.origin}${assetPath}`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get("content-type") ?? "", /^text\/javascript/u);
    assert.match(await assetResponse.text(), /安装与使用指南/u);

    const bootstrapResponse = await fetch(`${runtime.origin}/api/config-center`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = (await bootstrapResponse.json()) as ConfigCenterBootstrap;
    assert.equal(bootstrap.product.name, PRODUCT.name);
    assert.equal(bootstrap.storage.provider, "sqlite");
    assert.deepEqual(bootstrap.runtime.provider, {
      configured: false,
      type: null,
      model: null,
    });
    assert.equal(
      bootstrap.configuration.workspace.active.configuration.schemaVersion,
      CONFIG_SCHEMA_VERSION,
    );
    assert.equal(bootstrap.configuration.workspace.active.configuration.activeMode, "managed");
    assert.equal(bootstrap.configuration.editable, true);
    assert.equal(bootstrap.clients.privacy, "metadata-only");
  } finally {
    await runtime.close();
  }
});

test("routes validated inference through an injected real provider adapter", async () => {
  const requests: Array<{
    protocol: string;
    model: unknown;
    virtualModelId: string;
  }> = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "upstream-test-model" },
    execute: async (request) => {
      requests.push({
        protocol: request.protocol,
        model: request.body.model,
        virtualModelId: request.virtualModelId,
      });
      return {
        kind: "json",
        statusCode: 200,
        body:
          request.protocol === "chat-completions"
            ? {
                id: "chatcmpl-test",
                object: "chat.completion",
                model: request.virtualModelId,
                choices: [],
              }
            : {
                id: "resp-test",
                object: "response",
                model: request.virtualModelId,
                status: "completed",
                output: [],
              },
      };
    },
  };
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
    provider,
  });

  try {
    const bootstrapResponse = await fetch(`${runtime.origin}/api/config-center`);
    const bootstrap = (await bootstrapResponse.json()) as ConfigCenterBootstrap;
    assert.deepEqual(bootstrap.runtime.provider, {
      configured: true,
      type: "openai-compatible",
      model: "upstream-test-model",
    });

    const chatResponse = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        metadata: { ai_tidu9_probe: true },
      }),
    });
    assert.equal(chatResponse.status, 200);
    assert.equal(chatResponse.headers.get("x-ai-tidu9"), "true");
    assert.equal(((await chatResponse.json()) as { model: string }).model, "ai-tidu9-config");

    const responsesResponse = await fetch(`${runtime.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        input: "hello",
        metadata: { ai_tidu9_probe: true },
      }),
    });
    assert.equal(responsesResponse.status, 200);
    assert.equal(((await responsesResponse.json()) as { model: string }).model, "ai-tidu9-config");
    assert.deepEqual(requests, [
      {
        protocol: "chat-completions",
        model: "ai-tidu9-config",
        virtualModelId: "ai-tidu9-config",
      },
      {
        protocol: "responses",
        model: "ai-tidu9-config",
        virtualModelId: "ai-tidu9-config",
      },
    ]);
  } finally {
    await runtime.close();
  }
});

test("streams provider events through the virtual-model endpoint without buffering", async () => {
  const encoder = new TextEncoder();
  let receivedTools = false;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "upstream-test-model" },
    execute: async (request) => {
      receivedTools = Array.isArray(request.body.tools);
      return {
        kind: "stream",
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-test","model":"ai-tidu9-config","choices":[{"delta":{"content":"hello"}}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      };
    },
  };
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
    provider,
  });

  try {
    const response = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        metadata: { ai_tidu9_probe: true },
        stream: true,
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
    assert.equal(response.headers.get("x-ai-tidu9"), "true");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.equal(receivedTools, true);
    assert.match(await response.text(), /data: \[DONE\]/u);
  } finally {
    await runtime.close();
  }
});

test("cancels upstream streaming work when the client disconnects", async () => {
  const encoder = new TextEncoder();
  let resolveAbort: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "upstream-test-model" },
    execute: async (request) => {
      request.signal?.addEventListener("abort", () => resolveAbort?.(), {
        once: true,
      });
      return {
        kind: "stream",
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-test","model":"ai-tidu9-config","choices":[{"delta":{"content":"hello"}}]}\n\n',
              ),
            );
          },
        }),
      };
    },
  };
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
    provider,
  });
  const clientController = new AbortController();

  try {
    const response = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        metadata: { ai_tidu9_probe: true },
        stream: true,
      }),
      signal: clientController.signal,
    });
    const reader = response.body?.getReader();
    await reader?.read();
    clientController.abort();
    let cancellationTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        abortObserved,
        new Promise<never>((_resolve, reject) => {
          cancellationTimeout = setTimeout(
            () => reject(new Error("Provider cancellation was not observed.")),
            1_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(cancellationTimeout);
    }
  } finally {
    clientController.abort();
    await runtime.close();
  }
});

test("keeps mode drafts isolated until a valid draft is explicitly activated", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    port: 0,
  });

  try {
    const initialResponse = await fetch(`${runtime.origin}/api/config-center`);
    const initial = (await initialResponse.json()) as ConfigCenterBootstrap;
    const expertRevision = initial.configuration.workspace.drafts.expert.revision;

    const invalidResponse = await fetch(`${runtime.origin}/api/configuration/drafts/expert`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: expertRevision,
        configuration: {
          schemaVersion: CONFIG_SCHEMA_VERSION,
          activeMode: "expert",
          activeProfileId: "INVALID PROFILE",
          virtualModelName: "",
        },
      }),
    });
    assert.equal(invalidResponse.status, 422);

    const saveResponse = await fetch(`${runtime.origin}/api/configuration/drafts/expert`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: expertRevision,
        configuration: {
          schemaVersion: CONFIG_SCHEMA_VERSION,
          activeMode: "expert",
          activeProfileId: "expert-local",
          virtualModelName: "本地专家入口",
          expertServices:
            initial.configuration.workspace.drafts.expert.configuration.expertServices,
        },
      }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = (await saveResponse.json()) as ConfigCenterBootstrap;
    assert.equal(saved.configuration.workspace.active.configuration.activeMode, "managed");
    assert.equal(
      saved.configuration.workspace.drafts.expert.configuration.virtualModelName,
      "本地专家入口",
    );

    const activateResponse = await fetch(
      `${runtime.origin}/api/configuration/drafts/expert/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedDraftRevision: saved.configuration.workspace.drafts.expert.revision,
        }),
      },
    );
    assert.equal(activateResponse.status, 200);
    const activated = (await activateResponse.json()) as ConfigCenterBootstrap;
    assert.equal(activated.configuration.workspace.active.configuration.activeMode, "expert");
    assert.equal(
      activated.configuration.workspace.active.configuration.virtualModelName,
      "本地专家入口",
    );
  } finally {
    await runtime.close();
  }
});

test("exposes the active virtual model through OpenAI-compatible discovery", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const modelsResponse = await fetch(`${runtime.origin}/v1/models`);
    assert.equal(modelsResponse.status, 200);
    assert.equal(modelsResponse.headers.get("x-ai-tidu9"), "true");
    assert.notEqual(modelsResponse.headers.get("x-request-id"), null);
    const models = (await modelsResponse.json()) as {
      object: string;
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        created: number;
      }>;
    };
    assert.equal(models.object, "list");
    assert.equal(models.data.length, 1);
    assert.equal(models.data[0]?.id, "ai-tidu9-config");
    assert.equal(models.data[0]?.object, "model");
    assert.equal(models.data[0]?.owned_by, "AI-Tidu9");
    assert.equal(Number.isInteger(models.data[0]?.created), true);
  } finally {
    await runtime.close();
  }
});

test("publishes company models only through the upstream-selection API", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
    provider: {
      descriptor: { type: "openai-compatible", model: "company-model/v2" },
      listModels: async () => [
        { id: "company-model/v2", name: "Company Model V2" },
        { id: "company-model/v3", name: "Company Model V3" },
      ],
      execute: async () => ({ kind: "json", statusCode: 200, body: { output: [] } }),
    },
  });

  try {
    const response = await fetch(`${runtime.origin}/v1/models`);
    const models = (await response.json()) as {
      data: Array<{ id: string; display_name: string; owned_by: string }>;
    };
    assert.deepEqual(
      models.data.map(({ id }) => id),
      ["ai-tidu9-config"],
    );
    assert.equal((await fetch(`${runtime.origin}/v1/models/company-company-model-v2`)).status, 404);
    const upstreams = (await (await fetch(`${runtime.origin}/api/models/upstreams`)).json()) as {
      companyConfigured: boolean;
      companyProviderType: string | null;
      company: Array<{ id: string; name: string }>;
    };
    assert.equal(upstreams.companyConfigured, true);
    assert.equal(upstreams.companyProviderType, "openai-compatible");
    assert.deepEqual(upstreams.company, [
      { id: "company-model/v2", name: "Company Model V2" },
      { id: "company-model/v3", name: "Company Model V3" },
    ]);
    const providerDetection = await fetch(`${runtime.origin}/api/provider/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai-compatible" }),
    });
    assert.equal(providerDetection.status, 200);
    assert.deepEqual(await providerDetection.json(), {
      detected: true,
      matchesRuntime: true,
      model: "company-model/v2",
      provider: "openai-compatible",
      account: null,
      reason: null,
    });
  } finally {
    await runtime.close();
  }
});

test("validates OpenAI-compatible inference requests before provider routing", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    discoverHostProvider: false,
    port: 0,
  });

  try {
    const missingModelResponse = await fetch(`${runtime.origin}/v1/models/unknown-model`);
    assert.equal(missingModelResponse.status, 404);
    assert.equal(
      ((await missingModelResponse.json()) as { error: { code: string } }).error.code,
      "model_not_found",
    );

    const invalidResponse = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ai-tidu9-config", messages: [] }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal(
      ((await invalidResponse.json()) as { error: { code: string } }).error.code,
      "invalid_messages",
    );

    const chatResponse = await fetch(`${runtime.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        messages: [{ role: "user", content: "hello" }],
        metadata: { ai_tidu9_probe: true },
      }),
    });
    assert.equal(chatResponse.status, 503);
    assert.equal(chatResponse.headers.get("x-ai-tidu9"), "true");
    const chatFailure = (await chatResponse.json()) as {
      error: { code: string; failure_source: string; next_steps: string[] };
    };
    assert.equal(chatFailure.error.code, "model_provider_not_configured");
    assert.equal(chatFailure.error.failure_source, "ai-tidu9");
    assert.equal(chatFailure.error.next_steps.length, 3);

    const responsesResponse = await fetch(`${runtime.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        input: "hello",
        metadata: { ai_tidu9_probe: true },
      }),
    });
    assert.equal(responsesResponse.status, 503);
    const responseFailure = (await responsesResponse.json()) as {
      error: { code: string; failure_source: string; next_steps: string[] };
    };
    assert.equal(responseFailure.error.code, "model_provider_not_configured");
    assert.equal(responseFailure.error.failure_source, "ai-tidu9");
    assert.equal(responseFailure.error.next_steps.length, 3);
  } finally {
    await runtime.close();
  }
});

test("does not expose undefined routes", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/unknown`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
  } finally {
    await runtime.close();
  }
});

test("exposes an enterprise pilot and one-time administrator key lifecycle", async () => {
  const enterpriseControlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(),
  );
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    enterpriseControlPlane,
    port: 0,
  });

  try {
    const bootstrap = (await (
      await fetch(`${runtime.origin}/api/config-center`)
    ).json()) as ConfigCenterBootstrap;
    assert.equal(bootstrap.enterprise.enabled, true);
    assert.equal(bootstrap.enterprise.administratorInitialized, false);

    const initializeResponse = await fetch(`${runtime.origin}/api/enterprise/admin/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(initializeResponse.status, 201);
    const initialized = (await initializeResponse.json()) as { key: string };
    assert.match(initialized.key, /^tidu_admin_/u);

    const repeatedResponse = await fetch(`${runtime.origin}/api/enterprise/admin/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(repeatedResponse.status, 409);

    const sessionResponse = await fetch(`${runtime.origin}/api/enterprise/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: initialized.key }),
    });
    assert.equal(sessionResponse.status, 201);
    assert.equal(typeof ((await sessionResponse.json()) as { id: string }).id, "string");
  } finally {
    await runtime.close();
  }
});

test("exposes stateless scaling admission and production health summaries", async () => {
  const scalingControlPlane = createScalingControlPlane();
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    scalingControlPlane,
    port: 0,
  });

  try {
    const createResponse = await fetch(`${runtime.origin}/api/scaling/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "runtime-scaling-task",
        tenantId: "tenant-runtime",
        resourceGroup: "general",
        priority: 50,
        maxAttempts: 3,
        memoryBytes: 1024,
        scratchBytes: 2048,
        payloadBytes: 128,
        payloadReference: "private://tenant-runtime/runtime-scaling-task",
      }),
    });
    assert.equal(createResponse.status, 202);

    const scalingResponse = await fetch(`${runtime.origin}/api/scaling`);
    assert.equal(scalingResponse.status, 200);
    const scaling = (await scalingResponse.json()) as {
      health: { queuedTaskCount: number };
      metrics: { counters: Record<string, number> };
    };
    assert.equal(scaling.health.queuedTaskCount, 1);
    assert.equal(scaling.metrics.counters["tasks.accepted"], 1);

    const healthResponse = await fetch(`${runtime.origin}/health`);
    assert.equal(healthResponse.status, 503);
    const health = (await healthResponse.json()) as {
      scaling: { status: string };
    };
    assert.equal(health.scaling.status, "unavailable");
  } finally {
    await runtime.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_SCHEMA_VERSION } from "../config/index.js";
import type { ConfigCenterBootstrap } from "../config-center/index.js";
import { PRODUCT } from "../core/index.js";
import type { ModelProvider } from "../providers/index.js";
import { IN_MEMORY_DATABASE_PATH, STORAGE_SCHEMA_VERSION } from "../storage/index.js";
import { startLocalRuntime } from "./index.js";

test("starts a loopback runtime with a verifiable health endpoint", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      product: PRODUCT.name,
      status: "ok",
      storage: {
        provider: "sqlite",
        schemaVersion: STORAGE_SCHEMA_VERSION,
        status: "ok",
      },
      version: PRODUCT.version,
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
  const requests: Array<{ protocol: string; model: unknown; virtualModelId: string }> = [];
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
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(chatResponse.status, 200);
    assert.equal(chatResponse.headers.get("x-ai-tidu9"), "true");
    assert.equal(((await chatResponse.json()) as { model: string }).model, "managed-default");

    const responsesResponse = await fetch(`${runtime.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "managed-default", input: "hello" }),
    });
    assert.equal(responsesResponse.status, 200);
    assert.equal(((await responsesResponse.json()) as { model: string }).model, "managed-default");
    assert.deepEqual(requests, [
      {
        protocol: "chat-completions",
        model: "managed-default",
        virtualModelId: "managed-default",
      },
      {
        protocol: "responses",
        model: "managed-default",
        virtualModelId: "managed-default",
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
                'data: {"id":"chatcmpl-test","model":"managed-default","choices":[{"delta":{"content":"hello"}}]}\n\n',
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
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
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
      request.signal?.addEventListener("abort", () => resolveAbort?.(), { once: true });
      return {
        kind: "stream",
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-test","model":"managed-default","choices":[{"delta":{"content":"hello"}}]}\n\n',
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
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
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
      data: Array<{ id: string; object: string; owned_by: string; created: number }>;
    };
    assert.equal(models.object, "list");
    assert.equal(models.data.length, 1);
    assert.equal(models.data[0]?.id, "managed-default");
    assert.equal(models.data[0]?.object, "model");
    assert.equal(models.data[0]?.owned_by, "AI-Tidu9");
    assert.equal(Number.isInteger(models.data[0]?.created), true);
  } finally {
    await runtime.close();
  }
});

test("validates OpenAI-compatible inference requests before provider routing", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
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
      body: JSON.stringify({ model: "managed-default", messages: [] }),
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
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(chatResponse.status, 503);
    assert.equal(chatResponse.headers.get("x-ai-tidu9"), "true");
    assert.equal(
      ((await chatResponse.json()) as { error: { code: string } }).error.code,
      "model_provider_not_configured",
    );

    const responsesResponse = await fetch(`${runtime.origin}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "managed-default", input: "hello" }),
    });
    assert.equal(responsesResponse.status, 503);
    assert.equal(
      ((await responsesResponse.json()) as { error: { code: string } }).error.code,
      "model_provider_not_configured",
    );
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

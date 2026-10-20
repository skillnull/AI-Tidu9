import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProvider, ProviderExecutionRequest } from "../providers/index.js";
import {
  createCapabilityCompletionProvider,
  createDynamicModelRouter,
  type DynamicRoutingPolicy,
  inferModelRequestCapabilities,
  type ModelRouteProfile,
  type RoutableModel,
} from "./index.js";

const waitForMilliseconds = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const streamEncoder = new TextEncoder();

const encodeSseData = (body: unknown): Uint8Array =>
  streamEncoder.encode(`data: ${JSON.stringify(body)}\n\n`);

const consumeStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return chunks;
    chunks.push(chunk.value);
  }
};

test("infers structured output from the Responses text format", () => {
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: "return one object",
        text: {
          format: {
            type: "json_schema",
            name: "result",
            schema: { type: "object" },
          },
        },
      },
    }),
    ["structured-output", "text"],
  );
});

test("infers web research and code only from declared tool structure", () => {
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: "Use the available tools.",
        tools: [
          { type: "web_search" },
          { type: "function", name: "apply_patch" },
          { type: "function", function: { name: "exec_command" } },
        ],
      },
    }),
    ["code", "text", "tool-use", "web-research"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "Please use apply_patch, shell, and web search." },
    }),
    ["text"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: "Do not use tools.",
        tools: [{ type: "web_search" }, { type: "function", name: "apply_patch" }],
        tool_choice: "none",
      },
    }),
    ["text"],
  );
});

test("infers long context only when textual input reaches 100000 characters", () => {
  const inferForInput = (input: string): readonly string[] =>
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input },
    });

  assert.deepEqual(inferForInput("x".repeat(99_999)), ["text"]);
  assert.deepEqual(inferForInput("x".repeat(100_000)), ["long-context", "text"]);
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: `data:image/png;base64,${"x".repeat(100_000)}`,
              },
            ],
          },
        ],
      },
    }),
    ["text", "vision"],
  );
});

test("records primary and secondary results for the shared Agent policy", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "main-model" },
    execute: async (request) => {
      calls.push(request.routing?.targetModel ?? "current");
      return {
        kind: "json",
        statusCode: 200,
        body:
          request.routing?.role === "specialist"
            ? {
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "visual evidence" }],
                  },
                ],
              }
            : { choices: [{ message: { content: "combined answer" } }] },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text", "structured-output"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "vision-model[context=300k,effort=high]",
          capabilities: ["vision"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  await completion.execute({
    protocol: "chat-completions",
    virtualModelId: "ai-tidu9-config",
    body: { messages: [{ role: "user", content: "inspect image" }] },
    routing: { requiredCapabilities: ["vision"], role: "worker" },
  });

  assert.deepEqual(calls, ["vision-model[context=300k,effort=high]", "main-model"]);
  const status = await completion.inspectCapabilityCompletion();
  assert.equal(status.records[0]?.complemented, true);
  assert.deepEqual(status.records[0]?.specialistModelIds, ["specialist-0:cursor:official"]);
  assert.equal(status.records[0]?.outcome, "succeeded");
  assert.deepEqual(status.records[0]?.mainResult, {
    modelId: "main:openai-compatible:official",
    host: "openai-compatible",
    model: "main-model",
    role: "main",
    capabilities: ["text"],
    outcome: "succeeded",
    statusCode: 200,
    durationMilliseconds: status.records[0]?.mainResult.durationMilliseconds,
    message: "",
  });
  assert.deepEqual(status.records[0]?.secondaryResults[0], {
    modelId: "specialist-0:cursor:official",
    host: "cursor",
    model: "vision-model[context=300k,effort=high]",
    role: "secondary",
    capabilities: ["vision"],
    outcome: "succeeded",
    statusCode: 200,
    durationMilliseconds: status.records[0]?.secondaryResults[0]?.durationMilliseconds,
    message: "",
  });
});

test("isolates primary and specialist models by request host", async () => {
  const calls: string[] = [];
  const createHostProvider = (host: "codex" | "cursor"): ModelProvider => ({
    descriptor: {
      type: host === "codex" ? "codex-host" : "cursor-host",
      model: "default",
    },
    execute: async (request) => {
      calls.push(`${host}:${request.routing?.targetModel ?? "current"}`);
      return {
        kind: "json",
        statusCode: 200,
        body: { choices: [{ message: { content: "{}" } }] },
      };
    },
  });
  const providers = {
    codex: createHostProvider("codex"),
    cursor: createHostProvider("cursor"),
  };
  const completion = createCapabilityCompletionProvider(
    providers.codex,
    async () => ({
      modelSelection: { source: "official", model: "default-main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        specialists: [],
        maximumSpecialists: 1,
        hostPolicies: {
          codex: {
            mainModel: { source: "official", model: "codex-main" },
            mainCapabilities: ["text"],
            specialists: [
              {
                host: "cursor",
                source: "official",
                model: "cursor-vision",
                capabilities: ["vision"],
              },
            ],
            maximumSpecialists: 1,
          },
          cursor: {
            mainModel: { source: "official", model: "cursor-main" },
            mainCapabilities: ["text"],
            specialists: [
              {
                host: "codex",
                source: "official",
                model: "codex-vision",
                capabilities: ["vision"],
              },
            ],
            maximumSpecialists: 1,
          },
        },
      },
    }),
    {
      resolveProviderForHost: async (host) =>
        host === "codex" || host === "cursor" ? providers[host] : undefined,
    },
  );

  await completion.execute({
    protocol: "chat-completions",
    virtualModelId: "ai-tidu9-config",
    body: { messages: [{ role: "user", content: "inspect image" }] },
    routing: {
      host: "cursor",
      requiredCapabilities: ["vision"],
      role: "worker",
    },
  });

  assert.deepEqual(calls, ["codex:codex-vision", "cursor:cursor-main"]);
});

test("does not infer a private boundary from a company model source", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "default" },
    execute: async (request) => {
      calls.push(`${request.routing?.host}:${request.routing?.targetModel}`);
      return { kind: "json", statusCode: 200, body: { output_text: "ok" } };
    },
  };
  const completion = createCapabilityCompletionProvider(
    provider,
    async () => ({
      modelSelection: { source: "official", model: "main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        specialists: [],
        maximumSpecialists: 1,
        hostPolicies: {
          codex: {
            mainModel: { source: "official", model: "main" },
            mainCapabilities: ["text"],
            specialists: [
              {
                host: "cursor",
                source: "company",
                model: "company-model",
                capabilities: ["text"],
              },
            ],
            maximumSpecialists: 1,
          },
        },
      },
    }),
    { resolveProviderForHost: async () => provider },
  );

  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "hello" },
    routing: { host: "codex" },
  });

  assert.deepEqual(calls, ["codex:main"]);
  assert.equal(
    (await completion.inspectCapabilityCompletion()).records[0]?.reason,
    "main-capability-match",
  );
});

test("uses the Ollama host as a verifiably local privacy boundary", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "default" },
    execute: async (request) => {
      calls.push(`${request.routing?.host}:${request.routing?.targetModel}`);
      return { kind: "json", statusCode: 200, body: { output_text: "ok" } };
    },
  };
  const completion = createCapabilityCompletionProvider(
    provider,
    async () => ({
      modelSelection: { source: "official", model: "main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        specialists: [],
        maximumSpecialists: 1,
        hostPolicies: {
          codex: {
            mainModel: { source: "official", model: "main" },
            mainCapabilities: ["text"],
            specialists: [
              {
                host: "ollama",
                source: "custom",
                model: "local-model",
                capabilities: ["text"],
              },
            ],
            maximumSpecialists: 1,
          },
        },
      },
    }),
    { resolveProviderForHost: async () => provider },
  );

  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "hello" },
    routing: { host: "codex" },
  });

  assert.deepEqual(calls, ["ollama:local-model"]);
  assert.equal(
    (await completion.inspectCapabilityCompletion()).records[0]?.reason,
    "tighter-privacy",
  );
});

test("records streaming latency only after the stream completes", async () => {
  const calls: string[] = [];
  const mainControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "default" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "main";
      calls.push(targetModel);
      if (targetModel === "secondary") {
        await waitForMilliseconds(10);
        return {
          kind: "json",
          statusCode: 200,
          body: { output_text: "secondary" },
        };
      }
      return {
        kind: "stream",
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start: (controller) => mainControllers.push(controller),
        }),
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary",
          capabilities: ["text"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  const firstResult = await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "first" },
    routing: { requireSpecialist: true },
  });
  const secondResult = await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "second" },
  });
  assert.deepEqual(calls, ["secondary", "main", "main"]);
  assert.equal((await completion.inspectCapabilityCompletion()).records.length, 0);

  await waitForMilliseconds(25);
  mainControllers[0]?.enqueue(
    encodeSseData({
      type: "response.output_text.delta",
      delta: "completed output",
    }),
  );
  mainControllers[0]?.enqueue(
    encodeSseData({
      type: "response.completed",
      response: { status: "completed", output_text: "completed output" },
    }),
  );
  mainControllers[0]?.close();
  assert.equal(firstResult.kind, "stream");
  if (firstResult.kind === "stream") {
    await consumeStream(firstResult.stream);
  }
  const completedStatus = await completion.inspectCapabilityCompletion();
  assert.equal(completedStatus.records.length, 1);
  assert.equal(completedStatus.records[0]?.outcome, "succeeded");
  assert.equal(completedStatus.records[0]?.mainResult.outcome, "succeeded");

  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "third" },
  });
  assert.deepEqual(calls, ["secondary", "main", "main", "secondary"]);
  if (secondResult.kind === "stream") await secondResult.stream.cancel("test cleanup");
});

test("records failed and cancelled streams as unavailable observations", async () => {
  for (const terminalState of ["failed", "cancelled"] as const) {
    const calls: string[] = [];
    const provider: ModelProvider = {
      descriptor: { type: "openai-compatible", model: "default" },
      execute: async (request) => {
        const targetModel = request.routing?.targetModel ?? "main";
        calls.push(targetModel);
        if (targetModel === "secondary") {
          return {
            kind: "json",
            statusCode: 200,
            body: { output_text: "secondary" },
          };
        }
        return {
          kind: "stream",
          statusCode: 200,
          stream: new ReadableStream<Uint8Array>({
            pull: (controller) => {
              if (terminalState === "failed") controller.error(new Error("stream failed"));
            },
          }),
        };
      },
    };
    const completion = createCapabilityCompletionProvider(provider, async () => ({
      modelSelection: { source: "official", model: "main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        specialists: [
          {
            host: "cursor",
            source: "official",
            model: "secondary",
            capabilities: ["text"],
          },
        ],
        maximumSpecialists: 1,
      },
    }));

    const firstResult = await completion.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: terminalState },
      routing: { requireSpecialist: true },
    });
    assert.equal(firstResult.kind, "stream");
    if (firstResult.kind === "stream") {
      if (terminalState === "failed") {
        await assert.rejects(firstResult.stream.getReader().read(), /stream failed/u);
      } else {
        await firstResult.stream.cancel("client cancelled");
      }
    }
    const failedStatus = await completion.inspectCapabilityCompletion();
    assert.equal(failedStatus.records[0]?.outcome, "failed");
    assert.equal(failedStatus.records[0]?.mainResult.outcome, "failed");

    await completion.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "retry" },
    });
    assert.deepEqual(calls, ["secondary", "main", "secondary"]);
  }
});

test("does not reuse performance observations after a configured model changes", async () => {
  const calls: string[] = [];
  let secondaryModel = "secondary-a";
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "default" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "main";
      calls.push(targetModel);
      if (targetModel === "main") await waitForMilliseconds(20);
      return {
        kind: "json",
        statusCode: 200,
        body: { output_text: targetModel },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: secondaryModel,
          capabilities: ["text"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "first" },
    routing: { requireSpecialist: true },
  });
  assert.deepEqual(calls, ["secondary-a", "main"]);

  secondaryModel = "secondary-b";
  calls.length = 0;
  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "second" },
  });
  assert.deepEqual(calls, ["main"]);
});

test("does not treat lower token use as lower cost when prices are unknown", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "main-model" },
    execute: async (request) => {
      const model = request.routing?.targetModel ?? "main-model";
      calls.push(model);
      const specialist = model === "vision-model";
      return {
        kind: "json",
        statusCode: 200,
        body: {
          choices: [{ message: { content: specialist ? "visual evidence" : "answer" } }],
          usage: {
            prompt_tokens: specialist ? 12 : 80,
            completion_tokens: specialist ? 8 : 20,
            total_tokens: specialist ? 20 : 100,
          },
        },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text", "structured-output"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "vision-model",
          capabilities: ["text", "structured-output", "vision"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  await completion.execute({
    protocol: "chat-completions",
    virtualModelId: "ai-tidu9-config",
    body: { messages: [{ role: "user", content: "inspect image" }] },
    routing: { requiredCapabilities: ["vision"], role: "worker" },
  });
  calls.length = 0;
  await completion.execute({
    protocol: "chat-completions",
    virtualModelId: "ai-tidu9-config",
    body: {
      messages: [{ role: "user", content: "return json" }],
      response_format: { type: "json_object" },
    },
    routing: { role: "worker" },
  });

  assert.deepEqual(calls, ["main-model"]);
  const status = await completion.inspectCapabilityCompletion();
  assert.equal(status.records[0]?.reason, "main-capability-match");
  assert.equal(status.records[0]?.mainResult.outcome, "succeeded");
  assert.deepEqual(status.records[0]?.tokenUsage, {
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
  });
});

const policy: DynamicRoutingPolicy = {
  enabled: true,
  mainModelId: "cheap-main",
  weights: { capability: 5, cost: 3, privacy: 2, latency: 1, availability: 2 },
  capabilityCompletion: {
    enabled: true,
    poolModelIds: ["vision-specialist"],
    maximumSpecialists: 2,
  },
};

const profile = (
  overrides: Partial<ModelRouteProfile> & Pick<ModelRouteProfile, "id">,
): ModelRouteProfile => ({
  id: overrides.id,
  capabilities: overrides.capabilities ?? ["text", "structured-output"],
  inputCostPerMillionTokens: overrides.inputCostPerMillionTokens ?? 0.1,
  outputCostPerMillionTokens: overrides.outputCostPerMillionTokens ?? 0.2,
  averageInputTokensByCapability: overrides.averageInputTokensByCapability,
  averageOutputTokensByCapability: overrides.averageOutputTokensByCapability,
  averageLatencyMilliseconds: overrides.averageLatencyMilliseconds ?? 100,
  performanceSamples: overrides.performanceSamples,
  availability: overrides.availability ?? 1,
  privacy: overrides.privacy ?? "external",
  remainingRequests: overrides.remainingRequests ?? null,
  enabled: overrides.enabled ?? true,
});

const jsonProvider = (
  model: string,
  execute: (request: ProviderExecutionRequest) => Promise<{ statusCode: number; body: unknown }>,
): ModelProvider => ({
  descriptor: { type: "openai-compatible", model },
  execute: async (request) => ({ kind: "json", ...(await execute(request)) }),
});

test("records a routed stream only after live output reaches a successful terminal", async () => {
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "streaming" },
    execute: async () => ({
      kind: "stream",
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start: (controller) => {
          upstreamController = controller;
        },
      }),
    }),
  };
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider,
      },
    ],
    policy,
  );

  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "stream" },
  });
  assert.equal(result.kind, "stream");
  assert.deepEqual(router.inspectAttempts(), []);
  const outputChunk = encodeSseData({
    type: "response.output_text.delta",
    delta: "hello",
  });
  const terminalChunk = encodeSseData({
    type: "response.completed",
    response: { status: "completed", output_text: "hello" },
  });
  upstreamController?.enqueue(outputChunk);
  upstreamController?.enqueue(terminalChunk);
  upstreamController?.close();
  if (result.kind !== "stream") return;
  const forwardedChunks = await consumeStream(result.stream);

  assert.equal(
    new TextDecoder().decode(Buffer.concat(forwardedChunks)),
    new TextDecoder().decode(Buffer.concat([outputChunk, terminalChunk])),
  );
  assert.deepEqual(router.inspectAttempts(), [
    {
      modelId: "cheap-main",
      role: "main",
      outcome: "succeeded",
      statusCode: 200,
      durationMilliseconds: router.inspectAttempts()[0]?.durationMilliseconds,
      message: "",
    },
  ]);
});

test("marks unsuccessful stream terminals, EOF, reader errors, and cancellation as failed", async () => {
  const failureCases = [
    {
      name: "responses failure",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encodeSseData({
                type: "response.failed",
                response: { error: { message: "responses failed" } },
              }),
            );
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /responses failed/u,
    },
    {
      name: "responses incomplete",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encodeSseData({
                type: "response.incomplete",
                response: { incomplete_details: { reason: "token limit" } },
              }),
            );
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /incomplete/u,
    },
    {
      name: "typed error",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(encodeSseData({ type: "error", message: "typed failure" }));
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /typed failure/u,
    },
    {
      name: "completed as failed",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encodeSseData({ type: "response.completed", response: { status: "failed" } }),
            );
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /did not complete successfully/u,
    },
    {
      name: "completed as incomplete",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encodeSseData({ type: "response.completed", response: { status: "incomplete" } }),
            );
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /did not complete successfully/u,
    },
    {
      name: "chat error",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(encodeSseData({ error: { message: "chat failed" } }));
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /chat failed/u,
    },
    {
      name: "empty close",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.close(),
        }),
      consume: consumeStream,
      message: /without assistant output/u,
    },
    {
      name: "partial output then EOF",
      stream: () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encodeSseData({ type: "response.output_text.delta", delta: "partial" }),
            );
            controller.close();
          },
        }),
      consume: consumeStream,
      message: /without a successful terminal/u,
    },
    {
      name: "reader error",
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.error(new Error("reader failed")),
        }),
      consume: async (stream: ReadableStream<Uint8Array>) => {
        await assert.rejects(consumeStream(stream), /reader failed/u);
        return [];
      },
      message: /reader failed/u,
    },
    {
      name: "cancelled",
      stream: () => new ReadableStream<Uint8Array>(),
      consume: async (stream: ReadableStream<Uint8Array>) => {
        await stream.cancel("client cancelled");
        return [];
      },
      message: /cancelled/u,
    },
  ] as const;

  for (const failureCase of failureCases) {
    const router = createDynamicModelRouter(
      [
        {
          profile: profile({ id: "cheap-main", capabilities: ["text"] }),
          provider: {
            descriptor: { type: "openai-compatible", model: failureCase.name },
            execute: async () => ({
              kind: "stream",
              statusCode: 200,
              stream: failureCase.stream(),
            }),
          },
        },
      ],
      policy,
    );
    const result = await router.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: failureCase.name },
    });
    assert.equal(result.kind, "stream");
    if (result.kind === "stream") await failureCase.consume(result.stream);
    assert.equal(router.inspectAttempts()[0]?.outcome, "failed");
    assert.match(router.inspectAttempts()[0]?.message ?? "", failureCase.message);
  }
});

test("aborting a routed stream cancels upstream without trying a fallback", async () => {
  const calls: string[] = [];
  let upstreamCancelled = false;
  const abortController = new AbortController();
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider: {
          descriptor: { type: "openai-compatible", model: "main" },
          execute: async () => {
            calls.push("cheap-main");
            return {
              kind: "stream",
              statusCode: 200,
              stream: new ReadableStream<Uint8Array>({
                cancel: () => {
                  upstreamCancelled = true;
                },
              }),
            };
          },
        },
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
        provider: jsonProvider("fallback", async () => {
          calls.push("vision-specialist");
          return { statusCode: 200, body: { output_text: "fallback" } };
        }),
      },
    ],
    policy,
  );
  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "wait" },
    signal: abortController.signal,
  });
  assert.equal(result.kind, "stream");

  abortController.abort(new DOMException("client aborted", "AbortError"));
  if (result.kind === "stream") {
    await assert.rejects(consumeStream(result.stream), /client aborted/u);
  }

  assert.equal(upstreamCancelled, true);
  assert.deepEqual(calls, ["cheap-main"]);
  assert.equal(router.inspectAttempts().length, 1);
  assert.equal(router.inspectAttempts()[0]?.outcome, "failed");
  assert.match(router.inspectAttempts()[0]?.message ?? "", /aborted/u);
});

test("does not try a fallback after a provider throws AbortError", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider: {
          descriptor: { type: "openai-compatible", model: "main" },
          execute: async () => {
            calls.push("cheap-main");
            throw new DOMException("provider cancelled", "AbortError");
          },
        },
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
        provider: jsonProvider("fallback", async () => {
          calls.push("vision-specialist");
          return { statusCode: 200, body: { output_text: "fallback" } };
        }),
      },
    ],
    policy,
  );

  await assert.rejects(
    router.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "cancel" },
    }),
    /provider cancelled/u,
  );

  assert.deepEqual(calls, ["cheap-main"]);
  assert.equal(router.inspectAttempts()[0]?.outcome, "failed");
});

test("records an aborted routed stream in capability-completion history", async () => {
  const calls: string[] = [];
  let upstreamCancelCount = 0;
  const abortController = new AbortController();
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "default" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "main";
      calls.push(targetModel);
      if (targetModel === "secondary") {
        return {
          kind: "json",
          statusCode: 200,
          body: { output_text: "secondary" },
        };
      }
      return {
        kind: "stream",
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          cancel: () => {
            upstreamCancelCount += 1;
          },
        }),
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary",
          capabilities: ["text"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));
  const result = await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "wait" },
    signal: abortController.signal,
  });
  assert.equal((await completion.inspectCapabilityCompletion()).records.length, 0);

  abortController.abort(new DOMException("client timeout", "AbortError"));
  if (result.kind === "stream") {
    await assert.rejects(consumeStream(result.stream), /client timeout/u);
  }

  const status = await completion.inspectCapabilityCompletion();
  assert.equal(upstreamCancelCount, 1);
  assert.deepEqual(calls, ["main"]);
  assert.equal(status.records.length, 1);
  assert.equal(status.records[0]?.outcome, "failed");
  assert.equal(status.records[0]?.mainResult.outcome, "failed");
  assert.match(status.records[0]?.mainResult.message ?? "", /aborted/u);
});

test("uses an opt-in specialist to complete a cheap main model capability", async () => {
  let mainRequest: ProviderExecutionRequest | undefined;
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main" }),
      provider: jsonProvider("cheap", async (request) => {
        mainRequest = request;
        return {
          statusCode: 200,
          body: { choices: [{ message: { content: "done" } }] },
        };
      }),
    },
    {
      profile: profile({
        id: "vision-specialist",
        capabilities: ["text", "vision"],
      }),
      provider: jsonProvider("vision", async () => ({
        statusCode: 200,
        body: { choices: [{ message: { content: "image contains a chart" } }] },
      })),
    },
  ];
  const router = createDynamicModelRouter(models, policy);
  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "local" } }],
        },
      ],
      response_format: { type: "json_object" },
    },
  });
  assert.deepEqual(router.inspect()?.specialistModelIds, ["vision-specialist"]);
  assert.match(JSON.stringify(mainRequest?.body), /image contains a chart/u);
  assert.ok(Math.abs((router.inspect()?.estimatedCostPerMillionTokens ?? 0) - 0.6) < 0.000001);
});

test("explicitly verifies an overlapping secondary model without requiring a capability gap", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return {
            statusCode: 200,
            body: { choices: [{ message: { content: "combined" } }] },
          };
        }),
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
        provider: jsonProvider("secondary", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 200,
            body: { choices: [{ message: { content: "evidence" } }] },
          };
        }),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: { messages: [{ role: "user", content: "verify both" }] },
    routing: { requireSpecialist: true },
  });

  assert.deepEqual(calls, ["vision-specialist", "cheap-main"]);
  assert.equal(router.inspect()?.reason, "explicit-secondary-test");
});

test("selects a fully capable model with lower observed latency", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          averageLatencyMilliseconds: 600,
          performanceSamples: 5,
        }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return { statusCode: 200, body: {} };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          averageLatencyMilliseconds: 100,
          performanceSamples: 5,
        }),
        provider: jsonProvider("secondary", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 200,
            body: { choices: [{ message: { content: "fast" } }] },
          };
        }),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: { messages: [{ role: "user", content: "fast response" }] },
  });

  assert.deepEqual(calls, ["vision-specialist"]);
  assert.equal(router.inspect()?.reason, "lower-latency");
});

test("infers reasoning capability from the requested reasoning strength", async () => {
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          capabilities: ["text", "reasoning"],
        }),
        provider: jsonProvider("main", async () => ({
          statusCode: 200,
          body: {},
        })),
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
        provider: jsonProvider("secondary", async () => ({
          statusCode: 200,
          body: {},
        })),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "think", reasoning: { effort: "high" } },
  });

  assert.deepEqual(router.inspect()?.requiredCapabilities, ["reasoning", "text"]);
});

test("does not require tool capabilities when the caller disables declared tools", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          capabilities: ["text", "tool-use"],
        }),
        provider: jsonProvider("cheap", async () => {
          calls.push("cheap-main");
          return { statusCode: 200, body: { output_text: "ok" } };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          capabilities: ["text", "vision"],
        }),
        provider: jsonProvider("vision", async () => ({
          statusCode: 200,
          body: { output_text: "visual evidence" },
        })),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      input: "Reply with OK.",
      tools: [{ type: "tool_search" }],
      tool_choice: "none",
    },
  });

  assert.deepEqual(calls, ["cheap-main"]);
  assert.deepEqual(router.inspect()?.requiredCapabilities, ["text"]);
});

test("keeps the main model when fewer observed tokens still cost more", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          inputCostPerMillionTokens: 1,
          outputCostPerMillionTokens: 2,
          averageInputTokensByCapability: { text: 80, "structured-output": 80 },
          averageOutputTokensByCapability: {
            text: 20,
            "structured-output": 20,
          },
        }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return { statusCode: 200, body: {} };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          inputCostPerMillionTokens: 8,
          outputCostPerMillionTokens: 16,
          averageInputTokensByCapability: { text: 12, "structured-output": 12 },
          averageOutputTokensByCapability: { text: 8, "structured-output": 8 },
        }),
        provider: jsonProvider("specialist", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 200,
            body: {
              choices: [{ message: { content: "ok" } }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                total_tokens: 16,
              },
            },
          };
        }),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: {
      messages: [{ role: "user", content: "return structured output" }],
      response_format: { type: "json_object" },
    },
  });

  assert.deepEqual(calls, ["cheap-main"]);
  assert.equal(router.inspect()?.reason, "main-capability-match");
});

test("selects a fully capable specialist when observed usage and known price cost less", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          inputCostPerMillionTokens: 1,
          outputCostPerMillionTokens: 2,
          averageInputTokensByCapability: { text: 80, "structured-output": 80 },
          averageOutputTokensByCapability: {
            text: 20,
            "structured-output": 20,
          },
        }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return { statusCode: 200, body: {} };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 3,
          averageInputTokensByCapability: { text: 12, "structured-output": 12 },
          averageOutputTokensByCapability: { text: 8, "structured-output": 8 },
        }),
        provider: jsonProvider("specialist", async () => {
          calls.push("vision-specialist");
          return { statusCode: 200, body: {} };
        }),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: {
      messages: [{ role: "user", content: "return structured output" }],
      response_format: { type: "json_object" },
    },
  });

  assert.deepEqual(calls, ["vision-specialist"]);
  assert.equal(router.inspect()?.reason, "lower-token-cost");
});

test("does not claim a lower token cost when either price is unknown", async () => {
  for (const unknownCost of [null, Number.MAX_SAFE_INTEGER]) {
    const calls: string[] = [];
    const router = createDynamicModelRouter(
      [
        {
          profile: profile({ id: "cheap-main" }),
          provider: jsonProvider("main", async () => {
            calls.push("cheap-main");
            return { statusCode: 200, body: {} };
          }),
        },
        {
          profile: profile({
            id: "vision-specialist",
            inputCostPerMillionTokens: unknownCost,
            outputCostPerMillionTokens: unknownCost,
          }),
          provider: jsonProvider("specialist", async () => {
            calls.push("vision-specialist");
            return { statusCode: 200, body: {} };
          }),
        },
      ],
      policy,
    );

    await router.execute({
      protocol: "chat-completions",
      virtualModelId: "tidu",
      body: { messages: [{ role: "user", content: "hello" }] },
    });

    assert.deepEqual(calls, ["cheap-main"]);
    assert.equal(router.inspect()?.reason, "main-capability-match");
  }
});

test("tries another capable model after an explicit host bridge capability rejection", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          capabilities: ["text", "vision"],
        }),
        provider: jsonProvider("host-bridge", async () => {
          calls.push("cheap-main");
          return {
            statusCode: 400,
            body: {
              error: {
                code: "host_bridge_image_unsupported",
                message: "The bridge cannot receive images.",
              },
            },
          };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          capabilities: ["text", "vision"],
        }),
        provider: jsonProvider("native-vision", async () => {
          calls.push("vision-specialist");
          return { statusCode: 200, body: { output_text: "image inspected" } };
        }),
      },
    ],
    policy,
  );

  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "local" }],
        },
      ],
    },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["cheap-main", "vision-specialist"]);
  assert.equal(router.inspect()?.mainModelId, "vision-specialist");
  assert.equal(router.inspect()?.reason, "failure-fallback");
  assert.deepEqual(
    router.inspectAttempts().map((attempt) => attempt.outcome),
    ["failed", "succeeded"],
  );
});

test("does not fall back for an ordinary client error", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return {
            statusCode: 400,
            body: { error: { code: "invalid_request", message: "Bad input." } },
          };
        }),
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
        provider: jsonProvider("fallback", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 200,
            body: { output_text: "unexpected fallback" },
          };
        }),
      },
    ],
    policy,
  );

  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "invalid" },
  });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(calls, ["cheap-main"]);
  assert.equal(router.inspectAttempts()[0]?.outcome, "failed");
});

test("falls back after the preferred model reports quota exhaustion", async () => {
  const calls: string[] = [];
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main" }),
      provider: jsonProvider("cheap", async () => {
        calls.push("cheap-main");
        return { statusCode: 429, body: {} };
      }),
    },
    {
      profile: profile({ id: "fallback" }),
      provider: jsonProvider("fallback", async () => {
        calls.push("fallback");
        return {
          statusCode: 200,
          body: { choices: [{ message: { content: "ok" } }] },
        };
      }),
    },
  ];
  const router = createDynamicModelRouter(models, policy);
  const result = await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: { messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["cheap-main", "fallback"]);
  assert.equal(router.inspect()?.mainModelId, "fallback");
  assert.equal(router.inspect()?.reason, "failure-fallback");
});

test("falls back after the preferred model is unavailable", async () => {
  const calls: string[] = [];
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main" }),
      provider: jsonProvider("cheap", async () => {
        calls.push("cheap-main");
        return { statusCode: 503, body: {} };
      }),
    },
    {
      profile: profile({ id: "fallback" }),
      provider: jsonProvider("fallback", async () => {
        calls.push("fallback");
        return {
          statusCode: 200,
          body: { choices: [{ message: { content: "ok" } }] },
        };
      }),
    },
  ];
  const router = createDynamicModelRouter(models, policy);
  const result = await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: { messages: [{ role: "user", content: "hello" }] },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["cheap-main", "fallback"]);
  assert.equal(router.inspect()?.mainModelId, "fallback");
});

test("applies explicit-failure fallback consistently to every supported host type", async () => {
  const hostTypes = ["codex-host", "cursor-host", "ollama", "openai-compatible"] as const;

  for (const hostType of hostTypes) {
    const calls: string[] = [];
    const router = createDynamicModelRouter(
      [
        {
          profile: profile({ id: "cheap-main" }),
          provider: {
            descriptor: { type: hostType, model: "main" },
            execute: async () => {
              calls.push(`${hostType}:main`);
              throw new Error(`${hostType} explicit transport failure`);
            },
          },
        },
        {
          profile: profile({ id: "fallback" }),
          provider: jsonProvider("fallback", async () => {
            calls.push("fallback");
            return {
              statusCode: 200,
              body: { choices: [{ message: { content: "ok" } }] },
            };
          }),
        },
      ],
      policy,
    );

    const result = await router.execute({
      protocol: "chat-completions",
      virtualModelId: "tidu",
      body: { messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls, [`${hostType}:main`, "fallback"]);
    assert.equal(router.inspect()?.reason, "failure-fallback");
  }
});

test("enforces privacy and can select a free local model", async () => {
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main", privacy: "external" }),
      provider: jsonProvider("external", async () => ({
        statusCode: 200,
        body: {},
      })),
    },
    {
      profile: profile({
        id: "local-free",
        privacy: "local",
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      }),
      provider: jsonProvider("local", async () => ({
        statusCode: 200,
        body: {},
      })),
    },
  ];
  const router = createDynamicModelRouter(models, policy);
  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: { messages: [] },
    routing: { privacy: "local" },
  });
  assert.equal(router.inspect()?.mainModelId, "local-free");
  assert.equal(router.inspect()?.estimatedCostPerMillionTokens, 0);
});

test("selects one fully capable fallback when capability completion is disabled", async () => {
  const calls: string[] = [];
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main" }),
      provider: jsonProvider("cheap", async () => {
        calls.push("cheap-main");
        return { statusCode: 200, body: {} };
      }),
    },
    {
      profile: profile({
        id: "full-model",
        capabilities: ["text", "structured-output", "vision"],
      }),
      provider: jsonProvider("full", async () => {
        calls.push("full-model");
        return { statusCode: 200, body: {} };
      }),
    },
  ];
  const router = createDynamicModelRouter(models, {
    ...policy,
    capabilityCompletion: { ...policy.capabilityCompletion, enabled: false },
  });
  await router.execute({
    protocol: "chat-completions",
    virtualModelId: "tidu",
    body: {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "local" } }],
        },
      ],
      response_format: { type: "json_object" },
    },
  });
  assert.deepEqual(calls, ["full-model"]);
  assert.deepEqual(router.inspect()?.specialistModelIds, []);
});

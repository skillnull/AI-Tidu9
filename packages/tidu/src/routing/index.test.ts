import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_ROUTING_CAPABILITIES } from "../config/index.js";
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

test("treats auto tools as optional and infers capabilities only from required execution", () => {
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
    ["text"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: "Search the web.",
        tools: [{ type: "web_search" }],
        tool_choice: "required",
      },
    }),
    ["text", "tool-use", "web-research"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        input: "Apply the patch.",
        tools: [{ type: "function", name: "apply_patch" }],
        tool_choice: { type: "function", name: "apply_patch" },
      },
    }),
    ["code", "text", "tool-use"],
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

test("infers workspace and web capabilities from explicit user actions only", () => {
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "查看本地 SKILL 文件并检查内容。" },
    }),
    ["code", "text"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: {
        instructions: "Inspect repository files when needed.",
        input: [{ role: "user", content: "Explain dependency injection." }],
      },
    }),
    ["text"],
  );
  assert.deepEqual(
    inferModelRequestCapabilities({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "请联网搜索官方网站的最新说明。" },
    }),
    ["text", "web-research"],
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
  const progress: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "main-model" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "current";
      calls.push(targetModel);
      request.onModelConfirmed?.(targetModel);
      return {
        kind: "json",
        statusCode: 200,
        upstreamModel: request.routing?.targetModel ?? "main-model",
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
    onProcessDelta: (delta) => progress.push(delta),
  });

  assert.deepEqual(calls, ["vision-model[context=300k,effort=high]", "main-model"]);
  assert.deepEqual(progress, []);
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
    executedModel: "main-model",
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
    executedModel: "vision-model[context=300k,effort=high]",
    statusCode: 200,
    durationMilliseconds: status.records[0]?.secondaryResults[0]?.durationMilliseconds,
    message: "",
  });
});

test("executes only the secondary model when the primary has zero assigned capabilities", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: "primary-model" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "primary-model";
      calls.push(`${request.routing?.host ?? "unknown"}:${targetModel}`);
      request.onModelConfirmed?.(targetModel);
      return {
        kind: "json",
        statusCode: 200,
        upstreamModel: targetModel,
        body: { output_text: "completed" },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "primary-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: [],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary-model",
          capabilities: [...MODEL_ROUTING_CAPABILITIES],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  const result = await completion.execute({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: { input: "complete the request" },
    routing: {
      host: "codex",
      requiredCapabilities: [...MODEL_ROUTING_CAPABILITIES],
    },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["cursor:secondary-model"]);
  const record = (await completion.inspectCapabilityCompletion()).records[0];
  assert.equal(record?.outcome, "succeeded");
  assert.equal(record?.complemented, true);
  assert.equal(record?.mainResult.outcome, "not-run");
  assert.equal(record?.mainResult.executedModel, null);
  assert.equal(record?.secondaryResults[0]?.outcome, "succeeded");
  assert.equal(record?.secondaryResults[0]?.executedModel, "secondary-model");
});

test("splits Chinese text and non-text capabilities across the assigned specialist and primary", async () => {
  const calls: string[] = [];
  const process: string[] = [];
  let cursorRequest: ProviderExecutionRequest | undefined;
  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: "primary-model" },
    execute: async (request) => {
      const targetModel = request.routing?.targetModel ?? "primary-model";
      calls.push(`${request.routing?.host ?? "unknown"}:${targetModel}`);
      if (targetModel === "primary-model") {
        request.onProcessDelta?.("Codex 已完成视觉检查。\n");
      } else {
        cursorRequest = request;
        request.onProcessDelta?.("Cursor 正在汇总共享结果。\n");
      }
      return {
        kind: "json",
        statusCode: 200,
        upstreamModel: targetModel,
        body: {
          output_text:
            targetModel === "primary-model" ? "Codex 视觉检查结果" : "由 Cursor 汇总回答",
        },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "primary-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["vision"],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary-model",
          capabilities: ["text"],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  const result = await completion.execute({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: { input: "九门远程部署创建数据库的流程是什么" },
    routing: { host: "codex" },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["cursor:secondary-model"]);
  const record = (await completion.inspectCapabilityCompletion()).records[0];
  assert.deepEqual(record?.requiredCapabilities, ["text"]);
  assert.equal(record?.mainResult.outcome, "not-run");
  assert.equal(record?.secondaryResults[0]?.outcome, "succeeded");

  await completion.execute({
    protocol: "responses",
    virtualModelId: "ai-tidu9-config",
    body: { input: "结合图片说明九门远程部署创建数据库的流程" },
    routing: { host: "codex", requiredCapabilities: ["text", "vision"] },
    onProcessDelta: (delta) => process.push(delta),
  });

  assert.deepEqual(calls, [
    "cursor:secondary-model",
    "codex:primary-model",
    "cursor:secondary-model",
  ]);
  const combinedRecord = (await completion.inspectCapabilityCompletion()).records[0];
  assert.deepEqual(combinedRecord?.requiredCapabilities, ["text", "vision"]);
  assert.deepEqual(combinedRecord?.mainResult.capabilities, ["vision"]);
  assert.equal(combinedRecord?.mainResult.outcome, "succeeded");
  assert.deepEqual(combinedRecord?.secondaryResults[0]?.capabilities, ["text"]);
  assert.equal(combinedRecord?.secondaryResults[0]?.outcome, "succeeded");
  assert.deepEqual(process, ["Codex 已完成视觉检查。\n", "Cursor 正在汇总共享结果。\n"]);
  const serializedCursorRequest = JSON.stringify(cursorRequest?.body);
  assert.doesNotMatch(serializedCursorRequest, /Codex 已完成视觉检查/u);
  assert.match(serializedCursorRequest, /Codex 视觉检查结果/u);
});

test("records a fail-closed result when no configured model has any capability", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: "primary-model" },
    execute: async () => {
      calls.push("unexpected");
      return {
        kind: "json",
        statusCode: 200,
        body: { output_text: "unexpected" },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "primary-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: [],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary-model",
          capabilities: [],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  await assert.rejects(
    completion.execute({
      protocol: "responses",
      virtualModelId: "ai-tidu9-config",
      body: { input: "complete the request" },
      routing: { host: "codex" },
    }),
    /No configured model combination covers required capabilities/u,
  );

  assert.deepEqual(calls, []);
  const record = (await completion.inspectCapabilityCompletion()).records[0];
  assert.equal(record?.outcome, "failed");
  assert.deepEqual(record?.missingCapabilities, ["text"]);
  assert.equal(record?.mainResult.outcome, "not-run");
});

test("does not call a zero-capability primary when capability completion is disabled", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: "primary-model" },
    execute: async () => {
      calls.push("unexpected");
      return {
        kind: "json",
        statusCode: 200,
        body: { output_text: "unexpected" },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "primary-model" },
    capabilityCompletion: {
      enabled: false,
      mainCapabilities: [],
      specialists: [
        {
          host: "cursor",
          source: "official",
          model: "secondary-model",
          capabilities: [...MODEL_ROUTING_CAPABILITIES],
        },
      ],
      maximumSpecialists: 1,
    },
  }));

  await assert.rejects(
    completion.execute({
      protocol: "responses",
      virtualModelId: "ai-tidu9-config",
      body: { input: "complete the request" },
      routing: { host: "codex" },
    }),
    /No configured model combination covers required capabilities/u,
  );

  assert.deepEqual(calls, []);
  const record = (await completion.inspectCapabilityCompletion()).records[0];
  assert.equal(record?.outcome, "failed");
  assert.equal(record?.mainResult.outcome, "not-run");
  assert.equal(record?.secondaryResults[0]?.outcome, "not-run");
  assert.match(record?.secondaryResults[0]?.message ?? "", /disabled/u);
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
      response: {
        status: "completed",
        output_text: "completed output",
        usage: { input_tokens: 17, output_tokens: 6, total_tokens: 23 },
      },
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
  assert.deepEqual(completedStatus.records[0]?.tokenUsage, {
    inputTokens: 17,
    outputTokens: 6,
    totalTokens: 23,
  });

  await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "third" },
  });
  assert.deepEqual(calls, ["secondary", "main", "main", "secondary"]);
  if (secondResult.kind === "stream") await secondResult.stream.cancel("test cleanup");
});

test("records failures without penalizing availability for user cancellation", async () => {
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
    assert.equal(failedStatus.records[0]?.outcome, terminalState);
    assert.equal(failedStatus.records[0]?.mainResult.outcome, terminalState);

    await completion.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "retry" },
    });
    assert.deepEqual(calls, [
      "secondary",
      "main",
      terminalState === "cancelled" ? "main" : "secondary",
    ]);
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
  host: overrides.host,
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

test("returns specialist native tool requests before asking the text model for a final answer", async () => {
  const calls: string[] = [];
  const completion = createCapabilityCompletionProvider(
    {
      descriptor: { type: "codex-host", model: "main" },
      execute: async (request) => {
        calls.push(request.routing?.targetModel ?? "main");
        assert.equal(request.routing?.role, "specialist");
        assert.equal(request.body.stream, false);
        return {
          kind: "json",
          statusCode: 200,
          upstreamModel: "code",
          body: {
            output: [
              {
                type: "function_call",
                call_id: "native-read",
                name: "exec_command",
                arguments: '{"cmd":"cat fixture.ts"}',
              },
            ],
            usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          },
        };
      },
    },
    async () => ({
      modelSelection: { source: "official", model: "main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        specialists: [
          { host: "cursor", source: "official", model: "code", capabilities: ["code"] },
        ],
        maximumSpecialists: 1,
      },
    }),
  );
  const result = await completion.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "Read the code file", stream: true },
    routing: { requiredCapabilities: ["code", "text"] },
  });
  assert.deepEqual(calls, ["code"]);
  assert.equal(result.kind, "json");
  if (result.kind === "json") assert.match(JSON.stringify(result.body), /native-read/u);
  const status = await completion.inspectCapabilityCompletion();
  assert.equal(status.records[0]?.outcome, "succeeded");
  assert.equal(status.records[0]?.mainResult.outcome, "not-run");
  assert.equal(status.records[0]?.mainResult.skipReason, "awaiting-tool-results");
  assert.equal(status.records[0]?.secondaryResults[0]?.outcome, "succeeded");
  assert.equal(status.records[0]?.tokenUsage?.totalTokens, 15);
});

test("sends image inputs only to the model assigned vision and shares its result with text", async () => {
  for (const protocol of ["responses", "chat-completions"] as const) {
    for (const visionOwner of ["main", "specialist"] as const) {
      let mainRequest: ProviderExecutionRequest | undefined;
      let specialistRequest: ProviderExecutionRequest | undefined;
      const router = createDynamicModelRouter(
        [
          {
            profile: profile({
              id: "cheap-main",
              capabilities:
                visionOwner === "main"
                  ? ["code", "reasoning", "vision"]
                  : ["text", "code", "reasoning"],
            }),
            provider: jsonProvider("main", async (request) => {
              mainRequest = request;
              return {
                statusCode: 200,
                body: { output_text: "combined answer" },
              };
            }),
          },
          {
            profile: profile({
              id: "vision-specialist",
              capabilities: visionOwner === "specialist" ? ["vision"] : ["text"],
            }),
            provider: jsonProvider("specialist", async (request) => {
              specialistRequest = request;
              return {
                statusCode: 200,
                body: { output_text: "secondary evidence" },
              };
            }),
          },
        ],
        policy,
      );
      const imageMarker = "data:image/png;base64,route-matrix";
      const body =
        protocol === "responses"
          ? {
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: "Inspect the attached image." },
                    { type: "input_image", image_url: imageMarker },
                  ],
                },
              ],
              reasoning: { effort: "high" },
            }
          : {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Inspect the attached image." },
                    { type: "image_url", image_url: { url: imageMarker } },
                  ],
                },
              ],
              reasoning_effort: "high",
            };

      await router.execute({
        protocol,
        virtualModelId: "tidu",
        body,
        routing: { requiredCapabilities: ["code", "reasoning", "vision"] },
      });

      const serializedMainRequest = JSON.stringify(mainRequest?.body);
      const serializedSpecialistRequest = JSON.stringify(specialistRequest?.body);
      if (visionOwner === "main") {
        assert.equal(serializedMainRequest.includes(imageMarker), true);
        assert.equal(serializedSpecialistRequest.includes(imageMarker), false);
        assert.match(serializedSpecialistRequest, /combined answer/u);
      } else {
        assert.equal(serializedMainRequest.includes(imageMarker), false);
        assert.equal(serializedSpecialistRequest.includes(imageMarker), true);
        assert.match(serializedMainRequest, /secondary evidence/u);
      }
    }
  }
});

test("records a routed stream only after live output reaches a successful terminal", async () => {
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "streaming" },
    execute: async () => ({
      kind: "stream",
      statusCode: 200,
      upstreamModel: "streaming",
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
    response: {
      status: "completed",
      output_text: "hello",
      usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
    },
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
      executedModel: "streaming",
      statusCode: 200,
      durationMilliseconds: router.inspectAttempts()[0]?.durationMilliseconds,
      message: "",
    },
  ]);
  assert.deepEqual(router.inspect()?.tokenUsage, {
    inputTokens: 11,
    outputTokens: 4,
    totalTokens: 15,
  });
});

test("distinguishes cancellation from unsuccessful terminals, EOF, and reader errors", async () => {
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
              encodeSseData({
                type: "response.completed",
                response: { status: "failed" },
              }),
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
              encodeSseData({
                type: "response.completed",
                response: { status: "incomplete" },
              }),
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
              encodeSseData({
                type: "response.output_text.delta",
                delta: "partial",
              }),
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
    assert.equal(
      router.inspectAttempts()[0]?.outcome,
      failureCase.name === "cancelled" ? "cancelled" : "failed",
    );
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
  assert.equal(router.inspectAttempts()[0]?.outcome, "cancelled");
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
  assert.equal(router.inspectAttempts()[0]?.outcome, "cancelled");
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
  assert.equal(status.records[0]?.outcome, "cancelled");
  assert.equal(status.records[0]?.mainResult.outcome, "cancelled");
  assert.match(status.records[0]?.mainResult.message ?? "", /aborted/u);
});

test("keeps reported usage when cancellation skips another selected model", async () => {
  const completion = createCapabilityCompletionProvider(
    {
      descriptor: { type: "codex-host", model: "fixture" },
      execute: async (request) => {
        request.onExecutionReceipt?.({
          host: "cursor",
          model: "vision",
          role: "specialist",
          capabilities: ["vision"],
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        });
        throw new DOMException("Fixture cancelled", "AbortError");
      },
    },
    async () => ({
      modelSelection: { source: "official", model: "main" },
      capabilityCompletion: {
        enabled: true,
        mainCapabilities: ["text"],
        maximumSpecialists: 1,
        specialists: [
          { host: "cursor", source: "official", model: "vision", capabilities: ["vision"] },
        ],
      },
    }),
  );
  await assert.rejects(
    completion.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "fixture" },
      routing: { requiredCapabilities: ["text", "vision"] },
    }),
    { name: "AbortError" },
  );
  const record = (await completion.inspectCapabilityCompletion()).records[0];
  assert.equal(record?.outcome, "cancelled");
  assert.equal(record?.mainResult.outcome, "not-run");
  assert.equal(record?.mainResult.skipReason, "blocked-by-cancellation");
  assert.equal(record?.secondaryResults[0]?.outcome, "cancelled");
  assert.equal(record?.tokenUsage?.totalTokens, 15);
});

test("retains usage on failed and incomplete stream terminal events", async () => {
  for (const terminalType of ["response.failed", "response.incomplete"] as const) {
    const completion = createCapabilityCompletionProvider(
      {
        descriptor: { type: "openai-compatible", model: "fixture" },
        execute: async () => ({
          kind: "stream",
          statusCode: 200,
          stream: new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(
                encodeSseData({
                  type: terminalType,
                  response: {
                    error: { message: "fixture failure" },
                    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
                  },
                }),
              );
              controller.close();
            },
          }),
        }),
      },
      async () => ({
        modelSelection: { source: "official", model: "main" },
        capabilityCompletion: {
          enabled: false,
          mainCapabilities: ["text"],
          maximumSpecialists: 0,
          specialists: [],
        },
      }),
    );
    const result = await completion.execute({
      protocol: "responses",
      virtualModelId: "tidu",
      body: { input: "fixture" },
    });
    assert.equal(result.kind, "stream");
    if (result.kind === "stream") await consumeStream(result.stream);
    const record = (await completion.inspectCapabilityCompletion()).records[0];
    assert.equal(record?.outcome, "failed");
    assert.equal(record?.tokenUsage?.totalTokens, 15);
  }
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

test("waits for the required specialist's official terminal response", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: ["text"] }),
        provider: jsonProvider("main", async () => {
          calls.push("cheap-main");
          return { statusCode: 200, body: { output_text: "main result" } };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          capabilities: ["text", "vision"],
        }),
        provider: {
          descriptor: { type: "openai-compatible", model: "secondary" },
          execute: async (request) => {
            calls.push("vision-specialist");
            request.onModelConfirmed?.("vision-model[reasoning_effort=high]");
            await new Promise<void>((resolve) => setTimeout(resolve, 40));
            return {
              kind: "json",
              statusCode: 200,
              upstreamModel: "vision-model[reasoning_effort=high]",
              body: { output_text: "official specialist result" },
            };
          },
        },
      },
    ],
    policy,
  );

  await router.execute({
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

  assert.deepEqual(calls, ["vision-specialist", "cheap-main"]);
  assert.deepEqual(
    router.inspectAttempts().map((attempt) => attempt.outcome),
    ["succeeded", "succeeded"],
  );
  assert.equal(router.inspectAttempts()[0]?.executedModel, "vision-model[reasoning_effort=high]");
});

test("routes an explicit local-file request to a code-capable secondary model", async () => {
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
        profile: profile({
          id: "vision-specialist",
          capabilities: ["text", "code"],
        }),
        provider: jsonProvider("secondary", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 200,
            body: { choices: [{ message: { content: "file inspected" } }] },
          };
        }),
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "查看本地 SKILL 文件并检查内容。" },
  });

  assert.deepEqual(calls, ["vision-specialist", "cheap-main"]);
  assert.deepEqual(router.inspect()?.requiredCapabilities, ["code", "text"]);
  assert.deepEqual(router.inspect()?.missingCapabilities, []);
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

test("does not synthesize model or capability process messages", async () => {
  const progress: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          host: "codex",
          capabilities: ["reasoning"],
        }),
        provider: {
          descriptor: { type: "cursor-host", model: "main" },
          execute: async (request) => {
            request.onModelConfirmed?.("gpt-5.6-sol");
            return {
              kind: "json",
              statusCode: 200,
              body: { output_text: "combined" },
            };
          },
        },
      },
      {
        profile: profile({
          id: "vision-specialist",
          host: "cursor",
          capabilities: ["text"],
        }),
        provider: {
          descriptor: { type: "codex-host", model: "secondary" },
          execute: async (request) => {
            request.onModelConfirmed?.("gemini-3.8-flash[reasoning_effort=high]");
            return {
              kind: "json",
              statusCode: 200,
              body: { output_text: "evidence" },
            };
          },
        },
      },
    ],
    policy,
  );

  await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "explain", reasoning_effort: "medium" },
    onProcessDelta: (delta) => progress.push(delta),
  });

  assert.deepEqual(progress, []);
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

test("fails closed without calling a model when configured capabilities leave a gap", async () => {
  const cases: ReadonlyArray<{
    body: Readonly<Record<string, unknown>>;
    missingCapabilities: readonly string[];
  }> = [
    {
      body: { input: "Return JSON.", response_format: { type: "json_object" } },
      missingCapabilities: ["structured-output"],
    },
    {
      body: { input: "Think.", reasoning: { effort: "high" } },
      missingCapabilities: ["reasoning"],
    },
    {
      body: {
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "local" }],
          },
        ],
      },
      missingCapabilities: ["vision"],
    },
    {
      body: { input: "x".repeat(100_000) },
      missingCapabilities: ["long-context"],
    },
    {
      body: {
        input: "Apply the patch.",
        tools: [{ type: "function", name: "apply_patch" }],
        tool_choice: { type: "function", name: "apply_patch" },
      },
      missingCapabilities: ["code", "tool-use"],
    },
    {
      body: {
        input: "Search the web.",
        tools: [{ type: "web_search" }],
        tool_choice: "required",
      },
      missingCapabilities: ["tool-use", "web-research"],
    },
  ];

  for (const regressionCase of cases) {
    const calls: string[] = [];
    const router = createDynamicModelRouter(
      [
        {
          profile: profile({ id: "cheap-main", capabilities: ["text"] }),
          provider: jsonProvider("main", async () => {
            calls.push("cheap-main");
            return {
              statusCode: 200,
              body: { output_text: "upstream accepted the request" },
            };
          }),
        },
        {
          profile: profile({ id: "vision-specialist", capabilities: ["text"] }),
          provider: jsonProvider("specialist", async () => {
            calls.push("vision-specialist");
            return { statusCode: 200, body: { output_text: "specialist" } };
          }),
        },
      ],
      policy,
    );

    await assert.rejects(
      router.execute({
        protocol: "responses",
        virtualModelId: "tidu",
        body: regressionCase.body,
      }),
      /No configured model combination covers required capabilities/u,
    );

    assert.deepEqual(calls, []);
    assert.equal(router.inspect()?.reason, "capability-gap");
    assert.deepEqual(router.inspect()?.missingCapabilities, regressionCase.missingCapabilities);
  }
});

test("covers all 65,536 primary and secondary capability checkbox allocations", async () => {
  const capabilities = [...MODEL_ROUTING_CAPABILITIES];
  const allocationCount = 2 ** capabilities.length;
  const fullAllocation = allocationCount - 1;
  const capabilitiesForAllocation = (allocation: number): string[] =>
    capabilities.filter((_capability, index) => (allocation & (1 << index)) !== 0);

  for (let primaryAllocation = 0; primaryAllocation < allocationCount; primaryAllocation += 1) {
    for (
      let secondaryAllocation = 0;
      secondaryAllocation < allocationCount;
      secondaryAllocation += 1
    ) {
      const calls: string[] = [];
      const router = createDynamicModelRouter(
        [
          {
            profile: profile({
              id: "cheap-main",
              capabilities: capabilitiesForAllocation(primaryAllocation),
            }),
            provider: {
              descriptor: { type: "codex-host", model: "primary-model" },
              execute: async (request) => {
                calls.push("primary");
                request.onModelConfirmed?.("primary-model");
                return {
                  kind: "json",
                  statusCode: 200,
                  upstreamModel: "primary-model",
                  body: { output_text: "primary result" },
                };
              },
            },
          },
          {
            profile: profile({
              id: "vision-specialist",
              capabilities: capabilitiesForAllocation(secondaryAllocation),
            }),
            provider: {
              descriptor: { type: "cursor-host", model: "secondary-model" },
              execute: async (request) => {
                calls.push("secondary");
                request.onModelConfirmed?.("secondary-model");
                return {
                  kind: "json",
                  statusCode: 200,
                  upstreamModel: "secondary-model",
                  body: { output_text: "secondary result" },
                };
              },
            },
          },
        ],
        policy,
      );
      const request = {
        protocol: "responses" as const,
        virtualModelId: "tidu",
        body: { input: "capability matrix" },
        routing: { requiredCapabilities: capabilities },
      };
      const covered = (primaryAllocation | secondaryAllocation) === fullAllocation;

      if (!covered) {
        await assert.rejects(
          router.execute(request),
          /No configured model combination covers required capabilities/u,
        );
        assert.deepEqual(calls, []);
        continue;
      }

      const result = await router.execute(request);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(router.inspect()?.missingCapabilities, []);
      const textCapabilityIndex = capabilities.indexOf("text");
      const primaryOwnsText = (primaryAllocation & (1 << textCapabilityIndex)) !== 0;
      const expectedCalls =
        primaryAllocation === fullAllocation
          ? ["primary"]
          : primaryAllocation === 0
            ? ["secondary"]
            : primaryOwnsText
              ? ["secondary", "primary"]
              : secondaryAllocation === fullAllocation
                ? ["secondary"]
                : ["primary", "secondary"];
      assert.deepEqual(calls, expectedCalls);
      assert.equal(
        router
          .inspectAttempts()
          .every((attempt) => attempt.outcome === "succeeded" && attempt.executedModel !== null),
        true,
      );
    }
  }
});

test("uses one secondary as the final model when multiple secondaries cover a zero-capability primary", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({ id: "cheap-main", capabilities: [] }),
        provider: jsonProvider("primary", async () => {
          calls.push("primary");
          return { statusCode: 200, body: { output_text: "unexpected" } };
        }),
      },
      {
        profile: profile({ id: "vision-specialist", capabilities: ["vision"] }),
        provider: jsonProvider("vision", async () => {
          calls.push("vision");
          return { statusCode: 200, body: { output_text: "visual evidence" } };
        }),
      },
      {
        profile: profile({
          id: "final-specialist",
          capabilities: ["text", "reasoning"],
        }),
        provider: jsonProvider("final", async () => {
          calls.push("final");
          return { statusCode: 200, body: { output_text: "final result" } };
        }),
      },
    ],
    {
      ...policy,
      capabilityCompletion: {
        enabled: true,
        poolModelIds: ["vision-specialist", "final-specialist"],
        maximumSpecialists: 2,
      },
    },
  );

  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: { input: "inspect and explain" },
    routing: { requiredCapabilities: ["text", "reasoning", "vision"] },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ["vision", "final"]);
  assert.equal(router.inspect()?.mainModelId, "final-specialist");
  assert.deepEqual(router.inspect()?.specialistModelIds, ["vision-specialist"]);
  assert.deepEqual(router.inspect()?.missingCapabilities, []);
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

test("preserves the explicit bridge limitation when every fallback is unavailable", async () => {
  const calls: string[] = [];
  const router = createDynamicModelRouter(
    [
      {
        profile: profile({
          id: "cheap-main",
          capabilities: ["text", "tool-use"],
        }),
        provider: jsonProvider("host-bridge", async () => {
          calls.push("cheap-main");
          return {
            statusCode: 400,
            body: {
              error: {
                code: "host_bridge_tools_unsupported",
                message: "The bridge cannot satisfy a required tool call.",
              },
            },
          };
        }),
      },
      {
        profile: profile({
          id: "vision-specialist",
          capabilities: ["text", "code", "tool-use"],
        }),
        provider: jsonProvider("unavailable", async () => {
          calls.push("vision-specialist");
          return {
            statusCode: 503,
            body: {
              error: { code: "provider_unavailable", message: "Unavailable." },
            },
          };
        }),
      },
    ],
    policy,
  );

  const result = await router.execute({
    protocol: "responses",
    virtualModelId: "tidu",
    body: {
      input: "Call lookup.",
      tools: [{ type: "function", name: "lookup" }],
      tool_choice: "required",
    },
  });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(calls, ["cheap-main", "vision-specialist"]);
  assert.match(JSON.stringify(result), /host_bridge_tools_unsupported/u);
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

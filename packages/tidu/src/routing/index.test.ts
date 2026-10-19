import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProvider, ProviderExecutionRequest } from "../providers/index.js";
import {
  createCapabilityCompletionProvider,
  createDynamicModelRouter,
  type DynamicRoutingPolicy,
  type ModelRouteProfile,
  type RoutableModel,
} from "./index.js";

test("records a configured specialist contribution for the shared Agent policy", async () => {
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
            ? { choices: [{ message: { content: "visual evidence" } }] }
            : { choices: [{ message: { content: "combined answer" } }] },
      };
    },
  };
  const completion = createCapabilityCompletionProvider(provider, async () => ({
    modelSelection: { source: "official", model: "main-model" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text", "structured-output"],
      specialists: [{ source: "company", model: "vision-model", capabilities: ["vision"] }],
      maximumSpecialists: 1,
    },
  }));

  await completion.execute({
    protocol: "chat-completions",
    virtualModelId: "ai-tidu9-config",
    body: { messages: [{ role: "user", content: "inspect image" }] },
    routing: { requiredCapabilities: ["vision"], role: "worker" },
  });

  assert.deepEqual(calls, ["vision-model", "main-model"]);
  const status = await completion.inspectCapabilityCompletion();
  assert.equal(status.records[0]?.complemented, true);
  assert.deepEqual(status.records[0]?.specialistModelIds, ["specialist-0:company:vision-model"]);
  assert.equal(status.records[0]?.outcome, "succeeded");
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
  averageLatencyMilliseconds: overrides.averageLatencyMilliseconds ?? 100,
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

test("uses an opt-in specialist to complete a cheap main model capability", async () => {
  let mainRequest: ProviderExecutionRequest | undefined;
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main" }),
      provider: jsonProvider("cheap", async (request) => {
        mainRequest = request;
        return { statusCode: 200, body: { choices: [{ message: { content: "done" } }] } };
      }),
    },
    {
      profile: profile({ id: "vision-specialist", capabilities: ["text", "vision"] }),
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
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "local" } }] }],
      response_format: { type: "json_object" },
    },
  });
  assert.deepEqual(router.inspect()?.specialistModelIds, ["vision-specialist"]);
  assert.match(JSON.stringify(mainRequest?.body), /image contains a chart/u);
  assert.ok(Math.abs((router.inspect()?.estimatedCostPerMillionTokens ?? 0) - 0.6) < 0.000001);
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
        return { statusCode: 200, body: { choices: [{ message: { content: "ok" } }] } };
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

test("enforces privacy and can select a free local model", async () => {
  const models: RoutableModel[] = [
    {
      profile: profile({ id: "cheap-main", privacy: "external" }),
      provider: jsonProvider("external", async () => ({ statusCode: 200, body: {} })),
    },
    {
      profile: profile({
        id: "local-free",
        privacy: "local",
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      }),
      provider: jsonProvider("local", async () => ({ statusCode: 200, body: {} })),
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
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "local" } }] }],
      response_format: { type: "json_object" },
    },
  });
  assert.deepEqual(calls, ["full-model"]);
  assert.deepEqual(router.inspect()?.specialistModelIds, []);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityRegistry } from "../capabilities/index.js";
import { createTask } from "../protocol/index.js";
import type { ModelProvider, ProviderExecutionRequest } from "../providers/index.js";
import { createDynamicModelRouter, type RoutableModel } from "../routing/index.js";
import { createSecretGate } from "../security/index.js";
import { openNodeSqliteStorage } from "../storage/index.js";
import {
  type AgentPlan,
  type AgentStepOutput,
  type AgentTool,
  type AgentWorker,
  createAgentKernel,
  createInMemoryTaskCapsuleStore,
  type TaskPlanner,
} from "./index.js";
import { createModelProviderAgentAdapters } from "./model-provider.js";

const understanding = {
  objective: "Produce a verified result",
  acceptanceCriteria: [] as string[],
  constraints: [] as string[],
  assumptions: [] as string[],
  requiredCapabilities: [] as string[],
};

const createPlanner = (plan: AgentPlan): TaskPlanner => ({
  understand: async (task) => ({
    ...understanding,
    objective: task.goal.objective,
    acceptanceCriteria: [...task.goal.acceptanceCriteria],
  }),
  plan: async () => plan,
});

const successfulWorker: AgentWorker = {
  execute: async ({ step }) => ({ summary: `Completed ${step.title}` }),
};

const agentStreamEncoder = new TextEncoder();

const encodeAgentSseData = (body: unknown): Uint8Array =>
  agentStreamEncoder.encode(`data: ${typeof body === "string" ? body : JSON.stringify(body)}\n\n`);

const executeFastStream = async (
  stream: ReadableStream<Uint8Array>,
  protocol: ProviderExecutionRequest["protocol"] = "responses",
): Promise<{ output: AgentStepOutput; deltas: readonly string[] }> => {
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "stream-test" },
    execute: async () => ({ kind: "stream", statusCode: 200, stream }),
  };
  const plan: AgentPlan = {
    revision: 1,
    steps: [{ id: "deliver", title: "Deliver", kind: "reason" }],
  };
  const step = plan.steps[0];
  if (step === undefined) throw new Error("Stream test plan requires one step.");
  const deltas: string[] = [];
  const output = await createModelProviderAgentAdapters(provider, "ai-tidu9-config").worker.execute(
    {
      task: createTask({ taskId: "stream-test", goal: "Return a streamed result" }),
      understanding,
      plan,
      step,
      previousResults: [],
      signal: new AbortController().signal,
      modelRequest: {
        protocol,
        virtualModelId: "ai-tidu9-config",
        body: protocol === "responses" ? { input: "stream" } : { messages: [] },
        onOutputDelta: (delta) => deltas.push(delta),
      },
    },
  );
  return { output, deltas };
};

test("uses deterministic understanding and planning for response-only tasks", async () => {
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: {
      understand: async () => {
        throw new Error("response-only understanding must not call the model");
      },
      plan: async () => {
        throw new Error("response-only planning must not call the model");
      },
    },
    worker: {
      execute: async () => ({
        summary: "Delivered",
        evidence: [
          {
            kind: "unsupported" as "model",
            integrity: "reported",
            summary: "The response was delivered.",
            supportsCriteria: [0],
          },
        ],
      }),
    },
    verifier: {
      verify: async () => {
        throw new Error("response-only verification must not call the model");
      },
    },
  });

  const created = await kernel.createTask({
    goal: { objective: "Reply once", acceptanceCriteria: ["A response is returned."] },
    planningMode: "response",
    verificationMode: "response",
  });
  const completed = await kernel.runTask(created.task.taskId);

  assert.equal(created.understanding?.objective, "Reply once");
  assert.equal(created.plan?.steps.length, 1);
  assert.equal(created.plan?.steps[0]?.id, "deliver");
  assert.equal(created.plan?.steps[0]?.kind, "reason");
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.result?.summary, "Delivered");
});

test("forwards response capabilities and reasoning strength in one model call", async () => {
  const requests: ProviderExecutionRequest[] = [];
  const deliveredText = "x".repeat(4_096);
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "response-model" },
    execute: async (request) => {
      requests.push(request);
      return {
        kind: "json",
        statusCode: 200,
        body: {
          id: "resp-agent",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: deliveredText }],
            },
          ],
        },
      };
    },
  };
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    ...createModelProviderAgentAdapters(provider, "ai-tidu9-config"),
  });
  const created = await kernel.createTask({
    goal: { objective: "Inspect the image", acceptanceCriteria: ["Return a result."] },
    planningMode: "response",
    verificationMode: "response",
    requiredCapabilities: ["text", "vision", "reasoning"],
    modelPreferences: { reasoningEffort: "high" },
    modelRequest: {
      protocol: "responses",
      virtualModelId: "ai-tidu9-config",
      body: {
        model: "ai-tidu9-config",
        input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png" }] }],
        stream: true,
      },
    },
  });
  const completed = await kernel.runTask(created.task.taskId);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.routing?.requiredCapabilities, ["text", "vision", "reasoning"]);
  assert.deepEqual(requests[0]?.body.reasoning, { effort: "high" });
  assert.equal(requests[0]?.body.reasoning_effort, undefined);
  assert.equal(requests[0]?.body.stream, false);
  assert.equal(completed.result?.summary, deliveredText);
});

test("accepts fast response streams only after a successful terminal event", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        encodeAgentSseData({ type: "response.output_text.delta", delta: "complete" }),
      );
      controller.enqueue(
        encodeAgentSseData({
          type: "response.completed",
          response: { status: "completed", output_text: "complete" },
        }),
      );
      controller.enqueue(encodeAgentSseData("[DONE]"));
      controller.close();
    },
  });

  const result = await executeFastStream(stream);

  assert.equal(result.output.summary, "complete");
  assert.deepEqual(result.deltas, ["complete"]);
});

test("rejects every unsuccessful fast-stream terminal and partial EOF", async () => {
  const failureCases = [
    {
      name: "response failed",
      events: [
        {
          type: "response.failed",
          response: { status: "failed", error: { message: "response failed" } },
        },
      ],
      message: /response failed/u,
    },
    {
      name: "response incomplete",
      events: [
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "token limit" } },
        },
      ],
      message: /token limit/u,
    },
    {
      name: "typed error",
      events: [{ type: "error", message: "typed failure" }],
      message: /typed failure/u,
    },
    {
      name: "error envelope",
      events: [{ error: { code: "provider_error", message: "provider failure" } }],
      message: /provider failure/u,
    },
    {
      name: "completed as failed",
      events: [{ type: "response.completed", response: { status: "failed" } }],
      message: /did not complete successfully/u,
    },
    {
      name: "completed as incomplete",
      events: [{ type: "response.completed", response: { status: "incomplete" } }],
      message: /did not complete successfully/u,
    },
    {
      name: "partial output then EOF",
      events: [{ type: "response.output_text.delta", delta: "partial" }],
      message: /without a successful terminal/u,
    },
  ] as const;

  for (const failureCase of failureCases) {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of failureCase.events) controller.enqueue(encodeAgentSseData(event));
        controller.close();
      },
    });

    await assert.rejects(() => executeFastStream(stream), failureCase.message, failureCase.name);
  }
});

test("preserves fast-stream cancellation errors", async () => {
  const cancellation = new DOMException("client cancelled", "AbortError");
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.error(cancellation),
  });

  await assert.rejects(
    () => executeFastStream(stream),
    (error: unknown) => error === cancellation,
  );
});

test("uses a configured model provider for understanding, planning, execution, and verification", async () => {
  const responses = [
    {
      objective: "Model-planned outcome",
      acceptanceCriteria: ["Outcome verified"],
      constraints: [],
      assumptions: [],
      requiredCapabilities: [],
    },
    {
      revision: 1,
      steps: [{ id: "produce", title: "Produce outcome", kind: "reason" }],
    },
    {
      summary: "Outcome produced",
      evidence: [
        {
          kind: "model",
          integrity: "reported",
          summary: "Model reports the outcome",
          supportsCriteria: [0],
        },
      ],
    },
    {
      summary: "Outcome accepted",
      criteria: [
        {
          criterionIndex: 0,
          accepted: true,
          reason: "Evidence supports the outcome",
          evidenceIds: [] as string[],
        },
      ],
    },
  ];
  let responseIndex = 0;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "agent-test" },
    execute: async (request) => {
      const currentResponseIndex = responseIndex;
      const response = structuredClone(responses[responseIndex]);
      responseIndex += 1;
      if (currentResponseIndex === 3) {
        const messages = request.body.messages as Array<{ content?: string }>;
        const verificationInput = JSON.parse(messages[1]?.content ?? "{}") as {
          evidence?: Array<{ id?: string }>;
        };
        const verifierResponse = response as {
          criteria: Array<{ evidenceIds: string[] }>;
        };
        const evidenceId = verificationInput.evidence?.[0]?.id;
        if (evidenceId !== undefined) {
          verifierResponse.criteria[0]?.evidenceIds.push(evidenceId);
        }
      }
      return {
        kind: "json",
        statusCode: 200,
        body: {
          choices: [{ message: { content: JSON.stringify(response) } }],
        },
      };
    },
  };
  const adapters = createModelProviderAgentAdapters(provider, "ai-tidu9-config");
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    ...adapters,
  });

  const created = await kernel.createTask({
    goal: {
      objective: "Model-planned outcome",
      acceptanceCriteria: ["Outcome verified"],
    },
  });
  const result = await kernel.runTask(created.task.taskId);
  assert.equal(result.task.status, "completed");
  assert.equal(result.result?.trustLevel, "low");
  assert.equal(responseIndex, 4);
});

test("does not route free-form task descriptions as model capability identifiers", async () => {
  const routedCapabilities: (readonly string[])[] = [];
  const responses = [
    {
      objective: "Explain the current system",
      acceptanceCriteria: ["The system is explained"],
      constraints: [],
      assumptions: [],
      requiredCapabilities: ["system positioning", "structured Chinese explanation", "vision"],
    },
    {
      revision: 1,
      steps: [
        { id: "scope", title: "Scope the explanation", kind: "reason" },
        { id: "explain", title: "Explain the system", kind: "reason" },
        { id: "check", title: "Check the explanation", kind: "verify" },
      ],
    },
    {
      summary: "The system is explained.",
      evidence: [
        {
          kind: "model",
          integrity: "reported",
          summary: "The model explained the system.",
          supportsCriteria: [0],
        },
      ],
    },
    {
      summary: "The explanation is complete.",
      criteria: [
        {
          criterionIndex: 0,
          accepted: true,
          reason: "The explanation addresses the goal.",
          evidenceIds: [] as string[],
        },
      ],
    },
  ];
  let responseIndex = 0;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "agent-test" },
    execute: async (request) => {
      routedCapabilities.push(request.routing?.requiredCapabilities ?? []);
      const response = structuredClone(responses[responseIndex]);
      responseIndex += 1;
      return {
        kind: "json",
        statusCode: 200,
        body: { choices: [{ message: { content: JSON.stringify(response) } }] },
      };
    },
  };
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    ...createModelProviderAgentAdapters(provider, "ai-tidu9-config"),
  });

  const created = await kernel.createTask({
    goal: {
      objective: "Explain the current system",
      acceptanceCriteria: ["The system is explained"],
    },
  });
  const completed = await kernel.runTask(created.task.taskId);

  assert.equal(completed.task.status, "completed");
  assert.deepEqual(completed.plan?.steps, [
    {
      id: "deliver",
      title: "Deliver the requested outcome",
      kind: "reason",
      input: undefined,
      dependsOn: [],
    },
  ]);
  assert.deepEqual(routedCapabilities, [[], ["vision"], ["vision"], []]);
});

test("completes an Agent task only after a specialist fills the main model capability gap", async () => {
  const calls = { main: 0, specialist: 0, specialistEvidenceSeen: false };
  const mainProvider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "main-text" },
    execute: async (request) => {
      calls.main += 1;
      const serializedRequest = JSON.stringify(request.body);
      if (serializedRequest.includes("vision specialist observed the chart")) {
        calls.specialistEvidenceSeen = true;
      }
      let response: unknown;
      if (serializedRequest.includes("Normalize the goal")) {
        response = {
          objective: "Explain the chart",
          acceptanceCriteria: ["The chart is explained with visual evidence"],
          constraints: [],
          assumptions: [],
          requiredCapabilities: ["vision"],
        };
      } else if (serializedRequest.includes("dependency-ordered steps")) {
        response = {
          revision: 1,
          steps: [{ id: "explain", title: "Explain the observed chart", kind: "reason" }],
        };
      } else if (serializedRequest.includes("Execute only this non-tool step")) {
        response = {
          summary: "The chart rises after the specialist-observed turning point.",
          evidence: [
            {
              kind: "model",
              integrity: "reported",
              summary: "Vision specialist observed the chart turning point.",
              supportsCriteria: [0],
            },
          ],
        };
      } else {
        const evidenceId = /evidence-[a-f0-9-]+/iu.exec(serializedRequest)?.[0];
        response = {
          summary: "The chart rises after the observed turning point.",
          criteria: [
            {
              criterionIndex: 0,
              accepted: evidenceId !== undefined,
              reason: "Specialist evidence supports the visual conclusion.",
              evidenceIds: evidenceId === undefined ? [] : [evidenceId],
            },
          ],
        };
      }
      return {
        kind: "json",
        statusCode: 200,
        body: { choices: [{ message: { content: JSON.stringify(response) } }] },
      };
    },
  };
  const specialistProvider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "vision-specialist" },
    execute: async () => {
      calls.specialist += 1;
      return {
        kind: "json",
        statusCode: 200,
        body: { choices: [{ message: { content: "vision specialist observed the chart" } }] },
      };
    },
  };
  const models: RoutableModel[] = [
    {
      profile: {
        id: "main-text",
        capabilities: ["text", "structured-output"],
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.1,
        averageLatencyMilliseconds: 10,
        availability: 1,
        privacy: "external",
        remainingRequests: null,
        enabled: true,
      },
      provider: mainProvider,
    },
    {
      profile: {
        id: "vision-specialist",
        capabilities: ["text", "structured-output", "vision"],
        inputCostPerMillionTokens: 0.2,
        outputCostPerMillionTokens: 0.2,
        averageLatencyMilliseconds: 20,
        availability: 1,
        privacy: "external",
        remainingRequests: null,
        enabled: true,
      },
      provider: specialistProvider,
    },
  ];
  const router = createDynamicModelRouter(models, {
    enabled: true,
    mainModelId: "main-text",
    weights: { capability: 5, cost: 2, privacy: 2, latency: 1, availability: 2 },
    capabilityCompletion: {
      enabled: true,
      poolModelIds: ["vision-specialist"],
      maximumSpecialists: 1,
    },
  });
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    ...createModelProviderAgentAdapters(router, "ai-tidu9-config"),
  });

  const created = await kernel.createTask({
    goal: {
      objective: "Explain the chart",
      acceptanceCriteria: ["The chart is explained with visual evidence"],
    },
  });
  const completed = await kernel.runTask(created.task.taskId);

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.result?.accepted, true);
  assert.equal(completed.result?.summary, "The chart rises after the observed turning point.");
  assert.equal(calls.specialist, 2);
  assert.equal(calls.specialistEvidenceSeen, true);
});

test("completes a bounded task only after independent acceptance verification", async () => {
  const evidenceTool: AgentTool = {
    name: "inspect",
    description: "Inspect an observable result",
    risk: "read",
    idempotent: true,
    execute: async () => ({
      summary: "Inspected result",
      evidence: [
        {
          kind: "tool",
          integrity: "observed",
          summary: "Result exists",
          supportsCriteria: [0],
        },
      ],
    }),
  };
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createPlanner({
      revision: 1,
      steps: [
        {
          id: "inspect-result",
          title: "Inspect result",
          kind: "tool",
          toolName: "inspect",
        },
      ],
    }),
    worker: successfulWorker,
    tools: [evidenceTool],
    verifier: {
      verify: async ({ evidence }) => ({
        summary: "Observable result verified",
        criteria: [
          {
            criterionIndex: 0,
            accepted: true,
            reason: "Observed by the inspection tool",
            evidenceIds: evidence.map((item) => item.id),
          },
        ],
      }),
    },
  });

  const created = await kernel.createTask({
    goal: {
      objective: "Produce a result",
      acceptanceCriteria: ["Result exists"],
    },
  });
  const completed = await kernel.runTask(created.task.taskId);

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.result?.accepted, true);
  assert.equal(completed.result?.trustLevel, "high");
  assert.equal(completed.usage.toolCalls, 1);
});

test("assembles heterogeneous capabilities before planning and fails closed when missing", async () => {
  let plannedAssets: readonly { id: string }[] = [];
  const registry = createCapabilityRegistry([
    {
      id: "internal-knowledge",
      kind: "knowledge",
      description: "Bounded internal reference",
      capabilities: ["domain-context"],
      enabled: true,
      privacy: "private",
      cost: 0,
    },
    {
      id: "analysis-skill",
      kind: "skill",
      description: "Analysis method",
      capabilities: ["analysis"],
      enabled: true,
      privacy: "local",
      cost: 0,
    },
  ]);
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    capabilityRegistry: registry,
    capabilityPrivacy: "private",
    planner: {
      understand: async (task) => ({
        ...understanding,
        objective: task.goal.objective,
        requiredCapabilities: ["analysis", "domain-context"],
      }),
      plan: async ({ assets }) => {
        plannedAssets = assets;
        return { revision: 1, steps: [{ id: "analyze", title: "Analyze", kind: "reason" }] };
      },
    },
    worker: successfulWorker,
  });
  const created = await kernel.createTask({ goal: "Analyze the domain" });
  assert.deepEqual(
    plannedAssets.map((asset) => asset.id),
    ["analysis-skill", "internal-knowledge"],
  );
  assert.equal(created.capabilityAssembly?.missingCapabilities.length, 0);

  const unavailableKernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    capabilityRegistry: registry,
    capabilityPrivacy: "local",
    planner: {
      understand: async (task) => ({
        ...understanding,
        objective: task.goal.objective,
        requiredCapabilities: ["domain-context"],
      }),
      plan: async () => ({ revision: 1, steps: [] }),
    },
    worker: successfulWorker,
  });
  await assert.rejects(
    () => unavailableKernel.createTask({ goal: "Private analysis" }),
    /unavailable/u,
  );
});

test("keeps task secrets out of persistence and external tools while restoring local execution", async () => {
  const secret = "Bearer stage-four-private-token-123456";
  const observed: { external?: unknown; local?: unknown } = {};
  const createSecretPlanner = (toolName: string): TaskPlanner => ({
    understand: async (task) => ({
      ...understanding,
      objective: task.goal.objective,
    }),
    plan: async ({ task }) => ({
      revision: 1,
      steps: [
        {
          id: "use-secret",
          title: "Use protected input",
          kind: "tool",
          toolName,
          input: task.goal.objective,
        },
      ],
    }),
  });
  const createTool = (name: string, executionLocation: "external" | "local"): AgentTool => ({
    name,
    description: "Observe protected input",
    risk: "read",
    idempotent: true,
    executionLocation,
    execute: async ({ input }) => {
      observed[executionLocation] = input;
      return { summary: "Observed" };
    },
  });
  const gate = createSecretGate();
  const externalKernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createSecretPlanner("external-observer"),
    worker: successfulWorker,
    secretGate: gate,
    tools: [createTool("external-observer", "external")],
  });
  const externalTask = await externalKernel.createTask({ goal: `Run curl with ${secret}` });
  assert.doesNotMatch(JSON.stringify(externalTask), /stage-four-private-token/u);
  await externalKernel.runTask(externalTask.task.taskId);
  assert.doesNotMatch(JSON.stringify(observed.external), /stage-four-private-token/u);

  const localKernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createSecretPlanner("local-observer"),
    worker: successfulWorker,
    secretGate: gate,
    tools: [createTool("local-observer", "local")],
  });
  const localTask = await localKernel.createTask({ goal: `Run curl with ${secret}` });
  await localKernel.runTask(localTask.task.taskId);
  assert.match(String(observed.local), /stage-four-private-token/u);
});

test("waits for approval before a side-effecting tool and resumes explicitly", async () => {
  let executions = 0;
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createPlanner({
      revision: 1,
      steps: [
        {
          id: "write",
          title: "Write result",
          kind: "tool",
          toolName: "writer",
        },
      ],
    }),
    worker: successfulWorker,
    tools: [
      {
        name: "writer",
        description: "Writes a result",
        risk: "write",
        idempotent: true,
        execute: async () => {
          executions += 1;
          return { summary: "Written" };
        },
      },
    ],
  });

  const created = await kernel.createTask({ goal: "Write a result" });
  const waiting = await kernel.runTask(created.task.taskId);
  assert.equal(waiting.task.status, "waiting_for_approval");
  assert.equal(executions, 0);

  await kernel.resolveApproval(created.task.taskId, "write", true);
  const completed = await kernel.resumeTask(created.task.taskId);
  assert.equal(completed.task.status, "completed");
  assert.equal(executions, 1);
});

test("enforces the per-task step budget", async () => {
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createPlanner({
      revision: 1,
      steps: [
        { id: "first", title: "First", kind: "reason" },
        { id: "second", title: "Second", kind: "reason" },
      ],
    }),
    worker: successfulWorker,
  });

  const created = await kernel.createTask({
    goal: "Run bounded work",
    budget: { maxSteps: 1 },
  });
  const failed = await kernel.runTask(created.task.taskId);
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.usage.steps, 1);
});

test("replans after a recoverable execution failure", async () => {
  let attempts = 0;
  const planner: TaskPlanner = {
    ...createPlanner({
      revision: 1,
      steps: [{ id: "fragile", title: "Fragile", kind: "reason" }],
    }),
    replan: async () => ({
      revision: 2,
      steps: [{ id: "fallback", title: "Fallback", kind: "reason" }],
    }),
  };
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner,
    worker: {
      execute: async ({ step }) => {
        attempts += 1;
        if (step.id === "fragile") {
          throw new Error("temporary worker failure");
        }
        return { summary: "Fallback completed" };
      },
    },
  });

  const created = await kernel.createTask({ goal: "Recover dynamically" });
  const completed = await kernel.runTask(created.task.taskId);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.plan?.revision, 2);
  assert.equal(completed.usage.replans, 1);
  assert.equal(attempts, 2);
});

test("recovers an interrupted idempotent tool after SQLite reopen", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-agent-recovery-"));
  const databasePath = join(temporaryDirectory, "tidu.db");
  let attempts = 0;
  let observedIdempotencyKey = "";
  const tool: AgentTool = {
    name: "recoverable",
    description: "Idempotent recoverable operation",
    risk: "read",
    idempotent: true,
    execute: async ({ idempotencyKey }) => {
      attempts += 1;
      if (attempts === 1) {
        observedIdempotencyKey = idempotencyKey;
        throw new Error("worker interrupted");
      }
      assert.equal(idempotencyKey, observedIdempotencyKey);
      return { summary: "Recovered safely" };
    },
  };

  try {
    const firstStorage = await openNodeSqliteStorage({ databasePath });
    const firstKernel = createAgentKernel({
      store: firstStorage.taskCapsuleStore,
      planner: createPlanner({
        revision: 1,
        steps: [
          {
            id: "recover",
            title: "Recover",
            kind: "tool",
            toolName: "recoverable",
          },
        ],
      }),
      worker: successfulWorker,
      tools: [tool],
    });
    const created = await firstKernel.createTask({
      goal: "Recover after restart",
    });
    const interrupted = await firstKernel.runTask(created.task.taskId);
    assert.equal(interrupted.task.status, "failed");
    firstStorage.close();

    const secondStorage = await openNodeSqliteStorage({ databasePath });
    const secondKernel = createAgentKernel({
      store: secondStorage.taskCapsuleStore,
      planner: createPlanner({
        revision: 1,
        steps: [{ id: "unused", title: "Unused", kind: "reason" }],
      }),
      worker: successfulWorker,
      tools: [tool],
    });
    const completed = await secondKernel.resumeTask(created.task.taskId);
    assert.equal(completed.task.status, "completed");
    assert.equal(attempts, 2);
    secondStorage.close();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("does not replay an interrupted non-idempotent tool without approval", async () => {
  let attempts = 0;
  const kernel = createAgentKernel({
    store: createInMemoryTaskCapsuleStore(),
    planner: createPlanner({
      revision: 1,
      steps: [{ id: "charge", title: "Charge", kind: "tool", toolName: "charger" }],
    }),
    worker: successfulWorker,
    tools: [
      {
        name: "charger",
        description: "Non-idempotent external operation",
        risk: "external",
        idempotent: false,
        execute: async () => {
          attempts += 1;
          throw new Error("unknown external outcome");
        },
      },
    ],
    approvalHandler: {
      request: async (request) => (request.reason === "tool_side_effect" ? "approved" : "pending"),
    },
  });

  const created = await kernel.createTask({ goal: "Perform external work" });
  const interrupted = await kernel.runTask(created.task.taskId);
  assert.equal(interrupted.task.status, "failed");
  const waiting = await kernel.resumeTask(created.task.taskId);
  assert.equal(waiting.task.status, "waiting_for_approval");
  assert.equal(attempts, 1);
});

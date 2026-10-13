import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityRegistry } from "../capabilities/index.js";
import type { ModelProvider } from "../providers/index.js";
import { createSecretGate } from "../security/index.js";
import { openNodeSqliteStorage } from "../storage/index.js";
import {
  type AgentPlan,
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
  const adapters = createModelProviderAgentAdapters(provider, "managed-default");
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

import { randomUUID } from "node:crypto";

import {
  type AgentEvent,
  type AgentEventType,
  type CanonicalTask,
  type CreateTaskInput,
  createAgentEvent,
  createTask,
  type TaskStatus,
} from "../protocol/index.js";

export const TASK_CAPSULE_VERSION = "tidu-task-capsule/1" as const;

export interface TaskBudgetLimits {
  /** Maximum plan steps that may finish across the task. */
  maxSteps: number;
  /** Maximum tool invocations across the task. */
  maxToolCalls: number;
  /** Maximum events retained by the bounded task capsule. */
  maxEvents: number;
  /** Maximum wall-clock lifetime from task creation. */
  maxDurationMs: number;
  /** Maximum evidence records retained by the task capsule. */
  maxEvidence: number;
  /** Maximum dynamic replans after execution failures. */
  maxReplans: number;
}

export interface TaskBudgetUsage {
  /** Number of plan steps completed. */
  steps: number;
  /** Number of tool invocations started. */
  toolCalls: number;
  /** Number of events appended. */
  events: number;
  /** Number of evidence records retained. */
  evidence: number;
  /** Number of dynamic replans performed. */
  replans: number;
}

export interface TaskUnderstanding {
  /** Normalized outcome understood by the planner. */
  objective: string;
  /** Observable acceptance conditions understood by the planner. */
  acceptanceCriteria: readonly string[];
  /** Explicit constraints that every plan step must preserve. */
  constraints: readonly string[];
  /** Assumptions that should be verified when material. */
  assumptions: readonly string[];
  /** Capability names required to execute the task. */
  requiredCapabilities: readonly string[];
}

export type AgentPlanStepKind = "reason" | "tool" | "verify";

export interface AgentPlanStep {
  /** Stable identifier unique inside the plan. */
  id: string;
  /** Concise operator-facing description. */
  title: string;
  /** Execution adapter selected for this step. */
  kind: AgentPlanStepKind;
  /** Tool identifier required by a tool step. */
  toolName?: string;
  /** JSON-compatible input passed to the selected adapter. */
  input?: unknown;
  /** Step identifiers that must complete first. */
  dependsOn?: readonly string[];
  /** Whether a human must explicitly approve execution. */
  requiresApproval?: boolean;
}

export interface AgentPlan {
  /** Revision incremented whenever the planner replaces the plan. */
  revision: number;
  /** Ordered, dependency-checked execution steps. */
  steps: readonly AgentPlanStep[];
}

export interface TaskStepResult {
  /** Plan step that produced this result. */
  stepId: string;
  /** Bounded summary retained instead of full model or tool output. */
  summary: string;
  /** ISO timestamp recorded after the step completed. */
  completedAt: string;
}

export type EvidenceKind = "human" | "model" | "system" | "tool";
export type EvidenceIntegrity = "observed" | "reported";

export interface TaskEvidence {
  /** Stable evidence identifier. */
  id: string;
  /** Producer category used when deriving trust. */
  kind: EvidenceKind;
  /** Whether AI-Tidu9 observed the fact or received a report. */
  integrity: EvidenceIntegrity;
  /** Bounded human-readable evidence summary. */
  summary: string;
  /** Acceptance-criterion indexes supported by this evidence. */
  supportsCriteria: readonly number[];
  /** Optional non-secret external or local reference. */
  reference?: string;
}

export type TaskTrustLevel = "high" | "low" | "medium" | "unverified";

export interface TaskAcceptanceCriterionResult {
  /** Zero-based index in the task acceptance criteria. */
  criterionIndex: number;
  /** Whether the verifier accepted this criterion. */
  accepted: boolean;
  /** Bounded explanation returned by the verifier. */
  reason: string;
  /** Evidence identifiers used for the decision. */
  evidenceIds: readonly string[];
}

export interface TaskResult {
  /** Whether every required acceptance condition passed. */
  accepted: boolean;
  /** Bounded final outcome summary. */
  summary: string;
  /** Per-criterion verification details. */
  criteria: readonly TaskAcceptanceCriterionResult[];
  /** Trust derived from acceptance and evidence integrity. */
  trustLevel: TaskTrustLevel;
  /** Minimal evidence identifiers included in the result package. */
  evidenceIds: readonly string[];
}

export interface ActiveTaskStep {
  /** Step that may have started before an interruption. */
  stepId: string;
  /** Stable key reused when an idempotent operation is retried. */
  idempotencyKey: string;
}

export interface TaskCheckpoint {
  /** Index of the next planned step. */
  nextStepIndex: number;
  /** Step identifiers known to have completed. */
  completedStepIds: readonly string[];
  /** Step identifiers explicitly approved by a human. */
  approvedStepIds: readonly string[];
  /** Operation that was active when the latest checkpoint was saved. */
  activeStep?: ActiveTaskStep;
  /** ISO timestamp of the latest checkpoint. */
  updatedAt: string;
}

export interface TaskCapsule {
  /** Stable capsule contract used by storage adapters. */
  capsuleVersion: typeof TASK_CAPSULE_VERSION;
  /** Optimistic storage revision. */
  revision: number;
  /** Canonical task aggregate. */
  task: CanonicalTask;
  /** Model-produced goal interpretation. */
  understanding?: TaskUnderstanding;
  /** Current validated execution plan. */
  plan?: AgentPlan;
  /** Latest bounded recovery checkpoint. */
  checkpoint: TaskCheckpoint;
  /** Per-task hard resource limits. */
  budget: TaskBudgetLimits;
  /** Resource usage accumulated across resumes. */
  usage: TaskBudgetUsage;
  /** Bounded recent event stream required for control and recovery. */
  events: readonly AgentEvent[];
  /** Bounded step summaries required for verification and recovery. */
  stepResults: readonly TaskStepResult[];
  /** Minimal evidence retained for result verification. */
  evidence: readonly TaskEvidence[];
  /** Final result package when verification has run. */
  result?: TaskResult;
  /** Absolute task deadline derived from its budget. */
  deadlineAt: string;
  /** ISO timestamp of the latest durable capsule update. */
  updatedAt: string;
}

export interface TaskCapsuleStore {
  /** Loads one capsule or returns undefined when absent. */
  load: (taskId: string) => Promise<TaskCapsule | undefined>;
  /** Lists recently updated capsules using a bounded result count. */
  list: (limit?: number) => Promise<readonly TaskCapsule[]>;
  /** Saves a capsule only when its expected revision still matches. */
  save: (capsule: TaskCapsule, expectedRevision: number) => Promise<TaskCapsule>;
}

export interface TaskPlanner {
  /** Uses a model or equivalent expert adapter to understand the goal. */
  understand: (task: CanonicalTask, signal: AbortSignal) => Promise<TaskUnderstanding>;
  /** Produces a dependency-ordered plan from the understood goal and available capabilities. */
  plan: (input: TaskPlanningInput, signal: AbortSignal) => Promise<AgentPlan>;
  /** Optionally replaces the remaining plan after a recoverable execution failure. */
  replan?: (input: TaskReplanningInput, signal: AbortSignal) => Promise<AgentPlan>;
}

export interface TaskPlanningInput {
  /** Canonical task being planned. */
  task: CanonicalTask;
  /** Model-produced task understanding. */
  understanding: TaskUnderstanding;
  /** Non-secret tool capabilities available to the planner. */
  tools: readonly AgentToolDescriptor[];
}

export interface TaskReplanningInput extends TaskPlanningInput {
  /** Plan that failed during execution. */
  previousPlan: AgentPlan;
  /** Step that could not complete. */
  failedStep: AgentPlanStep;
  /** Safe error summary without credentials or raw tool output. */
  failure: string;
  /** Step identifiers already completed and not to be repeated. */
  completedStepIds: readonly string[];
}

export type AgentToolRisk = "external" | "read" | "write";

export interface AgentToolDescriptor {
  /** Stable tool identifier referenced by plans. */
  name: string;
  /** Non-sensitive capability description exposed to the planner. */
  description: string;
  /** Side-effect category used by the approval gate. */
  risk: AgentToolRisk;
  /** Whether retrying with the same idempotency key is safe. */
  idempotent: boolean;
}

export interface AgentTool extends AgentToolDescriptor {
  /** Executes one bounded tool call. */
  execute: (input: AgentToolExecutionInput) => Promise<AgentStepOutput>;
}

export interface AgentToolExecutionInput {
  /** JSON-compatible input produced by the validated plan. */
  input: unknown;
  /** Stable key used by idempotent tool adapters. */
  idempotencyKey: string;
  /** Cancellation signal owned by the Agent kernel. */
  signal: AbortSignal;
}

export interface AgentStepOutput {
  /** Bounded summary retained in the task capsule. */
  summary: string;
  /** Minimal evidence emitted by this step. */
  evidence?: readonly Omit<TaskEvidence, "id">[];
}

export interface AgentWorkerInput {
  /** Canonical task being executed. */
  task: CanonicalTask;
  /** Model-produced task understanding. */
  understanding: TaskUnderstanding;
  /** Current validated plan. */
  plan: AgentPlan;
  /** Non-tool step being executed. */
  step: AgentPlanStep;
  /** Bounded summaries from completed steps. */
  previousResults: readonly TaskStepResult[];
  /** Cancellation signal owned by the Agent kernel. */
  signal: AbortSignal;
}

export interface AgentWorker {
  /** Executes reasoning or verification work without bypassing the kernel. */
  execute: (input: AgentWorkerInput) => Promise<AgentStepOutput>;
}

export interface TaskVerificationInput {
  /** Canonical task whose result is being evaluated. */
  task: CanonicalTask;
  /** Validated plan that produced the result. */
  plan: AgentPlan;
  /** Bounded completed-step summaries. */
  stepResults: readonly TaskStepResult[];
  /** Minimal evidence package. */
  evidence: readonly TaskEvidence[];
}

export interface TaskVerificationResult {
  /** Bounded final outcome summary. */
  summary: string;
  /** Per-criterion verification decisions. */
  criteria: readonly TaskAcceptanceCriterionResult[];
}

export interface TaskVerifier {
  /** Evaluates observable acceptance criteria independently from the execution loop. */
  verify: (input: TaskVerificationInput, signal: AbortSignal) => Promise<TaskVerificationResult>;
}

export type ApprovalReason = "recovery_retry" | "step_requested" | "tool_side_effect";

export interface TaskApprovalRequest {
  /** Task waiting for approval. */
  taskId: string;
  /** Step that cannot continue without approval. */
  step: AgentPlanStep;
  /** Reason the mandatory approval gate was activated. */
  reason: ApprovalReason;
}

export interface TaskApprovalHandler {
  /** Returns a human decision or leaves the task waiting when unavailable. */
  request: (request: TaskApprovalRequest) => Promise<"approved" | "denied" | "pending">;
}

export interface CreateAgentTaskInput extends Omit<CreateTaskInput, "taskId"> {
  /** Optional caller-supplied identifier; a random identifier is used when omitted. */
  taskId?: string;
  /** Optional task-specific limits constrained by hard platform maxima. */
  budget?: Partial<TaskBudgetLimits>;
}

export interface TaskControlView {
  /** Stable task identifier. */
  taskId: string;
  /** Concise objective safe for the local control view. */
  objective: string;
  /** Current task lifecycle state. */
  status: TaskStatus;
  /** Completed plan steps. */
  completedSteps: number;
  /** Total plan steps. */
  totalSteps: number;
  /** Current task trust level when verification has completed. */
  trustLevel: TaskTrustLevel;
  /** Step awaiting a human decision, when the task is approval-gated. */
  pendingApprovalStepId?: string;
  /** Resource usage and limits. */
  budget: { limits: TaskBudgetLimits; usage: TaskBudgetUsage };
  /** ISO timestamp of the latest durable update. */
  updatedAt: string;
}

export interface AgentKernel {
  /** Creates, understands, plans, and durably checkpoints a task. */
  createTask: (input: CreateAgentTaskInput) => Promise<TaskCapsule>;
  /** Runs or continues a planned task within all configured bounds. */
  runTask: (taskId: string) => Promise<TaskCapsule>;
  /** Requests a safe pause at the current execution boundary. */
  pauseTask: (taskId: string) => Promise<TaskCapsule>;
  /** Resumes a paused, failed, or approved task from its checkpoint. */
  resumeTask: (taskId: string) => Promise<TaskCapsule>;
  /** Cancels a task and prevents further execution. */
  cancelTask: (taskId: string) => Promise<TaskCapsule>;
  /** Resolves a pending human approval without silently continuing. */
  resolveApproval: (taskId: string, stepId: string, approved: boolean) => Promise<TaskCapsule>;
  /** Loads one complete bounded capsule. */
  getTask: (taskId: string) => Promise<TaskCapsule | undefined>;
  /** Lists bounded task-control summaries. */
  listTasks: (limit?: number) => Promise<readonly TaskControlView[]>;
}

export interface AgentKernelOptions {
  /** Durable or in-memory task-capsule persistence. */
  store: TaskCapsuleStore;
  /** Model-driven goal-understanding and planning adapter. */
  planner: TaskPlanner;
  /** Worker for reasoning and verification plan steps. */
  worker: AgentWorker;
  /** Independent result verifier. */
  verifier?: TaskVerifier;
  /** Tools available to validated plans. */
  tools?: readonly AgentTool[];
  /** Optional interactive human approval adapter. */
  approvalHandler?: TaskApprovalHandler;
  /** Default limits applied to new tasks. */
  defaultBudget?: Partial<TaskBudgetLimits>;
}

const DEFAULT_TASK_BUDGET: TaskBudgetLimits = Object.freeze({
  maxSteps: 24,
  maxToolCalls: 12,
  maxEvents: 96,
  maxDurationMs: 5 * 60 * 1000,
  maxEvidence: 24,
  maxReplans: 3,
});
const HARD_BUDGET_MAXIMA: TaskBudgetLimits = Object.freeze({
  maxSteps: 256,
  maxToolCalls: 128,
  maxEvents: 512,
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxEvidence: 128,
  maxReplans: 16,
});
const CAPSULE_LIMITS = Object.freeze({
  maxPlanSteps: 64,
  maxPlanInputBytes: 16 * 1024,
  maxSummaryCharacters: 2048,
});
const TERMINAL_STATUSES = new Set<TaskStatus>(["cancelled", "completed"]);
const EVIDENCE_KINDS = new Set<EvidenceKind>(["human", "model", "system", "tool"]);
const EVIDENCE_INTEGRITIES = new Set<EvidenceIntegrity>(["observed", "reported"]);

const now = (): string => new Date().toISOString();
const clone = <TValue>(value: TValue): TValue => structuredClone(value);

const boundedSummary = (value: string): string => {
  const summary = value.trim();
  if (summary === "") {
    throw new Error("Agent summaries cannot be empty.");
  }
  return summary.slice(0, CAPSULE_LIMITS.maxSummaryCharacters);
};

const boundedPlanInput = (value: unknown): unknown => {
  if (value === undefined) {
    return undefined;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > CAPSULE_LIMITS.maxPlanInputBytes) {
    throw new Error(`Plan step input exceeds ${CAPSULE_LIMITS.maxPlanInputBytes} bytes.`);
  }
  return JSON.parse(serialized) as unknown;
};

const normalizeBudget = (
  defaults: Partial<TaskBudgetLimits> | undefined,
  requested: Partial<TaskBudgetLimits> | undefined,
): TaskBudgetLimits => {
  const budget = { ...DEFAULT_TASK_BUDGET, ...defaults, ...requested };
  for (const budgetKey of Object.keys(budget) as Array<keyof TaskBudgetLimits>) {
    const value = budget[budgetKey];
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_BUDGET_MAXIMA[budgetKey]) {
      throw new Error(`${budgetKey} must be a positive integer within the platform maximum.`);
    }
  }
  return budget;
};

const validateUnderstanding = (
  task: CanonicalTask,
  understanding: TaskUnderstanding,
): TaskUnderstanding => ({
  objective: boundedSummary(understanding.objective || task.goal.objective),
  acceptanceCriteria: (task.goal.acceptanceCriteria.length > 0
    ? task.goal.acceptanceCriteria
    : understanding.acceptanceCriteria
  ).map(boundedSummary),
  constraints: understanding.constraints.map(boundedSummary),
  assumptions: understanding.assumptions.map(boundedSummary),
  requiredCapabilities: understanding.requiredCapabilities.map(boundedSummary),
});

const validatePlan = (plan: AgentPlan, tools: ReadonlyMap<string, AgentTool>): AgentPlan => {
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    throw new Error("Plan revision must be a positive safe integer.");
  }
  if (plan.steps.length === 0 || plan.steps.length > CAPSULE_LIMITS.maxPlanSteps) {
    throw new Error(`Plan must contain 1-${CAPSULE_LIMITS.maxPlanSteps} steps.`);
  }
  const knownSteps = new Set<string>();
  const steps = plan.steps.map((step) => {
    const id = step.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(id) || knownSteps.has(id)) {
      throw new Error("Plan step identifiers must be unique safe identifiers.");
    }
    const dependsOn = [...new Set(step.dependsOn ?? [])];
    if (!["reason", "tool", "verify"].includes(step.kind)) {
      throw new Error(`Plan step ${id} has an unsupported kind.`);
    }
    if (dependsOn.some((dependency) => !knownSteps.has(dependency))) {
      throw new Error(`Plan step ${id} depends on an unknown or later step.`);
    }
    if (step.kind === "tool" && (step.toolName === undefined || !tools.has(step.toolName))) {
      throw new Error(`Plan step ${id} references an unavailable tool.`);
    }
    knownSteps.add(id);
    return {
      ...step,
      id,
      title: boundedSummary(step.title),
      input: boundedPlanInput(step.input),
      dependsOn,
    };
  });
  return { revision: plan.revision, steps };
};

const setStatus = (capsule: TaskCapsule, status: TaskStatus): TaskCapsule => {
  const updatedAt = now();
  return {
    ...capsule,
    task: {
      ...capsule.task,
      status,
      revision: capsule.task.revision + 1,
      updatedAt,
    },
    updatedAt,
  };
};

const appendEvent = (
  capsule: TaskCapsule,
  type: AgentEventType,
  payload: unknown,
  source: AgentEvent["source"] = { kind: "kernel" },
): TaskCapsule => {
  if (capsule.usage.events >= capsule.budget.maxEvents) {
    throw new Error("Task event budget exhausted.");
  }
  const sequence = capsule.usage.events + 1;
  const event = createAgentEvent({
    taskId: capsule.task.taskId,
    sequence,
    type,
    source,
    payload,
  });
  return {
    ...capsule,
    events: [...capsule.events, event],
    usage: { ...capsule.usage, events: sequence },
    updatedAt: event.occurredAt,
  };
};

const transition = (
  capsule: TaskCapsule,
  status: TaskStatus,
  type: AgentEventType,
  payload: unknown,
): TaskCapsule => appendEvent(setStatus(capsule, status), type, payload);

export const createTaskControlView = (capsule: TaskCapsule): TaskControlView => {
  const approvalEvent = [...capsule.events]
    .reverse()
    .find((event) => event.type === "tool.approval_requested");
  const approvalPayload = approvalEvent?.payload;
  const pendingApprovalStepId =
    capsule.task.status === "waiting_for_approval" &&
    typeof approvalPayload === "object" &&
    approvalPayload !== null &&
    "stepId" in approvalPayload &&
    typeof approvalPayload.stepId === "string"
      ? approvalPayload.stepId
      : undefined;
  return {
    taskId: capsule.task.taskId,
    objective: capsule.task.goal.objective,
    status: capsule.task.status,
    completedSteps: capsule.checkpoint.completedStepIds.length,
    totalSteps: capsule.plan?.steps.length ?? 0,
    trustLevel: capsule.result?.trustLevel ?? "unverified",
    ...(pendingApprovalStepId === undefined ? {} : { pendingApprovalStepId }),
    budget: { limits: capsule.budget, usage: capsule.usage },
    updatedAt: capsule.updatedAt,
  };
};

const calculateTrust = (accepted: boolean, evidence: readonly TaskEvidence[]): TaskTrustLevel => {
  if (!accepted) {
    return "unverified";
  }
  if (evidence.length === 0) {
    return "low";
  }
  if (evidence.every((item) => item.integrity === "observed" && item.kind !== "model")) {
    return "high";
  }
  return evidence.some((item) => item.integrity === "observed") ? "medium" : "low";
};

const defaultVerifier: TaskVerifier = {
  verify: async ({ task }) =>
    task.goal.acceptanceCriteria.length === 0
      ? { summary: "All planned steps completed.", criteria: [] }
      : {
          summary: "Execution completed, but semantic acceptance requires a configured verifier.",
          criteria: task.goal.acceptanceCriteria.map((_, criterionIndex) => ({
            criterionIndex,
            accepted: false,
            reason: "No independent verifier is configured.",
            evidenceIds: [],
          })),
        },
};

export const createInMemoryTaskCapsuleStore = (): TaskCapsuleStore => {
  const capsules = new Map<string, TaskCapsule>();
  return {
    load: async (taskId) => clone(capsules.get(taskId)),
    list: async (limit = 50) =>
      [...capsules.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map(clone),
    save: async (capsule, expectedRevision) => {
      const current = capsules.get(capsule.task.taskId);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new Error("Task capsule revision conflict.");
      }
      const saved = {
        ...clone(capsule),
        revision: expectedRevision + 1,
        updatedAt: now(),
      };
      capsules.set(saved.task.taskId, saved);
      return clone(saved);
    },
  };
};

export const createAgentKernel = (options: AgentKernelOptions): AgentKernel => {
  const toolList = options.tools ?? [];
  const tools = new Map<string, AgentTool>();
  const toolDescriptors: AgentToolDescriptor[] = [];
  for (const tool of toolList) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(tool.name) ||
      tools.has(tool.name) ||
      !["external", "read", "write"].includes(tool.risk) ||
      typeof tool.idempotent !== "boolean"
    ) {
      throw new Error("Agent tools must have unique safe names and valid execution metadata.");
    }
    const descriptor = {
      name: tool.name,
      description: boundedSummary(tool.description),
      risk: tool.risk,
      idempotent: tool.idempotent,
    };
    tools.set(tool.name, { ...tool, ...descriptor });
    toolDescriptors.push(descriptor);
  }
  const activeExecutions = new Map<
    string,
    { controller: AbortController; requested: "cancel" | "pause" | undefined }
  >();
  const verifier = options.verifier ?? defaultVerifier;

  const persist = (capsule: TaskCapsule): Promise<TaskCapsule> =>
    options.store.save(capsule, capsule.revision);

  const requireCapsule = async (taskId: string): Promise<TaskCapsule> => {
    const capsule = await options.store.load(taskId);
    if (capsule === undefined) {
      throw new Error(`Task ${taskId} does not exist.`);
    }
    return capsule;
  };

  const createPlannedTask = async (input: CreateAgentTaskInput): Promise<TaskCapsule> => {
    const task = createTask({
      ...input,
      taskId: input.taskId ?? `task-${randomUUID()}`,
    });
    const budget = normalizeBudget(options.defaultBudget, input.budget);
    const createdAt = task.createdAt;
    let capsule: TaskCapsule = {
      capsuleVersion: TASK_CAPSULE_VERSION,
      revision: 0,
      task,
      checkpoint: {
        nextStepIndex: 0,
        completedStepIds: [],
        approvedStepIds: [],
        updatedAt: createdAt,
      },
      budget,
      usage: { steps: 0, toolCalls: 0, events: 0, evidence: 0, replans: 0 },
      events: [],
      stepResults: [],
      evidence: [],
      deadlineAt: new Date(Date.parse(createdAt) + budget.maxDurationMs).toISOString(),
      updatedAt: createdAt,
    };
    capsule = appendEvent(
      capsule,
      "task.created",
      { objective: task.goal.objective },
      {
        kind: "client",
      },
    );
    capsule = await persist(capsule);
    const controller = new AbortController();
    try {
      const understanding = validateUnderstanding(
        task,
        await options.planner.understand(task, controller.signal),
      );
      const plan = validatePlan(
        await options.planner.plan(
          { task, understanding, tools: toolDescriptors },
          controller.signal,
        ),
        tools,
      );
      capsule = appendEvent(
        { ...capsule, understanding, plan },
        "plan.created",
        { revision: plan.revision, steps: plan.steps.length },
        { kind: "planner" },
      );
      return persist(capsule);
    } catch (error) {
      capsule = transition(capsule, "failed", "task.failed", {
        reason: error instanceof Error ? error.message : "Planning failed.",
      });
      await persist(capsule);
      throw error;
    }
  };

  const ensureRunnable = (capsule: TaskCapsule): void => {
    if (capsule.plan === undefined || capsule.understanding === undefined) {
      throw new Error("Task does not have a validated understanding and plan.");
    }
    if (Date.now() >= Date.parse(capsule.deadlineAt)) {
      throw new Error("Task duration budget exhausted.");
    }
    if (capsule.usage.steps >= capsule.budget.maxSteps) {
      throw new Error("Task step budget exhausted.");
    }
    if (capsule.usage.events + 4 > capsule.budget.maxEvents) {
      throw new Error("Task event budget cannot safely complete another step.");
    }
  };

  const requestStepApproval = async (
    capsule: TaskCapsule,
    step: AgentPlanStep,
    reason: ApprovalReason,
  ): Promise<{ capsule: TaskCapsule; approved: boolean }> => {
    if (reason !== "recovery_retry" && capsule.checkpoint.approvedStepIds.includes(step.id)) {
      return { capsule, approved: true };
    }
    let nextCapsule = appendEvent(
      capsule,
      "tool.approval_requested",
      { stepId: step.id, reason },
      { kind: "kernel" },
    );
    const decision =
      (await options.approvalHandler?.request({
        taskId: capsule.task.taskId,
        step,
        reason,
      })) ?? "pending";
    if (decision === "pending") {
      nextCapsule = transition(nextCapsule, "waiting_for_approval", "task.waiting_for_approval", {
        stepId: step.id,
      });
      return { capsule: await persist(nextCapsule), approved: false };
    }
    nextCapsule = appendEvent(
      nextCapsule,
      "tool.approval_resolved",
      { stepId: step.id, approved: decision === "approved" },
      { kind: "human" },
    );
    if (decision === "denied") {
      nextCapsule = transition(nextCapsule, "cancelled", "task.cancelled", {
        reason: "Human approval denied.",
      });
      return { capsule: await persist(nextCapsule), approved: false };
    }
    nextCapsule = {
      ...nextCapsule,
      checkpoint: {
        ...nextCapsule.checkpoint,
        approvedStepIds: [...new Set([...nextCapsule.checkpoint.approvedStepIds, step.id])],
        updatedAt: now(),
      },
    };
    return { capsule: nextCapsule, approved: true };
  };

  const runTask = async (taskId: string): Promise<TaskCapsule> => {
    if (activeExecutions.has(taskId)) {
      throw new Error(`Task ${taskId} is already running.`);
    }
    let capsule = await requireCapsule(taskId);
    if (TERMINAL_STATUSES.has(capsule.task.status)) {
      return capsule;
    }
    ensureRunnable(capsule);
    const controller = new AbortController();
    const execution = {
      controller,
      requested: undefined as "cancel" | "pause" | undefined,
    };
    activeExecutions.set(taskId, execution);
    capsule = transition(
      capsule,
      "running",
      capsule.task.status === "created" ? "task.started" : "task.resumed",
      { nextStepIndex: capsule.checkpoint.nextStepIndex },
    );
    capsule = await persist(capsule);

    try {
      while ((capsule.plan?.steps.length ?? 0) > capsule.checkpoint.nextStepIndex) {
        ensureRunnable(capsule);
        const plan = capsule.plan as AgentPlan;
        const understanding = capsule.understanding as TaskUnderstanding;
        const step = plan.steps[capsule.checkpoint.nextStepIndex];
        if (step === undefined) {
          throw new Error("Task checkpoint points outside the current plan.");
        }
        if (capsule.checkpoint.completedStepIds.includes(step.id)) {
          capsule = {
            ...capsule,
            checkpoint: {
              ...capsule.checkpoint,
              nextStepIndex: capsule.checkpoint.nextStepIndex + 1,
            },
          };
          continue;
        }
        const tool = step.kind === "tool" ? tools.get(step.toolName ?? "") : undefined;
        const interruptedTool = capsule.checkpoint.activeStep?.stepId === step.id;
        const approvalReason: ApprovalReason | undefined =
          interruptedTool && tool?.idempotent === false
            ? "recovery_retry"
            : step.requiresApproval
              ? "step_requested"
              : tool !== undefined && tool.risk !== "read"
                ? "tool_side_effect"
                : undefined;
        if (approvalReason !== undefined) {
          const approval = await requestStepApproval(capsule, step, approvalReason);
          capsule = approval.capsule;
          if (!approval.approved) {
            return capsule;
          }
        }
        if (tool !== undefined && capsule.usage.toolCalls >= capsule.budget.maxToolCalls) {
          throw new Error("Task tool-call budget exhausted.");
        }
        const idempotencyKey =
          capsule.checkpoint.activeStep?.idempotencyKey ??
          `${taskId}:${step.id}:${capsule.usage.toolCalls + 1}`;
        capsule = appendEvent(
          {
            ...capsule,
            usage: {
              ...capsule.usage,
              toolCalls: capsule.usage.toolCalls + (tool === undefined ? 0 : 1),
            },
            checkpoint: {
              ...capsule.checkpoint,
              activeStep: { stepId: step.id, idempotencyKey },
              updatedAt: now(),
            },
          },
          tool === undefined ? "step.started" : "tool.started",
          { stepId: step.id, toolName: tool?.name },
          tool === undefined ? { kind: "worker" } : { kind: "tool", id: tool.name },
        );
        capsule = await persist(capsule);

        try {
          const output =
            tool === undefined
              ? await options.worker.execute({
                  task: capsule.task,
                  understanding,
                  plan,
                  step,
                  previousResults: capsule.stepResults,
                  signal: controller.signal,
                })
              : await tool.execute({
                  input: step.input,
                  idempotencyKey,
                  signal: controller.signal,
                });
          if (execution.requested !== undefined || controller.signal.aborted) {
            const status = execution.requested === "cancel" ? "cancelled" : "paused";
            const eventType = status === "cancelled" ? "task.cancelled" : "task.paused";
            capsule = transition(capsule, status, eventType, {
              stepId: step.id,
            });
            return persist(capsule);
          }
          const completedAt = now();
          const rawEvidence = output.evidence ?? [];
          if (
            rawEvidence.some(
              (item) =>
                !EVIDENCE_KINDS.has(item.kind) ||
                !EVIDENCE_INTEGRITIES.has(item.integrity) ||
                !Array.isArray(item.supportsCriteria) ||
                (item.reference !== undefined && typeof item.reference !== "string"),
            )
          ) {
            throw new Error("Step returned invalid evidence metadata.");
          }
          const evidence = rawEvidence.map((item) => ({
            ...item,
            ...(item.reference === undefined
              ? {}
              : { reference: item.reference.slice(0, CAPSULE_LIMITS.maxSummaryCharacters) }),
            id: `evidence-${randomUUID()}`,
            summary: boundedSummary(item.summary),
          }));
          for (const item of evidence) {
            if (
              !item.supportsCriteria.every(
                (criterionIndex) =>
                  Number.isSafeInteger(criterionIndex) &&
                  criterionIndex >= 0 &&
                  criterionIndex < capsule.task.goal.acceptanceCriteria.length,
              )
            ) {
              throw new Error("Evidence references an unknown acceptance criterion.");
            }
          }
          if (capsule.usage.evidence + evidence.length > capsule.budget.maxEvidence) {
            throw new Error("Task evidence budget exhausted.");
          }
          const nextUsage = {
            ...capsule.usage,
            steps: capsule.usage.steps + 1,
            evidence: capsule.usage.evidence + evidence.length,
          };
          capsule = appendEvent(
            {
              ...capsule,
              usage: nextUsage,
              stepResults: [
                ...capsule.stepResults,
                {
                  stepId: step.id,
                  summary: boundedSummary(output.summary),
                  completedAt,
                },
              ],
              evidence: [...capsule.evidence, ...evidence],
              checkpoint: {
                nextStepIndex: capsule.checkpoint.nextStepIndex + 1,
                completedStepIds: [...capsule.checkpoint.completedStepIds, step.id],
                approvedStepIds: capsule.checkpoint.approvedStepIds,
                updatedAt: completedAt,
              },
            },
            tool === undefined ? "step.completed" : "tool.completed",
            { stepId: step.id, evidence: evidence.map((item) => item.id) },
            tool === undefined ? { kind: "worker" } : { kind: "tool", id: tool.name },
          );
          capsule = await persist(capsule);
        } catch (error) {
          if (execution.requested !== undefined || controller.signal.aborted) {
            const status = execution.requested === "cancel" ? "cancelled" : "paused";
            const eventType = status === "cancelled" ? "task.cancelled" : "task.paused";
            capsule = transition(capsule, status, eventType, {
              stepId: step.id,
            });
            return persist(capsule);
          }
          if (
            options.planner.replan !== undefined &&
            capsule.usage.replans < capsule.budget.maxReplans
          ) {
            const replanned = validatePlan(
              await options.planner.replan(
                {
                  task: capsule.task,
                  understanding,
                  tools: toolDescriptors,
                  previousPlan: plan,
                  failedStep: step,
                  failure: error instanceof Error ? error.message : "Step failed.",
                  completedStepIds: capsule.checkpoint.completedStepIds,
                },
                controller.signal,
              ),
              tools,
            );
            capsule = appendEvent(
              {
                ...capsule,
                plan: replanned,
                usage: { ...capsule.usage, replans: capsule.usage.replans + 1 },
                checkpoint: {
                  ...capsule.checkpoint,
                  nextStepIndex: 0,
                  activeStep: undefined,
                },
              },
              "plan.updated",
              { revision: replanned.revision, failedStepId: step.id },
              { kind: "planner" },
            );
            capsule = await persist(capsule);
            continue;
          }
          capsule = transition(capsule, "failed", "task.failed", {
            stepId: step.id,
            reason: error instanceof Error ? error.message : "Step failed.",
          });
          return persist(capsule);
        }
      }

      const verification = await verifier.verify(
        {
          task: capsule.task,
          plan: capsule.plan as AgentPlan,
          stepResults: capsule.stepResults,
          evidence: capsule.evidence,
        },
        controller.signal,
      );
      const criteria = verification.criteria.map((criterion) => ({
        ...criterion,
        reason: boundedSummary(criterion.reason),
      }));
      const criterionIndexes = new Set(criteria.map((criterion) => criterion.criterionIndex));
      const knownEvidenceIds = new Set(capsule.evidence.map((item) => item.id));
      if (
        criteria.length !== capsule.task.goal.acceptanceCriteria.length ||
        criterionIndexes.size !== criteria.length ||
        criteria.some(
          (criterion) =>
            !Number.isSafeInteger(criterion.criterionIndex) ||
            criterion.criterionIndex < 0 ||
            criterion.criterionIndex >= capsule.task.goal.acceptanceCriteria.length ||
            criterion.evidenceIds.some((evidenceId) => !knownEvidenceIds.has(evidenceId)),
        )
      ) {
        throw new Error("Verifier returned invalid acceptance evidence.");
      }
      criteria.sort((left, right) => left.criterionIndex - right.criterionIndex);
      const accepted =
        criteria.length === capsule.task.goal.acceptanceCriteria.length &&
        criteria.every((criterion) => criterion.accepted);
      const evidenceIds = [...new Set(criteria.flatMap((criterion) => criterion.evidenceIds))];
      const result: TaskResult = {
        accepted,
        summary: boundedSummary(verification.summary),
        criteria,
        trustLevel: calculateTrust(
          accepted,
          capsule.evidence.filter((item) => evidenceIds.includes(item.id)),
        ),
        evidenceIds,
      };
      capsule = transition(
        {
          ...capsule,
          result,
          checkpoint: { ...capsule.checkpoint, activeStep: undefined },
        },
        accepted ? "completed" : "failed",
        accepted ? "task.completed" : "task.failed",
        { accepted, trustLevel: result.trustLevel },
      );
      return persist(capsule);
    } catch (error) {
      if (
        capsule.task.status !== "failed" &&
        capsule.task.status !== "cancelled" &&
        capsule.task.status !== "paused" &&
        capsule.task.status !== "waiting_for_approval"
      ) {
        capsule = transition(capsule, "failed", "task.failed", {
          reason: error instanceof Error ? error.message : "Task execution failed.",
        });
        return persist(capsule);
      }
      throw error;
    } finally {
      activeExecutions.delete(taskId);
    }
  };

  const controlInactiveTask = async (
    taskId: string,
    requested: "cancel" | "pause",
  ): Promise<TaskCapsule> => {
    const active = activeExecutions.get(taskId);
    if (active !== undefined) {
      active.requested = requested;
      active.controller.abort();
      return requireCapsule(taskId);
    }
    let capsule = await requireCapsule(taskId);
    if (TERMINAL_STATUSES.has(capsule.task.status)) {
      return capsule;
    }
    capsule = transition(
      capsule,
      requested === "cancel" ? "cancelled" : "paused",
      requested === "cancel" ? "task.cancelled" : "task.paused",
      { source: "control" },
    );
    return persist(capsule);
  };

  return {
    createTask: createPlannedTask,
    runTask,
    pauseTask: (taskId) => controlInactiveTask(taskId, "pause"),
    resumeTask: runTask,
    cancelTask: (taskId) => controlInactiveTask(taskId, "cancel"),
    resolveApproval: async (taskId, stepId, approved) => {
      let capsule = await requireCapsule(taskId);
      if (capsule.task.status !== "waiting_for_approval") {
        throw new Error("Task is not waiting for approval.");
      }
      capsule = appendEvent(
        capsule,
        "tool.approval_resolved",
        { stepId, approved },
        { kind: "human" },
      );
      if (!approved) {
        return persist(
          transition(capsule, "cancelled", "task.cancelled", {
            reason: "Human approval denied.",
          }),
        );
      }
      capsule = setStatus(capsule, "paused");
      capsule = {
        ...capsule,
        checkpoint: {
          ...capsule.checkpoint,
          approvedStepIds: [...new Set([...capsule.checkpoint.approvedStepIds, stepId])],
          updatedAt: now(),
        },
      };
      return persist(capsule);
    },
    getTask: options.store.load,
    listTasks: async (limit) => (await options.store.list(limit)).map(createTaskControlView),
  };
};

import type { AgentHostId } from "../config/index.js";

export const TASK_CONTRACT_VERSION = "tidu-task/1" as const;
export const AGENT_PROTOCOL_VERSION = "tidu-agent-protocol/2" as const;

export const TASK_STATUSES = [
  "created",
  "running",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_EVENT_TYPES = [
  "task.created",
  "task.started",
  "task.progress",
  "task.waiting_for_approval",
  "task.paused",
  "task.resumed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "plan.created",
  "plan.updated",
  "step.started",
  "step.completed",
  "step.failed",
  "tool.approval_requested",
  "tool.approval_resolved",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "checkpoint.created",
  "evidence.recorded",
  "budget.updated",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentEventSourceKind =
  | "client"
  | "kernel"
  | "planner"
  | "worker"
  | "tool"
  | "human"
  | "system";

export interface TaskGoal {
  /** Concise outcome the task must achieve. */
  objective: string;
  /** Observable conditions used to decide whether the outcome is acceptable. */
  acceptanceCriteria: readonly string[];
}

export interface CanonicalTask {
  /** Stable contract version used to decode this task. */
  contractVersion: typeof TASK_CONTRACT_VERSION;
  /** Unique identifier shared by the task and all of its events. */
  taskId: string;
  /** Goal and observable acceptance conditions supplied at task creation. */
  goal: TaskGoal;
  /** Current lifecycle state derived from accepted task events. */
  status: TaskStatus;
  /** Optimistic revision incremented when durable task state changes. */
  revision: number;
  /** ISO-8601 timestamp recorded when the task was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the latest durable task-state change. */
  updatedAt: string;
  /** Optional parent identifier for explicitly delegated child work. */
  parentTaskId?: string;
  /** Host entry that owns this task's isolated model-completion policy. */
  originHost?: AgentHostId;
}

export interface CreateTaskInput {
  /** Unique identifier chosen by the task owner. */
  taskId: string;
  /** Goal text or a goal with explicit acceptance conditions. */
  goal: string | TaskGoal;
  /** Optional creation time for deterministic import and replay. */
  createdAt?: string;
  /** Optional parent identifier for explicitly delegated child work. */
  parentTaskId?: string;
  /** Host entry that owns this task's isolated model-completion policy. */
  originHost?: AgentHostId;
}

export interface AgentEventSource {
  /** Kind of component or person that produced the event. */
  kind: AgentEventSourceKind;
  /** Optional non-secret identifier for the producing component. */
  id?: string;
}

export interface AgentEvent<TPayload = unknown> {
  /** Stable protocol version used to decode this event. */
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  /** Deterministic identifier unique within the task event stream. */
  eventId: string;
  /** Unique task identifier shared by all events in one task. */
  taskId: string;
  /** Monotonically increasing positive sequence number within the task. */
  sequence: number;
  /** Event category used by kernels, clients, and adapters. */
  type: AgentEventType;
  /** Component or person that produced the event. */
  source: AgentEventSource;
  /** ISO-8601 timestamp recorded when the event occurred. */
  occurredAt: string;
  /** Event-specific data; persistence layers must apply their own size and privacy limits. */
  payload: TPayload;
}

export interface CreateAgentEventInput<TPayload = unknown> {
  /** Optional event identifier; defaults to the task identifier plus sequence. */
  eventId?: string;
  /** Unique task identifier shared by all events in one task. */
  taskId: string;
  /** Monotonically increasing positive sequence number within the task. */
  sequence: number;
  /** Event category used by kernels, clients, and adapters. */
  type: AgentEventType;
  /** Optional producer; defaults to the Agent kernel. */
  source?: AgentEventSource;
  /** Optional occurrence time for deterministic import and replay. */
  occurredAt?: string;
  /** Event-specific data. */
  payload: TPayload;
}

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

const normalizeIdentifier = (value: string, field: string): string => {
  const normalizedValue = value.trim();
  if (!IDENTIFIER_PATTERN.test(normalizedValue)) {
    throw new Error(`${field} must be 1-128 safe identifier characters.`);
  }
  return normalizedValue;
};

const normalizeTimestamp = (value: string | undefined): string => {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Timestamp must be a valid ISO-8601 value.");
  }
  return timestamp.toISOString();
};

const normalizeGoal = (goal: string | TaskGoal): TaskGoal => {
  const objective = (typeof goal === "string" ? goal : goal.objective).trim();
  if (objective === "") {
    throw new Error("Task goal objective cannot be empty.");
  }
  const acceptanceCriteria =
    typeof goal === "string"
      ? []
      : [...new Set(goal.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean))];
  return { objective, acceptanceCriteria };
};

export const createTask = (input: CreateTaskInput): CanonicalTask => {
  const createdAt = normalizeTimestamp(input.createdAt);
  return {
    contractVersion: TASK_CONTRACT_VERSION,
    taskId: normalizeIdentifier(input.taskId, "taskId"),
    goal: normalizeGoal(input.goal),
    status: "created",
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...(input.parentTaskId === undefined
      ? {}
      : { parentTaskId: normalizeIdentifier(input.parentTaskId, "parentTaskId") }),
    ...(input.originHost === undefined ? {} : { originHost: input.originHost }),
  };
};

export const createAgentEvent = <TPayload>(
  input: CreateAgentEventInput<TPayload>,
): AgentEvent<TPayload> => {
  const taskId = normalizeIdentifier(input.taskId, "taskId");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("Event sequence must be a positive safe integer.");
  }
  const eventId = normalizeIdentifier(input.eventId ?? `${taskId}:${input.sequence}`, "eventId");
  const source = input.source ?? { kind: "kernel" };
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId,
    taskId,
    sequence: input.sequence,
    type: input.type,
    source: {
      kind: source.kind,
      ...(source.id === undefined ? {} : { id: normalizeIdentifier(source.id, "source.id") }),
    },
    occurredAt: normalizeTimestamp(input.occurredAt),
    payload: input.payload,
  };
};

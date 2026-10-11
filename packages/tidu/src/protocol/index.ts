export const AGENT_PROTOCOL_VERSION = "tidu-agent-protocol/1" as const;

export type AgentEventType = "task.started" | "task.progress" | "task.completed" | "task.failed";

export interface AgentEvent<TPayload = unknown> {
  /** Stable protocol version used to decode this event. */
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  /** Unique task identifier shared by all events in one task. */
  taskId: string;
  /** Monotonically increasing sequence number within the task. */
  sequence: number;
  /** Event category used by clients and adapters. */
  type: AgentEventType;
  /** Event-specific data. */
  payload: TPayload;
}

export const createAgentEvent = <TPayload>(
  event: Omit<AgentEvent<TPayload>, "protocolVersion">,
): AgentEvent<TPayload> => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  ...event,
});

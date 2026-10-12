import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_VERSION,
  createAgentEvent,
  createTask,
  TASK_CONTRACT_VERSION,
} from "./index.js";

test("creates a canonical task with normalized acceptance criteria", () => {
  const task = createTask({
    taskId: "task-test",
    goal: {
      objective: " Verify the protocol ",
      acceptanceCriteria: [" event is versioned ", "event is versioned", " ", "task is stable"],
    },
    createdAt: "2026-10-12T08:00:00+08:00",
  });

  assert.equal(task.contractVersion, TASK_CONTRACT_VERSION);
  assert.equal(task.status, "created");
  assert.equal(task.revision, 0);
  assert.equal(task.createdAt, "2026-10-12T00:00:00.000Z");
  assert.deepEqual(task.goal, {
    objective: "Verify the protocol",
    acceptanceCriteria: ["event is versioned", "task is stable"],
  });
});

test("creates a versioned canonical event with replay-safe metadata", () => {
  const event = createAgentEvent({
    taskId: "task-test",
    sequence: 1,
    type: "task.started",
    source: { kind: "client", id: "codex" },
    occurredAt: "2026-10-12T00:00:01.000Z",
    payload: { goal: "verify protocol" },
  });

  assert.equal(event.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.equal(event.eventId, "task-test:1");
  assert.equal(event.taskId, "task-test");
  assert.deepEqual(event.source, { kind: "client", id: "codex" });
  assert.equal(event.occurredAt, "2026-10-12T00:00:01.000Z");
});

test("rejects ambiguous task identities, empty goals, and invalid event ordering", () => {
  assert.throws(() => createTask({ taskId: "unsafe task", goal: "valid goal" }), /taskId/u);
  assert.throws(() => createTask({ taskId: "task-safe", goal: "  " }), /objective/u);
  assert.throws(
    () =>
      createAgentEvent({
        taskId: "task-safe",
        sequence: 0,
        type: "task.started",
        payload: null,
      }),
    /positive safe integer/u,
  );
});

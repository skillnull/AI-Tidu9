import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_PROTOCOL_VERSION, createAgentEvent } from "./index.js";

test("creates a versioned canonical event", () => {
  const event = createAgentEvent({
    taskId: "task-test",
    sequence: 1,
    type: "task.started",
    payload: { goal: "verify protocol" },
  });

  assert.equal(event.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.equal(event.taskId, "task-test");
});

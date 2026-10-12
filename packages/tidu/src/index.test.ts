import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_VERSION,
  CONFIG_SCHEMA_VERSION,
  createAgentEvent,
  createDefaultConfiguration,
  DEFAULT_RUNTIME_HOST,
  IN_MEMORY_DATABASE_PATH,
  openNodeSqliteStorage,
  PRODUCT,
  TiduError,
} from "./index.js";

test("exposes the supported public API from one package", async () => {
  assert.equal(PRODUCT.name, "九门赛博提督");
  assert.equal(createDefaultConfiguration().schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(
    createAgentEvent({
      taskId: "task-public-api",
      sequence: 1,
      type: "task.started",
      payload: null,
    }).protocolVersion,
    AGENT_PROTOCOL_VERSION,
  );
  assert.equal(new TiduError("INTERNAL_ERROR", "test").code, "INTERNAL_ERROR");
  assert.equal(DEFAULT_RUNTIME_HOST, "127.0.0.1");
  const storage = await openNodeSqliteStorage({ databasePath: IN_MEMORY_DATABASE_PATH });
  storage.close();
});

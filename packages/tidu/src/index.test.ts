import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_VERSION,
  CONFIG_SCHEMA_VERSION,
  configureCodexClient,
  createAgentEvent,
  createDefaultConfiguration,
  createHostAccountRegistry,
  createOpenAiModel,
  createProviderFromEnvironment,
  DEFAULT_RUNTIME_HOST,
  discoverLocalClients,
  IN_MEMORY_DATABASE_PATH,
  openNodeSqliteStorage,
  PRODUCT,
  selectAuthoritativeUsage,
  TiduError,
  USAGE_CONTRACT_VERSION,
} from "./index.js";

test("exposes the supported public API from one package", async () => {
  assert.equal(PRODUCT.name, "九门赛博提督");
  assert.equal(typeof configureCodexClient, "function");
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
  assert.deepEqual(
    createProviderFromEnvironment({
      TIDU_PROVIDER: "ollama",
      TIDU_PROVIDER_MODEL: "public-api-test",
    })?.descriptor,
    { type: "ollama", model: "public-api-test" },
  );
  assert.equal(new TiduError("INTERNAL_ERROR", "test").code, "INTERNAL_ERROR");
  assert.equal(DEFAULT_RUNTIME_HOST, "127.0.0.1");
  assert.equal(typeof createHostAccountRegistry, "function");
  assert.equal(selectAuthoritativeUsage([]), undefined);
  assert.equal(USAGE_CONTRACT_VERSION, "tidu-usage/1");
  assert.equal(
    discoverLocalClients({ executablePath: "", operatingSystem: "linux" }).privacy,
    "metadata-only",
  );
  assert.equal(
    createOpenAiModel(createDefaultConfiguration(), "2026-10-12T00:00:00.000Z").owned_by,
    "AI-Tidu9",
  );
  const storage = await openNodeSqliteStorage({ databasePath: IN_MEMORY_DATABASE_PATH });
  storage.close();
});

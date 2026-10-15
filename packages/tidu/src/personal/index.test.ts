import assert from "node:assert/strict";
import test from "node:test";

import type { TaskAccountSnapshot } from "../accounts/index.js";
import { createDefaultConfiguration } from "../config/index.js";
import { openNodeSqliteStorage } from "../storage/index.js";
import type { UsageObservation } from "../usage/index.js";
import {
  activateConfigurationSafely,
  createHistoryCleanupPlan,
  createLocalModelSetup,
  createPersonalBudgetView,
  decryptConfigurationBundle,
  diagnoseExtension,
  diagnoseLocalModel,
  encryptConfigurationBundle,
  importConfigurationBundle,
  installPersonalExtension,
  PERSONAL_EXPERIENCE_VERSION,
  previewConfigurationImpact,
  validateAccountSwitch,
} from "./index.js";

test("isolates UI mode selection from the active runtime configuration", () => {
  const active = createDefaultConfiguration("managed");
  const candidate = {
    ...createDefaultConfiguration("expert"),
    activeProfileId: "expert-safe",
  };
  const preview = previewConfigurationImpact(active, candidate);
  assert.equal(preview.valid, true);
  assert.equal(preview.isolated, true);
  assert.equal(preview.risk, "medium");
  assert.deepEqual(preview.changes, [
    "activeMode",
    "activeProfileId",
    "expertServices.host",
    "expertServices.port",
    "expertServices.responsesApiEnabled",
    "expertServices.chatCompletionsApiEnabled",
    "expertServices.taskApiEnabled",
  ]);
  assert.equal(preview.restartRequired, true);
  assert.equal(active.activeMode, "managed");
});

test("rejects an invalid expert draft before activation", () => {
  const preview = previewConfigurationImpact(createDefaultConfiguration(), {
    ...createDefaultConfiguration("expert"),
    activeProfileId: "INVALID PROFILE",
  });
  assert.equal(preview.valid, false);
  assert.equal(preview.issues[0]?.code, "INVALID_PROFILE_ID");
});

test("restores the last-known-good configuration after a failed health probe", async () => {
  const storage = await openNodeSqliteStorage({ databasePath: ":memory:" });
  try {
    const initial = await storage.configurationStore.loadWorkspace();
    const saved = await storage.configurationStore.saveDraft({
      mode: "expert",
      expectedRevision: initial.drafts.expert.revision,
      configuration: {
        ...createDefaultConfiguration("expert"),
        activeProfileId: "expert-next",
      },
    });
    const result = await activateConfigurationSafely(
      storage.configurationStore,
      "expert",
      saved.drafts.expert.revision,
      async () => false,
    );
    assert.equal(result.activated, false);
    assert.equal(result.rolledBack, true);
    assert.equal(result.workspace.active.configuration.activeMode, "managed");
  } finally {
    storage.close();
  }
});

test("applies bounded portable history cleanup and clears non-owned history modes", () => {
  const entries = [
    { id: "recent-small", bytes: 40, lastAccessedAt: "2026-10-12T00:00:00.000Z" },
    { id: "recent-large", bytes: 80, lastAccessedAt: "2026-10-11T00:00:00.000Z" },
    { id: "expired", bytes: 20, lastAccessedAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(
    createHistoryCleanupPlan(
      { mode: "portable", maximumBytes: 100, retentionDays: 30 },
      entries,
      new Date("2026-10-13T00:00:00.000Z"),
    ),
    { removeIds: ["expired", "recent-large"], retainedBytes: 40 },
  );
  assert.deepEqual(
    createHistoryCleanupPlan({ mode: "host", maximumBytes: 0, retentionDays: 0 }, entries),
    { removeIds: ["recent-small", "recent-large", "expired"], retainedBytes: 0 },
  );
});

const accountSnapshot = (profileId: string, taskId: string): TaskAccountSnapshot => ({
  bridgeVersion: "tidu-host-account-bridge/1",
  taskId,
  profileId,
  provider: "chatgpt",
  authority: "host-delegated",
  profileRevision: 1,
  selectedAt: "2026-10-13T00:00:00.000Z",
});

const usage = (requestId: string, tokens: number): UsageObservation => ({
  contractVersion: "tidu-usage/1",
  requestId,
  authority: "provider",
  model: "example",
  tokens: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
  cost: { amount: tokens / 1000, currency: "USD" },
  observedAt: "2026-10-13T00:00:00.000Z",
});

test("attributes personal usage to immutable account snapshots without cross-account charging", () => {
  const view = createPersonalBudgetView(
    {
      periodStartedAt: "2026-10-01T00:00:00.000Z",
      periodEndsAt: "2026-11-01T00:00:00.000Z",
      tokenLimit: 1000,
      costLimit: { amount: 20, currency: "USD" },
    },
    [
      { account: accountSnapshot("account-one", "task-one"), usage: usage("request-one", 200) },
      { account: accountSnapshot("account-two", "task-two"), usage: usage("request-two", 300) },
    ],
  );
  assert.equal(view.totalTokens, 500);
  assert.equal(view.remainingTokens, 500);
  assert.equal(view.accounts[0]?.totalTokens, 200);
  assert.equal(view.accounts[1]?.totalTokens, 300);
  assert.equal(view.costs.USD, 0.5);
});

test("rejects duplicate request charging", () => {
  assert.throws(() =>
    createPersonalBudgetView(
      {
        periodStartedAt: "2026-10-01T00:00:00.000Z",
        periodEndsAt: "2026-11-01T00:00:00.000Z",
        tokenLimit: null,
        costLimit: null,
      },
      [
        { account: accountSnapshot("account-one", "task-one"), usage: usage("same", 1) },
        { account: accountSnapshot("account-one", "task-one"), usage: usage("same", 1) },
      ],
    ),
  );
});

test("keeps running task snapshots stable when an account switch is allowed", () => {
  const result = validateAccountSwitch(
    {
      id: "account-one",
      provider: "chatgpt",
      label: "One",
      authority: "host-delegated",
      status: "available",
      revision: 1,
    },
    {
      id: "account-two",
      provider: "chatgpt",
      label: "Two",
      authority: "host-delegated",
      status: "available",
      revision: 2,
    },
  );
  assert.equal(result.allowed, true);
  assert.match(result.reason, /running tasks keep their snapshots/u);
});

test("diagnoses local models and extensions without accepting unsafe defaults", () => {
  const localModel = {
    id: "qwen-local",
    provider: "ollama" as const,
    endpoint: "http://127.0.0.1:11434",
    available: true,
    capabilities: ["text"],
  };
  assert.equal(diagnoseLocalModel(localModel).ready, true);
  assert.deepEqual(createLocalModelSetup(localModel), {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen-local",
  });
  assert.equal(
    diagnoseLocalModel({
      id: "remote-model",
      provider: "ollama",
      endpoint: "https://external.example.com",
      available: true,
      capabilities: ["text"],
    }).ready,
    false,
  );
  const extension = {
    id: "local-search",
    kind: "tool" as const,
    version: "1.0.0",
    enabled: true,
    permissions: ["network.local"],
  };
  assert.equal(diagnoseExtension(extension).ready, true);
  assert.deepEqual(installPersonalExtension([], extension), [extension]);
});

test("round-trips an authenticated encrypted configuration export", () => {
  const bundle = {
    version: PERSONAL_EXPERIENCE_VERSION,
    exportedAt: "2026-10-13T00:00:00.000Z",
    configurations: {
      managed: createDefaultConfiguration("managed"),
      expert: createDefaultConfiguration("expert"),
    },
    history: { mode: "host" as const, maximumBytes: 0, retentionDays: 0 },
    extensions: [
      {
        id: "local-search",
        kind: "tool" as const,
        version: "1.0.0",
        enabled: true,
        permissions: ["network.local"],
      },
    ],
  };
  const encrypted = encryptConfigurationBundle(bundle, "correct-horse-battery-staple");
  assert.notEqual(encrypted.ciphertext, JSON.stringify(bundle));
  assert.deepEqual(decryptConfigurationBundle(encrypted, "correct-horse-battery-staple"), bundle);
  assert.throws(() => decryptConfigurationBundle(encrypted, "incorrect-passphrase"));
});

test("imports shared entry fields and expert settings without activating them", async () => {
  const storage = await openNodeSqliteStorage({ databasePath: ":memory:" });
  try {
    const workspace = await importConfigurationBundle(storage.configurationStore, {
      version: PERSONAL_EXPERIENCE_VERSION,
      exportedAt: "2026-10-13T00:00:00.000Z",
      configurations: {
        managed: { ...createDefaultConfiguration("managed"), virtualModelName: "Managed import" },
        expert: { ...createDefaultConfiguration("expert"), virtualModelName: "Expert import" },
      },
      history: { mode: "incognito", maximumBytes: 0, retentionDays: 0 },
      extensions: [],
    });
    assert.equal(workspace.active.configuration.virtualModelName, "九门赛博提督");
    assert.equal(workspace.drafts.managed.configuration.virtualModelName, "Expert import");
    assert.equal(workspace.drafts.expert.configuration.virtualModelName, "Expert import");
  } finally {
    storage.close();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEmptyEnterpriseState,
  createEnterpriseControlPlane,
  createInMemoryEnterpriseStateRepository,
  type EnterpriseState,
  planPersonalToEnterpriseEnrollment,
} from "./index.js";
import {
  createPostgresqlEnterpriseStateRepository,
  initializePostgresqlEnterpriseStorage,
  type PostgresqlQueryResult,
} from "./postgresql.js";
import { createPrivateFileArtifactStore } from "./private-artifacts.js";

const createPilotState = (): EnterpriseState => ({
  ...createEmptyEnterpriseState(),
  scopes: [
    { id: "tenant-acme", name: "Acme", type: "tenant", parentId: null },
    { id: "org-ai", name: "AI", type: "organization", parentId: "tenant-acme" },
    { id: "team-platform", name: "Platform", type: "team", parentId: "org-ai" },
    { id: "user-alice", name: "Alice", type: "user", parentId: "team-platform" },
  ],
  identities: [
    {
      id: "alice",
      displayName: "Alice",
      roles: ["member"],
      scopeIds: ["user-alice"],
    },
  ],
  policies: [
    {
      id: "block-secrets",
      mode: "mandatory",
      scopeId: "tenant-acme",
      action: "external-secret",
      allow: false,
      reason: "Secrets stay private.",
    },
    {
      id: "prefer-cheap",
      mode: "advisory",
      scopeId: "org-ai",
      action: "model-select",
      allow: true,
      reason: "Prefer the lowest-cost capable model.",
    },
  ],
  capabilities: [
    {
      id: "skill-release",
      kind: "skill",
      name: "Release assistant",
      scopeIds: ["org-ai"],
      private: true,
      version: "1.0.0",
    },
  ],
  resources: [
    {
      id: "company-gpt",
      name: "Company GPT",
      provider: "openai",
      ownership: "enterprise",
      ownerIdentityId: null,
      scopeIds: ["tenant-acme"],
    },
    {
      id: "alice-local",
      name: "Alice local",
      provider: "ollama",
      ownership: "user",
      ownerIdentityId: "alice",
      scopeIds: ["user-alice"],
    },
  ],
  quotaPools: [
    {
      id: "pool-gpt",
      resourceId: "company-gpt",
      scopeId: "tenant-acme",
      capacity: 1000,
      remaining: 1000,
      reserved: 0,
      settled: 0,
      cycleEndsAt: "2026-11-01T00:00:00.000Z",
      shareAfter: "2026-10-31T00:00:00.000Z",
    },
  ],
  quotaAllocations: [
    {
      id: "allocation-platform",
      poolId: "pool-gpt",
      scopeId: "team-platform",
      limit: 700,
      reserved: 0,
      settled: 0,
    },
    {
      id: "allocation-other",
      poolId: "pool-gpt",
      scopeId: "org-ai",
      limit: 300,
      reserved: 0,
      settled: 0,
    },
  ],
});

test("inherits mandatory and advisory policy without hiding allowed capabilities", async () => {
  const controlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(createPilotState()),
  );

  assert.deepEqual(await controlPlane.evaluatePolicy("user-alice", "external-secret"), {
    allowed: false,
    mandatoryPolicyIds: ["block-secrets"],
    advisories: [],
  });
  assert.deepEqual(await controlPlane.evaluatePolicy("user-alice", "model-select"), {
    allowed: true,
    mandatoryPolicyIds: [],
    advisories: ["Prefer the lowest-cost capable model."],
  });
  assert.equal((await controlPlane.listCapabilities("user-alice"))[0]?.id, "skill-release");
  assert.equal(await controlPlane.authorizeIdentity("alice", "user-alice", "member"), true);
  assert.equal(await controlPlane.authorizeIdentity("alice", "user-alice", "administrator"), false);
});

test("combines enterprise-purchased resources with the current user's resources", async () => {
  const controlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(createPilotState()),
  );
  const resources = await controlPlane.listResources("user-alice", "alice");
  assert.deepEqual(
    resources.map((resource) => resource.id),
    ["company-gpt", "alice-local"],
  );
  assert.deepEqual(await controlPlane.listResources("user-alice", "bob"), [resources[0]]);
});

test("reserves, settles, releases, and shares hierarchical quota atomically", async () => {
  const controlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(createPilotState()),
  );
  const reservations = await Promise.all([
    controlPlane.reserveQuota("allocation-platform", "request-1", 100),
    controlPlane.reserveQuota("allocation-platform", "request-2", 200),
  ]);
  assert.equal(reservations.length, 2);
  await controlPlane.settleQuota("request-1", 80);
  await controlPlane.releaseQuota("request-2");
  await assert.rejects(
    controlPlane.shareAllocation("allocation-platform", "allocation-other", 50),
    /not active/u,
  );
  await controlPlane.shareAllocation(
    "allocation-platform",
    "allocation-other",
    50,
    new Date("2026-10-31T00:00:01.000Z"),
  );
  const state = await controlPlane.snapshot();
  assert.deepEqual(state.quotaPools[0], {
    ...createPilotState().quotaPools[0],
    remaining: 920,
    settled: 80,
  });
  assert.equal(state.quotaAllocations[0]?.limit, 650);
  assert.equal(state.quotaAllocations[1]?.limit, 350);
});

test("shows an administrator key once and revokes sessions on rotation", async () => {
  const controlPlane = createEnterpriseControlPlane(
    createInMemoryEnterpriseStateRepository(createPilotState()),
  );
  const firstKey = await controlPlane.initializeAdministratorKey();
  await assert.rejects(controlPlane.initializeAdministratorKey(), /already initialized/u);
  const persistedState = await controlPlane.snapshot();
  assert.equal(JSON.stringify(persistedState).includes(firstKey.key), false);
  const session = await controlPlane.authenticateAdministrator(firstKey.key);
  assert.equal(controlPlane.validateAdministratorSession(session.id), true);
  await controlPlane.rotateAdministratorKey();
  assert.equal(controlPlane.validateAdministratorSession(session.id), false);
  await assert.rejects(controlPlane.authenticateAdministrator(firstKey.key), /failed/u);
  await controlPlane.recoverAdministratorKey(true, "Approved host recovery");
  assert.equal(
    (await controlPlane.snapshot()).securityAudit.at(-1)?.action,
    "administrator-key-host-recovery",
  );
});

test("preflights staged personal-to-enterprise enrollment", () => {
  const blocked = planPersonalToEnterpriseEnrollment({
    runtimeActive: true,
    enterpriseEndpointVerified: false,
    encryptedSnapshotAvailable: true,
  });
  assert.equal(blocked.compatible, false);
  assert.equal(blocked.blockers.length, 2);
  assert.equal(blocked.encryptedSnapshotRequired, true);
});

test("isolates bounded private artifacts by scope", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "tidu-enterprise-artifacts-"));
  try {
    const store = createPrivateFileArtifactStore(rootDirectory);
    await store.put("team-platform", "result.bin", new Uint8Array([1, 2, 3]));
    assert.deepEqual(await store.get("team-platform", "result.bin"), Buffer.from([1, 2, 3]));
    assert.equal(await store.get("org-ai", "result.bin"), undefined);
    assert.equal(await store.delete("team-platform", "result.bin"), true);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("initializes and updates PostgreSQL enterprise state with compare-and-swap", async () => {
  let state = createEmptyEnterpriseState();
  const statements: string[] = [];
  const client = {
    query: async <Row>(statement: string, parameters: readonly unknown[] = []) => {
      statements.push(statement);
      if (statement.includes("RETURNING revision")) {
        if (parameters[2] !== state.revision) {
          return { rows: [], rowCount: 0 } as PostgresqlQueryResult<Row>;
        }
        state = JSON.parse(String(parameters[1])) as EnterpriseState;
        return {
          rows: [{ revision: String(state.revision), state_json: state }] as Row[],
          rowCount: 1,
        };
      }
      if (statement.startsWith("SELECT")) {
        return {
          rows: [{ revision: String(state.revision), state_json: state }] as Row[],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 } as PostgresqlQueryResult<Row>;
    },
  };

  await initializePostgresqlEnterpriseStorage(client);
  const repository = createPostgresqlEnterpriseStateRepository(client);
  const saved = await repository.save(state, 0);
  assert.equal(saved.revision, 1);
  assert.equal((await repository.load()).revision, 1);
  assert.equal(
    statements.some((statement) => statement.includes("JSONB")),
    true,
  );
});

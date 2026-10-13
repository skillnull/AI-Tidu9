import assert from "node:assert/strict";
import test from "node:test";

import type { PostgresqlQueryResult } from "../enterprise/postgresql.js";
import {
  createProviderFailoverExecutor,
  createScalingControlPlane,
  type ScalingTaskRecord,
  type ScalingTaskRequest,
  streamBoundedChunks,
} from "./index.js";
import {
  createPostgresqlScalingTaskStore,
  initializePostgresqlScalingStorage,
} from "./postgresql.js";

const createRequest = (
  id: string,
  tenantId = "tenant-a",
  overrides: Partial<ScalingTaskRequest> = {},
): ScalingTaskRequest => ({
  id,
  tenantId,
  resourceGroup: "general",
  priority: 50,
  maxAttempts: 3,
  memoryBytes: 64 * 1024 * 1024,
  scratchBytes: 128 * 1024 * 1024,
  payloadBytes: 1_024,
  payloadReference: `private://${tenantId}/${id}`,
  ...overrides,
});

test("enforces idempotent admission, tenant isolation, backpressure, and resource bounds", async () => {
  const controlPlane = createScalingControlPlane({
    limits: {
      maxActiveTasks: 2,
      maxTenantActiveTasks: 1,
      maxTaskMemoryBytes: 100 * 1024 * 1024,
    },
  });
  const first = await controlPlane.submit(createRequest("task-1", "tenant-a"));
  assert.equal(first.accepted, true);
  assert.equal((await controlPlane.submit(createRequest("task-1", "tenant-a"))).task.id, "task-1");
  assert.equal(
    (await controlPlane.submit(createRequest("task-2", "tenant-a"))).reason,
    "TENANT_BACKPRESSURE",
  );
  assert.equal((await controlPlane.submit(createRequest("task-3", "tenant-b"))).accepted, true);
  assert.equal(
    (await controlPlane.submit(createRequest("task-4", "tenant-c"))).reason,
    "GLOBAL_BACKPRESSURE",
  );
  assert.equal(await controlPlane.getTask("tenant-b", "task-1"), undefined);
  await assert.rejects(
    controlPlane.submit(
      createRequest("task-large", "tenant-c", { memoryBytes: 100 * 1024 * 1024 + 1 }),
    ),
    /boundary/u,
  );
});

test("keeps admission limits exact under concurrent gateway requests", async () => {
  const controlPlane = createScalingControlPlane({
    limits: { maxActiveTasks: 10, maxTenantActiveTasks: 10 },
  });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, taskIndex) =>
      controlPlane.submit(createRequest(`concurrent-${taskIndex}`)),
    ),
  );
  assert.equal(results.filter((result) => result.accepted).length, 10);
  assert.equal(results.filter((result) => result.reason === "GLOBAL_BACKPRESSURE").length, 40);
});

test("leases fairly across tenants and scales horizontally across workers", async () => {
  const controlPlane = createScalingControlPlane();
  for (const request of [
    createRequest("a-high", "tenant-a", { priority: 100 }),
    createRequest("a-low", "tenant-a", { priority: 1 }),
    createRequest("b", "tenant-b"),
    createRequest("c", "tenant-c"),
  ]) {
    await controlPlane.submit(request);
  }
  for (const workerId of ["worker-1", "worker-2"]) {
    controlPlane.registerWorker({
      id: workerId,
      version: "0.7.0",
      resourceGroups: ["general"],
      tenantIds: [],
      concurrency: 2,
    });
  }

  const leases = [
    await controlPlane.leaseNext("worker-1"),
    await controlPlane.leaseNext("worker-2"),
    await controlPlane.leaseNext("worker-1"),
    await controlPlane.leaseNext("worker-2"),
  ];
  assert.deepEqual(
    leases.map((task) => task?.tenantId),
    ["tenant-a", "tenant-b", "tenant-c", "tenant-a"],
  );
  assert.equal(leases[0]?.id, "a-high");
  assert.equal(
    controlPlane.workers().reduce((total, worker) => total + worker.activeLeaseCount, 0),
    4,
  );
});

test("recovers checkpoints after injected worker failure and expired leases", async () => {
  const baseTime = new Date("2026-10-13T00:00:00.000Z");
  const controlPlane = createScalingControlPlane({ limits: { leaseMilliseconds: 100 } });
  await controlPlane.submit(createRequest("recoverable"), baseTime);
  controlPlane.registerWorker(
    {
      id: "worker-old",
      version: "0.6.0",
      resourceGroups: ["general"],
      tenantIds: [],
      concurrency: 1,
    },
    baseTime,
  );
  controlPlane.registerWorker(
    {
      id: "worker-new",
      version: "0.7.0",
      resourceGroups: ["general"],
      tenantIds: [],
      concurrency: 1,
    },
    baseTime,
  );
  assert.equal((await controlPlane.leaseNext("worker-old", baseTime))?.attempt, 1);
  const retried = await controlPlane.fail(
    "worker-old",
    "recoverable",
    { retryable: true, reason: "injected-crash", checkpoint: "step:2" },
    baseTime,
  );
  assert.equal(retried.status, "queued");
  const recovered = await controlPlane.leaseNext("worker-new", baseTime);
  assert.equal(recovered?.checkpoint, "step:2");
  assert.equal(recovered?.attempt, 2);

  const afterExpiry = new Date(baseTime.getTime() + 101);
  await controlPlane.heartbeatWorker("worker-old", afterExpiry);
  const expiredRecovery = await controlPlane.leaseNext("worker-old", afterExpiry);
  assert.equal(expiredRecovery?.id, "recoverable");
  assert.equal(expiredRecovery?.attempt, 3);
});

test("streams large output in bounded chunks and rejects total overflow", async () => {
  async function* source() {
    yield new Uint8Array(10);
    yield new Uint8Array(5);
  }
  const chunkSizes: number[] = [];
  for await (const chunk of streamBoundedChunks(source(), {
    maxChunkBytes: 4,
    maxTotalBytes: 15,
  })) {
    chunkSizes.push(chunk.byteLength);
  }
  assert.deepEqual(chunkSizes, [4, 4, 2, 4, 1]);
  await assert.rejects(async () => {
    for await (const _chunk of streamBoundedChunks(source(), {
      maxChunkBytes: 8,
      maxTotalBytes: 14,
    })) {
      // Consume the bounded stream.
    }
  }, /total size boundary/u);
});

test("opens provider circuits and fails over without weakening the result", async () => {
  let currentTime = new Date("2026-10-13T00:00:00.000Z");
  let expensiveAttempts = 0;
  const execute = createProviderFailoverExecutor(
    { failureThreshold: 1, cooldownMilliseconds: 1_000 },
    () => currentTime,
  );
  const candidates = () => [
    {
      id: "cheap-primary",
      execute: async () => {
        throw new Error("provider unavailable");
      },
    },
    {
      id: "specialist-fallback",
      execute: async () => {
        expensiveAttempts += 1;
        return "verified-result";
      },
    },
  ];
  assert.deepEqual(await execute(candidates()), {
    providerId: "specialist-fallback",
    result: "verified-result",
  });
  assert.equal((await execute(candidates())).providerId, "specialist-fallback");
  currentTime = new Date(currentTime.getTime() + 1_001);
  assert.equal((await execute(candidates())).providerId, "specialist-fallback");
  assert.equal(expensiveAttempts, 3);
});

test("supports drain-first rolling upgrades and explicit rollback", async () => {
  const controlPlane = createScalingControlPlane();
  controlPlane.registerWorker({
    id: "worker-v6",
    version: "0.6.0",
    resourceGroups: ["general"],
    tenantIds: [],
    concurrency: 1,
  });
  controlPlane.beginRollingUpgrade("0.7.0", 1);
  assert.equal((await controlPlane.evaluateRollingUpgrade())?.status, "pending");
  controlPlane.registerWorker({
    id: "worker-v7",
    version: "0.7.0",
    resourceGroups: ["general"],
    tenantIds: [],
    concurrency: 1,
  });
  assert.equal((await controlPlane.evaluateRollingUpgrade())?.status, "succeeded");
  assert.equal(
    controlPlane.workers().find((worker) => worker.id === "worker-v6")?.status,
    "draining",
  );
  assert.equal(controlPlane.rollbackRollingUpgrade()?.status, "rolled-back");
  assert.equal(
    controlPlane.workers().find((worker) => worker.id === "worker-v6")?.status,
    "active",
  );
});

test("reports metrics-first health and sampled diagnostics without payloads", async () => {
  const controlPlane = createScalingControlPlane({
    diagnosticSampleRate: 1,
    random: () => 0,
    limits: { maxActiveTasks: 1 },
  });
  await controlPlane.submit(createRequest("queued"));
  const health = await controlPlane.health();
  assert.equal(health.status, "unavailable");
  assert.deepEqual(
    health.alerts.map((alert) => alert.code),
    ["NO_ACTIVE_WORKERS", "QUEUE_CAPACITY_HIGH"],
  );
  const metrics = controlPlane.metrics();
  assert.equal(metrics.counters["tasks.accepted"], 1);
  assert.equal(metrics.gauges["tasks.queued"], 1);
  assert.equal(JSON.stringify(metrics).includes("private://"), false);
});

test("sustains a documented multi-tenant scheduler load without losing tasks", async () => {
  const controlPlane = createScalingControlPlane({
    limits: { maxActiveTasks: 1_200, maxTenantActiveTasks: 200 },
  });
  const taskCount = 1_000;
  const admissionResults = await Promise.all(
    Array.from({ length: taskCount }, (_, taskIndex) => {
      const tenantId = `tenant-${taskIndex % 10}`;
      return controlPlane.submit(createRequest(`load-${taskIndex}`, tenantId));
    }),
  );
  assert.equal(
    admissionResults.every((result) => result.accepted),
    true,
  );
  for (let workerIndex = 0; workerIndex < 10; workerIndex += 1) {
    controlPlane.registerWorker({
      id: `load-worker-${workerIndex}`,
      version: "0.7.0",
      resourceGroups: ["general"],
      tenantIds: [],
      concurrency: 100,
    });
  }
  let completedCount = 0;
  while (completedCount < taskCount) {
    const workerId = `load-worker-${completedCount % 10}`;
    const task = await controlPlane.leaseNext(workerId);
    assert.notEqual(task, undefined);
    await controlPlane.complete(workerId, task?.id ?? "missing");
    completedCount += 1;
  }
  assert.equal(controlPlane.metrics().counters["tasks.completed"], taskCount);
  assert.equal((await controlPlane.health()).queuedTaskCount, 0);
});

test("persists scaling tasks through the PostgreSQL compare-and-swap adapter", async () => {
  const statements: string[] = [];
  let storedTask: ScalingTaskRecord | undefined;
  const client = {
    query: async <Row>(statement: string, parameters: readonly unknown[] = []) => {
      statements.push(statement);
      if (statement.includes("INSERT INTO tidu_scaling_tasks")) {
        if (storedTask !== undefined)
          return { rows: [], rowCount: 0 } as PostgresqlQueryResult<Row>;
        storedTask = JSON.parse(String(parameters[6])) as ScalingTaskRecord;
        return { rows: [], rowCount: 1 } as PostgresqlQueryResult<Row>;
      }
      if (statement.includes("SELECT COUNT(*) AS active_count")) {
        const activeCount =
          storedTask?.status === "queued" || storedTask?.status === "leased" ? 1 : 0;
        return {
          rows: [{ active_count: String(activeCount) }] as Row[],
          rowCount: 1,
        };
      }
      if (statement.includes("WHERE task_id = $1") && statement.startsWith("SELECT")) {
        return {
          rows:
            storedTask === undefined
              ? []
              : ([
                  {
                    task_id: storedTask.id,
                    revision: String(storedTask.revision),
                    task_json: storedTask,
                  },
                ] as Row[]),
          rowCount: storedTask === undefined ? 0 : 1,
        };
      }
      if (statement.includes("UPDATE tidu_scaling_tasks")) {
        if (storedTask?.revision !== parameters[7]) {
          return { rows: [], rowCount: 0 } as PostgresqlQueryResult<Row>;
        }
        storedTask = JSON.parse(String(parameters[5])) as ScalingTaskRecord;
        return { rows: [], rowCount: 1 } as PostgresqlQueryResult<Row>;
      }
      return { rows: [], rowCount: 0 } as PostgresqlQueryResult<Row>;
    },
  };
  await initializePostgresqlScalingStorage(client);
  const store = createPostgresqlScalingTaskStore(client);
  const task: ScalingTaskRecord = {
    ...createRequest("postgres-task"),
    revision: 0,
    status: "queued",
    attempt: 0,
    submittedAt: "2026-10-13T00:00:00.000Z",
    availableAt: "2026-10-13T00:00:00.000Z",
    lease: null,
    checkpoint: null,
    outcome: null,
  };
  assert.equal(await store.insert(task), true);
  assert.equal((await store.get(task.id))?.revision, 0);
  const controlPlane = createScalingControlPlane({ store });
  assert.equal((await controlPlane.health()).queuedTaskCount, 1);
  assert.equal(
    statements.some(
      (statement) => statement.includes("available_at <=") && statement.includes("SELECT"),
    ),
    false,
  );
  assert.equal(await store.save({ ...task, revision: 1, status: "completed" }, 0), true);
  assert.equal(
    statements.some((statement) => statement.includes("CREATE INDEX")),
    true,
  );
});

import { randomUUID } from "node:crypto";

import { TiduError } from "../core/index.js";

export type ScalingTaskStatus = "completed" | "failed" | "leased" | "queued";
export type ScalingWorkerStatus = "active" | "draining" | "offline";

export interface ScalingResourceLimits {
  /** Maximum number of queued or leased tasks across all tenants. */
  maxActiveTasks: number;
  /** Maximum number of queued or leased tasks owned by one tenant. */
  maxTenantActiveTasks: number;
  /** Maximum memory reservation accepted for one task. */
  maxTaskMemoryBytes: number;
  /** Maximum scratch-space reservation accepted for one task. */
  maxTaskScratchBytes: number;
  /** Maximum referenced input size accepted for one task. */
  maxTaskPayloadBytes: number;
  /** Duration of a worker lease before checkpoint recovery. */
  leaseMilliseconds: number;
  /** Maximum interval without a worker heartbeat. */
  workerHeartbeatMilliseconds: number;
}

export interface ScalingTaskRequest {
  /** Caller-owned idempotency key. */
  id: string;
  /** Tenant security and fairness boundary. */
  tenantId: string;
  /** Required worker resource group. */
  resourceGroup: string;
  /** Higher values are scheduled first within one tenant. */
  priority: number;
  /** Maximum attempts including the first execution. */
  maxAttempts: number;
  /** Per-task memory reservation. */
  memoryBytes: number;
  /** Per-task scratch-space reservation. */
  scratchBytes: number;
  /** Referenced input size without embedding the input itself. */
  payloadBytes: number;
  /** Opaque private reference resolved only by the assigned worker. */
  payloadReference: string;
}

export interface ScalingTaskLease {
  /** Worker holding the lease. */
  workerId: string;
  /** Time after which another worker may recover the task. */
  expiresAt: string;
}

export interface ScalingTaskRecord extends ScalingTaskRequest {
  /** Optimistic concurrency revision. */
  revision: number;
  /** Current scheduler lifecycle state. */
  status: ScalingTaskStatus;
  /** Number of leases issued so far. */
  attempt: number;
  /** Stable insertion time used for deterministic ordering. */
  submittedAt: string;
  /** Earliest time at which the task may be leased. */
  availableAt: string;
  /** Current worker lease when the task is executing. */
  lease: ScalingTaskLease | null;
  /** Bounded restart checkpoint owned by the task. */
  checkpoint: string | null;
  /** Non-secret terminal or retry reason. */
  outcome: string | null;
}

export interface ScalingTaskStore {
  /** Loads one task by its idempotency key. */
  get: (taskId: string) => Promise<ScalingTaskRecord | undefined>;
  /** Counts queued and leased tasks, optionally for one tenant. */
  countActive: (tenantId?: string) => Promise<number>;
  /** Loads tasks ready for scheduling without transferring completed history. */
  listQueued: (availableBefore: string) => Promise<readonly ScalingTaskRecord[]>;
  /** Loads active leases for worker accounting. */
  listLeased: () => Promise<readonly ScalingTaskRecord[]>;
  /** Loads only leases that require checkpoint recovery. */
  listExpiredLeases: (expiresBefore: string) => Promise<readonly ScalingTaskRecord[]>;
  /** Inserts a task only when its id is unused. */
  insert: (task: ScalingTaskRecord) => Promise<boolean>;
  /** Replaces a task only when the expected revision still matches. */
  save: (task: ScalingTaskRecord, expectedRevision: number) => Promise<boolean>;
}

export interface ScalingWorkerRegistration {
  /** Stable worker instance identifier. */
  id: string;
  /** Worker build version used during rolling upgrades. */
  version: string;
  /** Resource groups executable by this worker. */
  resourceGroups: readonly string[];
  /** Optional tenant allowlist; an empty list accepts every tenant. */
  tenantIds: readonly string[];
  /** Maximum concurrent leases for this worker. */
  concurrency: number;
}

export interface ScalingWorkerState extends ScalingWorkerRegistration {
  /** Current admission state. */
  status: ScalingWorkerStatus;
  /** Last successful heartbeat. */
  lastHeartbeatAt: string;
  /** Number of active leases currently owned by the worker. */
  activeLeaseCount: number;
}

export interface ScalingAdmissionResult {
  /** Whether the task entered the shared queue. */
  accepted: boolean;
  /** Existing or newly created task. */
  task: ScalingTaskRecord;
  /** Stable rejection reason when admission was refused. */
  reason: string | null;
}

export interface ScalingMetricSnapshot {
  /** Monotonic operation counters. */
  counters: Readonly<Record<string, number>>;
  /** Current bounded values. */
  gauges: Readonly<Record<string, number>>;
  /** Sampled metadata-only diagnostic events. */
  diagnostics: readonly ScalingDiagnosticEvent[];
}

export interface ScalingDiagnosticEvent {
  /** Diagnostic category. */
  name: string;
  /** Tenant identifier when safe and relevant. */
  tenantId: string | null;
  /** Event time. */
  recordedAt: string;
}

export interface ScalingAlert {
  /** Stable alert code. */
  code: string;
  /** Operational severity. */
  severity: "critical" | "warning";
  /** Non-secret operator message. */
  message: string;
}

export interface ScalingHealthSnapshot {
  /** Aggregate production-scaling health. */
  status: "degraded" | "healthy" | "unavailable";
  /** Number of active workers. */
  activeWorkerCount: number;
  /** Number of queued tasks. */
  queuedTaskCount: number;
  /** Fraction of the active-task capacity currently consumed. */
  utilization: number;
  /** Actionable alerts. */
  alerts: readonly ScalingAlert[];
}

export interface ScalingRollingUpgrade {
  /** Unique rollout identifier. */
  id: string;
  /** Version that receives new work. */
  targetVersion: string;
  /** Minimum healthy target workers required before draining old workers. */
  minimumReadyWorkers: number;
  /** Current rollout lifecycle. */
  status: "draining" | "pending" | "rolled-back" | "succeeded";
  /** Rollout creation time. */
  startedAt: string;
}

export interface ScalingControlPlaneOptions {
  /** Shared task store; defaults to isolated memory for personal use and tests. */
  store?: ScalingTaskStore;
  /** Admission and resource boundaries. */
  limits?: Partial<ScalingResourceLimits>;
  /** Fraction from zero to one of metadata-only diagnostics retained. */
  diagnosticSampleRate?: number;
  /** Injectable random source for deterministic tests. */
  random?: () => number;
}

export interface ScalingControlPlane {
  /** Idempotently submits a task through the stateless gateway boundary. */
  submit: (request: ScalingTaskRequest, now?: Date) => Promise<ScalingAdmissionResult>;
  /** Returns a tenant-owned task without crossing tenant boundaries. */
  getTask: (tenantId: string, taskId: string) => Promise<ScalingTaskRecord | undefined>;
  /** Registers or refreshes one horizontally scalable worker. */
  registerWorker: (registration: ScalingWorkerRegistration, now?: Date) => ScalingWorkerState;
  /** Refreshes a worker heartbeat and active-lease count. */
  heartbeatWorker: (workerId: string, now?: Date) => Promise<ScalingWorkerState>;
  /** Prevents a worker from receiving new leases. */
  drainWorker: (workerId: string) => ScalingWorkerState;
  /** Leases the next fair, compatible task. */
  leaseNext: (workerId: string, now?: Date) => Promise<ScalingTaskRecord | undefined>;
  /** Completes a task only for its current lease holder. */
  complete: (workerId: string, taskId: string, outcome?: string) => Promise<ScalingTaskRecord>;
  /** Fails or checkpoint-requeues a leased task. */
  fail: (
    workerId: string,
    taskId: string,
    options: { checkpoint?: string; reason: string; retryable: boolean; retryDelayMs?: number },
    now?: Date,
  ) => Promise<ScalingTaskRecord>;
  /** Starts a drain-first rolling upgrade. */
  beginRollingUpgrade: (
    targetVersion: string,
    minimumReadyWorkers: number,
    now?: Date,
  ) => ScalingRollingUpgrade;
  /** Advances the current rollout from live worker health. */
  evaluateRollingUpgrade: (now?: Date) => Promise<ScalingRollingUpgrade | null>;
  /** Restores old workers and drains target workers. */
  rollbackRollingUpgrade: () => ScalingRollingUpgrade | null;
  /** Returns metrics without task payloads or tool output. */
  metrics: () => ScalingMetricSnapshot;
  /** Computes queue, capacity, and heartbeat health. */
  health: (now?: Date) => Promise<ScalingHealthSnapshot>;
  /** Lists current workers for administration and autoscaling. */
  workers: () => readonly ScalingWorkerState[];
}

export interface StatelessScalingGateway {
  /** Idempotently admits one tenant task. */
  submit: ScalingControlPlane["submit"];
  /** Reads one task through its tenant boundary. */
  getTask: ScalingControlPlane["getTask"];
  /** Reads aggregate health without worker or payload details. */
  health: ScalingControlPlane["health"];
}

export interface ScalingWorkerClient {
  /** Registered worker identity. */
  id: string;
  /** Refreshes worker liveness. */
  heartbeat: (now?: Date) => Promise<ScalingWorkerState>;
  /** Leases at most one compatible task. */
  lease: (now?: Date) => Promise<ScalingTaskRecord | undefined>;
  /** Completes a currently owned task. */
  complete: (taskId: string, outcome?: string) => Promise<ScalingTaskRecord>;
  /** Checkpoint-fails a currently owned task. */
  fail: (
    taskId: string,
    options: { checkpoint?: string; reason: string; retryable: boolean; retryDelayMs?: number },
    now?: Date,
  ) => Promise<ScalingTaskRecord>;
  /** Stops accepting new work while active leases finish. */
  drain: () => ScalingWorkerState;
}

const DEFAULT_LIMITS: ScalingResourceLimits = Object.freeze({
  maxActiveTasks: 10_000,
  maxTenantActiveTasks: 1_000,
  maxTaskMemoryBytes: 512 * 1024 * 1024,
  maxTaskScratchBytes: 2 * 1024 * 1024 * 1024,
  maxTaskPayloadBytes: 64 * 1024 * 1024,
  leaseMilliseconds: 60_000,
  workerHeartbeatMilliseconds: 30_000,
});

const cloneTask = (task: ScalingTaskRecord): ScalingTaskRecord => structuredClone(task);
const cloneWorker = (worker: ScalingWorkerState): ScalingWorkerState => structuredClone(worker);
const isActiveTask = (task: ScalingTaskRecord) =>
  task.status === "queued" || task.status === "leased";

export const createInMemoryScalingTaskStore = (): ScalingTaskStore => {
  const tasks = new Map<string, ScalingTaskRecord>();
  return {
    get: async (taskId) => {
      const task = tasks.get(taskId);
      return task === undefined ? undefined : cloneTask(task);
    },
    countActive: async (tenantId) =>
      [...tasks.values()].filter(
        (task) => isActiveTask(task) && (tenantId === undefined || task.tenantId === tenantId),
      ).length,
    listQueued: async (availableBefore) =>
      [...tasks.values()]
        .filter(
          (task) =>
            task.status === "queued" && Date.parse(task.availableAt) <= Date.parse(availableBefore),
        )
        .map(cloneTask),
    listLeased: async () =>
      [...tasks.values()].filter((task) => task.status === "leased").map(cloneTask),
    listExpiredLeases: async (expiresBefore) =>
      [...tasks.values()]
        .filter(
          (task) =>
            task.status === "leased" &&
            task.lease !== null &&
            task.lease.expiresAt <= expiresBefore,
        )
        .map(cloneTask),
    insert: async (task) => {
      if (tasks.has(task.id)) return false;
      tasks.set(task.id, cloneTask(task));
      return true;
    },
    save: async (task, expectedRevision) => {
      const current = tasks.get(task.id);
      if (current === undefined || current.revision !== expectedRevision) return false;
      tasks.set(task.id, cloneTask(task));
      return true;
    },
  };
};

const assertIdentifier = (value: string, field: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value)) {
    throw new TiduError("CONFIGURATION_INVALID", `${field} is invalid.`);
  }
};

const assertPositiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TiduError("CONFIGURATION_INVALID", `${field} must be a positive integer.`);
  }
};

const createMetrics = (sampleRate: number, random: () => number) => {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const diagnostics: ScalingDiagnosticEvent[] = [];
  return {
    increment: (name: string) => counters.set(name, (counters.get(name) ?? 0) + 1),
    gauge: (name: string, value: number) => gauges.set(name, value),
    diagnose: (name: string, tenantId: string | null, now: Date) => {
      if (random() >= sampleRate) return;
      diagnostics.push({ name, tenantId, recordedAt: now.toISOString() });
      if (diagnostics.length > 100) diagnostics.shift();
    },
    snapshot: (): ScalingMetricSnapshot => ({
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      diagnostics: structuredClone(diagnostics),
    }),
  };
};

const validateRequest = (request: ScalingTaskRequest, limits: ScalingResourceLimits) => {
  assertIdentifier(request.id, "Task id");
  assertIdentifier(request.tenantId, "Tenant id");
  assertIdentifier(request.resourceGroup, "Resource group");
  assertPositiveInteger(request.maxAttempts, "Maximum attempts");
  for (const [field, value, maximum] of [
    ["Task memory", request.memoryBytes, limits.maxTaskMemoryBytes],
    ["Task scratch space", request.scratchBytes, limits.maxTaskScratchBytes],
    ["Task payload", request.payloadBytes, limits.maxTaskPayloadBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new TiduError("CONFIGURATION_INVALID", `${field} exceeds its configured boundary.`);
    }
  }
  if (!Number.isSafeInteger(request.priority) || request.priority < 0 || request.priority > 100) {
    throw new TiduError("CONFIGURATION_INVALID", "Task priority must be from 0 to 100.");
  }
  if (request.payloadReference.length < 1 || request.payloadReference.length > 1_024) {
    throw new TiduError("CONFIGURATION_INVALID", "Payload reference is invalid.");
  }
};

const withRevision = (task: ScalingTaskRecord, changes: Partial<ScalingTaskRecord>) => ({
  ...task,
  ...changes,
  revision: task.revision + 1,
});

export const createScalingControlPlane = (
  options: ScalingControlPlaneOptions = {},
): ScalingControlPlane => {
  const store = options.store ?? createInMemoryScalingTaskStore();
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  const sampleRate = options.diagnosticSampleRate ?? 0.01;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new TiduError("CONFIGURATION_INVALID", "Diagnostic sample rate must be from 0 to 1.");
  }
  const metricState = createMetrics(sampleRate, options.random ?? Math.random);
  const workerStates = new Map<string, ScalingWorkerState>();
  let lastTenantId: string | null = null;
  let rollingUpgrade: ScalingRollingUpgrade | null = null;
  let admissionTail: Promise<void> = Promise.resolve();

  const withAdmissionLock = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const previousAdmission = admissionTail;
    let releaseAdmission: () => void = () => undefined;
    admissionTail = new Promise<void>((resolveAdmission) => {
      releaseAdmission = resolveAdmission;
    });
    await previousAdmission;
    try {
      return await operation();
    } finally {
      releaseAdmission();
    }
  };

  const saveOrThrow = async (task: ScalingTaskRecord, expectedRevision: number) => {
    if (!(await store.save(task, expectedRevision))) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Task state changed concurrently.");
    }
    return cloneTask(task);
  };

  const expireLeases = async (now: Date) => {
    const currentTasks = await store.listExpiredLeases(now.toISOString());
    for (const task of currentTasks) {
      if (
        task.status === "leased" &&
        task.lease !== null &&
        Date.parse(task.lease.expiresAt) <= now.getTime()
      ) {
        const exhausted = task.attempt >= task.maxAttempts;
        const recovered = withRevision(task, {
          status: exhausted ? "failed" : "queued",
          lease: null,
          availableAt: now.toISOString(),
          outcome: exhausted
            ? "Lease expired after maximum attempts."
            : "Lease expired; recovered.",
        });
        if (await store.save(recovered, task.revision)) {
          metricState.increment(exhausted ? "tasks.failed" : "tasks.recovered");
        }
      }
    }
  };

  const refreshWorkerLeaseCounts = async () => {
    const currentTasks = await store.listLeased();
    const leaseCounts = new Map<string, number>();
    for (const task of currentTasks) {
      if (task.status === "leased" && task.lease !== null) {
        leaseCounts.set(task.lease.workerId, (leaseCounts.get(task.lease.workerId) ?? 0) + 1);
      }
    }
    for (const [workerId, worker] of workerStates) {
      workerStates.set(workerId, { ...worker, activeLeaseCount: leaseCounts.get(workerId) ?? 0 });
    }
  };

  const controlPlane: ScalingControlPlane = {
    submit: async (request, now = new Date()) => {
      validateRequest(request, limits);
      return withAdmissionLock(async () => {
        const existing = await store.get(request.id);
        if (existing !== undefined) {
          if (existing.tenantId !== request.tenantId) {
            throw new TiduError("CONFIGURATION_CONFLICT", "Task id belongs to another tenant.");
          }
          return { accepted: true, task: existing, reason: null };
        }
        const [activeTaskCount, tenantActiveCount] = await Promise.all([
          store.countActive(),
          store.countActive(request.tenantId),
        ]);
        const timestamp = now.toISOString();
        const task: ScalingTaskRecord = {
          ...structuredClone(request),
          revision: 0,
          status: "queued",
          attempt: 0,
          submittedAt: timestamp,
          availableAt: timestamp,
          lease: null,
          checkpoint: null,
          outcome: null,
        };
        const reason =
          activeTaskCount >= limits.maxActiveTasks
            ? "GLOBAL_BACKPRESSURE"
            : tenantActiveCount >= limits.maxTenantActiveTasks
              ? "TENANT_BACKPRESSURE"
              : null;
        if (reason !== null) {
          metricState.increment("tasks.rejected");
          metricState.diagnose(reason, request.tenantId, now);
          return { accepted: false, task, reason };
        }
        if (!(await store.insert(task))) {
          const concurrent = await store.get(request.id);
          if (concurrent === undefined || concurrent.tenantId !== request.tenantId) {
            throw new TiduError("CONFIGURATION_CONFLICT", "Task id was claimed concurrently.");
          }
          return { accepted: true, task: concurrent, reason: null };
        }
        metricState.increment("tasks.accepted");
        return { accepted: true, task, reason: null };
      });
    },
    getTask: async (tenantId, taskId) => {
      assertIdentifier(tenantId, "Tenant id");
      const task = await store.get(taskId);
      return task?.tenantId === tenantId ? task : undefined;
    },
    registerWorker: (registration, now = new Date()) => {
      assertIdentifier(registration.id, "Worker id");
      assertPositiveInteger(registration.concurrency, "Worker concurrency");
      if (registration.resourceGroups.length === 0) {
        throw new TiduError("CONFIGURATION_INVALID", "Worker requires a resource group.");
      }
      const worker: ScalingWorkerState = {
        ...structuredClone(registration),
        status: "active",
        lastHeartbeatAt: now.toISOString(),
        activeLeaseCount: workerStates.get(registration.id)?.activeLeaseCount ?? 0,
      };
      workerStates.set(worker.id, worker);
      metricState.increment("workers.registered");
      return cloneWorker(worker);
    },
    heartbeatWorker: async (workerId, now = new Date()) => {
      const worker = workerStates.get(workerId);
      if (worker === undefined) throw new TiduError("CONFIGURATION_INVALID", "Worker is unknown.");
      await refreshWorkerLeaseCounts();
      const current = workerStates.get(workerId) ?? worker;
      const refreshed = { ...current, lastHeartbeatAt: now.toISOString() };
      workerStates.set(workerId, refreshed);
      return cloneWorker(refreshed);
    },
    drainWorker: (workerId) => {
      const worker = workerStates.get(workerId);
      if (worker === undefined) throw new TiduError("CONFIGURATION_INVALID", "Worker is unknown.");
      const draining = { ...worker, status: "draining" as const };
      workerStates.set(workerId, draining);
      return cloneWorker(draining);
    },
    leaseNext: async (workerId, now = new Date()) => {
      await expireLeases(now);
      await refreshWorkerLeaseCounts();
      const worker = workerStates.get(workerId);
      if (worker === undefined || worker.status !== "active") return undefined;
      if (
        now.getTime() - Date.parse(worker.lastHeartbeatAt) > limits.workerHeartbeatMilliseconds ||
        worker.activeLeaseCount >= worker.concurrency
      ) {
        return undefined;
      }
      const tasks = (await store.listQueued(now.toISOString())).filter(
        (task) =>
          worker.resourceGroups.includes(task.resourceGroup) &&
          (worker.tenantIds.length === 0 || worker.tenantIds.includes(task.tenantId)),
      );
      const tenantIds = [...new Set(tasks.map((task) => task.tenantId))].sort();
      if (tenantIds.length === 0) return undefined;
      const previousTenantId = lastTenantId;
      const selectedTenantId =
        previousTenantId === null
          ? tenantIds[0]
          : (tenantIds.find((tenantId) => tenantId > previousTenantId) ?? tenantIds[0]);
      if (selectedTenantId === undefined) return undefined;
      const selectedTask = tasks
        .filter((task) => task.tenantId === selectedTenantId)
        .sort(
          (leftTask, rightTask) =>
            rightTask.priority - leftTask.priority ||
            leftTask.submittedAt.localeCompare(rightTask.submittedAt) ||
            leftTask.id.localeCompare(rightTask.id),
        )[0];
      if (selectedTask === undefined) return undefined;
      const leased = withRevision(selectedTask, {
        status: "leased",
        attempt: selectedTask.attempt + 1,
        lease: {
          workerId,
          expiresAt: new Date(now.getTime() + limits.leaseMilliseconds).toISOString(),
        },
        outcome: null,
      });
      if (!(await store.save(leased, selectedTask.revision))) {
        metricState.increment("leases.conflicted");
        return controlPlane.leaseNext(workerId, now);
      }
      lastTenantId = selectedTenantId;
      workerStates.set(workerId, { ...worker, activeLeaseCount: worker.activeLeaseCount + 1 });
      metricState.increment("tasks.leased");
      return cloneTask(leased);
    },
    complete: async (workerId, taskId, outcome = "Completed.") => {
      const task = await store.get(taskId);
      if (task?.status !== "leased" || task.lease?.workerId !== workerId) {
        throw new TiduError("CONFIGURATION_CONFLICT", "Worker does not own the task lease.");
      }
      const completed = await saveOrThrow(
        withRevision(task, { status: "completed", lease: null, outcome }),
        task.revision,
      );
      await refreshWorkerLeaseCounts();
      metricState.increment("tasks.completed");
      return completed;
    },
    fail: async (workerId, taskId, failure, now = new Date()) => {
      const task = await store.get(taskId);
      if (task?.status !== "leased" || task.lease?.workerId !== workerId) {
        throw new TiduError("CONFIGURATION_CONFLICT", "Worker does not own the task lease.");
      }
      if (failure.checkpoint !== undefined && Buffer.byteLength(failure.checkpoint) > 64 * 1024) {
        throw new TiduError("CONFIGURATION_INVALID", "Checkpoint exceeds 64 KB.");
      }
      const retryable = failure.retryable && task.attempt < task.maxAttempts;
      const failed = await saveOrThrow(
        withRevision(task, {
          status: retryable ? "queued" : "failed",
          lease: null,
          checkpoint: failure.checkpoint ?? task.checkpoint,
          availableAt: new Date(now.getTime() + (failure.retryDelayMs ?? 0)).toISOString(),
          outcome: failure.reason,
        }),
        task.revision,
      );
      await refreshWorkerLeaseCounts();
      metricState.increment(retryable ? "tasks.retried" : "tasks.failed");
      metricState.diagnose(retryable ? "task-retry" : "task-failure", task.tenantId, now);
      return failed;
    },
    beginRollingUpgrade: (targetVersion, minimumReadyWorkers, now = new Date()) => {
      assertIdentifier(targetVersion, "Target version");
      assertPositiveInteger(minimumReadyWorkers, "Minimum ready workers");
      rollingUpgrade = {
        id: randomUUID(),
        targetVersion,
        minimumReadyWorkers,
        status: "pending",
        startedAt: now.toISOString(),
      };
      return structuredClone(rollingUpgrade);
    },
    evaluateRollingUpgrade: async (now = new Date()) => {
      if (rollingUpgrade === null || ["rolled-back", "succeeded"].includes(rollingUpgrade.status)) {
        return rollingUpgrade === null ? null : structuredClone(rollingUpgrade);
      }
      await refreshWorkerLeaseCounts();
      const healthyTargetWorkers = [...workerStates.values()].filter(
        (worker) =>
          worker.version === rollingUpgrade?.targetVersion &&
          worker.status === "active" &&
          now.getTime() - Date.parse(worker.lastHeartbeatAt) <= limits.workerHeartbeatMilliseconds,
      );
      if (healthyTargetWorkers.length < rollingUpgrade.minimumReadyWorkers) {
        return structuredClone(rollingUpgrade);
      }
      for (const [workerId, worker] of workerStates) {
        if (worker.version !== rollingUpgrade.targetVersion && worker.status === "active") {
          workerStates.set(workerId, { ...worker, status: "draining" });
        }
      }
      const oldWorkersBusy = [...workerStates.values()].some(
        (worker) => worker.version !== rollingUpgrade?.targetVersion && worker.activeLeaseCount > 0,
      );
      rollingUpgrade = {
        ...rollingUpgrade,
        status: oldWorkersBusy ? "draining" : "succeeded",
      };
      metricState.increment(`rollouts.${rollingUpgrade.status}`);
      return structuredClone(rollingUpgrade);
    },
    rollbackRollingUpgrade: () => {
      if (rollingUpgrade === null) return null;
      for (const [workerId, worker] of workerStates) {
        workerStates.set(workerId, {
          ...worker,
          status: worker.version === rollingUpgrade.targetVersion ? "draining" : "active",
        });
      }
      rollingUpgrade = { ...rollingUpgrade, status: "rolled-back" };
      metricState.increment("rollouts.rolled-back");
      return structuredClone(rollingUpgrade);
    },
    metrics: () => metricState.snapshot(),
    health: async (now = new Date()) => {
      await expireLeases(now);
      await refreshWorkerLeaseCounts();
      const [activeTaskCount, leasedTasks] = await Promise.all([
        store.countActive(),
        store.listLeased(),
      ]);
      const queuedTaskCount = Math.max(0, activeTaskCount - leasedTasks.length);
      const activeWorkers = [...workerStates.values()].filter(
        (worker) =>
          worker.status === "active" &&
          now.getTime() - Date.parse(worker.lastHeartbeatAt) <= limits.workerHeartbeatMilliseconds,
      );
      const alerts: ScalingAlert[] = [];
      if (activeWorkers.length === 0 && queuedTaskCount > 0) {
        alerts.push({
          code: "NO_ACTIVE_WORKERS",
          severity: "critical",
          message: "Queued tasks have no healthy active workers.",
        });
      }
      const utilization = activeTaskCount / limits.maxActiveTasks;
      if (utilization >= 0.8) {
        alerts.push({
          code: "QUEUE_CAPACITY_HIGH",
          severity: utilization >= 1 ? "critical" : "warning",
          message: "Active task capacity is at or above 80 percent.",
        });
      }
      metricState.gauge("tasks.active", activeTaskCount);
      metricState.gauge("tasks.queued", queuedTaskCount);
      metricState.gauge("workers.active", activeWorkers.length);
      return {
        status: alerts.some((alert) => alert.severity === "critical")
          ? "unavailable"
          : alerts.length > 0
            ? "degraded"
            : "healthy",
        activeWorkerCount: activeWorkers.length,
        queuedTaskCount,
        utilization,
        alerts,
      };
    },
    workers: () => [...workerStates.values()].map(cloneWorker),
  };
  return controlPlane;
};

export const createStatelessScalingGateway = (
  controlPlane: ScalingControlPlane,
): StatelessScalingGateway => ({
  submit: controlPlane.submit,
  getTask: controlPlane.getTask,
  health: controlPlane.health,
});

export const createScalingWorkerClient = (
  controlPlane: ScalingControlPlane,
  registration: ScalingWorkerRegistration,
  now = new Date(),
): ScalingWorkerClient => {
  const registered = controlPlane.registerWorker(registration, now);
  return {
    id: registered.id,
    heartbeat: (heartbeatTime) => controlPlane.heartbeatWorker(registered.id, heartbeatTime),
    lease: (leaseTime) => controlPlane.leaseNext(registered.id, leaseTime),
    complete: (taskId, outcome) => controlPlane.complete(registered.id, taskId, outcome),
    fail: (taskId, options, failureTime) =>
      controlPlane.fail(registered.id, taskId, options, failureTime),
    drain: () => controlPlane.drainWorker(registered.id),
  };
};

export interface ProviderCandidate<Result> {
  /** Provider identifier used by the circuit breaker. */
  id: string;
  /** Executes one provider attempt. */
  execute: () => Promise<Result>;
}

export interface ProviderFailoverOptions {
  /** Consecutive failures that open one provider circuit. */
  failureThreshold: number;
  /** Time before an open circuit allows a half-open probe. */
  cooldownMilliseconds: number;
}

export interface ProviderFailoverResult<Result> {
  /** Provider that completed the request. */
  providerId: string;
  /** Provider result. */
  result: Result;
}

export const createProviderFailoverExecutor = (
  options: ProviderFailoverOptions,
  now: () => Date = () => new Date(),
) => {
  assertPositiveInteger(options.failureThreshold, "Failure threshold");
  assertPositiveInteger(options.cooldownMilliseconds, "Circuit cooldown");
  const states = new Map<string, { failures: number; openedAt: number | null }>();
  return async <Result>(
    candidates: readonly ProviderCandidate<Result>[],
  ): Promise<ProviderFailoverResult<Result>> => {
    const errors: unknown[] = [];
    for (const candidate of candidates) {
      const state = states.get(candidate.id) ?? { failures: 0, openedAt: null };
      if (
        state.openedAt !== null &&
        now().getTime() - state.openedAt < options.cooldownMilliseconds
      ) {
        continue;
      }
      try {
        const result = await candidate.execute();
        states.set(candidate.id, { failures: 0, openedAt: null });
        return { providerId: candidate.id, result };
      } catch (error) {
        errors.push(error);
        const failures = state.failures + 1;
        states.set(candidate.id, {
          failures,
          openedAt: failures >= options.failureThreshold ? now().getTime() : null,
        });
      }
    }
    throw new AggregateError(errors, "Every available provider failed or has an open circuit.");
  };
};

export interface BoundedStreamOptions {
  /** Maximum yielded chunk size. */
  maxChunkBytes: number;
  /** Maximum total size accepted from the source. */
  maxTotalBytes: number;
}

export async function* streamBoundedChunks(
  source: AsyncIterable<Uint8Array>,
  options: BoundedStreamOptions,
): AsyncGenerator<Uint8Array> {
  assertPositiveInteger(options.maxChunkBytes, "Maximum chunk size");
  assertPositiveInteger(options.maxTotalBytes, "Maximum stream size");
  let totalBytes = 0;
  for await (const sourceChunk of source) {
    totalBytes += sourceChunk.byteLength;
    if (totalBytes > options.maxTotalBytes) {
      throw new TiduError("CONFIGURATION_INVALID", "Stream exceeds its total size boundary.");
    }
    for (let offset = 0; offset < sourceChunk.byteLength; offset += options.maxChunkBytes) {
      yield sourceChunk.subarray(offset, offset + options.maxChunkBytes);
    }
  }
}

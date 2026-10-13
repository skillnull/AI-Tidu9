import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const ENTERPRISE_CONTRACT_VERSION = "tidu-enterprise/1" as const;

export type EnterpriseScopeType = "organization" | "project" | "team" | "tenant" | "user";
export type EnterpriseRole = "administrator" | "auditor" | "member" | "operator";
export type EnterprisePolicyMode = "advisory" | "mandatory";
export type EnterpriseResourceOwnership = "enterprise" | "user";

export interface EnterpriseScope {
  /** Stable scope identifier. */
  id: string;
  /** Human-readable scope name. */
  name: string;
  /** Scope level used by inheritance checks. */
  type: EnterpriseScopeType;
  /** Parent scope identifier; null only for a tenant root. */
  parentId: string | null;
}

export interface EnterpriseIdentity {
  /** Stable identity supplied by the configured identity provider. */
  id: string;
  /** Non-secret display name. */
  displayName: string;
  /** Roles granted to this identity. */
  roles: readonly EnterpriseRole[];
  /** Scope identifiers visible to this identity. */
  scopeIds: readonly string[];
}

export interface EnterprisePolicy {
  /** Stable policy identifier. */
  id: string;
  /** Policy mode; mandatory policies cannot be bypassed by a user. */
  mode: EnterprisePolicyMode;
  /** Scope where the policy starts applying. */
  scopeId: string;
  /** Action matched by the policy. */
  action: string;
  /** Whether a matching mandatory policy permits the action. */
  allow: boolean;
  /** Explanation safe to return to an authenticated user. */
  reason: string;
}

export interface EnterprisePolicyDecision {
  /** Whether mandatory policy permits execution. */
  allowed: boolean;
  /** Matching mandatory policy identifiers. */
  mandatoryPolicyIds: readonly string[];
  /** Matching advisory policy messages. */
  advisories: readonly string[];
}

export interface EnterpriseCapability {
  /** Stable catalog identifier. */
  id: string;
  /** Capability kind rendered in employee guidance. */
  kind: "agent" | "knowledge" | "mcp" | "skill" | "tool";
  /** Human-readable capability name. */
  name: string;
  /** Scope identifiers allowed to discover the capability. */
  scopeIds: readonly string[];
  /** Whether capability content must remain inside the private boundary. */
  private: boolean;
  /** Published capability revision. */
  version: string;
}

export interface EnterpriseModelResource {
  /** Stable model-resource identifier. */
  id: string;
  /** Display name shown to eligible users. */
  name: string;
  /** Model provider identifier. */
  provider: string;
  /** Ownership used for quota attribution. */
  ownership: EnterpriseResourceOwnership;
  /** Owner identity for user-owned resources; null for enterprise resources. */
  ownerIdentityId: string | null;
  /** Scope identifiers allowed to select the resource. */
  scopeIds: readonly string[];
}

export interface EnterpriseQuotaPool {
  /** Stable quota-pool identifier. */
  id: string;
  /** Model resource funded by this pool. */
  resourceId: string;
  /** Scope that owns this pool. */
  scopeId: string;
  /** Total units purchased for the current cycle. */
  capacity: number;
  /** Units still available for reservation. */
  remaining: number;
  /** Units held by active reservations. */
  reserved: number;
  /** Units settled during the current cycle. */
  settled: number;
  /** ISO timestamp when the current cycle ends. */
  cycleEndsAt: string;
  /** ISO timestamp after which unused allocations may be shared. */
  shareAfter: string;
}

export interface EnterpriseQuotaAllocation {
  /** Stable allocation identifier. */
  id: string;
  /** Parent quota-pool identifier. */
  poolId: string;
  /** Scope receiving this allocation. */
  scopeId: string;
  /** Maximum units this scope may consume in the cycle. */
  limit: number;
  /** Units currently reserved by this scope. */
  reserved: number;
  /** Units already settled by this scope. */
  settled: number;
}

export interface EnterpriseQuotaReservation {
  /** Idempotency identifier supplied by the caller. */
  id: string;
  /** Allocation used for this reservation. */
  allocationId: string;
  /** Reserved units. */
  units: number;
  /** Reservation lifecycle state. */
  status: "released" | "reserved" | "settled";
  /** ISO timestamp of the latest transition. */
  updatedAt: string;
}

export interface EnterpriseAdminKeyRecord {
  /** Key generation identifier. */
  id: string;
  /** Hex-encoded independent salt. */
  salt: string;
  /** Hex-encoded irreversible scrypt verifier. */
  verifier: string;
  /** Verifier algorithm version. */
  algorithm: "scrypt-v1";
  /** ISO timestamp when this key generation was created. */
  createdAt: string;
  /** ISO timestamp when this generation was revoked, or null while active. */
  revokedAt: string | null;
}

export interface EnterpriseSecurityAuditEvent {
  /** Stable audit-event identifier. */
  id: string;
  /** Security event category. */
  action: "administrator-key-host-recovery" | "administrator-key-rotation";
  /** Non-secret reason supplied by the authorized operator. */
  reason: string;
  /** ISO timestamp when the event occurred. */
  createdAt: string;
}

export interface EnterpriseState {
  /** Stable enterprise-state contract. */
  contractVersion: typeof ENTERPRISE_CONTRACT_VERSION;
  /** Optimistic persistence revision. */
  revision: number;
  /** Configured organization scopes. */
  scopes: readonly EnterpriseScope[];
  /** Enterprise identities and role assignments. */
  identities: readonly EnterpriseIdentity[];
  /** Mandatory and advisory policies. */
  policies: readonly EnterprisePolicy[];
  /** Published internal capability catalog. */
  capabilities: readonly EnterpriseCapability[];
  /** Enterprise-purchased and user-owned model resources. */
  resources: readonly EnterpriseModelResource[];
  /** Hierarchical quota pools. */
  quotaPools: readonly EnterpriseQuotaPool[];
  /** Per-scope allocations inside quota pools. */
  quotaAllocations: readonly EnterpriseQuotaAllocation[];
  /** Idempotent quota reservations. */
  quotaReservations: readonly EnterpriseQuotaReservation[];
  /** Active administrator key generation, or null before initialization. */
  administratorKey: EnterpriseAdminKeyRecord | null;
  /** Append-only security events retained for administrator-key operations. */
  securityAudit: readonly EnterpriseSecurityAuditEvent[];
  /** Monotonic employee-guidance revision. */
  guidanceRevision: number;
}

export interface EnterpriseStateRepository {
  /** Loads the current state. */
  load: () => Promise<EnterpriseState>;
  /** Saves only when the expected revision still matches. */
  save: (state: EnterpriseState, expectedRevision: number) => Promise<EnterpriseState>;
}

export interface EnterpriseAdminSession {
  /** Opaque session identifier. */
  id: string;
  /** Administrator-key generation that authenticated the session. */
  keyId: string;
  /** ISO expiration timestamp. */
  expiresAt: string;
}

export interface EnterpriseGuidance {
  /** Guidance version tied to the published enterprise configuration. */
  version: number;
  /** Administrator deployment and access steps. */
  administrator: readonly string[];
  /** Employee onboarding steps for enabled clients. */
  employee: readonly string[];
}

export interface EnterpriseEnrollmentPlan {
  /** Whether the personal configuration can be enrolled without destructive changes. */
  compatible: boolean;
  /** Compatibility blockers found during preflight. */
  blockers: readonly string[];
  /** Ordered staged-activation steps. */
  steps: readonly string[];
  /** Whether an encrypted local rollback snapshot is required. */
  encryptedSnapshotRequired: true;
}

export interface EnterprisePrivateArtifactStore {
  /** Saves encrypted or already protected artifact bytes inside the private boundary. */
  put: (scopeId: string, artifactId: string, content: Uint8Array) => Promise<void>;
  /** Loads artifact bytes only for an authorized scope. */
  get: (scopeId: string, artifactId: string) => Promise<Uint8Array | undefined>;
  /** Deletes one owned artifact. */
  delete: (scopeId: string, artifactId: string) => Promise<boolean>;
}

export interface EnterpriseControlPlane {
  /** Reads a detached state snapshot. */
  snapshot: () => Promise<EnterpriseState>;
  /** Authorizes one identity role inside an inherited organization scope. */
  authorizeIdentity: (
    identityId: string,
    scopeId: string,
    requiredRole: EnterpriseRole,
  ) => Promise<boolean>;
  /** Publishes a validated enterprise state update. */
  publish: (
    update: Omit<EnterpriseState, "contractVersion" | "revision">,
  ) => Promise<EnterpriseState>;
  /** Evaluates inherited mandatory and advisory policy. */
  evaluatePolicy: (scopeId: string, action: string) => Promise<EnterprisePolicyDecision>;
  /** Lists capabilities visible from one scope. */
  listCapabilities: (scopeId: string) => Promise<readonly EnterpriseCapability[]>;
  /** Lists enterprise and eligible user-owned model resources. */
  listResources: (
    scopeId: string,
    identityId: string,
  ) => Promise<readonly EnterpriseModelResource[]>;
  /** Reserves quota atomically and idempotently. */
  reserveQuota: (
    allocationId: string,
    reservationId: string,
    units: number,
  ) => Promise<EnterpriseQuotaReservation>;
  /** Settles an existing quota reservation. */
  settleQuota: (reservationId: string, actualUnits: number) => Promise<EnterpriseQuotaReservation>;
  /** Releases an unsettled quota reservation. */
  releaseQuota: (reservationId: string) => Promise<EnterpriseQuotaReservation>;
  /** Shares unused allocation after the configured end-of-cycle threshold. */
  shareAllocation: (
    sourceAllocationId: string,
    targetAllocationId: string,
    units: number,
    now?: Date,
  ) => Promise<EnterpriseState>;
  /** Initializes or rotates the one-time administrator access key. */
  initializeAdministratorKey: () => Promise<{ key: string; record: EnterpriseAdminKeyRecord }>;
  /** Rotates the administrator key after an authenticated session. */
  rotateAdministratorKey: () => Promise<{ key: string; record: EnterpriseAdminKeyRecord }>;
  /** Performs an explicitly authorized server-host key recovery and records an audit event. */
  recoverAdministratorKey: (
    hostAuthorized: boolean,
    reason: string,
  ) => Promise<{ key: string; record: EnterpriseAdminKeyRecord }>;
  /** Authenticates a new short-lived administrator session. */
  authenticateAdministrator: (key: string, now?: Date) => Promise<EnterpriseAdminSession>;
  /** Revokes every locally issued administrator session. */
  revokeAdministratorSessions: () => void;
  /** Validates a locally issued administrator session. */
  validateAdministratorSession: (sessionId: string, now?: Date) => boolean;
  /** Generates administrator and employee guidance from live configuration. */
  generateGuidance: () => Promise<EnterpriseGuidance>;
}

const cloneState = (state: EnterpriseState): EnterpriseState => structuredClone(state);

export const createEmptyEnterpriseState = (): EnterpriseState => ({
  contractVersion: ENTERPRISE_CONTRACT_VERSION,
  revision: 0,
  scopes: [],
  identities: [],
  policies: [],
  capabilities: [],
  resources: [],
  quotaPools: [],
  quotaAllocations: [],
  quotaReservations: [],
  administratorKey: null,
  securityAudit: [],
  guidanceRevision: 0,
});

export const createInMemoryEnterpriseStateRepository = (
  initialState: EnterpriseState = createEmptyEnterpriseState(),
): EnterpriseStateRepository => {
  let currentState = cloneState(initialState);
  return {
    load: async () => cloneState(currentState),
    save: async (state, expectedRevision) => {
      if (currentState.revision !== expectedRevision) {
        throw new Error("Enterprise state revision conflict.");
      }
      currentState = { ...cloneState(state), revision: expectedRevision + 1 };
      return cloneState(currentState);
    },
  };
};

const assertIdentifier = (value: string, field: string): void => {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
};

const assertPositiveUnits = (units: number): void => {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new Error("Quota units must be a positive safe integer.");
  }
};

const validateEnterpriseState = (state: EnterpriseState): void => {
  const scopeIds = new Set<string>();
  for (const scope of state.scopes) {
    assertIdentifier(scope.id, "Scope identifier");
    if (scopeIds.has(scope.id)) {
      throw new Error(`Duplicate enterprise scope ${scope.id}.`);
    }
    scopeIds.add(scope.id);
  }
  for (const scope of state.scopes) {
    if (scope.type === "tenant" ? scope.parentId !== null : !scopeIds.has(scope.parentId ?? "")) {
      throw new Error(`Enterprise scope ${scope.id} has an invalid parent.`);
    }
  }
  for (const policy of state.policies) {
    assertIdentifier(policy.id, "Policy identifier");
    if (!scopeIds.has(policy.scopeId) || policy.action.trim() === "") {
      throw new Error(`Enterprise policy ${policy.id} is invalid.`);
    }
  }
  const resourceIds = new Set(state.resources.map((resource) => resource.id));
  for (const resource of state.resources) {
    if (
      resource.ownership === "user" &&
      (resource.ownerIdentityId === null || resource.ownerIdentityId.trim() === "")
    ) {
      throw new Error(`User-owned resource ${resource.id} requires an owner.`);
    }
  }
  for (const pool of state.quotaPools) {
    if (
      !resourceIds.has(pool.resourceId) ||
      !scopeIds.has(pool.scopeId) ||
      ![pool.capacity, pool.remaining, pool.reserved, pool.settled].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      pool.remaining + pool.reserved + pool.settled !== pool.capacity ||
      Number.isNaN(Date.parse(pool.cycleEndsAt)) ||
      Number.isNaN(Date.parse(pool.shareAfter))
    ) {
      throw new Error(`Quota pool ${pool.id} is invalid.`);
    }
  }
};

const collectScopeLineage = (state: EnterpriseState, scopeId: string): readonly string[] => {
  const scopesById = new Map(state.scopes.map((scope) => [scope.id, scope]));
  const lineage: string[] = [];
  let currentScope = scopesById.get(scopeId);
  while (currentScope !== undefined) {
    if (lineage.includes(currentScope.id)) {
      throw new Error("Enterprise scope hierarchy contains a cycle.");
    }
    lineage.push(currentScope.id);
    currentScope =
      currentScope.parentId === null ? undefined : scopesById.get(currentScope.parentId);
  }
  if (lineage.length === 0) {
    throw new Error(`Unknown enterprise scope ${scopeId}.`);
  }
  return lineage;
};

const createAdministratorKey = (): { key: string; record: EnterpriseAdminKeyRecord } => {
  const secret = randomBytes(32).toString("base64url");
  const salt = randomBytes(16);
  const record: EnterpriseAdminKeyRecord = {
    id: randomUUID(),
    salt: salt.toString("hex"),
    verifier: scryptSync(secret, salt, 32).toString("hex"),
    algorithm: "scrypt-v1",
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  return { key: `tidu_admin_${secret}`, record };
};

export const createEnterpriseControlPlane = (
  repository: EnterpriseStateRepository,
): EnterpriseControlPlane => {
  const administratorSessions = new Map<string, EnterpriseAdminSession>();

  const mutate = async (
    mutation: (state: EnterpriseState) => EnterpriseState,
  ): Promise<EnterpriseState> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentState = await repository.load();
      const nextState = mutation(cloneState(currentState));
      validateEnterpriseState(nextState);
      try {
        return await repository.save(nextState, currentState.revision);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("revision conflict")) {
          throw error;
        }
      }
    }
    throw new Error("Enterprise state remained contended after bounded retries.");
  };

  return {
    snapshot: async () => cloneState(await repository.load()),
    authorizeIdentity: async (identityId, scopeId, requiredRole) => {
      const state = await repository.load();
      const lineage = collectScopeLineage(state, scopeId);
      const identity = state.identities.find((item) => item.id === identityId);
      if (!identity?.roles.includes(requiredRole)) {
        return false;
      }
      return identity.scopeIds.some((allowedScopeId) => lineage.includes(allowedScopeId));
    },
    publish: async (update) =>
      mutate((state) => ({
        ...structuredClone(update),
        contractVersion: ENTERPRISE_CONTRACT_VERSION,
        revision: state.revision,
        guidanceRevision: state.guidanceRevision + 1,
      })),
    evaluatePolicy: async (scopeId, action) => {
      const state = await repository.load();
      const lineage = collectScopeLineage(state, scopeId);
      const matchingPolicies = state.policies.filter(
        (policy) => lineage.includes(policy.scopeId) && policy.action === action,
      );
      const mandatoryPolicies = matchingPolicies.filter((policy) => policy.mode === "mandatory");
      return {
        allowed: mandatoryPolicies.every((policy) => policy.allow),
        mandatoryPolicyIds: mandatoryPolicies.map((policy) => policy.id),
        advisories: matchingPolicies
          .filter((policy) => policy.mode === "advisory")
          .map((policy) => policy.reason),
      };
    },
    listCapabilities: async (scopeId) => {
      const state = await repository.load();
      const lineage = collectScopeLineage(state, scopeId);
      return state.capabilities.filter((capability) =>
        capability.scopeIds.some((allowedScopeId) => lineage.includes(allowedScopeId)),
      );
    },
    listResources: async (scopeId, identityId) => {
      const state = await repository.load();
      const lineage = collectScopeLineage(state, scopeId);
      return state.resources.filter(
        (resource) =>
          resource.scopeIds.some((allowedScopeId) => lineage.includes(allowedScopeId)) &&
          (resource.ownership === "enterprise" || resource.ownerIdentityId === identityId),
      );
    },
    reserveQuota: async (allocationId, reservationId, units) => {
      assertIdentifier(reservationId, "Reservation identifier");
      assertPositiveUnits(units);
      let savedReservation: EnterpriseQuotaReservation | undefined;
      await mutate((state) => {
        const existingReservation = state.quotaReservations.find(
          (reservation) => reservation.id === reservationId,
        );
        if (existingReservation !== undefined) {
          if (
            existingReservation.allocationId !== allocationId ||
            existingReservation.units !== units
          ) {
            throw new Error("Reservation idempotency conflict.");
          }
          savedReservation = existingReservation;
          return state;
        }
        const allocation = state.quotaAllocations.find((item) => item.id === allocationId);
        const pool = state.quotaPools.find((item) => item.id === allocation?.poolId);
        if (allocation === undefined || pool === undefined) {
          throw new Error("Quota allocation does not exist.");
        }
        if (allocation.reserved + allocation.settled + units > allocation.limit) {
          throw new Error("Quota allocation limit exceeded.");
        }
        if (pool.remaining < units) {
          throw new Error("Quota pool is exhausted.");
        }
        const newReservation: EnterpriseQuotaReservation = {
          id: reservationId,
          allocationId,
          units,
          status: "reserved",
          updatedAt: new Date().toISOString(),
        };
        savedReservation = newReservation;
        return {
          ...state,
          quotaPools: state.quotaPools.map((item) =>
            item.id === pool.id
              ? { ...item, remaining: item.remaining - units, reserved: item.reserved + units }
              : item,
          ),
          quotaAllocations: state.quotaAllocations.map((item) =>
            item.id === allocation.id ? { ...item, reserved: item.reserved + units } : item,
          ),
          quotaReservations: [...state.quotaReservations, newReservation],
        };
      });
      if (savedReservation === undefined) {
        throw new Error("Quota reservation was not persisted.");
      }
      return savedReservation;
    },
    settleQuota: async (reservationId, actualUnits) => {
      if (!Number.isSafeInteger(actualUnits) || actualUnits < 0) {
        throw new Error("Actual quota units must be a non-negative safe integer.");
      }
      let settledReservation: EnterpriseQuotaReservation | undefined;
      await mutate((state) => {
        const reservation = state.quotaReservations.find((item) => item.id === reservationId);
        if (reservation === undefined || reservation.status !== "reserved") {
          throw new Error("Active quota reservation does not exist.");
        }
        if (actualUnits > reservation.units) {
          throw new Error("Settlement cannot exceed reserved quota.");
        }
        const allocation = state.quotaAllocations.find(
          (item) => item.id === reservation.allocationId,
        );
        const pool = state.quotaPools.find((item) => item.id === allocation?.poolId);
        if (allocation === undefined || pool === undefined) {
          throw new Error("Quota reservation references missing state.");
        }
        const releasedUnits = reservation.units - actualUnits;
        const newSettlement: EnterpriseQuotaReservation = {
          ...reservation,
          units: actualUnits,
          status: "settled",
          updatedAt: new Date().toISOString(),
        };
        settledReservation = newSettlement;
        return {
          ...state,
          quotaPools: state.quotaPools.map((item) =>
            item.id === pool.id
              ? {
                  ...item,
                  remaining: item.remaining + releasedUnits,
                  reserved: item.reserved - reservation.units,
                  settled: item.settled + actualUnits,
                }
              : item,
          ),
          quotaAllocations: state.quotaAllocations.map((item) =>
            item.id === allocation.id
              ? {
                  ...item,
                  reserved: item.reserved - reservation.units,
                  settled: item.settled + actualUnits,
                }
              : item,
          ),
          quotaReservations: state.quotaReservations.map((item) =>
            item.id === reservationId ? newSettlement : item,
          ),
        };
      });
      if (settledReservation === undefined) {
        throw new Error("Quota settlement was not persisted.");
      }
      return settledReservation;
    },
    releaseQuota: async (reservationId) => {
      let releasedReservation: EnterpriseQuotaReservation | undefined;
      await mutate((state) => {
        const reservation = state.quotaReservations.find((item) => item.id === reservationId);
        if (reservation === undefined || reservation.status !== "reserved") {
          throw new Error("Active quota reservation does not exist.");
        }
        const allocation = state.quotaAllocations.find(
          (item) => item.id === reservation.allocationId,
        );
        const pool = state.quotaPools.find((item) => item.id === allocation?.poolId);
        if (allocation === undefined || pool === undefined) {
          throw new Error("Quota reservation references missing state.");
        }
        const newRelease: EnterpriseQuotaReservation = {
          ...reservation,
          status: "released",
          updatedAt: new Date().toISOString(),
        };
        releasedReservation = newRelease;
        return {
          ...state,
          quotaPools: state.quotaPools.map((item) =>
            item.id === pool.id
              ? {
                  ...item,
                  remaining: item.remaining + reservation.units,
                  reserved: item.reserved - reservation.units,
                }
              : item,
          ),
          quotaAllocations: state.quotaAllocations.map((item) =>
            item.id === allocation.id
              ? { ...item, reserved: item.reserved - reservation.units }
              : item,
          ),
          quotaReservations: state.quotaReservations.map((item) =>
            item.id === reservationId ? newRelease : item,
          ),
        };
      });
      if (releasedReservation === undefined) {
        throw new Error("Quota release was not persisted.");
      }
      return releasedReservation;
    },
    shareAllocation: async (sourceAllocationId, targetAllocationId, units, now = new Date()) => {
      assertPositiveUnits(units);
      return mutate((state) => {
        const source = state.quotaAllocations.find((item) => item.id === sourceAllocationId);
        const target = state.quotaAllocations.find((item) => item.id === targetAllocationId);
        const pool = state.quotaPools.find((item) => item.id === source?.poolId);
        if (
          source === undefined ||
          target === undefined ||
          pool === undefined ||
          source.poolId !== target.poolId
        ) {
          throw new Error("Quota allocations must belong to the same pool.");
        }
        if (now.getTime() < Date.parse(pool.shareAfter)) {
          throw new Error("Quota sharing is not active yet.");
        }
        const sourceUnused = source.limit - source.reserved - source.settled;
        if (sourceUnused < units) {
          throw new Error("Source allocation has insufficient unused quota.");
        }
        return {
          ...state,
          quotaAllocations: state.quotaAllocations.map((item) =>
            item.id === source.id
              ? { ...item, limit: item.limit - units }
              : item.id === target.id
                ? { ...item, limit: item.limit + units }
                : item,
          ),
        };
      });
    },
    initializeAdministratorKey: async () => {
      const generated = createAdministratorKey();
      await mutate((state) => {
        if (state.administratorKey !== null) {
          throw new Error("Administrator key is already initialized.");
        }
        return {
          ...state,
          administratorKey: generated.record,
          securityAudit: [
            ...state.securityAudit,
            {
              id: randomUUID(),
              action: "administrator-key-rotation",
              reason: "Initial enterprise configuration",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      });
      return generated;
    },
    rotateAdministratorKey: async () => {
      const generated = createAdministratorKey();
      await mutate((state) => ({
        ...state,
        administratorKey: generated.record,
        securityAudit: [
          ...state.securityAudit,
          {
            id: randomUUID(),
            action: "administrator-key-rotation",
            reason: "Authenticated administrator rotation",
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      administratorSessions.clear();
      return generated;
    },
    recoverAdministratorKey: async (hostAuthorized, reason) => {
      if (!hostAuthorized || reason.trim().length < 8) {
        throw new Error("Authorized host recovery requires a non-secret reason.");
      }
      const generated = createAdministratorKey();
      await mutate((state) => ({
        ...state,
        administratorKey: generated.record,
        securityAudit: [
          ...state.securityAudit,
          {
            id: randomUUID(),
            action: "administrator-key-host-recovery",
            reason: reason.trim(),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      administratorSessions.clear();
      return generated;
    },
    authenticateAdministrator: async (key, now = new Date()) => {
      const state = await repository.load();
      const record = state.administratorKey;
      if (record === null || record.revokedAt !== null || !key.startsWith("tidu_admin_")) {
        throw new Error("Administrator authentication failed.");
      }
      const candidate = scryptSync(
        key.slice("tidu_admin_".length),
        Buffer.from(record.salt, "hex"),
        32,
      );
      const expected = Buffer.from(record.verifier, "hex");
      if (candidate.byteLength !== expected.byteLength || !timingSafeEqual(candidate, expected)) {
        throw new Error("Administrator authentication failed.");
      }
      const session: EnterpriseAdminSession = {
        id: randomUUID(),
        keyId: record.id,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      };
      administratorSessions.set(session.id, session);
      return session;
    },
    revokeAdministratorSessions: () => administratorSessions.clear(),
    validateAdministratorSession: (sessionId, now = new Date()) => {
      const session = administratorSessions.get(sessionId);
      return session !== undefined && Date.parse(session.expiresAt) > now.getTime();
    },
    generateGuidance: async () => {
      const state = await repository.load();
      const resourceNames = state.resources.map((resource) => resource.name).join(", ");
      return {
        version: state.guidanceRevision,
        administrator: [
          "Deploy the gateway behind HTTPS and the enterprise identity provider.",
          "Save the one-time administrator key offline; only its verifier is persisted.",
          `Publish ${state.policies.length} policies and verify mandatory controls before onboarding.`,
          "Distribute the generated client entry and keep provider credentials server-side.",
        ],
        employee: [
          "Sign in through the company identity provider.",
          `Select an allowed virtual model resource${resourceNames === "" ? "." : `: ${resourceNames}.`}`,
          "Use the same company entry from supported clients; mandatory policy is enforced centrally.",
          "Contact the configured administrator when quota or capability access is denied.",
        ],
      };
    },
  };
};

export const planPersonalToEnterpriseEnrollment = (input: {
  /** Whether a personal runtime is currently active. */
  runtimeActive: boolean;
  /** Whether the enterprise endpoint passed TLS and identity preflight. */
  enterpriseEndpointVerified: boolean;
  /** Whether an encrypted local snapshot can be created. */
  encryptedSnapshotAvailable: boolean;
}): EnterpriseEnrollmentPlan => {
  const blockers = [
    ...(input.runtimeActive ? ["Stop active personal tasks before enrollment."] : []),
    ...(input.enterpriseEndpointVerified ? [] : ["Enterprise endpoint verification failed."]),
    ...(input.encryptedSnapshotAvailable ? [] : ["Encrypted rollback snapshot is unavailable."]),
  ];
  return {
    compatible: blockers.length === 0,
    blockers,
    encryptedSnapshotRequired: true,
    steps: [
      "Create an encrypted local personal-profile snapshot.",
      "Enroll an isolated enterprise profile without deleting the personal profile.",
      "Verify identity, policy, model, quota, and client connectivity.",
      "Activate the enterprise profile only after every probe passes.",
      "Restore the personal profile automatically when organization enrollment is removed.",
    ],
  };
};

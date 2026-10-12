export const HOST_ACCOUNT_BRIDGE_VERSION = "tidu-host-account-bridge/1" as const;

export type HostAccountProvider = "chatgpt" | "cursor" | "openai-api" | "custom";
export type HostAccountAuthority = "host-delegated" | "provider-oauth" | "user-api-key";
export type HostAccountStatus = "available" | "expired" | "revoked" | "unavailable";

export interface HostAccountProfile {
  /** Stable profile identifier; it must not contain a token, password, or session secret. */
  id: string;
  /** Upstream account or service family. */
  provider: HostAccountProvider;
  /** Human-readable local label; callers decide whether to display it. */
  label: string;
  /** Party that authoritatively owns authentication for this profile. */
  authority: HostAccountAuthority;
  /** Current non-secret connection state reported by the authority. */
  status: HostAccountStatus;
  /** Monotonic revision changed by the authority after account switching. */
  revision: number;
}

export interface HostAccountRequest {
  /** OpenAI-compatible wire protocol requested by the client. */
  protocol: "chat-completions" | "responses";
  /** Request body after platform policy checks and before provider execution. */
  body: Readonly<Record<string, unknown>>;
  /** Cancellation signal owned by the calling task. */
  signal?: AbortSignal;
}

export interface HostAccountResponse {
  /** Provider response status. */
  statusCode: number;
  /** Provider response headers safe to forward to the client. */
  headers: Readonly<Record<string, string>>;
  /** Provider response body; credentials must never be included. */
  body: unknown;
}

export interface TaskAccountSnapshot {
  /** Contract version used to decode this immutable snapshot. */
  bridgeVersion: typeof HOST_ACCOUNT_BRIDGE_VERSION;
  /** Task that selected the account. */
  taskId: string;
  /** Selected profile identifier. */
  profileId: string;
  /** Provider selected for the task. */
  provider: HostAccountProvider;
  /** Authentication authority used by the task. */
  authority: HostAccountAuthority;
  /** Profile revision captured before the first provider request. */
  profileRevision: number;
  /** ISO timestamp of account selection. */
  selectedAt: string;
}

export interface HostAccountSession {
  /** Immutable account identity captured for the task. */
  snapshot: TaskAccountSnapshot;
  /** Executes through the authority without exposing its credential to AI-Tidu9. */
  execute: (request: HostAccountRequest) => Promise<HostAccountResponse>;
  /** Releases authority-owned session resources. */
  close: () => Promise<void>;
}

export interface HostAccountBridge {
  /** Stable bridge name used for diagnostics. */
  id: string;
  /** Lists non-secret account metadata owned by this bridge. */
  listProfiles: () => Promise<readonly HostAccountProfile[]>;
  /** Opens a task-scoped delegated session for one profile. */
  openSession: (profileId: string, taskId: string) => Promise<HostAccountSession>;
}

export interface HostAccountRegistry {
  /** Lists profiles across all registered bridges and rejects ambiguous identifiers. */
  listProfiles: () => Promise<readonly HostAccountProfile[]>;
  /** Opens a task-scoped session pinned to the selected profile revision. */
  openSession: (profileId: string, taskId: string) => Promise<HostAccountSession>;
}

export interface HostAccountRegistryOptions {
  /** Clock override used for deterministic embedded implementations and tests. */
  now?: () => Date;
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

const validateProfile = (profile: HostAccountProfile): void => {
  if (!PROFILE_ID_PATTERN.test(profile.id)) {
    throw new Error("Host account profile ID is invalid.");
  }
  if (profile.label.trim() === "" || [...profile.label].length > 128) {
    throw new Error("Host account profile label is invalid.");
  }
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) {
    throw new Error("Host account profile revision is invalid.");
  }
};

const loadProfiles = async (
  bridges: readonly HostAccountBridge[],
): Promise<ReadonlyMap<string, { bridge: HostAccountBridge; profile: HostAccountProfile }>> => {
  const profiles = new Map<string, { bridge: HostAccountBridge; profile: HostAccountProfile }>();
  for (const bridge of bridges) {
    const bridgeProfiles = await bridge.listProfiles();
    for (const profile of bridgeProfiles) {
      validateProfile(profile);
      if (profiles.has(profile.id)) {
        throw new Error(`Host account profile '${profile.id}' is ambiguous.`);
      }
      profiles.set(profile.id, { bridge, profile: Object.freeze({ ...profile }) });
    }
  }
  return profiles;
};

export const createHostAccountRegistry = (
  bridges: readonly HostAccountBridge[],
  options: HostAccountRegistryOptions = {},
): HostAccountRegistry => {
  const bridgeIds = new Set<string>();
  for (const bridge of bridges) {
    if (!PROFILE_ID_PATTERN.test(bridge.id) || bridgeIds.has(bridge.id)) {
      throw new Error("Host account bridge ID must be valid and unique.");
    }
    bridgeIds.add(bridge.id);
  }
  const now = options.now ?? (() => new Date());

  return {
    listProfiles: async () => {
      const profiles = await loadProfiles(bridges);
      return [...profiles.values()].map(({ profile }) => profile);
    },
    openSession: async (profileId, taskId) => {
      if (!TASK_ID_PATTERN.test(taskId)) {
        throw new Error("Task ID is invalid.");
      }
      const profiles = await loadProfiles(bridges);
      const selected = profiles.get(profileId);
      if (selected === undefined) {
        throw new Error(`Host account profile '${profileId}' is not available.`);
      }
      if (selected.profile.status !== "available") {
        throw new Error(`Host account profile '${profileId}' is ${selected.profile.status}.`);
      }

      const session = await selected.bridge.openSession(profileId, taskId);
      const expectedSnapshot: TaskAccountSnapshot = Object.freeze({
        bridgeVersion: HOST_ACCOUNT_BRIDGE_VERSION,
        taskId,
        profileId: selected.profile.id,
        provider: selected.profile.provider,
        authority: selected.profile.authority,
        profileRevision: selected.profile.revision,
        selectedAt: now().toISOString(),
      });
      if (
        session.snapshot.taskId !== expectedSnapshot.taskId ||
        session.snapshot.profileId !== expectedSnapshot.profileId ||
        session.snapshot.provider !== expectedSnapshot.provider ||
        session.snapshot.authority !== expectedSnapshot.authority ||
        session.snapshot.profileRevision !== expectedSnapshot.profileRevision
      ) {
        await session.close();
        throw new Error("Host account session does not match the selected profile snapshot.");
      }
      return { ...session, snapshot: expectedSnapshot };
    },
  };
};

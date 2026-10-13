import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import type { HostAccountProfile, TaskAccountSnapshot } from "../accounts/index.js";
import {
  type ConfigurationMode,
  type ConfigurationValidationIssue,
  type TiduConfiguration,
  validateConfiguration,
} from "../config/index.js";
import type { ConfigurationStore, ConfigurationWorkspace } from "../storage/index.js";
import type { UsageObservation } from "../usage/index.js";

export const PERSONAL_EXPERIENCE_VERSION = "tidu-personal/1" as const;

export type PersonalLocale = "en-US" | "zh-CN";
export type HistoryMode = "host" | "incognito" | "portable";

export interface HistoryPolicy {
  /** Storage strategy used for conversation content. */
  mode: HistoryMode;
  /** Maximum locally retained bytes; ignored by host and incognito modes. */
  maximumBytes: number;
  /** Maximum age in days; ignored by host and incognito modes. */
  retentionDays: number;
}

export interface HistoryEntryMetadata {
  /** Stable local history identifier. */
  id: string;
  /** Stored byte count used for bounded cleanup. */
  bytes: number;
  /** ISO timestamp of the most recent access. */
  lastAccessedAt: string;
}

export interface HistoryCleanupPlan {
  /** History identifiers removed from oldest to newest. */
  removeIds: readonly string[];
  /** Bytes retained after cleanup. */
  retainedBytes: number;
}

export interface ConfigurationImpactPreview {
  /** Whether the candidate is safe to activate. */
  valid: boolean;
  /** Validation issues that block activation. */
  issues: readonly ConfigurationValidationIssue[];
  /** Human-readable fields changed from the active configuration. */
  changes: readonly string[];
  /** Whether switching modes leaves the other mode's draft untouched. */
  isolated: true;
  /** Risk classification for the proposed activation. */
  risk: "low" | "medium";
}

export interface SafeActivationResult {
  /** Resulting workspace after activation or rollback. */
  workspace: ConfigurationWorkspace;
  /** Whether the candidate remained active after its health probe. */
  activated: boolean;
  /** Whether the previous known-good configuration was restored. */
  rolledBack: boolean;
}

export interface PersonalBudget {
  /** ISO date on which this budget period starts. */
  periodStartedAt: string;
  /** ISO date on which this budget period ends. */
  periodEndsAt: string;
  /** Optional token ceiling for the period. */
  tokenLimit: number | null;
  /** Optional cost ceiling for the period. */
  costLimit: { amount: number; currency: string } | null;
}

export interface AccountUsageSummary {
  /** Account profile that owns the recorded charges. */
  profileId: string;
  /** Total tokens attributed to this profile. */
  totalTokens: number;
  /** Cost totals keyed by ISO currency code. */
  costs: Readonly<Record<string, number>>;
  /** Number of reconciled requests. */
  requests: number;
}

export interface PersonalBudgetView {
  /** Budget applied to the view. */
  budget: PersonalBudget;
  /** Usage grouped by immutable task account snapshots. */
  accounts: readonly AccountUsageSummary[];
  /** Total tokens across accounts in this budget period. */
  totalTokens: number;
  /** Remaining token allowance, or null when no ceiling is configured. */
  remainingTokens: number | null;
  /** Cost totals keyed by ISO currency code. */
  costs: Readonly<Record<string, number>>;
}

export interface AccountUsageRecord {
  /** Immutable account identity captured before provider execution. */
  account: TaskAccountSnapshot;
  /** Authoritative or estimated observation for the request. */
  usage: UsageObservation;
}

export interface LocalModelCandidate {
  /** Stable local model identifier. */
  id: string;
  /** Local provider type. */
  provider: "ollama" | "openai-compatible-local";
  /** Loopback endpoint used to reach the provider. */
  endpoint: string;
  /** Whether the provider health check succeeded. */
  available: boolean;
  /** Capabilities declared by the local provider. */
  capabilities: readonly string[];
}

export interface LocalModelDiagnostic {
  /** Whether this candidate is safe to select. */
  ready: boolean;
  /** Normalized candidate without credentials. */
  candidate: LocalModelCandidate;
  /** Diagnostic findings that require attention. */
  findings: readonly string[];
}

export interface LocalModelSetup {
  /** Provider environment name accepted by the runtime. */
  provider: "ollama" | "openai-compatible";
  /** Loopback provider endpoint. */
  baseUrl: string;
  /** Selected local model identifier. */
  model: string;
}

export interface PersonalExtension {
  /** Stable extension identifier. */
  id: string;
  /** Extension type exposed to the Agent runtime. */
  kind: "agent" | "mcp" | "skill" | "tool";
  /** Installed extension version. */
  version: string;
  /** Whether the extension is enabled. */
  enabled: boolean;
  /** Declared permissions reviewed before activation. */
  permissions: readonly string[];
}

export interface ExtensionDiagnostic {
  /** Extension inspected by the diagnostic. */
  extension: PersonalExtension;
  /** Whether the extension can be activated. */
  ready: boolean;
  /** Diagnostic findings that require attention. */
  findings: readonly string[];
}

export interface PersonalConfigurationBundle {
  /** Bundle format version. */
  version: typeof PERSONAL_EXPERIENCE_VERSION;
  /** Export timestamp. */
  exportedAt: string;
  /** Non-secret configuration profiles. */
  configurations: Readonly<Record<ConfigurationMode, TiduConfiguration>>;
  /** Personal history policy, never history content. */
  history: HistoryPolicy;
  /** Installed extension metadata, never extension credentials. */
  extensions: readonly PersonalExtension[];
}

export interface EncryptedConfigurationExport {
  /** Encrypted export format. */
  format: "tidu-config-aes-256-gcm/1";
  /** Base64 salt used by scrypt. */
  salt: string;
  /** Base64 initialization vector. */
  initializationVector: string;
  /** Base64 authentication tag. */
  authenticationTag: string;
  /** Base64 encrypted payload. */
  ciphertext: string;
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const validateHistoryPolicy = (policy: HistoryPolicy): void => {
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes < 0) {
    throw new Error("History maximumBytes must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 0) {
    throw new Error("History retentionDays must be a non-negative integer.");
  }
};

export const createHistoryCleanupPlan = (
  policy: HistoryPolicy,
  entries: readonly HistoryEntryMetadata[],
  now: Date = new Date(),
): HistoryCleanupPlan => {
  validateHistoryPolicy(policy);
  if (policy.mode !== "portable") {
    return { removeIds: entries.map((entry) => entry.id), retainedBytes: 0 };
  }
  const sortedEntries = [...entries].sort(
    (left, right) => Date.parse(right.lastAccessedAt) - Date.parse(left.lastAccessedAt),
  );
  const cutoff = now.getTime() - policy.retentionDays * 86_400_000;
  const retained: HistoryEntryMetadata[] = [];
  const removeIds: string[] = [];
  let retainedBytes = 0;
  for (const entry of sortedEntries) {
    const timestamp = Date.parse(entry.lastAccessedAt);
    if (
      !PROFILE_ID_PATTERN.test(entry.id) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      Number.isNaN(timestamp)
    ) {
      throw new Error("History entry metadata is invalid.");
    }
    if (timestamp < cutoff || retainedBytes + entry.bytes > policy.maximumBytes) {
      removeIds.push(entry.id);
    } else {
      retained.push(entry);
      retainedBytes += entry.bytes;
    }
  }
  return {
    removeIds: removeIds.sort(
      (leftId, rightId) =>
        Date.parse(entries.find((entry) => entry.id === leftId)?.lastAccessedAt ?? "") -
        Date.parse(entries.find((entry) => entry.id === rightId)?.lastAccessedAt ?? ""),
    ),
    retainedBytes,
  };
};

export const previewConfigurationImpact = (
  active: TiduConfiguration,
  candidate: TiduConfiguration,
): ConfigurationImpactPreview => {
  const validation = validateConfiguration(candidate, candidate.activeMode);
  const changes = [
    ...(active.activeMode === candidate.activeMode ? [] : ["activeMode"]),
    ...(active.activeProfileId === candidate.activeProfileId ? [] : ["activeProfileId"]),
    ...(active.virtualModelName === candidate.virtualModelName ? [] : ["virtualModelName"]),
  ];
  return {
    valid: validation.valid,
    issues: validation.issues,
    changes,
    isolated: true,
    risk: changes.includes("activeMode") || changes.includes("activeProfileId") ? "medium" : "low",
  };
};

export const activateConfigurationSafely = async (
  store: ConfigurationStore,
  mode: ConfigurationMode,
  expectedDraftRevision: number,
  healthProbe: (configuration: TiduConfiguration) => Promise<boolean>,
): Promise<SafeActivationResult> => {
  const activatedWorkspace = await store.activateDraft(mode, expectedDraftRevision);
  if (await healthProbe(activatedWorkspace.active.configuration)) {
    return { workspace: activatedWorkspace, activated: true, rolledBack: false };
  }
  const rolledBackWorkspace = await store.rollbackActive();
  return { workspace: rolledBackWorkspace, activated: false, rolledBack: true };
};

const validateBudget = (budget: PersonalBudget): void => {
  if (Date.parse(budget.periodStartedAt) >= Date.parse(budget.periodEndsAt)) {
    throw new Error("Personal budget period is invalid.");
  }
  if (
    budget.tokenLimit !== null &&
    (!Number.isSafeInteger(budget.tokenLimit) || budget.tokenLimit < 0)
  ) {
    throw new Error("Personal token budget is invalid.");
  }
  if (
    budget.costLimit !== null &&
    (!Number.isFinite(budget.costLimit.amount) ||
      budget.costLimit.amount < 0 ||
      !/^[A-Z]{3}$/u.test(budget.costLimit.currency))
  ) {
    throw new Error("Personal cost budget is invalid.");
  }
};

export const createPersonalBudgetView = (
  budget: PersonalBudget,
  records: readonly AccountUsageRecord[],
): PersonalBudgetView => {
  validateBudget(budget);
  const accounts = new Map<
    string,
    { costs: Record<string, number>; requests: number; totalTokens: number }
  >();
  const seenRequests = new Set<string>();
  for (const record of records) {
    if (record.account.profileId.trim() === "" || record.account.taskId.trim() === "") {
      throw new Error("Usage record account snapshot is invalid.");
    }
    const requestIdentity = `${record.account.taskId}:${record.usage.requestId}`;
    if (seenRequests.has(requestIdentity)) {
      throw new Error("A request cannot be charged more than once.");
    }
    seenRequests.add(requestIdentity);
    const summary = accounts.get(record.account.profileId) ?? {
      costs: {},
      requests: 0,
      totalTokens: 0,
    };
    summary.requests += 1;
    summary.totalTokens += record.usage.tokens?.totalTokens ?? 0;
    if (record.usage.cost !== null) {
      summary.costs[record.usage.cost.currency] =
        (summary.costs[record.usage.cost.currency] ?? 0) + record.usage.cost.amount;
    }
    accounts.set(record.account.profileId, summary);
  }
  const accountViews = [...accounts.entries()]
    .map(([profileId, summary]) => ({ profileId, ...summary }))
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
  const totalTokens = accountViews.reduce((total, account) => total + account.totalTokens, 0);
  const costs: Record<string, number> = {};
  for (const account of accountViews) {
    for (const [currency, amount] of Object.entries(account.costs)) {
      costs[currency] = (costs[currency] ?? 0) + amount;
    }
  }
  return {
    budget,
    accounts: accountViews,
    totalTokens,
    remainingTokens:
      budget.tokenLimit === null ? null : Math.max(0, budget.tokenLimit - totalTokens),
    costs,
  };
};

export const validateAccountSwitch = (
  current: HostAccountProfile,
  next: HostAccountProfile,
): { allowed: boolean; reason: string } => {
  if (next.status !== "available") {
    return { allowed: false, reason: `Target account is ${next.status}.` };
  }
  if (current.id === next.id && current.revision === next.revision) {
    return { allowed: false, reason: "Target account is already active." };
  }
  return {
    allowed: true,
    reason: "New tasks use the selected account; running tasks keep their snapshots.",
  };
};

export const diagnoseLocalModel = (candidate: LocalModelCandidate): LocalModelDiagnostic => {
  const findings: string[] = [];
  let parsedEndpoint: URL | undefined;
  try {
    parsedEndpoint = new URL(candidate.endpoint);
  } catch {
    findings.push("Endpoint is not a valid URL.");
  }
  if (
    parsedEndpoint !== undefined &&
    !["127.0.0.1", "::1", "localhost"].includes(parsedEndpoint.hostname)
  ) {
    findings.push("Personal local-model endpoints must use loopback networking.");
  }
  if (!candidate.available) {
    findings.push("Provider health check failed.");
  }
  if (candidate.capabilities.length === 0) {
    findings.push("Model capabilities are not declared.");
  }
  return { ready: findings.length === 0, candidate: { ...candidate }, findings };
};

export const createLocalModelSetup = (candidate: LocalModelCandidate): LocalModelSetup => {
  const diagnostic = diagnoseLocalModel(candidate);
  if (!diagnostic.ready) {
    throw new Error(`Local model is not ready: ${diagnostic.findings.join(" ")}`);
  }
  return {
    provider: candidate.provider === "ollama" ? "ollama" : "openai-compatible",
    baseUrl: new URL(candidate.endpoint).toString().replace(/\/$/u, ""),
    model: candidate.id,
  };
};

export const diagnoseExtension = (extension: PersonalExtension): ExtensionDiagnostic => {
  const findings: string[] = [];
  if (!PROFILE_ID_PATTERN.test(extension.id)) {
    findings.push("Extension ID is invalid.");
  }
  if (!EXTENSION_VERSION_PATTERN.test(extension.version)) {
    findings.push("Extension version must use semantic versioning.");
  }
  if (new Set(extension.permissions).size !== extension.permissions.length) {
    findings.push("Extension permissions contain duplicates.");
  }
  if (extension.enabled && extension.permissions.length === 0) {
    findings.push("Enabled extensions must declare permissions.");
  }
  return { extension: { ...extension }, ready: findings.length === 0, findings };
};

export const installPersonalExtension = (
  installed: readonly PersonalExtension[],
  candidate: PersonalExtension,
): readonly PersonalExtension[] => {
  const diagnostic = diagnoseExtension(candidate);
  if (!diagnostic.ready) {
    throw new Error(`Extension cannot be installed: ${diagnostic.findings.join(" ")}`);
  }
  return [
    ...installed.filter((extension) => extension.id !== candidate.id),
    { ...candidate, permissions: [...candidate.permissions] },
  ].sort((left, right) => left.id.localeCompare(right.id));
};

const validateBundle = (bundle: PersonalConfigurationBundle): void => {
  if (
    bundle.version !== PERSONAL_EXPERIENCE_VERSION ||
    Number.isNaN(Date.parse(bundle.exportedAt))
  ) {
    throw new Error("Configuration bundle metadata is invalid.");
  }
  validateHistoryPolicy(bundle.history);
  for (const mode of ["managed", "expert"] as const) {
    if (!validateConfiguration(bundle.configurations[mode], mode).valid) {
      throw new Error(`Configuration bundle contains an invalid ${mode} profile.`);
    }
  }
  for (const extension of bundle.extensions) {
    if (!diagnoseExtension(extension).ready) {
      throw new Error(`Configuration bundle contains an invalid extension: ${extension.id}.`);
    }
  }
};

export const encryptConfigurationBundle = (
  bundle: PersonalConfigurationBundle,
  passphrase: string,
): EncryptedConfigurationExport => {
  validateBundle(bundle);
  if (passphrase.length < 12) {
    throw new Error("Configuration export passphrase must contain at least 12 characters.");
  }
  const salt = randomBytes(16);
  const initializationVector = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
  return {
    format: "tidu-config-aes-256-gcm/1",
    salt: salt.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
};

export const decryptConfigurationBundle = (
  encrypted: EncryptedConfigurationExport,
  passphrase: string,
): PersonalConfigurationBundle => {
  if (encrypted.format !== "tidu-config-aes-256-gcm/1") {
    throw new Error("Configuration export format is not supported.");
  }
  const salt = Buffer.from(encrypted.salt, "base64");
  const initializationVector = Buffer.from(encrypted.initializationVector, "base64");
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, initializationVector);
  decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const bundle = JSON.parse(plaintext) as PersonalConfigurationBundle;
  validateBundle(bundle);
  return bundle;
};

export const importConfigurationBundle = async (
  store: ConfigurationStore,
  bundle: PersonalConfigurationBundle,
): Promise<ConfigurationWorkspace> => {
  validateBundle(bundle);
  let workspace = await store.loadWorkspace();
  for (const mode of ["managed", "expert"] as const) {
    workspace = await store.saveDraft({
      mode,
      expectedRevision: workspace.drafts[mode].revision,
      configuration: bundle.configurations[mode],
    });
  }
  return workspace;
};

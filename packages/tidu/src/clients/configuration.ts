import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PRODUCT, TiduError } from "../core/index.js";

const CODEX_PROFILE_NAME = "ai-tidu9";
const CODEX_PROFILE_FILE = `${CODEX_PROFILE_NAME}.config.toml`;
const STATE_FILE = ".ai-tidu9-profile-state.json";
const BACKUP_DIRECTORY = ".ai-tidu9-backups";
const SNAPSHOT_MANIFEST_FILE = "snapshot.json";
const SNAPSHOT_PROFILE_FILE = "profile.config.toml";
const SNAPSHOT_STATE_FILE = "state.json";

export interface CodexClientConfigurationOptions {
  /** AI-Tidu9 management origin used by the dedicated Codex profile. */
  endpoint: string;
  /** Optional Codex home override; defaults to CODEX_HOME or the standard user directory. */
  codexHomeDirectory?: string;
  /** Optional fetch implementation for embedded runtimes and isolated tests. */
  request?: typeof fetch;
}

export interface CodexClientRollbackOptions {
  /** Optional Codex home override; defaults to CODEX_HOME or the standard user directory. */
  codexHomeDirectory?: string;
}

export interface CodexClientConfigurationResult {
  /** Completed transaction state. */
  status: "configured";
  /** Client whose dedicated profile was configured. */
  client: "codex";
  /** Profile selected with `codex --profile`. */
  profile: "ai-tidu9";
  /** Normalized AI-Tidu9 origin verified before and after writing. */
  endpoint: string;
  /** Active virtual-model identifier written to the profile. */
  model: string;
  /** Snapshot identifier available for explicit rollback. */
  backupId: string;
}

export interface CodexClientRollbackResult {
  /** Whether a snapshot was restored or no snapshot existed. */
  status: "missing" | "restored";
  /** Client whose dedicated profile was targeted. */
  client: "codex";
  /** Profile affected by the rollback. */
  profile: "ai-tidu9";
  /** Restored snapshot identifier, or null when no snapshot exists. */
  backupId: string | null;
}

interface CodexProfileState {
  /** State-contract version. */
  schemaVersion: 1;
  /** Owner marker preventing adoption of an unrelated profile. */
  owner: "AI-Tidu9";
  /** Managed Codex profile name. */
  profile: "ai-tidu9";
  /** Normalized AI-Tidu9 origin. */
  endpoint: string;
  /** Active virtual-model identifier. */
  model: string;
  /** Snapshot restored by the next explicit rollback. */
  backupId: string;
  /** ISO timestamp of the completed write. */
  configuredAt: string;
}

interface SnapshotManifest {
  /** Snapshot-contract version. */
  schemaVersion: 1;
  /** Whether a managed profile existed before the transaction. */
  profileExisted: boolean;
  /** Whether managed state existed before the transaction. */
  stateExisted: boolean;
}

interface VerifiedEndpoint {
  /** Normalized runtime origin. */
  endpoint: string;
  /** Active virtual-model identifier returned by model discovery. */
  model: string;
}

interface CodexPaths {
  /** Codex configuration root. */
  home: string;
  /** Dedicated AI-Tidu9 profile file. */
  profile: string;
  /** AI-Tidu9 ownership and connection state. */
  state: string;
  /** Root containing transaction snapshots. */
  backups: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveCodexHome = (configuredDirectory?: string): string =>
  configuredDirectory ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

const resolveCodexPaths = (configuredDirectory?: string): CodexPaths => {
  const home = resolveCodexHome(configuredDirectory);
  return {
    home,
    profile: join(home, CODEX_PROFILE_FILE),
    state: join(home, STATE_FILE),
    backups: join(home, BACKUP_DIRECTORY),
  };
};

const assertSafeRegularFile = (filePath: string): void => {
  if (!existsSync(filePath)) {
    return;
  }
  const fileStatus = lstatSync(filePath);
  if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "AI-Tidu9 refuses to replace a non-regular or symbolic-link client configuration.",
    );
  }
};

const ensureSafeDirectory = (directoryPath: string): void => {
  mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  const directoryStatus = lstatSync(directoryPath);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "AI-Tidu9 client configuration directory must be a regular directory.",
    );
  }
  chmodSync(directoryPath, 0o700);
};

const writePrivateFileAtomically = (targetPath: string, content: string): void => {
  assertSafeRegularFile(targetPath);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, targetPath);
    chmodSync(targetPath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

const normalizeEndpoint = (candidate: string): string => {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(candidate.trim());
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "Client endpoint must be a valid URL.", {
      cause: error,
    });
  }
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Client endpoint cannot contain credentials, query parameters, or fragments.",
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    endpointUrl.protocol !== "https:" &&
    !(endpointUrl.protocol === "http:" && loopbackHosts.has(endpointUrl.hostname))
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Client endpoint must use HTTPS unless it is a loopback address.",
    );
  }
  return endpointUrl.toString().replace(/\/$/u, "");
};

const requestJson = async (
  request: typeof fetch,
  endpoint: string,
  path: string,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await request(`${endpoint}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new TiduError("INTERNAL_ERROR", "Cannot reach the AI-Tidu9 runtime.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new TiduError(
      "INTERNAL_ERROR",
      `AI-Tidu9 connectivity check failed with HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body)) {
    throw new TiduError("INTERNAL_ERROR", "AI-Tidu9 returned an invalid connectivity response.");
  }
  return body;
};

const verifyEndpoint = async (
  candidate: string,
  request: typeof fetch,
): Promise<VerifiedEndpoint> => {
  const endpoint = normalizeEndpoint(candidate);
  const health = await requestJson(request, endpoint, "/health");
  if (health.product !== PRODUCT.name || health.status !== "ok") {
    throw new TiduError("INTERNAL_ERROR", "The endpoint is not a healthy AI-Tidu9 runtime.");
  }
  const modelList = await requestJson(request, endpoint, "/v1/models");
  const models = modelList.data;
  const firstModel = Array.isArray(models) ? models[0] : undefined;
  if (
    !isRecord(firstModel) ||
    typeof firstModel.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(firstModel.id) ||
    firstModel.owned_by !== "AI-Tidu9"
  ) {
    throw new TiduError("INTERNAL_ERROR", "AI-Tidu9 did not expose an active virtual model.");
  }
  return { endpoint, model: firstModel.id };
};

const createCodexProfile = (endpoint: string, model: string): string =>
  [
    "# Managed by AI-Tidu9. This file contains no provider credentials.",
    `model = ${JSON.stringify(model)}`,
    'model_provider = "ai_tidu9"',
    "",
    "[model_providers.ai_tidu9]",
    'name = "AI-Tidu9"',
    `base_url = ${JSON.stringify(`${endpoint}/v1`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n");

const readManagedState = (statePath: string): CodexProfileState | undefined => {
  if (!existsSync(statePath)) {
    return undefined;
  }
  assertSafeRegularFile(statePath);
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch (error) {
    throw new TiduError("CONFIGURATION_CONFLICT", "AI-Tidu9 client state is invalid.", {
      cause: error,
    });
  }
  if (
    !isRecord(state) ||
    state.schemaVersion !== 1 ||
    state.owner !== "AI-Tidu9" ||
    state.profile !== CODEX_PROFILE_NAME ||
    typeof state.endpoint !== "string" ||
    typeof state.model !== "string" ||
    typeof state.backupId !== "string" ||
    typeof state.configuredAt !== "string"
  ) {
    throw new TiduError("CONFIGURATION_CONFLICT", "AI-Tidu9 client state is invalid.");
  }
  return state as unknown as CodexProfileState;
};

const createSnapshot = (paths: CodexPaths): string => {
  ensureSafeDirectory(paths.home);
  assertSafeRegularFile(paths.profile);
  assertSafeRegularFile(paths.state);
  const profileExisted = existsSync(paths.profile);
  const stateExisted = existsSync(paths.state);
  if (profileExisted !== stateExisted) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "An unmanaged or incomplete ai-tidu9 Codex profile already exists; no file was changed.",
    );
  }
  if (stateExisted) {
    readManagedState(paths.state);
  }

  ensureSafeDirectory(paths.backups);
  const backupId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const snapshotDirectory = join(paths.backups, backupId);
  try {
    ensureSafeDirectory(snapshotDirectory);
    const manifest: SnapshotManifest = { schemaVersion: 1, profileExisted, stateExisted };
    writePrivateFileAtomically(
      join(snapshotDirectory, SNAPSHOT_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    if (profileExisted) {
      copyFileSync(paths.profile, join(snapshotDirectory, SNAPSHOT_PROFILE_FILE));
      chmodSync(join(snapshotDirectory, SNAPSHOT_PROFILE_FILE), 0o600);
    }
    if (stateExisted) {
      copyFileSync(paths.state, join(snapshotDirectory, SNAPSHOT_STATE_FILE));
      chmodSync(join(snapshotDirectory, SNAPSHOT_STATE_FILE), 0o600);
    }
  } catch (error) {
    rmSync(snapshotDirectory, { force: true, recursive: true });
    throw error;
  }
  return backupId;
};

const readSnapshotManifest = (snapshotDirectory: string): SnapshotManifest => {
  const manifestPath = join(snapshotDirectory, SNAPSHOT_MANIFEST_FILE);
  assertSafeRegularFile(manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup manifest is invalid.", {
      cause: error,
    });
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.profileExisted !== "boolean" ||
    typeof manifest.stateExisted !== "boolean"
  ) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup manifest is invalid.");
  }
  return manifest as unknown as SnapshotManifest;
};

const restoreSnapshot = (paths: CodexPaths, backupId: string, removeSnapshot: boolean): void => {
  const snapshotDirectory = join(paths.backups, backupId);
  const manifest = readSnapshotManifest(snapshotDirectory);
  if (manifest.profileExisted) {
    const snapshotProfile = join(snapshotDirectory, SNAPSHOT_PROFILE_FILE);
    assertSafeRegularFile(snapshotProfile);
    writePrivateFileAtomically(paths.profile, readFileSync(snapshotProfile, "utf8"));
  } else {
    assertSafeRegularFile(paths.profile);
    rmSync(paths.profile, { force: true });
  }
  if (manifest.stateExisted) {
    const snapshotState = join(snapshotDirectory, SNAPSHOT_STATE_FILE);
    assertSafeRegularFile(snapshotState);
    writePrivateFileAtomically(paths.state, readFileSync(snapshotState, "utf8"));
  } else {
    assertSafeRegularFile(paths.state);
    rmSync(paths.state, { force: true });
  }
  if (removeSnapshot) {
    rmSync(snapshotDirectory, { force: true, recursive: true });
  }
};

const listSnapshotIds = (paths: CodexPaths): readonly string[] => {
  if (!existsSync(paths.backups)) {
    return [];
  }
  ensureSafeDirectory(paths.backups);
  return readdirSync(paths.backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .reverse();
};

export const configureCodexClient = async (
  options: CodexClientConfigurationOptions,
): Promise<CodexClientConfigurationResult> => {
  const request = options.request ?? fetch;
  const verified = await verifyEndpoint(options.endpoint, request);
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  const backupId = createSnapshot(paths);
  try {
    writePrivateFileAtomically(
      paths.profile,
      createCodexProfile(verified.endpoint, verified.model),
    );
    const state: CodexProfileState = {
      schemaVersion: 1,
      owner: "AI-Tidu9",
      profile: CODEX_PROFILE_NAME,
      endpoint: verified.endpoint,
      model: verified.model,
      backupId,
      configuredAt: new Date().toISOString(),
    };
    writePrivateFileAtomically(paths.state, `${JSON.stringify(state, null, 2)}\n`);
    const postWriteVerification = await verifyEndpoint(verified.endpoint, request);
    if (postWriteVerification.model !== verified.model) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "The active virtual model changed during client configuration.",
      );
    }
  } catch (error) {
    restoreSnapshot(paths, backupId, true);
    throw error;
  }

  return {
    status: "configured",
    client: "codex",
    profile: CODEX_PROFILE_NAME,
    endpoint: verified.endpoint,
    model: verified.model,
    backupId,
  };
};

export const rollbackCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientRollbackResult => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  assertSafeRegularFile(paths.profile);
  assertSafeRegularFile(paths.state);
  if (existsSync(paths.profile) !== existsSync(paths.state)) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "The managed Codex profile is incomplete; rollback refused to overwrite local files.",
    );
  }
  const managedState = readManagedState(paths.state);
  const backupId = managedState?.backupId ?? listSnapshotIds(paths)[0];
  if (backupId === undefined) {
    return { status: "missing", client: "codex", profile: CODEX_PROFILE_NAME, backupId: null };
  }
  restoreSnapshot(paths, backupId, true);
  return { status: "restored", client: "codex", profile: CODEX_PROFILE_NAME, backupId };
};

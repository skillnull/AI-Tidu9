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
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexCommand } from "../accounts/codex-host.js";
import { DEFAULT_VIRTUAL_MODEL_ID } from "../config/index.js";
import { readCodexActiveSelection } from "../connectors/codex-client-proxy.js";
import { PRODUCT, TiduError } from "../core/index.js";
import {
  installCodexDesktopProxy,
  removeCodexDesktopProxy,
  switchCodexDesktopProxy,
} from "./codex-desktop.js";
import {
  acquireManagedCodexCatalogLock,
  DEFAULT_CODEX_HARNESS,
  preserveManagedCodexHarness,
  withManagedCodexCatalogLock,
} from "./codex-model-catalog.js";

const CODEX_PROFILE_NAME = "ai-tidu9";
const prepareDesktopRecovery = (home: string, customHome?: string): void => {
  // A custom home may be an embedded/headless client and must not change the desktop environment.
  if (
    process.platform !== "darwin" ||
    customHome !== undefined ||
    home !== join(homedir(), ".codex")
  )
    return;
  const bundled = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ].find((path) => existsSync(path));
  const source = import.meta.url.endsWith(".ts");
  installCodexDesktopProxy({
    realCommand: bundled ?? resolveCodexCommand({}),
    nodeCommand: process.execPath,
    entryPath: fileURLToPath(
      new URL(`../connectors/codex-client-cli.${source ? "ts" : "js"}`, import.meta.url),
    ),
    nodeArguments: source ? ["--import", import.meta.resolve("tsx")] : [],
    codexHomeDirectory: home,
    activate: false,
  });
};
const CODEX_PROFILE_FILE = `${CODEX_PROFILE_NAME}.config.toml`;
const CODEX_MODEL_CATALOG_FILE = ".ai-tidu9-model-catalog.json";
const STATE_FILE = ".ai-tidu9-profile-state.json";
const TURN_PROVIDER_HISTORY_FILE = ".ai-tidu9-turn-providers.jsonl";
const BACKUP_DIRECTORY = ".ai-tidu9-backups";
const SNAPSHOT_MANIFEST_FILE = "snapshot.json";
const SNAPSHOT_PROFILE_FILE = "profile.config.toml";
const SNAPSHOT_STATE_FILE = "state.json";
const SNAPSHOT_MODEL_CATALOG_FILE = "model-catalog.json";
const SNAPSHOT_DEFAULT_CONFIGURATION_FILE = "config.toml";
const MANAGED_SNAPSHOT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export interface CodexClientConfigurationOptions {
  /** AI-Tidu9 management origin used by the dedicated Codex profile. */
  endpoint: string;
  /** Whether setup must verify a running endpoint before writing; defaults to true. */
  verifyRuntime?: boolean;
  /** Optional Codex home override; defaults to CODEX_HOME or the standard user directory. */
  codexHomeDirectory?: string;
  /** Optional fetch implementation for embedded runtimes and isolated tests. */
  request?: typeof fetch;
  /** Cancels setup before an obsolete network result can change local configuration. */
  signal?: AbortSignal;
}

export interface CodexOfficialModel {
  /** Account-visible official model identifier. */
  id: string;
  /** Human-readable official model name. */
  name: string;
  /** Capabilities executable through the Codex bridge and grounded in the official host catalog. */
  capabilities: readonly string[];
  /** Evidence source for the displayed capability declaration. */
  capabilitySource: "host-catalog";
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
  /** Active Codex configuration after setup; setup preserves the official default. */
  activeMode: CodexClientMode;
}

export type CodexClientMode = "official" | "ai-tidu9";

export interface CodexClientModeOptions extends CodexClientRollbackOptions {
  /** Configuration to make active for new chats and subsequent turns in resumed chats. */
  mode: CodexClientMode;
  /** Optional fetch implementation for isolated tests. */
  request?: typeof fetch;
  /** Cancels a pending mode verification when its caller disconnects or supersedes it. */
  signal?: AbortSignal;
  /** Maximum inference-probe duration; defaults to thirty seconds. */
  verificationTimeoutMilliseconds?: number;
  /** Prepares a missing or changed runtime connection within the same mode transaction. */
  endpoint?: string;
}

export interface CodexClientModelCatalogRefreshOptions extends CodexClientRollbackOptions {
  /** Optional fetch implementation for embedded runtimes and isolated tests. */
  request?: typeof fetch;
}

export interface CodexClientStatus {
  /** Whether the managed AI-Tidu9 profile is installed. */
  installed: boolean;
  /** Configuration currently selected for new chats and subsequent resumed turns. */
  activeMode: CodexClientMode;
  /** Managed endpoint, or null when the profile is not installed. */
  endpoint: string | null;
  /** Managed virtual model, or null when the profile is not installed. */
  model: string | null;
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

export interface CodexClientRemovalResult {
  /** Whether AI-Tidu9-owned Codex artifacts were absent or removed. */
  status: "missing" | "removed";
  /** Client whose dedicated configuration was removed. */
  client: "codex";
  /** Number of AI-Tidu9-owned files or directories removed. */
  removedArtifactCount: number;
}

interface CodexProfileState {
  /** Unique write generation used to reject late results from another process. */
  revision?: string;
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
  /** Official model captured before activating managed mode. */
  officialModel?: string;
  /** Latest official top-level model selection restored after managed mode. */
  officialDefaultLines?: readonly string[];
  /** Snapshot restored by the next explicit rollback. */
  backupId: string;
  /** First snapshot used to restore the pre-install Codex defaults on uninstall. */
  originalBackupId: string;
  /** ISO timestamp of the completed write. */
  configuredAt: string;
  /** Configuration selected for newly started Codex sessions. */
  activeMode?: CodexClientMode;
}

interface SnapshotManifest {
  /** Snapshot-contract version. */
  schemaVersion: 1;
  /** Whether a managed profile existed before the transaction. */
  profileExisted: boolean;
  /** Whether managed state existed before the transaction. */
  stateExisted: boolean;
  /** Whether a managed model catalog existed before the transaction. */
  modelCatalogExisted?: boolean;
  /** Whether the user-level Codex configuration existed before the transaction. */
  defaultConfigurationExisted?: boolean;
}

interface VerifiedEndpoint {
  /** Normalized runtime origin. */
  endpoint: string;
  /** Active virtual-model identifier returned by model discovery. */
  model: string;
  /** Human-readable virtual-model name returned by model discovery. */
  displayName: string;
  /** Whether the currently executable primary provider accepts Codex reasoning effort. */
  reasoningEffortSupported: boolean;
}

interface CodexFailureDiagnostic {
  /** Component responsible for the failed Codex configuration check. */
  failureSource: "ai-tidu9" | "official-codex";
  /** Stable reason identifier used by the management page. */
  reasonCode: string;
  /** Safe explanation without credentials or request content. */
  reason: string;
  /** Ordered actions that can restore service. */
  nextSteps: readonly string[];
}

interface CodexPaths {
  /** Codex configuration root. */
  home: string;
  /** Dedicated AI-Tidu9 profile file. */
  profile: string;
  /** User-level Codex configuration used to select the default profile. */
  defaultConfiguration: string;
  /** Dedicated AI-Tidu9 model catalog displayed by Codex model pickers. */
  modelCatalog: string;
  /** Official model catalog cache maintained by Codex. */
  officialModelCache: string;
  /** AI-Tidu9 ownership and connection state. */
  state: string;
  /** Root containing transaction snapshots. */
  backups: string;
}

interface PrivateFileState {
  /** Managed file path participating in one local transaction. */
  path: string;
  /** Complete file content, or undefined when the file must be absent. */
  content: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveCodexHome = (configuredDirectory?: string): string =>
  resolve(configuredDirectory ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));

const resolveCodexPaths = (configuredDirectory?: string): CodexPaths => {
  const home = resolveCodexHome(configuredDirectory);
  return {
    home,
    profile: join(home, CODEX_PROFILE_FILE),
    defaultConfiguration: join(home, "config.toml"),
    modelCatalog: join(home, CODEX_MODEL_CATALOG_FILE),
    officialModelCache: join(home, "models_cache.json"),
    state: join(home, STATE_FILE),
    backups: join(home, BACKUP_DIRECTORY),
  };
};

const MANAGED_DEFAULT_START = "# AI-Tidu9 managed default:start";
const MANAGED_DEFAULT_END = "# AI-Tidu9 managed default:end";
const MANAGED_PROVIDER_START = "# AI-Tidu9 managed provider:start";
const MANAGED_PROVIDER_END = "# AI-Tidu9 managed provider:end";

const hasManagedDefaultConfiguration = (paths: CodexPaths): boolean =>
  existsSync(paths.defaultConfiguration) &&
  readFileSync(paths.defaultConfiguration, "utf8").includes(MANAGED_DEFAULT_START);

const OFFICIAL_DEFAULT_KEYS = new Set(["model", "model_provider", "model_catalog_json"]);

const readOfficialDefaultLines = (configurationPath: string): readonly string[] => {
  if (!existsSync(configurationPath)) return [];
  assertSafeRegularFile(configurationPath);
  const lines = readFileSync(configurationPath, "utf8").split("\n");
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/u.test(line));
  const topLevelEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  return lines.slice(0, topLevelEnd).filter((line) => {
    const key = line.match(/^\s*([a-z_]+)\s*=/u)?.[1];
    return key !== undefined && OFFICIAL_DEFAULT_KEYS.has(key);
  });
};

const removeManagedBlock = (content: string, start: string, end: string): string => {
  let remaining = content;
  while (true) {
    const startIndex = remaining.indexOf(start);
    const endIndex = remaining.indexOf(end);
    if ((startIndex === -1) !== (endIndex === -1) || endIndex < startIndex) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "AI-Tidu9 found an incomplete managed Codex configuration block.",
      );
    }
    if (startIndex === -1) {
      return remaining;
    }
    remaining = `${remaining.slice(0, startIndex)}${remaining.slice(endIndex + end.length)}`;
  }
};

const addManagedProviderBlock = (content: string, endpoint: string): string => {
  const withoutManagedProvider = removeManagedBlock(
    content,
    MANAGED_PROVIDER_START,
    MANAGED_PROVIDER_END,
  );
  if (/^\s*\[model_providers\.ai_tidu9\]\s*$/mu.test(withoutManagedProvider)) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Codex already contains an unmanaged model_providers.ai_tidu9 definition.",
    );
  }
  const normalized = withoutManagedProvider.replace(/^\n+|\n+$/gu, "");
  return [
    normalized,
    MANAGED_PROVIDER_START,
    "# Local Agent runtime only. Official Codex credentials are never sent to this endpoint.",
    "[model_providers.ai_tidu9]",
    'name = "AI-Tidu9 (local)"',
    `base_url = ${JSON.stringify(`${endpoint}/v1/hosts/codex`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    MANAGED_PROVIDER_END,
  ]
    .filter((line) => line !== "")
    .join("\n");
};

const activateDefaultCodexConfiguration = (
  paths: CodexPaths,
  endpoint: string,
  model: string,
): void => {
  assertSafeRegularFile(paths.defaultConfiguration);
  const current = existsSync(paths.defaultConfiguration)
    ? readFileSync(paths.defaultConfiguration, "utf8")
    : "";
  const withoutManagedDefault = removeManagedBlock(
    current,
    MANAGED_DEFAULT_START,
    MANAGED_DEFAULT_END,
  );
  const withoutManagedBlocks = removeManagedBlock(
    withoutManagedDefault,
    MANAGED_PROVIDER_START,
    MANAGED_PROVIDER_END,
  );
  if (/^\s*\[model_providers\.ai_tidu9\]\s*$/mu.test(withoutManagedBlocks)) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Codex already contains an unmanaged model_providers.ai_tidu9 definition.",
    );
  }
  const normalizedCurrent = withoutManagedBlocks.replace(/\n+$/u, "");
  const lines = normalizedCurrent === "" ? [] : normalizedCurrent.split("\n");
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/u.test(line));
  const topLevelEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  const managedKeys = new Set(["model", "model_provider", "model_catalog_json"]);
  for (let lineIndex = topLevelEnd - 1; lineIndex >= 0; lineIndex -= 1) {
    const key = lines[lineIndex]?.match(/^\s*([a-z_]+)\s*=/u)?.[1];
    if (key !== undefined && managedKeys.has(key)) {
      lines.splice(lineIndex, 1);
    }
  }
  const updatedFirstTableIndex = lines.findIndex((line) => /^\s*\[/u.test(line));
  const insertIndex = updatedFirstTableIndex === -1 ? lines.length : updatedFirstTableIndex;
  lines.splice(
    insertIndex,
    0,
    MANAGED_DEFAULT_START,
    "# Native AI-Tidu9 Agent mode. Official models are intentionally excluded from this provider.",
    `model = ${JSON.stringify(model)}`,
    'model_provider = "ai_tidu9"',
    `model_catalog_json = ${JSON.stringify(paths.modelCatalog)}`,
    MANAGED_DEFAULT_END,
  );
  writePrivateFileAtomically(
    paths.defaultConfiguration,
    `${addManagedProviderBlock(lines.join("\n"), endpoint)}\n`,
  );
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
  const commit = () => {
    assertSafeRegularFile(targetPath);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      const currentContent =
        basename(targetPath) === CODEX_MODEL_CATALOG_FILE
          ? preserveManagedCodexHarness(dirname(targetPath), content)
          : content;
      writeFileSync(temporaryPath, currentContent, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, targetPath);
      chmodSync(targetPath, 0o600);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };
  if ([CODEX_MODEL_CATALOG_FILE, STATE_FILE].includes(basename(targetPath)))
    withManagedCodexCatalogLock(dirname(targetPath), commit);
  else commit();
};

const applyPrivateFileStatesAtomically = (states: readonly PrivateFileState[]): void => {
  const commit = () => {
    const duplicatePaths = new Set<string>();
    for (const state of states) {
      if (duplicatePaths.has(state.path)) {
        throw new TiduError("CONFIGURATION_CONFLICT", "Client file transaction is invalid.");
      }
      duplicatePaths.add(state.path);
      assertSafeRegularFile(state.path);
    }
    const transactionId = randomUUID();
    const entries = states.map((state) => ({
      ...state,
      previousPath: `${state.path}.${transactionId}.previous`,
      stagedPath: `${state.path}.${transactionId}.staged`,
      previousMoved: false,
      nextInstalled: false,
    }));
    let committed = false;
    try {
      for (const entry of entries) {
        if (entry.content === undefined) continue;
        writeFileSync(entry.stagedPath, entry.content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
      for (const entry of entries) {
        if (existsSync(entry.path)) {
          renameSync(entry.path, entry.previousPath);
          entry.previousMoved = true;
        }
        if (entry.content !== undefined) {
          renameSync(entry.stagedPath, entry.path);
          entry.nextInstalled = true;
          chmodSync(entry.path, 0o600);
        }
      }
      committed = true;
    } catch (error) {
      for (const entry of [...entries].reverse()) {
        if (entry.nextInstalled) {
          rmSync(entry.path, { force: true });
          entry.nextInstalled = false;
        }
        if (entry.previousMoved && existsSync(entry.previousPath)) {
          renameSync(entry.previousPath, entry.path);
          entry.previousMoved = false;
        }
      }
      throw error;
    } finally {
      for (const entry of entries) {
        rmSync(entry.stagedPath, { force: true });
        if (committed) rmSync(entry.previousPath, { force: true });
      }
    }
  };
  const guarded = states.find((state) =>
    [CODEX_MODEL_CATALOG_FILE, STATE_FILE].includes(basename(state.path)),
  );
  if (guarded === undefined) commit();
  else withManagedCodexCatalogLock(dirname(guarded.path), commit);
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

const aiTidu9RecoverySteps = [
  "Check that the configured local or remote AI-Tidu9 service is running and its /health endpoint is reachable.",
  "Check the AI-Tidu9 provider configuration and upstream model compatibility.",
  "Update the AI-Tidu9 Codex configuration and retry, or switch to Official mode.",
] as const;

const officialCodexRecoverySteps = [
  "Run 'codex login status' and sign in again if the official session is unavailable.",
  "Switch to an official model and verify that official Codex inference succeeds.",
  "Retry AI-Tidu9 after official Codex access is restored.",
] as const;

const createCodexFailure = (diagnostic: CodexFailureDiagnostic, cause?: unknown): TiduError => {
  const sourceLabel = diagnostic.failureSource === "official-codex" ? "Official Codex" : "AI-Tidu9";
  return new TiduError(
    "INTERNAL_ERROR",
    `Failure source: ${sourceLabel}. Reason: ${diagnostic.reason}`,
    {
      cause,
      details: {
        failureSource: diagnostic.failureSource,
        reasonCode: diagnostic.reasonCode,
        reason: diagnostic.reason,
        nextSteps: diagnostic.nextSteps,
      },
    },
  );
};

const requestJson = async (
  request: typeof fetch,
  endpoint: string,
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await request(`${endpoint}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([
        AbortSignal.timeout(5_000),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
  } catch (error) {
    throw createCodexFailure(
      {
        failureSource: "ai-tidu9",
        reasonCode: "tidu_service_unreachable",
        reason: "The configured AI-Tidu9 service cannot be reached.",
        nextSteps: aiTidu9RecoverySteps,
      },
      error,
    );
  }
  if (!response.ok) {
    throw createCodexFailure({
      failureSource: "ai-tidu9",
      reasonCode: "tidu_endpoint_http_error",
      reason: `The AI-Tidu9 connectivity check returned HTTP ${response.status}.`,
      nextSteps: aiTidu9RecoverySteps,
    });
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body)) {
    throw createCodexFailure({
      failureSource: "ai-tidu9",
      reasonCode: "tidu_invalid_response",
      reason: "The AI-Tidu9 service returned an invalid connectivity response.",
      nextSteps: aiTidu9RecoverySteps,
    });
  }
  return body;
};

const activeProviderSupportsCodexReasoningEffort = async (
  request: typeof fetch,
  endpoint: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const capabilityCompletion = await requestJson(
      request,
      endpoint,
      "/api/capability-completion",
      signal,
    );
    return capabilityCompletion.codexReasoningEffortSupported === true;
  } catch {
    return false;
  }
};

const requestInference: typeof fetch = async (input, init) => {
  const endpoint = new URL(input instanceof Request ? input.url : String(input));
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "The Codex inference probe supports only a text request body.",
    );
  }
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const sendRequest = endpoint.protocol === "https:" ? requestHttps : requestHttp;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = sendRequest(
      endpoint,
      {
        headers,
        method: init?.method ?? "GET",
        signal: init?.signal ?? undefined,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: responseHeaders,
              status: incoming.statusCode ?? 500,
            }),
          );
        });
      },
    );
    outgoing.once("error", reject);
    if (body !== undefined && body !== null) outgoing.write(body);
    outgoing.end();
  });
};

const verifyEndpoint = async (
  candidate: string,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<VerifiedEndpoint> => {
  const endpoint = normalizeEndpoint(candidate);
  const health = await requestJson(request, endpoint, "/health", signal);
  if (health.product !== PRODUCT.name || health.status !== "ok") {
    throw createCodexFailure({
      failureSource: "ai-tidu9",
      reasonCode: "tidu_health_check_failed",
      reason: "The configured endpoint is not a healthy AI-Tidu9 service.",
      nextSteps: aiTidu9RecoverySteps,
    });
  }
  const modelList = await requestJson(request, endpoint, "/v1/models", signal);
  const models = Array.isArray(modelList.data) ? modelList.data : [];
  const firstModel = models.find(
    (candidate) => isRecord(candidate) && candidate.owned_by === "AI-Tidu9",
  );
  if (
    !isRecord(firstModel) ||
    typeof firstModel.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(firstModel.id) ||
    firstModel.owned_by !== "AI-Tidu9"
  ) {
    throw createCodexFailure({
      failureSource: "ai-tidu9",
      reasonCode: "tidu_model_unavailable",
      reason: "The AI-Tidu9 service did not expose an active virtual model.",
      nextSteps: aiTidu9RecoverySteps,
    });
  }
  return {
    endpoint,
    model: firstModel.id,
    displayName:
      typeof firstModel.display_name === "string" && firstModel.display_name.trim()
        ? firstModel.display_name.trim()
        : firstModel.id,
    reasoningEffortSupported: await activeProviderSupportsCodexReasoningEffort(
      request,
      endpoint,
      signal,
    ),
  };
};

const verifyInference = async (
  endpoint: string,
  model: string,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<void> => {
  let response: Response;
  try {
    response = await request(`${endpoint}/v1/hosts/codex/responses`, {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with OK.",
        metadata: { ai_tidu9_probe: true },
        stream: false,
      }),
    });
  } catch (error) {
    throw createCodexFailure(
      {
        failureSource: "ai-tidu9",
        reasonCode: "tidu_inference_unreachable",
        reason:
          "The AI-Tidu9 inference endpoint could not be reached; Official mode remains active.",
        nextSteps: aiTidu9RecoverySteps,
      },
      error,
    );
  }
  if (response.ok) {
    return;
  }
  let detail = `HTTP ${response.status}`;
  let failureSource: CodexFailureDiagnostic["failureSource"] = "ai-tidu9";
  let reasonCode = "tidu_inference_failed";
  let nextSteps: readonly string[] = aiTidu9RecoverySteps;
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.reason === "string") {
        detail = body.error.reason;
      } else if (typeof body.error.message === "string") {
        detail = body.error.message;
      }
      if (body.error.failure_source === "official-codex") {
        failureSource = "official-codex";
        nextSteps = officialCodexRecoverySteps;
      }
      if (typeof body.error.code === "string") {
        reasonCode = body.error.code;
      }
      if (
        Array.isArray(body.error.next_steps) &&
        body.error.next_steps.every((step) => typeof step === "string")
      ) {
        nextSteps = body.error.next_steps;
      }
    }
  } catch {
    // Keep the status-only explanation when the runtime did not return JSON.
  }
  throw createCodexFailure({
    failureSource,
    reasonCode,
    reason: `${detail} Official mode remains active.`,
    nextSteps,
  });
};

const createCodexProfile = (endpoint: string, model: string, modelCatalogPath: string): string =>
  [
    "# Managed by AI-Tidu9. This file contains no provider credentials.",
    `model = ${JSON.stringify(model)}`,
    'model_provider = "ai_tidu9"',
    `model_catalog_json = ${JSON.stringify(modelCatalogPath)}`,
    "",
    "[model_providers.ai_tidu9]",
    'name = "AI-Tidu9 (local)"',
    `base_url = ${JSON.stringify(`${endpoint}/v1/hosts/codex`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n");

const restoreCodexNativeRetries = (filePath: string): void => {
  if (!existsSync(filePath)) return;
  assertSafeRegularFile(filePath);
  const original = readFileSync(filePath, "utf8");
  let managedProvider = false;
  const updated = original
    .split("\n")
    .filter((line) => {
      if (/^\s*\[/u.test(line))
        managedProvider = /^\s*\[model_providers\.ai_tidu9\]\s*$/u.test(line);
      if (line === MANAGED_PROVIDER_END) managedProvider = false;
      return !(managedProvider && /^\s*(?:request|stream)_max_retries\s*=\s*0\s*$/u.test(line));
    })
    .join("\n");
  if (updated !== original) writePrivateFileAtomically(filePath, updated);
};

const createCodexModelCatalog = (
  model: string,
  reasoningEffortSupported: boolean,
  codexHomeDirectory: string,
): string =>
  preserveManagedCodexHarness(
    codexHomeDirectory,
    `${JSON.stringify(
      {
        models: [
          {
            slug: model,
            display_name: "AI-Tidu9",
            description: "AI-Tidu9 local Agent service",
            ...(reasoningEffortSupported ? { default_reasoning_level: "medium" } : {}),
            supported_reasoning_levels: reasoningEffortSupported
              ? [
                  {
                    effort: "low",
                    description: "Fast responses with lighter reasoning",
                  },
                  {
                    effort: "medium",
                    description: "Balances speed and reasoning depth for everyday tasks",
                  },
                  {
                    effort: "high",
                    description: "Greater reasoning depth for complex problems",
                  },
                  {
                    effort: "xhigh",
                    description: "Extra high reasoning depth for complex problems",
                  },
                  {
                    effort: "max",
                    description: "Maximum reasoning depth for the hardest problems",
                  },
                  {
                    effort: "ultra",
                    description: "Maximum reasoning with automatic task delegation",
                  },
                ]
              : [],
            ...DEFAULT_CODEX_HARNESS,
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            additional_speed_tiers: [],
            service_tiers: [],
            upgrade: null,
            default_reasoning_summary: "auto",
            support_verbosity: true,
            default_verbosity: "low",
            truncation_policy: { mode: "tokens", limit: 10_000 },
            input_modalities: ["text", "image"],
            supports_parallel_tool_calls: true,
            supports_image_detail_original: true,
            supports_search_tool: true,
            web_search_tool_type: "text_and_image",
            context_window: 128_000,
            max_context_window: 128_000,
            comp_hash: null,
            effective_context_window_percent: 95,
            experimental_supported_tools: [],
            use_responses_lite: false,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

const readOfficialCatalogModels = (paths: CodexPaths): Record<string, unknown>[] => {
  if (!existsSync(paths.officialModelCache)) return [];
  assertSafeRegularFile(paths.officialModelCache);
  try {
    const cache = JSON.parse(readFileSync(paths.officialModelCache, "utf8")) as unknown;
    if (!isRecord(cache) || !Array.isArray(cache.models)) return [];
    return cache.models.filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        typeof candidate.slug === "string" &&
        candidate.slug.trim() !== "" &&
        typeof candidate.display_name === "string" &&
        candidate.visibility === "list" &&
        candidate.supported_in_api === true,
    );
  } catch {
    return [];
  }
};

const readManagedCatalogHistory = (
  paths: CodexPaths,
  tiduModel: string,
): Record<string, unknown>[] => {
  const catalogPaths = [paths.modelCatalog];
  if (existsSync(paths.backups)) {
    for (const entry of readdirSync(paths.backups, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        catalogPaths.push(join(paths.backups, entry.name, SNAPSHOT_MODEL_CATALOG_FILE));
      }
    }
  }
  return catalogPaths.flatMap((catalogPath) => {
    if (!existsSync(catalogPath)) return [];
    assertSafeRegularFile(catalogPath);
    try {
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
      if (!isRecord(catalog) || !Array.isArray(catalog.models)) return [];
      return catalog.models.filter(
        (candidate): candidate is Record<string, unknown> =>
          isRecord(candidate) &&
          typeof candidate.slug === "string" &&
          candidate.slug !== tiduModel &&
          candidate.slug !== "managed-default" &&
          !(
            typeof candidate.description === "string" &&
            candidate.description.startsWith("Company service model")
          ) &&
          candidate.visibility === "list" &&
          candidate.supported_in_api === true,
      );
    } catch {
      return [];
    }
  });
};

export const listCodexOfficialModels = (
  codexHomeDirectory?: string,
): readonly CodexOfficialModel[] => {
  const paths = resolveCodexPaths(codexHomeDirectory);
  const currentModels = readOfficialCatalogModels(paths);
  const historicalModels = readManagedCatalogHistory(paths, DEFAULT_VIRTUAL_MODEL_ID).sort(
    (left, right) => String(left.slug).localeCompare(String(right.slug), "en"),
  );
  const modelsById = new Map<string, CodexOfficialModel>();
  for (const model of [...currentModels, ...historicalModels]) {
    const id = String(model.slug);
    if (!modelsById.has(id)) {
      const inputModalities = Array.isArray(model.input_modalities)
        ? model.input_modalities.filter((value): value is string => typeof value === "string")
        : [];
      const contextWindow =
        typeof model.context_window === "number"
          ? model.context_window
          : typeof model.max_context_window === "number"
            ? model.max_context_window
            : 0;
      const capabilities = new Set<string>();
      if (inputModalities.includes("text")) {
        capabilities.add("text");
        capabilities.add("structured-output");
      }
      if (inputModalities.includes("image")) capabilities.add("vision");
      if (
        Array.isArray(model.supported_reasoning_levels) &&
        model.supported_reasoning_levels.length > 0
      ) {
        capabilities.add("reasoning");
      }
      if (
        (typeof model.tool_mode === "string" && model.tool_mode.includes("code")) ||
        typeof model.apply_patch_tool_type === "string" ||
        typeof model.shell_type === "string"
      ) {
        capabilities.add("code");
        capabilities.add("tool-use");
      }
      if (model.supports_parallel_tool_calls === true) capabilities.add("tool-use");
      if (model.supports_search_tool === true) capabilities.add("web-research");
      if (contextWindow >= 100_000) capabilities.add("long-context");
      modelsById.set(id, {
        id,
        name: String(model.display_name),
        capabilities: [...capabilities],
        capabilitySource: "host-catalog",
      });
    }
  }
  return [...modelsById.values()];
};

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
    (state.officialModel !== undefined && typeof state.officialModel !== "string") ||
    (state.officialDefaultLines !== undefined &&
      (!Array.isArray(state.officialDefaultLines) ||
        !state.officialDefaultLines.every(
          (line) =>
            typeof line === "string" &&
            OFFICIAL_DEFAULT_KEYS.has(line.match(/^\s*([a-z_]+)\s*=/u)?.[1] ?? ""),
        ))) ||
    typeof state.backupId !== "string" ||
    !MANAGED_SNAPSHOT_ID_PATTERN.test(state.backupId) ||
    (state.originalBackupId !== undefined &&
      (typeof state.originalBackupId !== "string" ||
        !MANAGED_SNAPSHOT_ID_PATTERN.test(state.originalBackupId))) ||
    typeof state.configuredAt !== "string"
  ) {
    throw new TiduError("CONFIGURATION_CONFLICT", "AI-Tidu9 client state is invalid.");
  }
  return {
    ...(state as unknown as CodexProfileState),
    originalBackupId:
      typeof state.originalBackupId === "string" ? state.originalBackupId : state.backupId,
    activeMode: state.activeMode === "ai-tidu9" ? "ai-tidu9" : "official",
  };
};

const writeManagedState = (path: string, state: CodexProfileState): CodexProfileState => {
  const updated = { ...state, revision: randomUUID() };
  writePrivateFileAtomically(path, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
};

const managedStateMatches = (path: string, expected: CodexProfileState): boolean =>
  JSON.stringify(readManagedState(path)) === JSON.stringify(expected);

const assertManagedStateUnchanged = (path: string, expected: CodexProfileState): void => {
  if (!managedStateMatches(path, expected))
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Codex configuration changed during verification; the newer configuration was preserved.",
    );
};

const createSnapshot = (paths: CodexPaths): string => {
  ensureSafeDirectory(paths.home);
  assertSafeRegularFile(paths.profile);
  assertSafeRegularFile(paths.defaultConfiguration);
  assertSafeRegularFile(paths.modelCatalog);
  assertSafeRegularFile(paths.state);
  const profileExisted = existsSync(paths.profile);
  const modelCatalogExisted = existsSync(paths.modelCatalog);
  const stateExisted = existsSync(paths.state);
  const defaultConfigurationExisted = existsSync(paths.defaultConfiguration);
  if (profileExisted !== stateExisted || (modelCatalogExisted && !stateExisted)) {
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
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      profileExisted,
      stateExisted,
      modelCatalogExisted,
      defaultConfigurationExisted,
    };
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
    if (modelCatalogExisted) {
      copyFileSync(paths.modelCatalog, join(snapshotDirectory, SNAPSHOT_MODEL_CATALOG_FILE));
      chmodSync(join(snapshotDirectory, SNAPSHOT_MODEL_CATALOG_FILE), 0o600);
    }
    if (defaultConfigurationExisted) {
      copyFileSync(
        paths.defaultConfiguration,
        join(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE),
      );
      chmodSync(join(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE), 0o600);
    }
  } catch (error) {
    rmSync(snapshotDirectory, { force: true, recursive: true });
    throw error;
  }
  return backupId;
};

const readSnapshotManifest = (snapshotDirectory: string): SnapshotManifest => {
  const manifestPath = join(snapshotDirectory, SNAPSHOT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup manifest is missing.");
  }
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
    typeof manifest.stateExisted !== "boolean" ||
    (manifest.modelCatalogExisted !== undefined &&
      typeof manifest.modelCatalogExisted !== "boolean") ||
    (manifest.defaultConfigurationExisted !== undefined &&
      typeof manifest.defaultConfigurationExisted !== "boolean")
  ) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup manifest is invalid.");
  }
  return manifest as unknown as SnapshotManifest;
};

const resolveSnapshotDirectory = (paths: CodexPaths, backupId: string): string => {
  if (!MANAGED_SNAPSHOT_ID_PATTERN.test(backupId)) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup identifier is invalid.");
  }
  if (!existsSync(paths.backups)) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup directory is missing.");
  }
  const backupStatus = lstatSync(paths.backups);
  if (!backupStatus.isDirectory() || backupStatus.isSymbolicLink()) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "AI-Tidu9 Codex backups must be a real directory.",
    );
  }
  const snapshotDirectory = join(paths.backups, backupId);
  if (!existsSync(snapshotDirectory)) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup snapshot is missing.");
  }
  const snapshotStatus = lstatSync(snapshotDirectory);
  if (!snapshotStatus.isDirectory() || snapshotStatus.isSymbolicLink()) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup snapshot is invalid.");
  }
  return snapshotDirectory;
};

const readSnapshotFile = (snapshotDirectory: string, fileName: string): string => {
  const snapshotPath = join(snapshotDirectory, fileName);
  if (!existsSync(snapshotPath)) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Client backup snapshot is incomplete.");
  }
  assertSafeRegularFile(snapshotPath);
  return readFileSync(snapshotPath, "utf8");
};

const readSnapshotRestoration = (
  paths: CodexPaths,
  backupId: string,
): { snapshotDirectory: string; states: readonly PrivateFileState[] } => {
  const snapshotDirectory = resolveSnapshotDirectory(paths, backupId);
  const manifest = readSnapshotManifest(snapshotDirectory);
  const states = [
    {
      path: paths.profile,
      content: manifest.profileExisted
        ? readSnapshotFile(snapshotDirectory, SNAPSHOT_PROFILE_FILE)
        : undefined,
    },
    {
      path: paths.state,
      content: manifest.stateExisted
        ? readSnapshotFile(snapshotDirectory, SNAPSHOT_STATE_FILE)
        : undefined,
    },
    {
      path: paths.modelCatalog,
      content: manifest.modelCatalogExisted
        ? readSnapshotFile(snapshotDirectory, SNAPSHOT_MODEL_CATALOG_FILE)
        : undefined,
    },
    {
      path: paths.defaultConfiguration,
      content: manifest.defaultConfigurationExisted
        ? readSnapshotFile(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE)
        : undefined,
    },
  ];
  return { snapshotDirectory, states };
};

const restoreSnapshot = (paths: CodexPaths, backupId: string, removeSnapshot: boolean): void => {
  withManagedCodexCatalogLock(paths.home, () => {
    const restoration = readSnapshotRestoration(paths, backupId);
    applyPrivateFileStatesAtomically(restoration.states);
    const restored = readManagedState(paths.state);
    if (restored !== undefined) writeManagedState(paths.state, restored);
    if (removeSnapshot) {
      rmSync(restoration.snapshotDirectory, { force: true, recursive: true });
    }
  });
};

const createRestoredDefaultConfiguration = (
  paths: CodexPaths,
  backupId: string,
  retainedProviderEndpoint?: string,
  retainedDefaultLines?: readonly string[],
): string | undefined => {
  const snapshotDirectory = resolveSnapshotDirectory(paths, backupId);
  const manifest = readSnapshotManifest(snapshotDirectory);
  const original = manifest.defaultConfigurationExisted
    ? readSnapshotFile(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE)
    : "";
  assertSafeRegularFile(paths.defaultConfiguration);
  const current = existsSync(paths.defaultConfiguration)
    ? readFileSync(paths.defaultConfiguration, "utf8")
    : "";
  const withoutManagedDefault = removeManagedBlock(
    current,
    MANAGED_DEFAULT_START,
    MANAGED_DEFAULT_END,
  );
  const withoutManagedBlocks = removeManagedBlock(
    withoutManagedDefault,
    MANAGED_PROVIDER_START,
    MANAGED_PROVIDER_END,
  );
  const originalLines = original.replace(/\n+$/u, "").split("\n");
  const originalFirstTableIndex = originalLines.findIndex((line) => /^\s*\[/u.test(line));
  const originalTopLevelEnd =
    originalFirstTableIndex === -1 ? originalLines.length : originalFirstTableIndex;
  const managedKeys = new Set(["model", "model_provider", "model_catalog_json"]);
  const originalManagedLines =
    retainedDefaultLines ??
    originalLines.slice(0, originalTopLevelEnd).filter((line) => {
      const key = line.match(/^\s*([a-z_]+)\s*=/u)?.[1];
      return key !== undefined && managedKeys.has(key);
    });
  const remaining = withoutManagedBlocks.replace(/^\n+|\n+$/gu, "");
  const remainingLines = remaining === "" ? [] : remaining.split("\n");
  const firstTableIndex = remainingLines.findIndex((line) => /^\s*\[/u.test(line));
  const remainingTopLevelEnd = firstTableIndex === -1 ? remainingLines.length : firstTableIndex;
  for (let lineIndex = remainingTopLevelEnd - 1; lineIndex >= 0; lineIndex -= 1) {
    const key = remainingLines[lineIndex]?.match(/^\s*([a-z_]+)\s*=/u)?.[1];
    if (key !== undefined && managedKeys.has(key)) {
      remainingLines.splice(lineIndex, 1);
    }
  }
  const updatedFirstTableIndex = remainingLines.findIndex((line) => /^\s*\[/u.test(line));
  const insertIndex =
    updatedFirstTableIndex === -1 ? remainingLines.length : updatedFirstTableIndex;
  remainingLines.splice(insertIndex, 0, ...originalManagedLines);
  const restored = remainingLines.join("\n").replace(/^\n+|\n+$/gu, "");
  if (
    restored === "" &&
    !manifest.defaultConfigurationExisted &&
    retainedProviderEndpoint === undefined
  ) {
    return undefined;
  }
  const officialCompatibleConfiguration =
    retainedProviderEndpoint === undefined
      ? restored
      : addManagedProviderBlock(restored, retainedProviderEndpoint);
  return `${officialCompatibleConfiguration}\n`;
};

const restoreDefaultConfigurationValues = (
  paths: CodexPaths,
  backupId: string,
  retainedProviderEndpoint?: string,
  retainedDefaultLines?: readonly string[],
): void => {
  const content = createRestoredDefaultConfiguration(
    paths,
    backupId,
    retainedProviderEndpoint,
    retainedDefaultLines,
  );
  applyPrivateFileStatesAtomically([{ path: paths.defaultConfiguration, content }]);
};

const readManagedProfileEndpoint = (paths: CodexPaths): string | undefined => {
  if (!existsSync(paths.profile)) return undefined;
  assertSafeRegularFile(paths.profile);
  const content = readFileSync(paths.profile, "utf8");
  if (
    !content.startsWith("# Managed by AI-Tidu9.") ||
    !/^\s*\[model_providers\.ai_tidu9\]\s*$/mu.test(content)
  )
    return undefined;
  const encodedBaseUrl = /^\s*base_url\s*=\s*("(?:[^"\\]|\\.)*")\s*$/mu.exec(content)?.[1];
  if (encodedBaseUrl === undefined) return undefined;
  try {
    const baseUrl = JSON.parse(encodedBaseUrl) as unknown;
    const suffix = "/v1/hosts/codex";
    return typeof baseUrl === "string" && baseUrl.endsWith(suffix)
      ? normalizeEndpoint(baseUrl.slice(0, -suffix.length))
      : undefined;
  } catch {
    return undefined;
  }
};

const deactivateManagedDefaultConfiguration = (
  paths: CodexPaths,
  retainedEndpoint?: string,
): void => {
  assertSafeRegularFile(paths.defaultConfiguration);
  const current = existsSync(paths.defaultConfiguration)
    ? readFileSync(paths.defaultConfiguration, "utf8")
    : "";
  const withoutManagedDefault = removeManagedBlock(
    current,
    MANAGED_DEFAULT_START,
    MANAGED_DEFAULT_END,
  );
  const managedEndpoint = retainedEndpoint ?? readManagedProfileEndpoint(paths);
  const officialCompatible =
    managedEndpoint === undefined
      ? withoutManagedDefault
      : addManagedProviderBlock(withoutManagedDefault, managedEndpoint);
  if (officialCompatible !== current) {
    writePrivateFileAtomically(
      paths.defaultConfiguration,
      `${officialCompatible.replace(/\n+$/u, "")}\n`,
    );
  }
};

const listSnapshotIds = (paths: CodexPaths): readonly string[] => {
  if (!existsSync(paths.backups)) {
    return [];
  }
  ensureSafeDirectory(paths.backups);
  return readdirSync(paths.backups, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        MANAGED_SNAPSHOT_ID_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
};

const pruneManagedSnapshots = (paths: CodexPaths, retainedIds: readonly string[]): void => {
  const retained = new Set(retainedIds);
  for (const backupId of listSnapshotIds(paths)) {
    if (retained.has(backupId)) {
      continue;
    }
    const snapshotDirectory = resolveSnapshotDirectory(paths, backupId);
    try {
      readSnapshotManifest(snapshotDirectory);
    } catch {
      continue;
    }
    rmSync(snapshotDirectory, { force: true, recursive: true });
  }
};

const applyCodexClientConfiguration = async (
  options: CodexClientConfigurationOptions,
): Promise<CodexClientConfigurationResult> => {
  const request = options.request ?? fetch;
  const verified =
    options.verifyRuntime === false
      ? {
          endpoint: normalizeEndpoint(options.endpoint),
          model: DEFAULT_VIRTUAL_MODEL_ID,
          displayName: PRODUCT.name,
          reasoningEffortSupported: false,
        }
      : await verifyEndpoint(options.endpoint, request, options.signal);
  options.signal?.throwIfAborted();
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  let catalogLock = acquireManagedCodexCatalogLock(paths.home);
  try {
    let existingState = readManagedState(paths.state);
    if (existingState !== undefined && hasManagedDefaultConfiguration(paths)) {
      restoreDefaultConfigurationValues(
        paths,
        existingState.originalBackupId,
        existingState.endpoint,
        existingState.officialDefaultLines,
      );
      existingState = {
        ...existingState,
        activeMode: "official",
        configuredAt: new Date().toISOString(),
      };
      writeManagedState(paths.state, existingState);
    }
    const expectedCatalog = createCodexModelCatalog(
      verified.model,
      verified.reasoningEffortSupported,
      paths.home,
    );
    const expectedProfile = createCodexProfile(
      verified.endpoint,
      verified.model,
      paths.modelCatalog,
    );
    if (
      existingState?.endpoint === verified.endpoint &&
      existingState.model === verified.model &&
      existsSync(paths.profile) &&
      existsSync(paths.modelCatalog) &&
      readFileSync(paths.profile, "utf8") === expectedProfile &&
      readFileSync(paths.modelCatalog, "utf8") === expectedCatalog
    ) {
      const officialModel = readCodexActiveSelection(paths.home).model;
      const officialDefaultLines = readOfficialDefaultLines(paths.defaultConfiguration);
      restoreDefaultConfigurationValues(
        paths,
        existingState.originalBackupId,
        existingState.endpoint,
        officialDefaultLines,
      );
      writeManagedState(paths.state, {
        ...existingState,
        officialModel,
        officialDefaultLines,
        activeMode: "official",
        configuredAt: new Date().toISOString(),
      });
      pruneManagedSnapshots(paths, [existingState.originalBackupId, existingState.backupId]);
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
      return {
        status: "configured",
        client: "codex",
        profile: CODEX_PROFILE_NAME,
        endpoint: verified.endpoint,
        model: verified.model,
        backupId: existingState.backupId,
        activeMode: "official",
      };
    }
    if (existingState?.activeMode === "ai-tidu9") {
      restoreDefaultConfigurationValues(
        paths,
        existingState.originalBackupId,
        existingState.endpoint,
        existingState.officialDefaultLines,
      );
    }
    const backupId = createSnapshot(paths);
    let writtenState: CodexProfileState | undefined;
    try {
      const officialModel = readCodexActiveSelection(paths.home).model;
      const officialDefaultLines = readOfficialDefaultLines(paths.defaultConfiguration);
      writePrivateFileAtomically(paths.modelCatalog, expectedCatalog);
      writePrivateFileAtomically(paths.profile, expectedProfile);
      let state: CodexProfileState = {
        schemaVersion: 1,
        owner: "AI-Tidu9",
        profile: CODEX_PROFILE_NAME,
        endpoint: verified.endpoint,
        model: verified.model,
        ...(officialModel === undefined ? {} : { officialModel }),
        officialDefaultLines,
        backupId,
        originalBackupId: existingState?.originalBackupId ?? backupId,
        configuredAt: new Date().toISOString(),
        activeMode: "official",
      };
      state = writeManagedState(paths.state, state);
      writtenState = state;
      restoreDefaultConfigurationValues(
        paths,
        state.originalBackupId,
        state.endpoint,
        state.officialDefaultLines,
      );
      if (options.verifyRuntime !== false) {
        catalogLock.release();
        const postWriteVerification = await verifyEndpoint(
          verified.endpoint,
          request,
          options.signal,
        );
        options.signal?.throwIfAborted();
        catalogLock = acquireManagedCodexCatalogLock(paths.home);
        assertManagedStateUnchanged(paths.state, state);
        if (postWriteVerification.model !== verified.model) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "The active virtual model changed during client configuration.",
          );
        }
      }
      pruneManagedSnapshots(paths, [state.originalBackupId, state.backupId]);
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
    } catch (error) {
      if (!options.signal?.aborted)
        withManagedCodexCatalogLock(paths.home, () => {
          if (writtenState === undefined || managedStateMatches(paths.state, writtenState))
            restoreSnapshot(paths, backupId, true);
        });
      throw error;
    }

    return {
      status: "configured",
      client: "codex",
      profile: CODEX_PROFILE_NAME,
      endpoint: verified.endpoint,
      model: verified.model,
      backupId,
      activeMode: "official",
    };
  } finally {
    catalogLock.release();
  }
};

export const configureCodexClient = (
  options: CodexClientConfigurationOptions,
): Promise<CodexClientConfigurationResult> =>
  runConfigurationMutation(options, (signal) =>
    applyCodexClientConfiguration({ ...options, signal }),
  );

export const inspectCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientStatus => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  let state: CodexProfileState | undefined;
  try {
    state = readManagedState(paths.state);
  } catch (error) {
    if (hasManagedDefaultConfiguration(paths)) throw error;
  }
  return {
    installed: state !== undefined && existsSync(paths.profile) && existsSync(paths.modelCatalog),
    activeMode:
      state !== undefined && hasManagedDefaultConfiguration(paths) ? "ai-tidu9" : "official",
    endpoint: state?.endpoint ?? null,
    model: state?.model ?? null,
  };
};

export const refreshCodexClientModelCatalog = async (
  options: CodexClientModelCatalogRefreshOptions = {},
): Promise<CodexClientStatus> =>
  runConfigurationMutation(
    options,
    async (signal) => {
      const paths = resolveCodexPaths(options.codexHomeDirectory);
      const state = readManagedState(paths.state);
      if (
        state === undefined ||
        !existsSync(paths.profile) ||
        !hasManagedDefaultConfiguration(paths)
      ) {
        return inspectCodexClientConfiguration(options);
      }
      const verified = await verifyEndpoint(state.endpoint, options.request ?? fetch, signal);
      return withManagedCodexCatalogLock(paths.home, () => {
        signal.throwIfAborted();
        assertManagedStateUnchanged(paths.state, state);
        if (verified.model !== state.model) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "The active virtual model changed after the Codex client was configured.",
          );
        }
        writePrivateFileAtomically(
          paths.modelCatalog,
          createCodexModelCatalog(state.model, verified.reasoningEffortSupported, paths.home),
        );
        restoreCodexNativeRetries(paths.profile);
        restoreCodexNativeRetries(paths.defaultConfiguration);
        return inspectCodexClientConfiguration(options);
      });
    },
    false,
  );

const applyCodexClientMode = async (
  options: CodexClientModeOptions,
): Promise<CodexClientStatus> => {
  if (options.mode === "ai-tidu9" && options.endpoint !== undefined) {
    const status = inspectCodexClientConfiguration(options);
    if (!status.installed || status.endpoint !== normalizeEndpoint(options.endpoint))
      await applyCodexClientConfiguration({
        endpoint: options.endpoint,
        codexHomeDirectory: options.codexHomeDirectory,
        request: options.request,
        signal: options.signal,
      });
    options.signal?.throwIfAborted();
  }
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  let catalogLock = acquireManagedCodexCatalogLock(paths.home);
  try {
    let state: CodexProfileState | undefined;
    try {
      state = readManagedState(paths.state);
    } catch (error) {
      if (options.mode !== "official") throw error;
      deactivateManagedDefaultConfiguration(paths);
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
      return inspectCodexClientConfiguration(options);
    }
    if (state === undefined) {
      if (options.mode === "official") {
        deactivateManagedDefaultConfiguration(paths);
        prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
        switchCodexDesktopProxy(true, paths.home);
        return inspectCodexClientConfiguration(options);
      }
      throw new TiduError(
        "CONFIGURATION_INVALID",
        "Install the AI-Tidu9 Codex profile before switching to it.",
      );
    }
    const installed = existsSync(paths.profile) && existsSync(paths.modelCatalog);
    if (!installed && options.mode === "official") {
      restoreDefaultConfigurationValues(
        paths,
        state.originalBackupId,
        state.endpoint,
        state.officialDefaultLines,
      );
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
      writeManagedState(paths.state, {
        ...state,
        activeMode: "official",
        configuredAt: new Date().toISOString(),
      });
      return inspectCodexClientConfiguration(options);
    }
    if (!installed) {
      throw new TiduError(
        "CONFIGURATION_INVALID",
        "Install the AI-Tidu9 Codex profile before switching to it.",
      );
    }
    const managedDefaultActive = hasManagedDefaultConfiguration(paths);
    const activeMode = managedDefaultActive ? "ai-tidu9" : "official";
    if (activeMode === options.mode && options.mode === "official") {
      deactivateManagedDefaultConfiguration(paths, state.endpoint);
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
      writeManagedState(paths.state, {
        ...state,
        activeMode: "official",
        configuredAt: new Date().toISOString(),
      });
      return inspectCodexClientConfiguration(options);
    }
    let nextState = state;
    if (options.mode === "ai-tidu9") {
      const request = options.request ?? fetch;
      if (activeMode === "official") {
        const officialModel = readCodexActiveSelection(paths.home).model;
        const officialDefaultLines = readOfficialDefaultLines(paths.defaultConfiguration);
        nextState = {
          ...state,
          officialModel,
          officialDefaultLines,
        };
      }
      try {
        catalogLock.release();
        prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
        await verifyEndpoint(state.endpoint, request, options.signal);
        options.signal?.throwIfAborted();
        assertManagedStateUnchanged(paths.state, state);
        restoreCodexNativeRetries(paths.profile);
        await verifyInference(
          state.endpoint,
          state.model,
          options.request ?? requestInference,
          AbortSignal.any([
            AbortSignal.timeout(options.verificationTimeoutMilliseconds ?? 30_000),
            ...(options.signal === undefined ? [] : [options.signal]),
          ]),
        );
        options.signal?.throwIfAborted();
        assertManagedStateUnchanged(paths.state, state);
        const verified = await verifyEndpoint(state.endpoint, request, options.signal);
        options.signal?.throwIfAborted();
        catalogLock = acquireManagedCodexCatalogLock(paths.home);
        assertManagedStateUnchanged(paths.state, state);
        if (activeMode === "official") {
          nextState = {
            ...nextState,
            officialModel: readCodexActiveSelection(paths.home).model,
            officialDefaultLines: readOfficialDefaultLines(paths.defaultConfiguration),
          };
        }
        writePrivateFileAtomically(
          paths.modelCatalog,
          createCodexModelCatalog(state.model, verified.reasoningEffortSupported, paths.home),
        );
        options.signal?.throwIfAborted();
        activateDefaultCodexConfiguration(paths, state.endpoint, state.model);
        switchCodexDesktopProxy(true, paths.home);
      } catch (error) {
        options.signal?.throwIfAborted();
        catalogLock.release();
        catalogLock = acquireManagedCodexCatalogLock(paths.home);
        if (!managedStateMatches(paths.state, state)) throw error;
        if (activeMode === "official" && !hasManagedDefaultConfiguration(paths))
          nextState = {
            ...nextState,
            officialModel: readCodexActiveSelection(paths.home).model,
            officialDefaultLines: readOfficialDefaultLines(paths.defaultConfiguration),
          };
        restoreDefaultConfigurationValues(
          paths,
          state.originalBackupId,
          state.endpoint,
          nextState.officialDefaultLines,
        );
        writeManagedState(paths.state, {
          ...nextState,
          activeMode: "official",
          configuredAt: new Date().toISOString(),
        });
        switchCodexDesktopProxy(true, paths.home);
        throw error;
      }
    } else {
      restoreDefaultConfigurationValues(
        paths,
        state.originalBackupId,
        state.endpoint,
        state.officialDefaultLines,
      );
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      switchCodexDesktopProxy(true, paths.home);
    }
    writeManagedState(paths.state, {
      ...nextState,
      activeMode: options.mode,
      configuredAt: new Date().toISOString(),
    });
    return inspectCodexClientConfiguration(options);
  } finally {
    catalogLock.release();
  }
};

const configurationMutations = new Map<
  string,
  { controllers: AbortController[]; completed: Promise<void> }
>();

const cancelConfigurationMutations = (home: string): void => {
  configurationMutations.get(home)?.controllers.forEach((controller) => {
    controller.abort();
  });
};

const runConfigurationMutation = async <Result>(
  options: CodexClientRollbackOptions & { signal?: AbortSignal },
  apply: (signal: AbortSignal) => Promise<Result>,
  supersede = true,
): Promise<Result> => {
  options.signal?.throwIfAborted();
  const home = resolveCodexHome(options.codexHomeDirectory);
  const previous = configurationMutations.get(home);
  if (supersede) cancelConfigurationMutations(home);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const pending = (previous?.completed ?? Promise.resolve()).then(() => {
    controller.signal.throwIfAborted();
    return apply(controller.signal);
  });
  const entry = {
    controllers: [...(supersede ? [] : (previous?.controllers ?? [])), controller],
    completed: pending.then(
      () => undefined,
      () => undefined,
    ),
  };
  configurationMutations.set(home, entry);
  try {
    return await pending;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (configurationMutations.get(home) === entry) configurationMutations.delete(home);
  }
};

/** Serializes each home independently; a newer choice cancels and drains the older verification. */
export const switchCodexClientConfiguration = async (
  options: CodexClientModeOptions,
): Promise<CodexClientStatus> => {
  const timeout = options.verificationTimeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Mode verification timeout must be a positive safe integer.",
    );
  return runConfigurationMutation(options, (signal) =>
    applyCodexClientMode({ ...options, signal }),
  );
};

export const rollbackCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientRollbackResult => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  if (!existsSync(paths.home))
    return { status: "missing", client: "codex", profile: CODEX_PROFILE_NAME, backupId: null };
  return withManagedCodexCatalogLock(paths.home, () => {
    cancelConfigurationMutations(paths.home);
    assertSafeRegularFile(paths.profile);
    assertSafeRegularFile(paths.defaultConfiguration);
    assertSafeRegularFile(paths.modelCatalog);
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
      return {
        status: "missing",
        client: "codex",
        profile: CODEX_PROFILE_NAME,
        backupId: null,
      };
    }
    restoreSnapshot(paths, backupId, true);
    if (inspectCodexClientConfiguration(options).installed)
      switchCodexDesktopProxy(true, paths.home);
    else removeCodexDesktopProxy(paths.home);
    return {
      status: "restored",
      client: "codex",
      profile: CODEX_PROFILE_NAME,
      backupId,
    };
  });
};

export const removeCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientRemovalResult => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  if (!existsSync(paths.home))
    return { status: "missing", client: "codex", removedArtifactCount: 0 };
  return withManagedCodexCatalogLock(paths.home, () => {
    cancelConfigurationMutations(paths.home);
    assertSafeRegularFile(paths.profile);
    assertSafeRegularFile(paths.defaultConfiguration);
    assertSafeRegularFile(paths.modelCatalog);
    assertSafeRegularFile(paths.state);
    const profileExists = existsSync(paths.profile);
    const stateExists = existsSync(paths.state);
    if (profileExists !== stateExists) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "The ai-tidu9 Codex profile is incomplete or unmanaged; complete uninstall refused to remove it.",
      );
    }
    const managedState = stateExists ? readManagedState(paths.state) : undefined;
    const modelCatalogExists = existsSync(paths.modelCatalog);
    if (modelCatalogExists && !stateExists) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "The AI-Tidu9 model catalog exists without managed ownership state.",
      );
    }
    if (managedState?.activeMode === "ai-tidu9" && !existsSync(paths.backups)) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "The original Codex configuration snapshot is missing; restore the official configuration before uninstalling.",
      );
    }

    const turnProviderHistory = join(paths.home, TURN_PROVIDER_HISTORY_FILE);
    assertSafeRegularFile(turnProviderHistory);
    const turnProviderHistoryExists = existsSync(turnProviderHistory);
    const backupsExist = existsSync(paths.backups);
    let restoredDefaultConfiguration: string | undefined;
    if (backupsExist) {
      const backupStatus = lstatSync(paths.backups);
      if (!backupStatus.isDirectory() || backupStatus.isSymbolicLink()) {
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          "AI-Tidu9 Codex backups must be a real directory before removal.",
        );
      }
      if (managedState !== undefined) {
        const retainedDefaultLines = hasManagedDefaultConfiguration(paths)
          ? managedState.officialDefaultLines
          : readOfficialDefaultLines(paths.defaultConfiguration);
        restoredDefaultConfiguration = createRestoredDefaultConfiguration(
          paths,
          managedState.originalBackupId,
          undefined,
          retainedDefaultLines,
        );
      }
    }

    let removedArtifactCount = 0;
    applyPrivateFileStatesAtomically([
      ...(profileExists
        ? [
            { path: paths.profile, content: undefined },
            { path: paths.state, content: undefined },
          ]
        : []),
      ...(modelCatalogExists ? [{ path: paths.modelCatalog, content: undefined }] : []),
      ...(turnProviderHistoryExists ? [{ path: turnProviderHistory, content: undefined }] : []),
      ...(backupsExist && managedState !== undefined
        ? [
            {
              path: paths.defaultConfiguration,
              content: restoredDefaultConfiguration,
            },
          ]
        : []),
    ]);
    if (profileExists) removedArtifactCount += 2;
    if (modelCatalogExists) removedArtifactCount += 1;
    if (turnProviderHistoryExists) removedArtifactCount += 1;
    if (removeCodexDesktopProxy(paths.home)) removedArtifactCount += 1;
    if (backupsExist) {
      rmSync(paths.backups, { recursive: true });
      removedArtifactCount += 1;
    }
    return {
      status: removedArtifactCount === 0 ? "missing" : "removed",
      client: "codex",
      removedArtifactCount,
    };
  });
};

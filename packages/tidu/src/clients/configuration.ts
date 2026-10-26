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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexCommand } from "../accounts/codex-host.js";
import { DEFAULT_VIRTUAL_MODEL_ID } from "../config/index.js";
import { PRODUCT, TiduError } from "../core/index.js";
import {
  installCodexDesktopProxy,
  removeCodexDesktopProxy,
  switchCodexDesktopProxy,
} from "./codex-desktop.js";

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
  /** Configuration to make active for newly started Codex sessions. */
  mode: CodexClientMode;
  /** Optional fetch implementation for isolated tests. */
  request?: typeof fetch;
}

export interface CodexClientModelCatalogRefreshOptions extends CodexClientRollbackOptions {
  /** Optional fetch implementation for embedded runtimes and isolated tests. */
  request?: typeof fetch;
}

export interface CodexClientStatus {
  /** Whether the managed AI-Tidu9 profile is installed. */
  installed: boolean;
  /** Configuration currently selected for newly started Codex sessions. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveCodexHome = (configuredDirectory?: string): string =>
  configuredDirectory ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

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
  lines.push(
    "",
    MANAGED_PROVIDER_START,
    "# Local Agent runtime only. Official Codex credentials are never sent to this endpoint.",
    "[model_providers.ai_tidu9]",
    'name = "AI-Tidu9 (local)"',
    `base_url = ${JSON.stringify(`${endpoint}/v1/hosts/codex`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    MANAGED_PROVIDER_END,
  );
  writePrivateFileAtomically(
    paths.defaultConfiguration,
    `${lines.join("\n").replace(/^\n+|\n+$/gu, "")}\n`,
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
  assertSafeRegularFile(targetPath);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, {
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
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await request(`${endpoint}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
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
): Promise<boolean> => {
  try {
    const capabilityCompletion = await requestJson(request, endpoint, "/api/capability-completion");
    return capabilityCompletion.codexReasoningEffortSupported === true;
  } catch {
    return false;
  }
};

const requestInferenceWithoutDeadline: typeof fetch = async (input, init) => {
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
): Promise<VerifiedEndpoint> => {
  const endpoint = normalizeEndpoint(candidate);
  const health = await requestJson(request, endpoint, "/health");
  if (health.product !== PRODUCT.name || health.status !== "ok") {
    throw createCodexFailure({
      failureSource: "ai-tidu9",
      reasonCode: "tidu_health_check_failed",
      reason: "The configured endpoint is not a healthy AI-Tidu9 service.",
      nextSteps: aiTidu9RecoverySteps,
    });
  }
  const modelList = await requestJson(request, endpoint, "/v1/models");
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
    reasoningEffortSupported: await activeProviderSupportsCodexReasoningEffort(request, endpoint),
  };
};

const verifyInference = async (
  endpoint: string,
  model: string,
  request: typeof fetch,
): Promise<void> => {
  let response: Response;
  try {
    response = await request(`${endpoint}/v1/hosts/codex/responses`, {
      method: "POST",
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
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n");

const createCodexModelCatalog = (model: string, reasoningEffortSupported: boolean): string =>
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
                { effort: "low", description: "Fast responses with lighter reasoning" },
                {
                  effort: "medium",
                  description: "Balances speed and reasoning depth for everyday tasks",
                },
                { effort: "high", description: "Greater reasoning depth for complex problems" },
                {
                  effort: "xhigh",
                  description: "Extra high reasoning depth for complex problems",
                },
                { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
                {
                  effort: "ultra",
                  description: "Maximum reasoning with automatic task delegation",
                },
              ]
            : [],
          shell_type: "unified_exec",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          additional_speed_tiers: [],
          service_tiers: [],
          upgrade: null,
          base_instructions: "You are Codex, an AI coding agent.",
          model_messages: {
            instructions_template: "You are Codex, an AI coding agent.",
            instructions_variables: {
              personality_default: "",
              personality_friendly: "",
              personality_pragmatic: "",
            },
            approvals: null,
            auto_review: null,
            permissions: null,
          },
          include_skills_usage_instructions: true,
          default_reasoning_summary: "auto",
          support_verbosity: true,
          default_verbosity: "low",
          apply_patch_tool_type: "freeform",
          truncation_policy: { mode: "tokens", limit: 10_000 },
          input_modalities: ["text", "image"],
          supports_parallel_tool_calls: true,
          supports_image_detail_original: true,
          supports_search_tool: true,
          web_search_tool_type: "text_and_image",
          context_window: 128_000,
          max_context_window: 128_000,
          comp_hash: "ai-tidu9-1",
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          use_responses_lite: false,
          tool_mode: null,
          multi_agent_version: null,
        },
      ],
    },
    null,
    2,
  )}\n`;

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
    typeof state.backupId !== "string" ||
    (state.originalBackupId !== undefined && typeof state.originalBackupId !== "string") ||
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

const writeManagedState = (path: string, state: CodexProfileState): void => {
  writePrivateFileAtomically(path, `${JSON.stringify(state, null, 2)}\n`);
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
  if (manifest.modelCatalogExisted) {
    const snapshotCatalog = join(snapshotDirectory, SNAPSHOT_MODEL_CATALOG_FILE);
    assertSafeRegularFile(snapshotCatalog);
    writePrivateFileAtomically(paths.modelCatalog, readFileSync(snapshotCatalog, "utf8"));
  } else {
    assertSafeRegularFile(paths.modelCatalog);
    rmSync(paths.modelCatalog, { force: true });
  }
  if (manifest.defaultConfigurationExisted) {
    const snapshotConfiguration = join(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE);
    assertSafeRegularFile(snapshotConfiguration);
    writePrivateFileAtomically(
      paths.defaultConfiguration,
      readFileSync(snapshotConfiguration, "utf8"),
    );
  } else {
    assertSafeRegularFile(paths.defaultConfiguration);
    rmSync(paths.defaultConfiguration, { force: true });
  }
  if (removeSnapshot) {
    rmSync(snapshotDirectory, { force: true, recursive: true });
  }
};

const restoreDefaultConfigurationValues = (paths: CodexPaths, backupId: string): void => {
  const snapshotDirectory = join(paths.backups, backupId);
  const manifest = readSnapshotManifest(snapshotDirectory);
  const original = manifest.defaultConfigurationExisted
    ? readFileSync(join(snapshotDirectory, SNAPSHOT_DEFAULT_CONFIGURATION_FILE), "utf8")
    : "";
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
  const originalManagedLines = originalLines.slice(0, originalTopLevelEnd).filter((line) => {
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
  if (restored === "" && !manifest.defaultConfigurationExisted) {
    rmSync(paths.defaultConfiguration, { force: true });
    return;
  }
  writePrivateFileAtomically(paths.defaultConfiguration, `${restored}\n`);
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
    const snapshotDirectory = join(paths.backups, backupId);
    try {
      readSnapshotManifest(snapshotDirectory);
    } catch {
      continue;
    }
    rmSync(snapshotDirectory, { force: true, recursive: true });
  }
};

export const configureCodexClient = async (
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
      : await verifyEndpoint(options.endpoint, request);
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  let existingState = readManagedState(paths.state);
  switchCodexDesktopProxy(false, paths.home);
  if (existingState !== undefined && hasManagedDefaultConfiguration(paths)) {
    restoreDefaultConfigurationValues(paths, existingState.originalBackupId);
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
  );
  const expectedProfile = createCodexProfile(verified.endpoint, verified.model, paths.modelCatalog);
  if (
    existingState?.endpoint === verified.endpoint &&
    existingState.model === verified.model &&
    existsSync(paths.profile) &&
    existsSync(paths.modelCatalog) &&
    readFileSync(paths.profile, "utf8") === expectedProfile &&
    readFileSync(paths.modelCatalog, "utf8") === expectedCatalog
  ) {
    writeManagedState(paths.state, {
      ...existingState,
      activeMode: "official",
      configuredAt: new Date().toISOString(),
    });
    pruneManagedSnapshots(paths, [existingState.originalBackupId, existingState.backupId]);
    prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
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
    restoreDefaultConfigurationValues(paths, existingState.originalBackupId);
  }
  const backupId = createSnapshot(paths);
  try {
    writePrivateFileAtomically(paths.modelCatalog, expectedCatalog);
    writePrivateFileAtomically(paths.profile, expectedProfile);
    const state: CodexProfileState = {
      schemaVersion: 1,
      owner: "AI-Tidu9",
      profile: CODEX_PROFILE_NAME,
      endpoint: verified.endpoint,
      model: verified.model,
      backupId,
      originalBackupId: existingState?.originalBackupId ?? backupId,
      configuredAt: new Date().toISOString(),
      activeMode: "official",
    };
    writeManagedState(paths.state, state);
    if (options.verifyRuntime !== false) {
      const postWriteVerification = await verifyEndpoint(verified.endpoint, request);
      if (postWriteVerification.model !== verified.model) {
        throw new TiduError(
          "CONFIGURATION_CONFLICT",
          "The active virtual model changed during client configuration.",
        );
      }
    }
    pruneManagedSnapshots(paths, [state.originalBackupId, state.backupId]);
    prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
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
    activeMode: "official",
  };
};

export const inspectCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientStatus => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  const state = readManagedState(paths.state);
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
): Promise<CodexClientStatus> => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  const state = readManagedState(paths.state);
  if (state === undefined || !existsSync(paths.profile) || !hasManagedDefaultConfiguration(paths)) {
    return inspectCodexClientConfiguration(options);
  }
  const verified = await verifyEndpoint(state.endpoint, options.request ?? fetch);
  if (verified.model !== state.model) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "The active virtual model changed after the Codex client was configured.",
    );
  }
  writePrivateFileAtomically(
    paths.modelCatalog,
    createCodexModelCatalog(state.model, verified.reasoningEffortSupported),
  );
  return inspectCodexClientConfiguration(options);
};

export const switchCodexClientConfiguration = async (
  options: CodexClientModeOptions,
): Promise<CodexClientStatus> => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
  const state = readManagedState(paths.state);
  if (state === undefined || !existsSync(paths.profile) || !existsSync(paths.modelCatalog)) {
    if (options.mode === "official") {
      return {
        installed: false,
        activeMode: "official",
        endpoint: null,
        model: null,
      };
    }
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Install the AI-Tidu9 Codex profile before switching to it.",
    );
  }
  const managedDefaultActive = hasManagedDefaultConfiguration(paths);
  const activeMode = managedDefaultActive ? "ai-tidu9" : "official";
  if (activeMode === options.mode && options.mode === "official") {
    switchCodexDesktopProxy(false, paths.home);
    return inspectCodexClientConfiguration(options);
  }
  if (options.mode === "ai-tidu9") {
    const request = options.request ?? fetch;
    try {
      prepareDesktopRecovery(paths.home, options.codexHomeDirectory);
      await verifyEndpoint(state.endpoint, request);
      activateDefaultCodexConfiguration(paths, state.endpoint, state.model);
      await verifyInference(
        state.endpoint,
        state.model,
        options.request ?? requestInferenceWithoutDeadline,
      );
      const verified = await verifyEndpoint(state.endpoint, request);
      writePrivateFileAtomically(
        paths.modelCatalog,
        createCodexModelCatalog(state.model, verified.reasoningEffortSupported),
      );
      switchCodexDesktopProxy(true, paths.home);
    } catch (error) {
      restoreDefaultConfigurationValues(paths, state.originalBackupId);
      writeManagedState(paths.state, {
        ...state,
        activeMode: "official",
        configuredAt: new Date().toISOString(),
      });
      throw error;
    }
  } else {
    restoreDefaultConfigurationValues(paths, state.originalBackupId);
    switchCodexDesktopProxy(false, paths.home);
  }
  writeManagedState(paths.state, {
    ...state,
    activeMode: options.mode,
    configuredAt: new Date().toISOString(),
  });
  return inspectCodexClientConfiguration(options);
};

export const rollbackCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientRollbackResult => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
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
  switchCodexDesktopProxy(
    inspectCodexClientConfiguration(options).activeMode === "ai-tidu9",
    paths.home,
  );
  return {
    status: "restored",
    client: "codex",
    profile: CODEX_PROFILE_NAME,
    backupId,
  };
};

export const removeCodexClientConfiguration = (
  options: CodexClientRollbackOptions = {},
): CodexClientRemovalResult => {
  const paths = resolveCodexPaths(options.codexHomeDirectory);
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
  if (
    managedState?.activeMode === "ai-tidu9" &&
    !existsSync(join(paths.backups, managedState.originalBackupId))
  ) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "The original Codex configuration snapshot is missing; restore the official configuration before uninstalling.",
    );
  }

  let removedArtifactCount = 0;
  if (removeCodexDesktopProxy(paths.home)) removedArtifactCount += 1;
  if (profileExists) {
    rmSync(paths.profile);
    rmSync(paths.state);
    removedArtifactCount += 2;
  }
  if (modelCatalogExists) {
    rmSync(paths.modelCatalog);
    removedArtifactCount += 1;
  }
  if (existsSync(paths.backups)) {
    const backupStatus = lstatSync(paths.backups);
    if (!backupStatus.isDirectory() || backupStatus.isSymbolicLink()) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "AI-Tidu9 Codex backups must be a real directory before removal.",
      );
    }
    if (managedState !== undefined) {
      restoreDefaultConfigurationValues(paths, managedState.originalBackupId);
    }
    rmSync(paths.backups, { recursive: true });
    removedArtifactCount += 1;
  }
  return {
    status: removedArtifactCount === 0 ? "missing" : "removed",
    client: "codex",
    removedArtifactCount,
  };
};

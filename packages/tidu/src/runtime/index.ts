import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { inspectCodexHostLogin, inspectCodexHostLoginAsync } from "../accounts/codex-host.js";
import {
  inspectCursorHostLogin,
  inspectCursorHostLoginAsync,
  reloginCursorHost,
} from "../accounts/cursor-host.js";
import {
  AgentExecutionError,
  type AgentKernel,
  type AgentReasoningEffort,
  type CreateAgentTaskInput,
  createAgentKernel,
  createTaskControlView,
} from "../agent/index.js";
import { createModelProviderAgentAdapters } from "../agent/model-provider.js";
import {
  configureCodexClient,
  inspectCodexClientConfiguration,
  listCodexOfficialModels,
  refreshCodexClientModelCatalog,
  removeCodexClientConfiguration,
  switchCodexClientConfiguration,
} from "../clients/configuration.js";
import {
  type AgentHostId,
  type CapabilitySpecialistConfiguration,
  CONFIG_SCHEMA_VERSION,
  type ConfigurationMode,
  type TiduConfiguration,
} from "../config/index.js";
import { createConfigCenterBootstrap } from "../config-center/index.js";
import { setupConnectors } from "../connectors/setup.js";
import { PRODUCT, TiduError } from "../core/index.js";
import type { CapabilityProviderImplementation, CapabilityRuntime } from "../ecosystem/index.js";
import type { EnterpriseControlPlane } from "../enterprise/index.js";
import { createEnterpriseRuntimeFromEnvironment } from "../enterprise/runtime.js";
import { acquireRuntimeDataLock } from "../lifecycle/index.js";
import {
  createOpenAiError,
  createOpenAiModel,
  type OpenAiErrorBody,
  type OpenAiRequestValidation,
  validateChatCompletionRequest,
  validateResponsesRequest,
} from "../openai/index.js";
import { activateConfigurationSafely, previewConfigurationImpact } from "../personal/index.js";
import {
  createCodexHostModelProvider,
  createCursorHostModelProvider,
  inspectCodexHostAccountReport,
  inspectCodexHostConfiguration,
} from "../providers/codex-host.js";
import {
  createCatalogModelRouter,
  createOllamaProvider,
  createProviderFromEnvironment,
  discoverOllamaModels,
  type ModelProvider,
  type ProviderExecutionReceipt,
  type ProviderExecutionResult,
} from "../providers/index.js";
import {
  type CapabilityCompletionProvider,
  type CapabilityCompletionUsageRecord,
  createCapabilityCompletionProvider,
  inferModelRequestCapabilities,
} from "../routing/index.js";
import type { ScalingControlPlane, ScalingTaskRequest } from "../scaling/index.js";
import { createSecretGate, guardModelProvider, type SecretGate } from "../security/index.js";
import {
  type EnterpriseConnectionSnapshot,
  openNodeSqliteStorage,
  resolveDefaultDatabasePath,
  type StorageAdapter,
} from "../storage/index.js";

export const DEFAULT_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_RUNTIME_PORT = 9639;

const CONFIG_CENTER_DIRECTORY = fileURLToPath(new URL("../ui/", import.meta.url));
const STATIC_CONTENT_TYPES = Object.freeze<Record<string, string>>({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
});
const SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

interface RuntimeReadCacheEntry {
  /** Cached response value after a successful load. */
  value?: unknown;
  /** Time after which the cached response must be refreshed. */
  expiresAt: number;
  /** Shared in-flight read used to coalesce concurrent requests. */
  pending?: Promise<unknown>;
}

const runtimeReadCaches = new WeakMap<object, Map<string, RuntimeReadCacheEntry>>();

const readCachedRuntimeValue = async <T>(
  runtime: object,
  key: string,
  ttlMilliseconds: number,
  load: () => Promise<T>,
): Promise<T> => {
  const cache = runtimeReadCaches.get(runtime) ?? new Map<string, RuntimeReadCacheEntry>();
  runtimeReadCaches.set(runtime, cache);
  const current = cache.get(key);
  if (current?.value !== undefined && current.expiresAt > Date.now()) {
    return current.value as T;
  }
  if (current?.pending !== undefined) return current.pending as Promise<T>;
  const pending = load()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMilliseconds });
      return value;
    })
    .catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { expiresAt: 0, pending });
  return pending;
};
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_INFERENCE_JSON_BODY_BYTES = 4 * 1024 * 1024;
const ENTERPRISE_DISCOVERY_TIMEOUT_MS = 5_000;

const runtimeProcessKind = (): "development" | "installed" =>
  process.env.NODE_ENV === "development" ? "development" : "installed";

interface RuntimeLogger {
  /** User-visible destination for this runtime's logs. */
  location: string;
  /** Writes one timestamped service event without request bodies or secrets. */
  write: (message: string) => void;
  /** Flushes and closes an installed-runtime log stream. */
  close: () => Promise<void>;
}

const createRuntimeLogger = (storageLocation: string): RuntimeLogger => {
  if (runtimeProcessKind() === "development") {
    return {
      location: "当前启动终端",
      write: (message) =>
        process.stdout.write(`[AI-TIDU9] 接口服务 · ${new Date().toISOString()} · ${message}\n`),
      close: async () => undefined,
    };
  }

  const configuredLogPath = process.env.TIDU_LOG_PATH?.trim();
  const logPath = resolve(
    configuredLogPath && configuredLogPath !== ""
      ? configuredLogPath
      : join(dirname(storageLocation), "logs", "runtime.log"),
  );
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    return {
      location: logPath,
      write: () => undefined,
      close: async () => undefined,
    };
  }

  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  let logStreamFailed = false;
  logStream.on("error", (error) => {
    logStreamFailed = true;
    process.stderr.write(`[AI-TIDU9] 接口服务日志写入失败 · ${error.message}\n`);
  });
  return {
    location: logPath,
    write: (message) => {
      if (!logStreamFailed) {
        logStream.write(`${new Date().toISOString()} [接口服务] ${message}\n`);
      }
    },
    close: () =>
      new Promise((resolveClose) => {
        if (logStreamFailed || logStream.destroyed) {
          resolveClose();
          return;
        }
        logStream.end(resolveClose);
      }),
  };
};

interface ServiceDiagnostic {
  /** Stable diagnostic identifier. */
  id: "network" | "process" | "provider" | "storage";
  /** Human-readable diagnostic detail. */
  message: string;
  /** Latest diagnostic outcome. */
  status: "passed" | "warning";
}

interface ServiceInventory {
  /** Time at which this service snapshot was generated. */
  checkedAt: string;
  /** Core non-secret runtime environment information. */
  environment: {
    /** Active virtual-model upstream identifier. */
    activeModel: string;
    /** HTTP endpoint currently serving this runtime. */
    endpoint: string;
    /** Node.js runtime version. */
    nodeVersion: string;
    /** Operating-system platform identifier. */
    platform: NodeJS.Platform;
    /** Active model-provider adapter. */
    providerType: string;
    /** Storage adapter and schema version. */
    storage: string;
    /** Runtime uptime measured in whole seconds. */
    uptimeSeconds: number;
    /** AI-Tidu9 product version. */
    version: string;
  };
  /** Mutually exclusive runtime shape active on this page. */
  mode: "development" | "installed";
  /** Latest checks used to determine overall service health. */
  diagnostics: readonly ServiceDiagnostic[];
  /** Runtime and CLI entries belonging to the active mode. */
  services: readonly {
    /** Actions currently accepted for this service. */
    actions: readonly ("refresh" | "restart" | "start" | "stop")[];
    /** Command used to enter or manage this service. */
    command: string;
    /** Runtime configuration or persistent configuration-storage path. */
    configurationPath: string;
    /** HTTP runtime endpoint used by this service. */
    endpoint: string;
    /** Stable service identifier. */
    id: string;
    /** Service role. */
    kind: "api" | "cli" | "frontend";
    /** Whether the service is persistent or invoked on demand. */
    lifecycle: "managed" | "on-demand";
    /** Current terminal or absolute file receiving this service's logs. */
    logLocation: string;
    /** User-facing service name. */
    name: string;
    /** Active process identifier, or null for command entries. */
    processId: number | null;
    /** Active reverse-proxy configuration path, or null when no proxy is configured. */
    proxyConfigurationPath: string | null;
    /** Current service state. */
    status: "ready" | "running" | "stopped";
    /** Service package version. */
    version: string;
  }[];
}

const createServiceInventory = async (
  storage: StorageAdapter,
  provider: ModelProvider | undefined,
  runtimeNetwork: { host: string; port: number },
  deployment: "personal" | "enterprise",
  runtimePaths: {
    /** Runtime configuration or persistent configuration-storage path. */
    configurationPath: string;
    /** Current terminal or absolute file receiving runtime logs. */
    logLocation: string;
    /** Active reverse-proxy configuration path, or null when no proxy is configured. */
    proxyConfigurationPath: string | null;
  },
): Promise<ServiceInventory> => {
  const development = runtimeProcessKind() === "development";
  const workspace = await storage.configurationStore.loadWorkspace();
  const modelSelection = workspace.active.configuration.modelSelection;
  const endpointHost = runtimeNetwork.host.includes(":")
    ? `[${runtimeNetwork.host}]`
    : runtimeNetwork.host;
  const endpoint = `http://${endpointHost}:${runtimeNetwork.port}`;
  const editionSuffix = deployment === "enterprise" ? "e" : "p";
  const serviceId = development ? `tidu:dev-api-${editionSuffix}` : `tidu:runtime-${editionSuffix}`;
  return {
    checkedAt: new Date().toISOString(),
    environment: {
      activeModel: `${modelSelection.source}:${modelSelection.model}`,
      endpoint,
      nodeVersion: process.version,
      platform: process.platform,
      providerType: provider?.descriptor.type ?? "not-configured",
      storage: `${storage.provider} · schema ${storage.schemaVersion}`,
      uptimeSeconds: Math.floor(process.uptime()),
      version: PRODUCT.version,
    },
    mode: development ? ("development" as const) : ("installed" as const),
    diagnostics: [
      {
        id: "process",
        status: "passed",
        message: `PID ${process.pid} · uptime ${Math.floor(process.uptime())}s`,
      },
      { id: "network", status: "passed", message: endpoint },
      {
        id: "storage",
        status: "passed",
        message: `${storage.provider} · schema ${storage.schemaVersion}`,
      },
      {
        id: "provider",
        status: provider === undefined ? "warning" : "passed",
        message:
          provider === undefined
            ? "Model provider is not configured"
            : `${provider.descriptor.type} · ${provider.descriptor.model}`,
      },
    ],
    services: [
      {
        actions: ["refresh", "restart", "stop"],
        command: development
          ? `npm run tidu:dev-api-${editionSuffix}`
          : `tidu service start ${serviceId}`,
        configurationPath: runtimePaths.configurationPath,
        endpoint,
        id: serviceId,
        kind: "api" as const,
        lifecycle: "managed" as const,
        logLocation: runtimePaths.logLocation,
        name: development ? "接口服务" : "九门运行时",
        processId: process.pid,
        proxyConfigurationPath: runtimePaths.proxyConfigurationPath,
        status: "running" as const,
        version: PRODUCT.version,
      },
    ],
  };
};

const scheduleInstalledRuntimeRestart = (): void => {
  const runtimeArguments = process.argv.slice(1);
  const helperSource = [
    'const { spawn } = require("node:child_process");',
    "const args = JSON.parse(process.argv[1]);",
    "setTimeout(() => {",
    "  const child = spawn(process.execPath, args, { detached: true, env: process.env, stdio: 'ignore' });",
    "  child.unref();",
    "}, 500);",
  ].join("\n");
  const helper = spawn(process.execPath, ["-e", helperSource, JSON.stringify(runtimeArguments)], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  helper.unref();
};

export interface LocalRuntimeOptions {
  /** Installation edition; personal runtimes attached to enterprise state are read-only. */
  deployment?: "personal" | "enterprise";
  /** Loopback host used by the personal runtime. */
  host?: string;
  /** TCP port used by the personal runtime; use zero to allocate a test port. */
  port?: number;
  /** SQLite file path; omit it to use the platform default. */
  databasePath?: string;
  /** Explicit provider adapter; omit it to resolve runtime environment configuration. */
  provider?: ModelProvider;
  /** Whether personal runtimes may reuse a detected host provider; defaults to true. */
  discoverHostProvider?: boolean;
  /** Optional autonomous Agent kernel exposed through the local task-control API. */
  agentKernel?: AgentKernel;
  /** Runtime Secret Gate; defaults to automatic detection and isolated placeholder storage. */
  secretGate?: SecretGate;
  /** Optional enterprise control plane for centralized policy, quota, and administration. */
  enterpriseControlPlane?: EnterpriseControlPlane;
  /** Optional production scheduler used by the stateless gateway endpoints. */
  scalingControlPlane?: ScalingControlPlane;
  /** Capability providers exposed through the versioned ecosystem API. */
  capabilityProviders?: readonly CapabilityProviderImplementation[];
  /** Permission and isolation runtime required to invoke capability providers. */
  capabilityRuntime?: CapabilityRuntime;
  /** Optional active-Codex catalog refresher for embedded runtimes and isolated tests. */
  codexClientModelCatalogRefresh?: () => Promise<void>;
}

export interface LocalRuntime {
  /** Resolved HTTP origin of the running local service. */
  origin: string;
  /** SQLite file path used by this runtime. */
  databasePath: string;
  /** Stops accepting requests and releases the listening socket. */
  close: () => Promise<void>;
}

const listen = (server: Server, host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });

const sendJson = (
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
  additionalHeaders: import("node:http").OutgoingHttpHeaders = {},
): void => {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...additionalHeaders,
  });
  response.end(JSON.stringify(body));
};

const resolveStaticFile = (pathname: string): string | undefined => {
  if (pathname === "/") {
    return join(CONFIG_CENTER_DIRECTORY, "index.html");
  }
  if (/^\/assets\/[a-zA-Z0-9._-]+$/u.test(pathname)) {
    return join(CONFIG_CENTER_DIRECTORY, pathname.slice(1));
  }
  return undefined;
};

const readJsonBody = async (
  request: import("node:http").IncomingMessage,
  maximumBytes = MAXIMUM_JSON_BODY_BYTES,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maximumBytes) {
      throw new TiduError("CONFIGURATION_INVALID", `Request body exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "Request body must be valid JSON.", {
      cause: error,
    });
  }
};

const sendOpenAiJson = (
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void => {
  sendJson(response, statusCode, body, {
    "x-ai-tidu9": "true",
    "x-request-id": requestId,
  });
};

const sendOpenAiStream = async (
  response: import("node:http").ServerResponse,
  statusCode: number,
  stream: ReadableStream<Uint8Array>,
  requestId: string,
): Promise<void> => {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-ai-tidu9": "true",
    "x-request-id": requestId,
  });
  await pipeline(
    Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    response,
  );
};

const readOpenAiRequest = async (
  request: import("node:http").IncomingMessage,
): Promise<unknown> => {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new TiduError("CONFIGURATION_INVALID", "Content-Type must be application/json.");
  }
  return readJsonBody(request, MAXIMUM_INFERENCE_JSON_BODY_BYTES);
};

const sendOpenAiValidation = (
  response: import("node:http").ServerResponse,
  validation: OpenAiRequestValidation,
  requestId: string,
): boolean => {
  if (validation.valid) {
    return false;
  }
  const error =
    validation.error ??
    createOpenAiError("invalid_request", "Request is invalid.", "invalid_request_error");
  const statusCode = error.error.code === "model_not_found" ? 404 : 400;
  sendOpenAiJson(response, statusCode, error, requestId);
  return true;
};

const providerFailureSource = (provider: ModelProvider): "ai-tidu9" | "official-codex" =>
  provider.descriptor.type === "codex-host" ? "official-codex" : "ai-tidu9";

const resolveRuntimeProviderType = (provider: ModelProvider | undefined): string | undefined => {
  if (provider?.descriptor.type !== "tidu-router") return provider?.descriptor.type;
  const configuredProvider = process.env.TIDU_PROVIDER?.trim();
  return configuredProvider === "ollama" || configuredProvider === "openai-compatible"
    ? configuredProvider
    : provider.descriptor.type;
};

const providerRecoverySteps = (failureSource: "ai-tidu9" | "official-codex"): readonly string[] =>
  failureSource === "official-codex"
    ? [
        "Run 'codex login status' and sign in again if the official session is unavailable.",
        "Switch to an official model and verify that official Codex inference succeeds.",
        "Retry AI-Tidu9 after official Codex access is restored.",
      ]
    : [
        "Check the AI-Tidu9 /health endpoint and confirm the configured local or remote service is reachable.",
        "Check the AI-Tidu9 provider configuration and upstream model compatibility.",
        "Update the AI-Tidu9 Codex configuration, retry, or switch to Official mode.",
      ];

const createProviderFailure = (
  provider: ModelProvider,
  reason: string,
  code = "provider_request_failed",
): OpenAiErrorBody => {
  const failureSource = providerFailureSource(provider);
  const sourceLabel = failureSource === "official-codex" ? "Official Codex" : "AI-Tidu9";
  const nextSteps = providerRecoverySteps(failureSource);
  return createOpenAiError(
    code,
    `Failure source: ${sourceLabel}. Reason: ${reason} Next steps: ${nextSteps.join(" ")}`,
    "server_error",
    null,
    { failure_source: failureSource, next_steps: nextSteps, reason },
  );
};

const providerResponseFailureReason = (body: unknown, statusCode: number): string => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message.slice(0, 240);
  }
  return `The configured upstream returned HTTP ${statusCode}.`;
};

const collectAgentInputText = (value: unknown, output: string[]): void => {
  if (typeof value === "string") {
    if (value.trim() !== "") output.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAgentInputText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["text", "content", "input", "output_text"]) {
    if (key in value) collectAgentInputText(value[key], output);
  }
};

const createAgentObjective = (body: Record<string, unknown>): string => {
  const inputParts: string[] = [];
  collectAgentInputText(body.input, inputParts);
  collectAgentInputText(body.messages, inputParts);
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  const objective = [instructions, ...inputParts].filter((part) => part !== "").join("\n\n");
  return objective.slice(0, MAXIMUM_INFERENCE_JSON_BODY_BYTES);
};

type AgentTokenUsage = NonNullable<ProviderExecutionReceipt["usage"]>;

const createAgentUsageCollector = (): {
  /** Records the most authoritative usage for one concrete host/model/role execution. */
  record: (receipt: ProviderExecutionReceipt) => void;
  /** Returns combined provider-reported usage for the active user turn. */
  read: () => AgentTokenUsage | null;
} => {
  const usageByExecution = new Map<string, AgentTokenUsage>();
  return {
    record: (receipt) => {
      if (receipt.usage === null) return;
      const executionKey = JSON.stringify([
        receipt.host,
        receipt.model,
        receipt.role,
        [...receipt.capabilities].sort(),
      ]);
      usageByExecution.set(executionKey, receipt.usage);
    },
    read: () => {
      if (usageByExecution.size === 0) return null;
      return [...usageByExecution.values()].reduce<AgentTokenUsage>(
        (total, usage) => ({
          inputTokens: total.inputTokens + usage.inputTokens,
          outputTokens: total.outputTokens + usage.outputTokens,
          totalTokens: total.totalTokens + usage.totalTokens,
          cachedInputTokens: (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
          cacheWriteInputTokens:
            (total.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
          reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        }),
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
        },
      );
    },
  };
};

const createAgentResponsesBody = (
  model: string,
  text: string,
  responseId = `resp_${randomUUID()}`,
  outputItems?: readonly Record<string, unknown>[],
  createdAt = Math.floor(Date.now() / 1_000),
  usage?: AgentTokenUsage | null,
): Record<string, unknown> => ({
  id: responseId,
  object: "response",
  created_at: createdAt,
  status: "completed",
  completed_at: Math.floor(Date.now() / 1_000),
  error: null,
  incomplete_details: null,
  model,
  output: outputItems ?? [
    {
      id: `${responseId}_message`,
      type: "message",
      status: "completed",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ],
  ...(usage == null
    ? {}
    : {
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: {
            cached_tokens: usage.cachedInputTokens ?? 0,
            cache_write_tokens: usage.cacheWriteInputTokens ?? 0,
          },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
          total_tokens: usage.totalTokens,
        },
      }),
});

const createAgentChatBody = (
  model: string,
  text: string,
  responseId = `chatcmpl_${randomUUID()}`,
  usage?: AgentTokenUsage | null,
): Record<string, unknown> => ({
  id: responseId,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1_000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
  ...(usage == null
    ? {}
    : {
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
      }),
});

const resolveAgentFailure = (error: unknown): { code: string; message: string } => ({
  code: error instanceof AgentExecutionError ? error.code : "agent_task_failed",
  message: (error instanceof Error ? error.message : "The Agent task failed.").slice(0, 240),
});

const createAgentResponsesStream = (
  model: string,
  run: (
    signal: AbortSignal,
    onProcessDelta: (delta: string) => void,
    onOutputDelta: (delta: string) => void,
  ) => Promise<string>,
  chineseRequest: boolean,
  preserveProcessLifecycle: boolean,
  readUsage: () => AgentTokenUsage | null,
): ReadableStream<Uint8Array> => {
  const responseId = `resp_${randomUUID()}`;
  const messageId = `${responseId}_message`;
  const createdAt = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let closed = false;
  let keepAlive: NodeJS.Timeout | undefined;
  const abortController = new AbortController();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let sequenceNumber = 0;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (keepAlive !== undefined) clearInterval(keepAlive);
        controller.close();
      };
      const write = (type: string, payload: Record<string, unknown>): void => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(
            `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`,
          ),
        );
        sequenceNumber += 1;
      };
      write("response.created", {
        response: {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          completed_at: null,
          error: null,
          incomplete_details: null,
          model,
          output: [],
        },
      });
      write("response.in_progress", {
        response: {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          completed_at: null,
          error: null,
          incomplete_details: null,
          model,
          output: [],
        },
      });
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ai-tidu9 keep-alive\n\n"));
      }, 10_000);
      keepAlive.unref();
      const completedOutputItems = new Map<number, Record<string, unknown>>();
      let activeProcess: { id: string; outputIndex: number; text: string } | undefined;
      let nextOutputIndex = 0;
      let processCount = 0;
      let messageStarted = false;
      let messageOutputIndex = 0;
      let outputText = "";
      const startProcessLifecycle = (): void => {
        if (activeProcess !== undefined) return;
        const stepIndex = processCount;
        const processItemId =
          stepIndex === 0
            ? `${responseId}_commentary`
            : `${responseId}_commentary_${String(stepIndex + 1)}`;
        processCount += 1;
        activeProcess = {
          id: processItemId,
          outputIndex: nextOutputIndex,
          text: "",
        };
        nextOutputIndex += 1;
        write("response.output_item.added", {
          output_index: activeProcess.outputIndex,
          item: {
            id: processItemId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            phase: "commentary",
            content: [],
          },
        });
        write("response.content_part.added", {
          item_id: processItemId,
          output_index: activeProcess.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      };
      const finishProcessLifecycle = (): void => {
        const process = activeProcess;
        if (process === undefined) return;
        activeProcess = undefined;
        if (process.text === "") return;
        write("response.output_text.done", {
          item_id: process.id,
          output_index: process.outputIndex,
          content_index: 0,
          text: process.text,
        });
        write("response.content_part.done", {
          item_id: process.id,
          output_index: process.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: process.text, annotations: [] },
        });
        const completedItem = {
          id: process.id,
          type: "message",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: process.text, annotations: [] }],
        };
        completedOutputItems.set(process.outputIndex, completedItem);
        write("response.output_item.done", {
          output_index: process.outputIndex,
          item: completedItem,
        });
      };
      const startMessage = (): void => {
        if (messageStarted) return;
        finishProcessLifecycle();
        messageStarted = true;
        messageOutputIndex = nextOutputIndex;
        nextOutputIndex += 1;
        write("response.output_item.added", {
          output_index: messageOutputIndex,
          item: {
            id: messageId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            phase: "final_answer",
            content: [],
          },
        });
        write("response.content_part.added", {
          item_id: messageId,
          output_index: messageOutputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      };
      const emitProcessDelta = (delta: string): void => {
        if (closed || delta === "") return;
        for (const chunk of delta.split(/((?:\r?\n){2,})/u)) {
          if (chunk === "") continue;
          if (/^(?:\r?\n){2,}$/u.test(chunk)) {
            finishProcessLifecycle();
            continue;
          }
          startProcessLifecycle();
          if (activeProcess === undefined) continue;
          activeProcess.text += chunk;
          write("response.output_text.delta", {
            item_id: activeProcess.id,
            output_index: activeProcess.outputIndex,
            content_index: 0,
            delta: chunk,
          });
        }
      };
      const emitOutputDelta = (delta: string): void => {
        if (closed || delta === "") return;
        startMessage();
        outputText += delta;
        write("response.output_text.delta", {
          item_id: messageId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta,
        });
      };
      if (preserveProcessLifecycle) {
        emitProcessDelta(chineseRequest ? "正在处理请求…" : "Working on the request…");
        finishProcessLifecycle();
      }
      void run(abortController.signal, emitProcessDelta, emitOutputDelta)
        .then((text) => {
          if (outputText === "") {
            emitOutputDelta(text);
          } else if (text.startsWith(outputText) && text.length > outputText.length) {
            emitOutputDelta(text.slice(outputText.length));
          }
          finishProcessLifecycle();
          startMessage();
          write("response.output_text.done", {
            item_id: messageId,
            output_index: messageOutputIndex,
            content_index: 0,
            text: outputText,
          });
          write("response.content_part.done", {
            item_id: messageId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: { type: "output_text", text: outputText, annotations: [] },
          });
          const completedMessage = {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: outputText, annotations: [] }],
          };
          completedOutputItems.set(messageOutputIndex, completedMessage);
          write("response.output_item.done", {
            output_index: messageOutputIndex,
            item: completedMessage,
          });
          write("response.completed", {
            response: createAgentResponsesBody(
              model,
              outputText,
              responseId,
              [...completedOutputItems.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
              createdAt,
              readUsage(),
            ),
          });
          if (!closed) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          close();
        })
        .catch((error: unknown) => {
          const failure = resolveAgentFailure(error);
          const failureUsage = readUsage();
          finishProcessLifecycle();
          const failureText = `${chineseRequest ? "请求失败" : "Request failed"}: ${failure.message}`;
          emitOutputDelta(`${outputText === "" ? "" : "\n\n"}${failureText}`);
          if (messageStarted) {
            write("response.output_text.done", {
              item_id: messageId,
              output_index: messageOutputIndex,
              content_index: 0,
              text: outputText,
            });
            write("response.content_part.done", {
              item_id: messageId,
              output_index: messageOutputIndex,
              content_index: 0,
              part: { type: "output_text", text: outputText, annotations: [] },
            });
            const incompleteMessage = {
              id: messageId,
              type: "message",
              status: "incomplete",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: outputText, annotations: [] }],
            };
            completedOutputItems.set(messageOutputIndex, incompleteMessage);
            write("response.output_item.done", {
              output_index: messageOutputIndex,
              item: incompleteMessage,
            });
          }
          write("response.failed", {
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              status: "failed",
              completed_at: null,
              incomplete_details: null,
              model,
              output: [...completedOutputItems.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => item),
              error: failure,
              ...(failureUsage === null
                ? {}
                : {
                    usage: {
                      input_tokens: failureUsage.inputTokens,
                      input_tokens_details: {
                        cached_tokens: failureUsage.cachedInputTokens ?? 0,
                        cache_write_tokens: failureUsage.cacheWriteInputTokens ?? 0,
                      },
                      output_tokens: failureUsage.outputTokens,
                      output_tokens_details: {
                        reasoning_tokens: failureUsage.reasoningTokens ?? 0,
                      },
                      total_tokens: failureUsage.totalTokens,
                    },
                  }),
            },
          });
          if (!closed) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          close();
        });
    },
    cancel() {
      closed = true;
      if (keepAlive !== undefined) clearInterval(keepAlive);
      abortController.abort();
    },
  });
};

const createAgentChatStream = (
  model: string,
  run: (
    signal?: AbortSignal,
    onProcessDelta?: (delta: string) => void,
    onOutputDelta?: (delta: string) => void,
  ) => Promise<string>,
  readUsage: () => AgentTokenUsage | null,
): ReadableStream<Uint8Array> => {
  const responseId = `chatcmpl_${randomUUID()}`;
  const encoder = new TextEncoder();
  let closed = false;
  let keepAlive: NodeJS.Timeout | undefined;
  const abortController = new AbortController();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let firstDelta = true;
      let outputText = "";
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ai-tidu9 keep-alive\n\n"));
      }, 10_000);
      keepAlive.unref();
      const write = (event: string): void => {
        if (!closed) controller.enqueue(encoder.encode(event));
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (keepAlive !== undefined) clearInterval(keepAlive);
        controller.close();
      };
      const emitOutputDelta = (delta: string): void => {
        if (closed || delta === "") return;
        outputText += delta;
        write(
          `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model, choices: [{ index: 0, delta: { ...(firstDelta ? { role: "assistant" } : {}), content: delta }, finish_reason: null }] })}\n\n`,
        );
        firstDelta = false;
      };
      void run(abortController.signal, undefined, emitOutputDelta)
        .then((text) => {
          if (outputText === "") {
            emitOutputDelta(text);
          } else if (text.startsWith(outputText) && text.length > outputText.length) {
            emitOutputDelta(text.slice(outputText.length));
          }
          const usage = readUsage();
          write(
            `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(usage === null ? {} : { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } }) })}\n\n`,
          );
          write("data: [DONE]\n\n");
          close();
        })
        .catch((error: unknown) => {
          const failure = resolveAgentFailure(error);
          const usage = readUsage();
          write(
            `data: ${JSON.stringify({ error: { ...failure, type: "server_error" }, ...(usage === null ? {} : { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } }) })}\n\n`,
          );
          write("data: [DONE]\n\n");
          close();
        });
    },
    cancel() {
      closed = true;
      if (keepAlive !== undefined) clearInterval(keepAlive);
      abortController.abort();
    },
  });
};

const runAgentResponsesTask = async (
  agentKernel: AgentKernel,
  body: Record<string, unknown>,
  protocol: "chat-completions" | "responses",
  originHost: AgentHostId,
  signal?: AbortSignal,
  onProcessDelta?: (delta: string) => void,
  onOutputDelta?: (delta: string) => void,
  onExecutionReceipt?: (receipt: ProviderExecutionReceipt) => void,
): Promise<string> => {
  const objective = createAgentObjective(body);
  if (objective === "") throw new Error("The Agent request does not contain a usable goal.");
  const reasoning = isRecord(body.reasoning) ? body.reasoning.effort : undefined;
  const requestedReasoningEffort = reasoning ?? body.reasoning_effort;
  const allowedReasoningEfforts = new Set<AgentReasoningEffort>([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  const reasoningEffort =
    typeof requestedReasoningEffort === "string" &&
    allowedReasoningEfforts.has(requestedReasoningEffort as AgentReasoningEffort)
      ? (requestedReasoningEffort as AgentReasoningEffort)
      : undefined;
  const model = typeof body.model === "string" ? body.model : "ai-tidu9-config";
  const requiredCapabilities = inferModelRequestCapabilities({
    protocol,
    body,
    virtualModelId: model,
    routing: { host: originHost },
  });
  const created = await agentKernel.createTask({
    goal: {
      objective,
      acceptanceCriteria: ["The response addresses the requested goal."],
    },
    originHost,
    planningMode: "response",
    verificationMode: "response",
    requiredCapabilities,
    ...(reasoningEffort === undefined ? {} : { modelPreferences: { reasoningEffort } }),
    modelRequest: {
      protocol,
      body,
      virtualModelId: model,
      ...(onOutputDelta === undefined ? {} : { onOutputDelta }),
      ...(onProcessDelta === undefined ? {} : { onProcessDelta }),
      ...(onExecutionReceipt === undefined ? {} : { onExecutionReceipt }),
    },
  });
  const cancel = (): void => {
    void agentKernel.cancelTask(created.task.taskId).catch(() => undefined);
  };
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const completed = await agentKernel.runTask(created.task.taskId).finally(() => {
    signal?.removeEventListener("abort", cancel);
  });
  if (completed.task.status !== "completed" || completed.result?.accepted !== true) {
    const failureEvent = [...completed.events]
      .reverse()
      .find((event) => event.type === "task.failed");
    const failureReason =
      failureEvent !== undefined &&
      isRecord(failureEvent.payload) &&
      typeof failureEvent.payload.reason === "string"
        ? failureEvent.payload.reason
        : undefined;
    const failureCode =
      failureEvent !== undefined &&
      isRecord(failureEvent.payload) &&
      typeof failureEvent.payload.errorCode === "string"
        ? failureEvent.payload.errorCode
        : undefined;
    const message = failureReason ?? `The Agent task ended with status ${completed.task.status}.`;
    throw failureCode === undefined
      ? new Error(message)
      : new AgentExecutionError(failureCode, message);
  }
  return completed.result.summary;
};

const resolveInferenceHost = (
  configuration: TiduConfiguration,
  provider: ModelProvider | undefined,
  requestedHost?: AgentHostId,
): AgentHostId => {
  if (requestedHost !== undefined) return requestedHost;
  switch (provider?.descriptor.type) {
    case "codex-host":
      return "codex";
    case "cursor-host":
      return "cursor";
    case "ollama":
      return "ollama";
    case "openai-compatible":
      return "openai-compatible";
  }
  const matchingPolicyHosts = Object.entries(
    configuration.capabilityCompletion.hostPolicies ?? {},
  ).flatMap(([host, policy]): AgentHostId[] =>
    policy !== undefined &&
    policy.mainModel.source === configuration.modelSelection.source &&
    policy.mainModel.model === configuration.modelSelection.model
      ? [host as AgentHostId]
      : [],
  );
  if (matchingPolicyHosts.length === 1 && matchingPolicyHosts[0] !== undefined) {
    return matchingPolicyHosts[0];
  }
  if (
    configuration.modelSelection.source === "official" &&
    configuration.capabilityCompletion.hostPolicies?.codex !== undefined
  ) {
    return "codex";
  }
  return "openai-compatible";
};

const handleOpenAiInference = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  storage: StorageAdapter,
  protocol: "chat-completions" | "responses",
  provider: ModelProvider | undefined,
  agentKernel: AgentKernel | undefined,
  requestedHost?: AgentHostId,
): Promise<void> => {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await readOpenAiRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request body is invalid.";
    sendOpenAiJson(
      response,
      400,
      createOpenAiError("invalid_request_body", message, "invalid_request_error"),
      requestId,
    );
    return;
  }
  const workspace = await storage.configurationStore.loadWorkspace();
  const originHost = resolveInferenceHost(workspace.active.configuration, provider, requestedHost);
  const activeModelId = workspace.active.configuration.activeProfileId;
  const validation =
    protocol === "chat-completions"
      ? validateChatCompletionRequest(body, activeModelId)
      : validateResponsesRequest(body, activeModelId);
  if (sendOpenAiValidation(response, validation, requestId)) {
    return;
  }
  const requestBody = body as Record<string, unknown>;
  const probe = isRecord(requestBody.metadata) && requestBody.metadata.ai_tidu9_probe === true;
  const modelSelection = workspace.active.configuration.modelSelection ?? {
    source: "official" as const,
    model: "current",
  };
  const executeProvider = (
    signal: AbortSignal,
    providerBody: Record<string, unknown> = requestBody,
  ): Promise<ProviderExecutionResult> => {
    if (provider === undefined) {
      throw new Error("No upstream model provider is configured.");
    }
    return provider.execute({
      protocol,
      body: providerBody,
      virtualModelId: activeModelId,
      signal,
      routing: {
        host: originHost,
        modelSource: modelSelection.source,
        ...(modelSelection.model === "current" ? {} : { targetModel: modelSelection.model }),
      },
    });
  };
  if (!probe) {
    if (agentKernel === undefined) {
      sendOpenAiJson(
        response,
        503,
        createOpenAiError(
          "agent_kernel_not_configured",
          "The AI-Tidu9 Agent kernel is not configured.",
          "server_error",
        ),
        requestId,
      );
      return;
    }
    const model = typeof requestBody.model === "string" ? requestBody.model : "ai-tidu9-config";
    const usageCollector = createAgentUsageCollector();
    const run = async (
      signal?: AbortSignal,
      onProcessDelta?: (delta: string) => void,
      onOutputDelta?: (delta: string) => void,
    ): Promise<string> =>
      runAgentResponsesTask(
        agentKernel,
        requestBody,
        protocol,
        originHost,
        signal,
        onProcessDelta,
        onOutputDelta,
        usageCollector.record,
      );
    try {
      if (requestBody.stream === true) {
        const stream =
          protocol === "responses"
            ? createAgentResponsesStream(
                model,
                run,
                /\p{Script=Han}/u.test(createAgentObjective(requestBody)),
                originHost === "codex",
                usageCollector.read,
              )
            : createAgentChatStream(model, run, usageCollector.read);
        await sendOpenAiStream(response, 200, stream, requestId);
      } else {
        const text = await run();
        sendOpenAiJson(
          response,
          200,
          protocol === "responses"
            ? createAgentResponsesBody(
                model,
                text,
                undefined,
                undefined,
                undefined,
                usageCollector.read(),
              )
            : createAgentChatBody(model, text, undefined, usageCollector.read()),
          requestId,
        );
      }
    } catch (error) {
      const failure = resolveAgentFailure(error);
      sendOpenAiJson(
        response,
        502,
        createOpenAiError(failure.code, failure.message, "server_error"),
        requestId,
      );
    }
    return;
  }
  if (provider !== undefined) {
    if (
      (modelSelection.source === "company" || modelSelection.source === "custom") &&
      provider.descriptor.type !== "tidu-router" &&
      provider.descriptor.type !== "openai-compatible" &&
      provider.descriptor.type !== "ollama"
    ) {
      sendOpenAiJson(
        response,
        503,
        createOpenAiError(
          "upstream_provider_not_configured",
          "The selected company or custom model source is not configured.",
          "server_error",
        ),
        requestId,
      );
      return;
    }
    const controller = new AbortController();
    const abortProvider = () => controller.abort();
    request.once("aborted", abortProvider);
    response.once("close", abortProvider);
    try {
      const result = await executeProvider(controller.signal);
      if (result.kind === "stream") {
        await sendOpenAiStream(response, result.statusCode, result.stream, requestId);
      } else if (result.statusCode >= 400) {
        sendOpenAiJson(
          response,
          result.statusCode,
          createProviderFailure(
            provider,
            providerResponseFailureReason(result.body, result.statusCode),
            "upstream_request_failed",
          ),
          requestId,
        );
      } else {
        sendOpenAiJson(response, result.statusCode, result.body, requestId);
      }
    } catch (error) {
      if (!response.headersSent) {
        const providerMessage = error instanceof Error ? error.message.trim() : "";
        const reason = providerMessage.includes("tool_search")
          ? "The active upstream model does not support Codex tool_search definitions. Switch back to the official Codex configuration or select a compatible upstream model."
          : providerMessage === ""
            ? "The configured provider could not complete the request."
            : `The configured provider could not complete the request: ${providerMessage.slice(0, 240)}`;
        sendOpenAiJson(response, 502, createProviderFailure(provider, reason), requestId);
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      request.off("aborted", abortProvider);
      response.off("close", abortProvider);
    }
    return;
  }
  sendOpenAiJson(
    response,
    503,
    createOpenAiError(
      "model_provider_not_configured",
      "Failure source: AI-Tidu9. Reason: no upstream model provider is configured. Next steps: Configure an AI-Tidu9 provider or restore an available host provider. Update the AI-Tidu9 Codex configuration and retry. Switch to Official mode if AI-Tidu9 is not required.",
      "server_error",
      null,
      {
        failure_source: "ai-tidu9",
        reason: "No upstream model provider is configured.",
        next_steps: [
          "Configure an AI-Tidu9 provider or restore an available host provider.",
          "Update the AI-Tidu9 Codex configuration and retry.",
          "Switch to Official mode if AI-Tidu9 is not required.",
        ],
      },
    ),
    requestId,
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeEnterpriseEndpoint = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TiduError("CONFIGURATION_INVALID", "Enterprise endpoint is required.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "Enterprise endpoint is not a valid URL.", {
      cause: error,
    });
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Enterprise endpoint must use HTTPS. HTTP is allowed only for local development.",
    );
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Enterprise endpoint must not contain credentials, query parameters, or fragments.",
    );
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") || "/";
  return endpoint.toString().replace(/\/$/u, "");
};

const readEnterpriseConnectionSnapshot = (
  endpoint: string,
  payload: unknown,
): EnterpriseConnectionSnapshot => {
  if (!isRecord(payload) || payload.deployment !== "enterprise") {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "The provided URL is not an enterprise AI-Tidu9 runtime.",
    );
  }
  const product = payload.product;
  const virtualModel = payload.virtualModel;
  const guidance = payload.employeeGuidance;
  if (
    !isRecord(product) ||
    typeof product.name !== "string" ||
    !isRecord(virtualModel) ||
    typeof virtualModel.id !== "string" ||
    typeof virtualModel.name !== "string" ||
    !Number.isInteger(payload.revision) ||
    !Number.isInteger(payload.policyCount) ||
    !Number.isInteger(payload.capabilityCount) ||
    !Number.isInteger(payload.resourceCount) ||
    !Array.isArray(guidance) ||
    !guidance.every((step) => typeof step === "string")
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "The enterprise runtime returned an invalid public configuration.",
    );
  }
  const now = new Date().toISOString();
  return {
    endpoint,
    companyName: product.name,
    revision: Number(payload.revision),
    virtualModelId: virtualModel.id,
    virtualModelName: virtualModel.name,
    policyCount: Number(payload.policyCount),
    capabilityCount: Number(payload.capabilityCount),
    resourceCount: Number(payload.resourceCount),
    employeeGuidance: guidance as string[],
    connectedAt: now,
    checkedAt: now,
  };
};

const inspectEnterpriseEndpoint = async (
  endpoint: string,
): Promise<EnterpriseConnectionSnapshot> => {
  const discoveryUrl = new URL(
    `${new URL(endpoint).pathname.replace(/\/$/u, "")}/api/enterprise/public`,
    endpoint,
  );
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(ENTERPRISE_DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      `Enterprise configuration check failed with HTTP ${response.status}.`,
    );
  }
  return readEnterpriseConnectionSnapshot(endpoint, await response.json());
};

const readRouteIdentifier = (match: RegExpExecArray): string => {
  const identifier = match[1];
  if (identifier === undefined) {
    throw new Error("Matched route does not contain its required identifier.");
  }
  return identifier;
};

const readExpectedRevision = (body: Record<string, unknown>, field: string): number => {
  const revision = body[field];
  if (!Number.isInteger(revision) || Number(revision) < 1) {
    throw new TiduError("CONFIGURATION_INVALID", `${field} must be a positive integer.`);
  }
  return Number(revision);
};

const readDraftConfiguration = (
  body: Record<string, unknown>,
  mode: ConfigurationMode,
): TiduConfiguration => {
  const candidate = body.configuration;
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== CONFIG_SCHEMA_VERSION ||
    candidate.activeMode !== mode ||
    typeof candidate.activeProfileId !== "string" ||
    typeof candidate.virtualModelName !== "string"
  ) {
    throw new TiduError("CONFIGURATION_INVALID", "Configuration payload is invalid.");
  }

  const parseSpecialists = (value: unknown): CapabilitySpecialistConfiguration[] => {
    if (!Array.isArray(value)) {
      throw new TiduError("CONFIGURATION_INVALID", "Specialist configuration is invalid.");
    }
    const specialists: CapabilitySpecialistConfiguration[] = [];
    for (const specialist of value) {
      if (
        !isRecord(specialist) ||
        (specialist.source !== "official" &&
          specialist.source !== "company" &&
          specialist.source !== "custom") ||
        (specialist.host !== "codex" &&
          specialist.host !== "cursor" &&
          specialist.host !== "ollama" &&
          specialist.host !== "openai-compatible") ||
        typeof specialist.model !== "string" ||
        !Array.isArray(specialist.capabilities) ||
        !specialist.capabilities.every((capability) => typeof capability === "string")
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Specialist configuration is invalid.");
      }
      specialists.push({
        host: specialist.host,
        source: specialist.source,
        model: specialist.model,
        capabilities: specialist.capabilities as string[],
        inputCostPerMillionTokens:
          typeof specialist.inputCostPerMillionTokens === "number"
            ? specialist.inputCostPerMillionTokens
            : null,
        outputCostPerMillionTokens:
          typeof specialist.outputCostPerMillionTokens === "number"
            ? specialist.outputCostPerMillionTokens
            : null,
      });
    }
    return specialists;
  };
  if (!isRecord(candidate.modelSelection)) {
    throw new TiduError("CONFIGURATION_INVALID", "Model selection is invalid.");
  }
  if (
    (candidate.modelSelection.source !== "official" &&
      candidate.modelSelection.source !== "company" &&
      candidate.modelSelection.source !== "custom") ||
    typeof candidate.modelSelection.model !== "string"
  ) {
    throw new TiduError("CONFIGURATION_INVALID", "Model selection is invalid.");
  }
  if (!isRecord(candidate.capabilityCompletion)) {
    throw new TiduError("CONFIGURATION_INVALID", "Capability completion is invalid.");
  }
  const completionCandidate = candidate.capabilityCompletion;
  if (
    typeof completionCandidate.enabled !== "boolean" ||
    !Array.isArray(completionCandidate.mainCapabilities) ||
    !completionCandidate.mainCapabilities.every((capability) => typeof capability === "string") ||
    typeof completionCandidate.maximumSpecialists !== "number"
  ) {
    throw new TiduError("CONFIGURATION_INVALID", "Capability completion is invalid.");
  }
  const specialists = parseSpecialists(completionCandidate.specialists);
  const hostPolicies: Partial<
    Record<
      AgentHostId,
      {
        mainModel: TiduConfiguration["modelSelection"];
        mainCapabilities: readonly string[];
        specialists: readonly CapabilitySpecialistConfiguration[];
        maximumSpecialists: number;
      }
    >
  > = {};
  if (
    completionCandidate.hostPolicies !== undefined &&
    !isRecord(completionCandidate.hostPolicies)
  ) {
    throw new TiduError("CONFIGURATION_INVALID", "Host capability policy is invalid.");
  }
  if (isRecord(completionCandidate.hostPolicies)) {
    const supportedHosts = new Set(["codex", "cursor", "ollama", "openai-compatible"]);
    if (Object.keys(completionCandidate.hostPolicies).some((host) => !supportedHosts.has(host))) {
      throw new TiduError("CONFIGURATION_INVALID", "Host capability policy is invalid.");
    }
    for (const host of ["codex", "cursor", "ollama", "openai-compatible"] as const) {
      const policy = completionCandidate.hostPolicies[host];
      if (policy === undefined) continue;
      if (
        !isRecord(policy) ||
        !isRecord(policy.mainModel) ||
        (policy.mainModel.source !== "official" &&
          policy.mainModel.source !== "company" &&
          policy.mainModel.source !== "custom") ||
        typeof policy.mainModel.model !== "string" ||
        !Array.isArray(policy.mainCapabilities) ||
        !policy.mainCapabilities.every((capability) => typeof capability === "string") ||
        typeof policy.maximumSpecialists !== "number"
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Host capability policy is invalid.");
      }
      const policySpecialists = parseSpecialists(policy.specialists);
      hostPolicies[host] = {
        mainModel: {
          source: policy.mainModel.source,
          model: policy.mainModel.model,
        },
        mainCapabilities: policy.mainCapabilities as string[],
        specialists: policySpecialists,
        maximumSpecialists: policy.maximumSpecialists,
      };
    }
  }
  const configuration: TiduConfiguration = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeMode: mode,
    activeProfileId: candidate.activeProfileId,
    virtualModelName: candidate.virtualModelName,
    modelSelection: {
      source: candidate.modelSelection.source,
      model: candidate.modelSelection.model,
    },
    capabilityCompletion: {
      enabled: completionCandidate.enabled,
      mainCapabilities: completionCandidate.mainCapabilities as string[],
      specialists,
      maximumSpecialists: completionCandidate.maximumSpecialists,
      hostPolicies,
    },
  };
  if (mode === "expert") {
    const expertServices = candidate.expertServices;
    if (
      !isRecord(expertServices) ||
      typeof expertServices.host !== "string" ||
      typeof expertServices.port !== "number" ||
      typeof expertServices.responsesApiEnabled !== "boolean" ||
      typeof expertServices.chatCompletionsApiEnabled !== "boolean" ||
      typeof expertServices.taskApiEnabled !== "boolean"
    ) {
      throw new TiduError("CONFIGURATION_INVALID", "Expert service configuration is invalid.");
    }
    configuration.expertServices = {
      host: expertServices.host,
      port: expertServices.port,
      responsesApiEnabled: expertServices.responsesApiEnabled,
      chatCompletionsApiEnabled: expertServices.chatCompletionsApiEnabled,
      taskApiEnabled: expertServices.taskApiEnabled,
    };
  }
  return configuration;
};

const isExpertServiceEnabled = async (
  storage: StorageAdapter,
  service: "chatCompletionsApiEnabled" | "responsesApiEnabled" | "taskApiEnabled",
): Promise<boolean> => {
  const configuration = (await storage.configurationStore.loadWorkspace()).active.configuration;
  return configuration.activeMode !== "expert" || configuration.expertServices?.[service] !== false;
};

const validateMutationRequest = (request: import("node:http").IncomingMessage): void => {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new TiduError("CONFIGURATION_INVALID", "Content-Type must be application/json.");
  }

  const origin = request.headers.origin;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch (error) {
      throw new TiduError("CONFIGURATION_INVALID", "Request origin is invalid.", { cause: error });
    }
    if (originHost !== request.headers.host) {
      throw new TiduError("CONFIGURATION_INVALID", "Cross-origin configuration writes are denied.");
    }
  }
};

const handleConfigurationMutationError = (
  response: import("node:http").ServerResponse,
  error: unknown,
): void => {
  if (error instanceof TiduError && error.code === "CONFIGURATION_CONFLICT") {
    sendJson(response, 409, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof TiduError && error.code === "CONFIGURATION_INVALID") {
    sendJson(response, 422, {
      error: error.code,
      message: error.message,
      issues: error.details.issues ?? [],
    });
    return;
  }
  if (
    error instanceof TiduError &&
    error.code === "INTERNAL_ERROR" &&
    (error.details.failureSource === "official-codex" || error.details.failureSource === "ai-tidu9")
  ) {
    const failureSource = error.details.failureSource;
    const nextSteps = Array.isArray(error.details.nextSteps)
      ? error.details.nextSteps.filter((step): step is string => typeof step === "string")
      : [];
    sendJson(response, 503, {
      error: error.code,
      failureSource,
      message: error.message,
      nextSteps,
      reason: typeof error.details.reason === "string" ? error.details.reason : error.message,
      reasonCode:
        typeof error.details.reasonCode === "string" ? error.details.reasonCode : "unknown_failure",
    });
    return;
  }
  throw error;
};

export const evaluateCapabilityCompletionDiagnostic = (
  record:
    | Pick<CapabilityCompletionUsageRecord, "mainResult" | "outcome" | "secondaryResults">
    | undefined,
  upstreamStatusCode: number | null,
) => {
  const mainInvoked =
    record?.mainResult.outcome === "succeeded" || record?.mainResult.outcome === "failed";
  const selectedSecondaryResults =
    record?.secondaryResults.filter(
      (result) => result.outcome !== "not-run" || result.skipReason === "blocked-by-failure",
    ) ?? [];
  const selectedModelResults = [
    ...(record !== undefined &&
    (record.mainResult.outcome !== "not-run" ||
      record.mainResult.skipReason === "blocked-by-failure")
      ? [record.mainResult]
      : []),
    ...selectedSecondaryResults,
  ];
  const secondaryInvoked = selectedSecondaryResults.some(
    (result) => result.outcome === "succeeded" || result.outcome === "failed",
  );
  const allSelectedInvocationsSucceeded =
    selectedModelResults.length > 0 &&
    selectedModelResults.every(
      (result) => result.outcome === "succeeded" && result.executedModel !== null,
    );
  const upstreamSucceeded =
    upstreamStatusCode !== null && upstreamStatusCode >= 200 && upstreamStatusCode < 300;
  const passed =
    upstreamSucceeded && record?.outcome === "succeeded" && allSelectedInvocationsSucceeded;
  let message =
    "The configured primary and secondary routing path completed successfully. This diagnostic does not verify the model's claimed semantic capability.";
  if (!passed) {
    if (record === undefined) {
      message = "The routing-path diagnostic did not produce a fresh execution record.";
    } else if (record.mainResult.outcome === "failed") {
      message = "The routing-path diagnostic failed because the primary invocation failed.";
    } else if (
      record.mainResult.outcome === "succeeded" &&
      record.mainResult.executedModel === null
    ) {
      message =
        "The routing-path diagnostic failed because the primary model returned no execution receipt.";
    } else if (selectedSecondaryResults.some((result) => result.outcome === "failed")) {
      message =
        "The routing-path diagnostic failed because at least one selected secondary invocation failed.";
    } else if (selectedSecondaryResults.some((result) => result.outcome === "not-run")) {
      message =
        "The routing-path diagnostic failed because at least one selected secondary invocation did not run.";
    } else if (selectedSecondaryResults.some((result) => result.executedModel === null)) {
      message =
        "The routing-path diagnostic failed because at least one selected secondary model returned no execution receipt.";
    } else if (selectedModelResults.length === 0) {
      message = "The routing-path diagnostic failed because no configured model was invoked.";
    } else if (!upstreamSucceeded) {
      message = `The routing-path diagnostic returned HTTP ${String(upstreamStatusCode)}.`;
    } else {
      message = "The routing-path diagnostic did not finish with a successful routing outcome.";
    }
  }
  return {
    allSelectedInvocationsSucceeded,
    httpStatus: passed ? 200 : 502,
    mainInvoked,
    message,
    passed,
    secondaryInvoked,
  };
};

const handleRequest = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  storage: StorageAdapter,
  provider: ModelProvider | undefined,
  getCatalogProviderForHost: (host: AgentHostId) => Promise<ModelProvider | undefined>,
  capabilityCompletionProvider: CapabilityCompletionProvider | undefined,
  agentKernel: AgentKernel | undefined,
  enterprise: EnterpriseControlPlane | undefined,
  scaling: ScalingControlPlane | undefined,
  capabilityProviders: readonly CapabilityProviderImplementation[],
  capabilityRuntime: CapabilityRuntime | undefined,
  deployment: "personal" | "enterprise",
  runtimeNetwork: { host: string; port: number },
  refreshCodexModelCatalog: () => Promise<void>,
  runtimePaths: {
    /** Runtime configuration or persistent configuration-storage path. */
    configurationPath: string;
    /** Current terminal or absolute file receiving runtime logs. */
    logLocation: string;
    /** Active reverse-proxy configuration path, or null when no proxy is configured. */
    proxyConfigurationPath: string | null;
  },
): Promise<void> => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/health") {
    const scalingHealth = await scaling?.health();
    sendJson(response, scalingHealth?.status === "unavailable" ? 503 : 200, {
      product: PRODUCT.name,
      runtimeMode: process.env.NODE_ENV === "development" ? "development" : "installed",
      status: scalingHealth?.status === "unavailable" ? "unavailable" : "ok",
      scaling: scalingHealth ?? { status: "disabled" },
      storage: {
        provider: storage.provider,
        schemaVersion: storage.schemaVersion,
        status: "ok",
      },
      version: PRODUCT.version,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/capability-completion") {
    const workspace = await storage.configurationStore.loadWorkspace();
    const status = await capabilityCompletionProvider?.inspectCapabilityCompletion();
    const enterpriseState = await enterprise?.snapshot();
    const remoteCompany = await storage.enterpriseConnectionStore?.load();
    const completionConfiguration = workspace.active.configuration.capabilityCompletion;
    const codexMainCapabilities =
      completionConfiguration.hostPolicies?.codex?.mainCapabilities ??
      (provider?.descriptor.type === "codex-host" ? completionConfiguration.mainCapabilities : []);
    const codexHostProvider = await getCatalogProviderForHost("codex");
    const codexReasoningEffortSupported =
      codexHostProvider?.descriptor.type === "codex-host" &&
      codexMainCapabilities.includes("reasoning");
    const activeHost: AgentHostId | null =
      provider?.descriptor.type === "codex-host"
        ? "codex"
        : provider?.descriptor.type === "cursor-host"
          ? "cursor"
          : provider?.descriptor.type === "ollama"
            ? "ollama"
            : provider?.descriptor.type === "openai-compatible"
              ? "openai-compatible"
              : null;
    sendJson(response, 200, {
      activeHost,
      available: capabilityCompletionProvider !== undefined,
      codexReasoningEffortSupported,
      operational:
        capabilityCompletionProvider !== undefined &&
        workspace.active.configuration.capabilityCompletion.enabled &&
        (workspace.active.configuration.capabilityCompletion.specialists.length > 0 ||
          Object.values(
            workspace.active.configuration.capabilityCompletion.hostPolicies ?? {},
          ).some((policy) => policy.specialists.length > 0)),
      configuration: workspace.active.configuration.capabilityCompletion,
      mainModel: workspace.active.configuration.modelSelection,
      records: status?.records ?? [],
      company: {
        connected: enterpriseState !== undefined || remoteCompany !== null,
        publishedCapabilityCount:
          enterpriseState?.capabilities.length ?? remoteCompany?.capabilityCount ?? 0,
      },
      hosts: ["codex", "cursor", "cli", "ollama", "openai-compatible"],
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/capability-completion/test") {
    try {
      validateMutationRequest(request);
      const body = await readJsonBody(request);
      const host = isRecord(body) ? body.host : undefined;
      if (
        host !== "codex" &&
        host !== "cursor" &&
        host !== "ollama" &&
        host !== "openai-compatible"
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "A valid primary host is required.");
      }
      if (capabilityCompletionProvider === undefined) {
        sendJson(response, 503, { error: "CAPABILITY_COMPLETION_UNAVAILABLE" });
        return;
      }
      const workspace = await storage.configurationStore.loadWorkspace();
      const configuration = workspace.active.configuration.capabilityCompletion;
      const hostPolicy = configuration.hostPolicies?.[host];
      const mainCapabilities = hostPolicy?.mainCapabilities ?? configuration.mainCapabilities;
      const specialists = hostPolicy?.specialists ?? configuration.specialists;
      const requiredCapability =
        specialists
          .flatMap((specialist) => specialist.capabilities)
          .find((capability) => !mainCapabilities.includes(capability)) ??
        specialists.flatMap((specialist) => specialist.capabilities)[0];
      if (!configuration.enabled || specialists.length === 0 || requiredCapability === undefined) {
        sendJson(response, 409, {
          error: "CAPABILITY_COMPLETION_TEST_NOT_READY",
          message:
            "Enable dynamic model routing and configure at least one secondary model capability.",
        });
        return;
      }
      const startedAt = performance.now();
      const diagnosticStartedAt = Date.now();
      const readDiagnosticRecord = async (): Promise<CapabilityCompletionUsageRecord | undefined> =>
        (await capabilityCompletionProvider.inspectCapabilityCompletion()).records.find(
          (record) =>
            record.role === "verification" && Date.parse(record.occurredAt) >= diagnosticStartedAt,
        );
      try {
        const result = await capabilityCompletionProvider.execute({
          protocol: "responses",
          body: {
            model: workspace.active.configuration.activeProfileId,
            input:
              "Run a minimal primary-secondary routing-path diagnostic. Return one short sentence.",
            stream: false,
          },
          virtualModelId: workspace.active.configuration.activeProfileId,
          signal: AbortSignal.timeout(120_000),
          routing: {
            host,
            requiredCapabilities: [requiredCapability],
            requireSpecialist: true,
            role: "verification",
          },
        });
        const latest = await readDiagnosticRecord();
        const diagnostic = evaluateCapabilityCompletionDiagnostic(latest, result.statusCode);
        sendJson(response, diagnostic.httpStatus, {
          ...(diagnostic.passed ? {} : { error: "CAPABILITY_COMPLETION_TEST_FAILED" }),
          verificationScope: "routing-path-only",
          capabilitySemanticsVerified: false,
          message: diagnostic.message,
          durationMilliseconds: Math.round(performance.now() - startedAt),
          mainInvoked: diagnostic.mainInvoked,
          secondaryInvoked: diagnostic.secondaryInvoked,
          requiredCapability,
          record: latest ?? null,
          statusCode: result.statusCode,
        });
      } catch (error) {
        const latest = await readDiagnosticRecord();
        const diagnostic = evaluateCapabilityCompletionDiagnostic(latest, null);
        sendJson(response, 502, {
          error: "CAPABILITY_COMPLETION_TEST_FAILED",
          message: error instanceof Error ? error.message : diagnostic.message,
          verificationScope: "routing-path-only",
          capabilitySemanticsVerified: false,
          durationMilliseconds: Math.round(performance.now() - startedAt),
          mainInvoked: diagnostic.mainInvoked,
          secondaryInvoked: diagnostic.secondaryInvoked,
          requiredCapability,
          record: latest ?? null,
          statusCode: null,
        });
      }
    } catch (error) {
      if (error instanceof TiduError) {
        handleConfigurationMutationError(response, error);
      } else {
        sendJson(response, 502, {
          error: "CAPABILITY_COMPLETION_TEST_FAILED",
          message: error instanceof Error ? error.message : "Capability completion test failed.",
        });
      }
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/services") {
    sendJson(
      response,
      200,
      await createServiceInventory(storage, provider, runtimeNetwork, deployment, runtimePaths),
    );
    return;
  }

  const serviceActionRoute = /^\/api\/services\/([^/]+)\/(refresh|start|stop|restart)$/u.exec(
    pathname,
  );
  if (request.method === "POST" && serviceActionRoute !== null) {
    validateMutationRequest(request);
    const serviceId = decodeURIComponent(serviceActionRoute[1] ?? "");
    const action = serviceActionRoute[2];
    const inventory = await createServiceInventory(
      storage,
      provider,
      runtimeNetwork,
      deployment,
      runtimePaths,
    );
    const service = inventory.services.find((candidate) => candidate.id === serviceId);
    if (service === undefined) {
      sendJson(response, 404, { error: "SERVICE_NOT_FOUND" });
      return;
    }
    if (action === "refresh") {
      sendJson(response, 200, {
        ...inventory,
        result: {
          checkedAt: new Date().toISOString(),
          message: "Service status refreshed",
          status: "passed",
        },
      });
      return;
    }
    if (action === "start") {
      sendJson(response, 409, { error: "SERVICE_ALREADY_RUNNING" });
      return;
    }
    if (runtimeProcessKind() === "development" && action === "restart") {
      sendJson(response, 409, {
        error: "DEVELOPMENT_SUPERVISOR_REQUIRED",
        command: "npm run tidu:dev-p",
      });
      return;
    }
    if (action === "restart") scheduleInstalledRuntimeRestart();
    sendJson(response, 202, { accepted: true, action, serviceId });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
    return;
  }

  if (request.method === "GET" && pathname === "/v1/ecosystem/providers") {
    sendJson(response, 200, {
      providers: capabilityProviders.map((capabilityProvider) => capabilityProvider.manifest),
    });
    return;
  }

  const capabilityProviderRoute = /^\/v1\/ecosystem\/providers\/([^/]+)\/invoke$/u.exec(pathname);
  if (request.method === "POST" && capabilityProviderRoute !== null) {
    try {
      validateMutationRequest(request);
      if (capabilityRuntime === undefined) {
        sendJson(response, 503, { error: "CAPABILITY_RUNTIME_NOT_CONFIGURED" });
        return;
      }
      const providerId = decodeURIComponent(capabilityProviderRoute[1] ?? "");
      const capabilityProvider = capabilityProviders.find(
        (candidate) => candidate.manifest.id === providerId,
      );
      if (capabilityProvider === undefined) {
        sendJson(response, 404, { error: "CAPABILITY_PROVIDER_NOT_FOUND" });
        return;
      }
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.operation !== "string" || !body.operation.trim()) {
        throw new TiduError("CONFIGURATION_INVALID", "Capability operation is required.");
      }
      const result = await capabilityRuntime.invoke(capabilityProvider, {
        operation: body.operation,
        input: body.input,
        tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        maximumOutputBytes:
          typeof body.maximumOutputBytes === "number" ? body.maximumOutputBytes : undefined,
      });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof TiduError) {
        handleConfigurationMutationError(response, error);
      } else {
        sendJson(response, 422, {
          error: "CAPABILITY_INVOCATION_REJECTED",
          message: error instanceof Error ? error.message : "Capability invocation was rejected.",
        });
      }
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/scaling") {
    if (scaling === undefined) {
      sendJson(response, 404, {
        error: "SCALING_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    const metrics = scaling.metrics();
    sendJson(response, 200, {
      health: await scaling.health(),
      metrics: { counters: metrics.counters, gauges: metrics.gauges },
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/scaling/tasks") {
    validateMutationRequest(request);
    if (scaling === undefined) {
      sendJson(response, 404, {
        error: "SCALING_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        throw new TiduError("CONFIGURATION_INVALID", "Scaling task must be an object.");
      }
      const requiredStrings = ["id", "tenantId", "resourceGroup", "payloadReference"] as const;
      const requiredNumbers = [
        "priority",
        "maxAttempts",
        "memoryBytes",
        "scratchBytes",
        "payloadBytes",
      ] as const;
      if (
        requiredStrings.some((field) => typeof body[field] !== "string") ||
        requiredNumbers.some((field) => typeof body[field] !== "number")
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Scaling task fields are invalid.");
      }
      const result = await scaling.submit(body as unknown as ScalingTaskRequest);
      sendJson(response, result.accepted ? 202 : 429, result);
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/config-center") {
    sendJson(
      response,
      200,
      await createConfigCenterBootstrap(
        storage,
        provider?.descriptor,
        undefined,
        enterprise,
        deployment,
        runtimeNetwork,
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/host-usage") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    const snapshot = await readCachedRuntimeValue(storage, "host-usage", 60_000, async () => {
      const [codex, cursor] = await Promise.all([
        inspectCodexHostAccountReport(5_000).catch(() => null),
        inspectCursorHostLoginAsync().catch(() => null),
      ]);
      const cursorProvider = cursor?.reusable
        ? await getCatalogProviderForHost("cursor")
        : undefined;
      return {
        activeProvider: provider?.descriptor ?? null,
        codex,
        cursor: {
          agentStatus: cursor?.status ?? "unavailable",
          agentProtocolAvailable: cursor?.acpAvailable ?? false,
          accountEmail: cursor?.accountEmail ?? null,
          accountPlan: cursor?.accountPlan ?? null,
          model: cursorProvider?.descriptor.model ?? null,
        },
      };
    });
    sendJson(response, 200, snapshot);
    return;
  }

  if (request.method === "POST" && pathname === "/api/cursor/connect") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      await readJsonBody(request);
      await reloginCursorHost({ stdio: "pipe" });
      const state = inspectCursorHostLogin();
      sendJson(response, state.reusable ? 200 : 409, {
        connected: state.reusable,
        status: state.status,
      });
    } catch (error) {
      if (error instanceof TiduError && error.code === "CONFIGURATION_INVALID") {
        handleConfigurationMutationError(response, error);
      } else {
        sendJson(response, 409, {
          connected: false,
          status: inspectCursorHostLogin().status,
          reason: "cursor-sign-in-incomplete",
        });
      }
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/clients/codex/connect") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      await readJsonBody(request);
      const configuredHost = runtimeNetwork.host;
      const clientHost =
        configuredHost === "0.0.0.0" || configuredHost === "::"
          ? DEFAULT_RUNTIME_HOST
          : configuredHost;
      const addressHost = clientHost.includes(":") ? `[${clientHost}]` : clientHost;
      const endpoint = `http://${addressHost}:${runtimeNetwork.port}`;
      const configured = await configureCodexClient({
        endpoint,
        verifyRuntime: false,
      });
      setupConnectors({
        action: "uninstall",
        endpoint,
        targets: ["codex"],
        cliEntry: process.env.TIDU_CONNECTOR_CLI_ENTRY,
      });
      sendJson(response, 200, {
        connected: true,
        profile: configured.profile,
        model: configured.model,
        activeMode: configured.activeMode,
      });
    } catch (error) {
      if (error instanceof TiduError) {
        handleConfigurationMutationError(response, error);
      } else {
        sendJson(response, 500, {
          error: "CODEX_CLIENT_CONFIGURATION_FAILED",
          message: error instanceof Error ? error.message : "Codex client configuration failed.",
        });
      }
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/clients/codex/configuration") {
    sendJson(response, 200, inspectCodexClientConfiguration());
    return;
  }

  if (request.method === "POST" && pathname === "/api/clients/codex/configuration") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      const body = await readJsonBody(request);
      const mode = isRecord(body) ? body.mode : undefined;
      if (mode !== "official" && mode !== "ai-tidu9") {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          "Codex configuration mode must be official or ai-tidu9.",
        );
      }
      const configuredHost = runtimeNetwork.host;
      const clientHost =
        configuredHost === "0.0.0.0" || configuredHost === "::"
          ? DEFAULT_RUNTIME_HOST
          : configuredHost;
      const addressHost = clientHost.includes(":") ? `[${clientHost}]` : clientHost;
      const endpoint = `http://${addressHost}:${runtimeNetwork.port}`;
      if (mode === "ai-tidu9") {
        await configureCodexClient({
          endpoint,
        });
        setupConnectors({
          action: "uninstall",
          endpoint,
          targets: ["codex"],
          cliEntry: process.env.TIDU_CONNECTOR_CLI_ENTRY,
        });
      } else {
        setupConnectors({
          action: "uninstall",
          endpoint,
          targets: ["codex"],
          cliEntry: process.env.TIDU_CONNECTOR_CLI_ENTRY,
        });
      }
      sendJson(response, 200, await switchCodexClientConfiguration({ mode }));
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "DELETE" && pathname === "/api/clients/codex/configuration") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      await readJsonBody(request);
      const configuredHost = runtimeNetwork.host;
      const clientHost =
        configuredHost === "0.0.0.0" || configuredHost === "::"
          ? DEFAULT_RUNTIME_HOST
          : configuredHost;
      const addressHost = clientHost.includes(":") ? `[${clientHost}]` : clientHost;
      setupConnectors({
        action: "uninstall",
        endpoint: `http://${addressHost}:${runtimeNetwork.port}`,
        targets: ["codex"],
        cliEntry: process.env.TIDU_CONNECTOR_CLI_ENTRY,
      });
      sendJson(response, 200, {
        ...removeCodexClientConfiguration(),
        configuration: inspectCodexClientConfiguration(),
      });
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/provider/detect") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      const body = await readJsonBody(request);
      const selected = isRecord(body) ? body.provider : undefined;
      if (
        selected !== "codex-host" &&
        selected !== "cursor-host" &&
        selected !== "ollama" &&
        selected !== "openai-compatible"
      ) {
        sendJson(response, 422, {
          detected: false,
          reason: "unknown-provider",
        });
        return;
      }

      let discoveredModel: string | undefined;
      let reason: string | undefined;
      let account: {
        status: string;
        type: string | null;
        email: string | null;
        plan: string | null;
      } | null = null;
      if (selected === "codex-host") {
        const discovered = await inspectCodexHostConfiguration(process.env.TIDU_PROVIDER_MODEL);
        discoveredModel = discovered?.model;
        const login = inspectCodexHostLogin();
        account = {
          status: login.status,
          type: discovered?.account?.type ?? null,
          email: discovered?.account?.email ?? null,
          plan: discovered?.account?.plan ?? null,
        };
        if (discoveredModel === undefined) {
          reason =
            login.status === "unavailable"
              ? "codex-cli-unavailable"
              : login.status === "not-authenticated"
                ? "codex-not-authenticated"
                : "codex-model-undiscovered";
        }
      } else if (selected === "cursor-host") {
        const discovered = await createCursorHostModelProvider();
        discoveredModel = discovered?.descriptor.model;
        const login = inspectCursorHostLogin();
        account = {
          status: login.status,
          type: login.status === "authenticated" ? "cursor" : null,
          email: login.accountEmail ?? null,
          plan: null,
        };
        if (discoveredModel === undefined) {
          reason =
            login.status === "unavailable"
              ? "cursor-cli-unavailable"
              : login.status === "not-authenticated"
                ? "cursor-not-authenticated"
                : !login.acpAvailable
                  ? "cursor-acp-unavailable"
                  : "cursor-model-undiscovered";
        }
      } else if (selected === "ollama") {
        try {
          const models = await discoverOllamaModels({
            baseUrl:
              process.env.TIDU_PROVIDER === "ollama"
                ? process.env.TIDU_PROVIDER_BASE_URL
                : undefined,
          });
          discoveredModel =
            provider?.descriptor.type === "ollama" && models.includes(provider.descriptor.model)
              ? provider.descriptor.model
              : models[0];
          if (discoveredModel === undefined) {
            reason = "ollama-no-models";
          }
        } catch {
          reason = "ollama-unavailable";
        }
      } else if (resolveRuntimeProviderType(provider) === selected) {
        discoveredModel = provider?.descriptor.model;
      } else {
        reason = "compatible-provider-not-active";
      }

      const detected = discoveredModel !== undefined;
      const matchesRuntime = detected && resolveRuntimeProviderType(provider) === selected;
      sendJson(response, detected ? 200 : 409, {
        detected,
        matchesRuntime,
        model: discoveredModel ?? null,
        provider: selected,
        account,
        reason: reason ?? (matchesRuntime ? null : "restart-required"),
      });
    } catch {
      sendJson(response, 500, { detected: false, reason: "detection-failed" });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/enterprise/public") {
    if (deployment !== "enterprise" || enterprise === undefined) {
      sendJson(response, 404, { error: "ENTERPRISE_RUNTIME_NOT_CONFIGURED" });
      return;
    }
    const [state, guidance, workspace] = await Promise.all([
      enterprise.snapshot(),
      enterprise.generateGuidance(),
      storage.configurationStore.loadWorkspace(),
    ]);
    const activeConfiguration = workspace.active.configuration;
    const companyName =
      state.scopes.find((scope) => scope.type === "tenant" && scope.parentId === null)?.name ??
      PRODUCT.name;
    sendJson(response, 200, {
      deployment: "enterprise",
      product: { name: companyName, version: PRODUCT.version },
      revision: state.revision,
      virtualModel: {
        id: activeConfiguration.activeProfileId,
        name: activeConfiguration.virtualModelName,
      },
      policyCount: state.policies.length,
      capabilityCount: state.capabilities.length,
      resourceCount: state.resources.length,
      employeeGuidance: guidance.employee,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/enterprise/connection") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      const body = await readJsonBody(request);
      const endpoint = normalizeEnterpriseEndpoint(isRecord(body) ? body.endpoint : undefined);
      await storage.enterpriseConnectionStore.save(await inspectEnterpriseEndpoint(endpoint));
      sendJson(
        response,
        200,
        await createConfigCenterBootstrap(
          storage,
          provider?.descriptor,
          undefined,
          enterprise,
          deployment,
          runtimeNetwork,
        ),
      );
    } catch (error) {
      if (error instanceof TiduError) {
        handleConfigurationMutationError(response, error);
      } else {
        sendJson(response, 502, {
          error: "ENTERPRISE_CONNECTION_FAILED",
          message: "The company runtime could not be reached or returned invalid data.",
        });
      }
    }
    return;
  }

  if (request.method === "DELETE" && pathname === "/api/enterprise/connection") {
    if (deployment !== "personal") {
      sendJson(response, 403, { error: "PERSONAL_EDITION_ONLY" });
      return;
    }
    try {
      validateMutationRequest(request);
      await readJsonBody(request);
      await storage.enterpriseConnectionStore.remove();
      sendJson(
        response,
        200,
        await createConfigCenterBootstrap(
          storage,
          provider?.descriptor,
          undefined,
          enterprise,
          deployment,
          runtimeNetwork,
        ),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/enterprise") {
    if (enterprise === undefined) {
      sendJson(response, 404, {
        error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    const state = await enterprise.snapshot();
    sendJson(response, 200, {
      revision: state.revision,
      administratorInitialized: state.administratorKey !== null,
      policyCount: state.policies.length,
      capabilityCount: state.capabilities.length,
      resourceCount: state.resources.length,
      quotaPoolCount: state.quotaPools.length,
      guidance: await enterprise.generateGuidance(),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/enterprise/members/usage") {
    if (deployment !== "enterprise") {
      sendJson(response, 403, { error: "ENTERPRISE_ADMIN_ONLY" });
      return;
    }
    if (enterprise === undefined) {
      sendJson(response, 404, {
        error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    const sessionId = request.headers["x-tidu-admin-session"];
    if (typeof sessionId !== "string" || !enterprise.validateAdministratorSession(sessionId)) {
      sendJson(response, 401, { error: "ADMINISTRATOR_SESSION_REQUIRED" });
      return;
    }
    const state = await enterprise.snapshot();
    const enterpriseResources = new Set(
      state.resources
        .filter((resource) => resource.ownership === "enterprise")
        .map((resource) => resource.id),
    );
    const enterprisePools = state.quotaPools.filter((pool) =>
      enterpriseResources.has(pool.resourceId),
    );
    const poolsById = new Map(enterprisePools.map((pool) => [pool.id, pool]));
    const resourceNames = new Map(state.resources.map((resource) => [resource.id, resource.name]));
    const userScopeIds = new Set(
      state.scopes.filter((scope) => scope.type === "user").map((scope) => scope.id),
    );
    sendJson(response, 200, {
      revision: state.revision,
      totals: {
        capacity: enterprisePools.reduce((total, pool) => total + pool.capacity, 0),
        remaining: enterprisePools.reduce((total, pool) => total + pool.remaining, 0),
        reserved: enterprisePools.reduce((total, pool) => total + pool.reserved, 0),
        settled: enterprisePools.reduce((total, pool) => total + pool.settled, 0),
      },
      members: state.identities.map((identity) => ({
        id: identity.id,
        displayName: identity.displayName,
        roles: identity.roles,
        allocations: state.quotaAllocations
          .filter(
            (allocation) =>
              userScopeIds.has(allocation.scopeId) &&
              identity.scopeIds.includes(allocation.scopeId) &&
              poolsById.has(allocation.poolId),
          )
          .map((allocation) => {
            const pool = poolsById.get(allocation.poolId);
            return {
              allocationId: allocation.id,
              resourceName:
                pool === undefined ? "" : (resourceNames.get(pool.resourceId) ?? pool.resourceId),
              limit: allocation.limit,
              settled: allocation.settled,
              reserved: allocation.reserved,
              remaining: Math.max(0, allocation.limit - allocation.settled - allocation.reserved),
            };
          }),
      })),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/enterprise/admin/initialize") {
    validateMutationRequest(request);
    await readJsonBody(request);
    if (deployment !== "enterprise") {
      sendJson(response, 403, { error: "ENTERPRISE_ADMIN_READ_ONLY" });
      return;
    }
    if (enterprise === undefined) {
      sendJson(response, 404, {
        error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    let generated: Awaited<ReturnType<EnterpriseControlPlane["initializeAdministratorKey"]>>;
    try {
      generated = await enterprise.initializeAdministratorKey();
    } catch (error) {
      if (error instanceof Error && error.message.includes("already initialized")) {
        sendJson(response, 409, {
          error: "ADMINISTRATOR_KEY_ALREADY_INITIALIZED",
        });
        return;
      }
      throw error;
    }
    sendJson(response, 201, {
      key: generated.key,
      keyId: generated.record.id,
      message: "Save this administrator key now. It cannot be retrieved again.",
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/enterprise/admin/session") {
    validateMutationRequest(request);
    if (deployment !== "enterprise") {
      sendJson(response, 403, { error: "ENTERPRISE_ADMIN_READ_ONLY" });
      return;
    }
    if (enterprise === undefined) {
      sendJson(response, 404, {
        error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || typeof body.key !== "string") {
      throw new TiduError("CONFIGURATION_INVALID", "Administrator key is required.");
    }
    try {
      sendJson(response, 201, await enterprise.authenticateAdministrator(body.key));
    } catch {
      sendJson(response, 401, { error: "ADMINISTRATOR_AUTHENTICATION_FAILED" });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/enterprise/admin/rotate") {
    validateMutationRequest(request);
    await readJsonBody(request);
    if (deployment !== "enterprise") {
      sendJson(response, 403, { error: "ENTERPRISE_ADMIN_READ_ONLY" });
      return;
    }
    if (enterprise === undefined) {
      sendJson(response, 404, {
        error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED",
      });
      return;
    }
    const sessionId = request.headers["x-tidu-admin-session"];
    if (typeof sessionId !== "string" || !enterprise.validateAdministratorSession(sessionId)) {
      sendJson(response, 401, { error: "ADMINISTRATOR_SESSION_REQUIRED" });
      return;
    }
    const generated = await enterprise.rotateAdministratorKey();
    sendJson(response, 201, {
      key: generated.key,
      keyId: generated.record.id,
      message: "Save this replacement administrator key now. Earlier sessions were revoked.",
    });
    return;
  }

  if (
    pathname.startsWith("/api/tasks") &&
    !(await isExpertServiceEnabled(storage, "taskApiEnabled"))
  ) {
    sendJson(response, 404, { error: "SERVICE_DISABLED" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/tasks") {
    const tasks = agentKernel
      ? await agentKernel.listTasks(100)
      : (await storage.taskCapsuleStore.list(100)).map(createTaskControlView);
    sendJson(response, 200, { available: agentKernel !== undefined, tasks });
    return;
  }

  const taskRoute = /^\/api\/tasks\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})$/u.exec(pathname);
  if (request.method === "GET" && taskRoute !== null) {
    const taskId = readRouteIdentifier(taskRoute);
    const capsule = agentKernel
      ? await agentKernel.getTask(taskId)
      : await storage.taskCapsuleStore.load(taskId);
    sendJson(response, capsule === undefined ? 404 : 200, capsule ?? { error: "TASK_NOT_FOUND" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/tasks") {
    try {
      validateMutationRequest(request);
      if (agentKernel === undefined) {
        sendJson(response, 503, { error: "AGENT_KERNEL_NOT_CONFIGURED" });
        return;
      }
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        typeof body.goal !== "string" ||
        body.goal.trim() === "" ||
        (body.acceptanceCriteria !== undefined &&
          (!Array.isArray(body.acceptanceCriteria) ||
            body.acceptanceCriteria.some((item) => typeof item !== "string")))
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "goal must be a non-empty string.");
      }
      const input: CreateAgentTaskInput = {
        goal: {
          objective: body.goal,
          acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
            ? (body.acceptanceCriteria as string[])
            : [],
        },
        originHost:
          body.originHost === "codex" ||
          body.originHost === "cursor" ||
          body.originHost === "ollama" ||
          body.originHost === "openai-compatible"
            ? body.originHost
            : "openai-compatible",
      };
      const created = await agentKernel.createTask(input);
      const capsule = body.run === true ? await agentKernel.runTask(created.task.taskId) : created;
      sendJson(response, 201, capsule);
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  const taskControlRoute = /^\/api\/tasks\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})\/control$/u.exec(
    pathname,
  );
  if (request.method === "POST" && taskControlRoute !== null) {
    try {
      validateMutationRequest(request);
      if (agentKernel === undefined) {
        sendJson(response, 503, { error: "AGENT_KERNEL_NOT_CONFIGURED" });
        return;
      }
      const body = await readJsonBody(request);
      if (!isRecord(body) || !["cancel", "pause", "resume"].includes(String(body.action))) {
        throw new TiduError("CONFIGURATION_INVALID", "Unsupported task-control action.");
      }
      const taskId = readRouteIdentifier(taskControlRoute);
      const capsule =
        body.action === "pause"
          ? await agentKernel.pauseTask(taskId)
          : body.action === "cancel"
            ? await agentKernel.cancelTask(taskId)
            : await agentKernel.resumeTask(taskId);
      sendJson(response, 200, capsule);
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  const taskApprovalRoute = /^\/api\/tasks\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})\/approval$/u.exec(
    pathname,
  );
  if (request.method === "POST" && taskApprovalRoute !== null) {
    try {
      validateMutationRequest(request);
      if (agentKernel === undefined) {
        sendJson(response, 503, { error: "AGENT_KERNEL_NOT_CONFIGURED" });
        return;
      }
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        typeof body.stepId !== "string" ||
        typeof body.approved !== "boolean"
      ) {
        throw new TiduError("CONFIGURATION_INVALID", "Approval decision is invalid.");
      }
      sendJson(
        response,
        200,
        await agentKernel.resolveApproval(
          readRouteIdentifier(taskApprovalRoute),
          body.stepId,
          body.approved,
        ),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/v1/models") {
    const workspace = await storage.configurationStore.loadWorkspace();
    const virtualModel = createOpenAiModel(
      workspace.active.configuration,
      workspace.active.updatedAt,
    );
    sendOpenAiJson(response, 200, { object: "list", data: [virtualModel] }, randomUUID());
    return;
  }

  if (request.method === "GET" && pathname === "/api/models/upstreams") {
    // Coalesce concurrent reads only. Capability editing must never reuse a stale per-model catalog.
    const catalog = await readCachedRuntimeValue(storage, "upstream-models", 0, async () => {
      const workspace = await storage.configurationStore.loadWorkspace();
      const [cursorProvider, ollamaProvider, compatibleProvider, codexLogin] = await Promise.all([
        getCatalogProviderForHost("cursor"),
        getCatalogProviderForHost("ollama"),
        getCatalogProviderForHost("openai-compatible"),
        inspectCodexHostLoginAsync(),
      ]);
      const [cursorCatalogModels, ollamaModels, compatibleModels] = await Promise.all([
        cursorProvider?.listModels?.().catch(() => []) ?? [],
        ollamaProvider?.listModels?.().catch(() => []) ?? [],
        compatibleProvider?.listModels?.().catch(() => []) ?? [],
      ]);
      const officialModels = listCodexOfficialModels();
      const cursorModels = cursorCatalogModels.map((model) => ({
        ...model,
        isDefault: model.id === cursorProvider?.descriptor.model,
      }));
      const companyProvider = ollamaProvider ?? compatibleProvider;
      const companyModels = ollamaProvider === undefined ? compatibleModels : ollamaModels;
      return {
        selection: workspace.active.configuration.modelSelection ?? {
          source: "official",
          model: "current",
        },
        official: officialModels,
        company: companyModels ?? [],
        hosts: {
          codex: {
            available: codexLogin.reusable,
            models: officialModels,
          },
          cursor: {
            available: cursorProvider !== undefined,
            models: cursorModels,
          },
          ollama: {
            available: ollamaProvider !== undefined,
            models: ollamaModels,
          },
          "openai-compatible": {
            available: compatibleProvider !== undefined,
            models: compatibleModels,
          },
        },
        companyConfigured: companyProvider !== undefined,
        companyProviderType:
          companyProvider?.descriptor.type === "ollama" ||
          companyProvider?.descriptor.type === "openai-compatible"
            ? companyProvider.descriptor.type
            : null,
      };
    });
    sendJson(response, 200, catalog);
    return;
  }

  const modelRoute = /^\/v1\/models\/([a-z0-9][a-z0-9-]{0,63})$/u.exec(pathname);
  if (request.method === "GET" && modelRoute !== null) {
    const requestId = randomUUID();
    const workspace = await storage.configurationStore.loadWorkspace();
    const virtualModel = createOpenAiModel(
      workspace.active.configuration,
      workspace.active.updatedAt,
    );
    const model = virtualModel.id === modelRoute[1] ? virtualModel : undefined;
    if (model === undefined) {
      sendOpenAiJson(
        response,
        404,
        createOpenAiError(
          "model_not_found",
          `The model '${modelRoute[1]}' is not available.`,
          "invalid_request_error",
          "model",
        ),
        requestId,
      );
      return;
    }
    sendOpenAiJson(response, 200, model, requestId);
    return;
  }

  const hostInferenceRoute =
    /^\/v1\/hosts\/(codex|cursor|ollama|openai-compatible)\/(chat\/completions|responses)$/u.exec(
      pathname,
    );
  const inferenceHost = hostInferenceRoute?.[1] as AgentHostId | undefined;
  const inferenceRoute = hostInferenceRoute?.[2];
  if (
    request.method === "POST" &&
    (pathname === "/v1/chat/completions" || inferenceRoute === "chat/completions")
  ) {
    if (!(await isExpertServiceEnabled(storage, "chatCompletionsApiEnabled"))) {
      sendJson(response, 404, { error: "SERVICE_DISABLED" });
      return;
    }
    await handleOpenAiInference(
      request,
      response,
      storage,
      "chat-completions",
      provider,
      agentKernel,
      inferenceHost,
    );
    return;
  }

  if (
    request.method === "POST" &&
    (pathname === "/v1/responses" || inferenceRoute === "responses")
  ) {
    if (!(await isExpertServiceEnabled(storage, "responsesApiEnabled"))) {
      sendJson(response, 404, { error: "SERVICE_DISABLED" });
      return;
    }
    await handleOpenAiInference(
      request,
      response,
      storage,
      "responses",
      provider,
      agentKernel,
      inferenceHost,
    );
    return;
  }

  const draftRoute = /^\/api\/configuration\/drafts\/(managed|expert)$/u.exec(pathname);
  if (request.method === "PUT" && draftRoute !== null) {
    try {
      validateMutationRequest(request);
      const mode = draftRoute[1] as ConfigurationMode;
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        throw new TiduError("CONFIGURATION_INVALID", "Request body must be an object.");
      }
      await storage.configurationStore.saveDraft({
        mode,
        expectedRevision: readExpectedRevision(body, "expectedRevision"),
        configuration: readDraftConfiguration(body, mode),
      });
      sendJson(
        response,
        200,
        await createConfigCenterBootstrap(
          storage,
          provider?.descriptor,
          undefined,
          enterprise,
          deployment,
          runtimeNetwork,
        ),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  const activationRoute = /^\/api\/configuration\/drafts\/(managed|expert)\/activate$/u.exec(
    pathname,
  );
  if (request.method === "POST" && activationRoute !== null) {
    try {
      validateMutationRequest(request);
      const mode = activationRoute[1] as ConfigurationMode;
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        throw new TiduError("CONFIGURATION_INVALID", "Request body must be an object.");
      }
      const activation = await activateConfigurationSafely(
        storage.configurationStore,
        mode,
        readExpectedRevision(body, "expectedDraftRevision"),
        async (configuration) => {
          if (configuration.activeMode !== mode || configuration.activeProfileId.trim() === "") {
            return false;
          }
          try {
            await refreshCodexModelCatalog();
            return true;
          } catch {
            return false;
          }
        },
      );
      if (activation.rolledBack) {
        sendJson(response, 422, {
          error: "CONFIGURATION_HEALTH_CHECK_FAILED",
          message: "Configuration failed its health probe and the known-good version was restored.",
        });
        return;
      }
      sendJson(
        response,
        200,
        await createConfigCenterBootstrap(
          storage,
          provider?.descriptor,
          undefined,
          enterprise,
          deployment,
          runtimeNetwork,
        ),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  const simulationRoute = /^\/api\/configuration\/drafts\/(managed|expert)\/simulate$/u.exec(
    pathname,
  );
  if (request.method === "POST" && simulationRoute !== null) {
    try {
      validateMutationRequest(request);
      const mode = simulationRoute[1] as ConfigurationMode;
      const body = await readJsonBody(request);
      if (!isRecord(body)) {
        throw new TiduError("CONFIGURATION_INVALID", "Request body must be an object.");
      }
      const workspace = await storage.configurationStore.loadWorkspace();
      const configuration = readDraftConfiguration(body, mode);
      sendJson(
        response,
        200,
        previewConfigurationImpact(workspace.active.configuration, configuration),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/configuration/rollback") {
    try {
      validateMutationRequest(request);
      await readJsonBody(request);
      await storage.configurationStore.rollbackActive();
      sendJson(
        response,
        200,
        await createConfigCenterBootstrap(
          storage,
          provider?.descriptor,
          undefined,
          enterprise,
          deployment,
          runtimeNetwork,
        ),
      );
    } catch (error) {
      handleConfigurationMutationError(response, error);
    }
    return;
  }

  const staticFile = request.method === "GET" ? resolveStaticFile(pathname) : undefined;
  if (staticFile !== undefined) {
    try {
      const content = await readFile(staticFile);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "cache-control": pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable",
        "content-type": STATIC_CONTENT_TYPES[extname(staticFile)] ?? "application/octet-stream",
      });
      response.end(content);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  sendJson(response, 404, { error: "NOT_FOUND" });
};

export const startLocalRuntime = async (
  options: LocalRuntimeOptions = {},
): Promise<LocalRuntime> => {
  const secretGate = options.secretGate ?? createSecretGate();
  const environmentEnterpriseRuntime =
    options.enterpriseControlPlane === undefined
      ? await createEnterpriseRuntimeFromEnvironment()
      : undefined;
  const enterpriseControlPlane =
    options.enterpriseControlPlane ?? environmentEnterpriseRuntime?.controlPlane;
  const deployment =
    options.deployment ??
    (options.enterpriseControlPlane === undefined ? "personal" : "enterprise");
  if (deployment === "enterprise" && enterpriseControlPlane === undefined) {
    throw new TiduError("CONFIGURATION_INVALID", "Enterprise edition requires TIDU_POSTGRES_URL.");
  }
  const providerSetting = process.env.TIDU_PROVIDER?.trim();
  const selectedProvider =
    options.provider ??
    (providerSetting === "codex-host"
      ? await createCodexHostModelProvider(process.env.TIDU_PROVIDER_MODEL)
      : providerSetting === "cursor-host"
        ? await createCursorHostModelProvider()
        : (createProviderFromEnvironment() ??
          (deployment === "personal" && options.discoverHostProvider !== false
            ? ((await createCodexHostModelProvider(process.env.TIDU_PROVIDER_MODEL)) ??
              (await createCursorHostModelProvider()))
            : undefined)));
  const officialProvider =
    options.provider === undefined &&
    selectedProvider !== undefined &&
    selectedProvider.descriptor.type !== "codex-host" &&
    selectedProvider.descriptor.type !== "cursor-host" &&
    deployment === "personal" &&
    options.discoverHostProvider !== false
      ? await createCodexHostModelProvider()
      : undefined;
  const configuredProvider =
    options.provider === undefined &&
    selectedProvider !== undefined &&
    selectedProvider.descriptor.type !== "codex-host" &&
    selectedProvider.descriptor.type !== "cursor-host"
      ? createCatalogModelRouter({
          defaultProvider: selectedProvider,
          officialProvider,
        })
      : selectedProvider;
  const hostProviderPromises = new Map<AgentHostId, Promise<ModelProvider | undefined>>();
  const registerHostProvider = (candidate: ModelProvider | undefined): void => {
    const host =
      candidate?.descriptor.type === "codex-host"
        ? "codex"
        : candidate?.descriptor.type === "cursor-host"
          ? "cursor"
          : candidate?.descriptor.type === "ollama"
            ? "ollama"
            : candidate?.descriptor.type === "openai-compatible"
              ? "openai-compatible"
              : undefined;
    if (host !== undefined) hostProviderPromises.set(host, Promise.resolve(candidate));
  };
  registerHostProvider(selectedProvider);
  registerHostProvider(officialProvider);
  const resolveProviderForHost = (host: AgentHostId): Promise<ModelProvider | undefined> => {
    const existing = hostProviderPromises.get(host);
    if (existing !== undefined) return existing;
    const discovered =
      host === "codex"
        ? createCodexHostModelProvider()
        : host === "cursor"
          ? createCursorHostModelProvider().then(
              async (provider) => provider ?? (await createCursorHostModelProvider()),
            )
          : host === "ollama"
            ? discoverOllamaModels({
                baseUrl:
                  process.env.TIDU_PROVIDER === "ollama"
                    ? process.env.TIDU_PROVIDER_BASE_URL
                    : undefined,
                timeoutMilliseconds: 750,
              })
                .then((models) =>
                  models[0] === undefined
                    ? undefined
                    : createOllamaProvider({
                        baseUrl:
                          process.env.TIDU_PROVIDER === "ollama"
                            ? (process.env.TIDU_PROVIDER_BASE_URL ?? "http://127.0.0.1:11434")
                            : "http://127.0.0.1:11434",
                        model: models[0],
                      }),
                )
                .catch(() => undefined)
            : Promise.resolve(undefined);
    hostProviderPromises.set(host, discovered);
    void discovered.then((candidate) => {
      if (candidate === undefined) hostProviderPromises.delete(host);
    });
    return discovered;
  };
  const getConnectedProviderForHost = (host: AgentHostId): Promise<ModelProvider | undefined> =>
    hostProviderPromises.get(host) ?? Promise.resolve(undefined);
  const getCatalogProviderForHost = (host: AgentHostId): Promise<ModelProvider | undefined> =>
    host === "cursor" || host === "ollama"
      ? resolveProviderForHost(host)
      : getConnectedProviderForHost(host);
  const scalingControlPlane =
    options.scalingControlPlane ?? environmentEnterpriseRuntime?.scalingControlPlane;
  const defaultDatabasePath = resolveDefaultDatabasePath();
  const enterpriseDatabasePath = join(
    dirname(defaultDatabasePath),
    basename(defaultDatabasePath).replace(/\.db$/u, "-enterprise.db"),
  );
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  try {
    storage = await openNodeSqliteStorage({
      databasePath:
        options.databasePath ?? (deployment === "enterprise" ? enterpriseDatabasePath : undefined),
    });
  } catch (error) {
    await configuredProvider?.close?.();
    await environmentEnterpriseRuntime?.close();
    throw error;
  }
  const capabilityCompletionProvider =
    configuredProvider === undefined
      ? undefined
      : createCapabilityCompletionProvider(
          configuredProvider,
          async () => {
            const configuration = (await storage.configurationStore.loadWorkspace()).active
              .configuration;
            return {
              modelSelection: configuration.modelSelection,
              capabilityCompletion: configuration.capabilityCompletion,
            };
          },
          { resolveProviderForHost },
        );
  const provider =
    capabilityCompletionProvider === undefined
      ? undefined
      : guardModelProvider(capabilityCompletionProvider, secretGate);
  const activeConfiguration = (await storage.configurationStore.loadWorkspace()).active
    .configuration;
  if (activeConfiguration.capabilityCompletion.enabled) {
    const configuredSpecialistHosts = new Set(
      [
        ...activeConfiguration.capabilityCompletion.specialists,
        ...Object.values(activeConfiguration.capabilityCompletion.hostPolicies ?? {}).flatMap(
          (policy) => policy.specialists,
        ),
      ].map((specialist) => specialist.host),
    );
    for (const specialistHost of configuredSpecialistHosts) {
      if (specialistHost === "cursor" || specialistHost === "ollama") {
        void (async () => {
          if ((await resolveProviderForHost(specialistHost)) === undefined) {
            await resolveProviderForHost(specialistHost);
          }
        })();
      }
    }
  }
  const activeExpertServices =
    activeConfiguration.activeMode === "expert" ? activeConfiguration.expertServices : undefined;
  const host = options.host ?? activeExpertServices?.host ?? DEFAULT_RUNTIME_HOST;
  const port = options.port ?? activeExpertServices?.port ?? DEFAULT_RUNTIME_PORT;
  const agentKernel =
    options.agentKernel ??
    (provider === undefined
      ? undefined
      : createAgentKernel({
          store: storage.taskCapsuleStore,
          secretGate,
          ...createModelProviderAgentAdapters(
            provider,
            async () =>
              (await storage.configurationStore.loadWorkspace()).active.configuration
                .activeProfileId,
          ),
        }));
  let runtimeDataLock: ReturnType<typeof acquireRuntimeDataLock>;
  try {
    runtimeDataLock = acquireRuntimeDataLock(storage.location);
  } catch (error) {
    storage.close();
    await provider?.close?.();
    await environmentEnterpriseRuntime?.close();
    throw error;
  }
  const runtimeNetwork = { host, port };
  const runtimeLogger = createRuntimeLogger(storage.location);
  const configuredRuntimePath = process.env.TIDU_RUNTIME_CONFIG_PATH?.trim();
  const configuredProxyPath = process.env.TIDU_NGINX_CONFIG_PATH?.trim();
  const runtimePaths = {
    configurationPath:
      configuredRuntimePath && configuredRuntimePath !== ""
        ? resolve(configuredRuntimePath)
        : storage.location,
    logLocation: runtimeLogger.location,
    proxyConfigurationPath:
      configuredProxyPath && configuredProxyPath !== "" ? resolve(configuredProxyPath) : null,
  };
  const refreshCodexModelCatalog =
    options.codexClientModelCatalogRefresh ??
    (process.env.NODE_TEST_CONTEXT !== undefined
      ? async () => undefined
      : async () => {
          await refreshCodexClientModelCatalog();
        });
  const server = createServer((request, response) => {
    const requestStartedAt = Date.now();
    const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
    response.once("finish", () => {
      runtimeLogger.write(
        `${request.method ?? "UNKNOWN"} ${requestPath} · ${response.statusCode} · ${Date.now() - requestStartedAt}ms`,
      );
    });
    void handleRequest(
      request,
      response,
      storage,
      provider,
      getCatalogProviderForHost,
      capabilityCompletionProvider,
      agentKernel,
      enterpriseControlPlane,
      scalingControlPlane,
      options.capabilityProviders ?? [],
      options.capabilityRuntime,
      deployment,
      runtimeNetwork,
      refreshCodexModelCatalog,
      runtimePaths,
    ).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "INTERNAL_ERROR" });
      } else {
        response.end();
      }
    });
  });

  try {
    await listen(server, host, port);
  } catch (error) {
    await runtimeLogger.close();
    storage.close();
    runtimeDataLock?.release();
    await provider?.close?.();
    await environmentEnterpriseRuntime?.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    await runtimeLogger.close();
    storage.close();
    await provider?.close?.();
    await environmentEnterpriseRuntime?.close();
    throw new Error("Local runtime did not expose a TCP address.");
  }

  runtimeNetwork.port = address.port;
  if (
    runtimeProcessKind() === "installed" ||
    process.env.TIDU_DEV_SUPPRESS_INITIAL_STATUS === "1"
  ) {
    runtimeLogger.write(`已就绪 · http://${host}:${address.port} · PID ${process.pid}`);
  }
  let isClosed = false;

  return {
    databasePath: storage.location,
    origin: `http://${host}:${address.port}`,
    close: async () => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      try {
        runtimeLogger.write(`停止中 · PID ${process.pid}`);
        if (deployment === "personal" && port !== 0) {
          await switchCodexClientConfiguration({ mode: "official" }).catch(() => undefined);
        }
        await close(server);
      } finally {
        await runtimeLogger.close();
        storage.close();
        runtimeDataLock?.release();
        await provider?.close?.();
        await environmentEnterpriseRuntime?.close();
      }
    },
  };
};

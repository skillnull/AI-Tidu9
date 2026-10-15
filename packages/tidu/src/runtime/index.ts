import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { inspectCodexHostLogin } from "../accounts/codex-host.js";
import { inspectCursorHostLogin, reloginCursorHost } from "../accounts/cursor-host.js";
import {
  type AgentKernel,
  type CreateAgentTaskInput,
  createAgentKernel,
  createTaskControlView,
} from "../agent/index.js";
import { createModelProviderAgentAdapters } from "../agent/model-provider.js";
import {
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
  createProviderFromEnvironment,
  discoverOllamaModels,
  type ModelProvider,
} from "../providers/index.js";
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
const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;
const MAXIMUM_INFERENCE_JSON_BODY_BYTES = 4 * 1024 * 1024;
const ENTERPRISE_DISCOVERY_TIMEOUT_MS = 5_000;

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

const handleOpenAiInference = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  storage: StorageAdapter,
  protocol: "chat-completions" | "responses",
  provider: ModelProvider | undefined,
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
  const activeModelId = workspace.active.configuration.activeProfileId;
  const validation =
    protocol === "chat-completions"
      ? validateChatCompletionRequest(body, activeModelId)
      : validateResponsesRequest(body, activeModelId);
  if (sendOpenAiValidation(response, validation, requestId)) {
    return;
  }
  if (provider !== undefined) {
    const controller = new AbortController();
    const abortProvider = () => controller.abort();
    request.once("aborted", abortProvider);
    response.once("close", abortProvider);
    try {
      const result = await provider.execute({
        protocol,
        body: body as Record<string, unknown>,
        virtualModelId: activeModelId,
        signal: controller.signal,
      });
      if (result.kind === "stream") {
        await sendOpenAiStream(response, result.statusCode, result.stream, requestId);
      } else {
        sendOpenAiJson(response, result.statusCode, result.body, requestId);
      }
    } catch {
      if (!response.headersSent) {
        sendOpenAiJson(
          response,
          502,
          createOpenAiError(
            "provider_request_failed",
            "The configured provider could not complete the request.",
            "server_error",
          ),
          requestId,
        );
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
      "The virtual model is available, but no model provider is configured yet.",
      "server_error",
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

  const configuration: TiduConfiguration = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeMode: mode,
    activeProfileId: candidate.activeProfileId,
    virtualModelName: candidate.virtualModelName,
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
  throw error;
};

const handleRequest = async (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  storage: StorageAdapter,
  provider: ModelProvider | undefined,
  agentKernel: AgentKernel | undefined,
  enterprise: EnterpriseControlPlane | undefined,
  scaling: ScalingControlPlane | undefined,
  capabilityProviders: readonly CapabilityProviderImplementation[],
  capabilityRuntime: CapabilityRuntime | undefined,
  deployment: "personal" | "enterprise",
  runtimeNetwork: { host: string; port: number },
): Promise<void> => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/health") {
    const scalingHealth = await scaling?.health();
    sendJson(response, scalingHealth?.status === "unavailable" ? 503 : 200, {
      product: PRODUCT.name,
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
      sendJson(response, 404, { error: "SCALING_CONTROL_PLANE_NOT_CONFIGURED" });
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
      sendJson(response, 404, { error: "SCALING_CONTROL_PLANE_NOT_CONFIGURED" });
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
    const codex = await inspectCodexHostAccountReport().catch(() => null);
    const cursor = inspectCursorHostLogin();
    const cursorProvider = cursor.reusable
      ? await createCursorHostModelProvider().catch(() => undefined)
      : undefined;
    sendJson(response, 200, {
      activeProvider: provider?.descriptor ?? null,
      codex,
      cursor: {
        agentStatus: cursor.status,
        agentProtocolAvailable: cursor.acpAvailable,
        accountEmail: cursor.accountEmail ?? null,
        accountPlan: cursor.accountPlan ?? null,
        model: cursorProvider?.descriptor.model ?? null,
      },
    });
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
      const report = setupConnectors({ action: "install", endpoint, targets: ["codex"] });
      const codex = report.connectors[0];
      sendJson(response, report.healthy ? 200 : 409, {
        connected: report.healthy,
        message: codex?.detail ?? "Codex connector registration did not return a result.",
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
        sendJson(response, 422, { detected: false, reason: "unknown-provider" });
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
      } else if (provider?.descriptor.type === selected) {
        discoveredModel = provider.descriptor.model;
      } else {
        reason = "compatible-provider-not-active";
      }

      const detected = discoveredModel !== undefined;
      const matchesRuntime = detected && provider?.descriptor.type === selected;
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
      sendJson(response, 404, { error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED" });
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
      sendJson(response, 404, { error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED" });
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
      sendJson(response, 404, { error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED" });
      return;
    }
    let generated: Awaited<ReturnType<EnterpriseControlPlane["initializeAdministratorKey"]>>;
    try {
      generated = await enterprise.initializeAdministratorKey();
    } catch (error) {
      if (error instanceof Error && error.message.includes("already initialized")) {
        sendJson(response, 409, { error: "ADMINISTRATOR_KEY_ALREADY_INITIALIZED" });
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
      sendJson(response, 404, { error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED" });
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
      sendJson(response, 404, { error: "ENTERPRISE_CONTROL_PLANE_NOT_CONFIGURED" });
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
    const model = createOpenAiModel(workspace.active.configuration, workspace.active.updatedAt);
    sendOpenAiJson(response, 200, { object: "list", data: [model] }, randomUUID());
    return;
  }

  const modelRoute = /^\/v1\/models\/([a-z0-9][a-z0-9-]{0,63})$/u.exec(pathname);
  if (request.method === "GET" && modelRoute !== null) {
    const requestId = randomUUID();
    const workspace = await storage.configurationStore.loadWorkspace();
    const model = createOpenAiModel(workspace.active.configuration, workspace.active.updatedAt);
    if (modelRoute[1] !== model.id) {
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

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    if (!(await isExpertServiceEnabled(storage, "chatCompletionsApiEnabled"))) {
      sendJson(response, 404, { error: "SERVICE_DISABLED" });
      return;
    }
    await handleOpenAiInference(request, response, storage, "chat-completions", provider);
    return;
  }

  if (request.method === "POST" && pathname === "/v1/responses") {
    if (!(await isExpertServiceEnabled(storage, "responsesApiEnabled"))) {
      sendJson(response, 404, { error: "SERVICE_DISABLED" });
      return;
    }
    await handleOpenAiInference(request, response, storage, "responses", provider);
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
        async (configuration) =>
          configuration.activeMode === mode && configuration.activeProfileId.trim() !== "",
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
  const configuredProvider =
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
  const provider =
    configuredProvider === undefined
      ? undefined
      : guardModelProvider(configuredProvider, secretGate);
  const scalingControlPlane =
    options.scalingControlPlane ?? environmentEnterpriseRuntime?.scalingControlPlane;
  const defaultDatabasePath = resolveDefaultDatabasePath();
  const enterpriseDatabasePath = join(
    dirname(defaultDatabasePath),
    basename(defaultDatabasePath).replace(/\.db$/u, "-enterprise.db"),
  );
  const storage = await openNodeSqliteStorage({
    databasePath:
      options.databasePath ?? (deployment === "enterprise" ? enterpriseDatabasePath : undefined),
  });
  const activeConfiguration = (await storage.configurationStore.loadWorkspace()).active
    .configuration;
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
    await environmentEnterpriseRuntime?.close();
    throw error;
  }
  const runtimeNetwork = { host, port };
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      storage,
      provider,
      agentKernel,
      enterpriseControlPlane,
      scalingControlPlane,
      options.capabilityProviders ?? [],
      options.capabilityRuntime,
      deployment,
      runtimeNetwork,
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
    storage.close();
    runtimeDataLock?.release();
    await environmentEnterpriseRuntime?.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    storage.close();
    await environmentEnterpriseRuntime?.close();
    throw new Error("Local runtime did not expose a TCP address.");
  }

  runtimeNetwork.port = address.port;
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
        await close(server);
      } finally {
        storage.close();
        runtimeDataLock?.release();
        await environmentEnterpriseRuntime?.close();
      }
    },
  };
};

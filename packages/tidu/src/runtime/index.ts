import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
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
import { PRODUCT, TiduError } from "../core/index.js";
import { acquireRuntimeDataLock } from "../lifecycle/index.js";
import {
  createOpenAiError,
  createOpenAiModel,
  type OpenAiRequestValidation,
  validateChatCompletionRequest,
  validateResponsesRequest,
} from "../openai/index.js";
import { createProviderFromEnvironment, type ModelProvider } from "../providers/index.js";
import { openNodeSqliteStorage, type StorageAdapter } from "../storage/index.js";

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

export interface LocalRuntimeOptions {
  /** Loopback host used by the personal runtime. */
  host?: string;
  /** TCP port used by the personal runtime; use zero to allocate a test port. */
  port?: number;
  /** SQLite file path; omit it to use the platform default. */
  databasePath?: string;
  /** Explicit provider adapter; omit it to resolve runtime environment configuration. */
  provider?: ModelProvider;
  /** Optional autonomous Agent kernel exposed through the local task-control API. */
  agentKernel?: AgentKernel;
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

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeMode: mode,
    activeProfileId: candidate.activeProfileId,
    virtualModelName: candidate.virtualModelName,
  };
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
): Promise<void> => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      product: PRODUCT.name,
      status: "ok",
      storage: {
        provider: storage.provider,
        schemaVersion: storage.schemaVersion,
        status: "ok",
      },
      version: PRODUCT.version,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/config-center") {
    sendJson(response, 200, await createConfigCenterBootstrap(storage, provider?.descriptor));
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
    await handleOpenAiInference(request, response, storage, "chat-completions", provider);
    return;
  }

  if (request.method === "POST" && pathname === "/v1/responses") {
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
      sendJson(response, 200, await createConfigCenterBootstrap(storage, provider?.descriptor));
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
      await storage.configurationStore.activateDraft(
        mode,
        readExpectedRevision(body, "expectedDraftRevision"),
      );
      sendJson(response, 200, await createConfigCenterBootstrap(storage, provider?.descriptor));
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
  const host = options.host ?? DEFAULT_RUNTIME_HOST;
  const port = options.port ?? DEFAULT_RUNTIME_PORT;
  const provider = options.provider ?? createProviderFromEnvironment();
  const storage = await openNodeSqliteStorage({
    databasePath: options.databasePath,
  });
  const agentKernel =
    options.agentKernel ??
    (provider === undefined
      ? undefined
      : createAgentKernel({
          store: storage.taskCapsuleStore,
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
    throw error;
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, storage, provider, agentKernel).catch(() => {
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
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await close(server);
    storage.close();
    throw new Error("Local runtime did not expose a TCP address.");
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
        await close(server);
      } finally {
        storage.close();
        runtimeDataLock?.release();
      }
    },
  };
};

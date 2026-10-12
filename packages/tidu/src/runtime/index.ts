import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_SCHEMA_VERSION,
  type ConfigurationMode,
  type TiduConfiguration,
} from "../config/index.js";
import { createConfigCenterBootstrap } from "../config-center/index.js";
import { PRODUCT, TiduError } from "../core/index.js";
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

export interface LocalRuntimeOptions {
  /** Loopback host used by the personal runtime. */
  host?: string;
  /** TCP port used by the personal runtime; use zero to allocate a test port. */
  port?: number;
  /** SQLite file path; omit it to use the platform default. */
  databasePath?: string;
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
): void => {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
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

const readJsonBody = async (request: import("node:http").IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > MAXIMUM_JSON_BODY_BYTES) {
      throw new TiduError("CONFIGURATION_INVALID", "Request body exceeds 64 KiB.");
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    sendJson(response, 200, await createConfigCenterBootstrap(storage));
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
      sendJson(response, 200, await createConfigCenterBootstrap(storage));
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
      sendJson(response, 200, await createConfigCenterBootstrap(storage));
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
  const storage = await openNodeSqliteStorage({ databasePath: options.databasePath });
  const server = createServer((request, response) => {
    void handleRequest(request, response, storage).catch(() => {
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
      }
    },
  };
};

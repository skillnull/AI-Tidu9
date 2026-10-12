import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfigCenterBootstrap } from "../config-center/index.js";
import { PRODUCT } from "../core/index.js";
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
    sendJson(response, 200, createConfigCenterBootstrap(storage));
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

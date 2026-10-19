import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as createHttpRequest, createServer as createHttpServer } from "node:http";
import { connect as createNetConnection, createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../packages/tidu/", import.meta.url));
const productVersion = JSON.parse(
  readFileSync(join(workspaceRoot, "package.json"), "utf8"),
).version;
const developmentStartedAt = Date.now();
const defaultPublicPort = 9639;
const edition = process.env.TIDU_DEV_EDITION ?? "personal";
const editionSuffix = edition === "enterprise" ? "e" : "p";
const publicPortSetting = process.env.TIDU_PORT?.trim();
const configuredPublicPort =
  publicPortSetting === undefined ? undefined : Number(publicPortSetting);
const databasePath =
  process.env.TIDU_DATABASE_PATH ??
  join(repositoryRoot, ".tidu-dev", edition === "enterprise" ? "enterprise.sqlite" : "tidu.sqlite");

if (edition !== "personal" && edition !== "enterprise") {
  process.stderr.write("TIDU_DEV_EDITION must be personal or enterprise.\n");
  process.exit(1);
}

if (
  configuredPublicPort !== undefined &&
  (!Number.isInteger(configuredPublicPort) ||
    configuredPublicPort < 1 ||
    configuredPublicPort > 65_535)
) {
  process.stderr.write("TIDU_PORT must be an integer from 1 to 65535 for local development.\n");
  process.exit(1);
}

const publicPort = configuredPublicPort ?? defaultPublicPort;
const installedDataDirectory =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "AI-Tidu9")
    : process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local"),
          "AI-Tidu9",
        )
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-tidu9");
const installedLockPath = join(installedDataDirectory, ".runtime.lock");
if (existsSync(installedLockPath)) {
  try {
    const lock = JSON.parse(readFileSync(installedLockPath, "utf8"));
    if (Number.isInteger(lock?.processId)) {
      process.kill(lock.processId, 0);
      process.stderr.write(
        "检测到正在运行的本地安装版九门服务。\n请先运行 tidu service stop && tidu uninstall --confirm DELETE，再执行 npm run tidu:dev-p。\n",
      );
      process.exit(1);
    }
  } catch {
    // Ignore stale or incomplete installed-runtime locks; the runtime validates its own lock.
  }
}
for (const candidatePort of new Set([publicPort, defaultPublicPort])) {
  try {
    const existingResponse = await fetch(`http://127.0.0.1:${candidatePort}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (existingResponse.ok) {
      const existingHealth = await existingResponse.json();
      if (existingHealth?.product === "九门赛博提督") {
        const command =
          existingHealth.runtimeMode === "development"
            ? "请先停止当前 npm run tidu:dev-p 进程，再重新启动。"
            : "请先运行 tidu service stop && tidu uninstall --confirm DELETE，再执行 npm run tidu:dev-p。";
        process.stderr.write(`检测到冲突的九门服务正在占用 ${candidatePort} 端口。\n${command}\n`);
        process.exit(1);
      }
    }
  } catch {
    // Continue when no healthy AI-Tidu9 service responds on this candidate port.
  }
}
const internalRuntimePort = await new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Unable to allocate the internal development runtime port."));
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address.port);
    });
  });
});
const internalFrontendPort = await new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Unable to allocate the internal development frontend port."));
      return;
    }
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

const enterprisePostgresqlGuide = (postgresDetected) => `
企业版本地开发需要 PostgreSQL。
Local enterprise development requires PostgreSQL.

启动项目提供的 PostgreSQL 容器 / Start the project PostgreSQL container
  1. export TIDU_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  2. docker compose -f config/docker/compose.yml -f config/docker/compose.dev.yml up -d postgres
  3. export TIDU_POSTGRES_URL="postgresql://tidu:\${TIDU_POSTGRES_PASSWORD}@127.0.0.1:5432/tidu"
  4. npm run tidu:dev-e

${postgresDetected ? "已发现本机 PostgreSQL 服务，但仍需设置 TIDU_POSTGRES_URL。" : "未发现已就绪的本机 PostgreSQL 服务。"}
`;

const verifyEnterprisePostgresql = async () => {
  const connectionString = process.env.TIDU_POSTGRES_URL?.trim();
  const readiness = spawnSync("pg_isready", ["-q"], { stdio: "ignore" });
  const postgresDetected = readiness.status === 0;
  if (!connectionString) {
    process.stderr.write(enterprisePostgresqlGuide(postgresDetected));
    process.exit(1);
  }

  let connectionUrl;
  try {
    connectionUrl = new URL(connectionString);
  } catch {
    process.stderr.write(
      `TIDU_POSTGRES_URL is not a valid PostgreSQL URL.\n${enterprisePostgresqlGuide(postgresDetected)}`,
    );
    process.exit(1);
  }
  if (connectionUrl.protocol !== "postgres:" && connectionUrl.protocol !== "postgresql:") {
    process.stderr.write(
      `TIDU_POSTGRES_URL must use postgres:// or postgresql://.\n${enterprisePostgresqlGuide(postgresDetected)}`,
    );
    process.exit(1);
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    max: 1,
    ssl: process.env.TIDU_POSTGRES_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  });
  try {
    await pool.query("SELECT current_database() AS database_name");
    process.stdout.write("PostgreSQL 检查通过，正在启动企业版开发运行时。\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown connection error";
    process.stderr.write(
      `PostgreSQL preflight failed: ${reason}\n${enterprisePostgresqlGuide(postgresDetected)}`,
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
};

if (edition === "enterprise") {
  await verifyEnterprisePostgresql();
}

const backendBuild = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "packages/tidu/tsconfig.build.json"],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
  },
);

if (backendBuild.status !== 0) {
  process.exit(backendBuild.status ?? 1);
}

const spawnRuntimeProcess = () =>
  spawn(
    join(repositoryRoot, "node_modules/.bin/tsx"),
    ["watch", "packages/tidu/src/cli/index.ts", "start", "--edition", edition],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        TIDU_CONNECTOR_CLI_ENTRY: join(repositoryRoot, "packages/tidu/dist/cli/launcher.js"),
        TIDU_DATABASE_PATH: databasePath,
        TIDU_DEV_SILENT: "1",
        TIDU_HOST: process.env.TIDU_HOST ?? "127.0.0.1",
        TIDU_PORT: String(internalRuntimePort),
      },
      stdio: "inherit",
    },
  );
let runtimeProcess = spawnRuntimeProcess();
let frontendProcess;
const spawnCliServiceProcess = () =>
  spawn(
    process.execPath,
    [
      "-e",
      "process.title='ai-tidu9-cli-service';const timer=setInterval(()=>{},2147483647);const stop=()=>{clearInterval(timer);process.exit(0)};process.once('SIGINT',stop);process.once('SIGTERM',stop)",
    ],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
let cliServiceProcess = spawnCliServiceProcess();
const processIsRunning = (childProcess) =>
  childProcess !== undefined && childProcess.exitCode === null && childProcess.signalCode === null;

let runtimeReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${internalRuntimePort}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) {
      runtimeReady = true;
      break;
    }
  } catch {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

if (!runtimeReady) {
  runtimeProcess.kill("SIGTERM");
  cliServiceProcess.kill("SIGTERM");
  process.stderr.write("Development runtime did not become ready within 10 seconds.\n");
  process.exit(1);
}

const intentionallyStoppedProcesses = new WeakSet();
let registerManagedProcess = () => undefined;
const createDevelopmentInventory = async () => {
  const runtimeRunning = processIsRunning(runtimeProcess);
  const frontendRunning = processIsRunning(frontendProcess);
  const cliRunning = processIsRunning(cliServiceProcess);
  let runtimeHealth;
  let upstreamCatalog;
  if (runtimeRunning) {
    [runtimeHealth, upstreamCatalog] = await Promise.all([
      fetch(`http://127.0.0.1:${internalRuntimePort}/health`, {
        signal: AbortSignal.timeout(800),
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined),
      fetch(`http://127.0.0.1:${internalRuntimePort}/api/models/upstreams`, {
        signal: AbortSignal.timeout(800),
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined),
    ]);
  }
  const selection = upstreamCatalog?.selection;
  const providerStatus = selection ? `${selection.source}:${selection.model}` : "not-configured";
  return {
    checkedAt: new Date().toISOString(),
    environment: {
      activeModel: providerStatus,
      endpoint: `http://127.0.0.1:${publicPort}`,
      nodeVersion: process.version,
      platform: process.platform,
      providerType: selection?.source ?? "not-configured",
      storage: runtimeHealth?.storage
        ? `${runtimeHealth.storage.provider} · schema ${runtimeHealth.storage.schemaVersion}`
        : "unavailable",
      uptimeSeconds: Math.floor((Date.now() - developmentStartedAt) / 1000),
      version: productVersion,
    },
    mode: "development",
    diagnostics: [
      {
        id: "process",
        status: runtimeRunning ? "passed" : "warning",
        message: runtimeRunning ? `PID ${runtimeProcess.pid}` : "Runtime process is stopped",
      },
      {
        id: "network",
        status: runtimeHealth?.status === "ok" ? "passed" : "warning",
        message:
          runtimeHealth?.status === "ok"
            ? `Public ${publicPort} · internal ${internalRuntimePort}`
            : "Runtime health endpoint is unavailable",
      },
      {
        id: "storage",
        status: runtimeHealth?.storage?.status === "ok" ? "passed" : "warning",
        message: runtimeHealth?.storage
          ? `${runtimeHealth.storage.provider} · schema ${runtimeHealth.storage.schemaVersion}`
          : "Storage status is unavailable",
      },
      {
        id: "provider",
        status: selection ? "passed" : "warning",
        message: selection ? providerStatus : "Model selection is unavailable",
      },
    ],
    services: [
      {
        id: `tidu:dev-frontend-${editionSuffix}`,
        name: "前端开发服务",
        kind: "frontend",
        lifecycle: "managed",
        status: frontendRunning ? "running" : "stopped",
        processId: frontendRunning ? (frontendProcess?.pid ?? null) : null,
        command: `npm run tidu:dev-frontend-${editionSuffix}`,
        endpoint: `http://127.0.0.1:${publicPort}`,
        version: productVersion,
        actions: ["refresh", "start", "restart", "stop"],
      },
      {
        id: `tidu:dev-cli-${editionSuffix}`,
        name: "CLI 服务",
        kind: "cli",
        lifecycle: "managed",
        status: cliRunning ? "running" : "stopped",
        processId: cliRunning ? (cliServiceProcess.pid ?? null) : null,
        command: `npm run tidu:dev-cli-${editionSuffix}`,
        endpoint: `http://127.0.0.1:${publicPort}`,
        version: productVersion,
        actions: ["refresh", "start", "restart", "stop"],
      },
      {
        id: `tidu:dev-api-${editionSuffix}`,
        name: "接口服务",
        kind: "api",
        lifecycle: "managed",
        status: runtimeRunning ? "running" : "stopped",
        processId: runtimeRunning ? (runtimeProcess.pid ?? null) : null,
        command: `npm run tidu:dev-api-${editionSuffix}`,
        endpoint: `http://127.0.0.1:${publicPort}/api`,
        version: productVersion,
        actions: ["refresh", "start", "restart", "stop"],
      },
    ],
  };
};

const proxyRequest = (request, response, targetPort) => {
  const upstreamRequest = createHttpRequest(
    {
      headers: request.headers,
      host: "127.0.0.1",
      method: request.method,
      path: request.url,
      port: targetPort,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequest.once("error", () => {
    if (!response.headersSent) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    }
    response.end('{"error":"SERVICE_UNAVAILABLE"}\n');
  });
  request.pipe(upstreamRequest);
};

const handleManagerRequest = async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const sendJson = (statusCode, body) => {
    response.writeHead(statusCode, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify(body)}\n`);
  };
  if (request.method === "GET" && pathname === "/api/services") {
    sendJson(200, await createDevelopmentInventory());
    return;
  }
  const actionRoute = /^\/api\/services\/([^/]+)\/(refresh|start|stop|restart)$/u.exec(pathname);
  if (request.method !== "POST" || actionRoute === null) {
    const apiRequest =
      pathname === "/health" || pathname.startsWith("/api/") || pathname.startsWith("/v1/");
    const targetProcess = apiRequest ? runtimeProcess : frontendProcess;
    if (!processIsRunning(targetProcess)) {
      sendJson(503, { error: "SERVICE_UNAVAILABLE" });
      return;
    }
    proxyRequest(request, response, apiRequest ? internalRuntimePort : internalFrontendPort);
    return;
  }
  const serviceId = decodeURIComponent(actionRoute[1] ?? "");
  const action = actionRoute[2];
  const serviceProcesses = {
    [`tidu:dev-api-${editionSuffix}`]: {
      get: () => runtimeProcess,
      set: (childProcess) => {
        runtimeProcess = childProcess;
      },
      spawn: spawnRuntimeProcess,
    },
    [`tidu:dev-cli-${editionSuffix}`]: {
      get: () => cliServiceProcess,
      set: (childProcess) => {
        cliServiceProcess = childProcess;
      },
      spawn: spawnCliServiceProcess,
    },
    [`tidu:dev-frontend-${editionSuffix}`]: {
      get: () => frontendProcess,
      set: (childProcess) => {
        frontendProcess = childProcess;
      },
      spawn: () => spawnFrontendProcess(),
    },
  };
  const managedService = serviceProcesses[serviceId];
  if (managedService === undefined) {
    sendJson(404, { error: "SERVICE_NOT_FOUND" });
    return;
  }
  if (action === "refresh") {
    sendJson(200, { accepted: true, action, serviceId });
    return;
  }
  const activeProcess = managedService.get();
  if (action === "start" && processIsRunning(activeProcess)) {
    sendJson(409, { error: "SERVICE_ALREADY_RUNNING" });
    return;
  }
  if (action === "start") {
    const childProcess = managedService.spawn();
    managedService.set(childProcess);
    registerManagedProcess(childProcess);
    sendJson(202, { accepted: true, action, serviceId });
    return;
  }
  sendJson(202, { accepted: true, action, serviceId });
  if (activeProcess !== undefined) {
    intentionallyStoppedProcesses.add(activeProcess);
    activeProcess.kill("SIGTERM");
  }
  if (action === "restart") {
    setTimeout(() => {
      const childProcess = managedService.spawn();
      managedService.set(childProcess);
      registerManagedProcess(childProcess);
    }, 500);
  }
};
const managerServer = createHttpServer((request, response) => {
  void handleManagerRequest(request, response);
});
managerServer.on("upgrade", (request, socket, head) => {
  if (!processIsRunning(frontendProcess)) {
    socket.destroy();
    return;
  }
  const upstreamSocket = createNetConnection(internalFrontendPort, "127.0.0.1", () => {
    const headerLines = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headerLines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstreamSocket.write(
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`,
    );
    if (head.length > 0) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstreamSocket.once("error", () => socket.destroy());
});
await new Promise((resolve, reject) => {
  managerServer.once("error", reject);
  managerServer.listen(publicPort, "127.0.0.1", () => {
    managerServer.off("error", reject);
    resolve();
  });
});

const typeCheckerProcess = spawn(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "-p",
    "packages/tidu/tsconfig.json",
    "--watch",
    "--preserveWatchOutput",
    "--pretty",
    "false",
  ],
  { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] },
);

if (typeCheckerProcess.stdout !== null) {
  const typeCheckerOutput = createInterface({ input: typeCheckerProcess.stdout });
  typeCheckerOutput.on("line", (line) => {
    const message = line.replace(/^\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*-\s*/u, "").trim();
    if (
      message === "" ||
      message === "Starting compilation in watch mode..." ||
      message === "File change detected. Starting incremental compilation..."
    ) {
      return;
    }
    const summary = message.match(/^Found (\d+) errors?\. Watching for file changes\.$/u);
    if (summary !== null) {
      const errorCount = Number(summary[1]);
      process.stdout.write(
        errorCount === 0 ? "✓ TS 通过 · 监听中\n" : `✗ TS ${errorCount} 个错误 · 监听中\n`,
      );
      return;
    }
    process.stdout.write(`${message}\n`);
  });
}

const spawnFrontendProcess = () =>
  spawn(
    "../../node_modules/.bin/vite",
    ["--host", "127.0.0.1", "--port", String(internalFrontendPort)],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        TIDU_RUNTIME_PORT: String(internalRuntimePort),
      },
      stdio: "inherit",
    },
  );
frontendProcess = spawnFrontendProcess();

const processes = [
  runtimeProcess,
  spawn(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/tidu/tsconfig.build.json",
      "--watch",
      "--preserveWatchOutput",
    ],
    { cwd: repositoryRoot, stdio: "ignore" },
  ),
  typeCheckerProcess,
  frontendProcess,
  cliServiceProcess,
];

let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const childProcess of processes) {
    if (processIsRunning(childProcess)) {
      childProcess.kill(signal);
    }
  }
  managerServer.close();
};

process.once("SIGINT", () => stop("SIGTERM"));
process.once("SIGTERM", () => stop("SIGTERM"));

const registerProcess = (childProcess) => {
  childProcess.once("error", (error) => {
    process.stderr.write(`Development process failed to start: ${error.message}\n`);
    stop();
    process.exitCode = 1;
  });
  childProcess.once("exit", (code, signal) => {
    if (intentionallyStoppedProcesses.has(childProcess)) {
      return;
    }
    if (!stopping) {
      process.stderr.write(
        `Development process stopped (${signal ?? code ?? "unknown status"}); stopping the other processes.\n`,
      );
      process.exitCode = code ?? 1;
      stop();
    }
  });
};
for (const childProcess of processes) registerProcess(childProcess);
registerManagedProcess = (childProcess) => {
  processes.push(childProcess);
  registerProcess(childProcess);
};

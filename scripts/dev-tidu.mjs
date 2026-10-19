import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const paths = {
  repository: fileURLToPath(new URL("../", import.meta.url)),
  workspace: fileURLToPath(new URL("../packages/tidu/", import.meta.url)),
};
const edition = process.env.TIDU_DEV_EDITION === "enterprise" ? "enterprise" : "personal";
const editionSuffix = edition === "enterprise" ? "e" : "p";
const requestedServiceIndex = process.argv.indexOf("--service");
const requestedService =
  requestedServiceIndex === -1 ? "controller" : (process.argv[requestedServiceIndex + 1] ?? "");
const startAllServices = process.argv.includes("--start-all");
const startFrontend = startAllServices || process.argv.includes("--start-frontend");
const validServices = new Set(["api", "controller", "frontend"]);
if (!validServices.has(requestedService)) {
  process.stderr.write("--service must be frontend, controller, or api.\n");
  process.exit(1);
}

const defaultPorts =
  edition === "enterprise"
    ? { api: 9740, control: 9741, frontend: 9739 }
    : { api: 9640, control: 9641, frontend: 9639 };
const parsePort = (setting, fallback, name) => {
  if (setting === undefined || setting.trim() === "") return fallback;
  const port = Number(setting);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write(`${name} must be an integer from 1 to 65535.\n`);
    process.exit(1);
  }
  return port;
};
const ports = {
  api: parsePort(process.env.TIDU_API_PORT, defaultPorts.api, "TIDU_API_PORT"),
  control: parsePort(
    process.env.TIDU_CONTROL_PORT ?? process.env.TIDU_CLI_PORT,
    defaultPorts.control,
    "TIDU_CONTROL_PORT",
  ),
  frontend: parsePort(process.env.TIDU_PORT, defaultPorts.frontend, "TIDU_PORT"),
};
const productVersion = JSON.parse(
  readFileSync(join(paths.workspace, "package.json"), "utf8"),
).version;
const runtimeDirectory = join(paths.repository, ".tidu-dev", "services");
const databasePath =
  process.env.TIDU_DATABASE_PATH ??
  join(
    paths.repository,
    ".tidu-dev",
    edition === "enterprise" ? "enterprise.sqlite" : "tidu.sqlite",
  );
const serviceIds = {
  api: `tidu:dev-api-${editionSuffix}`,
  frontend: `tidu:dev-${editionSuffix}`,
};
const commands = {
  api: `npm run tidu:dev-api-${editionSuffix}`,
  frontend: `npm run tidu:dev-${editionSuffix}`,
};
const pidPaths = {
  api: join(runtimeDirectory, `api-${editionSuffix}.pid`),
  controller: join(runtimeDirectory, `controller-${editionSuffix}.pid`),
  frontend: join(runtimeDirectory, `frontend-${editionSuffix}.pid`),
};
const supervisorPidPaths = {
  api: join(runtimeDirectory, `api-${editionSuffix}.supervisor.pid`),
  frontend: join(runtimeDirectory, `frontend-${editionSuffix}.supervisor.pid`),
};

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

const processIsRunning = (processId) => {
  if (!Number.isInteger(processId) || processId < 1) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const readProcessId = (pidPath) => {
  if (!existsSync(pidPath)) return null;
  const processId = Number(readFileSync(pidPath, "utf8").trim());
  if (processIsRunning(processId)) return processId;
  rmSync(pidPath, { force: true });
  return null;
};

const readServiceProcessId = (service) => readProcessId(pidPaths[service]);

const readSupervisorProcessId = (service) => readProcessId(supervisorPidPaths[service]);

const writeServiceProcessId = (service, processId = process.pid) => {
  mkdirSync(runtimeDirectory, { recursive: true });
  writeFileSync(pidPaths[service], `${processId}\n`, { mode: 0o600 });
};

const writeSupervisorProcessId = (service) => {
  mkdirSync(runtimeDirectory, { recursive: true });
  writeFileSync(supervisorPidPaths[service], `${process.pid}\n`, {
    mode: 0o600,
  });
};

const removeServiceProcessId = (service, expectedProcessId = process.pid) => {
  const storedProcessId = readServiceProcessId(service);
  if (storedProcessId === expectedProcessId || storedProcessId === null) {
    rmSync(pidPaths[service], { force: true });
  }
};

const removeSupervisorProcessId = (service) => {
  const storedProcessId = readSupervisorProcessId(service);
  if (storedProcessId === process.pid || storedProcessId === null) {
    rmSync(supervisorPidPaths[service], { force: true });
  }
};

const assertInstalledRuntimeIsStopped = () => {
  if (!existsSync(installedLockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(installedLockPath, "utf8"));
    if (processIsRunning(lock?.processId)) {
      process.stderr.write(
        "检测到正在运行的安装版九门接口服务。请先停止安装版服务，再启动仓库开发服务。\n",
      );
      process.exit(1);
    }
  } catch {
    // The runtime owns validation and cleanup of stale lock files.
  }
};

const assertServiceIsNotRunning = (service) => {
  const processId = readServiceProcessId(service) ?? readSupervisorProcessId(service);
  if (processId !== null) {
    const serviceName = serviceIds[service] ?? "development controller";
    process.stderr.write(`${serviceName} is already running with PID ${processId}.\n`);
    process.exit(1);
  }
};

const serviceDetails = {
  api: { label: "接口服务", endpoint: `http://127.0.0.1:${ports.api}` },
  frontend: {
    label: "前端服务",
    endpoint: `http://127.0.0.1:${ports.frontend}`,
  },
};

const printServiceStarted = (service, processId, restarted) => {
  const details = serviceDetails[service];
  process.stdout.write(
    [
      `\n[AI-TIDU9] ${details.label}${restarted ? "已重启" : "已启动"}`,
      `  状态  运行中`,
      `  地址  ${details.endpoint}`,
      `  进程  PID ${processId} · 监督器 PID ${process.pid}`,
      `  命令  ${commands[service]}`,
      `  操作  页面或 tidu service 可启动、停止、重启；Ctrl+C 结束当前服务`,
      "",
    ].join("\n"),
  );
};

const startServiceSupervisor = (service, spawnChild) => {
  assertServiceIsNotRunning(service);
  writeSupervisorProcessId(service);
  let childProcess;
  let finalized = false;
  let restarting = false;
  let stopping = false;

  const removeSignalHandlers = () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGUSR2", restart);
  };
  const finish = (exitCode) => {
    if (finalized) return;
    finalized = true;
    removeServiceProcessId(service, childProcess?.pid);
    removeSupervisorProcessId(service);
    removeSignalHandlers();
    process.exitCode = exitCode;
  };
  const launch = (restarted = false) => {
    childProcess = spawnChild();
    if (!Number.isInteger(childProcess.pid)) {
      finish(1);
      return;
    }
    writeServiceProcessId(service, childProcess.pid);
    printServiceStarted(service, childProcess.pid, restarted);
    childProcess.once("error", (error) => {
      process.stderr.write(
        `[AI-TIDU9] ${serviceDetails[service].label}启动失败：${error.message}\n`,
      );
      finish(1);
    });
    childProcess.once("exit", (exitCode, signal) => {
      removeServiceProcessId(service, childProcess.pid);
      if (restarting && !stopping) {
        restarting = false;
        setTimeout(() => launch(true), 250);
        return;
      }
      if (!stopping && !finalized) {
        process.stderr.write(
          `[AI-TIDU9] ${serviceDetails[service].label}已退出 · ${signal ?? `code ${exitCode ?? 1}`}\n`,
        );
      }
      finish(stopping ? 0 : (exitCode ?? 1));
    });
  };
  function restart() {
    if (stopping || restarting || finalized) return;
    restarting = true;
    process.stdout.write(
      `[AI-TIDU9] ${serviceDetails[service].label}重启中… · 当前 PID ${childProcess?.pid ?? "unknown"}\n`,
    );
    if (childProcess?.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill("SIGTERM");
    } else {
      restarting = false;
      launch(true);
    }
  }
  function stop() {
    if (stopping || finalized) return;
    stopping = true;
    process.stdout.write(`[AI-TIDU9] ${serviceDetails[service].label}停止中…\n`);
    if (childProcess?.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill("SIGTERM");
    } else {
      finish(0);
    }
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGUSR2", restart);
  launch();
};

const verifyEnterprisePostgresql = async () => {
  if (edition !== "enterprise") return;
  const connectionString = process.env.TIDU_POSTGRES_URL?.trim();
  if (!connectionString) {
    process.stderr.write("Enterprise development requires TIDU_POSTGRES_URL.\n");
    process.exit(1);
  }
  const connectionUrl = new URL(connectionString);
  if (connectionUrl.protocol !== "postgres:" && connectionUrl.protocol !== "postgresql:") {
    process.stderr.write("TIDU_POSTGRES_URL must use postgres:// or postgresql://.\n");
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
  } finally {
    await pool.end();
  }
};

const startFrontendService = () => {
  startServiceSupervisor("frontend", () =>
    spawn(
      "../../node_modules/.bin/vite",
      ["--host", "127.0.0.1", "--port", String(ports.frontend)],
      {
        cwd: paths.workspace,
        env: {
          ...process.env,
          TIDU_MANAGER_PORT: String(ports.control),
          TIDU_RUNTIME_PORT: String(ports.api),
        },
        stdio: "inherit",
      },
    ),
  );
};

const startApiService = async () => {
  await verifyEnterprisePostgresql();
  startServiceSupervisor("api", () =>
    spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "packages/tidu/src/cli/index.ts",
        "start",
        "--edition",
        edition,
      ],
      {
        cwd: paths.repository,
        env: {
          ...process.env,
          NODE_ENV: "development",
          TIDU_CONNECTOR_CLI_ENTRY: join(paths.repository, "packages/tidu/dist/cli/launcher.js"),
          TIDU_DATABASE_PATH: databasePath,
          TIDU_DEV_EDITION: edition,
          TIDU_DEV_SILENT: "1",
          TIDU_HOST: "127.0.0.1",
          TIDU_PORT: String(ports.api),
        },
        stdio: "inherit",
      },
    ),
  );
};

const spawnService = (service) =>
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--service", service], {
    cwd: paths.repository,
    detached: true,
    env: { ...process.env, TIDU_DEV_EDITION: edition },
    stdio: "inherit",
  });

const stopService = (service) => {
  const processId = readSupervisorProcessId(service) ?? readServiceProcessId(service);
  if (processId === null) return false;
  process.kill(processId, "SIGTERM");
  return true;
};

const restartService = (service) => {
  const supervisorProcessId = readSupervisorProcessId(service);
  if (supervisorProcessId === null) return false;
  process.kill(supervisorProcessId, "SIGUSR2");
  return true;
};

const createInventory = async () => {
  const processIds = {
    api: readServiceProcessId("api"),
    frontend: readServiceProcessId("frontend"),
  };
  const apiHealth =
    processIds.api === null
      ? undefined
      : await fetch(`http://127.0.0.1:${ports.api}/health`, {
          signal: AbortSignal.timeout(800),
        })
          .then((response) => (response.ok ? response.json() : undefined))
          .catch(() => undefined);
  return {
    checkedAt: new Date().toISOString(),
    environment: {
      activeModel: "查看接口服务运行配置",
      endpoint: `http://127.0.0.1:${ports.frontend}`,
      nodeVersion: process.version,
      platform: process.platform,
      providerType: "由接口服务提供",
      storage: apiHealth?.storage
        ? `${apiHealth.storage.provider} · schema ${apiHealth.storage.schemaVersion}`
        : "unavailable",
      uptimeSeconds: Math.floor(process.uptime()),
      version: productVersion,
    },
    mode: "development",
    diagnostics: [],
    services: [
      {
        actions: ["refresh", "start", "restart", "stop"],
        command: commands.frontend,
        endpoint: `http://127.0.0.1:${ports.frontend}`,
        id: serviceIds.frontend,
        kind: "frontend",
        lifecycle: "managed",
        name: "前端服务",
        processId: processIds.frontend,
        status: processIds.frontend === null ? "stopped" : "running",
        version: productVersion,
      },
      {
        actions: ["refresh", "start", "restart", "stop"],
        command: commands.api,
        endpoint: `http://127.0.0.1:${ports.api}`,
        id: serviceIds.api,
        kind: "api",
        lifecycle: "managed",
        name: "接口服务",
        processId: processIds.api,
        status: processIds.api === null ? "stopped" : "running",
        version: productVersion,
      },
    ],
  };
};

const startController = async () => {
  assertServiceIsNotRunning("controller");
  writeServiceProcessId("controller");
  const managedChildren = new Set();
  const registerChild = (childProcess) => {
    managedChildren.add(childProcess);
    childProcess.once("exit", () => managedChildren.delete(childProcess));
    childProcess.unref();
  };
  const startupServices = [
    startFrontend ? "frontend" : undefined,
    startAllServices ? "api" : undefined,
  ];
  for (const service of startupServices) {
    if (service !== undefined) registerChild(spawnService(service));
  }

  const server = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const sendJson = (statusCode, body) => {
      response.writeHead(statusCode, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(`${JSON.stringify(body)}\n`);
    };
    if (request.method === "GET" && pathname === "/health") {
      sendJson(200, {
        product: "九门赛博提督",
        role: "development-controller",
        status: "ok",
      });
      return;
    }
    if (request.method === "GET" && pathname === "/api/services") {
      sendJson(200, await createInventory());
      return;
    }
    const actionRoute = /^\/api\/services\/([^/]+)\/(refresh|start|stop|restart)$/u.exec(pathname);
    if (request.method !== "POST" || actionRoute === null) {
      sendJson(404, { error: "NOT_FOUND" });
      return;
    }
    const requestedId = decodeURIComponent(actionRoute[1] ?? "");
    const action = actionRoute[2];
    const service = Object.entries(serviceIds).find(
      ([, serviceId]) => serviceId === requestedId,
    )?.[0];
    if (service === undefined) {
      sendJson(404, { error: "SERVICE_NOT_FOUND" });
      return;
    }
    if (action === "refresh") {
      sendJson(200, await createInventory());
      return;
    }
    const running = readServiceProcessId(service) !== null;
    if (action === "start" && running) {
      sendJson(409, { error: "SERVICE_ALREADY_RUNNING" });
      return;
    }
    if (action === "start") {
      registerChild(spawnService(service));
      sendJson(202, { accepted: true, action, serviceId: requestedId });
      return;
    }
    if (!running) {
      sendJson(409, { error: "SERVICE_NOT_RUNNING" });
      return;
    }
    if (action === "restart" && !restartService(service)) {
      sendJson(409, { error: "SERVICE_SUPERVISOR_NOT_RUNNING" });
      return;
    }
    if (action === "stop") stopService(service);
    sendJson(202, { accepted: true, action, serviceId: requestedId });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ports.control, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(
    [
      "\n[AI-TIDU9] 本地开发控制已启动",
      `  前端  ${startFrontend ? `启动中 · http://127.0.0.1:${ports.frontend}` : "未启动"}`,
      `  接口  ${startAllServices ? `启动中 · http://127.0.0.1:${ports.api}` : `未启动 · ${commands.api}`}`,
      `  控制  运行中 · http://127.0.0.1:${ports.control}`,
      `  进程  PID ${process.pid}`,
      "  操作  页面与命令行状态联动；Ctrl+C 停止本次启动的服务",
      "",
    ].join("\n"),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const childProcess of managedChildren) {
      if (childProcess.exitCode === null && childProcess.signalCode === null) {
        childProcess.kill("SIGTERM");
      }
    }
    server.close(() => {
      removeServiceProcessId("controller");
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

assertInstalledRuntimeIsStopped();
if (requestedService === "api") {
  const backendBuild = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "packages/tidu/tsconfig.build.json"],
    { cwd: paths.repository, stdio: "inherit" },
  );
  if (backendBuild.status !== 0) process.exit(backendBuild.status ?? 1);
}

if (requestedService === "frontend") startFrontendService();
else if (requestedService === "api") await startApiService();
else await startController();

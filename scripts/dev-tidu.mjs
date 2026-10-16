import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../packages/tidu/", import.meta.url));
const defaultPublicPort = 9639;
const edition = process.env.TIDU_DEV_EDITION ?? "personal";
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
const internalRuntimePort = await new Promise((resolve, reject) => {
  const server = createServer();
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

const runtimeProcess = spawn(
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
  process.stderr.write("Development runtime did not become ready within 10 seconds.\n");
  process.exit(1);
}

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
  spawn("../../node_modules/.bin/vite", ["--host", "127.0.0.1", "--port", String(publicPort)], {
    cwd: workspaceRoot,
    env: { ...process.env, TIDU_RUNTIME_PORT: String(internalRuntimePort) },
    stdio: "inherit",
  }),
];

let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const childProcess of processes) {
    if (childProcess.exitCode === null) {
      childProcess.kill(signal);
    }
  }
};

process.once("SIGINT", () => stop("SIGTERM"));
process.once("SIGTERM", () => stop("SIGTERM"));

for (const childProcess of processes) {
  childProcess.once("error", (error) => {
    process.stderr.write(`Development process failed to start: ${error.message}\n`);
    stop();
    process.exitCode = 1;
  });
  childProcess.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(
        `Development process stopped (${signal ?? code ?? "unknown status"}); stopping the other processes.\n`,
      );
      process.exitCode = code ?? 1;
      stop();
    }
  });
}

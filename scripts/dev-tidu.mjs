import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../packages/tidu/", import.meta.url));
const edition = process.env.TIDU_DEV_EDITION ?? "personal";
const runtimePort = Number(process.env.TIDU_PORT ?? 9639);
const databasePath =
  process.env.TIDU_DATABASE_PATH ??
  join(repositoryRoot, ".tidu-dev", edition === "enterprise" ? "enterprise.sqlite" : "tidu.sqlite");

if (edition !== "personal" && edition !== "enterprise") {
  process.stderr.write("TIDU_DEV_EDITION must be personal or enterprise.\n");
  process.exit(1);
}

if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65_535) {
  process.stderr.write("TIDU_PORT must be an integer from 1 to 65535 for local development.\n");
  process.exit(1);
}

const enterprisePostgresqlGuide = (postgresDetected) => `
企业版开发需要可连接的 PostgreSQL 数据库。
Enterprise development requires a reachable PostgreSQL database.

方案一 / Option 1 · 启动项目提供的 PostgreSQL 容器
  1. export TIDU_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  2. docker compose -f config/docker/compose.yml -f config/docker/compose.dev.yml up -d postgres
  3. export TIDU_POSTGRES_URL="postgresql://tidu:\${TIDU_POSTGRES_PASSWORD}@127.0.0.1:5432/tidu"
  4. npm run tidu:dev-e

方案二 / Option 2 · 使用自行安装的 PostgreSQL
  1. 创建数据库和具有建表权限的用户。
  2. export TIDU_POSTGRES_URL="postgresql://<user>:<password>@<host>:<port>/<database>"
  3. 服务端要求验证 TLS 时设置 TIDU_POSTGRES_SSL=require。
  4. npm run tidu:dev-e

${postgresDetected ? "已发现本机 PostgreSQL 服务，但仍需通过 TIDU_POSTGRES_URL 指定数据库与账号。" : "未发现已就绪的本机 PostgreSQL 服务。"}
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

const build = spawnSync("npm", ["run", "build:tidu"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const runtimeEndpoint = `http://${process.env.TIDU_HOST ?? "127.0.0.1"}:${runtimePort}`;
const managesLocalClients = edition === "personal";
if (managesLocalClients) {
  const setup = spawnSync(
    process.execPath,
    ["packages/tidu/dist/cli/launcher.js", "setup", "install", "--endpoint", runtimeEndpoint],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (setup.status !== 0) {
    process.exit(setup.status ?? 1);
  }
}

const processes = [
  spawn(
    process.execPath,
    ["--watch", "packages/tidu/dist/cli/launcher.js", "start", "--edition", edition],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        TIDU_DATABASE_PATH: databasePath,
        TIDU_HOST: process.env.TIDU_HOST ?? "127.0.0.1",
      },
      stdio: "inherit",
    },
  ),
  spawn(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/tidu/tsconfig.build.json",
      "--watch",
      "--preserveWatchOutput",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  ),
  spawn("../../node_modules/.bin/vite", ["--host", "127.0.0.1"], {
    cwd: workspaceRoot,
    env: { ...process.env, TIDU_PORT: String(runtimePort) },
    stdio: "inherit",
  }),
];

let stopping = false;
let clientSetupInstalled = managesLocalClients;
const stop = (signal = "SIGTERM") => {
  if (stopping) {
    return;
  }
  stopping = true;
  if (clientSetupInstalled) {
    clientSetupInstalled = false;
    const cleanup = spawnSync(
      process.execPath,
      ["packages/tidu/dist/cli/launcher.js", "setup", "uninstall", "--endpoint", runtimeEndpoint],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    if (cleanup.status !== 0) {
      process.stderr.write("Local client cleanup did not complete. Run: tidu setup uninstall\n");
      process.exitCode = 1;
    }
  }
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

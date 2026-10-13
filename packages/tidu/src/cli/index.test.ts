import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_SCHEMA_VERSION } from "../config/index.js";
import { startLocalRuntime } from "../runtime/index.js";
import { runCli } from "./index.js";
import {
  createSafeDiagnosticReport,
  diagnoseEndpoint,
  formatConfiguration,
  loadConfiguration,
  normalizeManagementEndpoint,
  saveConfiguration,
} from "./management.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

test("shows concise help by default", () => {
  assert.match(runCli([]), /Usage \/ 用法:/u);
  assert.match(runCli([]), /九门赛博提督/);
  assert.match(runCli([]), /tidu doctor/u);
  assert.match(runCli([]), /tidu clients/u);
  assert.match(runCli([]), /tidu account/u);
  assert.match(runCli([]), /tidu config/u);
  assert.match(runCli([]), /tidu uninstall/u);
  assert.match(runCli([]), /tidu restore/u);
});

test("provides side-effect-free help for every command group", () => {
  const helpInvocations = [
    ["start", "--help"],
    ["setup", "verify", "--help"],
    ["mcp", "--help"],
    ["doctor", "--help"],
    ["clients", "--help"],
    ["clients", "connect", "codex", "--help"],
    ["clients", "rollback", "codex", "--help"],
    ["account", "--help"],
    ["account", "status", "--help"],
    ["account", "relogin", "--help"],
    ["account", "switch", "--help"],
    ["config", "--help"],
    ["config", "show", "--help"],
    ["config", "set", "--help"],
    ["uninstall", "--help"],
    ["restore", "--help"],
    ["enterprise", "recover-admin", "--help"],
    ["version", "--help"],
    ["help", "config", "set"],
  ] as const;

  for (const invocation of helpInvocations) {
    assert.match(runCli(invocation), /Usage \/ 用法:/u, invocation.join(" "));
  }
});

test("prints subcommand help from the executable without starting the command", () => {
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const result = spawnSync(process.execPath, [executablePath, "start", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /TIDU_PROVIDER/u);
  assert.doesNotMatch(result.stdout, /Running at/u);
});

test("reports local client discovery without credential data", () => {
  const output = runCli(["clients"]);
  assert.match(output, /Local clients/u);
  assert.match(output, /Codex/u);
  assert.match(output, /Cursor/u);
  assert.match(output, /No credentials/u);
});

test("prints the published package version", () => {
  assert.equal(runCli(["version"]), packageVersion);
});

test("rejects unsupported commands", () => {
  assert.throws(() => runCli(["unsupported"]), /Unknown command/);
});

test("runs as an executable entry point", () => {
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const result = spawnSync(process.execPath, [executablePath, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), packageVersion);
});

test("configures and rolls back a dedicated Codex profile through the CLI", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cli-codex-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });
  const runCommand = async (commandArguments: readonly string[]) => {
    const child = spawn(process.execPath, [executablePath, ...commandArguments], {
      env: { ...process.env, CODEX_HOME: codexHomeDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let standardOutput = "";
    let standardError = "";
    child.stdout.on("data", (chunk) => {
      standardOutput += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      standardError += chunk.toString();
    });
    const [exitCode] = (await once(child, "exit")) as [number | null];
    return { exitCode, standardOutput, standardError };
  };

  try {
    const configured = await runCommand([
      "clients",
      "connect",
      "codex",
      "--yes",
      "--endpoint",
      runtime.origin,
    ]);
    assert.equal(configured.exitCode, 0);
    assert.equal(configured.standardError, "");
    assert.match(configured.standardOutput, /configured and verified/u);
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), true);

    const rolledBack = await runCommand(["clients", "rollback", "codex", "--yes"]);
    assert.equal(rolledBack.exitCode, 0);
    assert.equal(rolledBack.standardError, "");
    assert.match(rolledBack.standardOutput, /restored/u);
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), false);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("reuses, refreshes, and switches host-owned Codex and Cursor logins through the CLI", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cli-account-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const fakeBinDirectory = join(temporaryDirectory, "bin");
  const commandLogPath = join(temporaryDirectory, "commands.log");
  const cursorCommandLogPath = join(temporaryDirectory, "cursor-commands.log");
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700 });
    mkdirSync(fakeBinDirectory, { mode: 0o700 });
    writeFileSync(join(codexHomeDirectory, "auth.json"), "test-only", { mode: 0o600 });
    const fakeCodexPath = join(fakeBinDirectory, "codex");
    writeFileSync(
      fakeCodexPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
        '  printf "Logged in using ChatGPT\\n"',
        "  exit 0",
        "fi",
        'printf "%s\\n" "$*" >> "$CODEX_TEST_LOG"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const fakeCursorAgentPath = join(fakeBinDirectory, "agent");
    writeFileSync(
      fakeCursorAgentPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "status" ]; then',
        '  printf "Authenticated with Cursor\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then',
        '  printf "Start Agent Client Protocol server\\n"',
        "  exit 0",
        "fi",
        'printf "%s\\n" "$*" >> "$CURSOR_TEST_LOG"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const environment = {
      ...process.env,
      CODEX_HOME: codexHomeDirectory,
      CODEX_TEST_LOG: commandLogPath,
      CURSOR_TEST_LOG: cursorCommandLogPath,
      PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}`,
    };

    const status = spawnSync(process.execPath, [executablePath, "account"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(status.status, 0);
    assert.match(status.stdout, /signed in · reusable/u);
    assert.match(status.stdout, /Cursor account: signed in/u);
    assert.match(status.stdout, /does not read, copy, store, or print tokens/u);

    const relogin = spawnSync(process.execPath, [executablePath, "account", "relogin"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(relogin.status, 0);

    const switched = spawnSync(process.execPath, [executablePath, "account", "switch", "--yes"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(switched.status, 0);
    assert.deepEqual(readFileSync(commandLogPath, "utf8").trim().split("\n"), [
      "login",
      "logout",
      "login",
    ]);

    const cursorRelogin = spawnSync(
      process.execPath,
      [executablePath, "account", "relogin", "cursor"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(cursorRelogin.status, 0);
    const cursorSwitched = spawnSync(
      process.execPath,
      [executablePath, "account", "switch", "cursor", "--yes"],
      { encoding: "utf8", env: environment },
    );
    assert.equal(cursorSwitched.status, 0);
    assert.deepEqual(readFileSync(cursorCommandLogPath, "utf8").trim().split("\n"), [
      "login",
      "logout",
      "login",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("refuses to remove a custom database path", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cli-uninstall-"));
  const databasePath = join(temporaryDirectory, "shared.db");
  writeFileSync(databasePath, "preserve-me", { mode: 0o600 });
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));

  try {
    const result = spawnSync(process.execPath, [executablePath, "uninstall", "--yes"], {
      encoding: "utf8",
      env: { ...process.env, TIDU_DATABASE_PATH: databasePath, TIDU_PORT: "0" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Custom database paths are preserved/u);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("completely removes owned connectors, profiles, data, and snapshots", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cli-complete-uninstall-"));
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const binaryDirectory = join(temporaryDirectory, "bin");
  const cursorCommand = join(binaryDirectory, "cursor");
  const cursorConfiguration = join(temporaryDirectory, ".cursor", "mcp.json");
  const dataDirectory =
    process.platform === "darwin"
      ? join(temporaryDirectory, "Library", "Application Support", "AI-Tidu9")
      : process.platform === "win32"
        ? join(temporaryDirectory, "AppData", "Local", "AI-Tidu9")
        : join(temporaryDirectory, "data", "ai-tidu9");
  const snapshotDirectory = `${dataDirectory}.snapshot.test`;

  try {
    mkdirSync(binaryDirectory, { recursive: true });
    writeFileSync(cursorCommand, "", { mode: 0o700 });
    mkdirSync(join(temporaryDirectory, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfiguration,
      JSON.stringify({
        mcpServers: {
          "ai-tidu9": { command: "node", args: ["tidu", "mcp"] },
          preserved: { command: "preserved" },
        },
      }),
      { mode: 0o600 },
    );
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(snapshotDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "tidu.db"), "test", { mode: 0o600 });

    const result = spawnSync(
      process.execPath,
      [executablePath, "uninstall", "--complete", "--confirm", "DELETE"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: join(temporaryDirectory, ".codex"),
          HOME: temporaryDirectory,
          LOCALAPPDATA: join(temporaryDirectory, "AppData", "Local"),
          PATH: binaryDirectory,
          TIDU_PORT: "0",
          XDG_DATA_HOME: join(temporaryDirectory, "data"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Complete AI-Tidu9 cleanup finished/u);
    assert.equal(existsSync(dataDirectory), false);
    assert.equal(existsSync(snapshotDirectory), false);
    assert.deepEqual(JSON.parse(readFileSync(cursorConfiguration, "utf8")), {
      mcpServers: { preserved: { command: "preserved" } },
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("starts the local runtime from the executable entry point", async () => {
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [executablePath, "start"], {
    env: {
      ...process.env,
      TIDU_DATABASE_PATH: ":memory:",
      TIDU_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let healthVerified = false;

  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += chunk.toString();
      const origin = output.match(/Running at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
      if (origin !== undefined) {
        const response = await fetch(`${origin}/health`);
        assert.equal(response.status, 200);
        healthVerified = true;
        break;
      }
    }
    assert.equal(healthVerified, true);
  } finally {
    if (child.exitCode === null) {
      const exitPromise = once(child, "exit");
      child.kill("SIGTERM");
      await exitPromise;
    }
  }
});

test("normalizes safe management endpoints and rejects embedded credentials", () => {
  assert.equal(normalizeManagementEndpoint(), "http://127.0.0.1:9639");
  assert.equal(
    normalizeManagementEndpoint("https://tidu.example.com/"),
    "https://tidu.example.com",
  );
  assert.throws(
    () => normalizeManagementEndpoint("https://admin:secret@tidu.example.com"),
    /cannot contain credentials/u,
  );
});

test("diagnoses and configures a running runtime through the public API", async () => {
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });
  try {
    const report = await diagnoseEndpoint(runtime.origin);
    assert.equal(report.healthy, true);
    assert.deepEqual(
      report.checks.map((check) => check.name),
      ["runtime", "configuration", "page"],
    );
    const safeReport = createSafeDiagnosticReport(report, packageVersion);
    assert.equal(safeReport.endpointScope, "local");
    assert.equal(safeReport.productVersion, packageVersion);
    assert.equal("endpoint" in safeReport, false);
    assert.doesNotMatch(JSON.stringify(safeReport), /127\.0\.0\.1/u);

    const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
    const doctorProcess = spawn(
      process.execPath,
      [executablePath, "doctor", "--json", "--endpoint", runtime.origin],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let doctorOutput = "";
    let doctorError = "";
    doctorProcess.stdout.on("data", (chunk) => {
      doctorOutput += chunk.toString();
    });
    doctorProcess.stderr.on("data", (chunk) => {
      doctorError += chunk.toString();
    });
    const [doctorExitCode] = (await once(doctorProcess, "exit")) as [number | null];
    assert.equal(doctorExitCode, 0);
    assert.equal(doctorError, "");
    const doctorReport = JSON.parse(doctorOutput) as {
      endpointScope: string;
      healthy: boolean;
      schemaVersion: string;
    };
    assert.equal(doctorReport.endpointScope, "local");
    assert.equal(doctorReport.healthy, true);
    assert.equal(doctorReport.schemaVersion, "tidu-diagnostic/1");
    assert.doesNotMatch(doctorOutput, /127\.0\.0\.1/u);

    const saved = await saveConfiguration(runtime.origin, {
      mode: "expert",
      activeProfileId: "expert-cli",
      virtualModelName: "CLI专家入口",
      activate: false,
    });
    assert.equal(saved.configuration.workspace.active.configuration.activeMode, "managed");
    assert.equal(
      saved.configuration.workspace.drafts.expert.configuration.schemaVersion,
      CONFIG_SCHEMA_VERSION,
    );
    assert.match(formatConfiguration(saved), /Expert draft: r2 · expert-cli · CLI专家入口/u);

    const activated = await saveConfiguration(runtime.origin, {
      mode: "expert",
      virtualModelName: "CLI专家入口",
      activate: true,
    });
    assert.equal(activated.configuration.workspace.active.configuration.activeMode, "expert");
    assert.equal(
      (await loadConfiguration(runtime.origin)).configuration.workspace.active.configuration
        .virtualModelName,
      "CLI专家入口",
    );
  } finally {
    await runtime.close();
  }
});

test("offers a simple interactive configuration fallback", async () => {
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [executablePath, "config", "--endpoint", runtime.origin], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    let standardOutput = "";
    let standardError = "";
    let promptIndex = 0;
    const promptMarkers = [
      "Mode [managed/expert]",
      "Profile ID",
      "Virtual model name",
      "Activate after saving?",
      "Configure detected clients now?",
    ];
    const promptAnswers = ["\n", "cli-personal\n", "CLI个人入口\n", "y\n", "n\n"];
    child.stdout.on("data", (chunk) => {
      standardOutput += chunk.toString();
      const promptMarker = promptMarkers[promptIndex];
      const promptAnswer = promptAnswers[promptIndex];
      if (
        promptMarker !== undefined &&
        promptAnswer !== undefined &&
        standardOutput.includes(promptMarker)
      ) {
        promptIndex += 1;
        child.stdin.write(promptAnswer);
        if (promptIndex === promptAnswers.length) {
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      standardError += chunk.toString();
    });
    const [exitCode] = (await once(child, "exit")) as [number | null];
    assert.equal(exitCode, 0, standardError);
    assert.equal(standardError, "");
    assert.match(standardOutput, /\[5\/5\] Clients/u);
    assert.match(standardOutput, /Configuration saved and activated/u);
    assert.match(standardOutput, /cli-personal · CLI个人入口/u);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await runtime.close();
  }
});

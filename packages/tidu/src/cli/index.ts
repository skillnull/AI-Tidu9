#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  formatCodexHostLogin,
  inspectCodexHostLogin,
  reloginCodexHost,
  switchCodexHostAccount,
} from "../accounts/codex-host.js";
import {
  formatCursorHostLogin,
  inspectCursorHostLogin,
  reloginCursorHost,
  switchCursorHostAccount,
} from "../accounts/cursor-host.js";
import {
  configureCodexClient,
  rollbackCodexClientConfiguration,
} from "../clients/configuration.js";
import { discoverLocalClients, formatLocalClientDiscovery } from "../clients/index.js";
import type { ConfigurationMode } from "../config/index.js";
import { startTiduMcpServer } from "../connectors/mcp-server.js";
import {
  type ConnectorSetupAction,
  formatConnectorSetupReport,
  setupConnectors,
} from "../connectors/setup.js";
import { PRODUCT, TiduError } from "../core/index.js";
import {
  archivePersonalData,
  purgePersonalData,
  resolvePersonalDataDirectory,
  restoreLatestPersonalData,
} from "../lifecycle/index.js";
import { resolveDefaultDatabasePath } from "../storage/index.js";
import {
  diagnoseEndpoint,
  formatConfiguration,
  loadConfiguration,
  normalizeManagementEndpoint,
  saveConfiguration,
} from "./management.js";

const HELP_TEXT = `${PRODUCT.explanation}

Usage:
  tidu [command]

Commands:
  start                  Start the local runtime
  setup [action]         Install, verify, repair, update, or uninstall connectors
  mcp                    Run the stdio MCP connector for Agent hosts
  doctor                 Diagnose runtime, configuration API, and page
  clients                Detect supported local clients without reading credentials
  clients connect codex  Back up, write, and verify a dedicated Codex profile
  clients rollback codex Restore the most recent Codex profile snapshot
  account                Show reusable Codex and Cursor host accounts
  account relogin [host] Explicitly run the host's official login flow
  account switch [host]  Confirm, sign out, and choose another host account
  config                 Open the simple interactive configuration wizard
  config show            Show active configuration and isolated drafts
  config set             Update a draft with advanced command options
  uninstall              Archive local data for a recoverable uninstall
  restore                Restore the latest uninstall snapshot
  help, --help, -h       Show help
  version, --version, -v Show version

Examples:
  tidu start
  tidu setup
  tidu setup verify
  tidu doctor
  tidu clients
  tidu clients connect codex
  tidu clients rollback codex
  tidu account
  tidu account relogin cursor
  tidu account switch codex
  tidu config
  tidu config show
  tidu config set --mode expert --name "Expert entry" --activate
  tidu uninstall
  tidu restore

Remote management:
  Add --endpoint https://tidu.example.com or set TIDU_ENDPOINT.`;

const TERMINAL_STYLE = Object.freeze({
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  reset: "\u001B[0m",
  yellow: "\u001B[33m",
});

const style = (value: string, color: keyof Omit<typeof TERMINAL_STYLE, "reset">): string =>
  process.stdout.isTTY && process.env.NO_COLOR === undefined
    ? `${TERMINAL_STYLE[color]}${value}${TERMINAL_STYLE.reset}`
    : value;

const readOption = (argumentsList: readonly string[], option: string): string | undefined => {
  const optionIndex = argumentsList.indexOf(option);
  if (optionIndex === -1) {
    return undefined;
  }
  const value = argumentsList[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TiduError("CONFIGURATION_INVALID", `${option} requires a value.`);
  }
  return value;
};

const resolveEndpoint = (argumentsList: readonly string[]): string =>
  normalizeManagementEndpoint(readOption(argumentsList, "--endpoint") ?? process.env.TIDU_ENDPOINT);

const readMode = (value: string | undefined): ConfigurationMode => {
  if (value === "managed" || value === "expert") {
    return value;
  }
  throw new TiduError("CONFIGURATION_INVALID", "--mode must be managed or expert.");
};

const runDoctor = async (argumentsList: readonly string[]): Promise<string> => {
  const endpoint = resolveEndpoint(argumentsList);
  const report = await diagnoseEndpoint(endpoint);
  const checkLabels = {
    configuration: "Configuration API",
    page: "Management page",
    runtime: "Runtime",
  };
  const lines = report.checks.map((check) => {
    const marker = check.healthy ? style("✓", "green") : style("✖", "red");
    return `${marker} ${checkLabels[check.name]}: ${check.detail}`;
  });
  const summary = report.healthy
    ? style("All management checks passed.", "green")
    : style("Some checks failed. The active runtime configuration was not changed.", "yellow");
  return [`Endpoint: ${report.endpoint}`, ...lines, summary].join("\n");
};

const runInteractiveConfiguration = async (endpoint: string): Promise<string> => {
  const bootstrap = await loadConfiguration(endpoint);
  const activeMode = bootstrap.configuration.workspace.active.configuration.activeMode;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const modeAnswer = (await readline.question(`Mode [managed/expert] (${activeMode}): `)).trim();
    const mode = modeAnswer === "" ? activeMode : readMode(modeAnswer);
    const draft = bootstrap.configuration.workspace.drafts[mode].configuration;
    const profileAnswer = (
      await readline.question(`Profile ID (${draft.activeProfileId}): `)
    ).trim();
    const nameAnswer = (
      await readline.question(`Virtual model name (${draft.virtualModelName}): `)
    ).trim();
    const activateAnswer = (await readline.question("Activate after saving? [y/N]: "))
      .trim()
      .toLowerCase();
    const updated = await saveConfiguration(endpoint, {
      mode,
      activeProfileId: profileAnswer || draft.activeProfileId,
      virtualModelName: nameAnswer || draft.virtualModelName,
      activate: activateAnswer === "y" || activateAnswer === "yes",
    });
    return `${style("✓", "green")} Configuration saved${activateAnswer === "y" || activateAnswer === "yes" ? " and activated" : " as a draft"}.\n${formatConfiguration(updated)}`;
  } finally {
    readline.close();
  }
};

const runConfiguration = async (argumentsList: readonly string[]): Promise<string> => {
  const endpoint = resolveEndpoint(argumentsList);
  const action = argumentsList[1];
  if (action === undefined || action.startsWith("--")) {
    return runInteractiveConfiguration(endpoint);
  }
  if (action === "show") {
    return formatConfiguration(await loadConfiguration(endpoint));
  }
  if (action === "set") {
    const mode = readMode(readOption(argumentsList, "--mode"));
    const activeProfileId = readOption(argumentsList, "--profile");
    const virtualModelName = readOption(argumentsList, "--name");
    if (activeProfileId === undefined && virtualModelName === undefined) {
      throw new TiduError("CONFIGURATION_INVALID", "config set requires --profile or --name.");
    }
    const updated = await saveConfiguration(endpoint, {
      mode,
      activeProfileId,
      virtualModelName,
      activate: argumentsList.includes("--activate"),
    });
    return `${style("✓", "green")} Configuration saved${argumentsList.includes("--activate") ? " and activated" : " as a draft"}.\n${formatConfiguration(updated)}`;
  }
  throw new TiduError("UNSUPPORTED_COMMAND", `Unknown config action: ${action}`);
};

const assertDefaultLifecycleStorage = (): void => {
  const configuredDatabasePath = process.env.TIDU_DATABASE_PATH;
  if (
    configuredDatabasePath !== undefined &&
    configuredDatabasePath !== resolveDefaultDatabasePath()
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Custom database paths are preserved and must be managed explicitly.",
    );
  }
};

const isPersonalRuntimeActive = async (): Promise<boolean> => {
  const configuredPort = process.env.TIDU_PORT;
  const port = configuredPort === undefined ? 9639 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { product?: unknown };
    return body.product === PRODUCT.name;
  } catch {
    return false;
  }
};

const assertPersonalRuntimeStopped = async (): Promise<void> => {
  if (await isPersonalRuntimeActive()) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Stop the running personal runtime before uninstalling or restoring data.",
    );
  }
};

const confirmLifecycleAction = async (
  question: string,
  expectedAnswer: string,
): Promise<boolean> => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim() === expectedAnswer;
  } finally {
    readline.close();
  }
};

const runClientConfiguration = async (argumentsList: readonly string[]): Promise<string> => {
  const action = argumentsList[1];
  const client = argumentsList[2];
  if (client !== "codex") {
    throw new TiduError(
      "UNSUPPORTED_COMMAND",
      "Automatic configuration currently supports only the dedicated Codex profile.",
    );
  }
  if (action === "connect") {
    const confirmed =
      argumentsList.includes("--yes") ||
      (await confirmLifecycleAction(
        "Create or update the dedicated Codex profile 'ai-tidu9'? [y/N]: ",
        "y",
      ));
    if (!confirmed) {
      return `${style("Cancelled.", "yellow")} No client configuration was changed.`;
    }
    const result = await configureCodexClient({ endpoint: resolveEndpoint(argumentsList) });
    return [
      `${style("✓", "green")} Codex profile '${result.profile}' configured and verified.`,
      `Virtual model: ${result.model}`,
      `Endpoint: ${result.endpoint}`,
      `Start with: codex --profile ${result.profile}`,
      `Rollback snapshot: ${result.backupId}`,
    ].join("\n");
  }
  if (action === "rollback") {
    const confirmed =
      argumentsList.includes("--yes") ||
      (await confirmLifecycleAction(
        "Restore the latest AI-Tidu9 Codex profile snapshot? [y/N]: ",
        "y",
      ));
    if (!confirmed) {
      return `${style("Cancelled.", "yellow")} No client configuration was changed.`;
    }
    const result = rollbackCodexClientConfiguration();
    return result.status === "missing"
      ? `${style("✓", "green")} No Codex profile snapshot was found.`
      : `${style("✓", "green")} Codex profile '${result.profile}' restored from ${result.backupId}.`;
  }
  throw new TiduError("UNSUPPORTED_COMMAND", `Unknown clients action: ${String(action)}`);
};

const runSetup = (argumentsList: readonly string[]): string => {
  const requestedAction = argumentsList[1] ?? "install";
  const supportedActions = new Set<ConnectorSetupAction>([
    "install",
    "verify",
    "repair",
    "update",
    "uninstall",
  ]);
  if (!supportedActions.has(requestedAction as ConnectorSetupAction)) {
    throw new TiduError("UNSUPPORTED_COMMAND", `Unknown setup action: ${requestedAction}`);
  }
  const report = setupConnectors({
    action: requestedAction as ConnectorSetupAction,
    endpoint: resolveEndpoint(argumentsList),
  });
  if (!report.healthy) {
    process.exitCode = 1;
  }
  return formatConnectorSetupReport(report);
};

const runAccount = async (argumentsList: readonly string[]): Promise<string> => {
  const action = argumentsList[1];
  if (action === undefined || action === "status") {
    const requestedHost = action === "status" ? argumentsList[2] : undefined;
    if (requestedHost === "codex") {
      return formatCodexHostLogin(inspectCodexHostLogin());
    }
    if (requestedHost === "cursor") {
      return formatCursorHostLogin(inspectCursorHostLogin());
    }
    if (requestedHost !== undefined) {
      throw new TiduError("UNSUPPORTED_COMMAND", `Unknown account host: ${requestedHost}`);
    }
    return [
      formatCodexHostLogin(inspectCodexHostLogin()),
      "",
      formatCursorHostLogin(inspectCursorHostLogin()),
    ].join("\n");
  }
  const hostArgument = argumentsList[2];
  const requestedHost =
    hostArgument === undefined || hostArgument.startsWith("--") ? "codex" : hostArgument;
  if (requestedHost !== "codex" && requestedHost !== "cursor") {
    throw new TiduError("UNSUPPORTED_COMMAND", `Unknown account host: ${requestedHost}`);
  }
  if (action === "relogin") {
    if (requestedHost === "cursor") {
      await reloginCursorHost();
      return `${style("✓", "green")} Cursor login refreshed.\n${formatCursorHostLogin(inspectCursorHostLogin())}`;
    }
    await reloginCodexHost();
    return `${style("✓", "green")} Codex login refreshed.\n${formatCodexHostLogin(inspectCodexHostLogin())}`;
  }
  if (action === "switch") {
    const confirmed =
      argumentsList.includes("--yes") ||
      (await confirmLifecycleAction(
        `Switch ${requestedHost === "cursor" ? "Cursor" : "Codex"} account? The current host login will be signed out first. [y/N]: `,
        "y",
      ));
    if (!confirmed) {
      return `${style("Cancelled.", "yellow")} The current host login was not changed.`;
    }
    if (requestedHost === "cursor") {
      await switchCursorHostAccount();
      return `${style("✓", "green")} Cursor account switched.\n${formatCursorHostLogin(inspectCursorHostLogin())}`;
    }
    await switchCodexHostAccount();
    return `${style("✓", "green")} Codex account switched.\n${formatCodexHostLogin(inspectCodexHostLogin())}`;
  }
  throw new TiduError("UNSUPPORTED_COMMAND", `Unknown account action: ${action}`);
};

const runPersonalUninstall = async (argumentsList: readonly string[]): Promise<string> => {
  assertDefaultLifecycleStorage();
  await assertPersonalRuntimeStopped();
  const dataDirectory = resolvePersonalDataDirectory();
  const purge = argumentsList.includes("--purge");
  if (purge) {
    const confirmed =
      readOption(argumentsList, "--confirm") === "DELETE" ||
      (await confirmLifecycleAction(
        `Permanently delete ${dataDirectory} and all AI-Tidu9 snapshots? Type DELETE: `,
        "DELETE",
      ));
    if (!confirmed) {
      return `${style("Cancelled.", "yellow")} No data was changed.`;
    }
    const result = purgePersonalData(dataDirectory);
    return result.status === "missing"
      ? `${style("✓", "green")} No personal data or snapshots were found.`
      : `${style("✓", "green")} Permanently removed ${result.removedDirectoryCount} AI-Tidu9 data director${result.removedDirectoryCount === 1 ? "y" : "ies"}.`;
  }

  const confirmed =
    argumentsList.includes("--yes") ||
    (await confirmLifecycleAction(
      `Archive personal data at ${dataDirectory} for a recoverable uninstall? [y/N]: `,
      "y",
    ));
  if (!confirmed) {
    return `${style("Cancelled.", "yellow")} No data was changed.`;
  }
  const result = archivePersonalData(dataDirectory);
  if (result.status === "missing") {
    return `${style("✓", "green")} No personal data was found. npx installations need no package removal.`;
  }
  return [
    `${style("✓", "green")} Personal data was archived safely.`,
    `Snapshot: ${result.snapshotDirectory}`,
    "Run tidu restore after reinstalling to recover it.",
    "If installed globally, finish with: npm uninstall -g @skillnull/tidu",
  ].join("\n");
};

const runPersonalRestore = async (argumentsList: readonly string[]): Promise<string> => {
  assertDefaultLifecycleStorage();
  await assertPersonalRuntimeStopped();
  const confirmed =
    argumentsList.includes("--yes") ||
    (await confirmLifecycleAction("Restore the latest AI-Tidu9 personal snapshot? [y/N]: ", "y"));
  if (!confirmed) {
    return `${style("Cancelled.", "yellow")} No data was changed.`;
  }
  const result = restoreLatestPersonalData();
  return result.status === "missing"
    ? `${style("✓", "green")} No uninstall snapshot was found.`
    : `${style("✓", "green")} Restored ${result.snapshotDirectory} to ${result.dataDirectory}.`;
};

export const runCli = (argumentsList: readonly string[]): string => {
  const [command = "help"] = argumentsList;

  if (command === "version" || command === "--version" || command === "-v") {
    return PRODUCT.version;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    return HELP_TEXT;
  }

  if (command === "clients") {
    return formatLocalClientDiscovery(discoverLocalClients());
  }

  throw new TiduError("UNSUPPORTED_COMMAND", `Unknown command: ${command}`, {
    details: { command },
  });
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  try {
    const argumentsList = process.argv.slice(2);
    if (argumentsList[0] === "start") {
      const { startLocalRuntime } = await import("../runtime/index.js");
      const configuredPort = process.env.TIDU_PORT;
      const port = configuredPort === undefined ? undefined : Number(configuredPort);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          "TIDU_PORT must be an integer from 0 to 65535.",
        );
      }

      const runtime = await startLocalRuntime({
        databasePath: process.env.TIDU_DATABASE_PATH,
        port,
      });
      process.stdout.write(
        `${PRODUCT.explanation}\nRunning at ${runtime.origin}\nConfiguration center: ${runtime.origin}\n`,
      );

      const stopRuntime = async () => {
        await runtime.close();
        process.exitCode = 0;
      };
      process.once("SIGINT", stopRuntime);
      process.once("SIGTERM", stopRuntime);
    } else if (argumentsList[0] === "mcp") {
      const server = startTiduMcpServer({ endpoint: resolveEndpoint(argumentsList) });
      await server.completed;
    } else if (argumentsList[0] === "setup") {
      process.stdout.write(`${runSetup(argumentsList)}\n`);
    } else if (argumentsList[0] === "doctor") {
      const output = await runDoctor(argumentsList);
      process.stdout.write(`${output}\n`);
      if (output.includes("Some checks failed.")) {
        process.exitCode = 1;
      }
    } else if (argumentsList[0] === "clients" && argumentsList[1] !== undefined) {
      process.stdout.write(`${await runClientConfiguration(argumentsList)}\n`);
    } else if (argumentsList[0] === "account") {
      process.stdout.write(`${await runAccount(argumentsList)}\n`);
    } else if (argumentsList[0] === "config") {
      process.stdout.write(`${await runConfiguration(argumentsList)}\n`);
    } else if (argumentsList[0] === "uninstall") {
      process.stdout.write(`${await runPersonalUninstall(argumentsList)}\n`);
    } else if (argumentsList[0] === "restore") {
      process.stdout.write(`${await runPersonalRestore(argumentsList)}\n`);
    } else {
      process.stdout.write(`${runCli(argumentsList)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

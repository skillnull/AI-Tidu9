#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
  removeCodexClientConfiguration,
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
  createSafeDiagnosticReport,
  diagnoseEndpoint,
  formatConfiguration,
  loadConfiguration,
  normalizeManagementEndpoint,
  saveConfiguration,
} from "./management.js";

const HELP_TEXT = `${PRODUCT.explanation}

Usage / 用法:
  tidu <command> [options]
  tidu help <command>

Commands / 命令:
  tidu start        Start the runtime / 启动运行时
  tidu setup        Manage host connectors / 管理宿主连接器
  tidu mcp          Run the MCP connector / 运行MCP连接器
  tidu doctor       Diagnose the service / 诊断服务
  tidu clients      Discover or configure clients / 发现或配置客户端
  tidu account      Inspect or change host login / 检查或切换宿主账号
  tidu config       View or edit configuration / 查看或编辑配置
  tidu uninstall    Archive or remove AI-Tidu9 / 归档或卸载九门赛博提督
  tidu restore      Restore personal data / 恢复个人数据
  tidu enterprise   Enterprise host operations / 企业服务器操作
  tidu version      Show package version / 显示版本

Help / 帮助:
  tidu <command> --help
  tidu help <command>

Remote / 远程管理:
  Add --endpoint <url> or set TIDU_ENDPOINT.`;

const COMMAND_HELP = Object.freeze<Record<string, string>>({
  account: `Account / 宿主账号

Usage / 用法:
  tidu account
  tidu account status [codex|cursor]
  tidu account relogin [codex|cursor]
  tidu account switch [codex|cursor] [--yes]

Notes / 说明:
  Status reads only sanitized official CLI output. Relogin and switch invoke the host's official flow.
  状态检查只读取官方CLI的脱敏输出；重新登录与切换均调用宿主官方流程。`,
  "account relogin": `Account relogin / 重新登录宿主账号

Usage / 用法:
  tidu account relogin [codex|cursor]

The default host is codex. This explicitly starts the official login flow.
默认宿主为codex；该命令会显式启动官方登录流程。`,
  "account status": `Account status / 宿主账号状态

Usage / 用法:
  tidu account status [codex|cursor]

Without a host, both Codex and Cursor are inspected without exposing credentials.
不指定宿主时同时检查Codex与Cursor，且不会输出凭据。`,
  "account switch": `Account switch / 切换宿主账号

Usage / 用法:
  tidu account switch [codex|cursor] [--yes]

Options / 选项:
  --yes  Skip the interactive confirmation / 跳过交互确认`,
  clients: `Clients / 客户端

Usage / 用法:
  tidu clients
  tidu clients connect codex [--yes] [--endpoint <url>]
  tidu clients rollback codex [--yes]

Discovery checks presence only and never reads credential contents.
发现过程只检查是否存在，不读取凭据正文。`,
  "clients connect": `Clients connect / 接入客户端

Usage / 用法:
  tidu clients connect codex [--yes] [--endpoint <url>]

Creates and verifies only the dedicated ai-tidu9 Codex profile, with a private rollback snapshot.
仅创建并验证九门专属Codex Profile，同时保留私有回滚快照。`,
  "clients rollback": `Clients rollback / 回滚客户端配置

Usage / 用法:
  tidu clients rollback codex [--yes]

Restores the latest AI-Tidu9-owned Codex profile snapshot.
恢复最近一次由九门管理的Codex Profile快照。`,
  config: `Config / 配置

Usage / 用法:
  tidu config [--endpoint <url>]
  tidu config show [--endpoint <url>]
  tidu config set --mode <managed|expert> [--profile <id>] [--name <text>] [--activate] [--endpoint <url>]

Running without an action opens the guided wizard. Drafts do not affect the runtime until activated.
不带动作时进入引导式配置；草稿只有启用后才影响运行时。`,
  "config set": `Config set / 修改配置草稿

Usage / 用法:
  tidu config set --mode <managed|expert> [--profile <id>] [--name <text>] [--activate] [--endpoint <url>]

Options / 选项:
  --mode       Required isolated draft / 必填，指定独立草稿
  --profile    Active profile ID / Profile标识
  --name       Virtual-model display name / 虚拟模型显示名
  --activate   Activate after saving / 保存后启用
  --endpoint   Management service URL / 管理服务地址`,
  "config show": `Config show / 查看配置

Usage / 用法:
  tidu config show [--endpoint <url>]

Shows the active snapshot and both isolated drafts.
显示当前生效快照以及普通、专家两个隔离草稿。`,
  doctor: `Doctor / 诊断

Usage / 用法:
  tidu doctor [--json] [--endpoint <url>]

Options / 选项:
  --json  Print a privacy-safe report for issue submission / 输出可用于提交问题的隐私安全报告

Checks the runtime health endpoint, configuration API, and management page without changing configuration.
检查运行时、配置API和管理页面，不修改任何配置。JSON报告不包含端点主机名、凭据、路径或会话内容。`,
  enterprise: `Enterprise / 企业服务器操作

Usage / 用法:
  tidu enterprise recover-admin --reason <text>

Enterprise commands run on the trusted server host and require TIDU_POSTGRES_URL.
企业命令必须在可信服务器执行，并配置TIDU_POSTGRES_URL。`,
  "enterprise recover-admin": `Enterprise recover-admin / 恢复管理员密钥

Usage / 用法:
  tidu enterprise recover-admin --reason <non-secret-text>

Creates a new one-time administrator key and writes a security audit event. Never place secrets in --reason.
生成新的单次展示管理员密钥并记录安全审计；--reason中不得包含秘密。`,
  mcp: `MCP connector / MCP连接器

Usage / 用法:
  tidu mcp [--endpoint <url>]

Runs the stdio MCP bridge for supported Agent hosts. It is normally launched by tidu setup.
为支持的Agent宿主运行stdio MCP桥，通常由tidu setup自动启动。`,
  restore: `Restore / 恢复

Usage / 用法:
  tidu restore [--yes]

Restores the latest recoverable personal-data snapshot without overwriting an existing data directory.
恢复最近的个人数据快照，不覆盖已有数据目录。`,
  setup: `Setup / 连接器安装

Usage / 用法:
  tidu setup [install|verify|repair|update|uninstall] [--endpoint <url>]

Actions / 动作:
  install     Install detected connectors; default / 安装已发现连接器，默认动作
  verify      Verify without changes / 只验证，不修改
  repair      Recreate owned registrations / 重建九门自有注册
  update      Refresh launch metadata / 更新启动信息
  uninstall   Remove connectors, keep data / 移除连接器，保留数据`,
  start: `Start / 启动

Usage / 用法:
  tidu start [--cli]

Options / 选项:
  --cli  Start and run the guided terminal setup / 启动后进入终端分步配置

Environment / 环境变量:
  TIDU_HOST, TIDU_PORT, TIDU_DATABASE_PATH
  TIDU_PROVIDER, TIDU_PROVIDER_MODEL, TIDU_PROVIDER_API_KEY, TIDU_PROVIDER_BASE_URL
  TIDU_POSTGRES_URL

Starts the runtime and prints the management URL. Secrets are read from the process environment only.
启动运行时并输出管理地址；密钥只从当前进程环境读取。`,
  uninstall: `Uninstall / 卸载

Usage / 用法:
  tidu uninstall [--yes]
  tidu uninstall --purge [--confirm DELETE]
  tidu uninstall --complete [--confirm DELETE] [--endpoint <url>]

Modes / 模式:
  default     Archive personal data for restore / 归档个人数据，可恢复
  --purge     Permanently remove owned data and snapshots / 永久删除自有数据和快照
  --complete  Also remove owned connectors, profiles, and global npm install / 同时清理自有连接器、Profile和全局npm安装`,
  version: `Version / 版本

Usage / 用法:
  tidu version
  tidu --version
  tidu -v`,
});

const HELP_FLAGS = new Set(["--help", "-h"]);

const resolveHelpText = (argumentsList: readonly string[]): string | undefined => {
  const helpRequested =
    argumentsList.length === 0 ||
    argumentsList[0] === "help" ||
    argumentsList.some((argument) => HELP_FLAGS.has(argument));
  if (!helpRequested) {
    return undefined;
  }

  const topicArguments = (
    argumentsList[0] === "help" ? argumentsList.slice(1) : argumentsList
  ).filter((argument) => !HELP_FLAGS.has(argument));
  if (topicArguments.length === 0) {
    return HELP_TEXT;
  }
  const detailedTopic = topicArguments.slice(0, 2).join(" ");
  const topLevelTopic = topicArguments[0] ?? "";
  const helpText = COMMAND_HELP[detailedTopic] ?? COMMAND_HELP[topLevelTopic];
  if (helpText === undefined) {
    throw new TiduError("UNSUPPORTED_COMMAND", `Unknown help topic: ${topLevelTopic}`);
  }
  return helpText;
};

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
  if (argumentsList.includes("--json")) {
    return JSON.stringify(createSafeDiagnosticReport(report, PRODUCT.version), null, 2);
  }
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
    process.stdout.write(`\n[1/5] Runtime / 运行环境\n${endpoint}\n`);
    process.stdout.write(
      bootstrap.runtime.provider.configured
        ? `Provider ready / 模型已就绪: ${String(bootstrap.runtime.provider.type)} · ${String(bootstrap.runtime.provider.model)}\n`
        : "Provider pending / 模型待配置: restart with TIDU_PROVIDER and TIDU_PROVIDER_MODEL when inference is required.\n",
    );
    process.stdout.write("\n[2/5] Mode / 配置模式\n");
    const modeAnswer = (await readline.question(`Mode [managed/expert] (${activeMode}): `)).trim();
    const mode = modeAnswer === "" ? activeMode : readMode(modeAnswer);
    const draft = bootstrap.configuration.workspace.drafts[mode].configuration;
    process.stdout.write("\n[3/5] Entry / 统一入口\n");
    const profileAnswer = (
      await readline.question(`Profile ID (${draft.activeProfileId}): `)
    ).trim();
    const nameAnswer = (
      await readline.question(`Virtual model name (${draft.virtualModelName}): `)
    ).trim();
    process.stdout.write("\n[4/5] Activation / 保存与启用\n");
    const activateAnswer = (await readline.question("Activate after saving? [y/N]: "))
      .trim()
      .toLowerCase();
    const updated = await saveConfiguration(endpoint, {
      mode,
      activeProfileId: profileAnswer || draft.activeProfileId,
      virtualModelName: nameAnswer || draft.virtualModelName,
      activate: activateAnswer === "y" || activateAnswer === "yes",
    });
    process.stdout.write("\n[5/5] Clients / 客户端接入\n");
    const setupAnswer = (await readline.question("Configure detected clients now? [Y/n]: "))
      .trim()
      .toLowerCase();
    const setupRequested = setupAnswer === "" || setupAnswer === "y" || setupAnswer === "yes";
    const setupReport = setupRequested
      ? formatConnectorSetupReport(setupConnectors({ action: "install", endpoint }))
      : "Connector setup skipped. Run: tidu setup";
    return [
      `${style("✓", "green")} Configuration saved${activateAnswer === "y" || activateAnswer === "yes" ? " and activated" : " as a draft"}.`,
      formatConfiguration(updated),
      setupReport,
    ].join("\n");
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

const removeGlobalNpmPackage = (): string => {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    return "Package removal: no installed CLI entry was detected.";
  }
  const resolvedEntry = realpathSync(entryPath);
  if (resolvedEntry.includes(`${join(".npm", "_npx")}`)) {
    return "Package removal: this npx run has no persistent package installation.";
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const rootResult = spawnSync(npmCommand, ["root", "--global"], {
    encoding: "utf8",
    env: process.env,
    timeout: 15_000,
  });
  const globalRoot = rootResult.status === 0 ? rootResult.stdout.trim() : "";
  if (globalRoot === "") {
    return "Package removal: npm ownership could not be determined; use the original package manager.";
  }
  const globalPackageRoot = join(realpathSync(globalRoot), "@skillnull", "tidu");
  const relativeEntry = relative(globalPackageRoot, resolvedEntry);
  const globallyInstalled =
    relativeEntry === "" || (!relativeEntry.startsWith("..") && !isAbsolute(relativeEntry));
  if (!globallyInstalled) {
    return "Package removal: source checkouts and project dependencies remain owned by their project package manager.";
  }
  const uninstallResult = spawnSync(npmCommand, ["uninstall", "--global", "@skillnull/tidu"], {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  if (uninstallResult.status !== 0) {
    process.exitCode = 1;
    return "Package removal: global npm uninstall failed; all other AI-Tidu9-owned state was removed.";
  }
  return "Package removal: global @skillnull/tidu installation removed.";
};

const runPersonalUninstall = async (argumentsList: readonly string[]): Promise<string> => {
  assertDefaultLifecycleStorage();
  await assertPersonalRuntimeStopped();
  const dataDirectory = resolvePersonalDataDirectory();
  const complete = argumentsList.includes("--complete");
  if (complete) {
    const confirmed =
      readOption(argumentsList, "--confirm") === "DELETE" ||
      (await confirmLifecycleAction(
        `Remove all AI-Tidu9 connectors, managed client files, data, and snapshots at ${dataDirectory}? Type DELETE: `,
        "DELETE",
      ));
    if (!confirmed) {
      return `${style("Cancelled.", "yellow")} No data was changed.`;
    }
    const connectorReport = setupConnectors({
      action: "uninstall",
      endpoint: resolveEndpoint(argumentsList),
    });
    if (!connectorReport.healthy) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        `Complete uninstall stopped because a connector could not be removed.\n${formatConnectorSetupReport(connectorReport)}`,
      );
    }
    const codexRemoval = removeCodexClientConfiguration();
    const dataRemoval = purgePersonalData(dataDirectory);
    const packageRemoval = removeGlobalNpmPackage();
    return [
      `${style("✓", "green")} Complete AI-Tidu9 cleanup finished.`,
      formatConnectorSetupReport(connectorReport),
      `Codex managed artifacts removed: ${codexRemoval.removedArtifactCount}`,
      `Data directories removed: ${dataRemoval.removedDirectoryCount}`,
      packageRemoval,
      "Host accounts, conversations, unrelated plugins, and custom database paths were preserved.",
    ].join("\n");
  }
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
  const helpText = resolveHelpText(argumentsList);
  if (helpText !== undefined) {
    return helpText;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    return PRODUCT.version;
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
    const helpText = resolveHelpText(argumentsList);
    if (helpText !== undefined) {
      process.stdout.write(`${helpText}\n`);
    } else if (argumentsList[0] === "start") {
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
        host: process.env.TIDU_HOST,
        port,
      });
      process.stdout.write(
        `${PRODUCT.explanation}\nRunning at ${runtime.origin}\nConfiguration center: ${runtime.origin}\n`,
      );

      if (argumentsList.includes("--cli")) {
        process.stdout.write(`${await runInteractiveConfiguration(runtime.origin)}\n`);
      } else {
        process.stdout.write(
          "Guided setup: open the configuration center. Terminal setup: tidu start --cli\n",
        );
      }

      const stopRuntime = async () => {
        await runtime.close();
        process.exitCode = 0;
      };
      process.once("SIGINT", stopRuntime);
      process.once("SIGTERM", stopRuntime);
    } else if (argumentsList[0] === "mcp") {
      const server = startTiduMcpServer({ endpoint: resolveEndpoint(argumentsList) });
      await server.completed;
    } else if (argumentsList[0] === "enterprise" && argumentsList[1] === "recover-admin") {
      const reasonIndex = argumentsList.indexOf("--reason");
      const reason = reasonIndex === -1 ? undefined : argumentsList[reasonIndex + 1];
      if (reason === undefined) {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          "Host recovery requires --reason with a non-secret audit explanation.",
        );
      }
      const { createEnterpriseRuntimeFromEnvironment } = await import("../enterprise/runtime.js");
      const enterpriseRuntime = await createEnterpriseRuntimeFromEnvironment();
      if (enterpriseRuntime === undefined) {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          "TIDU_POSTGRES_URL is required for enterprise host recovery.",
        );
      }
      try {
        const recovered = await enterpriseRuntime.controlPlane.recoverAdministratorKey(
          true,
          reason,
        );
        process.stdout.write(
          `Administrator key recovered. Save it now; it cannot be retrieved again.\n${recovered.key}\n`,
        );
      } finally {
        await enterpriseRuntime.close();
      }
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

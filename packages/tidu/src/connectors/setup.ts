import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { TiduError } from "../core/index.js";

export type ConnectorSetupAction = "install" | "repair" | "uninstall" | "update" | "verify";
export type ConnectorSetupStatus =
  | "configured"
  | "missing"
  | "removed"
  | "unavailable"
  | "verified";

export interface ConnectorSetupItem {
  /** Stable connector identifier. */
  id: "browser" | "codex" | "cursor" | "openai";
  /** Capability boundary exposed by this surface. */
  capability: "browser-management" | "mcp-tools" | "openai-compatible";
  /** Result of the requested setup action. */
  status: ConnectorSetupStatus;
  /** Human-readable result without credentials or configuration contents. */
  detail: string;
}

export interface ConnectorSetupReport {
  /** Setup contract version. */
  schemaVersion: 1;
  /** Action applied to every supported connector. */
  action: ConnectorSetupAction;
  /** Shared runtime endpoint used by all configured surfaces. */
  endpoint: string;
  /** Per-surface outcome; unavailable clients do not block other connectors. */
  connectors: readonly ConnectorSetupItem[];
  /** True only when every installed or universal connector is usable. */
  healthy: boolean;
}

export interface ConnectorSetupOptions {
  /** Action to perform; defaults to install. */
  action?: ConnectorSetupAction;
  /** AI-Tidu9 runtime origin shared by browser and OpenAI-compatible clients. */
  endpoint?: string;
  /** Absolute Node executable used to make MCP startup independent from PATH. */
  nodeExecutable?: string;
  /** Absolute installed CLI entry file. */
  cliEntry?: string;
  /** Home override used by isolated tests. */
  homeDirectory?: string;
  /** PATH override used by isolated tests. */
  executablePath?: string;
}

const CONNECTOR_NAME = "ai-tidu9";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeEndpoint = (candidate: string): string => {
  const endpoint = new URL(candidate);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname)))
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Connector endpoint must use HTTPS or uncredentialed loopback HTTP.",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
};

const findCommand = (names: readonly string[], executablePath: string): string | undefined => {
  for (const directory of executablePath.split(":")) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const status = statSync(candidate);
        if (status.isFile()) {
          return candidate;
        }
      } catch {
        // Continue discovery without inspecting unrelated files.
      }
    }
  }
  return undefined;
};

const run = (command: string, argumentsList: readonly string[]): boolean => {
  const result = spawnSync(command, [...argumentsList], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  return result.status === 0;
};

const writeJsonAtomically = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Cursor MCP configuration is not a safe file.");
    }
  }
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

const updateCursorMcp = (
  path: string,
  command: string,
  argumentsList: readonly string[],
  remove: boolean,
): ConnectorSetupStatus => {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("root is not an object");
      }
      root = parsed;
    } catch (error) {
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "Cursor MCP configuration is invalid; no file was changed.",
        { cause: error },
      );
    }
  }
  const currentServers = isRecord(root.mcpServers) ? root.mcpServers : {};
  const servers = { ...currentServers };
  if (remove) {
    if (!(CONNECTOR_NAME in servers)) {
      return "missing";
    }
    delete servers[CONNECTOR_NAME];
  } else {
    servers[CONNECTOR_NAME] = { type: "stdio", command, args: [...argumentsList] };
  }
  writeJsonAtomically(path, { ...root, mcpServers: servers });
  return remove ? "removed" : "configured";
};

const configureCodex = (
  codex: string | undefined,
  action: ConnectorSetupAction,
  command: string,
  argumentsList: readonly string[],
): ConnectorSetupItem => {
  if (codex === undefined) {
    return {
      id: "codex",
      capability: "mcp-tools",
      status: "unavailable",
      detail: "Codex is not installed.",
    };
  }
  const configured = run(codex, ["mcp", "get", CONNECTOR_NAME, "--json"]);
  if (action === "verify") {
    return {
      id: "codex",
      capability: "mcp-tools",
      status: configured ? "verified" : "missing",
      detail: configured
        ? "Codex MCP connector is registered."
        : "Codex MCP connector is not registered.",
    };
  }
  if (action === "uninstall") {
    const removed = !configured || run(codex, ["mcp", "remove", CONNECTOR_NAME]);
    return {
      id: "codex",
      capability: "mcp-tools",
      status: configured && removed ? "removed" : "missing",
      detail: removed
        ? "Codex MCP connector removed."
        : "Codex MCP connector could not be removed.",
    };
  }
  if (configured && (action === "repair" || action === "update")) {
    run(codex, ["mcp", "remove", CONNECTOR_NAME]);
  }
  const installed =
    configured && action === "install"
      ? true
      : run(codex, ["mcp", "add", CONNECTOR_NAME, "--", command, ...argumentsList]);
  return {
    id: "codex",
    capability: "mcp-tools",
    status: installed ? "configured" : "missing",
    detail: installed
      ? "Codex app, CLI, and IDE share the registered MCP connector."
      : "Codex connector registration failed.",
  };
};

export const setupConnectors = (options: ConnectorSetupOptions = {}): ConnectorSetupReport => {
  const action = options.action ?? "install";
  const endpoint = normalizeEndpoint(
    options.endpoint ?? process.env.TIDU_ENDPOINT ?? "http://127.0.0.1:9639",
  );
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const cliEntry = options.cliEntry ?? process.argv[1];
  if (cliEntry === undefined) {
    throw new TiduError("CONFIGURATION_INVALID", "Cannot resolve the installed tidu CLI entry.");
  }
  const executablePath = options.executablePath ?? process.env.PATH ?? "";
  const homeDirectory = options.homeDirectory ?? homedir();
  const mcpArguments = [cliEntry, "mcp", "--endpoint", endpoint] as const;
  const codex = findCommand(["codex"], executablePath);
  const cursor = findCommand(["cursor", "agent", "cursor-agent"], executablePath);
  const cursorConfig = join(homeDirectory, ".cursor", "mcp.json");

  const codexResult = configureCodex(codex, action, nodeExecutable, mcpArguments);
  let cursorStatus: ConnectorSetupStatus;
  const cursorAvailable = cursor !== undefined || existsSync(join("/Applications", "Cursor.app"));
  if (!cursorAvailable) {
    cursorStatus = "unavailable";
  } else if (action === "verify") {
    const root = existsSync(cursorConfig)
      ? (() => {
          try {
            return JSON.parse(readFileSync(cursorConfig, "utf8")) as unknown;
          } catch {
            return undefined;
          }
        })()
      : undefined;
    cursorStatus =
      isRecord(root) && isRecord(root.mcpServers) && CONNECTOR_NAME in root.mcpServers
        ? "verified"
        : "missing";
  } else {
    cursorStatus = updateCursorMcp(
      cursorConfig,
      nodeExecutable,
      mcpArguments,
      action === "uninstall",
    );
  }
  const cursorResult: ConnectorSetupItem = {
    id: "cursor",
    capability: "mcp-tools",
    status: cursorStatus,
    detail: cursorAvailable
      ? `Cursor desktop and CLI connector is ${cursorStatus}. Restart Cursor to reload it.`
      : "Cursor is not installed; its connector configuration was not activated.",
  };
  const universalStatus: ConnectorSetupStatus = action === "uninstall" ? "removed" : "verified";
  const connectors: ConnectorSetupItem[] = [
    codexResult,
    cursorResult,
    {
      id: "browser",
      capability: "browser-management",
      status: universalStatus,
      detail:
        action === "uninstall"
          ? "No browser files require removal."
          : `Configuration center: ${endpoint}`,
    },
    {
      id: "openai",
      capability: "openai-compatible",
      status: universalStatus,
      detail:
        action === "uninstall"
          ? "No generic-client files require removal."
          : `OpenAI-compatible base URL: ${endpoint}/v1`,
    },
  ];
  const healthy = connectors.every((item) =>
    action === "uninstall"
      ? item.status === "removed" || item.status === "missing" || item.status === "unavailable"
      : item.status === "configured" || item.status === "verified" || item.status === "unavailable",
  );
  return { schemaVersion: 1, action, endpoint, connectors, healthy };
};

export const formatConnectorSetupReport = (report: ConnectorSetupReport): string => {
  const lines = report.connectors.map(
    (item) =>
      `${item.status === "missing" ? "✖" : item.status === "unavailable" ? "○" : "✓"} ${item.id} [${item.capability}]: ${item.detail}`,
  );
  return [`Connector setup: ${report.action}`, ...lines].join("\n");
};

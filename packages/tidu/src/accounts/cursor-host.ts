import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { TiduError } from "../core/index.js";

export type CursorHostLoginStatus =
  | "authenticated"
  | "not-authenticated"
  | "unavailable"
  | "unknown";

export interface CursorHostLoginState {
  /** Stable schema version for account-state consumers. */
  schemaVersion: "1";
  /** Host client that remains the authority for this login. */
  client: "cursor";
  /** Sanitized result reported by the official Cursor Agent status command. */
  status: CursorHostLoginStatus;
  /** Resolved official Cursor Agent command, or null when ACP is unavailable. */
  command: string | null;
  /** Whether full Cursor Agent delegation is available through ACP. */
  acpAvailable: boolean;
  /** Whether AI-Tidu9 can delegate without asking the user to sign in again. */
  reusable: boolean;
  /** Authentication owner; AI-Tidu9 never reads or persists Cursor credentials. */
  authority: "cursor-host";
  /** Account email only when the official status command reports it in JSON. */
  accountEmail?: string | null;
  /** Subscription plan only when the official status command reports it in JSON. */
  accountPlan?: string | null;
}

export interface CursorHostModel {
  /** Cursor-owned model identifier accepted by the Agent CLI. */
  id: string;
  /** Human-readable model name published by Cursor. */
  name: string;
  /** Whether Cursor marks this entry as the account's default model. */
  default: boolean;
}

export interface CursorHostInspectionOptions {
  /** Optional official Cursor Agent executable override used by packaged environments and tests. */
  command?: string;
  /** Environment passed to the official Cursor Agent process. */
  environment?: NodeJS.ProcessEnv;
  /** Maximum duration for the status probe. */
  timeoutMilliseconds?: number;
}

export interface CursorHostCommandOptions extends CursorHostInspectionOptions {
  /** Standard input/output mode used for explicit login operations. */
  stdio?: "inherit" | "pipe";
  /** Time allowed for a user to finish the browser sign-in flow. */
  loginTimeoutMilliseconds?: number;
}

export interface CursorAcpLaunch {
  /** Official Cursor Agent executable to launch. */
  command: string;
  /** Arguments that start the stdio ACP server. */
  arguments: readonly string[];
  /** Environment inherited without API-key overrides, preserving host-owned login. */
  environment: NodeJS.ProcessEnv;
}

const DEFAULT_STATUS_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_COMMAND_CANDIDATES = ["agent", "cursor-agent"] as const;

const resolveCursorCommands = (options: CursorHostInspectionOptions): string[] => {
  if (options.command !== undefined) return [options.command];
  const environment = { ...process.env, ...options.environment };
  const directories = [
    ...(environment.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const candidates = directories.flatMap((directory) =>
    DEFAULT_COMMAND_CANDIDATES.map((name) => join(directory, name)),
  );
  return candidates.filter((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

const resolveEnvironment = (options: CursorHostInspectionOptions): NodeJS.ProcessEnv => {
  const environment = { ...process.env, ...options.environment };
  delete environment.CURSOR_API_KEY;
  delete environment.CURSOR_AUTH_TOKEN;
  return environment;
};

const parseLoginStatus = (statusCode: number | null, output: string): CursorHostLoginStatus => {
  if (/not authenticated|not logged in/iu.test(output)) {
    return "not-authenticated";
  }
  if (statusCode === 0 && /authenticated|logged in/iu.test(output)) {
    return "authenticated";
  }
  return statusCode === null ? "unavailable" : "unknown";
};

const parseAccountEmail = (output: string): string | null => {
  try {
    const status = JSON.parse(output) as unknown;
    if (typeof status !== "object" || status === null || Array.isArray(status)) return null;
    const fields = status as Record<string, unknown>;
    const candidate = fields.email ?? fields.userEmail;
    return typeof candidate === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate)
      ? candidate
      : null;
  } catch {
    return null;
  }
};

const parseAccountPlan = (output: string): string | null => {
  try {
    const status = JSON.parse(output) as unknown;
    if (typeof status !== "object" || status === null || Array.isArray(status)) return null;
    const fields = status as Record<string, unknown>;
    const candidate = fields.plan ?? fields.subscription ?? fields.subscriptionType ?? fields.tier;
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
  } catch {
    return null;
  }
};

const parseCursorModels = (output: string): CursorHostModel[] =>
  output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\p{Cf}/gu, "").trim())
    .flatMap((line) => {
      const match = /^(\S+)\s+-\s+(.+?)(\s+\(default\))?$/u.exec(line);
      if (match === null) return [];
      const [, id, name, defaultMarker] = match;
      if (id === undefined || name === undefined) return [];
      return [{ id, name: name.trim(), default: defaultMarker !== undefined }];
    });

export const listCursorHostModels = (
  options: CursorHostInspectionOptions = {},
): CursorHostModel[] => {
  for (const command of resolveCursorCommands(options)) {
    const result = spawnSync(command, ["--list-models"], {
      encoding: "utf8",
      env: resolveEnvironment(options),
      timeout: options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
    if (result.status !== 0) return [];
    return parseCursorModels(result.stdout ?? "");
  }
  return [];
};

const supportsCursorAcp = (command: string, options: CursorHostInspectionOptions): boolean => {
  const result = spawnSync(command, ["acp", "--help"], {
    encoding: "utf8",
    env: resolveEnvironment(options),
    timeout: options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 && /Agent Client Protocol|\bACP\b/iu.test(output);
};

export const inspectCursorHostLogin = (
  options: CursorHostInspectionOptions = {},
): CursorHostLoginState => {
  const commandCandidates = resolveCursorCommands(options);
  for (const command of commandCandidates) {
    const result = spawnSync(command, ["status"], {
      encoding: "utf8",
      env: resolveEnvironment(options),
      timeout: options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      continue;
    }
    const acpAvailable = supportsCursorAcp(command, options);
    const status = parseLoginStatus(
      result.status,
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    return {
      schemaVersion: "1",
      client: "cursor",
      status,
      command,
      acpAvailable,
      reusable: acpAvailable && status === "authenticated",
      authority: "cursor-host",
      accountEmail: parseAccountEmail(result.stdout ?? ""),
      accountPlan: parseAccountPlan(result.stdout ?? ""),
    };
  }
  return {
    schemaVersion: "1",
    client: "cursor",
    status: "unavailable",
    command: null,
    acpAvailable: false,
    reusable: false,
    authority: "cursor-host",
    accountEmail: null,
    accountPlan: null,
  };
};

const runCursorCommand = async (
  command: string,
  argumentsList: readonly string[],
  options: CursorHostCommandOptions,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: resolveEnvironment(options),
      stdio: options.stdio ?? "inherit",
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new TiduError("INTERNAL_ERROR", "Cursor browser sign-in timed out."));
    }, options.loginTimeoutMilliseconds ?? 300_000);
    child.once("exit", () => clearTimeout(timeout));
    child.once("error", () => clearTimeout(timeout));
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new TiduError(
          "INTERNAL_ERROR",
          `Cursor account command failed${signal === null ? ` with exit code ${String(exitCode)}` : ` after signal ${signal}`}.`,
        ),
      );
    });
  });
};

const requireCursorCommand = (options: CursorHostInspectionOptions): string => {
  const state = inspectCursorHostLogin(options);
  if (state.command === null) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Cursor Agent CLI with ACP support was not found. Install the official Cursor Agent CLI first.",
    );
  }
  return state.command;
};

export const reloginCursorHost = (options: CursorHostCommandOptions = {}): Promise<void> =>
  runCursorCommand(requireCursorCommand(options), ["login"], options);

export const switchCursorHostAccount = async (
  options: CursorHostCommandOptions = {},
): Promise<void> => {
  const command = requireCursorCommand(options);
  await runCursorCommand(command, ["logout"], options);
  await runCursorCommand(command, ["login"], options);
};

export const createCursorAcpLaunch = (
  options: CursorHostInspectionOptions = {},
): CursorAcpLaunch => {
  const state = inspectCursorHostLogin(options);
  if (!state.reusable || state.command === null) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "No reusable Cursor Agent login is available. Run `tidu account relogin cursor` explicitly.",
    );
  }
  return {
    command: state.command,
    arguments: ["acp"],
    environment: resolveEnvironment(options),
  };
};

export const formatCursorHostLogin = (state: CursorHostLoginState): string => {
  if (state.reusable) {
    return [
      "Cursor account: signed in · official ACP endpoint available",
      "Target capabilities: Agent, Plan, Ask, tools, permissions, sessions, and supported MCP configuration.",
      "Credentials: owned by Cursor; AI-Tidu9 does not read, copy, store, or print tokens.",
    ].join("\n");
  }
  const detail = !state.acpAvailable
    ? "Cursor Agent CLI with ACP is not installed"
    : state.status === "not-authenticated"
      ? "not signed in"
      : "login state could not be verified";
  const guidance = state.acpAvailable
    ? "The ACP endpoint is installed, but Cursor Desktop login is not automatically delegated to Agent CLI."
    : "The Cursor desktop app alone is not an ACP endpoint; install the official Agent CLI first.";
  return [`Cursor account: ${detail}`, guidance].join("\n");
};

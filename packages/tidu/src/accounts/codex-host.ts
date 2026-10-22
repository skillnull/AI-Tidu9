import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { TiduError } from "../core/index.js";
import { inspectProcess } from "./process-inspection.js";

export type CodexHostLoginStatus =
  | "authenticated"
  | "not-authenticated"
  | "unavailable"
  | "unknown";

export interface CodexHostLoginState {
  /** Stable schema version for account-state consumers. */
  schemaVersion: "1";
  /** Host client that remains the authority for this login. */
  client: "codex";
  /** Sanitized result reported by the official Codex status command. */
  status: CodexHostLoginStatus;
  /** Whether the official Codex executable can be invoked. */
  commandAvailable: boolean;
  /** Whether Codex-owned authentication storage exists. */
  authStoragePresent: boolean;
  /** Whether the detected authentication storage is a regular, non-symbolic-link file. */
  authStorageSafe: boolean;
  /** Whether AI-Tidu9 can delegate to Codex without asking the user to sign in again. */
  reusable: boolean;
  /** Authentication owner; AI-Tidu9 never copies or persists its credentials. */
  authority: "codex-host";
}

export interface CodexHostInspectionOptions {
  /** Optional Codex home override used by isolated tests and managed installations. */
  codexHomeDirectory?: string;
  /** Optional Codex executable override used by packaged environments and tests. */
  command?: string;
  /** Environment passed to the official status command. */
  environment?: NodeJS.ProcessEnv;
  /** Maximum duration for the status probe. */
  timeoutMilliseconds?: number;
  /** Provider forced for delegated app-server requests, without changing the user's configuration. */
  modelProvider?: string;
}

export interface CodexHostCommandOptions extends CodexHostInspectionOptions {
  /** Standard input/output mode used for explicit login operations. */
  stdio?: "inherit" | "pipe";
}

export interface CodexAppServerLaunch {
  /** Official Codex executable to launch. */
  command: string;
  /** Arguments that start the local stdio app-server. */
  arguments: readonly string[];
  /** Environment inherited by Codex without provider credentials, including CODEX_HOME. */
  environment: NodeJS.ProcessEnv;
}

const DEFAULT_STATUS_TIMEOUT_MILLISECONDS = 15_000;

const executableExists = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveCodexCommand = (options: CodexHostInspectionOptions): string => {
  if (options.command !== undefined) return options.command;
  const environment = { ...process.env, ...options.environment };
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory !== "")
    .map((directory) => join(directory, "codex"));
  const nvmVersionsDirectory = join(
    environment.NVM_DIR ?? join(homedir(), ".nvm"),
    "versions",
    "node",
  );
  let nvmCandidates: string[] = [];
  try {
    nvmCandidates = readdirSync(nvmVersionsDirectory)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(nvmVersionsDirectory, version, "bin", "codex"));
  } catch {
    // NVM is optional.
  }
  return (
    [
      ...pathCandidates,
      join(homedir(), ".local", "bin", "codex"),
      ...nvmCandidates,
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ].find(executableExists) ?? "codex"
  );
};

const resolveCodexHome = (options: CodexHostInspectionOptions): string =>
  options.codexHomeDirectory ??
  options.environment?.CODEX_HOME ??
  process.env.CODEX_HOME ??
  join(homedir(), ".codex");

const resolveEnvironment = (options: CodexHostInspectionOptions): NodeJS.ProcessEnv => {
  const environment = { ...process.env, ...options.environment };
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.OPENAI_API_KEY;
  if (options.codexHomeDirectory !== undefined) {
    environment.CODEX_HOME = options.codexHomeDirectory;
  }
  return environment;
};

const inspectAuthStorage = (
  options: CodexHostInspectionOptions,
): Pick<CodexHostLoginState, "authStoragePresent" | "authStorageSafe"> => {
  const authStoragePath = join(resolveCodexHome(options), "auth.json");
  if (!existsSync(authStoragePath)) {
    return { authStoragePresent: false, authStorageSafe: false };
  }
  try {
    const fileStatus = lstatSync(authStoragePath);
    return {
      authStoragePresent: true,
      authStorageSafe: fileStatus.isFile() && !fileStatus.isSymbolicLink(),
    };
  } catch {
    return { authStoragePresent: true, authStorageSafe: false };
  }
};

const parseLoginStatus = (statusCode: number | null, output: string): CodexHostLoginStatus => {
  if (statusCode === 0 && /logged in|authenticated/iu.test(output)) {
    return "authenticated";
  }
  if (/not logged in|not authenticated/iu.test(output)) {
    return "not-authenticated";
  }
  return statusCode === null ? "unavailable" : "unknown";
};

export const inspectCodexHostLogin = (
  options: CodexHostInspectionOptions = {},
): CodexHostLoginState => {
  const storage = inspectAuthStorage(options);
  const command = resolveCodexCommand(options);
  const result = spawnSync(command, ["login", "status"], {
    encoding: "utf8",
    env: resolveEnvironment(options),
    timeout: options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
  });
  const commandAvailable =
    result.error === undefined || (result.error as NodeJS.ErrnoException).code !== "ENOENT";
  const status = commandAvailable
    ? parseLoginStatus(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`)
    : "unavailable";
  return {
    schemaVersion: "1",
    client: "codex",
    status,
    commandAvailable,
    ...storage,
    reusable:
      status === "authenticated" && (!storage.authStoragePresent || storage.authStorageSafe),
    authority: "codex-host",
  };
};

export const inspectCodexHostLoginAsync = async (
  options: CodexHostInspectionOptions = {},
): Promise<CodexHostLoginState> => {
  const storage = inspectAuthStorage(options);
  const result = await inspectProcess(
    resolveCodexCommand(options),
    ["login", "status"],
    resolveEnvironment(options),
    options.timeoutMilliseconds ?? DEFAULT_STATUS_TIMEOUT_MILLISECONDS,
  );
  const commandAvailable = result.errorCode !== "ENOENT";
  const status = commandAvailable
    ? parseLoginStatus(result.status, `${result.stdout}\n${result.stderr}`)
    : "unavailable";
  return {
    schemaVersion: "1",
    client: "codex",
    status,
    commandAvailable,
    ...storage,
    reusable:
      status === "authenticated" && (!storage.authStoragePresent || storage.authStorageSafe),
    authority: "codex-host",
  };
};

const runCodexCommand = async (
  argumentsList: readonly string[],
  options: CodexHostCommandOptions,
): Promise<void> => {
  const command = resolveCodexCommand(options);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      env: resolveEnvironment(options),
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new TiduError(
          "INTERNAL_ERROR",
          `Codex account command failed${signal === null ? ` with exit code ${String(exitCode)}` : ` after signal ${signal}`}.`,
        ),
      );
    });
  });
};

export const reloginCodexHost = (options: CodexHostCommandOptions = {}): Promise<void> =>
  runCodexCommand(["login"], options);

export const switchCodexHostAccount = async (
  options: CodexHostCommandOptions = {},
): Promise<void> => {
  await runCodexCommand(["logout"], options);
  await runCodexCommand(["login"], options);
};

export const createCodexAppServerLaunch = (
  options: CodexHostInspectionOptions = {},
): CodexAppServerLaunch => {
  const state = inspectCodexHostLogin(options);
  if (!state.reusable) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "No reusable Codex login is available. Run `tidu account relogin` explicitly.",
    );
  }
  const officialModelCatalog = join(resolveCodexHome(options), "models_cache.json");
  return {
    command: resolveCodexCommand(options),
    arguments: [
      ...(options.modelProvider === undefined
        ? []
        : [
            "-c",
            `model_provider=${JSON.stringify(options.modelProvider)}`,
            ...(options.modelProvider === "openai" && existsSync(officialModelCatalog)
              ? ["-c", `model_catalog_json=${JSON.stringify(officialModelCatalog)}`]
              : []),
          ]),
      "app-server",
      "--listen",
      "stdio://",
    ],
    environment: resolveEnvironment(options),
  };
};

export const formatCodexHostLogin = (state: CodexHostLoginState): string => {
  if (state.reusable) {
    return [
      "Codex account: signed in · reusable",
      "Default: delegate through the official Codex process without another login.",
      "Credentials: owned by Codex; AI-Tidu9 does not read, copy, store, or print tokens.",
    ].join("\n");
  }
  const detail =
    state.status === "not-authenticated"
      ? "not signed in"
      : state.status === "unavailable"
        ? "Codex command unavailable"
        : state.authStoragePresent && !state.authStorageSafe
          ? "unsafe authentication storage"
          : "login state could not be verified";
  return [
    `Codex account: ${detail}`,
    "Run `tidu account relogin` only when you want to authenticate or repair the connection.",
  ].join("\n");
};

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHER_NAME = ".ai-tidu9-codex-client";
const OWNER_LINE = "# AI-Tidu9 native Codex client recovery v1";
const ORIGINAL_LINE = "# Original CODEX_CLI_PATH: ";
const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const writeLauncher = (path: string, content: string): void => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o700, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
};

export interface CodexDesktopProxyOptions {
  /** Official executable; no credentials or host conversation contents are copied. */
  realCommand: string;
  /** Node executable used by the installed connector launcher. */
  nodeCommand: string;
  /** Compiled connector entry, or a source entry with explicitly supplied loader arguments. */
  entryPath: string;
  /** Runtime loader arguments, used only for source development. */
  nodeArguments?: readonly string[];
  /** Codex directory that owns the dedicated launcher. */
  codexHomeDirectory?: string;
  /** Optional environment adapter for isolated tests. */
  environment?: { read: () => string | undefined; write: (value: string | undefined) => void };
  /** Register now, or prepare the executable until AI-Tidu9 mode is selected. */
  activate?: boolean;
}

export interface CodexDesktopProxyResult {
  /** Dedicated executable registered through the desktop's CODEX_CLI_PATH override. */
  launcher: string;
  /** Running desktop processes retain their original environment until restarted. */
  requiresAppRestart: true;
}

const desktopEnvironment = {
  read: (): string | undefined => {
    try {
      return (
        execFileSync("launchctl", ["getenv", "CODEX_CLI_PATH"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  },
  write: (value: string | undefined): void => {
    if (process.platform !== "darwin")
      throw new Error(
        "Automatic Codex desktop environment registration is supported on macOS only.",
      );
    execFileSync(
      "launchctl",
      value === undefined ? ["unsetenv", "CODEX_CLI_PATH"] : ["setenv", "CODEX_CLI_PATH", value],
      { stdio: "pipe" },
    );
  },
};

const readOwnedLauncher = (path: string): string | undefined => {
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("Codex client launcher must be an owned regular file.");
  const content = readFileSync(path, "utf8");
  if (!content.split("\n").includes(OWNER_LINE))
    throw new Error("Refusing to overwrite a launcher not owned by AI-Tidu9.");
  return content;
};

/** Installs executable configuration only; creates no additional conversation database or journal. */
export const installCodexDesktopProxy = (
  options: CodexDesktopProxyOptions,
): CodexDesktopProxyResult => {
  const home = options.codexHomeDirectory ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const launcher = join(home, LAUNCHER_NAME);
  const environment = options.environment ?? desktopEnvironment;
  const oldContent = readOwnedLauncher(launcher);
  const previous = oldContent?.split("\n").find((line) => line.startsWith(ORIGINAL_LINE));
  const current = environment.read();
  const original: unknown =
    previous !== undefined && current === launcher
      ? JSON.parse(previous.slice(ORIGINAL_LINE.length))
      : (current ?? null);
  if (original !== null && typeof original !== "string")
    throw new Error("Invalid original Codex desktop executable override.");
  const realCommand =
    typeof original === "string" && original !== launcher ? original : options.realCommand;
  if (realCommand === launcher) throw new Error("The native Codex relay cannot launch itself.");
  const command = [options.nodeCommand, ...(options.nodeArguments ?? []), options.entryPath]
    .map(quoteShell)
    .join(" ");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const content = `#!/bin/sh\n${OWNER_LINE}\n${ORIGINAL_LINE}${JSON.stringify(original)}\nexec env ${quoteShell(`TIDU_CODEX_REAL_COMMAND=${realCommand}`)} ${command} "$@"\n`;
  writeLauncher(launcher, content);
  try {
    if (options.activate !== false) environment.write(launcher);
  } catch (error) {
    if (oldContent === undefined) rmSync(launcher);
    else writeLauncher(launcher, oldContent);
    throw error;
  }
  return { launcher, requiresAppRestart: true };
};

/** Switches an installed connector with the product mode, preserving the original environment. */
export const switchCodexDesktopProxy = (
  enabled: boolean,
  codexHomeDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  environment = desktopEnvironment,
): void => {
  const launcher = join(codexHomeDirectory, LAUNCHER_NAME);
  const content = readOwnedLauncher(launcher);
  if (content === undefined) return;
  const originalLine = content.split("\n").find((line) => line.startsWith(ORIGINAL_LINE));
  if (originalLine === undefined) throw new Error("Original Codex desktop override is missing.");
  const original: unknown = JSON.parse(originalLine.slice(ORIGINAL_LINE.length));
  if (original !== null && typeof original !== "string")
    throw new Error("Invalid original Codex desktop override.");
  const current = environment.read();
  if (!enabled) {
    if (current === launcher) environment.write(original ?? undefined);
    return;
  }
  if (current === launcher) return;
  if (current !== (original ?? undefined))
    throw new Error(
      "The Codex desktop executable override changed; reinstall the connector to preserve it.",
    );
  environment.write(launcher);
};

/** Removes executable configuration; official histories and account files remain untouched. */
export const removeCodexDesktopProxy = (
  codexHomeDirectory = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  environment = desktopEnvironment,
): boolean => {
  const launcher = join(codexHomeDirectory, LAUNCHER_NAME);
  if (readOwnedLauncher(launcher) === undefined) return false;
  switchCodexDesktopProxy(false, codexHomeDirectory, environment);
  rmSync(launcher);
  return true;
};

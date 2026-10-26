#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCodexCommand } from "../accounts/codex-host.js";
import { supportsNodeVersion } from "../cli/launcher.js";
import { installCodexDesktopProxy, removeCodexDesktopProxy } from "../clients/codex-desktop.js";
import { createCodexClientProxy } from "./codex-client-proxy.js";

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href) {
  if (!supportsNodeVersion(process.versions.node))
    throw new Error("AI-Tidu9 native Codex recovery requires Node.js 22.14.0 or newer.");
  const command = process.env.TIDU_CODEX_REAL_COMMAND ?? resolveCodexCommand({});
  const args = process.argv.slice(2);
  if (args[0] === "--install-desktop") {
    const result = installCodexDesktopProxy({
      realCommand: command,
      nodeCommand: process.execPath,
      entryPath: fileURLToPath(import.meta.url),
      nodeArguments: import.meta.url.endsWith(".ts")
        ? ["--import", import.meta.resolve("tsx")]
        : [],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (args[0] === "--uninstall-desktop") {
    removeCodexDesktopProxy();
  } else if (
    args.includes("app-server") &&
    // Startup policy reads are one-shot commands with ignored stdin, not JSON-RPC sessions.
    !args.some((arg) =>
      [
        "--print-startup-config",
        "--help",
        "-h",
        "--version",
        "-V",
        "daemon",
        "generate-json-schema",
        "generate-ts",
      ].includes(arg),
    ) &&
    !args.some((arg) => arg.startsWith("ws://") || arg.startsWith("--listen=ws://"))
  ) {
    const proxy = createCodexClientProxy({
      launch: { command, arguments: args, environment: process.env },
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
      ...(process.env.TIDU_CODEX_RECOVERY_PROVIDER === undefined
        ? {}
        : { managedProvider: process.env.TIDU_CODEX_RECOVERY_PROVIDER }),
    });
    process.once("SIGTERM", () => {
      void proxy.close();
    });
    process.once("SIGINT", () => {
      void proxy.close();
    });
    proxy.process.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  } else {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    process.once("SIGTERM", () => {
      child.kill("SIGTERM");
    });
    process.once("SIGINT", () => {
      child.kill("SIGINT");
    });
    child.once("error", () => {
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}

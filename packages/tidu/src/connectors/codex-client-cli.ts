#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveCodexCommand } from "../accounts/codex-host.js";
import { supportsNodeVersion } from "../cli/launcher.js";

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href) {
  if (!supportsNodeVersion(process.versions.node))
    throw new Error("AI-Tidu9 native Codex recovery requires Node.js 22.14.0 or newer.");
  const command = process.env.TIDU_CODEX_REAL_COMMAND ?? resolveCodexCommand({});
  const args = process.argv.slice(2);
  const session =
    args[0] === "--install-desktop" ||
    args[0] === "--uninstall-desktop" ||
    (args.includes("app-server") &&
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
      !args.some((arg) => arg.startsWith("ws://") || arg.startsWith("--listen=ws://")));
  if (session) {
    const { runCodexClientSession } = await import("./codex-client-session.js");
    runCodexClientSession(command, args, import.meta.url);
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

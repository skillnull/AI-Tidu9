import { fileURLToPath } from "node:url";
import { installCodexDesktopProxy, removeCodexDesktopProxy } from "../clients/codex-desktop.js";
import { createCodexClientProxy } from "./codex-client-proxy.js";

/** Loads recovery and desktop management only for commands that need those capabilities. */
export const runCodexClientSession = (command: string, args: string[], entryUrl: string): void => {
  if (args[0] === "--install-desktop") {
    const result = installCodexDesktopProxy({
      realCommand: command,
      nodeCommand: process.execPath,
      entryPath: fileURLToPath(entryUrl),
      nodeArguments: entryUrl.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (args[0] === "--uninstall-desktop") {
    removeCodexDesktopProxy();
  } else {
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
  }
};

#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PRODUCT, TiduError } from "../core/index.js";

const HELP_TEXT = `${PRODUCT.explanation}

Usage:
  tidu [command]

Commands:
  start                  Start the local runtime
  help, --help, -h       Show help
  version, --version, -v Show version

Examples:
  tidu start`;

export const runCli = (argumentsList: readonly string[]): string => {
  const [command = "help"] = argumentsList;

  if (command === "version" || command === "--version" || command === "-v") {
    return PRODUCT.version;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    return HELP_TEXT;
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
    } else {
      process.stdout.write(`${runCli(argumentsList)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

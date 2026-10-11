#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PRODUCT, TiduError } from "../core/index.js";

const HELP_TEXT = `${PRODUCT.explanation}

Usage:
  tidu [command]

Commands:
  help, --help, -h       Show help
  version, --version, -v Show version

The Agent runtime commands will be added in later release stages.`;

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
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

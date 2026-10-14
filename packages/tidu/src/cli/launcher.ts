#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_NODE_VERSION = Object.freeze([22, 14, 0] as const);

export const supportsNodeVersion = (version: string): boolean => {
  const versionParts = version.split(".").map((part) => Number(part));
  if (versionParts.length < MINIMUM_NODE_VERSION.length || versionParts.some(Number.isNaN)) {
    return false;
  }

  for (const [versionIndex, minimumPart] of MINIMUM_NODE_VERSION.entries()) {
    const versionPart = versionParts[versionIndex];
    if (versionPart === undefined) {
      return false;
    }
    if (versionPart > minimumPart) {
      return true;
    }
    if (versionPart < minimumPart) {
      return false;
    }
  }
  return true;
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  if (!supportsNodeVersion(process.versions.node)) {
    process.stderr.write(
      `${[
        `AI-Tidu9 requires Node.js 22.14.0 or newer. Current version: ${process.version}.`,
        "九门赛博提督需要 Node.js 22.14.0 或更高版本。安装程序不会自动修改本机 Node 环境。",
        "",
        "With NVM / 使用 NVM：",
        "  nvm install 22",
        "  nvm use 22",
        "  npm install -g @skillnull/tidu",
      ].join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    const implementationPath = fileURLToPath(new URL("./index.js", import.meta.url));
    process.argv[1] = implementationPath;
    await import("./index.js");
  }
}

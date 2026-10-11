import { copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "packages/tidu");
const packageAssets = Object.freeze([
  { source: resolve(repositoryRoot, "README.md"), target: resolve(packageRoot, "README.md") },
  { source: resolve(repositoryRoot, "LICENSE"), target: resolve(packageRoot, "LICENSE") },
]);

const command = process.argv[2];

if (command === "prepare") {
  for (const packageAsset of packageAssets) {
    copyFileSync(packageAsset.source, packageAsset.target);
  }
} else if (command === "clean") {
  for (const packageAsset of packageAssets) {
    if (existsSync(packageAsset.target)) {
      rmSync(packageAsset.target);
    }
  }
} else {
  throw new Error("Expected package asset command: prepare or clean.");
}

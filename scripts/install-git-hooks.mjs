import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (existsSync(resolve(repositoryRoot, ".git"))) {
  execFileSync("git", ["config", "core.hooksPath", "config/git-hooks"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  process.stdout.write("AI-Tidu9 Git policy hooks enabled.\n");
}

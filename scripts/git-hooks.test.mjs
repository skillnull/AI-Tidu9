import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(repositoryRoot, "config", "git-hooks", "pre-push");

test("pre-push skips all validation when Git has no refs to update", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-pre-push-"));
  const npmPath = join(temporaryDirectory, "npm");
  const invocationLog = join(temporaryDirectory, "npm-invocations.log");
  try {
    writeFileSync(npmPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_INVOCATION_LOG"\n');
    chmodSync(npmPath, 0o700);
    const environment = {
      ...process.env,
      HOOK_INVOCATION_LOG: invocationLog,
      PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
    };

    const unchangedPush = spawnSync("sh", [hookPath, "origin", "unused"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input: "",
    });
    assert.equal(unchangedPush.status, 0, unchangedPush.stderr);
    assert.equal(existsSync(invocationLog), false);

    const changedPush = spawnSync("sh", [hookPath, "origin", "unused"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input:
        "refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    });
    assert.equal(changedPush.status, 0, changedPush.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n"), [
      "run policy -- branch",
      "run policy -- release-lines",
      "run check",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

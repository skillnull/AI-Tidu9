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
  const nodePath = join(temporaryDirectory, "node");
  const invocationLog = join(temporaryDirectory, "node-invocations.log");
  const refsLog = join(temporaryDirectory, "refs.log");
  try {
    writeFileSync(
      nodePath,
      '#!/bin/sh\ncase "$1" in scripts/*) printf "%s\\n" "$*" >> "$HOOK_INVOCATION_LOG";; esac\nif [ "$1" = scripts/check-project.mjs ]; then cat > "$HOOK_REFS_LOG"; fi\n',
    );
    chmodSync(nodePath, 0o700);
    const environment = {
      ...process.env,
      HOOK_INVOCATION_LOG: invocationLog,
      HOOK_REFS_LOG: refsLog,
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

    const refs =
      "refs/heads/main aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
      "refs/heads/fix/example cccccccccccccccccccccccccccccccccccccccc refs/heads/fix/example dddddddddddddddddddddddddddddddddddddddd\n";
    const changedPush = spawnSync("sh", [hookPath, "origin", "unused"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input: refs,
    });
    assert.equal(changedPush.status, 0, changedPush.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n"), [
      "scripts/check-project.mjs --pre-push",
    ]);
    assert.equal(readFileSync(refsLog, "utf8"), refs);
    const committed = spawnSync("sh", [join(repositoryRoot, "config/git-hooks/pre-commit")], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(committed.status, 0, committed.stderr);
    const message = spawnSync(
      "sh",
      [join(repositoryRoot, "config/git-hooks/commit-msg"), "message.txt"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
      },
    );
    assert.equal(message.status, 0, message.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n").slice(1), [
      "scripts/sync-package-versions.mjs",
      "scripts/project-policy.mjs branch",
      "scripts/project-policy.mjs versions",
      "scripts/project-policy.mjs release-lines",
      "scripts/project-policy.mjs commit --file message.txt",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

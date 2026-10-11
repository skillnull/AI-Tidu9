import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./index.js";

test("shows concise help by default", () => {
  assert.match(runCli([]), /Usage:/);
  assert.match(runCli([]), /九门赛博提督/);
});

test("prints the planned alpha version", () => {
  assert.equal(runCli(["version"]), "0.1.0-alpha.1");
});

test("rejects unsupported commands", () => {
  assert.throws(() => runCli(["unsupported"]), /Unknown command/);
});

test("runs as an executable entry point", () => {
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const result = spawnSync(process.execPath, [executablePath, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "0.1.0-alpha.1");
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./index.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

test("shows concise help by default", () => {
  assert.match(runCli([]), /Usage:/);
  assert.match(runCli([]), /九门赛博提督/);
});

test("prints the published package version", () => {
  assert.equal(runCli(["version"]), packageVersion);
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
  assert.equal(result.stdout.trim(), packageVersion);
});

test("starts the local runtime from the executable entry point", async () => {
  const executablePath = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(process.execPath, [executablePath, "start"], {
    env: {
      ...process.env,
      TIDU_DATABASE_PATH: ":memory:",
      TIDU_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let healthVerified = false;

  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += chunk.toString();
      const origin = output.match(/Running at (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
      if (origin !== undefined) {
        const response = await fetch(`${origin}/health`);
        assert.equal(response.status, 200);
        healthVerified = true;
        break;
      }
    }
    assert.equal(healthVerified, true);
  } finally {
    if (child.exitCode === null) {
      const exitPromise = once(child, "exit");
      child.kill("SIGTERM");
      await exitPromise;
    }
  }
});

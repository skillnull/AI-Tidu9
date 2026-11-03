import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("preserves one-shot desktop startup checks with closed stdin and exact official results", {
  timeout: 30_000,
}, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "tidu-cli-startup-"));
  const fixture = join(directory, "official-fixture");
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(
    new URL(`./codex-client-cli.${source ? "ts" : "js"}`, import.meta.url),
  );
  const response =
    '{ "appServerVersion": "fixture", "configRequirements": { "requirements": null } }\n';
  writeFileSync(
    fixture,
    `#!${process.execPath}\nsetTimeout(() => {
process.stdout.write(${JSON.stringify(response)});
process.stderr.write('official diagnostic\\n');
process.exitCode = process.argv.includes('--fixture-failure') ? 7 : 0;
}, 50);\n`,
    { mode: 0o700 },
  );
  try {
    for (const invocation of [
      ["--print-startup-config", "--startup-client-info", '{"name":"codex_desktop"}'],
      ["--print-startup-config", "--startup-sign-out"],
      ["daemon", "version"],
      ["generate-json-schema"],
      ["generate-ts"],
      ["--help"],
      ["-h"],
      ["--version"],
      ["--print-startup-config", "--fixture-failure"],
    ]) {
      // All nine launches share one bounded test budget; abort terminates the active child.
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              ...(source ? ["--import", import.meta.resolve("tsx")] : []),
              entry,
              "-c",
              "features.code_mode_host=true",
              "app-server",
              "--analytics-default-enabled",
              ...invocation,
            ],
            {
              env: { ...process.env, TIDU_CODEX_REAL_COMMAND: fixture },
              stdio: ["ignore", "pipe", "pipe"],
              signal: context.signal,
            },
          );
          const output = { stdout: "", stderr: "" };
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            output.stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            output.stderr += chunk;
          });
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, ...output }));
        },
      );
      assert.equal(
        result.status,
        invocation.includes("--fixture-failure") ? 7 : 0,
        invocation.join(" "),
      );
      assert.equal(result.stdout, response);
      assert.equal(result.stderr, "official diagnostic\n");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

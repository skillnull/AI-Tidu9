import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("preserves one-shot desktop startup checks with closed stdin and exact official results", () => {
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
      const result = spawnSync(
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
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.ifError(result.error);
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

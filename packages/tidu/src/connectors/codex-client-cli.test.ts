import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createStdioJsonRpcClient } from "./json-rpc.js";

test("closing the full relay does not orphan a native child that ignores termination", {
  timeout: 10000,
  skip: process.platform === "win32",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-relay-process-tree-"));
  const fixture = join(directory, "native-fixture");
  writeFileSync(
    join(directory, "config.toml"),
    'model_provider = "ai_tidu9"\nmodel = "ai-tidu9-config"\n',
  );
  writeFileSync(
    fixture,
    `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);process.stdout.write(JSON.stringify({id:message.id,result:{processId:process.pid}})+'\\n');});`,
    { mode: 0o700 },
  );
  const source = import.meta.url.endsWith(".ts");
  const client = createStdioJsonRpcClient({
    command: process.execPath,
    arguments: [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      fileURLToPath(new URL(`./codex-client-cli.${source ? "ts" : "js"}`, import.meta.url)),
      "app-server",
    ],
    environment: {
      PATH: process.env.PATH,
      CODEX_HOME: directory,
      TIDU_CODEX_REAL_COMMAND: fixture,
    },
  });
  let nativeProcessId: number | undefined;
  let accountProcessId: number | undefined;
  let workerProcessId: number | undefined;
  try {
    const initialized = await client.request<{ processId: number }>("initialize", {});
    nativeProcessId = initialized.processId;
    accountProcessId = (await client.request<{ processId: number }>("account/read", {})).processId;
    assert.equal(accountProcessId, nativeProcessId);
    workerProcessId = (await client.request<{ processId: number }>("config/read", {})).processId;
    assert.notEqual(workerProcessId, nativeProcessId);
    await client.close();
    const ownedProcessIds = new Set([nativeProcessId, accountProcessId, workerProcessId]);
    const remainingProcessIds = new Set(ownedProcessIds);
    const deadline = Date.now() + 1000;
    while (remainingProcessIds.size > 0 && Date.now() < deadline) {
      for (const processId of remainingProcessIds) {
        try {
          process.kill(processId, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          remainingProcessIds.delete(processId);
        }
      }
      if (remainingProcessIds.size > 0) await delay(5);
    }
    for (const processId of ownedProcessIds) {
      assert.throws(() => process.kill(processId, 0), /ESRCH/u);
    }
  } finally {
    if (workerProcessId !== undefined) {
      try {
        process.kill(workerProcessId, "SIGKILL");
      } catch {}
    }
    if (accountProcessId !== undefined) {
      try {
        process.kill(accountProcessId, "SIGKILL");
      } catch {}
    }
    if (nativeProcessId !== undefined) {
      try {
        process.kill(nativeProcessId, "SIGKILL");
      } catch {}
    }
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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

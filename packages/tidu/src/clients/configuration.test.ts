import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalRuntime } from "../runtime/index.js";
import { configureCodexClient, rollbackCodexClientConfiguration } from "./configuration.js";

test("writes a dedicated Codex profile and rolls it back without touching default configuration", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-config-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(defaultConfiguration, 'model = "user-default"\n', {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const result = await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    const profilePath = join(codexHomeDirectory, "ai-tidu9.config.toml");
    const profile = readFileSync(profilePath, "utf8");

    assert.equal(result.status, "configured");
    assert.equal(result.model, "managed-default");
    assert.match(profile, /model_provider = "ai_tidu9"/u);
    assert.match(profile, new RegExp(`base_url = "${runtime.origin}/v1"`, "u"));
    assert.doesNotMatch(profile, /api[_-]?key|token|secret/iu);
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "user-default"\n');

    const rollback = rollbackCodexClientConfiguration({ codexHomeDirectory });
    assert.equal(rollback.status, "restored");
    assert.equal(existsSync(profilePath), false);
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "user-default"\n');
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("backs up and restores an earlier managed Codex profile", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-update-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });

  try {
    await configureCodexClient({ endpoint: runtime.origin, codexHomeDirectory });
    const profilePath = join(codexHomeDirectory, "ai-tidu9.config.toml");
    const originalProfile = readFileSync(profilePath, "utf8");
    await configureCodexClient({ endpoint: runtime.origin, codexHomeDirectory });
    const rollback = rollbackCodexClientConfiguration({ codexHomeDirectory });

    assert.equal(rollback.status, "restored");
    assert.equal(readFileSync(profilePath, "utf8"), originalProfile);
    assert.equal(rollbackCodexClientConfiguration({ codexHomeDirectory }).status, "restored");
    assert.equal(existsSync(profilePath), false);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("automatically rolls back when post-write connectivity verification fails", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-failure-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  let requestCount = 0;
  const request: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json({ product: "九门赛博提督", status: "ok" });
    }
    if (requestCount === 2) {
      return Response.json({
        object: "list",
        data: [{ id: "managed-default", owned_by: "AI-Tidu9" }],
      });
    }
    throw new Error("simulated disconnect");
  };

  try {
    await assert.rejects(
      configureCodexClient({
        endpoint: "http://127.0.0.1:9639",
        codexHomeDirectory,
        request,
      }),
      /Cannot reach the AI-Tidu9 runtime/u,
    );
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json")), false);
    assert.equal(rollbackCodexClientConfiguration({ codexHomeDirectory }).status, "missing");
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("refuses to overwrite an unmanaged dedicated profile", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-conflict-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0 });

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(join(codexHomeDirectory, "ai-tidu9.config.toml"), "user-owned-content\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await assert.rejects(
      configureCodexClient({ endpoint: runtime.origin, codexHomeDirectory }),
      /unmanaged or incomplete/u,
    );
    assert.equal(
      readFileSync(join(codexHomeDirectory, "ai-tidu9.config.toml"), "utf8"),
      "user-owned-content\n",
    );
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-backups")), false);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

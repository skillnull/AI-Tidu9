import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverLocalClients, formatLocalClientDiscovery } from "./index.js";

test("discovers supported clients from metadata without reading configuration contents", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-clients-"));
  const binaryDirectory = join(temporaryDirectory, "bin");
  const homeDirectory = join(temporaryDirectory, "home");
  const codexConfiguration = join(homeDirectory, ".codex/config.toml");
  const cursorApplication = join(homeDirectory, "Applications/Cursor.app");
  const cursorAgentExecutable = join(binaryDirectory, "agent");
  const openAiExecutable = join(binaryDirectory, "openai");
  const ollamaApplication = join(homeDirectory, "Applications/Ollama.app");

  try {
    mkdirSync(binaryDirectory, { recursive: true });
    mkdirSync(join(homeDirectory, ".codex"), { recursive: true });
    mkdirSync(cursorApplication, { recursive: true });
    mkdirSync(ollamaApplication, { recursive: true });
    writeFileSync(codexConfiguration, "SECRET_VALUE_MUST_NOT_BE_READ", {
      mode: 0o600,
    });
    writeFileSync(openAiExecutable, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(cursorAgentExecutable, "#!/bin/sh\n", { mode: 0o700 });
    chmodSync(openAiExecutable, 0o700);
    chmodSync(cursorAgentExecutable, 0o700);

    const discovery = discoverLocalClients({
      homeDirectory,
      executablePath: binaryDirectory,
      operatingSystem: "darwin",
      now: () => new Date("2026-10-12T00:00:00.000Z"),
    });

    assert.equal(discovery.detectedAt, "2026-10-12T00:00:00.000Z");
    assert.equal(discovery.privacy, "metadata-only");
    assert.deepEqual(discovery.clients[0]?.signals, {
      command: false,
      application: false,
      configuration: true,
      agentProtocol: false,
    });
    assert.equal(discovery.clients[0]?.readiness, "configurable");
    assert.equal(discovery.clients[1]?.signals.application, true);
    assert.equal(discovery.clients[1]?.signals.agentProtocol, true);
    assert.equal(discovery.clients[1]?.readiness, "configurable");
    assert.equal(discovery.clients[1]?.integrationMode, "native-agent");
    assert.equal(discovery.clients[1]?.limitation, null);
    assert.equal(discovery.clients[2]?.signals.command, true);
    assert.equal(discovery.clients[2]?.integrationMode, "virtual-model");
    assert.equal(discovery.clients[3]?.id, "ollama");
    assert.equal(discovery.clients[3]?.signals.application, true);
    assert.equal(discovery.clients[3]?.readiness, "configurable");
    assert.doesNotMatch(JSON.stringify(discovery), /SECRET_VALUE_MUST_NOT_BE_READ/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("reports absent clients without exposing candidate paths", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-clients-empty-"));
  try {
    const discovery = discoverLocalClients({
      homeDirectory: temporaryDirectory,
      executablePath: "",
      operatingSystem: "linux",
      now: () => new Date("2026-10-12T00:00:00.000Z"),
    });
    assert.equal(
      discovery.clients.every((client) => !client.detected),
      true,
    );
    assert.equal(
      discovery.clients.every((client) => client.readiness === "not-detected"),
      true,
    );
    assert.equal(
      discovery.clients.every((client) => client.integrationMode === "not-detected"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(discovery), new RegExp(temporaryDirectory, "u"));
    assert.match(formatLocalClientDiscovery(discovery), /metadata only/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

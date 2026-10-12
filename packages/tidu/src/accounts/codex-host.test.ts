import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCodexAppServerLaunch,
  formatCodexHostLogin,
  inspectCodexHostLogin,
  reloginCodexHost,
  switchCodexHostAccount,
} from "./codex-host.js";

const createFakeCodex = (directory: string): string => {
  const commandPath = join(directory, "codex");
  writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      '  printf "Logged in using ChatGPT\\n"',
      "  exit 0",
      "fi",
      'printf "%s\\n" "$*" >> "$CODEX_TEST_LOG"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(commandPath, 0o700);
  return commandPath;
};

test("reuses a Codex-owned login without reading credential contents", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-host-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const secretMarker = "must-never-be-returned";
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700 });
    writeFileSync(join(codexHomeDirectory, "auth.json"), secretMarker, { mode: 0o600 });
    const state = inspectCodexHostLogin({
      codexHomeDirectory,
      command: createFakeCodex(temporaryDirectory),
      environment: { CODEX_TEST_LOG: join(temporaryDirectory, "commands.log") },
    });

    assert.equal(state.status, "authenticated");
    assert.equal(state.authStoragePresent, true);
    assert.equal(state.authStorageSafe, true);
    assert.equal(state.reusable, true);
    assert.doesNotMatch(JSON.stringify(state), new RegExp(secretMarker, "u"));
    assert.doesNotMatch(formatCodexHostLogin(state), new RegExp(secretMarker, "u"));

    const launch = createCodexAppServerLaunch({
      codexHomeDirectory,
      command: join(temporaryDirectory, "codex"),
      environment: { CODEX_TEST_LOG: join(temporaryDirectory, "commands.log") },
    });
    assert.deepEqual(launch.arguments, ["app-server", "--listen", "stdio://"]);
    assert.equal(launch.environment.CODEX_HOME, codexHomeDirectory);
    assert.equal("CODEX_ACCESS_TOKEN" in launch.environment, false);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("does not trust symbolic-link authentication storage", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-unsafe-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700 });
    const targetPath = join(temporaryDirectory, "external-auth.json");
    writeFileSync(targetPath, "test-only", { mode: 0o600 });
    const linkPath = join(codexHomeDirectory, "auth.json");
    symlinkSync(targetPath, linkPath);
    const state = inspectCodexHostLogin({
      codexHomeDirectory,
      command: createFakeCodex(temporaryDirectory),
      environment: { CODEX_TEST_LOG: join(temporaryDirectory, "commands.log") },
    });
    assert.equal(state.authStorageSafe, false);
    assert.equal(state.reusable, false);
    assert.throws(
      () =>
        createCodexAppServerLaunch({
          codexHomeDirectory,
          command: join(temporaryDirectory, "codex"),
        }),
      /No reusable Codex login/u,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("runs explicit relogin and switch through official Codex commands", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-actions-"));
  const commandLogPath = join(temporaryDirectory, "commands.log");
  const command = createFakeCodex(temporaryDirectory);
  const options = {
    command,
    environment: { CODEX_TEST_LOG: commandLogPath },
    stdio: "pipe" as const,
  };
  try {
    await reloginCodexHost(options);
    await switchCodexHostAccount(options);
    assert.deepEqual(readFileSync(commandLogPath, "utf8").trim().split("\n"), [
      "login",
      "logout",
      "login",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

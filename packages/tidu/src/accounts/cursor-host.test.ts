import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCursorAcpLaunch,
  formatCursorHostLogin,
  inspectCursorHostLogin,
  reloginCursorHost,
  switchCursorHostAccount,
} from "./cursor-host.js";

const createFakeCursorAgent = (directory: string): string => {
  const commandPath = join(directory, "agent");
  writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "status" ]; then',
      '  if [ -n "$CURSOR_TEST_STATUS" ]; then',
      '    printf "%s\\n" "$CURSOR_TEST_STATUS"',
      "  else",
      '    printf "Authenticated with Cursor\\n"',
      "  fi",
      "  exit 0",
      "fi",
      'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then',
      '  printf "Start Agent Client Protocol server\\n"',
      "  exit 0",
      "fi",
      'printf "%s\\n" "$*" >> "$CURSOR_TEST_LOG"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(commandPath, 0o700);
  return commandPath;
};

test("reuses Cursor login through the official full-capability ACP process", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cursor-host-"));
  try {
    const command = createFakeCursorAgent(temporaryDirectory);
    const state = inspectCursorHostLogin({
      command,
      environment: { CURSOR_TEST_LOG: join(temporaryDirectory, "commands.log") },
    });
    assert.equal(state.status, "authenticated");
    assert.equal(state.acpAvailable, true);
    assert.equal(state.reusable, true);
    assert.match(formatCursorHostLogin(state), /official ACP endpoint available/u);

    const launch = createCursorAcpLaunch({
      command,
      environment: {
        CURSOR_API_KEY: "must-not-be-forwarded",
        CURSOR_AUTH_TOKEN: "must-not-be-forwarded",
        CURSOR_TEST_LOG: join(temporaryDirectory, "commands.log"),
      },
    });
    assert.deepEqual(launch.arguments, ["acp"]);
    assert.equal("CURSOR_API_KEY" in launch.environment, false);
    assert.equal("CURSOR_AUTH_TOKEN" in launch.environment, false);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("reports Cursor desktop without Agent CLI as unavailable for ACP", () => {
  const state = inspectCursorHostLogin({
    command: join(tmpdir(), "missing-ai-tidu9-cursor-agent"),
    environment: {},
  });
  assert.equal(state.acpAvailable, false);
  assert.equal(state.reusable, false);
  assert.throws(
    () => createCursorAcpLaunch({ command: state.command ?? "missing" }),
    /No reusable/u,
  );
});

test("does not mistake a successful not-logged-in status for authentication", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cursor-signed-out-"));
  try {
    const state = inspectCursorHostLogin({
      command: createFakeCursorAgent(temporaryDirectory),
      environment: { CURSOR_TEST_STATUS: "Not logged in" },
    });
    assert.equal(state.status, "not-authenticated");
    assert.equal(state.acpAvailable, true);
    assert.equal(state.reusable, false);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("runs explicit Cursor relogin and switch with official commands", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-cursor-actions-"));
  const commandLogPath = join(temporaryDirectory, "commands.log");
  const options = {
    command: createFakeCursorAgent(temporaryDirectory),
    environment: { CURSOR_TEST_LOG: commandLogPath },
    stdio: "pipe" as const,
  };
  try {
    await reloginCursorHost(options);
    await switchCursorHostAccount(options);
    assert.deepEqual(readFileSync(commandLogPath, "utf8").trim().split("\n"), [
      "login",
      "logout",
      "login",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

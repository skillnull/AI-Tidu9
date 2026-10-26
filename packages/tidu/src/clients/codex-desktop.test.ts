import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installCodexDesktopProxy,
  removeCodexDesktopProxy,
  switchCodexDesktopProxy,
} from "./codex-desktop.js";

test("registers a bounded executable configuration and restores the original desktop override", () => {
  const directory = mkdtempSync(join(tmpdir(), "tidu-desktop-relay-"));
  let override: string | undefined = "/original/codex";
  const environment = {
    read: () => override,
    write: (value: string | undefined) => {
      override = value;
    },
  };
  try {
    const options = {
      realCommand: "/official/codex",
      nodeCommand: "/node path/node",
      entryPath: "/module's/connector.js",
      codexHomeDirectory: directory,
      environment,
    };
    const result = installCodexDesktopProxy(options);
    assert.equal(result.requiresAppRestart, true);
    assert.equal(override, result.launcher);
    assert.ok(readFileSync(result.launcher).length < 1024);
    assert.match(
      readFileSync(result.launcher, "utf8"),
      /TIDU_CODEX_REAL_COMMAND=\/original\/codex/u,
    );
    installCodexDesktopProxy(options);
    switchCodexDesktopProxy(false, directory, environment);
    assert.equal(override, "/original/codex");
    switchCodexDesktopProxy(true, directory, environment);
    assert.equal(override, result.launcher);
    assert.equal(removeCodexDesktopProxy(directory, environment), true);
    assert.equal(override, "/original/codex");
    assert.equal(removeCodexDesktopProxy(directory, environment), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rolls back a failed registration and refuses unrelated launchers", () => {
  const directory = mkdtempSync(join(tmpdir(), "tidu-desktop-relay-"));
  try {
    const options = {
      realCommand: "/official/codex",
      nodeCommand: "/node",
      entryPath: "/connector.js",
      codexHomeDirectory: directory,
      environment: {
        read: () => undefined,
        write: () => {
          throw new Error("registration denied");
        },
      },
    };
    assert.throws(() => installCodexDesktopProxy(options), /registration denied/u);
    const launcher = join(directory, ".ai-tidu9-codex-client");
    writeFileSync(launcher, "unrelated executable");
    assert.throws(() => installCodexDesktopProxy(options), /not owned/u);
    assert.equal(readFileSync(launcher, "utf8"), "unrelated executable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepares without activating and preserves a subsequently changed official executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "tidu-desktop-relay-"));
  let override: string | undefined;
  const environment = {
    read: () => override,
    write: (value: string | undefined) => {
      override = value;
    },
  };
  try {
    const options = {
      realCommand: "/official/codex",
      nodeCommand: "/node",
      entryPath: "/connector.js",
      codexHomeDirectory: directory,
      environment,
    };
    installCodexDesktopProxy({ ...options, activate: false });
    assert.equal(override, undefined);
    override = "/new official/codex";
    installCodexDesktopProxy(options);
    removeCodexDesktopProxy(directory, environment);
    assert.equal(override, "/new official/codex");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

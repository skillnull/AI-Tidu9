import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TiduError } from "../core/index.js";
import {
  acquireRuntimeDataLock,
  archivePersonalData,
  listPersonalDataSnapshots,
  purgePersonalData,
  restoreLatestPersonalData,
} from "./index.js";

test("blocks lifecycle changes while a runtime owns the data directory", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-lifecycle-lock-"));
  const dataDirectory = join(temporaryDirectory, "AI-Tidu9");
  const databasePath = join(dataDirectory, "tidu.db");
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(databasePath, "test-data", { mode: 0o600 });
  const lock = acquireRuntimeDataLock(databasePath);

  try {
    assert.notEqual(lock, undefined);
    assert.throws(
      () => archivePersonalData(dataDirectory),
      (error) => error instanceof TiduError && error.code === "CONFIGURATION_CONFLICT",
    );
    lock?.release();
    assert.equal(archivePersonalData(dataDirectory).status, "archived");
  } finally {
    lock?.release();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("archives personal data and restores the latest snapshot without data loss", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-lifecycle-"));
  const dataDirectory = join(temporaryDirectory, "AI-Tidu9");
  const databasePath = join(dataDirectory, "tidu.db");
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(databasePath, "test-data", { mode: 0o600 });

  try {
    const archived = archivePersonalData(dataDirectory, new Date("2026-10-12T10:20:30.000Z"));
    assert.equal(archived.status, "archived");
    assert.equal(existsSync(dataDirectory), false);
    assert.notEqual(archived.snapshotDirectory, null);
    assert.equal(existsSync(archived.snapshotDirectory ?? ""), true);
    assert.deepEqual(listPersonalDataSnapshots(dataDirectory), [archived.snapshotDirectory]);

    const restored = restoreLatestPersonalData(dataDirectory);
    assert.equal(restored.status, "restored");
    assert.equal(existsSync(databasePath), true);
    assert.deepEqual(listPersonalDataSnapshots(dataDirectory), []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("restores the newest snapshot and refuses to overwrite active data", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-lifecycle-latest-"));
  const dataDirectory = join(temporaryDirectory, "AI-Tidu9");
  mkdirSync(dataDirectory, { recursive: true });

  try {
    const first = archivePersonalData(dataDirectory, new Date("2026-10-11T10:20:30.000Z"));
    mkdirSync(dataDirectory, { recursive: true });
    const second = archivePersonalData(dataDirectory, new Date("2026-10-12T10:20:30.000Z"));
    assert.deepEqual(listPersonalDataSnapshots(dataDirectory), [
      second.snapshotDirectory,
      first.snapshotDirectory,
    ]);

    restoreLatestPersonalData(dataDirectory);
    assert.throws(
      () => restoreLatestPersonalData(dataDirectory),
      (error) => error instanceof TiduError && error.code === "CONFIGURATION_CONFLICT",
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("purges only the owned data directory and its snapshots", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-lifecycle-purge-"));
  const dataDirectory = join(temporaryDirectory, "AI-Tidu9");
  const unrelatedDirectory = join(temporaryDirectory, "unrelated");
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(unrelatedDirectory, { recursive: true });

  try {
    archivePersonalData(dataDirectory, new Date("2026-10-12T10:20:30.000Z"));
    mkdirSync(dataDirectory, { recursive: true });
    const result = purgePersonalData(dataDirectory);
    assert.equal(result.status, "purged");
    assert.equal(result.removedDirectoryCount, 2);
    assert.equal(existsSync(dataDirectory), false);
    assert.equal(existsSync(unrelatedDirectory), true);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("reports missing data and rejects broad destructive targets", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-lifecycle-missing-"));
  const dataDirectory = join(temporaryDirectory, "AI-Tidu9");

  try {
    assert.equal(archivePersonalData(dataDirectory).status, "missing");
    assert.equal(restoreLatestPersonalData(dataDirectory).status, "missing");
    assert.equal(purgePersonalData(dataDirectory).status, "missing");
    assert.throws(() => purgePersonalData(homedir()), /broad or unsafe/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

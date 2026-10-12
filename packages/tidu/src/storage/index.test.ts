import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IN_MEMORY_DATABASE_PATH,
  openNodeSqliteStorage,
  STORAGE_CONTRACT_VERSION,
  STORAGE_SCHEMA_VERSION,
} from "./index.js";

test("initializes isolated in-memory storage", async () => {
  const storage = await openNodeSqliteStorage({ databasePath: IN_MEMORY_DATABASE_PATH });

  try {
    assert.equal(STORAGE_CONTRACT_VERSION, "1");
    assert.equal(storage.location, IN_MEMORY_DATABASE_PATH);
    assert.equal(storage.provider, "sqlite");
    assert.equal(storage.schemaVersion, STORAGE_SCHEMA_VERSION);
  } finally {
    storage.close();
  }
});

test("creates and reopens a persistent SQLite database", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-storage-"));
  const databasePath = join(temporaryDirectory, "nested", "tidu.db");

  try {
    const firstConnection = await openNodeSqliteStorage({ databasePath });
    firstConnection.close();
    assert.equal(existsSync(databasePath), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    }

    const secondConnection = await openNodeSqliteStorage({ databasePath });
    assert.equal(secondConnection.schemaVersion, STORAGE_SCHEMA_VERSION);
    secondConnection.close();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("rejects a database created by a newer schema", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-storage-newer-"));
  const databasePath = join(temporaryDirectory, "tidu.db");

  try {
    const storage = await openNodeSqliteStorage({ databasePath });
    storage.close();

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tidu_metadata SET value = ? WHERE key = ?").run("2", "schema_version");
    database.close();

    await assert.rejects(openNodeSqliteStorage({ databasePath }), /not supported/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

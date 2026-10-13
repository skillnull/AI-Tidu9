import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultConfiguration } from "../config/index.js";
import {
  IN_MEMORY_DATABASE_PATH,
  openNodeSqliteStorage,
  STORAGE_CONTRACT_VERSION,
  STORAGE_SCHEMA_VERSION,
} from "./index.js";

test("initializes isolated in-memory storage", async () => {
  const storage = await openNodeSqliteStorage({
    databasePath: IN_MEMORY_DATABASE_PATH,
  });

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

test("isolates drafts from each other and from the active configuration", async () => {
  const storage = await openNodeSqliteStorage({
    databasePath: IN_MEMORY_DATABASE_PATH,
  });

  try {
    const initialWorkspace = await storage.configurationStore.loadWorkspace();
    const expertDraft = initialWorkspace.drafts.expert;
    const updatedWorkspace = await storage.configurationStore.saveDraft({
      mode: "expert",
      expectedRevision: expertDraft.revision,
      configuration: {
        ...createDefaultConfiguration("expert"),
        activeProfileId: "expert-custom",
        virtualModelName: "九门专家入口",
      },
    });

    assert.equal(updatedWorkspace.active.configuration.activeMode, "managed");
    assert.equal(
      updatedWorkspace.drafts.managed.revision,
      initialWorkspace.drafts.managed.revision,
    );
    assert.equal(updatedWorkspace.drafts.expert.configuration.virtualModelName, "九门专家入口");

    const activatedWorkspace = await storage.configurationStore.activateDraft(
      "expert",
      updatedWorkspace.drafts.expert.revision,
    );
    assert.equal(activatedWorkspace.active.configuration.activeMode, "expert");
    assert.equal(activatedWorkspace.active.configuration.virtualModelName, "九门专家入口");

    const rolledBackWorkspace = await storage.configurationStore.rollbackActive();
    assert.equal(rolledBackWorkspace.active.configuration.activeMode, "managed");
    assert.equal(
      rolledBackWorkspace.active.configuration.virtualModelName,
      initialWorkspace.active.configuration.virtualModelName,
    );
  } finally {
    storage.close();
  }
});

test("rejects invalid drafts and stale revisions without changing persisted state", async () => {
  const storage = await openNodeSqliteStorage({
    databasePath: IN_MEMORY_DATABASE_PATH,
  });

  try {
    const initialWorkspace = await storage.configurationStore.loadWorkspace();
    await assert.rejects(
      storage.configurationStore.saveDraft({
        mode: "expert",
        expectedRevision: initialWorkspace.drafts.expert.revision,
        configuration: {
          ...createDefaultConfiguration("expert"),
          virtualModelName: " ",
        },
      }),
      { code: "CONFIGURATION_INVALID" },
    );
    await assert.rejects(
      storage.configurationStore.saveDraft({
        mode: "managed",
        expectedRevision: 999,
        configuration: createDefaultConfiguration("managed"),
      }),
      { code: "CONFIGURATION_CONFLICT" },
    );

    const unchangedWorkspace = await storage.configurationStore.loadWorkspace();
    assert.deepEqual(unchangedWorkspace, initialWorkspace);
  } finally {
    storage.close();
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
    database.prepare("UPDATE tidu_metadata SET value = ? WHERE key = ?").run("5", "schema_version");
    database.close();

    await assert.rejects(openNodeSqliteStorage({ databasePath }), /not supported/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("upgrades an earlier schema in place without losing existing metadata", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-storage-upgrade-"));
  const databasePath = join(temporaryDirectory, "tidu.db");
  const storageDirectory = new URL("../../storage/", import.meta.url);

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const earlierDatabase = new DatabaseSync(databasePath);
    for (const migrationFile of [
      "migrations/0001-initialize-metadata.sql",
      "migrations/0002-isolate-configuration-drafts.sql",
      "migrations/0003-add-task-capsules.sql",
    ]) {
      earlierDatabase.exec(readFileSync(new URL(migrationFile, storageDirectory), "utf8"));
    }
    earlierDatabase
      .prepare("INSERT INTO tidu_metadata (key, value) VALUES (?, ?)")
      .run("upgrade_marker", "preserved");
    earlierDatabase.close();

    const upgradedStorage = await openNodeSqliteStorage({ databasePath });
    assert.equal(upgradedStorage.schemaVersion, STORAGE_SCHEMA_VERSION);
    upgradedStorage.close();

    const verifiedDatabase = new DatabaseSync(databasePath);
    const marker = verifiedDatabase
      .prepare("SELECT value FROM tidu_metadata WHERE key = ?")
      .get("upgrade_marker") as { value: string };
    const historyTable = verifiedDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("tidu_configuration_history");
    assert.equal(marker.value, "preserved");
    assert.notEqual(historyTable, undefined);
    verifiedDatabase.close();
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

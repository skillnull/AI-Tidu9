import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteConfigurationStore } from "./sqlite-configuration-store.js";
import { createSqliteEnterpriseConnectionStore } from "./sqlite-enterprise-connection-store.js";
import { createSqliteTaskCapsuleStore } from "./sqlite-task-capsule-store.js";
import type { NodeSqliteStorageOptions, StorageAdapter } from "./types.js";

interface StorageMigrationContract {
  /** Schema version produced by this migration. */
  version: string;
  /** SQL file path relative to the storage contract directory. */
  file: string;
}

interface StorageContract {
  /** Version of the language-neutral storage contract format. */
  contractVersion: string;
  /** Latest schema version supported by this package. */
  schemaVersion: string;
  /** Ordered SQL migrations shared by every runtime implementation. */
  migrations: readonly StorageMigrationContract[];
}

const STORAGE_CONTRACT_DIRECTORY = new URL("../../storage/", import.meta.url);
const STORAGE_CONTRACT = JSON.parse(
  readFileSync(new URL("contract.json", STORAGE_CONTRACT_DIRECTORY), "utf8"),
) as StorageContract;

export const STORAGE_CONTRACT_VERSION = STORAGE_CONTRACT.contractVersion;
export const STORAGE_SCHEMA_VERSION = STORAGE_CONTRACT.schemaVersion;
export const IN_MEMORY_DATABASE_PATH = ":memory:";

const isPositiveInteger = (value: string): boolean => /^[1-9]\d*$/u.test(value);

const validateStorageContract = (): void => {
  if (
    !isPositiveInteger(STORAGE_CONTRACT_VERSION) ||
    !isPositiveInteger(STORAGE_SCHEMA_VERSION) ||
    STORAGE_CONTRACT.migrations.length === 0
  ) {
    throw new Error("The storage contract is invalid.");
  }

  let previousVersion = 0;
  for (const migration of STORAGE_CONTRACT.migrations) {
    const migrationVersion = Number(migration.version);
    if (
      !isPositiveInteger(migration.version) ||
      migrationVersion <= previousVersion ||
      !/^migrations\/[0-9]{4}-[a-z0-9-]+\.sql$/u.test(migration.file)
    ) {
      throw new Error("The storage migration sequence is invalid.");
    }
    previousVersion = migrationVersion;
  }

  if (String(previousVersion) !== STORAGE_SCHEMA_VERSION) {
    throw new Error("The storage contract schema version does not match its migrations.");
  }
};

validateStorageContract();

export const resolveDefaultDatabasePath = (): string => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "AI-Tidu9", "tidu.db");
  }

  if (process.platform === "win32") {
    const localDataDirectory =
      process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local");
    return join(localDataDirectory, "AI-Tidu9", "tidu.db");
  }

  const dataDirectory = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataDirectory, "ai-tidu9", "tidu.db");
};

const readSchemaVersion = (database: DatabaseSync): string => {
  const metadataTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("tidu_metadata");
  if (metadataTable === undefined) {
    return "0";
  }

  const metadata = database
    .prepare("SELECT value FROM tidu_metadata WHERE key = ?")
    .get("schema_version") as { value?: unknown } | undefined;
  return typeof metadata?.value === "string" ? metadata.value : "0";
};

const applyMigrations = (database: DatabaseSync): string => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA journal_mode = WAL;
  `);

  let currentVersion = readSchemaVersion(database);
  if (!/^\d+$/u.test(currentVersion) || Number(currentVersion) > Number(STORAGE_SCHEMA_VERSION)) {
    throw new Error(
      `SQLite schema ${currentVersion} is not supported; expected at most ${STORAGE_SCHEMA_VERSION}.`,
    );
  }

  for (const migration of STORAGE_CONTRACT.migrations) {
    if (Number(migration.version) <= Number(currentVersion)) {
      continue;
    }

    const migrationSql = readFileSync(new URL(migration.file, STORAGE_CONTRACT_DIRECTORY), "utf8");
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec(migrationSql);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    currentVersion = readSchemaVersion(database);
    if (currentVersion !== migration.version) {
      throw new Error(`Storage migration ${migration.version} did not update the schema version.`);
    }
  }

  if (currentVersion !== STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema ${currentVersion} is not supported; expected ${STORAGE_SCHEMA_VERSION}.`,
    );
  }

  return currentVersion;
};

const inspectTables = (database: DatabaseSync): readonly { name: string; rowCount: number }[] => {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return tables.map((table) => {
    const escapedName = table.name.replaceAll('"', '""');
    const result = database.prepare(`SELECT COUNT(*) AS row_count FROM "${escapedName}"`).get() as {
      row_count: number;
    };
    return { name: table.name, rowCount: result.row_count };
  });
};

export const openNodeSqliteStorage = async (
  options: NodeSqliteStorageOptions = {},
): Promise<StorageAdapter> => {
  const databasePath = options.databasePath ?? resolveDefaultDatabasePath();
  if (databasePath !== IN_MEMORY_DATABASE_PATH) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const databaseFile = openSync(databasePath, "a", 0o600);
    closeSync(databaseFile);
    if (process.platform !== "win32") {
      chmodSync(databasePath, 0o600);
    }
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

  try {
    const schemaVersion = applyMigrations(database);
    const configurationStore = createSqliteConfigurationStore(database);
    const enterpriseConnectionStore = createSqliteEnterpriseConnectionStore(database);
    const taskCapsuleStore = createSqliteTaskCapsuleStore(database);
    let isClosed = false;

    return {
      configurationStore,
      enterpriseConnectionStore,
      taskCapsuleStore,
      provider: "sqlite",
      location: databasePath,
      schemaVersion,
      get tables() {
        return inspectTables(database);
      },
      close: () => {
        if (!isClosed) {
          database.close();
          isClosed = true;
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
};

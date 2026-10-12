import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";

import { TiduError } from "../core/index.js";
import { resolveDefaultDatabasePath } from "../storage/index.js";

export type PersonalDataLifecycleStatus = "archived" | "missing" | "purged" | "restored";

export interface PersonalDataLifecycleResult {
  /** Lifecycle operation outcome. */
  status: PersonalDataLifecycleStatus;
  /** Current personal-data directory. */
  dataDirectory: string;
  /** Snapshot used or created by the operation when applicable. */
  snapshotDirectory: string | null;
  /** Number of owned data directories removed by a purge. */
  removedDirectoryCount: number;
}

export interface RuntimeDataLock {
  /** Absolute runtime-lock file path. */
  path: string;
  /** Releases this process-owned lock without removing a replacement lock. */
  release: () => void;
}

const SNAPSHOT_MARKER = ".snapshot.";
const RUNTIME_LOCK_FILE_NAME = ".runtime.lock";
const INCOMPLETE_LOCK_GRACE_MILLISECONDS = 30_000;

export const resolvePersonalDataDirectory = (): string => dirname(resolveDefaultDatabasePath());

const validateOwnedDataDirectory = (dataDirectory: string): string => {
  const normalizedDirectory = resolve(dataDirectory);
  const rootDirectory = parse(normalizedDirectory).root;
  if (normalizedDirectory === rootDirectory || normalizedDirectory === resolve(homedir())) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Refusing to manage a broad or unsafe personal-data directory.",
    );
  }
  return normalizedDirectory;
};

const assertRealDirectory = (directory: string): void => {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Personal data and snapshots must be real directories, not symbolic links.",
    );
  }
};

const isProcessActive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readRuntimeLock = (lockPath: string): { processId: number; token: string } | undefined => {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as {
      processId?: unknown;
      token?: unknown;
    };
    if (Number.isInteger(value.processId) && typeof value.token === "string") {
      return { processId: Number(value.processId), token: value.token };
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const assertDataDirectoryUnlocked = (dataDirectory: string): void => {
  const lockPath = resolve(dataDirectory, RUNTIME_LOCK_FILE_NAME);
  if (!existsSync(lockPath)) {
    return;
  }
  const lock = readRuntimeLock(lockPath);
  if (lock === undefined) {
    const lockAge = Date.now() - lstatSync(lockPath).mtimeMs;
    if (lockAge < INCOMPLETE_LOCK_GRACE_MILLISECONDS) {
      throw new TiduError("CONFIGURATION_CONFLICT", "Runtime data is being locked.");
    }
    rmSync(lockPath, { force: true });
    return;
  }
  if (isProcessActive(lock.processId)) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Stop the running personal runtime before changing its data.",
    );
  }
  rmSync(lockPath, { force: true });
};

export const acquireRuntimeDataLock = (databasePath: string): RuntimeDataLock | undefined => {
  if (databasePath === ":memory:") {
    return undefined;
  }
  const dataDirectory = validateOwnedDataDirectory(dirname(databasePath));
  const lockPath = resolve(dataDirectory, RUNTIME_LOCK_FILE_NAME);
  assertDataDirectoryUnlocked(dataDirectory);
  const token = randomUUID();
  let lockFile: number;
  try {
    lockFile = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new TiduError("CONFIGURATION_CONFLICT", "Runtime data is already in use.", {
      cause: error,
    });
  }
  try {
    writeFileSync(lockFile, JSON.stringify({ processId: process.pid, token }), "utf8");
  } catch (error) {
    closeSync(lockFile);
    rmSync(lockPath, { force: true });
    throw error;
  }
  closeSync(lockFile);
  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (readRuntimeLock(lockPath)?.token === token) {
        rmSync(lockPath, { force: true });
      }
    },
  };
};

const snapshotPrefix = (dataDirectory: string): string =>
  `${basename(dataDirectory)}${SNAPSHOT_MARKER}`;

export const listPersonalDataSnapshots = (
  dataDirectory = resolvePersonalDataDirectory(),
): readonly string[] => {
  const normalizedDirectory = validateOwnedDataDirectory(dataDirectory);
  const parentDirectory = dirname(normalizedDirectory);
  if (!existsSync(parentDirectory)) {
    return [];
  }
  const prefix = snapshotPrefix(normalizedDirectory);
  return readdirSync(parentDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix),
    )
    .map((entry) => resolve(parentDirectory, entry.name))
    .sort()
    .reverse();
};

const createSnapshotDirectory = (dataDirectory: string, timestamp: Date): string => {
  const compactTimestamp = timestamp.toISOString().replace(/[-:.]/gu, "");
  const prefix = `${snapshotPrefix(dataDirectory)}${compactTimestamp}`;
  let candidate = resolve(dirname(dataDirectory), prefix);
  let collisionIndex = 1;
  while (existsSync(candidate)) {
    collisionIndex += 1;
    candidate = resolve(dirname(dataDirectory), `${prefix}.${collisionIndex}`);
  }
  return candidate;
};

export const archivePersonalData = (
  dataDirectory = resolvePersonalDataDirectory(),
  timestamp = new Date(),
): PersonalDataLifecycleResult => {
  const normalizedDirectory = validateOwnedDataDirectory(dataDirectory);
  if (!existsSync(normalizedDirectory)) {
    return {
      status: "missing",
      dataDirectory: normalizedDirectory,
      snapshotDirectory: null,
      removedDirectoryCount: 0,
    };
  }
  assertRealDirectory(normalizedDirectory);
  assertDataDirectoryUnlocked(normalizedDirectory);
  const snapshotDirectory = createSnapshotDirectory(normalizedDirectory, timestamp);
  renameSync(normalizedDirectory, snapshotDirectory);
  return {
    status: "archived",
    dataDirectory: normalizedDirectory,
    snapshotDirectory,
    removedDirectoryCount: 0,
  };
};

export const restoreLatestPersonalData = (
  dataDirectory = resolvePersonalDataDirectory(),
): PersonalDataLifecycleResult => {
  const normalizedDirectory = validateOwnedDataDirectory(dataDirectory);
  if (existsSync(normalizedDirectory)) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "Personal data already exists; restore will not overwrite it.",
    );
  }
  const snapshotDirectory = listPersonalDataSnapshots(normalizedDirectory)[0];
  if (snapshotDirectory === undefined) {
    return {
      status: "missing",
      dataDirectory: normalizedDirectory,
      snapshotDirectory: null,
      removedDirectoryCount: 0,
    };
  }
  assertRealDirectory(snapshotDirectory);
  assertDataDirectoryUnlocked(snapshotDirectory);
  renameSync(snapshotDirectory, normalizedDirectory);
  return {
    status: "restored",
    dataDirectory: normalizedDirectory,
    snapshotDirectory,
    removedDirectoryCount: 0,
  };
};

export const purgePersonalData = (
  dataDirectory = resolvePersonalDataDirectory(),
): PersonalDataLifecycleResult => {
  const normalizedDirectory = validateOwnedDataDirectory(dataDirectory);
  const ownedDirectories = [
    ...(existsSync(normalizedDirectory) ? [normalizedDirectory] : []),
    ...listPersonalDataSnapshots(normalizedDirectory),
  ];
  for (const ownedDirectory of ownedDirectories) {
    assertRealDirectory(ownedDirectory);
    assertDataDirectoryUnlocked(ownedDirectory);
    rmSync(ownedDirectory, { force: true, recursive: true });
  }
  return {
    status: ownedDirectories.length === 0 ? "missing" : "purged",
    dataDirectory: normalizedDirectory,
    snapshotDirectory: null,
    removedDirectoryCount: ownedDirectories.length,
  };
};

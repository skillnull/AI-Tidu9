import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TiduError } from "../core/index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Compatibility defaults used only when no matching native harness is available. */
export const DEFAULT_CODEX_HARNESS: Readonly<Record<string, unknown>> = {
  shell_type: "unified_exec",
  base_instructions: "You are Codex, an AI coding agent.",
  model_messages: {
    instructions_template: "You are Codex, an AI coding agent.",
    instructions_variables: {
      personality_default: "",
      personality_friendly: "",
      personality_pragmatic: "",
    },
    approvals: null,
    auto_review: null,
    permissions: null,
  },
  include_skills_usage_instructions: true,
  apply_patch_tool_type: "freeform",
  tool_mode: null,
  multi_agent_version: null,
};

const HARNESS_FIELDS = new Set([
  ...Object.keys(DEFAULT_CODEX_HARNESS),
  "node_repl_auto_review_required",
  "node_repl_disabled",
]);
const isHarnessField = (field: string): boolean =>
  HARNESS_FIELDS.has(field) || /^include_[a-z0-9_]+_usage_instructions$/u.test(field);
const baseVersion = (version: unknown): string | undefined =>
  typeof version === "string"
    ? /^(?:codex-cli\s+)?(\d+\.\d+\.\d+)(?:-[a-z0-9.-]+)?$/iu.exec(version.trim())?.[1]
    : undefined;
const fingerprint = (content: string): string => createHash("sha256").update(content).digest("hex");

const catalogLocks = new Map<string, { references: number; release: () => void }>();
const requireBuiltin = createRequire(import.meta.url);
const loadCatalogSqlite = () => {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = (...parameters: unknown[]) => {
      const [warning, type] = parameters;
      if (
        warning === "SQLite is an experimental feature and might change at any time" &&
        (type === "ExperimentalWarning" || (isRecord(type) && type.type === "ExperimentalWarning"))
      )
        return;
      Reflect.apply(emitWarning, process, parameters);
    };
    return requireBuiltin("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
};

/** Owns only a synchronous catalog/state commit; network validation must release it first. */
export const acquireManagedCodexCatalogLock = (codexHomeDirectory: string) => {
  const home = resolve(codexHomeDirectory);
  let held = catalogLocks.get(home);
  if (held === undefined) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const directory = join(home, ".ai-tidu9-catalog-lock");
    const homeStatus = lstatSync(home);
    if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink())
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        "Unsafe Codex catalog configuration directory.",
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const status = lstatSync(directory);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new TiduError("CONFIGURATION_CONFLICT", "Unsafe Codex catalog configuration lock.");
    const databasePath = join(directory, "lease.sqlite");
    let database: DatabaseSync | undefined;
    try {
      try {
        closeSync(openSync(databasePath, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const databaseStatus = lstatSync(databasePath);
      if (
        !databaseStatus.isFile() ||
        databaseStatus.isSymbolicLink() ||
        databaseStatus.size > 1024 * 1024
      )
        throw new TiduError("CONFIGURATION_CONFLICT", "Unsafe Codex catalog configuration lock.");
      chmodSync(databasePath, 0o600);
      const { DatabaseSync } = loadCatalogSqlite();
      database = new DatabaseSync(databasePath, { allowExtension: false });
      database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    } catch (error) {
      database?.close();
      if (error instanceof TiduError) throw error;
      const nativeCode = (error as { errcode?: unknown }).errcode;
      throw new TiduError(
        "CONFIGURATION_CONFLICT",
        nativeCode === 5 || nativeCode === 6
          ? "Codex model catalog configuration is being updated by another process."
          : "Codex model catalog configuration lock is unavailable.",
        { cause: error },
      );
    }
    const ownedDatabase = database;
    held = {
      references: 0,
      release: () => {
        try {
          ownedDatabase.exec("ROLLBACK;");
        } finally {
          ownedDatabase.close();
        }
        // The shared inode must remain stable while other processes may open it.
      },
    };
    catalogLocks.set(home, held);
  }
  held.references += 1;
  const owned = held;
  let released = false;
  return {
    /** Releases this lease once; nested synchronous commits keep the outer lease alive. */
    release: () => {
      if (released) return;
      released = true;
      owned.references -= 1;
      if (owned.references === 0) {
        catalogLocks.delete(home);
        owned.release();
      }
    },
  };
};

/** Runs a synchronous commit without waiting behind another process's configuration change. */
export const withManagedCodexCatalogLock = <Result>(home: string, commit: () => Result): Result => {
  const lock = acquireManagedCodexCatalogLock(home);
  try {
    return commit();
  } finally {
    lock.release();
  }
};

const readRegularFile = (filePath: string): string | undefined => {
  try {
    const status = lstatSync(filePath);
    return status.isFile() && !status.isSymbolicLink() && status.size <= 32 * 1024 * 1024
      ? readFileSync(filePath, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
};
const parseObject = (content: string | undefined): Record<string, unknown> | undefined => {
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
const singleManagedEntry = (
  catalog: Record<string, unknown> | undefined,
  model?: unknown,
): Record<string, unknown> | undefined => {
  const models = catalog?.models;
  const entry = Array.isArray(models) && models.length === 1 ? models[0] : undefined;
  return isRecord(entry) &&
    typeof entry.slug === "string" &&
    (model === undefined || entry.slug === model)
    ? entry
    : undefined;
};
const withHarness = (
  managed: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...managed };
  const fields = new Set([...Object.keys(managed), ...Object.keys(source), ...HARNESS_FIELDS]);
  for (const field of fields) {
    if (!isHarnessField(field)) continue;
    if (Object.hasOwn(source, field)) result[field] = source[field];
    else if (
      field === "base_instructions" &&
      isRecord(source.model_messages) &&
      typeof source.model_messages.instructions_template === "string"
    )
      delete result[field];
    else if (Object.hasOwn(DEFAULT_CODEX_HARNESS, field))
      result[field] = DEFAULT_CODEX_HARNESS[field];
    else delete result[field];
  }
  return result;
};

export interface ManagedCodexCatalogRefreshOptions {
  /** Isolated or user-selected Codex home containing only the relevant catalog artifacts. */
  codexHomeDirectory: string;
  /** Version reported by the actual native host executable, including prerelease suffixes. */
  hostVersion?: string;
}

export interface ManagedCodexCatalogRefreshResult {
  /** Whether the owned managed catalog was atomically updated. */
  changed: boolean;
  /** Effective host/catalog fingerprint, or null when no compatible source is available. */
  fingerprint: string | null;
}

const matchedCatalog = (
  options: ManagedCodexCatalogRefreshOptions,
  catalog: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const hostVersion = baseVersion(options.hostVersion);
  if (hostVersion === undefined) return undefined;
  const home = options.codexHomeDirectory;
  const state = parseObject(readRegularFile(join(home, ".ai-tidu9-profile-state.json")));
  if (state?.owner !== "AI-Tidu9" || state.profile !== "ai-tidu9") return undefined;
  const managed = singleManagedEntry(catalog, state.model);
  if (managed === undefined) return undefined;
  const cache = parseObject(readRegularFile(join(home, "models_cache.json")));
  if (cache === undefined || baseVersion(cache.client_version) !== hostVersion) return undefined;
  const models = Array.isArray(cache.models)
    ? cache.models.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const visible = models.filter(
    (entry) =>
      typeof entry.slug === "string" &&
      entry.slug !== state.model &&
      entry.visibility === "list" &&
      entry.supported_in_api === true,
  );
  const source =
    typeof state.officialModel === "string"
      ? models.find((entry) => entry.slug === state.officialModel)
      : visible.length === 1
        ? visible[0]
        : undefined;
  if (
    source === undefined ||
    source.slug === state.model ||
    (source.model_messages !== undefined &&
      source.model_messages !== null &&
      !isRecord(source.model_messages))
  )
    return undefined;
  return {
    ...catalog,
    client_version: hostVersion,
    models: [withHarness(managed, source)],
  };
};

/** Preserves a previously confirmed harness when a configuration transaction changes route declarations. */
export const preserveManagedCodexHarness = (
  codexHomeDirectory: string,
  content: string,
): string => {
  const catalog = parseObject(content);
  const managed = singleManagedEntry(catalog);
  const previous = parseObject(
    readRegularFile(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json")),
  );
  const confirmed = singleManagedEntry(previous, managed?.slug);
  if (catalog === undefined || managed === undefined || confirmed === undefined) return content;
  const version = baseVersion(previous?.client_version);
  if (version === undefined) return content;
  const inherited = matchedCatalog({ codexHomeDirectory, hostVersion: version }, catalog);
  return `${JSON.stringify(
    inherited ?? {
      ...catalog,
      client_version: version,
      models: [withHarness(managed, confirmed)],
    },
    null,
    2,
  )}\n`;
};

/** Refreshes only an already-owned catalog; missing or incompatible sources leave it unchanged. */
export const refreshManagedCodexCatalog = (
  options: ManagedCodexCatalogRefreshOptions,
): ManagedCodexCatalogRefreshResult => {
  const unchanged = { changed: false, fingerprint: null };
  const home = options.codexHomeDirectory;
  const catalogPath = join(home, ".ai-tidu9-model-catalog.json");
  const current = readRegularFile(catalogPath);
  const catalog = parseObject(current);
  if (current === undefined || catalog === undefined) return unchanged;
  const statePath = join(home, ".ai-tidu9-profile-state.json");
  const inherited = matchedCatalog(options, catalog);
  if (inherited === undefined) return unchanged;
  let lock: ReturnType<typeof acquireManagedCodexCatalogLock>;
  try {
    lock = acquireManagedCodexCatalogLock(home);
  } catch {
    return unchanged;
  }
  try {
    const lockedCurrent = readRegularFile(catalogPath);
    const lockedCatalog = parseObject(lockedCurrent);
    if (lockedCurrent === undefined || lockedCatalog === undefined) return unchanged;
    const lockedState = readRegularFile(statePath);
    const lockedInherited = matchedCatalog(options, lockedCatalog);
    if (lockedInherited === undefined) return unchanged;
    const content = `${JSON.stringify(lockedInherited, null, 2)}\n`;
    const effectiveFingerprint = fingerprint(
      JSON.stringify({ hostVersion: options.hostVersion, content }),
    );
    if (content === lockedCurrent) return { changed: false, fingerprint: effectiveFingerprint };
    if (
      readRegularFile(catalogPath) !== lockedCurrent ||
      readRegularFile(statePath) !== lockedState
    )
      return unchanged;
    const temporary = `${catalogPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, catalogPath);
      chmodSync(catalogPath, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { changed: true, fingerprint: effectiveFingerprint };
  } finally {
    lock.release();
  }
};

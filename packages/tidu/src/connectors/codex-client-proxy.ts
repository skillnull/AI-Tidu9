import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { refreshManagedCodexCatalog } from "../clients/codex-model-catalog.js";
import {
  indexCodexRecoveryRecords,
  readCodexRecoveryRecords,
  recoverCodexTurn,
} from "../clients/codex-recovery.js";
import { createCodexThreadLinks } from "./codex-thread-links.js";
import type { JsonRpcProcessLaunch } from "./json-rpc.js";

type JsonObject = Record<string, unknown>;
interface NativeChannel {
  process: ChildProcessWithoutNullStreams;
  ready?: Promise<void>;
  /** Prevents completed turns or stale approvals from moving to a replacement worker. */
  failed?: boolean;
  /** Compatible managed catalog loaded when this worker was created. */
  catalogFingerprint?: string | null;
  terminate: () => Promise<void>;
}
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idKey = (id: unknown): string => JSON.stringify(id);
const TURN_PROVIDER_HISTORY_FILE = ".ai-tidu9-turn-providers.jsonl";
const MAXIMUM_TURN_PROVIDER_HISTORY_BYTES = 1024 * 1024;
const MAXIMUM_TURN_PROVIDER_ENTRIES = 512;
const DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS = 5_000;
const INTERNAL_REQUEST_ID_PREFIX = "tidu_recovery_";

interface StoredTurnSelection {
  /** Official thread identifier. */
  threadId: string;
  /** Official turn identifier. */
  turnId: string;
  /** Provider active when the turn began. */
  modelProvider: string;
  /** Model alias active when the turn began. */
  model?: string;
}

export interface CodexClientProxyOptions {
  /** Official executable, arguments, environment, and cwd; approvals remain with this process. */
  launch: JsonRpcProcessLaunch;
  /** Native client's newline-framed input. */
  input: Readable;
  /** Native client's newline-framed output. */
  output: Writable;
  /** Stderr sink; model output and session contents are never logged here. */
  errorOutput: Writable;
  /** Provider whose native display requires recovery; official model events pass through. */
  managedProvider?: string;
  /** Optional active-mode resolver for isolated protocol tests. */
  resolveActiveSelection?: () => CodexActiveSelection;
  /** Bounded wait for proxy-only official requests; defaults to five seconds. */
  internalRequestTimeoutMs?: number;
  /** Confirmed executable version for embedded hosts; otherwise inspected from launch.command. */
  hostVersion?: string;
}

export interface CodexActiveSelection {
  /** Provider selected by the current global Codex mode. */
  modelProvider: string;
  /** Current default model, when the configuration declares one. */
  model?: string;
}

export interface CodexClientProxy {
  /** Official app-server process. */
  process: ChildProcessWithoutNullStreams;
  /** Closes the transport and official child without writing additional history. */
  close: () => Promise<void>;
}

const parseTomlString = (value: string): string | undefined => {
  const literal = /^("(?:[^"\\]|\\.)*"|'[^']*')(?:\s+#.*)?$/u.exec(value.trim())?.[1];
  if (literal === undefined) return undefined;
  try {
    return literal.startsWith('"') ? (JSON.parse(literal) as string) : literal.slice(1, -1);
  } catch {
    return undefined;
  }
};

const readTopLevelSelection = (content: string): Partial<CodexActiveSelection> => {
  const selection: Partial<CodexActiveSelection> = {};
  for (const line of content.split("\n")) {
    if (/^\s*\[/u.test(line)) break;
    const assignment = /^\s*(model|model_provider)\s*=\s*(.+)$/u.exec(line);
    if (assignment === null) continue;
    const value = parseTomlString(assignment[2] ?? "");
    if (value === undefined || value.trim() === "") continue;
    if (assignment[1] === "model_provider") selection.modelProvider = value;
    else selection.model = value;
  }
  return selection;
};

const readConfigOverrides = (arguments_: readonly string[]): Partial<CodexActiveSelection> => {
  const selection: Partial<CodexActiveSelection> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const override =
      argument === "-c" || argument === "--config"
        ? arguments_[++index]
        : argument.startsWith("--config=")
          ? argument.slice("--config=".length)
          : undefined;
    if (override === undefined) continue;
    const assignment = /^(model|model_provider)\s*=\s*(.+)$/u.exec(override.trim());
    if (assignment === null) continue;
    const value = parseTomlString(assignment[2] ?? "");
    if (value === undefined || value.trim() === "") continue;
    if (assignment[1] === "model_provider") selection.modelProvider = value;
    else selection.model = value;
  }
  return selection;
};

const readStoredTurnSelections = (codexHome: string): Map<string, StoredTurnSelection> => {
  const historyPath = join(codexHome, TURN_PROVIDER_HISTORY_FILE);
  const selections = new Map<string, StoredTurnSelection>();
  if (!existsSync(historyPath)) return selections;
  try {
    const status = lstatSync(historyPath);
    if (!status.isFile() || status.isSymbolicLink()) return selections;
    const bytesToRead = Math.min(status.size, MAXIMUM_TURN_PROVIDER_HISTORY_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const descriptor = openSync(historyPath, "r");
    try {
      readSync(descriptor, buffer, 0, bytesToRead, Math.max(0, status.size - bytesToRead));
    } finally {
      closeSync(descriptor);
    }
    const content = buffer.toString("utf8");
    const completeContent =
      status.size > bytesToRead ? content.slice(Math.max(0, content.indexOf("\n") + 1)) : content;
    for (const line of completeContent.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !isRecord(value) ||
        typeof value.threadId !== "string" ||
        value.threadId.length > 256 ||
        typeof value.turnId !== "string" ||
        value.turnId.length > 256 ||
        typeof value.modelProvider !== "string" ||
        value.modelProvider.length > 256 ||
        (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 256))
      )
        continue;
      const selection = value as unknown as StoredTurnSelection;
      const key = `${selection.threadId}:${selection.turnId}`;
      selections.delete(key);
      selections.set(key, selection);
      if (selections.size > MAXIMUM_TURN_PROVIDER_ENTRIES) {
        const oldest = selections.keys().next().value;
        if (oldest !== undefined) selections.delete(oldest);
      }
    }
  } catch {
    return new Map();
  }
  return selections;
};

const storeTurnSelection = (codexHome: string, selection: StoredTurnSelection): void => {
  const historyPath = join(codexHome, TURN_PROVIDER_HISTORY_FILE);
  let temporaryPath: string | undefined;
  try {
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (existsSync(historyPath)) {
      const status = lstatSync(historyPath);
      if (!status.isFile() || status.isSymbolicLink()) return;
    }
    appendFileSync(historyPath, `${JSON.stringify(selection)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(historyPath, 0o600);
    if (statSync(historyPath).size <= MAXIMUM_TURN_PROVIDER_HISTORY_BYTES) return;
    const retained = [...readStoredTurnSelections(codexHome).values()];
    temporaryPath = `${historyPath}.${randomUUID()}.tmp`;
    writeFileSync(
      temporaryPath,
      retained.length === 0 ? "" : `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    renameSync(temporaryPath, historyPath);
  } catch {
    if (temporaryPath !== undefined) rmSync(temporaryPath, { force: true });
    // Recovery metadata must never block the official app-server transport.
  }
};

/** Reads only the active top-level model selection; provider secrets and tables are ignored. */
export const readCodexActiveSelection = (
  codexHome: string,
  launchArguments: readonly string[] = [],
): CodexActiveSelection => {
  const configurationPath = join(codexHome, "config.toml");
  const configured = existsSync(configurationPath)
    ? readTopLevelSelection(readFileSync(configurationPath, "utf8"))
    : {};
  const overridden = readConfigOverrides(launchArguments);
  const modelProvider = overridden.modelProvider ?? configured.modelProvider ?? "openai";
  return {
    modelProvider,
    ...(overridden.model !== undefined
      ? { model: overridden.model }
      : configured.model !== undefined
        ? { model: configured.model }
        : {}),
  };
};

const readOfficialBootstrapSelection = (
  codexHome: string,
  selection: CodexActiveSelection,
  managedProvider: string,
): CodexActiveSelection => {
  if (selection.modelProvider !== managedProvider) return selection;
  const path = join(codexHome, ".ai-tidu9-profile-state.json");
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 1024 * 1024)
      return { modelProvider: "openai" };
    const state: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(state) && state.owner === "AI-Tidu9") {
      const original = readTopLevelSelection(
        Array.isArray(state.officialDefaultLines)
          ? state.officialDefaultLines
              .filter((line): line is string => typeof line === "string")
              .join("\n")
          : "",
      );
      return {
        modelProvider:
          original.modelProvider !== undefined && original.modelProvider !== managedProvider
            ? original.modelProvider
            : "openai",
        ...(original.model !== undefined
          ? { model: original.model }
          : typeof state.officialModel === "string"
            ? { model: state.officialModel }
            : {}),
      };
    }
  } catch {
    /* Missing recovery metadata must not disable native authentication. */
  }
  return { modelProvider: "openai" };
};

const applyActiveSelection = (
  params: JsonObject,
  selection: CodexActiveSelection,
  currentProvider?: string,
): JsonObject => {
  const sourceProvider =
    currentProvider ??
    (typeof params.modelProvider === "string" ? params.modelProvider : undefined);
  const changedProvider =
    sourceProvider !== undefined && sourceProvider !== selection.modelProvider;
  const updated: JsonObject = {
    ...params,
    modelProvider: selection.modelProvider,
  };
  if (selection.model !== undefined) updated.model = selection.model;
  else if (changedProvider) delete updated.model;
  return updated;
};

const applyActiveModel = (
  params: JsonObject,
  model: string,
  previousMode?: unknown,
): JsonObject => {
  const collaborationMode = isRecord(params.collaborationMode)
    ? params.collaborationMode
    : isRecord(previousMode)
      ? previousMode
      : undefined;
  return {
    ...params,
    model,
    ...(collaborationMode !== undefined && isRecord(collaborationMode.settings)
      ? {
          collaborationMode: {
            ...collaborationMode,
            settings: { ...collaborationMode.settings, model },
          },
        }
      : {}),
  };
};

const readActiveModelList = (
  codexHome: string,
  selection: CodexActiveSelection,
  params: JsonObject,
  managedProvider: string,
): JsonObject | undefined => {
  if (selection.model === undefined) return undefined;
  const catalogPath = join(
    codexHome,
    selection.modelProvider === managedProvider
      ? ".ai-tidu9-model-catalog.json"
      : "models_cache.json",
  );
  if (
    !existsSync(catalogPath) ||
    !lstatSync(catalogPath).isFile() ||
    lstatSync(catalogPath).isSymbolicLink()
  )
    return undefined;
  let catalog: unknown;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) return undefined;
  const models = catalog.models
    .filter(isRecord)
    .filter(
      (model) =>
        typeof model.slug === "string" &&
        typeof model.display_name === "string" &&
        model.supported_in_api === true &&
        (selection.modelProvider === managedProvider
          ? model.slug === selection.model
          : model.slug !== "ai-tidu9-config") &&
        (params.includeHidden === true || model.visibility === "list"),
    )
    .map((model) => ({
      ...(selection.modelProvider === managedProvider ? {} : model),
      id: model.slug,
      model: model.slug,
      displayName: model.display_name,
      description: typeof model.description === "string" ? model.description : "",
      hidden: model.visibility !== "list",
      isDefault: model.slug === selection.model,
      defaultReasoningEffort: model.default_reasoning_level ?? "none",
      supportedReasoningEfforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .filter(isRecord)
            .filter((level) => typeof level.effort === "string")
            .map((level) => ({
              ...(selection.modelProvider === managedProvider ? {} : level),
              reasoningEffort: level.effort,
              description: typeof level.description === "string" ? level.description : "",
            }))
        : [],
      ...(Array.isArray(model.input_modalities) ? { inputModalities: model.input_modalities } : {}),
      ...(selection.modelProvider === managedProvider
        ? { supportsPersonality: false }
        : typeof model.supports_personality === "boolean"
          ? { supportsPersonality: model.supports_personality }
          : typeof model.supportsPersonality === "boolean"
            ? { supportsPersonality: model.supportsPersonality }
            : {}),
    }));
  if (models.length === 0) return undefined;
  const offset =
    typeof params.cursor === "string" && /^tidu_models:\d+$/u.test(params.cursor)
      ? Number(params.cursor.slice("tidu_models:".length))
      : 0;
  const limit =
    typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0
      ? params.limit
      : models.length;
  return {
    data: models.slice(offset, offset + limit),
    nextCursor: offset + limit < models.length ? `tidu_models:${offset + limit}` : null,
  };
};

/** Transparent native-client relay. Derives cancelled presentation from the official session only. */
export const createCodexClientProxy = (options: CodexClientProxyOptions): CodexClientProxy => {
  const internalRequestTimeoutMs =
    options.internalRequestTimeoutMs ?? DEFAULT_INTERNAL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(internalRequestTimeoutMs) || internalRequestTimeoutMs <= 0) {
    throw new Error("Codex proxy internal request timeout must be a positive safe integer.");
  }
  const codexHome = options.launch.environment.CODEX_HOME ?? join(homedir(), ".codex");
  const provider = options.managedProvider ?? "ai_tidu9";
  const resolveActiveSelection =
    options.resolveActiveSelection ??
    (() => readCodexActiveSelection(codexHome, options.launch.arguments));
  const launchSelection = resolveActiveSelection();
  const bootstrap = readOfficialBootstrapSelection(codexHome, launchSelection, provider);
  let managedCatalogFingerprint: string | null = null;
  let inspectedHost: { revision: string; version: Promise<string | undefined> } | undefined;
  const hostVersion = (): Promise<string | undefined> => {
    if (options.hostVersion !== undefined) return Promise.resolve(options.hostVersion);
    let revision: string;
    try {
      const status = statSync(options.launch.command);
      revision = `${status.dev}:${status.ino}:${status.size}:${status.mtimeMs}`;
    } catch {
      return Promise.resolve(undefined);
    }
    if (inspectedHost?.revision === revision) return inspectedHost.version;
    const version = new Promise<string | undefined>((resolve) => {
      const probe = spawn(options.launch.command, ["--version"], {
        env: options.launch.environment,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      let settled = false;
      const finish = (value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        probe.kill("SIGTERM");
        finish();
      }, internalRequestTimeoutMs);
      probe.stdout.on("data", (chunk: Buffer) => {
        if (output.length < 4096) output += chunk.toString("utf8");
      });
      probe.once("error", () => finish());
      probe.once("close", () => finish(/^codex(?:-cli)?\s+([^\s]+)/u.exec(output.trim())?.[1]));
    });
    inspectedHost = { revision, version };
    return version;
  };
  const spawnNative = (selection: CodexActiveSelection): NativeChannel => {
    const process = spawn(
      options.launch.command,
      [
        "-c",
        `model_provider=${JSON.stringify(selection.modelProvider)}`,
        ...(selection.model === undefined
          ? []
          : ["-c", `model=${JSON.stringify(selection.model)}`]),
        ...options.launch.arguments,
      ],
      {
        env: options.launch.environment,
        cwd: options.launch.workingDirectory,
        stdio: "pipe",
      },
    );
    const childEnded = new Promise<void>((resolve) => process.once("close", () => resolve()));
    let termination: Promise<void> | undefined;
    const terminateChild = (): Promise<void> => {
      termination ??= (async () => {
        if (process.exitCode !== null || process.signalCode !== null) return childEnded;
        const force = setTimeout(() => process.kill("SIGKILL"), 1000);
        force.unref();
        try {
          process.kill("SIGTERM");
          await childEnded;
        } finally {
          clearTimeout(force);
        }
      })();
      return termination;
    };
    return {
      process,
      terminate: terminateChild,
      ...(selection.modelProvider === provider
        ? { catalogFingerprint: managedCatalogFingerprint }
        : {}),
    };
  };
  // The desktop login remains in its original official process. Execution workers never receive it.
  const primary = spawnNative(bootstrap);
  const child = primary.process;
  const channels = new Map<string, NativeChannel>([[bootstrap.modelProvider, primary]]);
  const retiredChannels = new Set<NativeChannel>();
  const threadOwners = new Map<string, NativeChannel>();
  const turnOwners = new Map<
    string,
    {
      threadId: string;
      logicalThreadId: string;
      turnId: string;
      channel: NativeChannel;
      active: boolean;
      failed?: boolean;
    }
  >();
  const serverRequests = new Map<string, { id: unknown; channel: NativeChannel }>();
  const serverReaders = new Set<ReturnType<typeof createInterface>>();
  let initializationParams: unknown;
  const terminateChildren = async (): Promise<void> => {
    await Promise.all(
      [...new Set([...channels.values(), ...retiredChannels])].map((channel) =>
        channel.terminate(),
      ),
    );
  };
  const threadLinks = createCodexThreadLinks(codexHome);
  const migrations = new Map<string, string>();
  let emptyContinuation: Promise<unknown> | undefined;
  const emptyContinuationIds = new Set<string>();
  const requests = new Map<
    string,
    {
      method: string;
      threadId?: string;
      turnId?: string;
      itemIds?: string[];
      cursor?: unknown;
      sortDirection?: unknown;
      startParams?: JsonObject;
      channel?: NativeChannel;
      received?: boolean;
    }
  >();
  const internal = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      method: string;
      channel?: NativeChannel;
    }
  >();
  const turnSelections = new Map<
    string,
    { startedAt?: number; modelProvider: string; model?: string }
  >(
    [...readStoredTurnSelections(codexHome)].map(([key, selection]) => [
      key,
      {
        modelProvider: selection.modelProvider,
        ...(selection.model === undefined ? {} : { model: selection.model }),
      },
    ]),
  );
  const threads = new Map<string, JsonObject>();
  const runningThreads = new Set<string>();
  const terminalTurns = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      turn: JsonObject;
      footer: string;
      footerItemId: string;
    }
  >();
  let sequence = Promise.resolve();
  let closed = false;
  const send = (message: unknown): void => {
    if (!closed && options.output.writable)
      options.output.write(
        `${JSON.stringify(isRecord(message) ? threadLinks.toClient(message) : message)}\n`,
      );
  };
  const getChannel = (selection: CodexActiveSelection): NativeChannel => {
    const existing = channels.get(selection.modelProvider);
    if (existing !== undefined) return existing;
    const channel = spawnNative(selection);
    channels.set(selection.modelProvider, channel);
    attachNative(channel);
    if (initializationParams !== undefined) {
      channel.ready = request("initialize", initializationParams, channel, false).then(() => {
        writeChild({ method: "initialized" }, channel, false);
      });
    }
    return channel;
  };
  const writeChild = (message: JsonObject, target?: NativeChannel, waitForReady = true): void => {
    const originalParams = isRecord(message.params) ? message.params : {};
    const turnId =
      message.method === "turn/interrupt"
        ? originalParams.turnId
        : message.method === "turn/steer"
          ? originalParams.expectedTurnId
          : undefined;
    const turnOwner =
      typeof originalParams.threadId === "string" && typeof turnId === "string"
        ? turnOwners.get(`${threadLinks.logical(originalParams.threadId)}:${turnId}`)
        : undefined;
    let forwarded =
      turnOwner === undefined
        ? threadLinks.toServer(message)
        : { ...message, params: { ...originalParams, threadId: turnOwner.threadId } };
    const params = isRecord(forwarded.params) ? forwarded.params : {};
    const method = typeof forwarded.method === "string" ? forwarded.method : "";
    let channel = target ?? turnOwner?.channel;
    if (channel === undefined && method === "" && "id" in forwarded) {
      const responseKey = idKey(forwarded.id);
      const pending = serverRequests.get(responseKey);
      if (pending !== undefined) {
        channel = pending.channel;
        forwarded = { ...forwarded, id: pending.id };
        serverRequests.delete(responseKey);
      }
    }
    channel ??=
      ["thread/start", "thread/resume", "thread/fork"].includes(method) &&
      typeof params.modelProvider === "string"
        ? getChannel({
            modelProvider: params.modelProvider,
            ...(typeof params.model === "string" ? { model: params.model } : {}),
          })
        : typeof params.threadId === "string"
          ? (threadOwners.get(params.threadId) ?? getChannel(resolveActiveSelection()))
          : ["thread/list", "model/list", "config/read"].includes(method)
            ? getChannel(resolveActiveSelection())
            : primary;
    const destination = channel;
    const requestKey = idKey(message.id);
    const pendingInternal = internal.get(requestKey);
    if (pendingInternal !== undefined) pendingInternal.channel = destination;
    const pendingClient = requests.get(requestKey);
    if (pendingClient !== undefined) pendingClient.channel = destination;
    if (destination.failed) {
      if (method === "") return;
      throw new Error("Native execution worker connection closed.");
    }
    const write = (): void => {
      if (closed || destination.failed || !destination.process.stdin.writable)
        throw new Error("Native Codex connection is unavailable.");
      destination.process.stdin.write(`${JSON.stringify(forwarded)}\n`);
    };
    if (!waitForReady || destination.ready === undefined) write();
    else
      void destination.ready.then(write).catch((error: unknown) => {
        const pending = internal.get(idKey(message.id));
        const failure = error instanceof Error ? error : new Error("Native initialization failed.");
        if (pending !== undefined) {
          internal.delete(idKey(message.id));
          pending.reject(failure);
        } else if ("id" in message && requests.delete(idKey(message.id))) {
          send({ id: message.id, error: { code: -32_001, message: failure.message } });
        }
      });
  };
  let rateLimitsRefresh: Promise<void> | undefined;
  const refreshOfficialRateLimits = (): void => {
    if (rateLimitsRefresh !== undefined) return;
    rateLimitsRefresh = request("account/rateLimits/read", undefined)
      .then((result) => {
        if (closed || resolveActiveSelection().modelProvider !== provider) return;
        if (isRecord(result) && isRecord(result.rateLimits))
          send({ method: "account/rateLimits/updated", params: { rateLimits: result.rateLimits } });
      })
      // Keep the last official snapshot when a metadata refresh is unavailable.
      .catch(() => undefined)
      .finally(() => {
        rateLimitsRefresh = undefined;
      });
  };
  const request = (
    method: string,
    params: unknown,
    channel?: NativeChannel,
    waitForReady = true,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || !child.stdin.writable) {
        reject(new Error("Official Codex connection is unavailable."));
        return;
      }
      const id = `${INTERNAL_REQUEST_ID_PREFIX}${randomUUID()}`;
      const requestKey = idKey(id);
      const timeout = setTimeout(() => {
        internal.delete(requestKey);
        reject(new Error(`Official Codex did not answer ${method} in time.`));
      }, internalRequestTimeoutMs);
      internal.set(requestKey, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });
      try {
        writeChild({ jsonrpc: "2.0", id, method, params }, channel, waitForReady);
      } catch (error) {
        clearTimeout(timeout);
        internal.delete(requestKey);
        reject(error);
      }
    });
  const rememberThread = (thread: JsonObject, settings?: JsonObject, loaded?: boolean): void => {
    if (typeof thread.id !== "string") return;
    const threadId = threadLinks.logical(thread.id);
    const continuationId = threadLinks.current(threadId);
    const previous = threads.get(threadId);
    threads.set(threadId, {
      id: threadId,
      continuationId,
      loaded: loaded ?? (previous?.continuationId === continuationId && previous?.loaded === true),
      modelProvider: settings?.modelProvider ?? thread.modelProvider ?? previous?.modelProvider,
      model: settings?.model ?? thread.model ?? previous?.model,
      collaborationMode:
        settings?.collaborationMode ?? thread.collaborationMode ?? previous?.collaborationMode,
      empty: previous?.empty,
      approvalPolicy: settings?.approvalPolicy ?? previous?.approvalPolicy,
      sandbox: settings?.sandbox ?? previous?.sandbox,
      startParams: previous?.startParams,
      path: thread.path ?? previous?.path,
      cwd: thread.cwd ?? previous?.cwd,
    });
    if (threads.size > 32) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
  };
  const resumeThread = async (
    threadId: string,
    selection: CodexActiveSelection,
    params: JsonObject = { threadId, excludeTurns: true },
  ): Promise<JsonObject> => {
    const cached = threads.get(threadId);
    const known = cached?.continuationId === threadLinks.current(threadId) ? cached : undefined;
    if (known !== cached) threads.delete(threadId);
    const sourceThreadId = threadLinks.current(threadId);
    const previousOwner = threadOwners.get(sourceThreadId);
    const targetChannel =
      runningThreads.has(threadId) && previousOwner !== undefined
        ? previousOwner
        : getChannel(selection);
    const changedWorker = previousOwner !== undefined && previousOwner !== targetChannel;
    const changedProvider = known !== undefined && known.modelProvider !== selection.modelProvider;
    if ((changedProvider || changedWorker) && previousOwner !== undefined) {
      await request("thread/unsubscribe", { threadId }, previousOwner);
      if (threadOwners.get(sourceThreadId) === previousOwner) threadOwners.delete(sourceThreadId);
    }
    const updatedParams = applyActiveSelection(
      params,
      selection,
      typeof known?.modelProvider === "string" ? known.modelProvider : undefined,
    );
    let result: unknown;
    if (
      (changedProvider || changedWorker) &&
      known?.empty === true &&
      isRecord(known.startParams)
    ) {
      const source = threadLinks.current(threadId);
      const startParams = { ...known.startParams, ...updatedParams };
      delete startParams.threadId;
      delete startParams.excludeTurns;
      if (selection.model === undefined) delete startParams.model;
      const pending = request("thread/start", startParams, targetChannel).then((response) => {
        if (
          !isRecord(response) ||
          !isRecord(response.thread) ||
          typeof response.thread.id !== "string"
        )
          throw new Error("Official Codex did not return the empty continued chat.");
        threadLinks.record(threadId, response.thread.id, source);
        emptyContinuationIds.add(response.thread.id);
        return threadLinks.toClient({ result: response }).result;
      });
      emptyContinuation = pending;
      try {
        result = await pending;
      } finally {
        if (emptyContinuation === pending) emptyContinuation = undefined;
      }
    } else {
      // Unsubscription does not immediately release the previous process's history writer.
      let requiresFork = changedProvider || changedWorker;
      if (!requiresFork) {
        try {
          result = await request("thread/resume", updatedParams, targetChannel);
        } catch (error) {
          if (
            !isRecord(error) ||
            !isRecord(error.data) ||
            error.data.type !== "modelProviderMismatch"
          )
            throw error;
          requiresFork = true;
        }
      }
      if (requiresFork) {
        const source = threadLinks.current(threadId);
        migrations.set(source, threadId);
        try {
          // A provider change requires an official continuation, never a rewritten rollout.
          result = await request("thread/fork", updatedParams, targetChannel);
          if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== "string")
            throw new Error("Official Codex did not return the continued chat.");
          threadLinks.record(threadId, result.thread.id, source);
          result = threadLinks.toClient({ result }).result;
        } finally {
          migrations.delete(source);
        }
      }
    }
    result = threadLinks.toClient({ result }).result;
    if (!isRecord(result) || !isRecord(result.thread))
      throw new Error("Official Codex did not return the resumed chat.");
    rememberThread(result.thread, result, true);
    return result;
  };
  const ensureActiveThreadSelection = async (
    threadId: string,
    selection: CodexActiveSelection,
  ): Promise<JsonObject | undefined> => {
    const known = threads.get(threadId);
    if (
      known?.modelProvider === selection.modelProvider &&
      known.loaded === true &&
      known.continuationId === threadLinks.current(threadId) &&
      (runningThreads.has(threadId) ||
        threadOwners.get(threadLinks.current(threadId)) ===
          channels.get(selection.modelProvider)) &&
      (selection.model === undefined || known.model === selection.model)
    )
      return;
    return resumeThread(threadId, selection);
  };
  const reapRetiredChannels = (): void => {
    for (const channel of retiredChannels) {
      if (
        [...threadOwners.values()].includes(channel) ||
        [...turnOwners.values()].some((owner) => owner.channel === channel && owner.active) ||
        [...serverRequests.values()].some((pending) => pending.channel === channel) ||
        [...requests.values(), ...internal.values()].some((pending) => pending.channel === channel)
      )
        continue;
      retiredChannels.delete(channel);
      void channel.terminate().catch(() => undefined);
    }
  };
  const refreshCatalogForNewTurn = async (selection: CodexActiveSelection): Promise<void> => {
    if (
      selection.modelProvider !== provider ||
      !existsSync(join(codexHome, "models_cache.json")) ||
      !existsSync(join(codexHome, ".ai-tidu9-model-catalog.json"))
    )
      return;
    try {
      const refreshed = refreshManagedCodexCatalog({
        codexHomeDirectory: codexHome,
        hostVersion: await hostVersion(),
      });
      if (refreshed.fingerprint === null) return;
      managedCatalogFingerprint = refreshed.fingerprint;
      const previous = channels.get(provider);
      if (
        previous === undefined ||
        previous === primary ||
        previous.catalogFingerprint === refreshed.fingerprint
      )
        return;
      channels.delete(provider);
      retiredChannels.add(previous);
      reapRetiredChannels();
    } catch {
      // Optional metadata refresh cannot replace the last compatible native catalog with unverified data.
    }
  };
  const loadLiveTurn = async (threadId: string, turn: JsonObject, managedTurnConfirmed = false) => {
    const metadata = await request("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (
      !isRecord(metadata) ||
      !isRecord(metadata.thread) ||
      (!managedTurnConfirmed && metadata.thread.modelProvider !== provider)
    )
      return undefined;
    const thread = metadata.thread;
    const page = await request("thread/items/list", {
      threadId,
      turnId: turn.id,
      sortDirection: "desc",
      limit: 100,
    });
    const items =
      isRecord(page) && Array.isArray(page.data)
        ? page.data
            .filter(isRecord)
            .filter((entry) => entry.turnId === turn.id && isRecord(entry.item))
            .map((entry) => entry.item)
            .reverse()
        : [];
    return {
      /** Official thread metadata, without loading other turns. */
      thread,
      /** Current turn's latest native items only. */
      saved: { ...turn, items },
      /** Bounded read-only evidence for missing cancelled items and counters. */
      records:
        typeof thread.path === "string"
          ? await readCodexRecoveryRecords(thread.path, codexHome)
          : [],
    };
  };
  const recoverThread = async (thread: JsonObject): Promise<JsonObject> => {
    rememberThread(thread);
    if (typeof thread.path !== "string" || !Array.isArray(thread.turns)) return thread;
    const cancelled = thread.turns.filter(
      (turn): turn is JsonObject =>
        isRecord(turn) && (turn.status === "interrupted" || turn.status === "failed"),
    );
    if (cancelled.length === 0) return thread;
    let records: readonly unknown[];
    try {
      records = await readCodexRecoveryRecords(thread.path, codexHome);
    } catch {
      // Recovery is optional presentation metadata and must not affect official chat reads.
      return thread;
    }
    const byTurn = indexCodexRecoveryRecords(records);
    return {
      ...thread,
      turns: thread.turns.map((turn) =>
        isRecord(turn) && (turn.status === "interrupted" || turn.status === "failed")
          ? recoverCodexTurn(
              turn,
              byTurn.get(String(turn.id)) ?? [],
              typeof thread.cwd === "string" ? thread.cwd : "",
              provider,
              undefined,
              turnSelections.get(`${String(thread.id)}:${String(turn.id)}`)?.modelProvider ===
                provider,
            ).turn
          : turn,
      ),
    };
  };
  const processMessage = async (message: JsonObject, receivedAt: number): Promise<void> => {
    const params = isRecord(message.params) ? message.params : undefined;
    if (message.method === "thread/closed" && typeof params?.threadId === "string") {
      const thread = threads.get(params.threadId);
      if (thread !== undefined) thread.loaded = false;
      runningThreads.delete(params.threadId);
    }
    if (
      message.method === "account/rateLimits/updated" &&
      resolveActiveSelection().modelProvider === provider
    ) {
      // Local-provider snapshots lack official quotas; refresh without delaying turn events.
      refreshOfficialRateLimits();
      return;
    }
    if (
      message.method === "thread/settings/updated" &&
      typeof params?.threadId === "string" &&
      isRecord(params.threadSettings)
    ) {
      rememberThread({ id: params.threadId, ...params.threadSettings });
    }
    if (
      message.method === "thread/tokenUsage/updated" &&
      typeof params?.threadId === "string" &&
      typeof params.turnId === "string"
    ) {
      const terminal = terminalTurns.get(`${params.threadId}:${params.turnId}`);
      if (terminal !== undefined) {
        send(message);
        try {
          const snapshot = await loadLiveTurn(terminal.threadId, terminal.turn, true);
          if (snapshot !== undefined) {
            const { saved, thread, records } = snapshot;
            const recovered = recoverCodexTurn(
              saved,
              records,
              typeof thread.cwd === "string" ? thread.cwd : "",
              provider,
              undefined,
              true,
            );
            const footerItem = recovered.completedItems.find(
              (item) => item.type === "agentMessage" && typeof item.text === "string",
            );
            const footer =
              typeof footerItem?.text === "string"
                ? footerItem.text.slice(footerItem.text.lastIndexOf("\n") + 1)
                : "";
            if (footer !== terminal.footer) {
              const original = Array.isArray(saved.items)
                ? saved.items.find((item) => isRecord(item) && item.id === terminal.footerItemId)
                : undefined;
              const item =
                footerItem ??
                (isRecord(original)
                  ? original
                  : {
                      type: "agentMessage",
                      id: terminal.footerItemId,
                      text: "",
                      phase: "final_answer",
                      memoryCitation: null,
                      delivery: null,
                      questions: null,
                    });
              if (
                terminal.footer === "" &&
                item.id === `tidu_usage_${terminal.turnId}` &&
                footer !== ""
              )
                send({
                  jsonrpc: "2.0",
                  method: "item/started",
                  params: {
                    threadId: terminal.threadId,
                    turnId: terminal.turnId,
                    startedAtMs: receivedAt,
                    item: { ...item, text: "" },
                  },
                });
              send({
                jsonrpc: "2.0",
                method: "item/completed",
                params: {
                  threadId: terminal.threadId,
                  turnId: terminal.turnId,
                  completedAtMs: receivedAt,
                  item,
                },
              });
              terminal.footer = footer;
              terminal.footerItemId = String(item.id);
            }
          }
        } catch {
          options.errorOutput.write("AI-Tidu9 could not refresh late official token usage.\n");
        }
        return;
      }
    }
    if (
      message.method === "turn/started" &&
      typeof params?.threadId === "string" &&
      isRecord(params.turn) &&
      typeof params.turn.id === "string"
    ) {
      runningThreads.add(params.threadId);
      const thread = threads.get(params.threadId);
      if (thread !== undefined) thread.empty = false;
      if (typeof thread?.modelProvider === "string") {
        const key = `${params.threadId}:${params.turn.id}`;
        turnSelections.set(key, {
          startedAt: receivedAt,
          modelProvider: thread.modelProvider,
          ...(typeof thread.model === "string" ? { model: thread.model } : {}),
        });
        storeTurnSelection(codexHome, {
          threadId: params.threadId,
          turnId: params.turn.id,
          modelProvider: thread.modelProvider,
          ...(typeof thread.model === "string" ? { model: thread.model } : {}),
        });
        if (turnSelections.size > MAXIMUM_TURN_PROVIDER_ENTRIES) {
          const oldest = turnSelections.keys().next().value;
          if (oldest !== undefined) turnSelections.delete(oldest);
        }
      }
    }
    if (
      message.method === "turn/completed" &&
      typeof params?.threadId === "string" &&
      isRecord(params.turn)
    ) {
      const threadId = params.threadId;
      if (
        ![...turnOwners.values()].some(
          (owner) => owner.logicalThreadId === threadId && owner.active,
        )
      )
        runningThreads.delete(threadId);
      synchronizeSelection();
      const key = `${threadId}:${String(params.turn.id)}`;
      const turnSelection = turnSelections.get(key);
      const startedAt = turnSelection?.startedAt;
      if (
        turnSelection?.modelProvider === provider &&
        (params.turn.status === "interrupted" || params.turn.status === "failed")
      ) {
        try {
          const snapshot = await loadLiveTurn(threadId, params.turn, true);
          if (snapshot !== undefined) {
            const { thread, saved, records } = snapshot;
            const recovered = recoverCodexTurn(
              saved,
              records,
              typeof thread.cwd === "string" ? thread.cwd : "",
              provider,
              undefined,
              true,
            );
            const footerItem = recovered.completedItems.find(
              (item) => item.type === "agentMessage" && typeof item.text === "string",
            );
            terminalTurns.set(key, {
              threadId,
              turnId: String(params.turn.id),
              turn: {
                id: params.turn.id,
                status: params.turn.status,
                durationMs: recovered.turn.durationMs,
              },
              footer:
                typeof footerItem?.text === "string"
                  ? footerItem.text.slice(footerItem.text.lastIndexOf("\n") + 1)
                  : "",
              footerItemId:
                typeof footerItem?.id === "string"
                  ? footerItem.id
                  : `tidu_usage_${String(params.turn.id)}`,
            });
            if (terminalTurns.size > 32) {
              const oldest = terminalTurns.keys().next().value;
              if (oldest !== undefined) terminalTurns.delete(oldest);
            }
            const savedItemIds = new Set(
              (Array.isArray(saved.items) ? saved.items : [])
                .filter(isRecord)
                .flatMap((item) => (typeof item.id === "string" ? [item.id] : [])),
            );
            for (const item of recovered.completedItems) {
              if (
                item.type === "agentMessage" &&
                typeof item.id === "string" &&
                !savedItemIds.has(item.id)
              )
                send({
                  jsonrpc: "2.0",
                  method: "item/started",
                  params: {
                    threadId,
                    turnId: params.turn.id,
                    startedAtMs: receivedAt,
                    item: { ...item, text: "" },
                  },
                });
              send({
                jsonrpc: "2.0",
                method: "item/completed",
                params: {
                  threadId,
                  turnId: params.turn.id,
                  completedAtMs: receivedAt,
                  item,
                },
              });
            }
            const durationMs =
              typeof recovered.turn.durationMs === "number" && recovered.turn.durationMs > 0
                ? recovered.turn.durationMs
                : startedAt === undefined
                  ? params.turn.durationMs
                  : Math.max(0, receivedAt - startedAt);
            send({
              ...message,
              params: { ...params, turn: { ...params.turn, durationMs } },
            });
            return;
          }
        } catch {
          options.errorOutput.write(
            "AI-Tidu9 could not derive cancelled display from official session history.\n",
          );
        }
      }
    }
    if (message.method === undefined && "id" in message) {
      const context = requests.get(idKey(message.id));
      const method = context?.method;
      requests.delete(idKey(message.id));
      if (
        method === "thread/unsubscribe" &&
        context?.threadId !== undefined &&
        isRecord(message.result)
      ) {
        const thread = threads.get(context.threadId);
        if (thread !== undefined) thread.loaded = false;
      }
      if (
        method !== undefined &&
        ["thread/start", "thread/read", "thread/resume", "thread/fork"].includes(method) &&
        isRecord(message.result) &&
        isRecord(message.result.thread)
      ) {
        rememberThread(
          message.result.thread,
          message.result,
          method === "thread/read" ? undefined : context?.channel?.failed !== true,
        );
        if (method === "thread/start" && context?.startParams !== undefined) {
          const thread = threads.get(String(message.result.thread.id));
          if (thread !== undefined) {
            thread.startParams = context.startParams;
            thread.empty = true;
          }
        }
        try {
          send({
            ...message,
            result: {
              ...message.result,
              thread: await recoverThread(message.result.thread),
            },
          });
          return;
        } catch {
          options.errorOutput.write(
            "AI-Tidu9 could not derive saved display from official session history.\n",
          );
        }
      }
      if (
        context?.threadId !== undefined &&
        method !== undefined &&
        ["thread/turns/list", "thread/items/list", "thread/items/read"].includes(method) &&
        isRecord(message.result) &&
        Array.isArray(message.result.data)
      ) {
        try {
          let thread = threads.get(context.threadId);
          if (thread === undefined) {
            const metadata = await request("thread/read", {
              threadId: context.threadId,
              includeTurns: false,
            });
            if (isRecord(metadata) && isRecord(metadata.thread)) {
              rememberThread(metadata.thread);
              thread = metadata.thread;
            }
          }
          if (typeof thread?.path === "string") {
            let recoveryRecords: readonly unknown[];
            try {
              recoveryRecords = await readCodexRecoveryRecords(thread.path, codexHome);
            } catch {
              // Optional presentation recovery must not fail or warn on an official page read.
              send(message);
              return;
            }
            const byTurn = indexCodexRecoveryRecords(recoveryRecords);
            const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
            if (method === "thread/turns/list") {
              send({
                ...message,
                result: {
                  ...message.result,
                  data: message.result.data.map((turn) =>
                    isRecord(turn)
                      ? recoverCodexTurn(
                          turn,
                          byTurn.get(String(turn.id)) ?? [],
                          cwd,
                          provider,
                          undefined,
                          turnSelections.get(`${context.threadId}:${String(turn.id)}`)
                            ?.modelProvider === provider,
                        ).turn
                      : turn,
                  ),
                },
              });
              return;
            }
            const descending = context.sortDirection === "desc";
            const atBoundary =
              method === "thread/items/read" ||
              (descending ? context.cursor == null : message.result.nextCursor === null);
            if (atBoundary) {
              const data = message.result.data.filter(isRecord);
              const turnIds =
                context.turnId === undefined
                  ? [...new Set(data.map((entry) => String(entry.turnId)))]
                  : [context.turnId];
              const added: JsonObject[] = [];
              for (const turnId of turnIds) {
                const records = byTurn.get(turnId) ?? [];
                if (
                  !records.some(
                    (record) =>
                      isRecord(record) &&
                      isRecord(record.payload) &&
                      record.payload.type === "turn_aborted",
                  )
                )
                  continue;
                const existing = data
                  .filter((entry) => entry.turnId === turnId)
                  .map((entry) => entry.item);
                const recovered = recoverCodexTurn(
                  { id: turnId, status: "interrupted", items: existing },
                  records,
                  cwd,
                  provider,
                  undefined,
                  turnSelections.get(`${context.threadId}:${turnId}`)?.modelProvider === provider,
                );
                for (const item of recovered.completedItems) {
                  if (method === "thread/items/read" && !context.itemIds?.includes(String(item.id)))
                    continue;
                  const existingIndex = data.findIndex(
                    (entry) =>
                      entry.turnId === turnId && isRecord(entry.item) && entry.item.id === item.id,
                  );
                  if (existingIndex >= 0)
                    data[existingIndex] = {
                      ...data[existingIndex],
                      item,
                      turnId,
                    };
                  else added.push({ item, turnId });
                }
              }
              send({
                ...message,
                result: {
                  ...message.result,
                  data: descending ? [...added.reverse(), ...data] : [...data, ...added],
                },
              });
              return;
            }
          }
        } catch {
          options.errorOutput.write(
            "AI-Tidu9 could not derive paginated display from official session history.\n",
          );
        }
      }
    }
    send(message);
  };
  const fromClient = createInterface({ input: options.input });
  let clientSequence = Promise.resolve();
  let observedSelection = JSON.stringify(resolveActiveSelection());
  const synchronizeSelection = (): void => {
    clientSequence = clientSequence
      .then(async () => {
        const selection = resolveActiveSelection();
        if (JSON.stringify(selection) === observedSelection) return;
        for (const threadId of threads.keys()) {
          if (runningThreads.has(threadId)) continue;
          const resumed = await ensureActiveThreadSelection(threadId, selection);
          if (selection.model !== undefined) {
            await request(
              "thread/settings/update",
              applyActiveModel(
                { threadId },
                selection.model,
                threads.get(threadId)?.collaborationMode,
              ),
            );
          }
          if (
            resumed !== undefined &&
            typeof resumed.model === "string" &&
            typeof resumed.modelProvider === "string"
          ) {
            const threadSettings = applyActiveModel(
              {
                modelProvider: resumed.modelProvider,
                cwd: resumed.cwd,
                approvalPolicy: resumed.approvalPolicy,
                approvalsReviewer: resumed.approvalsReviewer,
                sandboxPolicy: resumed.sandbox,
                activePermissionProfile: resumed.activePermissionProfile,
                collaborationMode: resumed.collaborationMode,
                effort: resumed.reasoningEffort,
                serviceTier: resumed.serviceTier,
                disabledPluginIds: resumed.disabledPluginIds,
              },
              resumed.model,
              threads.get(threadId)?.collaborationMode,
            );
            send({ method: "thread/settings/updated", params: { threadId, threadSettings } });
          }
        }
        if (runningThreads.size === 0) observedSelection = JSON.stringify(selection);
      })
      .catch(() => {
        options.errorOutput.write("AI-Tidu9 could not synchronize the native model selection.\n");
      });
  };
  const configurationPath = join(codexHome, "config.toml");
  if (options.resolveActiveSelection === undefined) {
    watchFile(configurationPath, { persistent: false, interval: 250 }, synchronizeSelection);
  }
  fromClient.on("line", (line) => {
    let parsedMessage: unknown;
    try {
      parsedMessage = JSON.parse(line) as unknown;
    } catch {
      options.errorOutput.write("AI-Tidu9 received invalid client JSON-RPC.\n");
      return;
    }
    if (isRecord(parsedMessage) && parsedMessage.method === undefined && "id" in parsedMessage) {
      // Responses to server-initiated approvals must not wait behind mode synchronization.
      writeChild(parsedMessage);
      return;
    }
    if (isRecord(parsedMessage) && parsedMessage.method === "initialize") {
      initializationParams = parsedMessage.params;
    }
    if (isRecord(parsedMessage) && parsedMessage.method === "turn/interrupt") {
      // Stopping active work must not wait for another chat's mode synchronization.
      try {
        writeChild(parsedMessage);
      } catch (error) {
        if ("id" in parsedMessage)
          send({
            id: parsedMessage.id,
            error: {
              code: -32_600,
              message: error instanceof Error ? error.message : "Native interruption failed.",
            },
          });
      }
      return;
    }
    if (
      isRecord(parsedMessage) &&
      typeof parsedMessage.method === "string" &&
      (parsedMessage.method === "getAuthStatus" || parsedMessage.method.startsWith("account/"))
    ) {
      // Desktop credentials may exist only in this app-server's memory.
      writeChild(parsedMessage, primary);
      return;
    }
    clientSequence = clientSequence
      .then(async () => {
        const parsed = parsedMessage;
        if (!isRecord(parsed)) return;
        const params = isRecord(parsed.params) ? parsed.params : {};
        if (
          [
            "thread/start",
            "thread/fork",
            "turn/start",
            "review/start",
            "thread/compact/start",
            "thread/queue/start",
            "thread/realtime/start",
          ].includes(String(parsed.method)) &&
          (typeof params.threadId !== "string" || !runningThreads.has(params.threadId))
        )
          await refreshCatalogForNewTurn(resolveActiveSelection());
        if (parsed.method === "thread/loaded/list" && "id" in parsed) {
          const results = await Promise.all(
            [...new Set([...channels.values(), ...retiredChannels])].map((channel) =>
              request("thread/loaded/list", params, channel),
            ),
          );
          const ids = results.flatMap((result) =>
            isRecord(result) && Array.isArray(result.data)
              ? result.data.filter((id): id is string => typeof id === "string")
              : [],
          );
          send({ id: parsed.id, result: { data: [...new Set(ids.map(threadLinks.logical))] } });
          return;
        }
        if (parsed.method === "model/list" && "id" in parsed) {
          const selection = resolveActiveSelection();
          const catalog =
            selection.modelProvider === provider || launchSelection.modelProvider === provider
              ? readActiveModelList(codexHome, selection, params, provider)
              : undefined;
          if (catalog !== undefined) {
            send({ id: parsed.id, result: catalog });
            return;
          }
        }
        let message = parsed;
        if (parsed.method === "thread/resume" && typeof params.threadId === "string") {
          const known = threads.get(params.threadId);
          const selection =
            runningThreads.has(params.threadId) && typeof known?.modelProvider === "string"
              ? {
                  modelProvider: known.modelProvider,
                  ...(typeof known.model === "string" ? { model: known.model } : {}),
                }
              : resolveActiveSelection();
          const result = await resumeThread(params.threadId, selection, params);
          send({
            id: parsed.id,
            result: { ...result, thread: await recoverThread(result.thread as JsonObject) },
          });
          return;
        } else if (parsed.method === "thread/fork" && typeof params.threadId === "string") {
          const known = threads.get(params.threadId);
          const selection = resolveActiveSelection();
          message = {
            ...parsed,
            params: applyActiveSelection(
              params,
              selection,
              typeof known?.modelProvider === "string" ? known.modelProvider : undefined,
            ),
          };
        } else if (parsed.method === "thread/start") {
          message = {
            ...parsed,
            params: applyActiveSelection(params, resolveActiveSelection()),
          };
        } else if (
          [
            "turn/start",
            "review/start",
            "thread/compact/start",
            "thread/queue/start",
            "thread/realtime/start",
          ].includes(String(parsed.method)) &&
          typeof params.threadId === "string"
        ) {
          const activeSelection = resolveActiveSelection();
          try {
            await ensureActiveThreadSelection(params.threadId, activeSelection);
            if (parsed.method === "turn/start" && activeSelection.model !== undefined) {
              message = {
                ...parsed,
                params: applyActiveModel(
                  params,
                  activeSelection.model,
                  threads.get(params.threadId)?.collaborationMode,
                ),
              };
            }
          } catch (error) {
            if ("id" in parsed)
              send({
                jsonrpc: "2.0",
                id: parsed.id,
                error: {
                  code: isRecord(error) && typeof error.code === "number" ? error.code : -32_001,
                  message:
                    error instanceof Error
                      ? error.message
                      : "Codex could not resume this chat with the currently selected mode.",
                  ...(isRecord(error) && error.data !== undefined ? { data: error.data } : {}),
                },
              });
            options.errorOutput.write(
              "AI-Tidu9 could not apply the selected mode to the current Codex chat.\n",
            );
            return;
          }
        }
        if (typeof message.method === "string" && "id" in message) {
          const forwardedParams = isRecord(message.params) ? message.params : {};
          requests.set(idKey(message.id), {
            method: message.method,
            ...(message.method === "thread/start" ? { startParams: forwardedParams } : {}),
            ...(typeof forwardedParams.threadId === "string"
              ? { threadId: forwardedParams.threadId }
              : {}),
            ...(typeof forwardedParams.turnId === "string"
              ? { turnId: forwardedParams.turnId }
              : {}),
            ...(Array.isArray(forwardedParams.itemIds)
              ? {
                  itemIds: forwardedParams.itemIds.filter(
                    (id): id is string => typeof id === "string",
                  ),
                }
              : {}),
            cursor: forwardedParams.cursor,
            sortDirection: forwardedParams.sortDirection,
          });
        }
        // Server-initiated approval requests and the user's exact decisions pass unchanged.
        writeChild(message);
      })
      .catch((error: unknown) => {
        let failedRequest: unknown;
        try {
          failedRequest = JSON.parse(line) as unknown;
        } catch {
          failedRequest = undefined;
        }
        if (isRecord(failedRequest) && "id" in failedRequest) {
          send({
            jsonrpc: "2.0",
            id: failedRequest.id,
            error: {
              code: isRecord(error) && typeof error.code === "number" ? error.code : -32_600,
              message:
                error instanceof Error
                  ? error.message
                  : "AI-Tidu9 could not process this Codex request.",
              ...(isRecord(error) && error.data !== undefined ? { data: error.data } : {}),
            },
          });
        }
        options.errorOutput.write("AI-Tidu9 could not process client JSON-RPC.\n");
      });
  });
  const receiveNative = (channel: NativeChannel, line: string): void => {
    if (channel.failed) return;
    try {
      const received: unknown = JSON.parse(line);
      if (!isRecord(received)) return;
      const message = received;
      if (
        (message.method === "turn/started" || message.method === "turn/completed") &&
        isRecord(message.params) &&
        typeof message.params.threadId === "string" &&
        isRecord(message.params.turn) &&
        typeof message.params.turn.id === "string"
      ) {
        const threadId = message.params.threadId;
        const turnId = message.params.turn.id;
        const logicalThreadId = threadLinks.logical(threadId);
        turnOwners.set(`${logicalThreadId}:${turnId}`, {
          threadId,
          logicalThreadId,
          turnId,
          channel,
          active: message.method === "turn/started",
        });
        for (const [key, owner] of turnOwners) {
          if (turnOwners.size <= MAXIMUM_TURN_PROVIDER_ENTRIES) break;
          if (!owner.active) turnOwners.delete(key);
        }
      }
      if (
        channel !== primary &&
        typeof message.method === "string" &&
        message.method.startsWith("account/")
      ) {
        // Worker auth is deliberately empty; it must never replace the desktop's identity.
        if (message.method === "account/rateLimits/updated") refreshOfficialRateLimits();
        if ("id" in message)
          writeChild(
            {
              id: message.id,
              error: {
                code: -32_001,
                message: "Execution workers do not own desktop authentication.",
              },
            },
            channel,
            false,
          );
        return;
      }
      const responseKey = idKey(message.id);
      const pending = message.method === undefined ? internal.get(responseKey) : undefined;
      const context = message.method === undefined ? requests.get(responseKey) : undefined;
      if (context !== undefined) context.received = true;
      const method = pending?.method ?? context?.method;
      if (
        ["thread/start", "thread/resume", "thread/fork"].includes(method ?? "") &&
        isRecord(message.result) &&
        isRecord(message.result.thread) &&
        typeof message.result.thread.id === "string"
      )
        threadOwners.set(message.result.thread.id, channel);
      if (
        message.method === "thread/started" &&
        isRecord(message.params) &&
        isRecord(message.params.thread) &&
        typeof message.params.thread.id === "string"
      )
        threadOwners.set(message.params.thread.id, channel);
      if (
        message.method === "thread/closed" &&
        isRecord(message.params) &&
        typeof message.params.threadId === "string" &&
        threadOwners.get(message.params.threadId) === channel
      )
        threadOwners.delete(message.params.threadId);
      if (typeof message.method === "string" && "id" in message) {
        const originalId = message.id;
        if (serverRequests.has(responseKey)) message.id = `tidu_server_${randomUUID()}`;
        serverRequests.set(idKey(message.id), { id: originalId, channel });
      }
      if (pending !== undefined) {
        internal.delete(responseKey);
        if ("error" in message)
          pending.reject(
            Object.assign(
              new Error(
                isRecord(message.error) && typeof message.error.message === "string"
                  ? message.error.message
                  : "Official session read failed.",
              ),
              isRecord(message.error) ? { code: message.error.code, data: message.error.data } : {},
            ),
          );
        else pending.resolve(message.result);
        return;
      }
      if (
        message.method === "thread/started" &&
        isRecord(message.params) &&
        isRecord(message.params.thread) &&
        typeof message.params.thread.forkedFromId === "string"
      ) {
        const root = migrations.get(message.params.thread.forkedFromId);
        if (root !== undefined && typeof message.params.thread.id === "string") {
          threadLinks.record(root, message.params.thread.id, message.params.thread.forkedFromId);
          return;
        }
      }
      if (
        message.method === undefined &&
        typeof message.id === "string" &&
        message.id.startsWith(INTERNAL_REQUEST_ID_PREFIX)
      )
        return;
      const receivedAt = Date.now();
      sequence = sequence
        .then(async () => {
          const params = isRecord(message.params) ? message.params : {};
          const turnId = isRecord(params.turn) ? params.turn.id : params.turnId;
          if (
            typeof params.threadId === "string" &&
            typeof turnId === "string" &&
            turnOwners.get(`${threadLinks.logical(params.threadId)}:${turnId}`)?.failed === true
          )
            return;
          if (message.method === "thread/started" && emptyContinuation !== undefined) {
            await emptyContinuation.catch(() => undefined);
          }
          if (
            message.method === "thread/started" &&
            isRecord(message.params) &&
            isRecord(message.params.thread) &&
            typeof message.params.thread.id === "string" &&
            emptyContinuationIds.delete(message.params.thread.id)
          )
            return;
          await processMessage(threadLinks.toClient(message, context?.method), receivedAt);
        })
        .catch(() => {
          send(message);
        })
        .finally(reapRetiredChannels);
    } catch {
      options.errorOutput.write("AI-Tidu9 received invalid official JSON-RPC.\n");
    }
  };
  const disconnected = (): void => {
    if (closed) return;
    closed = true;
    void terminateChildren();
    unwatchFile(configurationPath, synchronizeSelection);
    internal.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Official Codex connection closed."));
    });
    internal.clear();
    requests.clear();
    turnSelections.clear();
    threads.clear();
    terminalTurns.clear();
    threadOwners.clear();
    turnOwners.clear();
    serverRequests.clear();
    fromClient.close();
    serverReaders.forEach((reader) => {
      reader.close();
    });
  };
  const attachNative = (channel: NativeChannel): void => {
    const reader = createInterface({ input: channel.process.stdout });
    serverReaders.add(reader);
    reader.on("line", (line) => receiveNative(channel, line));
    channel.process.stderr.pipe(options.errorOutput, { end: false });
    const channelDisconnected = (): void => {
      if (closed || channel.failed) return;
      if (channel === primary) {
        disconnected();
        return;
      }
      channel.failed = true;
      retiredChannels.delete(channel);
      reader.close();
      serverReaders.delete(reader);
      for (const [name, current] of channels) if (current === channel) channels.delete(name);
      const failure = new Error("Native execution worker connection closed.");
      for (const [key, pending] of internal)
        if (pending.channel === channel) {
          internal.delete(key);
          pending.reject(failure);
        }
      for (const [key, pending] of requests)
        if (pending.channel === channel && !pending.received) {
          requests.delete(key);
          send({ id: JSON.parse(key), error: { code: -32_001, message: failure.message } });
        }
      for (const [threadId, owner] of threadOwners)
        if (owner === channel) {
          threadOwners.delete(threadId);
          const known = threads.get(threadLinks.logical(threadId));
          if (known?.continuationId === threadId) known.loaded = false;
        }
      for (const owner of turnOwners.values())
        if (owner.channel === channel && owner.active) {
          owner.active = false;
          owner.failed = true;
          send({
            method: "turn/completed",
            params: {
              threadId: owner.logicalThreadId,
              turn: { id: owner.turnId, status: "failed", error: { message: failure.message } },
            },
          });
          if (
            ![...turnOwners.values()].some(
              (other) => other.logicalThreadId === owner.logicalThreadId && other.active,
            )
          )
            runningThreads.delete(owner.logicalThreadId);
        }
      void channel.terminate().catch(() => undefined);
    };
    channel.process.on("error", channelDisconnected);
    channel.process.stdin.on("error", channelDisconnected);
    channel.process.on("close", channelDisconnected);
  };
  attachNative(primary);
  fromClient.on("close", () => {
    void terminateChildren();
  });
  return {
    process: child,
    close: async () => {
      await terminateChildren();
    },
  };
};

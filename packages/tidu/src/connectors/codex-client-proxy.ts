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
import {
  indexCodexRecoveryRecords,
  readCodexRecoveryRecords,
  recoverCodexTurn,
} from "../clients/codex-recovery.js";
import {
  createStdioJsonRpcClient,
  type JsonRpcClient,
  type JsonRpcProcessLaunch,
} from "./json-rpc.js";

type JsonObject = Record<string, unknown>;
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
              reasoningEffort: level.effort,
              description: typeof level.description === "string" ? level.description : "",
            }))
        : [],
      ...(Array.isArray(model.input_modalities) ? { inputModalities: model.input_modalities } : {}),
      supportsPersonality: false,
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
  const child = spawn(options.launch.command, [...options.launch.arguments], {
    env: options.launch.environment,
    cwd: options.launch.workingDirectory,
    stdio: "pipe",
  });
  const codexHome = options.launch.environment.CODEX_HOME ?? join(homedir(), ".codex");
  const provider = options.managedProvider ?? "ai_tidu9";
  const resolveActiveSelection =
    options.resolveActiveSelection ??
    (() => readCodexActiveSelection(codexHome, options.launch.arguments));
  const launchSelection = resolveActiveSelection();
  let accountClient: JsonRpcClient | undefined;
  let accountReady: Promise<void> | undefined;
  const readOfficialAccount = async (method: string, params: unknown): Promise<unknown> => {
    if (accountClient === undefined) {
      accountClient = createStdioJsonRpcClient(
        {
          ...options.launch,
          arguments: [...options.launch.arguments, "-c", 'model_provider="openai"'],
        },
        { requestTimeoutMilliseconds: internalRequestTimeoutMs },
      );
      const client = accountClient;
      accountReady = client
        .request("initialize", {
          clientInfo: { name: "ai_tidu9_account", version: "1" },
          capabilities: { experimentalApi: true },
        })
        .then(() => client.notify("initialized"));
    }
    const client = accountClient;
    try {
      await accountReady;
      return await client.request(method, params);
    } catch (error) {
      if (accountClient === client) {
        accountClient = undefined;
        accountReady = undefined;
      }
      await client.close();
      throw error;
    }
  };
  const requests = new Map<
    string,
    {
      method: string;
      threadId?: string;
      turnId?: string;
      itemIds?: string[];
      cursor?: unknown;
      sortDirection?: unknown;
    }
  >();
  const internal = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
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
    if (!closed && options.output.writable) options.output.write(`${JSON.stringify(message)}\n`);
  };
  const writeChild = (message: unknown): void => {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  let rateLimitsRefresh: Promise<void> | undefined;
  const refreshOfficialRateLimits = (): void => {
    if (rateLimitsRefresh !== undefined) return;
    rateLimitsRefresh = readOfficialAccount("account/rateLimits/read", undefined)
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
  const request = (method: string, params: unknown): Promise<unknown> =>
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
      writeChild({ jsonrpc: "2.0", id, method, params });
    });
  const rememberThread = (thread: JsonObject, settings?: JsonObject): void => {
    if (typeof thread.id !== "string") return;
    const previous = threads.get(thread.id);
    threads.set(thread.id, {
      id: thread.id,
      modelProvider: settings?.modelProvider ?? thread.modelProvider ?? previous?.modelProvider,
      model: settings?.model ?? thread.model ?? previous?.model,
      collaborationMode:
        settings?.collaborationMode ?? thread.collaborationMode ?? previous?.collaborationMode,
      path: thread.path ?? previous?.path,
      cwd: thread.cwd ?? previous?.cwd,
    });
    if (threads.size > 32) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
  };
  const ensureActiveThreadSelection = async (
    threadId: string,
    activeSelection: CodexActiveSelection,
  ): Promise<JsonObject | undefined> => {
    const known = threads.get(threadId);
    const selection = activeSelection;
    const providerMatches = known?.modelProvider === selection.modelProvider;
    const modelMatches = selection.model === undefined || known?.model === selection.model;
    if (providerMatches && modelMatches) return;
    if (known !== undefined && !providerMatches) {
      await request("thread/unsubscribe", { threadId });
    }
    const result = await request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...applyActiveSelection(
        {},
        selection,
        typeof known?.modelProvider === "string" ? known.modelProvider : undefined,
      ),
    });
    if (!isRecord(result) || !isRecord(result.thread))
      throw new Error("Official Codex did not return the resumed chat.");
    rememberThread(result.thread, result);
    return result;
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
        method !== undefined &&
        ["thread/start", "thread/read", "thread/resume", "thread/fork"].includes(method) &&
        isRecord(message.result) &&
        isRecord(message.result.thread)
      ) {
        rememberThread(message.result.thread, message.result);
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
  const fromServer = createInterface({ input: child.stdout });
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
    clientSequence = clientSequence
      .then(async () => {
        const parsed = parsedMessage;
        if (!isRecord(parsed)) return;
        const params = isRecord(parsed.params) ? parsed.params : {};
        if (
          "id" in parsed &&
          resolveActiveSelection().modelProvider === provider &&
          ["account/read", "account/rateLimits/read", "account/usage/read"].includes(
            String(parsed.method),
          )
        ) {
          try {
            const result = await readOfficialAccount(String(parsed.method), parsed.params);
            send({ id: parsed.id, result });
            return;
          } catch {
            // Let the native process report its own account result when metadata is unavailable.
          }
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
          const selection = resolveActiveSelection();
          if (known !== undefined && known.modelProvider !== selection.modelProvider) {
            await request("thread/unsubscribe", { threadId: params.threadId });
          }
          if (known?.modelProvider !== selection.modelProvider || selection.model !== undefined)
            message = {
              ...parsed,
              params: applyActiveSelection(
                params,
                selection,
                typeof known?.modelProvider === "string" ? known.modelProvider : undefined,
              ),
            };
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
          } catch {
            if ("id" in parsed)
              send({
                jsonrpc: "2.0",
                id: parsed.id,
                error: {
                  code: -32_001,
                  message: "Codex could not resume this chat with the currently selected mode.",
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
      .catch(() => {
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
              code: -32_600,
              message: "AI-Tidu9 could not process this Codex request.",
            },
          });
        }
        options.errorOutput.write("AI-Tidu9 could not process client JSON-RPC.\n");
      });
  });
  fromServer.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) return;
      const responseKey = idKey(message.id);
      const pending = message.method === undefined ? internal.get(responseKey) : undefined;
      if (pending !== undefined) {
        internal.delete(responseKey);
        if ("error" in message) pending.reject(new Error("Official session read failed."));
        else pending.resolve(message.result);
        return;
      }
      if (
        message.method === undefined &&
        typeof message.id === "string" &&
        message.id.startsWith(INTERNAL_REQUEST_ID_PREFIX)
      )
        return;
      const receivedAt = Date.now();
      sequence = sequence
        .then(() => processMessage(message, receivedAt))
        .catch(() => {
          send(message);
        });
    } catch {
      options.errorOutput.write("AI-Tidu9 received invalid official JSON-RPC.\n");
    }
  });
  child.stderr.pipe(options.errorOutput, { end: false });
  const disconnected = (): void => {
    closed = true;
    void accountClient?.close();
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
    fromClient.close();
    fromServer.close();
  };
  child.on("error", disconnected);
  child.stdin.on("error", disconnected);
  child.on("close", disconnected);
  fromClient.on("close", () => {
    if (!closed) child.kill("SIGTERM");
  });
  return {
    process: child,
    close: async () => {
      if (!closed) {
        const ended = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        child.kill("SIGTERM");
        await ended;
      }
    },
  };
};

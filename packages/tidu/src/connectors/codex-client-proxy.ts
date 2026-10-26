import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  indexCodexRecoveryRecords,
  readCodexRecoveryRecords,
  recoverCodexTurn,
} from "../clients/codex-recovery.js";
import type { JsonRpcProcessLaunch } from "./json-rpc.js";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idKey = (id: unknown): string => JSON.stringify(id);

export interface CodexClientProxyOptions {
  /** Official executable, arguments, environment, and cwd; approvals remain with this process. */
  launch: JsonRpcProcessLaunch;
  /** Native client's newline-framed input. */
  input: Readable;
  /** Native client's newline-framed output. */
  output: Writable;
  /** Stderr sink; model output and session contents are never logged here. */
  errorOutput: Writable;
  /** Provider whose native display requires recovery; official direct mode passes through. */
  managedProvider?: string;
}

export interface CodexClientProxy {
  /** Official app-server process. */
  process: ChildProcessWithoutNullStreams;
  /** Closes the transport and official child without writing additional history. */
  close: () => Promise<void>;
}

/** Transparent native-client relay. Derives cancelled presentation from the official session only. */
export const createCodexClientProxy = (options: CodexClientProxyOptions): CodexClientProxy => {
  const child = spawn(options.launch.command, [...options.launch.arguments], {
    env: options.launch.environment,
    cwd: options.launch.workingDirectory,
    stdio: "pipe",
  });
  const codexHome = options.launch.environment.CODEX_HOME ?? join(homedir(), ".codex");
  const provider = options.managedProvider ?? "ai_tidu9";
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
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const starts = new Map<string, number>();
  const threads = new Map<string, JsonObject>();
  const terminalTurns = new Map<
    string,
    { threadId: string; turnId: string; turn: JsonObject; footer: string; footerItemId: string }
  >();
  let sequence = Promise.resolve();
  let closed = false;
  const send = (message: unknown): void => {
    if (!closed && options.output.writable) options.output.write(`${JSON.stringify(message)}\n`);
  };
  const writeChild = (message: unknown): void => {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = `tidu_recovery_${randomUUID()}`;
      internal.set(idKey(id), { resolve, reject });
      writeChild({ jsonrpc: "2.0", id, method, params });
    });
  const rememberThread = (thread: JsonObject): void => {
    if (typeof thread.id !== "string") return;
    threads.set(thread.id, {
      id: thread.id,
      modelProvider: thread.modelProvider,
      path: thread.path,
      cwd: thread.cwd,
    });
    if (threads.size > 32) {
      const oldest = threads.keys().next().value;
      if (oldest !== undefined) threads.delete(oldest);
    }
  };
  const loadLiveTurn = async (threadId: string, turn: JsonObject) => {
    const metadata = await request("thread/read", { threadId, includeTurns: false });
    if (
      !isRecord(metadata) ||
      !isRecord(metadata.thread) ||
      metadata.thread.modelProvider !== provider
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
    if (
      thread.modelProvider !== provider ||
      typeof thread.path !== "string" ||
      !Array.isArray(thread.turns)
    )
      return thread;
    const cancelled = thread.turns.filter(
      (turn): turn is JsonObject =>
        isRecord(turn) && (turn.status === "interrupted" || turn.status === "failed"),
    );
    if (cancelled.length === 0) return thread;
    const records = await readCodexRecoveryRecords(thread.path, codexHome);
    const byTurn = indexCodexRecoveryRecords(records);
    return {
      ...thread,
      turns: thread.turns.map((turn) =>
        isRecord(turn) && (turn.status === "interrupted" || turn.status === "failed")
          ? recoverCodexTurn(
              turn,
              byTurn.get(String(turn.id)) ?? [],
              typeof thread.cwd === "string" ? thread.cwd : "",
            ).turn
          : turn,
      ),
    };
  };
  const processMessage = async (message: JsonObject, receivedAt: number): Promise<void> => {
    const params = isRecord(message.params) ? message.params : undefined;
    if (
      message.method === "thread/tokenUsage/updated" &&
      typeof params?.threadId === "string" &&
      typeof params.turnId === "string"
    ) {
      const terminal = terminalTurns.get(`${params.threadId}:${params.turnId}`);
      if (terminal !== undefined) {
        send(message);
        try {
          const snapshot = await loadLiveTurn(terminal.threadId, terminal.turn);
          if (snapshot !== undefined) {
            const { saved, thread, records } = snapshot;
            const recovered = recoverCodexTurn(
              saved,
              records,
              typeof thread.cwd === "string" ? thread.cwd : "",
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
    )
      starts.set(`${params.threadId}:${params.turn.id}`, receivedAt);
    if (
      message.method === "turn/completed" &&
      typeof params?.threadId === "string" &&
      isRecord(params.turn)
    ) {
      const threadId = params.threadId;
      const key = `${threadId}:${String(params.turn.id)}`;
      const startedAt = starts.get(key);
      starts.delete(key);
      const known = threads.get(threadId);
      if (
        known?.modelProvider === provider &&
        (params.turn.status === "interrupted" || params.turn.status === "failed")
      ) {
        try {
          const snapshot = await loadLiveTurn(threadId, params.turn);
          if (snapshot !== undefined) {
            const { thread, saved, records } = snapshot;
            const recovered = recoverCodexTurn(
              saved,
              records,
              typeof thread.cwd === "string" ? thread.cwd : "",
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
                params: { threadId, turnId: params.turn.id, completedAtMs: receivedAt, item },
              });
            }
            const durationMs =
              typeof recovered.turn.durationMs === "number" && recovered.turn.durationMs > 0
                ? recovered.turn.durationMs
                : startedAt === undefined
                  ? params.turn.durationMs
                  : Math.max(0, receivedAt - startedAt);
            send({ ...message, params: { ...params, turn: { ...params.turn, durationMs } } });
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
        try {
          send({
            ...message,
            result: { ...message.result, thread: await recoverThread(message.result.thread) },
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
          if (thread?.modelProvider === provider && typeof thread.path === "string") {
            const byTurn = indexCodexRecoveryRecords(
              await readCodexRecoveryRecords(thread.path, codexHome),
            );
            const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
            if (method === "thread/turns/list") {
              send({
                ...message,
                result: {
                  ...message.result,
                  data: message.result.data.map((turn) =>
                    isRecord(turn)
                      ? recoverCodexTurn(turn, byTurn.get(String(turn.id)) ?? [], cwd).turn
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
                );
                for (const item of recovered.completedItems) {
                  if (method === "thread/items/read" && !context.itemIds?.includes(String(item.id)))
                    continue;
                  const existingIndex = data.findIndex(
                    (entry) =>
                      entry.turnId === turnId && isRecord(entry.item) && entry.item.id === item.id,
                  );
                  if (existingIndex >= 0)
                    data[existingIndex] = { ...data[existingIndex], item, turnId };
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
  fromClient.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) return;
      if (typeof message.method === "string" && "id" in message) {
        const params = isRecord(message.params) ? message.params : {};
        requests.set(idKey(message.id), {
          method: message.method,
          ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}),
          ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          ...(Array.isArray(params.itemIds)
            ? { itemIds: params.itemIds.filter((id): id is string => typeof id === "string") }
            : {}),
          cursor: params.cursor,
          sortDirection: params.sortDirection,
        });
      }
      // Server-initiated approval requests and the user's exact decisions pass unchanged.
      writeChild(message);
    } catch {
      options.errorOutput.write("AI-Tidu9 received invalid client JSON-RPC.\n");
    }
  });
  fromServer.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) return;
      const pending = message.method === undefined ? internal.get(idKey(message.id)) : undefined;
      if (pending !== undefined) {
        internal.delete(idKey(message.id));
        if ("error" in message) pending.reject(new Error("Official session read failed."));
        else pending.resolve(message.result);
        return;
      }
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
    internal.forEach((pending) => {
      pending.reject(new Error("Official Codex connection closed."));
    });
    internal.clear();
    requests.clear();
    starts.clear();
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

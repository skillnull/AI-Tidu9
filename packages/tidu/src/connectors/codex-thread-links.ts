import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { acquireRuntimeDataLock } from "../lifecycle/index.js";

interface ThreadLink {
  /** Stable chat identifier presented to the native client. */
  threadId: string;
  /** Official continuation currently owning this chat's complete history. */
  currentThreadId: string;
  /** Earlier official continuations retained for event and history identity. */
  previousThreadIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Stores identifiers only; official forked histories remain owned by the host. */
export const createCodexThreadLinks = (directory: string) => {
  const path = join(directory, ".client-thread-links.json");
  const links = new Map<string, ThreadLink>();
  let revision: string | undefined;
  let unavailable: Error | undefined;
  const reload = (force = false): void => {
    try {
      if (!existsSync(path)) {
        links.clear();
        revision = undefined;
        unavailable = undefined;
        return;
      }
      const status = lstatSync(path);
      if (!status.isFile() || status.isSymbolicLink() || status.size > 1024 * 1024)
        throw new Error("Unsafe native chat continuation index.");
      const currentRevision = `${status.ino}:${status.size}:${status.mtimeMs}`;
      if (!force && revision === currentRevision) return;
      revision = currentRevision;
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(stored)) throw new Error("Invalid native chat continuation index.");
      const loaded = new Map<string, ThreadLink>();
      const owners = new Map<string, string>();
      for (const entry of stored) {
        if (
          !isRecord(entry) ||
          !isId(entry.threadId) ||
          !isId(entry.currentThreadId) ||
          !Array.isArray(entry.previousThreadIds) ||
          !entry.previousThreadIds.every(isId) ||
          loaded.has(entry.threadId)
        )
          throw new Error("Invalid native chat continuation link.");
        for (const id of [entry.threadId, entry.currentThreadId, ...entry.previousThreadIds]) {
          if (owners.has(id) && owners.get(id) !== entry.threadId)
            throw new Error("Ambiguous native chat continuation link.");
          owners.set(id, entry.threadId);
        }
        loaded.set(entry.threadId, entry as unknown as ThreadLink);
      }
      links.clear();
      loaded.forEach((link, id) => {
        links.set(id, link);
      });
      unavailable = undefined;
    } catch {
      // Corrupt optional metadata must not prevent initialization or account requests.
      revision = undefined;
      unavailable = new Error("Native chat continuation metadata is unavailable.");
    }
  };
  reload();
  const lookupLogical = (threadId: string): string => {
    for (const link of links.values())
      if (link.currentThreadId === threadId || link.previousThreadIds.includes(threadId))
        return link.threadId;
    return threadId;
  };
  const logical = (threadId: string): string => {
    reload();
    if (unavailable !== undefined) throw unavailable;
    return lookupLogical(threadId);
  };
  const lookupCurrent = (threadId: string): string =>
    links.get(lookupLogical(threadId))?.currentThreadId ?? threadId;
  const current = (threadId: string): string => {
    logical(threadId);
    return lookupCurrent(threadId);
  };
  const record = (threadId: string, continuationId: string, expectedThreadId?: string): void => {
    if (!isId(threadId) || !isId(continuationId))
      throw new Error("Invalid native chat continuation identifier.");
    const lockDirectory = join(directory, ".client-thread-links-lock");
    let lock: ReturnType<typeof acquireRuntimeDataLock>;
    const deadline = Date.now() + 1000;
    while (lock === undefined) {
      mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
      const status = lstatSync(lockDirectory);
      if (!status.isDirectory() || status.isSymbolicLink())
        throw new Error("Unsafe native chat continuation lock.");
      try {
        lock = acquireRuntimeDataLock(join(lockDirectory, "index"));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          !["CONFIGURATION_CONFLICT", "ENOENT"].includes(String(error.code)) ||
          Date.now() >= deadline
        )
          throw new Error("Native chat continuation metadata is busy.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      reload(true);
      if (unavailable !== undefined) throw unavailable;
      const root = logical(threadId);
      if (
        expectedThreadId !== undefined &&
        lookupCurrent(root) !== expectedThreadId &&
        lookupCurrent(root) !== continuationId
      )
        throw new Error(
          "Native chat continuation changed during the fork; resume the latest continuation.",
        );
      if (
        [...links.values()].some(
          (link) =>
            link.threadId !== root &&
            [link.threadId, link.currentThreadId, ...link.previousThreadIds].includes(
              continuationId,
            ),
        )
      )
        throw new Error("Native chat continuation belongs to another chat.");
      const previous = links.get(root);
      if (previous?.currentThreadId === continuationId) return;
      const link: ThreadLink = {
        threadId: root,
        currentThreadId: continuationId,
        previousThreadIds: [
          ...new Set([
            root,
            ...(previous?.previousThreadIds ?? []),
            ...(previous === undefined ? [] : [previous.currentThreadId]),
          ]),
        ].filter((id) => id !== continuationId),
      };
      const updated = new Map(links).set(root, link);
      const content = `${JSON.stringify([...updated.values()])}\n`;
      if (Buffer.byteLength(content) > 1024 * 1024)
        throw new Error("Native chat continuation index exceeds its size limit.");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
        links.set(root, link);
        revision = undefined;
      } finally {
        if (existsSync(temporary)) rmSync(temporary);
      }
    } finally {
      lock.release();
      try {
        rmdirSync(lockDirectory);
      } catch {
        // Another relay may already own this directory; never remove its lock.
      }
    }
  };
  const itemView = (item: unknown): unknown => {
    if (!isRecord(item)) return item;
    if (item.type === "subAgentActivity")
      return isId(item.agentThreadId)
        ? { ...item, agentThreadId: lookupLogical(item.agentThreadId) }
        : item;
    if (item.type !== "collabAgentToolCall") return item;
    const updated = { ...item };
    if (isId(item.senderThreadId)) updated.senderThreadId = lookupLogical(item.senderThreadId);
    if (Array.isArray(item.receiverThreadIds))
      updated.receiverThreadIds = item.receiverThreadIds.map((threadId) =>
        isId(threadId) ? lookupLogical(threadId) : threadId,
      );
    if (isRecord(item.agentsStates)) {
      const states = new Map<string, unknown>();
      for (const [threadId, state] of Object.entries(item.agentsStates)) {
        const logicalId = lookupLogical(threadId);
        // Distinct native states cannot be merged into one logical owner without losing evidence.
        if (states.has(logicalId)) return item;
        states.set(logicalId, state);
      }
      updated.agentsStates = Object.fromEntries(states);
    }
    return updated;
  };
  const turnView = (turn: unknown): unknown =>
    isRecord(turn) && Array.isArray(turn.items)
      ? { ...turn, items: turn.items.map(itemView) }
      : turn;
  const threadView = (thread: Record<string, unknown>): Record<string, unknown> => {
    if (!isId(thread.id)) return thread;
    const threadId = lookupLogical(thread.id);
    return {
      ...thread,
      id: threadId,
      ...(isId(thread.sessionId) ? { sessionId: lookupLogical(thread.sessionId) } : {}),
      ...(Array.isArray(thread.turns) ? { turns: thread.turns.map(turnView) } : {}),
      ...(isId(thread.forkedFromId)
        ? {
            forkedFromId:
              lookupLogical(thread.forkedFromId) === threadId
                ? null
                : lookupLogical(thread.forkedFromId),
          }
        : {}),
    };
  };
  const toClient = (message: Record<string, unknown>, method?: string): Record<string, unknown> => {
    reload();
    const result = { ...message };
    for (const key of ["params", "result"]) {
      const payload = message[key];
      if (!isRecord(payload)) continue;
      const updated = { ...payload };
      if (isId(payload.threadId)) updated.threadId = lookupLogical(payload.threadId);
      if (isRecord(payload.thread)) updated.thread = threadView(payload.thread);
      if (isRecord(payload.item)) updated.item = itemView(payload.item);
      if (isRecord(payload.turn)) updated.turn = turnView(payload.turn);
      if (key === "result" && Array.isArray(payload.data)) {
        if (method === "thread/list")
          updated.data = payload.data
            .filter(
              (entry) =>
                !isRecord(entry) || !isId(entry.id) || lookupCurrent(entry.id) === entry.id,
            )
            .map((entry) => (isRecord(entry) ? threadView(entry) : entry));
        if (method === "thread/loaded/list")
          updated.data = [
            ...new Set(payload.data.map((entry) => (isId(entry) ? lookupLogical(entry) : entry))),
          ];
        if (method === "thread/turns/list") updated.data = payload.data.map(turnView);
        if (method === "thread/items/list" || method === "thread/items/read")
          updated.data = payload.data.map((entry) =>
            isRecord(entry) && isRecord(entry.item)
              ? { ...entry, item: itemView(entry.item) }
              : entry,
          );
      }
      result[key] = updated;
    }
    return result;
  };
  const toServer = (message: Record<string, unknown>): Record<string, unknown> => {
    if (!isRecord(message.params)) return message;
    const params = { ...message.params };
    if (isId(params.threadId)) params.threadId = current(params.threadId);
    if (Array.isArray(params.excludedThreadIds))
      params.excludedThreadIds = params.excludedThreadIds.map((id) =>
        isId(id) ? current(id) : id,
      );
    return { ...message, params };
  };
  return { logical, current, record, toClient, toServer };
};

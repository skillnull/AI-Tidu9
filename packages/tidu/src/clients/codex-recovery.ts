import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { formatResponseTokenFooter } from "../runtime/response-usage.js";

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const MAXIMUM_HISTORY_BYTES = 8 * 1024 * 1024;
const MAXIMUM_FAILURE_MESSAGE_CHARACTERS = 1_000;
let cachedHistory:
  | { path: string; size: number; modifiedAt: number; records: readonly unknown[] }
  | undefined;

const readFailureMessage = (value: unknown, depth = 0): string | undefined => {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    const message = value.trim();
    if (message === "") return undefined;
    if (message.startsWith("{")) {
      try {
        const nested = readFailureMessage(JSON.parse(message) as unknown, depth + 1);
        if (nested !== undefined) return nested;
      } catch {
        /* A plain provider error can begin with a brace without being JSON. */
      }
    }
    return [...message].slice(0, MAXIMUM_FAILURE_MESSAGE_CHARACTERS).join("");
  }
  if (!isRecord(value)) return undefined;
  for (const field of [value.error, value.message, value.reason]) {
    const message = readFailureMessage(field, depth + 1);
    if (message !== undefined) return message;
  }
  return undefined;
};

const appendFailureBeforeFooter = (text: string, failure: string, footer: string): string => {
  if (text.includes(failure)) return text;
  if (footer !== "" && text === footer) return `${failure}\n\n${footer}`;
  if (footer !== "" && text.endsWith(`\n\n${footer}`)) {
    return `${text.slice(0, -(footer.length + 2))}\n\n${failure}\n\n${footer}`;
  }
  return text === "" ? failure : `${text}\n\n${failure}`;
};

export interface CodexRecoveredTurn {
  /** Official turn with missing cancelled commands, footer, and timing restored. */
  turn: JsonObject;
  /** Derived items that a live native client has not received as completed items. */
  completedItems: readonly JsonObject[];
}

/** Groups the bounded evidence once so loading a history page is linear in its record count. */
export const indexCodexRecoveryRecords = (
  records: readonly unknown[],
): ReadonlyMap<string, readonly unknown[]> => {
  const turns = new Map<string, unknown[]>();
  let currentTurn: unknown;
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.payload)) continue;
    const payload = record.payload;
    if (record.type === "event_msg" && payload.type === "task_started")
      currentTurn = payload.turn_id;
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = payload.turn_id ?? metadata?.turn_id ?? currentTurn;
    if (typeof turnId !== "string") continue;
    const entries = turns.get(turnId) ?? [];
    entries.push(record);
    turns.set(turnId, entries);
  }
  return turns;
};

/** Derives display data from official history. Does not write or copy a conversation. */
export const recoverCodexTurn = (
  turn: JsonObject,
  records: readonly unknown[],
  cwd: string,
): CodexRecoveredTurn => {
  const items = Array.isArray(turn.items) ? turn.items.filter(isRecord) : [];
  const recovered = [...items];
  const completedItems: JsonObject[] = [];
  const calls = new Map<string, { command: string; cwd: string; startedAt: number }>();
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let durationMs = number(turn.durationMs);
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
  let failureMessage: string | undefined;
  let currentTurnId: unknown;
  for (const record of records) {
    if (!isRecord(record) || !isRecord(record.payload)) continue;
    const payload = record.payload;
    const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (record.type === "event_msg" && payload.type === "task_started")
      currentTurnId = payload.turn_id;
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : undefined;
    const turnId = payload.turn_id ?? metadata?.turn_id ?? currentTurnId;
    if (turnId !== turn.id) continue;
    if (
      record.type === "event_msg" &&
      payload.type === "task_started" &&
      Number.isFinite(timestamp)
    )
      startedAt = timestamp;
    if (
      record.type === "event_msg" &&
      (payload.type === "turn_aborted" || payload.type === "task_complete")
    ) {
      if (Number.isFinite(timestamp)) completedAt = timestamp;
      if ((number(payload.duration_ms) ?? 0) > 0) durationMs = payload.duration_ms as number;
      if (payload.type === "task_complete") {
        failureMessage = readFailureMessage(payload.error) ?? failureMessage;
      }
    }
    if (record.type === "token_usage_record" && isRecord(payload.turn_token_usage)) {
      const reported = payload.turn_token_usage;
      const inputTokens = number(reported.input_tokens);
      const outputTokens = number(reported.output_tokens);
      const totalTokens = number(reported.total_tokens);
      if (inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined)
        usage = { inputTokens, outputTokens, totalTokens };
    }
    if (record.type !== "response_item" || typeof payload.call_id !== "string") continue;
    if (
      payload.type === "function_call" &&
      payload.name === "exec_command" &&
      typeof payload.arguments === "string"
    ) {
      try {
        const args: unknown = JSON.parse(payload.arguments);
        if (isRecord(args) && typeof args.cmd === "string")
          calls.set(payload.call_id, {
            command: args.cmd,
            cwd: typeof args.workdir === "string" ? args.workdir : cwd,
            startedAt: timestamp,
          });
      } catch {
        /* Malformed model arguments are not evidence of an executed command. */
      }
    }
    if (
      turn.status !== "interrupted" ||
      payload.type !== "function_call_output" ||
      typeof payload.output !== "string" ||
      !/^Wall time: [\d.]+ seconds\naborted by user$/u.test(payload.output.trim())
    )
      continue;
    const call = calls.get(payload.call_id);
    if (call === undefined || items.some((item) => item.id === payload.call_id)) continue;
    const elapsed = /^Wall time: ([\d.]+) seconds/u.exec(payload.output)?.[1];
    const item = {
      type: "commandExecution",
      id: payload.call_id,
      command: call.command,
      cwd: call.cwd,
      processId: null,
      source: "unifiedExecStartup",
      status: "failed",
      commandActions: [{ type: "unknown", command: call.command }],
      // This is the actual abort result, not an invented process exit code or successful run.
      aggregatedOutput: payload.output,
      exitCode: null,
      durationMs:
        elapsed === undefined ? Math.max(0, timestamp - call.startedAt) : Number(elapsed) * 1000,
    };
    recovered.push(item);
    completedItems.push(item);
  }
  if (
    !(durationMs !== undefined && durationMs > 0) &&
    startedAt !== undefined &&
    completedAt !== undefined
  )
    durationMs = Math.max(0, completedAt - startedAt);
  if (turn.status === "interrupted" || turn.status === "failed") {
    const footer = formatResponseTokenFooter({ usage, complete: usage !== null }, true);
    const footerId = `tidu_usage_${String(turn.id)}`;
    let finalIndex = -1;
    for (let index = recovered.length - 1; index >= 0; index -= 1) {
      const item = recovered[index];
      if (
        (footer !== "" || failureMessage !== undefined) &&
        item?.type === "agentMessage" &&
        item.phase === "final_answer" &&
        typeof item.text === "string" &&
        (item.id !== footerId || item.text !== footer)
      ) {
        finalIndex = index;
        break;
      }
    }
    const finalMessage = recovered[finalIndex];
    if (finalMessage !== undefined && typeof finalMessage.text === "string") {
      const visibleText =
        failureMessage === undefined
          ? finalMessage.text
          : appendFailureBeforeFooter(finalMessage.text, failureMessage, footer);
      const completedText =
        footer === "" || visibleText.endsWith(footer) ? visibleText : `${visibleText}\n\n${footer}`;
      if (completedText !== finalMessage.text) {
        const updated = { ...finalMessage, text: completedText };
        recovered[finalIndex] = updated;
        completedItems.push(updated);
      }
    } else if (
      (failureMessage !== undefined || footer !== "") &&
      !recovered.some((item) => item.id === footerId)
    ) {
      const text = [failureMessage, footer]
        .filter((part) => part !== undefined && part !== "")
        .join("\n\n");
      const item = {
        type: "agentMessage",
        id: failureMessage === undefined ? footerId : `tidu_failure_${String(turn.id)}`,
        text,
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      recovered.push(item);
      completedItems.push(item);
    }
  }
  return {
    turn: { ...turn, ...(durationMs === undefined ? {} : { durationMs }), items: recovered },
    completedItems,
  };
};

/** Reads a bounded tail of a server-provided session path; never opens auth/config files. */
export const readCodexRecoveryRecords = async (
  path: string,
  codexHome: string,
): Promise<readonly unknown[]> => {
  const sessionRoot = await realpath(resolve(codexHome, "sessions"));
  const sessionPath = await realpath(path);
  const childPath = relative(sessionRoot, sessionPath);
  if (childPath.startsWith("..") || isAbsolute(childPath) || !sessionPath.endsWith(".jsonl"))
    throw new Error("Recovery requires an official session JSONL file inside CODEX_HOME/sessions.");
  const file = await open(sessionPath, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Recovery session is not a regular file.");
    if (
      cachedHistory?.path === sessionPath &&
      cachedHistory.size === stats.size &&
      cachedHistory.modifiedAt === stats.mtimeMs
    )
      return cachedHistory.records;
    const length = Math.min(stats.size, MAXIMUM_HISTORY_BYTES);
    const buffer = Buffer.alloc(length);
    const offset = stats.size - length;
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (offset > 0) lines.shift();
    const records = lines.flatMap((line): unknown[] => {
      try {
        if (line === "") return [];
        const record: unknown = JSON.parse(line);
        if (!isRecord(record) || !isRecord(record.payload)) return [];
        const payload = record.payload;
        // Keep only recovery evidence, never user prompts, reasoning, or bulk command output.
        if (
          record.type === "token_usage_record" ||
          (record.type === "event_msg" &&
            ["task_started", "turn_aborted", "task_complete"].includes(String(payload.type))) ||
          (record.type === "response_item" &&
            ((payload.type === "function_call" && payload.name === "exec_command") ||
              (payload.type === "function_call_output" &&
                typeof payload.output === "string" &&
                /^Wall time: [\d.]+ seconds\naborted by user$/u.test(payload.output.trim()))))
        )
          return [record];
        return [];
      } catch {
        return [];
      }
    });
    cachedHistory = { path: sessionPath, size: stats.size, modifiedAt: stats.mtimeMs, records };
    return records;
  } finally {
    await file.close();
  }
};

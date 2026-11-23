import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { TiduError } from "../core/index.js";

const MAXIMUM_EVENT_BYTES = 1_048_576;
const MAXIMUM_ERROR_TEXT = 240;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

const readTokenCount = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) return undefined;
  const count = value[key];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
};

const assistantText = (event: Record<string, unknown>): string => {
  if (!isRecord(event.message) || !Array.isArray(event.message.content)) return "";
  return event.message.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("");
};

const toolDescription = (event: Record<string, unknown>): string => {
  if (!isRecord(event.tool_call)) return "Cursor 正在调用工具";
  const toolName = Object.keys(event.tool_call)[0];
  if (toolName === undefined) return "Cursor 正在调用工具";
  const tool = event.tool_call[toolName];
  const argumentsValue = isRecord(tool) && isRecord(tool.args) ? tool.args : undefined;
  const target =
    readString(argumentsValue, "path") ??
    readString(argumentsValue, "query") ??
    readString(argumentsValue, "command");
  return target === undefined
    ? `Cursor 正在调用 ${toolName}`
    : `Cursor 正在调用 ${toolName}：${target}`;
};

export interface CursorHeadlessUsage {
  /** Total input, including tokens read from and written to cache. */
  inputTokens: number;
  /** Input outside disjoint cache reads and writes, when established by native counters. */
  freshInputTokens?: number;
  /** Output tokens reported by the Cursor CLI. */
  outputTokens: number;
  /** Combined input and output tokens. */
  totalTokens: number;
  /** Cached input tokens reported separately by the Cursor CLI. */
  cachedInputTokens?: number;
  /** Cache-write input tokens reported separately by the Cursor CLI. */
  cacheWriteInputTokens?: number;
  /** Reasoning tokens already included in output, when reported. */
  reasoningTokens?: number;
}

export interface CursorHeadlessResult {
  /** Complete assistant response from the terminal result event. */
  text: string;
  /** Provider-authoritative token counts, or null when available counters cannot establish the total. */
  usage: CursorHeadlessUsage | null;
}

export interface CursorHeadlessOptions {
  /** Official Cursor Agent executable. */
  command: string;
  /** Sanitized environment owned by the Cursor host adapter. */
  environment: NodeJS.ProcessEnv;
  /** Private temporary directory created by AI-Tidu9 for this run. */
  workingDirectory: string;
  /** Exact provider-owned model identifier selected by configuration. */
  model: string;
  /** Prompt supplied on stdin so user text is never parsed as CLI options. */
  prompt: string;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
  /** Receives real Cursor thinking and tool lifecycle updates. */
  onProcessDelta?: (delta: string) => void;
  /** Receives assistant text deltas. */
  onTextDelta?: (delta: string) => void;
  /** Receives reported usage before success or failure is validated. */
  onUsageUpdate?: (usage: CursorHeadlessUsage) => void;
}

export const runCursorHeadless = async (
  options: CursorHeadlessOptions,
): Promise<CursorHeadlessResult> => runCursorCommand(options, options.onTextDelta !== undefined);

const runCursorCommand = async (
  options: CursorHeadlessOptions,
  partialOutput: boolean,
): Promise<CursorHeadlessResult> => {
  if (options.signal?.aborted) throw new DOMException("Cursor request cancelled.", "AbortError");
  const child = spawn(
    options.command,
    [
      "--print",
      "--trust",
      "--mode",
      "ask",
      "--output-format",
      "stream-json",
      ...(partialOutput ? ["--stream-partial-output"] : []),
      "--model",
      options.model,
    ],
    {
      cwd: options.workingDirectory,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exitPromise = new Promise<
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "error"; error: Error }
  >((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("close", (code, signal) => resolve({ kind: "exit", code, signal }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let assistantOutput = "";
  let resultText: string | undefined;
  let usage: CursorHeadlessUsage | null = null;
  let sawUsageCounters = false;
  let standardError = "";
  let activeProcessKey: string | undefined;
  let receivedEvent = false;

  const emitProcessDelta = (processKey: string, delta: string): void => {
    if (delta === "") return;
    if (activeProcessKey !== undefined && activeProcessKey !== processKey) {
      options.onProcessDelta?.("\n\n");
    }
    activeProcessKey = processKey;
    options.onProcessDelta?.(delta);
  };
  const abort = (): void => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    standardError = `${standardError}${chunk}`.slice(-MAXIMUM_ERROR_TEXT);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      standardError = `${standardError}${error.message}`.slice(-MAXIMUM_ERROR_TEXT);
    }
  });
  child.stdin.end(options.prompt);

  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAXIMUM_EVENT_BYTES) {
        child.kill("SIGTERM");
        throw new TiduError("INTERNAL_ERROR", "Cursor stream event exceeds the size limit.");
      }
      if (line.trim() === "") continue;
      receivedEvent = true;
      let event: unknown;
      try {
        event = JSON.parse(line) as unknown;
      } catch {
        child.kill("SIGTERM");
        throw new TiduError("INTERNAL_ERROR", "Cursor returned invalid stream JSON.");
      }
      if (!isRecord(event)) continue;
      const type = readString(event, "type");
      const subtype = readString(event, "subtype");
      if (options.signal?.aborted && type !== "result") continue;
      if (type === "thinking" && subtype === "delta") {
        const text = readString(event, "text");
        if (text !== undefined) emitProcessDelta("thinking", text);
        continue;
      }
      if (type === "tool_call" && subtype === "started") {
        emitProcessDelta(
          `tool:${readString(event, "call_id") ?? "unknown"}`,
          toolDescription(event),
        );
        options.onProcessDelta?.("\n\n");
        activeProcessKey = undefined;
        continue;
      }
      if (type === "assistant") {
        // Partial streams also flush buffered text before tools and at the end of the turn.
        if (partialOutput && (event.timestamp_ms == null || event.model_call_id != null)) continue;
        if (activeProcessKey !== undefined) {
          options.onProcessDelta?.("\n\n");
          activeProcessKey = undefined;
        }
        const delta = assistantText(event);
        if (delta !== "") {
          assistantOutput += delta;
          options.onTextDelta?.(delta);
        }
        continue;
      }
      if (type !== "result") continue;
      const rawInput = readTokenCount(event.usage, "inputTokens");
      const outputTokens = readTokenCount(event.usage, "outputTokens");
      if (rawInput !== undefined && outputTokens !== undefined) {
        sawUsageCounters = true;
        const cachedInputTokens = readTokenCount(event.usage, "cacheReadTokens");
        const cacheWriteInputTokens = readTokenCount(event.usage, "cacheWriteTokens");
        const reasoningTokens = readTokenCount(event.usage, "reasoningTokens");
        const cacheTotal =
          cachedInputTokens === undefined || cacheWriteInputTokens === undefined
            ? undefined
            : cachedInputTokens + cacheWriteInputTokens;
        // Modern CLI input is fresh. Older terminals with an explicit total may report inclusive input.
        const nativeTotal = readTokenCount(event.usage, "totalTokens");
        const totalTokens =
          nativeTotal ??
          (cacheTotal === undefined ? undefined : rawInput + cacheTotal + outputTokens);
        if (totalTokens !== undefined) {
          const inputTokens = totalTokens - outputTokens;
          if (inputTokens < 0 || !Number.isSafeInteger(totalTokens)) {
            throw new TiduError("INTERNAL_ERROR", "Cursor returned inconsistent token usage.");
          }
          const freshInputTokens = cacheTotal === undefined ? undefined : inputTokens - cacheTotal;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens,
            ...(freshInputTokens === undefined || freshInputTokens < 0 ? {} : { freshInputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
          };
          options.onUsageUpdate?.(usage);
        }
      }
      if (subtype !== "success" || event.is_error === true) {
        if (options.signal?.aborted)
          throw new DOMException("Cursor request cancelled.", "AbortError");
        throw new TiduError(
          "INTERNAL_ERROR",
          readString(event, "result") ?? "Cursor did not complete the request.",
        );
      }
      resultText = readString(event, "result");
      if (!sawUsageCounters) {
        throw new TiduError(
          "INTERNAL_ERROR",
          "Cursor completed without provider-authoritative token usage.",
        );
      }
    }
    const exit = await exitPromise;
    if (options.signal?.aborted) {
      throw new DOMException("Cursor request cancelled.", "AbortError");
    }
    if (exit.kind === "error") {
      throw new TiduError("INTERNAL_ERROR", exit.error.message);
    }
    if (exit.code !== 0 || exit.signal !== null) {
      if (
        partialOutput &&
        !receivedEvent &&
        exit.signal === null &&
        /^(?:error:\s*)?(?:unknown|unrecognized) (?:option|argument) ['"]?--stream-partial-output['"]?\s*$/imu.test(
          standardError,
        )
      ) {
        return runCursorCommand(options, false);
      }
      throw new TiduError(
        "INTERNAL_ERROR",
        standardError.trim() || "Cursor Agent exited before completing the request.",
      );
    }
    const text = resultText ?? assistantOutput;
    if (text.trim() === "" || !sawUsageCounters) {
      throw new TiduError("INTERNAL_ERROR", "Cursor returned an incomplete terminal result.");
    }
    if (assistantOutput === "") options.onTextDelta?.(text);
    return { text, usage };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    lines.close();
  }
};

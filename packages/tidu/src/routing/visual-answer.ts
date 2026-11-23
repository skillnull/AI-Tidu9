import {
  extractProviderUsage,
  type ProviderExecutionReceipt,
  type ProviderExecutionResult,
  type ProviderProtocol,
} from "../providers/index.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A refusal, tool call, second answer or non-text content must stay on the original route.
const responseText = (body: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(body.output)) {
    return typeof body.output_text === "string" ? body.output_text : undefined;
  }
  const finalItems = body.output.filter(
    (item: unknown) =>
      !(
        record(item) &&
        (item.type === "reasoning" || (item.type === "message" && item.phase === "commentary"))
      ),
  );
  if (finalItems.length !== 1) return undefined;
  const message: unknown = finalItems[0];
  if (
    !record(message) ||
    message.type !== "message" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length === 0
  )
    return undefined;
  const fragments: string[] = [];
  for (const part of message.content) {
    if (!record(part) || part.type !== "output_text" || typeof part.text !== "string")
      return undefined;
    fragments.push(part.text);
  }
  return fragments.join("");
};

const chatText = (body: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(body.choices) || body.choices.length !== 1) return undefined;
  const choice: unknown = body.choices[0];
  if (!record(choice) || choice.finish_reason !== "stop" || !record(choice.message))
    return undefined;
  const message = choice.message;
  return message.role === "assistant" &&
    !message.tool_calls &&
    !message.function_call &&
    !message.refusal &&
    typeof message.content === "string"
    ? message.content
    : undefined;
};

interface AnswerInspection {
  /** Unmodified ordinary response, or an empty body for a consumed private marker. */
  result: ProviderExecutionResult;
  /** A successful, unambiguous request from the writer to consult the image. */
  needsImage: boolean;
  /** Actual usage for the consumed request, when the host supplied it. */
  usage: ProviderExecutionReceipt["usage"];
}

// Until the first answer bytes distinguish the route, the original wire prefix must be replayable.
const MAX_PENDING_BYTES = 512 * 1024;

export async function inspectVisualAnswer(
  result: ProviderExecutionResult,
  protocol: ProviderProtocol,
  marker: string,
  signal?: AbortSignal,
): Promise<AnswerInspection> {
  signal?.throwIfAborted();
  const ordinary = { result, needsImage: false, usage: null };
  if (!marker || result.statusCode < 200 || result.statusCode >= 300) return ordinary;
  if (result.kind === "json") {
    const body = result.body;
    if (!record(body) || body.error) return ordinary;
    const text =
      protocol === "chat-completions"
        ? chatText(body)
        : body.status === "completed"
          ? responseText(body)
          : undefined;
    return text === marker
      ? {
          needsImage: true,
          usage: extractProviderUsage(body.usage),
          result: { ...result, body: {} },
        }
      : ordinary;
  }

  const reader = result.stream.getReader();
  const prefix: Uint8Array[] = [];
  const commentary = new Set<unknown>();
  const decoder = new TextDecoder();
  let pending = "";
  let prefixBytes = 0;
  let text = "";
  let complete = false;
  let usage: ProviderExecutionReceipt["usage"] = null;
  let outputItem: unknown;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = (): void => {
    controller?.error(signal?.reason);
    void reader
      .cancel(signal?.reason)
      .catch(() => undefined)
      .finally(release);
  };
  signal?.addEventListener("abort", abort, { once: true });

  const mayBeMarker = (frame: string): boolean => {
    const data = frame
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) return true;
    if (data === "[DONE]") return true;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return false;
    }
    if (!record(event) || event.error) return false;
    if (protocol === "chat-completions") {
      usage = extractProviderUsage(event.usage) ?? usage;
      if (!Array.isArray(event.choices) || event.choices.length > 1) return false;
      if (event.choices.length === 0) return true;
      const choice: unknown = event.choices[0];
      if (!record(choice) || (choice.index != null && choice.index !== 0)) return false;
      if (choice.finish_reason != null) {
        if (choice.finish_reason !== "stop") return false;
        complete = true;
      }
      const delta = choice.delta;
      if (
        !record(delta) ||
        delta.tool_calls ||
        delta.function_call ||
        delta.refusal ||
        (delta.role != null && delta.role !== "assistant")
      )
        return false;
      if (delta.content != null) {
        if (typeof delta.content !== "string") return false;
        text += delta.content;
      }
      return marker.startsWith(text);
    }
    const kind = event.type;
    if (
      typeof kind !== "string" ||
      kind === "error" ||
      kind === "response.failed" ||
      kind === "response.incomplete" ||
      kind === "response.cancelled"
    )
      return false;
    if (kind === "response.completed") {
      if (
        !record(event.response) ||
        event.response.error ||
        (event.response.status != null && event.response.status !== "completed")
      )
        return false;
      const response = event.response;
      if (response.output !== undefined || response.output_text !== undefined) {
        const final = responseText(response);
        if (final !== marker || !final.startsWith(text)) return false;
        text = final;
      }
      complete = true;
      usage = extractProviderUsage(response.usage);
      return true;
    }
    if (kind === "response.output_item.added" || kind === "response.output_item.done") {
      const item = event.item;
      if (!record(item)) return false;
      if (item.type === "reasoning") return true;
      if (item.type !== "message" || item.role !== "assistant") return false;
      const id = item.id ?? event.output_index;
      if (item.phase === "commentary") {
        commentary.add(id);
        return true;
      }
      if (outputItem !== undefined && id !== outputItem) return false;
      outputItem = id;
      if (kind.endsWith(".done")) {
        const final = responseText({ output: [item] });
        if (final !== marker || !final.startsWith(text)) return false;
        text = final;
      }
      return true;
    }
    if (commentary.has(event.item_id ?? event.output_index)) return true;
    if (kind === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      return marker.startsWith(text);
    }
    if (kind === "response.output_text.done") {
      if (event.text !== marker || !marker.startsWith(text)) return false;
      text = marker;
    }
    if (kind === "response.content_part.added" || kind === "response.content_part.done") {
      if (!record(event.part) || event.part.type !== "output_text") return false;
      if (
        typeof event.part.text === "string" &&
        event.part.text &&
        !marker.startsWith(event.part.text)
      )
        return false;
    }
    return !/call|refusal/u.test(kind);
  };

  const replay = (): AnswerInspection => {
    let nextChunk = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(target) {
          controller = target;
        },
        async pull(target) {
          try {
            signal?.throwIfAborted();
            const buffered = prefix[nextChunk];
            if (buffered !== undefined) {
              nextChunk++;
              target.enqueue(buffered);
              if (nextChunk === prefix.length) prefix.length = 0;
              return;
            }
            const next = await reader.read();
            if (next.done) {
              release();
              target.close();
            } else target.enqueue(next.value);
          } catch (error) {
            release();
            target.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return { ...ordinary, result: { ...result, stream } };
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (!chunk.done) {
        prefix.push(chunk.value);
        prefixBytes += chunk.value.byteLength;
      }
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const separator = /\r\n\r\n|\n\n|\r\r/u.exec(pending);
        if (!separator) break;
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        if (!mayBeMarker(frame)) return replay();
      }
      if (chunk.done) {
        if ((pending && !mayBeMarker(pending)) || !complete || text !== marker) return replay();
        release();
        return {
          needsImage: true,
          usage,
          result: {
            ...result,
            stream: new ReadableStream({
              start(target) {
                target.close();
              },
            }),
          },
        };
      }
      // A long native preamble takes precedence over the optional image-routing probe.
      if (prefixBytes >= MAX_PENDING_BYTES) return replay();
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } finally {
      release();
    }
    throw error;
  }
}

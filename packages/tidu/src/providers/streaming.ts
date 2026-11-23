import { randomUUID } from "node:crypto";

type ResponseObserver = (body: Record<string, unknown>) => void;

export interface OllamaStreamOptions {
  /** Client-facing OpenAI-compatible protocol. */
  protocol: "chat-completions" | "responses";
  /** Virtual model identifier returned to the client. */
  virtualModelId: string;
  /** Reads native model identity and usage before virtual model translation. */
  observeResponse?: ResponseObserver;
}

export interface NormalizedToolCall {
  /** Stable call identifier used by later tool-result messages. */
  id: string;
  /** OpenAI-compatible tool discriminator. */
  type: "function";
  /** Function name and serialized JSON arguments. */
  function: {
    /** Function registered by the client. */
    name: string;
    /** JSON arguments serialized for OpenAI-compatible clients. */
    arguments: string;
  };
}

const encoder = new TextEncoder();
const MAXIMUM_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringifyArguments = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {});
};

export const normalizeOllamaToolCalls = (value: unknown): readonly NormalizedToolCall[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.function)) {
      return [];
    }
    const name = candidate.function.name;
    if (typeof name !== "string" || name === "") {
      return [];
    }
    return [
      {
        id: typeof candidate.id === "string" ? candidate.id : `call_${randomUUID()}`,
        type: "function" as const,
        function: {
          name,
          arguments: stringifyArguments(candidate.function.arguments),
        },
      },
    ];
  });
};

const createStreamFromIterator = (
  iterator: AsyncGenerator<string, void, undefined>,
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: async () => {
      await iterator.return();
    },
  });

async function* readDelimitedText(
  source: ReadableStream<Uint8Array>,
  delimiter: RegExp,
): AsyncGenerator<string, void, undefined> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_STREAM_BUFFER_BYTES) {
        throw new Error("Provider stream event exceeds the supported size.");
      }
      while (true) {
        const match = delimiter.exec(buffer);
        if (match?.index === undefined) {
          break;
        }
        yield buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") {
      yield buffer;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const replaceVirtualModel = (value: unknown, virtualModelId: string): unknown => {
  if (!isRecord(value)) {
    return value;
  }
  const rewritten = { ...value };
  if (typeof rewritten.model === "string") {
    rewritten.model = virtualModelId;
  }
  if (isRecord(rewritten.response)) {
    rewritten.response = replaceVirtualModel(rewritten.response, virtualModelId);
  }
  return rewritten;
};

const rewriteSseEvent = (
  event: string,
  virtualModelId: string,
  observeResponse?: ResponseObserver,
): string =>
  event
    .split(/\r?\n/u)
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const data = line.slice(5).trimStart();
      if (data === "[DONE]") {
        return line;
      }
      const body: unknown = JSON.parse(data);
      if (isRecord(body)) observeResponse?.(isRecord(body.response) ? body.response : body);
      return `data: ${JSON.stringify(replaceVirtualModel(body, virtualModelId))}`;
    })
    .join("\n");

export const rewriteOpenAiSseStream = (
  source: ReadableStream<Uint8Array>,
  virtualModelId: string,
  observeResponse?: ResponseObserver,
): ReadableStream<Uint8Array> => {
  async function* rewrite(): AsyncGenerator<string, void, undefined> {
    for await (const event of readDelimitedText(source, /\r?\n\r?\n/u)) {
      yield `${rewriteSseEvent(event, virtualModelId, observeResponse)}\n\n`;
    }
  }
  return createStreamFromIterator(rewrite());
};

const createChatChunk = (
  responseId: string,
  created: number,
  virtualModelId: string,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
  usage?: Record<string, number>,
): string =>
  `data: ${JSON.stringify({
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model: virtualModelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  })}\n\n`;

/** Ollama reports these counts on final responses; an absent counter is unknown. */
export const readOllamaUsage = (body: Record<string, unknown>) => {
  const promptTokens = body.prompt_eval_count;
  const completionTokens = body.eval_count;
  if (
    typeof promptTokens !== "number" ||
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== "number" ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0 ||
    !Number.isSafeInteger(promptTokens + completionTokens)
  )
    return undefined;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
};

async function* streamOllamaChat(
  source: ReadableStream<Uint8Array>,
  { virtualModelId, observeResponse }: OllamaStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const responseId = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  let firstChunk = true;
  let toolCallSeen = false;
  for await (const line of readDelimitedText(source, /\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    const body = JSON.parse(line) as Record<string, unknown>;
    const usage = body.done === true ? readOllamaUsage(body) : undefined;
    observeResponse?.({ model: body.model, usage });
    const message = isRecord(body.message) ? body.message : {};
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = normalizeOllamaToolCalls(message.tool_calls);
    const delta: Record<string, unknown> = {};
    if (firstChunk) {
      delta.role = "assistant";
      firstChunk = false;
    }
    if (content !== "") {
      delta.content = content;
    }
    if (toolCalls.length > 0) {
      toolCallSeen = true;
      delta.tool_calls = toolCalls.map((toolCall, index) => ({ index, ...toolCall }));
    }
    if (Object.keys(delta).length > 0) {
      yield createChatChunk(responseId, created, virtualModelId, delta, null);
    }
    if (body.done === true) {
      yield createChatChunk(
        responseId,
        created,
        virtualModelId,
        {},
        toolCallSeen ? "tool_calls" : "stop",
        usage,
      );
      yield "data: [DONE]\n\n";
    }
  }
}

const createResponseState = (responseId: string, virtualModelId: string) => ({
  id: responseId,
  object: "response",
  created_at: Math.floor(Date.now() / 1_000),
  model: virtualModelId,
  status: "in_progress",
  output: [] as unknown[],
});

const responseEvent = (type: string, body: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

async function* streamOllamaResponses(
  source: ReadableStream<Uint8Array>,
  { virtualModelId, observeResponse }: OllamaStreamOptions,
): AsyncGenerator<string, void, undefined> {
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  const response = createResponseState(responseId, virtualModelId);
  let messageStarted = false;
  let outputText = "";
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
  yield responseEvent("response.created", { response });
  for await (const line of readDelimitedText(source, /\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    const body = JSON.parse(line) as Record<string, unknown>;
    const nativeUsage = body.done === true ? readOllamaUsage(body) : undefined;
    observeResponse?.({ model: body.model, usage: nativeUsage });
    const message = isRecord(body.message) ? body.message : {};
    const content = typeof message.content === "string" ? message.content : "";
    if (content !== "" && !messageStarted) {
      messageStarted = true;
      yield responseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          id: messageId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      yield responseEvent("response.content_part.added", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    if (content !== "") {
      outputText += content;
      yield responseEvent("response.output_text.delta", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
    }
    const toolCalls = normalizeOllamaToolCalls(message.tool_calls);
    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      const outputIndex = messageStarted ? toolIndex + 1 : toolIndex;
      const item = {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      };
      response.output.push(item);
      yield responseEvent("response.output_item.added", { output_index: outputIndex, item });
      yield responseEvent("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: toolCall.function.arguments,
      });
      yield responseEvent("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: toolCall.function.arguments,
      });
      yield responseEvent("response.output_item.done", { output_index: outputIndex, item });
    }
    if (body.done === true) {
      usage = nativeUsage && {
        input_tokens: nativeUsage.prompt_tokens,
        output_tokens: nativeUsage.completion_tokens,
        total_tokens: nativeUsage.total_tokens,
      };
    }
  }
  if (messageStarted) {
    const item = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    };
    response.output.unshift(item);
    yield responseEvent("response.output_text.done", {
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: outputText,
    });
    yield responseEvent("response.content_part.done", {
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    });
    yield responseEvent("response.output_item.done", { output_index: 0, item });
  }
  response.status = "completed";
  yield responseEvent("response.completed", { response: { ...response, usage } });
}

export const createOllamaSseStream = (
  source: ReadableStream<Uint8Array>,
  options: OllamaStreamOptions,
): ReadableStream<Uint8Array> =>
  createStreamFromIterator(
    options.protocol === "chat-completions"
      ? streamOllamaChat(source, options)
      : streamOllamaResponses(source, options),
  );

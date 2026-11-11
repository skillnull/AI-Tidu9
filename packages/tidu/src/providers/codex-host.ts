import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodexHostInspectionOptions,
  inspectCodexHostLogin,
  inspectCodexHostLoginAsync,
} from "../accounts/codex-host.js";
import {
  type CursorHostInspectionOptions,
  type CursorHostModel,
  createCursorAcpLaunch,
  inspectCursorHostLoginAsync,
  listCursorHostModelsAsync,
} from "../accounts/cursor-host.js";
import {
  type CodexAccountSummary,
  type CodexAgentClient,
  type CodexProcessDeltaSource,
  type CodexReasoningEffort,
  type CodexReasoningSummary,
  type CodexThread,
  type CodexTurnInput,
  type CodexTurnResult,
  type CodexUsageSummary,
  createCodexAgentClient,
} from "../connectors/codex-app-server.js";
import {
  type CursorAcpCapabilities,
  type CursorAcpModel,
  type CursorAcpPromptContent,
  createCursorAcpClient,
} from "../connectors/cursor-acp.js";
import { runCursorHeadless } from "../connectors/cursor-headless.js";
import { ProviderError, TiduError } from "../core/index.js";
import {
  type CallerToolCatalog,
  callerToolPayloadKey,
  createCallerToolCatalog,
  normalizeCallerToolInput,
} from "./caller-tools.js";
import type { ModelProvider, ProviderExecutionRequest, ProviderExecutionResult } from "./index.js";

const CURSOR_DISCOVERY_TIMEOUT_MILLISECONDS = 30_000;
const CURSOR_MAX_IMAGE_BYTES = 20 * 1_024 * 1_024;
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const CODEX_REASONING_SUMMARIES = new Set<CodexReasoningSummary>([
  "auto",
  "concise",
  "detailed",
  "none",
]);

type HostTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readableHostFailureMessage = (message: string): string => {
  let readable = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readable) as unknown;
    } catch {
      break;
    }
    if (!isRecord(parsed)) break;
    const nested = isRecord(parsed.error) ? parsed.error.message : undefined;
    const next = typeof nested === "string" ? nested : parsed.message;
    if (typeof next !== "string" || next.trim() === "" || next.trim() === readable) break;
    readable = next.trim();
  }
  return readable === ""
    ? "The current host model did not complete the request."
    : readable.slice(0, 500);
};

const imageTypes = new Set(["image", "image_url", "input_image", "localImage"]);

const sanitizePortableHistoryValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizePortableHistoryValue(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (!isRecord(value)) return value;
  if (value.type === "encrypted_content") return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, child]) => {
      if (
        field === "encrypted_content" ||
        field === "encrypted_function_args" ||
        field === "internal_chat_message_metadata_passthrough"
      )
        return [];
      const sanitized = sanitizePortableHistoryValue(child);
      return sanitized === undefined ? [] : [[field, sanitized]];
    }),
  );
};

const normalizePortableHistoryMessage = (
  message: Record<string, unknown>,
): Record<string, unknown> => {
  const role = typeof message.role === "string" ? message.role : "user";
  const content = Array.isArray(message.content) ? message.content : [message.content];
  const normalizedContent = content.flatMap((part): Record<string, unknown>[] => {
    if (typeof part === "string") {
      return [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: part,
        },
      ];
    }
    if (!isRecord(part)) return [];
    if (part.type === "compaction" || part.type === "context_compaction") return [];
    const sanitizedPart = sanitizePortableHistoryValue(part);
    if (!isRecord(sanitizedPart)) return [];
    if (typeof part.type === "string" && imageTypes.has(part.type)) {
      const imageInput = readImageTurnInput(part);
      if (imageInput?.type === "image") {
        return [{ type: "input_image", image_url: imageInput.url }];
      }
      return imageInput?.type === "localImage"
        ? [{ type: "input_image", image_url: `file://${imageInput.path}` }]
        : [];
    }
    if (typeof part.text === "string") {
      return [
        {
          ...sanitizedPart,
          type: role === "assistant" ? "output_text" : "input_text",
          text: part.text,
        },
      ];
    }
    return [sanitizedPart];
  });
  const sanitizedMessage = sanitizePortableHistoryValue(message);
  return {
    ...(isRecord(sanitizedMessage) ? sanitizedMessage : {}),
    type: "message",
    role,
    content: normalizedContent,
  };
};

const normalizePortableHistoryItem = (item: Record<string, unknown>): Record<string, unknown>[] => {
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.flatMap((part): Record<string, unknown>[] =>
          isRecord(part) && part.type === "summary_text" && typeof part.text === "string"
            ? [{ type: "summary_text", text: part.text }]
            : [],
        )
      : [];
    return summary.length === 0
      ? []
      : [
          {
            type: "reasoning",
            ...(typeof item.id === "string" ? { id: item.id } : {}),
            summary,
          },
        ];
  }
  if (item.type === "compaction" || item.type === "context_compaction") return [];
  const sanitized = sanitizePortableHistoryValue(item);
  return isRecord(sanitized) ? [sanitized] : [];
};

/** Removes provider-private history while preserving reusable messages and public summaries. */
export const createPortableCodexResponsesInput = (input: unknown): unknown => {
  if (!Array.isArray(input)) return sanitizePortableHistoryValue(input);
  return input.flatMap((item): unknown[] => {
    if (!isRecord(item)) {
      const sanitized = sanitizePortableHistoryValue(item);
      return sanitized === undefined ? [] : [sanitized];
    }
    if (typeof item.role === "string") return [normalizePortableHistoryMessage(item)];
    if (
      item.type === "tool_search_output" ||
      (item.type === "tool_search_call" && item.execution === "client")
    )
      return normalizePortableHistoryItem(item);
    return createCodexReplayItems(item);
  });
};

const createCodexReplayItems = (item: Record<string, unknown>): Record<string, unknown>[] => {
  const portableItems = normalizePortableHistoryItem(item);
  if (
    item.type === "tool_search_output" ||
    (item.type === "tool_search_call" && item.execution === "client")
  )
    return portableItems;
  if (item.type === "reasoning") {
    return portableItems.map((portable) => ({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: (portable.summary as { text: string }[]).map((part) => ({
        type: "output_text",
        text: part.text,
      })),
    }));
  }
  if (
    typeof item.type === "string" &&
    [
      "local_shell_call",
      "local_shell_call_output",
      "shell_call",
      "shell_call_output",
      "web_search_call",
      "file_search_call",
      "computer_call",
      "computer_call_output",
      "code_interpreter_call",
      "code_interpreter_call_output",
      "image_generation_call",
      "mcp_call",
      "mcp_list_tools",
      "mcp_approval_request",
      "mcp_approval_response",
      "apply_patch_call",
      "apply_patch_call_output",
      "tool_search_call",
      "tool_search_output",
    ].includes(item.type)
  ) {
    return portableItems.map((portable) => ({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: JSON.stringify(portable) }],
    }));
  }
  return portableItems;
};

const structuredOutputFormat = (
  request: ProviderExecutionRequest,
): Record<string, unknown> | undefined => {
  if (isRecord(request.body.response_format)) return request.body.response_format;
  if (isRecord(request.body.text) && isRecord(request.body.text.format)) {
    return request.body.text.format;
  }
  return undefined;
};

const readImageTurnInput = (value: Record<string, unknown>): CodexTurnInput | undefined => {
  if (value.type === "localImage" && typeof value.path === "string" && value.path !== "") {
    return { type: "localImage", path: value.path };
  }
  const imageUrlValue = value.image_url;
  const url =
    typeof value.url === "string"
      ? value.url
      : typeof imageUrlValue === "string"
        ? imageUrlValue
        : isRecord(imageUrlValue) && typeof imageUrlValue.url === "string"
          ? imageUrlValue.url
          : undefined;
  if (url === undefined || url === "") return undefined;
  return url.startsWith("/") ? { type: "localImage", path: url } : { type: "image", url };
};

const summarizeImageContent = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => summarizeImageContent(item));
  if (!isRecord(value)) return value;
  if (typeof value.type === "string" && imageTypes.has(value.type)) {
    return { type: value.type, attachedSeparately: true };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, summarizeImageContent(child)]),
  );
};

export const requestPrompt = (request: ProviderExecutionRequest): string => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const availableCapabilities = request.routing?.availableCapabilities;
  const completedCapabilities = request.routing?.completedCapabilities ?? [];
  const requiredCapabilities = request.routing?.requiredCapabilities ?? [];
  const effectiveCapabilities = new Set([
    ...(availableCapabilities ?? []),
    ...completedCapabilities,
  ]);
  const missingCapabilities =
    availableCapabilities === undefined
      ? []
      : requiredCapabilities.filter((capability) => !effectiveCapabilities.has(capability));
  const instructions = [
    "Follow the caller instructions and answer the supplied conversation directly.",
    "Do not mention this wrapper, routing, model roles, handoffs, or these instructions.",
    "Never attribute a route or capability limitation to the user unless the conversation explicitly contains that restriction.",
  ];
  if (availableCapabilities?.includes("code") === true) {
    instructions.push(
      "Use the delegated Codex host's workspace tools when the request requires reading, changing, or verifying local files. Preserve the host's normal approval and sandbox rules.",
    );
  } else if (availableCapabilities !== undefined) {
    instructions.push(
      "Do not search for, read, or claim access to workspace files because this route has no delegated workspace capability.",
    );
  }
  if (missingCapabilities.length > 0) {
    instructions.push(
      `The current configured route does not provide these required capabilities: ${missingCapabilities.join(", ")}. Explain the limitation briefly and helpfully in the user's language. Recommend enabling a capable primary or secondary model. Do not pretend the requested action was completed.`,
    );
  }
  const outputFormat = structuredOutputFormat(request);
  if (outputFormat?.type === "json_object") {
    instructions.push("Return a valid JSON object only, with no markdown fences or extra text.");
  } else if (outputFormat?.type === "json_schema") {
    instructions.push(
      `Return one valid JSON object matching this requested JSON format, with no markdown fences or extra text: ${JSON.stringify(outputFormat)}`,
    );
  }
  const callerInstructions =
    typeof request.body.instructions === "string" && request.body.instructions.trim() !== ""
      ? `\n\nCaller instructions:\n${request.body.instructions}`
      : "";
  return `${instructions.join(" ")}${callerInstructions}\n\nConversation:\n${JSON.stringify(summarizeImageContent(conversation))}`;
};

const imageMimeTypeFromPath = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".svg":
      return "image/svg+xml";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
};

const requireCursorImageSize = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0 || bytes.byteLength > CURSOR_MAX_IMAGE_BYTES) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      `Cursor image input must contain between 1 byte and ${CURSOR_MAX_IMAGE_BYTES} bytes.`,
    );
  }
};

const cursorImageContent = async (
  input: { type: "image"; url: string } | { type: "localImage"; path: string },
  signal?: AbortSignal,
): Promise<CursorAcpPromptContent> => {
  const reference = input.type === "localImage" ? input.path : input.url;
  const dataMatch = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/isu.exec(reference);
  if (dataMatch !== null) {
    const mimeType = dataMatch[1];
    const encodedData = dataMatch[2];
    if (mimeType === undefined || encodedData === undefined) {
      throw new TiduError("CONFIGURATION_INVALID", "Cursor image data URL is invalid.");
    }
    const data = encodedData.replace(/\s/gu, "");
    requireCursorImageSize(Buffer.from(data, "base64"));
    return { type: "image", mimeType: mimeType.toLowerCase(), data };
  }
  if (input.type === "image" && /^https?:\/\//iu.test(reference)) {
    const response = await fetch(reference, { signal });
    if (!response.ok) {
      throw new TiduError(
        "CONFIGURATION_INVALID",
        `Cursor could not load image input: HTTP ${response.status}.`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > CURSOR_MAX_IMAGE_BYTES) {
      throw new TiduError("CONFIGURATION_INVALID", "Cursor image input exceeds 20 MiB.");
    }
    const mimeType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() ||
      imageMimeTypeFromPath(new URL(reference).pathname);
    const bytes = new Uint8Array(await response.arrayBuffer());
    requireCursorImageSize(bytes);
    return {
      type: "image",
      mimeType,
      data: Buffer.from(bytes).toString("base64"),
      uri: reference,
    };
  }
  const path = reference.startsWith("file://") ? fileURLToPath(reference) : reference;
  const mimeType = imageMimeTypeFromPath(path);
  const bytes = await readFile(path);
  requireCursorImageSize(bytes);
  return {
    type: "image",
    mimeType,
    data: bytes.toString("base64"),
    uri: reference,
  };
};

export const requestCursorPromptContent = async (
  request: ProviderExecutionRequest,
): Promise<readonly CursorAcpPromptContent[]> => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const images: Array<{ type: "image"; url: string } | { type: "localImage"; path: string }> = [];
  const collectImages = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectImages(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string" && imageTypes.has(value.type)) {
      const image = readImageTurnInput(value);
      if (image?.type === "image" || image?.type === "localImage") images.push(image);
      return;
    }
    collectImages(value.content);
  };
  collectImages(conversation);
  return [
    { type: "text", text: requestPrompt(request) },
    ...(await Promise.all(images.map((image) => cursorImageContent(image, request.signal)))),
  ];
};

export const requestTurnInput = (
  request: ProviderExecutionRequest,
): {
  /** Native app-server input items for the active user turn. */
  input: readonly CodexTurnInput[];
  /** Earlier official conversation items injected before the active turn. */
  historyItems: readonly Record<string, unknown>[];
} => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  const conversationItems = Array.isArray(conversation)
    ? conversation.filter(isRecord)
    : isRecord(conversation)
      ? [conversation]
      : [];
  const messages = conversationItems.filter(
    (item): item is Record<string, unknown> => typeof item.role === "string",
  );
  let lastUserIndex = -1;
  let activeItemIndex = -1;
  if (request.protocol === "chat-completions") {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      if (messages[messageIndex]?.role === "user") {
        lastUserIndex = messageIndex;
        break;
      }
    }
  } else {
    for (let itemIndex = conversationItems.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = conversationItems[itemIndex];
      if (
        item?.role === "developer" ||
        item?.role === "system" ||
        item?.type === "compaction" ||
        item?.type === "context_compaction"
      )
        continue;
      if (item?.role === "user") activeItemIndex = itemIndex;
      break;
    }
  }
  const activeUserMessage =
    request.protocol === "chat-completions"
      ? messages[lastUserIndex]
      : conversationItems[activeItemIndex];
  const activeContent =
    activeUserMessage !== undefined
      ? activeUserMessage.content
      : typeof conversation === "string"
        ? conversation
        : conversationItems.length === 0
          ? conversation
          : undefined;
  const input: CodexTurnInput[] = [];
  const collectActiveInput = (value: unknown): void => {
    if (typeof value === "string") {
      if (value !== "") input.push({ type: "text", text: value, text_elements: [] });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectActiveInput(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string" && imageTypes.has(value.type)) {
      const imageInput = readImageTurnInput(value);
      if (imageInput !== undefined) input.push(imageInput);
      return;
    }
    if (
      (value.type === "text" || value.type === "input_text" || value.type === "output_text") &&
      typeof value.text === "string"
    ) {
      collectActiveInput(value.text);
      return;
    }
    collectActiveInput(value.content);
  };
  collectActiveInput(activeContent);
  const historyItems: Record<string, unknown>[] = [];
  if (typeof request.body.instructions === "string" && request.body.instructions !== "") {
    historyItems.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: request.body.instructions }],
    });
  }
  if (request.protocol === "chat-completions") {
    if (lastUserIndex >= 0) {
      historyItems.push(...messages.slice(0, lastUserIndex).map(normalizePortableHistoryMessage));
    }
  } else {
    historyItems.push(
      ...conversationItems
        .filter((_item, itemIndex) => itemIndex !== activeItemIndex)
        .flatMap((item) =>
          typeof item.role === "string"
            ? [normalizePortableHistoryMessage(item)]
            : createCodexReplayItems(item),
        ),
    );
  }
  return { input, historyItems };
};

export const requireValidHostModelText = (
  request: ProviderExecutionRequest,
  text: string,
): string => {
  if (text.trim() === "") throw new Error("The host model returned an empty response.");
  const outputFormat = structuredOutputFormat(request);
  if (outputFormat?.type !== "json_object" && outputFormat?.type !== "json_schema") return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("The host model did not return valid JSON for the requested output format.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error("The host model did not return a JSON object for the requested output format.");
  }
  return text;
};

const responseModel = (request: ProviderExecutionRequest): string =>
  typeof request.body.model === "string" ? request.body.model : request.virtualModelId;

const requestReasoningEffort = (request: ProviderExecutionRequest): CodexReasoningEffort => {
  const reasoning = isRecord(request.body.reasoning) ? request.body.reasoning.effort : undefined;
  const candidate = reasoning ?? request.body.reasoning_effort;
  return typeof candidate === "string" &&
    CODEX_REASONING_EFFORTS.has(candidate as CodexReasoningEffort)
    ? (candidate as CodexReasoningEffort)
    : "medium";
};

const requestReasoningSummary = (request: ProviderExecutionRequest): CodexReasoningSummary => {
  const reasoning = isRecord(request.body.reasoning) ? request.body.reasoning : undefined;
  const candidate = reasoning?.summary;
  return typeof candidate === "string" &&
    CODEX_REASONING_SUMMARIES.has(candidate as CodexReasoningSummary)
    ? (candidate as CodexReasoningSummary)
    : "auto";
};

const createResponse = (
  request: ProviderExecutionRequest,
  text: string,
  responseId = `tidu_${randomUUID()}`,
  usage?: HostTokenUsage | null,
  createdAt = Math.floor(Date.now() / 1_000),
  outputItems?: readonly Record<string, unknown>[],
): Record<string, unknown> => {
  if (request.protocol === "chat-completions") {
    return {
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseModel(request),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      ...(usage == null
        ? {}
        : {
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
            },
          }),
    };
  }
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    completed_at: Math.floor(Date.now() / 1_000),
    error: null,
    incomplete_details: null,
    model: responseModel(request),
    output: outputItems ?? [
      {
        id: `${responseId}_message`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...(usage == null
      ? {}
      : {
          usage: {
            input_tokens: usage.inputTokens,
            input_tokens_details: {
              cached_tokens: usage.cachedInputTokens ?? 0,
              cache_write_tokens: usage.cacheWriteInputTokens ?? 0,
            },
            output_tokens: usage.outputTokens,
            output_tokens_details: {
              reasoning_tokens: usage.reasoningTokens ?? 0,
            },
            total_tokens: usage.totalTokens,
          },
        }),
  };
};

export const createLiveJsonStream = (
  request: ProviderExecutionRequest,
  run: (
    onTextDelta: (delta: string) => void,
    onProcessDelta: (delta: string, source?: CodexProcessDeltaSource) => void,
    onNativeItem: (item: Record<string, unknown>) => void,
  ) => Promise<
    | string
    | {
        /** Complete assistant text returned by the host. */
        text: string;
        /** Provider-authoritative token usage, when available. */
        usage: HostTokenUsage | null;
        /** Native caller-owned tool requests yielded without delegated execution. */
        outputItems?: readonly Record<string, unknown>[];
        /** Completed native progress with original reasoning or message phase. */
        progressItems?: readonly Record<string, unknown>[];
      }
  >,
  readUsage: () => HostTokenUsage | null = () => null,
  onCancel?: () => void,
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let firstChatDelta = true;
      const nativeItems = new Map<
        string,
        {
          item: Record<string, unknown>;
          outputIndex: number;
          done: boolean;
          summaryParts: Map<number, string>;
          contentText?: string;
        }
      >();
      let nativeOutputIndex = 0;
      const write = (event: string): boolean => {
        if (!streamOpen) return false;
        controller.enqueue(encoder.encode(event));
        return true;
      };
      const close = (): void => {
        if (!streamOpen) return;
        streamOpen = false;
        controller.close();
      };
      const emitEvent = (type: string, payload: Record<string, unknown>): void => {
        write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      };
      const startNativeItem = (item: Record<string, unknown>) => {
        const itemId = typeof item.id === "string" ? item.id : `${responseId}_${nativeOutputIndex}`;
        const existing = nativeItems.get(itemId);
        if (existing !== undefined) return existing;
        const state = {
          item: { ...item, id: itemId },
          outputIndex: nativeOutputIndex++,
          done: false,
          summaryParts: new Map<number, string>(),
          contentText: undefined as string | undefined,
        };
        nativeItems.set(itemId, state);
        emitEvent("response.output_item.added", {
          output_index: state.outputIndex,
          item: state.item,
        });
        return state;
      };
      const emitMessageDelta = (delta: string, itemId: string, phase: string): void => {
        const state = startNativeItem({
          id: itemId,
          type: "message",
          role: "assistant",
          phase,
          content: [],
          status: "in_progress",
        });
        if (state.done) return;
        const identity = {
          item_id: itemId,
          output_index: state.outputIndex,
          content_index: 0,
        };
        if (state.contentText === undefined) {
          state.contentText = "";
          emitEvent("response.content_part.added", {
            ...identity,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        state.contentText += delta;
        emitEvent("response.output_text.delta", { ...identity, delta });
      };
      const emitTextDelta = (delta: string): void => {
        if (request.protocol === "chat-completions") {
          if (
            !write(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1_000),
                model: responseModel(request),
                choices: [
                  {
                    index: 0,
                    delta: {
                      ...(firstChatDelta ? { role: "assistant" } : {}),
                      content: delta,
                    },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            )
          ) {
            return;
          }
          firstChatDelta = false;
          return;
        }
        if (streamOpen && delta !== "")
          emitMessageDelta(delta, `${responseId}_message`, "final_answer");
      };
      const emitProcessDelta = (delta: string, source?: CodexProcessDeltaSource): void => {
        if (!streamOpen || request.protocol !== "responses" || delta === "") return;
        if (source === undefined || source.type === "activity") {
          emitEvent("response.reasoning_summary_text.delta", { delta });
          return;
        }
        if (source.separator) return;
        if (source.type === "commentary") {
          emitMessageDelta(delta, source.itemId, "commentary");
          return;
        }
        const state = startNativeItem({
          id: source.itemId,
          type: "reasoning",
          summary: [],
        });
        if (state.done) return;
        const summaryIndex = source.summaryIndex ?? 0;
        const identity = {
          item_id: source.itemId,
          output_index: state.outputIndex,
          summary_index: summaryIndex,
        };
        if (!state.summaryParts.has(summaryIndex)) {
          state.summaryParts.set(summaryIndex, "");
          emitEvent("response.reasoning_summary_part.added", {
            ...identity,
            part: { type: "summary_text", text: "" },
          });
        }
        state.summaryParts.set(summaryIndex, `${state.summaryParts.get(summaryIndex)}${delta}`);
        emitEvent("response.reasoning_summary_text.delta", {
          ...identity,
          delta,
        });
      };
      const emitNativeItem = (item: Record<string, unknown>): void => {
        if (!streamOpen || request.protocol !== "responses") return;
        const state = startNativeItem(item);
        if (state.done) return;
        state.item = { ...item, id: state.item.id };
        for (const [summaryIndex, text] of state.summaryParts) {
          const part = Array.isArray(item.summary) ? item.summary[summaryIndex] : undefined;
          const completedPart = isRecord(part) ? part : { type: "summary_text", text };
          const identity = {
            item_id: state.item.id,
            output_index: state.outputIndex,
            summary_index: summaryIndex,
          };
          emitEvent("response.reasoning_summary_text.done", {
            ...identity,
            text: completedPart.text,
          });
          emitEvent("response.reasoning_summary_part.done", {
            ...identity,
            part: completedPart,
          });
        }
        if (state.contentText !== undefined) {
          const part = Array.isArray(item.content) ? item.content[0] : undefined;
          const completedPart = isRecord(part)
            ? part
            : { type: "output_text", text: state.contentText, annotations: [] };
          const identity = {
            item_id: state.item.id,
            output_index: state.outputIndex,
            content_index: 0,
          };
          emitEvent("response.output_text.done", {
            ...identity,
            text: completedPart.text,
          });
          emitEvent("response.content_part.done", {
            ...identity,
            part: completedPart,
          });
        }
        state.done = true;
        emitEvent("response.output_item.done", {
          output_index: state.outputIndex,
          item: state.item,
        });
      };
      void run(emitTextDelta, emitProcessDelta, emitNativeItem)
        .then((result) => {
          if (!streamOpen) return;
          const text = typeof result === "string" ? result : result.text;
          const usage = typeof result === "string" ? null : result.usage;
          const outputItems = typeof result === "string" ? undefined : result.outputItems;
          const progressItems = typeof result === "string" ? [] : (result.progressItems ?? []);
          if (request.protocol === "chat-completions") {
            write(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1_000),
                model: responseModel(request),
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                ...(usage === null
                  ? {}
                  : {
                      usage: {
                        prompt_tokens: usage.inputTokens,
                        completion_tokens: usage.outputTokens,
                        total_tokens: usage.totalTokens,
                      },
                    }),
              })}\n\n`,
            );
          } else {
            const responseBody = createResponse(
              request,
              text,
              responseId,
              usage,
              createdAt,
              outputItems,
            );
            const completedItems = [
              ...progressItems,
              ...(responseBody.output as Record<string, unknown>[]),
            ];
            completedItems.forEach(emitNativeItem);
            for (const state of nativeItems.values()) {
              if (state.done) continue;
              emitNativeItem({
                ...state.item,
                ...(state.item.type === "reasoning"
                  ? {
                      summary: [...state.summaryParts]
                        .sort(([left], [right]) => left - right)
                        .map(([, text]) => ({ type: "summary_text", text })),
                    }
                  : {
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: state.contentText ?? "",
                          annotations: [],
                        },
                      ],
                    }),
              });
            }
            const terminalItems = [...nativeItems.values()].map((state) => state.item);
            write(
              `event: response.completed\ndata: ${JSON.stringify({
                type: "response.completed",
                response: { ...responseBody, output: terminalItems },
              })}\n\n`,
            );
          }
          if (!write("data: [DONE]\n\n")) return;
          close();
        })
        .catch((error: unknown) => {
          if (!streamOpen) return;
          const message = error instanceof Error ? error.message : "The host model failed.";
          const failure = {
            code:
              error instanceof ProviderError || error instanceof TiduError
                ? error.code
                : "host_model_failed",
            message: message.slice(0, 240),
            type:
              error instanceof ProviderError
                ? error.type
                : error instanceof TiduError &&
                    ["CONFIGURATION_INVALID", "CONFIGURATION_CONFLICT"].includes(error.code)
                  ? "invalid_request_error"
                  : "server_error",
          };
          const usage = readUsage();
          if (request.protocol === "chat-completions") {
            write(
              `data: ${JSON.stringify({ error: failure, ...(usage === null ? {} : { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } }) })}\n\n`,
            );
          } else {
            write(
              `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { ...(createResponse(request, "", responseId, usage, createdAt) as Record<string, unknown>), status: "failed", output: [], error: failure } })}\n\n`,
            );
          }
          if (!write("data: [DONE]\n\n")) return;
          close();
        });
    },
    cancel() {
      streamOpen = false;
      onCancel?.();
    },
  });
};

export const requireCompletedCursorPrompt = (
  model: string | null,
  result: { readonly stopReason: string; readonly text: string },
): string => {
  const modelName = model ?? "current";
  if (result.stopReason !== "end_turn") {
    throw new Error(`Cursor model ${modelName} stopped with ${result.stopReason}.`);
  }
  if (result.text.trim() === "") {
    throw new Error(`Cursor model ${modelName} returned an empty response.`);
  }
  return result.text;
};

const cursorModelParameters = (modelId: string): ReadonlyMap<string, string> => {
  const parameterBlock = /\[([^\]]*)\]$/u.exec(modelId)?.[1] ?? "";
  return new Map(
    parameterBlock.split(",").flatMap((entry): [string, string][] => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex < 1) return [];
      return [
        [
          entry.slice(0, separatorIndex).trim().toLowerCase(),
          entry
            .slice(separatorIndex + 1)
            .trim()
            .toLowerCase(),
        ],
      ];
    }),
  );
};

const cursorHeadlessModelFamilies = (modelId: string): readonly string[] => {
  const family = modelId.replace(/\[[^\]]*\]$/u, "");
  const reorderedClaudeFamily = /^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?$/u.exec(family);
  const reorderedClaudeVersion =
    reorderedClaudeFamily === null
      ? undefined
      : reorderedClaudeFamily[3] === undefined
        ? reorderedClaudeFamily[2]
        : `${reorderedClaudeFamily[2]}.${reorderedClaudeFamily[3]}`;
  return [
    family,
    ...(family === "auto-smart" ? ["auto"] : []),
    ...(reorderedClaudeFamily === null || reorderedClaudeVersion === undefined
      ? []
      : [`claude-${reorderedClaudeVersion}-${reorderedClaudeFamily[1]}`]),
    ...(family.startsWith("grok-") ? [`cursor-${family}`] : []),
  ];
};

export const resolveCursorHeadlessModel = (
  modelId: string,
  availableModels: readonly CursorHostModel[],
): string | undefined => {
  const availableIds = new Set(availableModels.map((model) => model.id));
  if (availableIds.has(modelId)) return modelId;
  const parameters = cursorModelParameters(modelId);
  const configuredEffort =
    parameters.get("reasoning_effort") ?? parameters.get("reasoning") ?? parameters.get("effort");
  const efforts =
    configuredEffort === undefined
      ? [undefined]
      : configuredEffort === "xhigh"
        ? ["xhigh", "extra-high"]
        : [configuredEffort];
  const thinking = parameters.get("thinking") === "true";
  const fast = parameters.get("fast") === "true";
  const candidates: string[] = [];
  for (const family of cursorHeadlessModelFamilies(modelId)) {
    for (const effort of efforts) {
      const effortSuffix = effort === undefined ? "" : `-${effort}`;
      const thinkingSuffix = thinking ? "-thinking" : "";
      const fastSuffix = fast ? "-fast" : "";
      candidates.push(
        `${family}${thinkingSuffix}${effortSuffix}${fastSuffix}`,
        `${family}${effortSuffix}${thinkingSuffix}${fastSuffix}`,
      );
      if (thinking && effort === undefined) {
        candidates.push(
          `${family}-thinking-high${fastSuffix}`,
          `${family}-high-thinking${fastSuffix}`,
        );
      }
      if (effort === "medium") candidates.push(`${family}${thinkingSuffix}${fastSuffix}`);
    }
  }
  return candidates.find((candidate) => availableIds.has(candidate));
};

export const cursorRoutableCapabilitiesForModel = (
  modelId: string,
  acpCapabilities: CursorAcpCapabilities,
): readonly string[] => {
  const capabilities = ["text"];
  const parameters = cursorModelParameters(modelId);
  const reasoningValue =
    parameters.get("thinking") ??
    parameters.get("reasoning") ??
    parameters.get("reasoning_effort") ??
    parameters.get("effort");
  if (reasoningValue !== undefined && reasoningValue !== "false" && reasoningValue !== "none") {
    capabilities.push("reasoning");
  }
  if (acpCapabilities.imageInput) capabilities.push("vision");
  const contextMatch = /^(\d+)([km])?$/u.exec(parameters.get("context") ?? "");
  if (contextMatch !== null) {
    const contextAmount = Number(contextMatch[1]);
    const contextMultiplier =
      contextMatch[2] === "m" ? 1_000_000 : contextMatch[2] === "k" ? 1_000 : 1;
    if (contextAmount * contextMultiplier >= 100_000) capabilities.push("long-context");
  }
  return capabilities;
};

export const createCursorModelCatalog = (
  currentModel: string,
  availableModels: readonly CursorAcpModel[],
  acpCapabilities: CursorAcpCapabilities = { imageInput: false },
) => {
  const publishedModels = availableModels.map((model) => ({
    id: model.id,
    name: model.name,
    capabilities: cursorRoutableCapabilitiesForModel(model.id, acpCapabilities),
    capabilitySource: "effective-route" as const,
  }));
  return publishedModels.some((candidate) => candidate.id === currentModel)
    ? publishedModels
    : [
        {
          id: currentModel,
          name: currentModel.replace(/\[[^\]]*\]$/u, ""),
          capabilities: cursorRoutableCapabilitiesForModel(currentModel, acpCapabilities),
          capabilitySource: "effective-route" as const,
        },
        ...publishedModels,
      ];
};

interface CodexClientSession {
  /** Initialized long-lived official Codex app-server client. */
  client: CodexAgentClient;
  /** First empty thread created during model discovery and reused by the first request. */
  initialThread?: CodexThread;
  /** Model identifier explicitly confirmed by the Codex host for this session. */
  model: string;
  /** Caller tool batches still waiting for results on their original native turn. */
  callerTurns: Map<string, CodexCallerContinuation>;
  /** Public call ownership shared by all model sessions in this provider. */
  callerOwners: Map<string, CodexCallerContinuation>;
  /** Whether the underlying native connection has been retired. */
  closed?: boolean;
  /** Retires only this model connection. */
  discard?: () => Promise<void>;
  /** Recreates this model connection for a shared batch recovery. */
  recover?: () => Promise<CodexClientSession>;
}

interface CodexCallerContinuation {
  /** Model session that owns the original native operation. */
  owner: CodexClientSession;
  /** Thread whose live tool RPCs must receive the caller results. */
  thread: CodexThread;
  /** Native turn interrupted when its static tool catalog must be replaced. */
  turnId: string;
  /** Original alias mapping retained throughout native execution. */
  catalog: CallerToolCatalog;
  /** Complete tool batch, including RPCs the host dispatches sequentially. */
  callIds: readonly string[];
  /** Native IDs keyed by globally distinct public IDs to isolate concurrent turns. */
  nativeCallIds: ReadonlyMap<string, string>;
  /** Instructions already installed before this batch was emitted. */
  instructions: unknown;
  /** Public conversation including this batch, sufficient for isolated recovery. */
  replayItems: readonly Record<string, unknown>[];
  /** A terminal native turn can only be continued through its public replay history. */
  retired?: boolean;
  /** One atomic delivery shared by concurrent and completed retries. */
  delivery?: {
    key: string;
    resultsKey: string;
    promise: Promise<CodexExecutionResult>;
    controller: AbortController;
    subscribers: number;
    settled: boolean;
  };
}

type CodexExecutionResult = CodexTurnResult & {
  /** Public caller tool requests to execute after a successful model response. */
  outputItems?: readonly Record<string, unknown>[];
};

const createCodexClientSession = async (
  model?: string,
  hostOptions: CodexHostInspectionOptions = {},
  callerOwners = new Map<string, CodexCallerContinuation>(),
): Promise<CodexClientSession> => {
  let session: CodexClientSession | undefined;
  const client = createCodexAgentClient({
    ...hostOptions,
    workingDirectory: process.cwd(),
    ...(model === undefined ? {} : { model }),
    modelProvider: hostOptions.modelProvider ?? "openai",
    ephemeral: true,
    sandbox: "workspace-write",
    onEvent: (notification) => {
      if (
        notification.method !== "turn/completed" ||
        !isRecord(notification.params) ||
        !isRecord(notification.params.turn) ||
        !["failed", "interrupted"].includes(String(notification.params.turn.status))
      )
        return;
      for (const continuation of new Set(session?.callerTurns.values() ?? [])) {
        if (
          continuation.thread.id === notification.params.threadId &&
          continuation.turnId === notification.params.turn.id
        )
          continuation.retired = true;
      }
    },
  });
  try {
    await client.initialize();
    const initialThread = await client.startThread();
    session = {
      client,
      initialThread,
      model: initialThread.model,
      callerTurns: new Map(),
      callerOwners,
    };
    return session;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

const closeCodexClientSession = async (
  session: CodexClientSession,
  preserveDeliveries = false,
): Promise<void> => {
  session.closed = true;
  if (!preserveDeliveries) {
    for (const callId of session.callerTurns.keys()) session.callerOwners.delete(callId);
    session.callerTurns.clear();
  }
  await session.client.close().catch(() => undefined);
};

const requireCodexSessionModel = (session: CodexClientSession, requestedModel: string): string => {
  const confirmedModel = session.model;
  if (confirmedModel !== requestedModel) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      `Codex host confirmed model ${confirmedModel} instead of configured model ${requestedModel}.`,
    );
  }
  return confirmedModel;
};

const callerOutputs = (request: ProviderExecutionRequest): Record<string, unknown>[] =>
  request.protocol === "responses" && Array.isArray(request.body.input)
    ? request.body.input.filter(
        (item): item is Record<string, unknown> =>
          isRecord(item) &&
          ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(
            String(item.type),
          ),
      )
    : [];

const callerContinuationPayload = (
  continuation: CodexCallerContinuation,
  request: ProviderExecutionRequest,
) => {
  const items = Array.isArray(request.body.input) ? request.body.input.filter(isRecord) : [];
  const firstCall = items.findIndex(
    (item) =>
      ["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type)) &&
      continuation.callIds.includes(String(item.call_id)),
  );
  const delta = items.slice(firstCall < 0 ? 0 : firstCall + 1).filter((item) => {
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type)))
      return !continuation.callIds.includes(String(item.call_id));
    return true;
  });
  return requestTurnInput({
    ...request,
    body: {
      ...request.body,
      input: delta,
      instructions:
        request.body.instructions === continuation.instructions
          ? undefined
          : request.body.instructions,
    },
  });
};

const callerRequestItems = (request: ProviderExecutionRequest): Record<string, unknown>[] => {
  const input = createPortableCodexResponsesInput(request.body.input);
  return Array.isArray(input)
    ? input.filter(isRecord)
    : typeof input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
      : [];
};

const callerReplayInput = (
  continuation: CodexCallerContinuation,
  request: ProviderExecutionRequest,
): Record<string, unknown>[] => {
  const supplied = callerRequestItems(request);
  return supplied.some(
    (item) =>
      continuation.callIds.includes(String(item.call_id)) &&
      ["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type)),
  )
    ? supplied
    : [...continuation.replayItems, ...supplied];
};

const callerReplayRequest = (
  continuation: CodexCallerContinuation,
  request: ProviderExecutionRequest,
): ProviderExecutionRequest => ({
  ...request,
  routing: { ...request.routing, targetModel: continuation.owner.model },
  body: {
    ...request.body,
    input: callerReplayInput(continuation, request),
    tools: request.body.tools ?? continuation.catalog.sourceTools,
    instructions: request.body.instructions ?? continuation.instructions,
  },
});

const callerDeliveryKeys = (
  continuation: CodexCallerContinuation,
  request: ProviderExecutionRequest,
) => {
  const payload = callerContinuationPayload(continuation, request);
  const resultsKey = callerToolPayloadKey(
    callerOutputs(request)
      .filter((item) => continuation.callIds.includes(String(item.call_id)))
      .sort((left, right) => String(left.call_id).localeCompare(String(right.call_id))),
  );
  return {
    resultsKey,
    key: callerToolPayloadKey({
      input: payload.input,
      context: payload.historyItems.filter(
        (item) => !continuation.callIds.includes(String(item.call_id)),
      ),
      definitions:
        createCallerToolCatalog(request)?.definitions ?? continuation.catalog.definitions,
      effort: requestReasoningEffort(request),
      summary: requestReasoningSummary(request),
      outputFormat: structuredOutputFormat(request),
      resultsKey,
    }),
  };
};

const resolveCallerContinuation = (
  owners: ReadonlyMap<string, CodexCallerContinuation>,
  request: ProviderExecutionRequest,
): CodexCallerContinuation | undefined => {
  const known = [
    ...new Set(callerOutputs(request).flatMap((item) => owners.get(String(item.call_id)) ?? [])),
  ];
  const hasNewUser = (item: CodexCallerContinuation): boolean => {
    const payload = callerContinuationPayload(item, request);
    return payload.input.length > 0 || payload.historyItems.some((entry) => entry.role === "user");
  };
  const live = known.filter(
    (item) =>
      item.delivery?.settled !== true &&
      (item.delivery !== undefined || !item.retired || !hasNewUser(item)),
  );
  if (live.length > 1)
    throw new TiduError("CONFIGURATION_INVALID", "Caller tool results belong to different turns.");
  if (live[0] !== undefined) return live[0];
  const latest = known.at(-1);
  if (latest === undefined) return undefined;
  if (latest.retired && latest.delivery === undefined)
    return hasNewUser(latest) ? undefined : latest;
  const keys = callerDeliveryKeys(latest, request);
  if (latest.delivery?.resultsKey !== keys.resultsKey)
    throw new TiduError("CONFIGURATION_CONFLICT", "Conflicting caller tool results.");
  return requestTurnInput(request).input.length === 0 || latest.delivery.key === keys.key
    ? latest
    : undefined;
};

const forgetCallerContinuation = (continuation: CodexCallerContinuation): void => {
  for (const callId of continuation.callIds) {
    continuation.owner.callerTurns.delete(callId);
    continuation.owner.callerOwners.delete(callId);
  }
};

const runCodexTurn = (
  session: CodexClientSession,
  request: ProviderExecutionRequest,
  onTextDelta?: (delta: string) => void,
  onProcessDelta?: (delta: string, source?: CodexProcessDeltaSource) => void,
  onNativeItem?: (item: Record<string, unknown>) => void,
): Promise<CodexExecutionResult> => {
  const continuation = resolveCallerContinuation(session.callerOwners, request);
  if (continuation === undefined)
    return runCodexTurnBody(session, request, onTextDelta, onProcessDelta, onNativeItem);
  const { key, resultsKey } = callerDeliveryKeys(continuation, request);
  if (continuation.delivery !== undefined && continuation.delivery.key !== key)
    return Promise.reject(
      new TiduError("CONFIGURATION_CONFLICT", "Conflicting caller tool deliveries."),
    );
  if (continuation.delivery === undefined) {
    const controller = new AbortController();
    const delivery = {
      key,
      resultsKey,
      controller,
      subscribers: 0,
      settled: false,
      promise: Promise.resolve().then(async () => {
        const sharedRequest = { ...request, signal: controller.signal };
        const replay = continuation.owner.closed || continuation.retired === true;
        try {
          return await runCodexTurnBody(
            session,
            replay ? callerReplayRequest(continuation, sharedRequest) : sharedRequest,
            onTextDelta,
            onProcessDelta,
            onNativeItem,
            replay ? undefined : continuation,
          );
        } catch (error) {
          if (
            !isCodexConnectionFailure(error) ||
            controller.signal.aborted ||
            session.recover === undefined
          )
            throw error;
          const restoredSession = await session.recover();
          try {
            return await runCodexTurnBody(
              restoredSession,
              callerReplayRequest(continuation, sharedRequest),
              onTextDelta,
              onProcessDelta,
              onNativeItem,
            );
          } catch (recoveryError) {
            if (isCodexConnectionFailure(recoveryError)) await restoredSession.discard?.();
            throw recoveryError;
          }
        }
      }),
    };
    continuation.delivery = delivery;
    delivery.promise = delivery.promise.then(
      (result) => {
        delivery.settled = true;
        return result;
      },
      (error: unknown) => {
        delivery.settled = true;
        if (controller.signal.aborted || isCodexConnectionFailure(error))
          forgetCallerContinuation(continuation);
        else continuation.delivery = undefined;
        throw error;
      },
    );
  }
  const delivery = continuation.delivery;
  delivery.subscribers += 1;
  return new Promise<CodexExecutionResult>((resolve, reject) => {
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      request.signal?.removeEventListener("abort", abort);
      delivery.subscribers -= 1;
      return true;
    };
    const abort = (): void => {
      if (!finish()) return;
      if (delivery.subscribers === 0 && !delivery.settled) {
        forgetCallerContinuation(continuation);
        delivery.controller.abort();
      }
      reject(new DOMException("Codex turn cancelled.", "AbortError"));
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    delivery.promise.then(
      (result) => {
        if (finish()) resolve(result);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
};

const runCodexTurnBody = async (
  session: CodexClientSession,
  request: ProviderExecutionRequest,
  onTextDelta?: (delta: string) => void,
  onProcessDelta?: (delta: string, source?: CodexProcessDeltaSource) => void,
  onNativeItem?: (item: Record<string, unknown>) => void,
  continuation?: CodexCallerContinuation,
): Promise<CodexExecutionResult> => {
  const outputs =
    request.protocol === "responses" && Array.isArray(request.body.input)
      ? request.body.input.filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) &&
            ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(
              String(item.type),
            ),
        )
      : [];
  let turnPayload =
    continuation === undefined
      ? requestTurnInput(request)
      : callerContinuationPayload(continuation, request);
  const hasReplayContext = outputs.every((output) =>
    typeof output.call_id === "string"
      ? turnPayload.historyItems.some(
          (item) =>
            item.call_id === output.call_id &&
            ["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type)),
        )
      : output.type === "function_call_output" &&
        typeof output.name === "string" &&
        output.name.trim() !== "",
  );
  if (
    continuation === undefined &&
    turnPayload.input.length === 0 &&
    outputs.length > 0 &&
    !hasReplayContext
  ) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      "The native turn for these caller tool results is no longer available.",
    );
  }
  if (
    continuation !== undefined &&
    !continuation.callIds.every((callId) => outputs.some((item) => item.call_id === callId))
  ) {
    throw new TiduError("CONFIGURATION_INVALID", "All pending caller tool results are required.");
  }
  const requestedCatalog = createCallerToolCatalog(request);
  const replaceCatalog =
    continuation !== undefined &&
    requestedCatalog !== undefined &&
    callerToolPayloadKey({
      definitions: requestedCatalog.definitions,
      webSearchMode: requestedCatalog.webSearchMode,
    }) !==
      callerToolPayloadKey({
        definitions: continuation.catalog.definitions,
        webSearchMode: continuation.catalog.webSearchMode,
      });
  const callerTools = replaceCatalog
    ? requestedCatalog
    : (continuation?.catalog ?? requestedCatalog);
  if (replaceCatalog && continuation !== undefined) {
    await session.client.cancel(continuation.thread.id, continuation.turnId);
    const replayInput = callerReplayInput(continuation, request);
    turnPayload = {
      input: [],
      historyItems: [
        ...(typeof request.body.instructions === "string"
          ? [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: request.body.instructions }],
              },
            ]
          : []),
        ...replayInput,
      ],
    };
  }
  const thread =
    (replaceCatalog ? undefined : continuation?.thread) ??
    (callerTools === undefined
      ? (session.initialThread ?? (await session.client.startThread(session.model)))
      : await session.client.startThread(
          session.model,
          callerTools.definitions,
          callerTools.webSearchMode,
        ));
  session.initialThread = undefined;
  if (thread.model !== session.model) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      `Codex host confirmed model ${thread.model} instead of session model ${session.model}.`,
    );
  }
  const forwardProcessDelta =
    callerTools === undefined || onProcessDelta === undefined
      ? onProcessDelta
      : (delta: string, source?: CodexProcessDeltaSource): void => {
          if (source?.type !== "reasoning" && source?.type !== "commentary") return;
          onProcessDelta(delta, source);
        };
  reportCodexExecution(request, session.model, null);
  const outputFormat = structuredOutputFormat(request);
  const outputSchema =
    outputFormat?.type === "json_schema" && isRecord(outputFormat.schema)
      ? outputFormat.schema
      : outputFormat?.type === "json_object"
        ? { type: "object" }
        : undefined;
  const result = await session.client
    .prompt(
      thread.id,
      turnPayload.input,
      request.signal,
      onTextDelta,
      requestReasoningEffort(request),
      forwardProcessDelta,
      continuation !== undefined && !replaceCatalog
        ? turnPayload.historyItems.map((item) => {
            const nativeCallId = continuation.nativeCallIds.get(String(item.call_id));
            if (nativeCallId !== undefined) return { ...item, call_id: nativeCallId };
            if (
              ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(
                String(item.type),
              ) &&
              item.call_id !== undefined &&
              item.call_id !== null
            )
              throw new TiduError("CONFIGURATION_INVALID", "Unknown caller tool result.");
            return item;
          })
        : callerTools === undefined
          ? turnPayload.historyItems
          : callerTools.historyItems(turnPayload.historyItems),
      outputSchema,
      (usage) => reportCodexExecution(request, session.model, usage),
      requestReasoningSummary(request),
      onNativeItem,
    )
    .catch((error: unknown) => {
      if (continuation !== undefined && request.signal?.aborted)
        forgetCallerContinuation(continuation);
      throw error;
    });
  if (result.status !== "completed") {
    if (continuation !== undefined) forgetCallerContinuation(continuation);
    if (result.status === "interrupted")
      throw new DOMException("Codex turn cancelled.", "AbortError");
    if (result.error?.codexErrorInfo === "serverOverloaded")
      throw new ProviderError(
        "server_is_overloaded",
        readableHostFailureMessage(result.error.message),
        "service_unavailable_error",
      );
    throw new Error(
      result.error?.message === undefined
        ? "The current host model did not complete the request."
        : readableHostFailureMessage(result.error.message),
    );
  }
  if (request.signal?.aborted) {
    if ((result.toolCalls?.length ?? 0) > 0)
      await session.client.cancel(thread.id, result.turnId).catch(() => undefined);
    throw new DOMException("Codex turn cancelled.", "AbortError");
  }
  if (
    callerTools !== undefined &&
    (result.toolCalls?.length ?? 0) > 0 &&
    !request.signal?.aborted
  ) {
    const calls =
      result.toolCalls?.map((call) => ({
        nativeCallId: call.callId,
        item: { ...callerTools.outputItem(call), call_id: `call_${randomUUID()}` },
      })) ?? [];
    const pending: CodexCallerContinuation = {
      owner: session,
      thread,
      turnId: result.turnId,
      catalog: callerTools,
      callIds: calls.map((call) => call.item.call_id),
      nativeCallIds: new Map(calls.map((call) => [call.item.call_id, call.nativeCallId])),
      instructions: request.body.instructions,
      replayItems: [
        ...(continuation === undefined
          ? callerRequestItems(request)
          : callerReplayInput(continuation, request)),
        ...calls.map((call) => call.item),
      ],
    };
    for (const callId of pending.callIds) {
      session.callerTurns.set(callId, pending);
      session.callerOwners.set(callId, pending);
    }
    if (session.callerOwners.size > 512) {
      for (const previous of new Set(session.callerOwners.values())) {
        if (session.callerOwners.size <= 512) break;
        if (previous.delivery?.settled) forgetCallerContinuation(previous);
      }
    }
    return {
      ...result,
      outputItems: calls.map((call) => call.item),
    };
  }
  return { ...result, text: requireValidHostModelText(request, result.text) };
};

const isCodexConnectionFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /(?:Agent protocol (?:connection (?:is )?closed|connection failed|process exited)|Codex connection closed)/iu.test(
    error.message,
  );
};

const reportCodexExecution = (
  request: ProviderExecutionRequest,
  model: string,
  usage: CodexTurnResult["usage"],
): void => {
  request.onExecutionReceipt?.({
    host: request.routing?.host ?? "codex",
    model,
    role: request.routing?.role ?? "main",
    capabilities:
      request.routing?.availableCapabilities ?? request.routing?.requiredCapabilities ?? [],
    usage,
  });
};

export interface CodexHostConfiguration {
  /** Effective model selected by the Codex app-server for a new thread. */
  model: string;
  /** Non-secret account metadata reported by the Codex app-server. */
  account: CodexAccountSummary | null;
}

export interface CodexHostAccountReport {
  /** Host-owned, non-secret account metadata. */
  account: CodexAccountSummary | null;
  /** Official account quota and token totals, or null when unavailable. */
  usage: CodexUsageSummary | null;
}

export const inspectCodexHostAccountReport = async (
  timeoutMilliseconds = 15_000,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<CodexHostAccountReport | null> => {
  if (!(await inspectCodexHostLoginAsync({ ...hostOptions, timeoutMilliseconds })).reusable)
    return null;
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-account-report-"));
  const client = createCodexAgentClient({
    ...hostOptions,
    workingDirectory,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  let timeout: NodeJS.Timeout | undefined;
  const report: CodexHostAccountReport = { account: null, usage: null };
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        await Promise.all([
          client
            .readAccount()
            .then((account) => {
              report.account = account;
            })
            .catch(() => undefined),
          client
            .readUsage()
            .then((usage) => {
              report.usage = usage;
            })
            .catch(() => undefined),
        ]);
        return report;
      })(),
      new Promise<CodexHostAccountReport>((resolve) => {
        timeout = setTimeout(() => resolve(report), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.close().catch(() => undefined);
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const inspectCodexHostConfiguration = async (
  modelOverride?: string,
): Promise<CodexHostConfiguration | undefined> => {
  if (!inspectCodexHostLogin().reusable) {
    return undefined;
  }
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-discovery-"));
  const client = createCodexAgentClient({
    workingDirectory,
    model: modelOverride,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  let model: string;
  let account: CodexAccountSummary | null = null;
  try {
    await client.initialize();
    model = (await client.startThread()).model;
    account = await client.readAccount().catch(() => null);
  } catch {
    return undefined;
  } finally {
    try {
      await client.close().catch(() => undefined);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { model, account };
};

export const createCodexHostModelProvider = async (
  modelOverride?: string,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<ModelProvider | undefined> => {
  if (!inspectCodexHostLogin(hostOptions).reusable) return undefined;
  const callerOwners = new Map<string, CodexCallerContinuation>();
  let initialSession: CodexClientSession;
  try {
    initialSession = await createCodexClientSession(modelOverride, hostOptions, callerOwners);
  } catch {
    return undefined;
  }
  const initialModel = initialSession.initialThread?.model;
  if (initialModel === undefined) {
    await closeCodexClientSession(initialSession);
    return undefined;
  }
  if (modelOverride !== undefined && initialModel !== modelOverride) {
    await closeCodexClientSession(initialSession);
    return undefined;
  }
  const sessions = new Map<string, Promise<CodexClientSession>>();
  const initialSessionPromise = Promise.resolve(initialSession);
  sessions.set(initialModel, initialSessionPromise);
  const requestedModelFor = (request: ProviderExecutionRequest): string =>
    request.routing?.targetModel ??
    (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
      ? request.body.model
      : (modelOverride ?? initialModel));
  const resolveSession = (requestedModel: string): Promise<CodexClientSession> => {
    const current = sessions.get(requestedModel);
    if (current !== undefined) return current;
    const created = createCodexClientSession(requestedModel, hostOptions, callerOwners)
      .then(async (session) => {
        try {
          requireCodexSessionModel(session, requestedModel);
          session.discard = () => discardSession(requestedModel, created, session);
          session.recover = async () => {
            await session.discard?.();
            return resolveSession(requestedModel);
          };
          return session;
        } catch (error) {
          await closeCodexClientSession(session);
          throw error;
        }
      })
      .catch((error: unknown) => {
        sessions.delete(requestedModel);
        throw error;
      });
    sessions.set(requestedModel, created);
    return created;
  };
  const discardSession = async (
    requestedModel: string,
    sessionPromise: Promise<CodexClientSession>,
    session: CodexClientSession,
  ): Promise<void> => {
    if (sessions.get(requestedModel) === sessionPromise) sessions.delete(requestedModel);
    await closeCodexClientSession(session, true);
  };
  initialSession.discard = () =>
    discardSession(initialModel, initialSessionPromise, initialSession);
  initialSession.recover = async () => {
    await initialSession.discard?.();
    return resolveSession(initialModel);
  };

  const provider: ModelProvider = {
    descriptor: { type: "codex-host", model: initialModel },
    execute: async (request): Promise<ProviderExecutionResult> => {
      request = {
        ...request,
        body: {
          ...request.body,
          input:
            request.protocol === "responses"
              ? normalizeCallerToolInput(request.body.input)
              : request.body.input,
        },
      };
      const ownedContinuation = resolveCallerContinuation(callerOwners, request);
      const requestedModel = ownedContinuation?.owner.model ?? requestedModelFor(request);
      const sessionPromise = resolveSession(requestedModel);
      const session = await sessionPromise;
      const upstreamModel = requireCodexSessionModel(session, requestedModel);
      request.onModelConfirmed?.(upstreamModel);
      try {
        if (request.body.stream === true) {
          const streamController = new AbortController();
          let reportedUsage: HostTokenUsage | null = null;
          const streamingRequest: ProviderExecutionRequest = {
            ...request,
            signal:
              request.signal === undefined
                ? streamController.signal
                : AbortSignal.any([request.signal, streamController.signal]),
            onExecutionReceipt: (receipt) => {
              if (receipt.usage !== null) reportedUsage = receipt.usage;
              request.onExecutionReceipt?.(receipt);
            },
          };
          return {
            kind: "stream",
            statusCode: 200,
            upstreamModel,
            stream: createLiveJsonStream(
              request,
              async (onTextDelta, onProcessDelta, onNativeItem) => {
                let emittedVisibleOutput = false;
                const forwardTextDelta = (delta: string): void => {
                  if (delta !== "") emittedVisibleOutput = true;
                  onTextDelta(delta);
                };
                const forwardProcessDelta = (
                  delta: string,
                  source?: CodexProcessDeltaSource,
                ): void => {
                  if (delta.replace(/\s/gu, "") !== "") emittedVisibleOutput = true;
                  onProcessDelta(delta, source);
                };
                const forwardNativeItem = (item: Record<string, unknown>): void => {
                  emittedVisibleOutput = true;
                  onNativeItem(item);
                };
                try {
                  const result = await runCodexTurn(
                    session,
                    streamingRequest,
                    forwardTextDelta,
                    forwardProcessDelta,
                    forwardNativeItem,
                  );
                  reportCodexExecution(request, upstreamModel, result.usage);
                  return {
                    text: result.text,
                    usage: result.usage,
                    ...(result.progressItems === undefined
                      ? {}
                      : { progressItems: result.progressItems }),
                    ...(result.outputItems === undefined
                      ? {}
                      : { outputItems: result.outputItems }),
                  };
                } catch (error) {
                  if (!isCodexConnectionFailure(error)) throw error;
                  await discardSession(requestedModel, sessionPromise, session);
                  if (ownedContinuation !== undefined) throw error;
                  if (streamingRequest.signal?.aborted || emittedVisibleOutput) throw error;
                  const retrySessionPromise = resolveSession(requestedModel);
                  const retrySession = await retrySessionPromise;
                  const retryModel = requireCodexSessionModel(retrySession, requestedModel);
                  try {
                    const result = await runCodexTurn(
                      retrySession,
                      ownedContinuation === undefined
                        ? streamingRequest
                        : callerReplayRequest(ownedContinuation, streamingRequest),
                      forwardTextDelta,
                      forwardProcessDelta,
                      forwardNativeItem,
                    );
                    reportCodexExecution(request, retryModel, result.usage);
                    return {
                      text: result.text,
                      usage: result.usage,
                      ...(result.progressItems === undefined
                        ? {}
                        : { progressItems: result.progressItems }),
                      ...(result.outputItems === undefined
                        ? {}
                        : { outputItems: result.outputItems }),
                    };
                  } catch (retryError) {
                    if (isCodexConnectionFailure(retryError)) {
                      await discardSession(requestedModel, retrySessionPromise, retrySession);
                    }
                    throw retryError;
                  }
                }
              },
              () => reportedUsage,
              () => streamController.abort(),
            ),
          };
        }
        const result = await runCodexTurn(session, request, undefined, request.onProcessDelta);
        reportCodexExecution(request, upstreamModel, result.usage);
        const body = createResponse(
          request,
          result.text,
          undefined,
          result.usage,
          undefined,
          result.outputItems,
        );
        if (request.protocol === "responses" && result.progressItems !== undefined) {
          const itemIds = new Set<string>();
          body.output = [
            ...result.progressItems,
            ...(body.output as Record<string, unknown>[]),
          ].filter((item) => {
            if (typeof item.id !== "string") return true;
            if (itemIds.has(item.id)) return false;
            itemIds.add(item.id);
            return true;
          });
        }
        return {
          kind: "json",
          statusCode: 200,
          upstreamModel,
          body,
        };
      } catch (error) {
        if (isCodexConnectionFailure(error)) {
          await discardSession(requestedModel, sessionPromise, session);
        }
        throw error;
      }
    },
    close: async () => {
      const settledSessions = await Promise.allSettled(new Set(sessions.values()));
      const uniqueSessions = new Set(
        settledSessions.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      );
      await Promise.all([...uniqueSessions].map((session) => closeCodexClientSession(session)));
      sessions.clear();
      callerOwners.clear();
    },
  };
  return provider;
};

export const createCursorHostModelProvider = async (
  hostOptions: CursorHostInspectionOptions = {},
): Promise<ModelProvider | undefined> => {
  if (!(await inspectCursorHostLoginAsync(hostOptions)).reusable) {
    return undefined;
  }
  const cursorLaunch = createCursorAcpLaunch(hostOptions);
  const headlessModels = await listCursorHostModelsAsync(hostOptions);
  const discoveryDirectory = await mkdtemp(join(tmpdir(), "tidu-cursor-model-discovery-"));
  const discoveryClient = createCursorAcpClient({
    ...hostOptions,
    workingDirectory: discoveryDirectory,
    mode: "ask",
  });
  let model: string | null = null;
  let availableModels: readonly CursorAcpModel[] = [];
  let acpCapabilities: CursorAcpCapabilities = { imageInput: false };
  const discoverySignal = AbortSignal.timeout(CURSOR_DISCOVERY_TIMEOUT_MILLISECONDS);
  try {
    acpCapabilities = await discoveryClient.initialize(discoverySignal);
    const session = await discoveryClient.createSession(discoverySignal);
    model = session.model;
    availableModels = session.availableModels;
  } catch {
    return undefined;
  } finally {
    try {
      await discoveryClient.close().catch(() => undefined);
    } finally {
      await rm(discoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (model === null) return undefined;
  const models = createCursorModelCatalog(model, availableModels, acpCapabilities);
  return {
    descriptor: { type: "cursor-host", model },
    listModels: async () => models,
    execute: async (request): Promise<ProviderExecutionResult> => {
      const requestedModel =
        request.routing?.targetModel ??
        (typeof request.body.model === "string" && request.body.model !== request.virtualModelId
          ? request.body.model
          : model);
      const promptContent = await requestCursorPromptContent(request);
      let reportedUsage: HostTokenUsage | null = null;
      const reportUsage = (usage: HostTokenUsage | null): void => {
        if (usage === null || usage === reportedUsage) return;
        reportedUsage = usage;
        request.onExecutionReceipt?.({
          host: request.routing?.host ?? "cursor",
          model: requestedModel,
          role: request.routing?.role ?? "main",
          capabilities:
            request.routing?.availableCapabilities ?? request.routing?.requiredCapabilities ?? [],
          usage,
        });
      };
      const hasImageInput = promptContent.some((part) => part.type === "image");
      const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-model-"));
      const removeWorkingDirectory = async (): Promise<void> => {
        await rm(workingDirectory, { recursive: true, force: true });
      };
      if (!hasImageInput) {
        const headlessModel = resolveCursorHeadlessModel(requestedModel, headlessModels);
        if (headlessModel === undefined) {
          await removeWorkingDirectory();
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            `Cursor Agent does not expose a headless model equivalent for ${requestedModel}. Refresh the Cursor model list and select a supported model.`,
          );
        }
        const executeHeadless = async (
          onTextDelta?: (delta: string) => void,
          onProcessDelta?: (delta: string) => void,
        ) =>
          runCursorHeadless({
            command: cursorLaunch.command,
            environment: cursorLaunch.environment,
            workingDirectory,
            model: headlessModel,
            prompt: requestPrompt(request),
            onUsageUpdate: reportUsage,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(onTextDelta === undefined ? {} : { onTextDelta }),
            ...(onProcessDelta === undefined ? {} : { onProcessDelta }),
          });
        if (request.body.stream === true) {
          return {
            kind: "stream",
            statusCode: 200,
            upstreamModel: requestedModel,
            stream: createLiveJsonStream(
              request,
              async (onTextDelta, onProcessDelta) => {
                try {
                  const result = await executeHeadless(onTextDelta, onProcessDelta);
                  request.onModelConfirmed?.(requestedModel);
                  reportUsage(result.usage);
                  return result;
                } finally {
                  await removeWorkingDirectory();
                }
              },
              () => reportedUsage,
            ),
          };
        }
        try {
          const result = await executeHeadless(undefined, request.onProcessDelta);
          request.onModelConfirmed?.(requestedModel);
          reportUsage(result.usage);
          return {
            kind: "json",
            statusCode: 200,
            upstreamModel: requestedModel,
            body: createResponse(request, result.text, undefined, result.usage),
          };
        } finally {
          await removeWorkingDirectory();
        }
      }
      const client = createCursorAcpClient({
        ...hostOptions,
        workingDirectory,
        mode: "ask",
        requestedModel,
        onProcessDelta: request.onProcessDelta,
      });
      const closeClient = async (): Promise<void> => {
        try {
          await client.close();
        } finally {
          await removeWorkingDirectory();
        }
      };
      const createConfirmedSession = async () => {
        await client.initialize(request.signal);
        const session = await client.createSession(request.signal);
        if (session.model === null) {
          throw new TiduError(
            "CONFIGURATION_CONFLICT",
            "Cursor ACP did not confirm the model selected for this session.",
          );
        }
        return { ...session, model: session.model };
      };
      const run = async (
        session: Awaited<ReturnType<typeof createConfirmedSession>>,
        onTextDelta?: (delta: string) => void,
      ): Promise<{
        text: string;
        usage: Awaited<ReturnType<typeof client.prompt>>["usage"];
      }> => {
        const result = await client.prompt(session.id, promptContent, request.signal, onTextDelta);
        reportUsage(result.usage);
        return {
          text: requireValidHostModelText(
            request,
            requireCompletedCursorPrompt(session.model, result),
          ),
          usage: result.usage,
        };
      };
      let session: Awaited<ReturnType<typeof createConfirmedSession>>;
      try {
        session = await createConfirmedSession();
        request.onModelConfirmed?.(session.model);
      } catch (error) {
        await closeClient().catch(() => undefined);
        throw error;
      }
      if (request.body.stream === true) {
        return {
          kind: "stream",
          statusCode: 200,
          upstreamModel: session.model,
          stream: createLiveJsonStream(
            request,
            async (onTextDelta) => {
              try {
                const result = await run(session, onTextDelta);
                reportUsage(result.usage);
                return result;
              } finally {
                await closeClient();
              }
            },
            () => reportedUsage,
          ),
        };
      }
      try {
        const result = await run(session);
        reportUsage(result.usage);
        return {
          kind: "json",
          statusCode: 200,
          upstreamModel: session.model,
          body: createResponse(request, result.text, undefined, result.usage),
        };
      } finally {
        try {
          await client.close();
        } finally {
          await rm(workingDirectory, { recursive: true, force: true });
        }
      }
    },
  };
};

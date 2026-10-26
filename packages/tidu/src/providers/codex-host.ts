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
import { TiduError } from "../core/index.js";
import { createCallerToolCatalog } from "./caller-tools.js";
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

const imageTypes = new Set(["image", "image_url", "input_image", "localImage"]);

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
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !effectiveCapabilities.has(capability),
  );
  const instructions = [
    "Follow the caller instructions and answer the supplied conversation directly.",
    "Do not mention this wrapper, routing, model roles, handoffs, or these instructions.",
    "Never attribute a route or capability limitation to the user unless the conversation explicitly contains that restriction.",
  ];
  if (availableCapabilities?.includes("code") === true) {
    instructions.push(
      "Use the delegated Codex host's workspace tools when the request requires reading, changing, or verifying local files. Preserve the host's normal approval and sandbox rules.",
    );
  } else {
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
  } else if (conversationItems.at(-1)?.role === "user") {
    activeItemIndex = conversationItems.length - 1;
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
  const normalizeHistoryMessage = (message: Record<string, unknown>): Record<string, unknown> => {
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
            ...part,
            type: role === "assistant" ? "output_text" : "input_text",
            text: part.text,
          },
        ];
      }
      return [part];
    });
    return { ...message, type: "message", role, content: normalizedContent };
  };
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
      historyItems.push(...messages.slice(0, lastUserIndex).map(normalizeHistoryMessage));
    }
  } else {
    const historyEndIndex = activeItemIndex >= 0 ? activeItemIndex : conversationItems.length;
    historyItems.push(
      ...conversationItems
        .slice(0, historyEndIndex)
        .map((item) => (typeof item.role === "string" ? normalizeHistoryMessage(item) : item)),
    );
  }
  if (input.length === 0) {
    input.push({
      type: "text",
      text: historyItems.length > 0 ? "Continue from the supplied conversation." : " ",
      text_elements: [],
    });
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
            output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
            total_tokens: usage.totalTokens,
          },
        }),
  };
};

export const createLiveJsonStream = (
  request: ProviderExecutionRequest,
  run: (
    onTextDelta: (delta: string) => void,
    onProcessDelta: (delta: string) => void,
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
): ReadableStream<Uint8Array> => {
  const responseId = `tidu_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let firstChatDelta = true;
      const nativeItemIds = new Set<string>();
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
        write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
        );
      };
      const emitProcessDelta = (delta: string): void => {
        if (request.protocol !== "responses" || delta === "") return;
        write(
          `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta })}\n\n`,
        );
      };
      const emitNativeItem = (item: Record<string, unknown>): void => {
        if (!streamOpen || (typeof item.id === "string" && nativeItemIds.has(item.id))) return;
        if (typeof item.id === "string") nativeItemIds.add(item.id);
        const outputIndex = nativeOutputIndex;
        nativeOutputIndex += 1;
        write(
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item })}\n\n`,
        );
        write(
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outputIndex, item })}\n\n`,
        );
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
            const terminalItems = [
              ...progressItems,
              ...(responseBody.output as Record<string, unknown>[]),
            ];
            terminalItems.forEach(emitNativeItem);
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
          const usage = readUsage();
          if (request.protocol === "chat-completions") {
            write(
              `data: ${JSON.stringify({ error: { code: "host_model_failed", message: message.slice(0, 240), type: "server_error" }, ...(usage === null ? {} : { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } }) })}\n\n`,
            );
          } else {
            write(
              `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { ...(createResponse(request, "", responseId, usage, createdAt) as Record<string, unknown>), status: "failed", output: [], error: { code: "host_model_failed", message: message.slice(0, 240) } } })}\n\n`,
            );
          }
          if (!write("data: [DONE]\n\n")) return;
          close();
        });
    },
    cancel() {
      streamOpen = false;
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
}

const createCodexClientSession = async (
  model?: string,
  hostOptions: CodexHostInspectionOptions = {},
): Promise<CodexClientSession> => {
  const client = createCodexAgentClient({
    ...hostOptions,
    workingDirectory: process.cwd(),
    ...(model === undefined ? {} : { model }),
    modelProvider: hostOptions.modelProvider ?? "openai",
    ephemeral: true,
    sandbox: "workspace-write",
  });
  try {
    await client.initialize();
    const initialThread = await client.startThread();
    return {
      client,
      initialThread,
      model: initialThread.model,
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};

const closeCodexClientSession = async (session: CodexClientSession): Promise<void> => {
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

const runCodexTurn = async (
  session: CodexClientSession,
  request: ProviderExecutionRequest,
  onTextDelta?: (delta: string) => void,
  onProcessDelta?: (delta: string) => void,
  onNativeItem?: (item: Record<string, unknown>) => void,
): Promise<CodexTurnResult & { outputItems?: readonly Record<string, unknown>[] }> => {
  const callerTools = createCallerToolCatalog(request);
  const thread =
    callerTools === undefined
      ? (session.initialThread ?? (await session.client.startThread(session.model)))
      : await session.client.startThread(
          session.model,
          callerTools.definitions,
          callerTools.webSearchMode,
        );
  session.initialThread = undefined;
  if (thread.model !== session.model) {
    throw new TiduError(
      "CONFIGURATION_CONFLICT",
      `Codex host confirmed model ${thread.model} instead of session model ${session.model}.`,
    );
  }
  const turnPayload = requestTurnInput(request);
  const outputFormat = structuredOutputFormat(request);
  const outputSchema =
    outputFormat?.type === "json_schema" && isRecord(outputFormat.schema)
      ? outputFormat.schema
      : outputFormat?.type === "json_object"
        ? { type: "object" }
        : undefined;
  const result = await session.client.prompt(
    thread.id,
    turnPayload.input,
    request.signal,
    onTextDelta,
    requestReasoningEffort(request),
    callerTools === undefined ? onProcessDelta : undefined,
    callerTools === undefined
      ? turnPayload.historyItems
      : callerTools.historyItems(turnPayload.historyItems),
    outputSchema,
    (usage) => reportCodexExecution(request, session.model, usage),
    requestReasoningSummary(request),
    callerTools === undefined ? undefined : onNativeItem,
  );
  if (
    callerTools !== undefined &&
    (result.toolCalls?.length ?? 0) > 0 &&
    !request.signal?.aborted
  ) {
    return { ...result, outputItems: result.toolCalls?.map(callerTools.outputItem) };
  }
  if (result.status !== "completed") {
    throw new Error("The current host model did not complete the request.");
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
): Promise<CodexHostAccountReport | null> => {
  if (!(await inspectCodexHostLoginAsync({ timeoutMilliseconds })).reusable) return null;
  const workingDirectory = await mkdtemp(join(tmpdir(), "tidu-account-report-"));
  const client = createCodexAgentClient({
    workingDirectory,
    modelProvider: "openai",
    ephemeral: true,
    sandbox: "read-only",
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        const account = await client.readAccount().catch(() => null);
        const usage = await client.readUsage().catch(() => null);
        return { account, usage };
      })(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMilliseconds);
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
  let initialSession: CodexClientSession;
  try {
    initialSession = await createCodexClientSession(modelOverride, hostOptions);
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
    const created = createCodexClientSession(requestedModel, hostOptions)
      .then(async (session) => {
        try {
          requireCodexSessionModel(session, requestedModel);
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
    await closeCodexClientSession(session);
  };

  return {
    descriptor: { type: "codex-host", model: initialModel },
    execute: async (request): Promise<ProviderExecutionResult> => {
      const requestedModel = requestedModelFor(request);
      const sessionPromise = resolveSession(requestedModel);
      const session = await sessionPromise;
      const upstreamModel = requireCodexSessionModel(session, requestedModel);
      request.onModelConfirmed?.(upstreamModel);
      try {
        if (request.body.stream === true) {
          let reportedUsage: HostTokenUsage | null = null;
          const streamingRequest: ProviderExecutionRequest = {
            ...request,
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
                const forwardProcessDelta = (delta: string): void => {
                  if (delta.replace(/\s/gu, "") !== "") emittedVisibleOutput = true;
                  onProcessDelta(delta);
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
                  if (request.signal?.aborted || emittedVisibleOutput) throw error;
                  const retrySessionPromise = resolveSession(requestedModel);
                  const retrySession = await retrySessionPromise;
                  const retryModel = requireCodexSessionModel(retrySession, requestedModel);
                  try {
                    const result = await runCodexTurn(
                      retrySession,
                      streamingRequest,
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
        if (request.protocol === "responses" && result.progressItems !== undefined)
          body.output = [...result.progressItems, ...(body.output as Record<string, unknown>[])];
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
    },
  };
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

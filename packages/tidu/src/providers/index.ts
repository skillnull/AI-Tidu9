import { randomUUID } from "node:crypto";

import { TiduError } from "../core/index.js";
import { createOpenAiError } from "../openai/index.js";
import {
  createOllamaSseStream,
  normalizeOllamaToolCalls,
  rewriteOpenAiSseStream,
} from "./streaming.js";

export type ProviderType =
  | "codex-host"
  | "cursor-host"
  | "ollama"
  | "openai-compatible"
  | "tidu-router";
export type ProviderProtocol = "chat-completions" | "responses";
export type ProviderPrivacy = "external" | "local" | "private";

export interface ProviderRoutingContext {
  /** Capabilities required by the caller in addition to those inferred from the request. */
  requiredCapabilities?: readonly string[];
  /** Most permissive data boundary allowed for this request. */
  privacy?: ProviderPrivacy;
  /** Semantic role used when coordinating main and specialist models. */
  role?: "main" | "planning" | "specialist" | "verification" | "worker";
  /** Secret Gate scope shared across one durable Agent task. */
  securityScopeId?: string;
  /** Upstream provider group selected behind the virtual-model entry. */
  modelSource?: "company" | "official";
  /** Upstream model selected without changing the public virtual-model identity. */
  targetModel?: string;
}

export interface ProviderDescriptor {
  /** Provider adapter selected for the active runtime. */
  type: ProviderType;
  /** Upstream model identifier, safe to show in local diagnostics. */
  model: string;
}

export interface ProviderExecutionRequest {
  /** OpenAI-compatible protocol received by the virtual model. */
  protocol: ProviderProtocol;
  /** Validated request body; the adapter replaces its virtual model identifier. */
  body: Readonly<Record<string, unknown>>;
  /** Public virtual model identifier returned to the client. */
  virtualModelId: string;
  /** Optional cancellation signal propagated from the client connection. */
  signal?: AbortSignal;
  /** Optional routing and security constraints that never leave the local runtime. */
  routing?: ProviderRoutingContext;
}

export interface ProviderJsonExecutionResult {
  /** JSON result discriminator. */
  kind: "json";
  /** HTTP status returned through the virtual-model boundary. */
  statusCode: number;
  /** OpenAI-compatible response body. */
  body: unknown;
}

export interface ProviderStreamExecutionResult {
  /** Streaming result discriminator. */
  kind: "stream";
  /** HTTP status returned through the virtual-model boundary. */
  statusCode: number;
  /** OpenAI-compatible Server-Sent Events byte stream. */
  stream: ReadableStream<Uint8Array>;
}

export type ProviderExecutionResult = ProviderJsonExecutionResult | ProviderStreamExecutionResult;

export interface ModelProvider {
  /** Non-secret provider identity exposed to local status surfaces. */
  descriptor: ProviderDescriptor;
  /** Executes one validated inference request as JSON or Server-Sent Events. */
  execute: (request: ProviderExecutionRequest) => Promise<ProviderExecutionResult>;
  /** Lists safe upstream model identifiers when the provider supports discovery. */
  listModels?: () => Promise<readonly { id: string; name: string }[]>;
  /** Releases persistent provider processes and connections owned by this adapter. */
  close?: () => Promise<void>;
}

export interface CatalogModelRouterOptions {
  /** Default provider used by the AI-Tidu9 virtual model and company service entry. */
  defaultProvider: ModelProvider;
  /** Official Codex provider used only for account-owned model identifiers. */
  officialProvider?: ModelProvider;
}

export const createCatalogModelRouter = (options: CatalogModelRouterOptions): ModelProvider => ({
  descriptor: { type: "tidu-router", model: options.defaultProvider.descriptor.model },
  execute: async (request) => {
    if (request.routing?.modelSource === "official" && options.officialProvider === undefined) {
      return {
        kind: "json",
        statusCode: 503,
        body: createOpenAiError(
          "official_provider_not_configured",
          "The selected official model source is unavailable.",
          "server_error",
        ),
      };
    }
    const useOfficialProvider =
      options.officialProvider !== undefined && request.routing?.modelSource === "official";
    const selectedProvider =
      useOfficialProvider && options.officialProvider !== undefined
        ? options.officialProvider
        : options.defaultProvider;
    return selectedProvider.execute(request);
  },
  listModels: () => options.defaultProvider.listModels?.() ?? Promise.resolve([]),
  close: async () => {
    const providers = new Set(
      [options.defaultProvider, options.officialProvider].filter(
        (provider): provider is ModelProvider => provider !== undefined,
      ),
    );
    await Promise.all([...providers].map((provider) => provider.close?.()));
  },
});

export interface ProviderEnvironment {
  /** Provider adapter name. */
  TIDU_PROVIDER?: string;
  /** Provider API origin or versioned base URL. */
  TIDU_PROVIDER_BASE_URL?: string;
  /** Upstream model identifier. */
  TIDU_PROVIDER_MODEL?: string;
  /** Runtime-only credential for OpenAI-compatible providers. */
  TIDU_PROVIDER_API_KEY?: string;
}

export interface ProviderAdapterOptions {
  /** Validated provider base URL. */
  baseUrl: string;
  /** Upstream model identifier. */
  model: string;
  /** Request timeout in milliseconds. */
  timeoutMilliseconds?: number;
}

export interface OpenAiCompatibleProviderOptions extends ProviderAdapterOptions {
  /** Optional bearer credential kept private by the adapter. */
  apiKey?: string;
}

export interface OllamaDiscoveryOptions {
  /** Ollama API origin; defaults to the standard loopback endpoint. */
  baseUrl?: string;
  /** Optional fetch implementation for isolated tests. */
  request?: typeof fetch;
  /** Discovery timeout in milliseconds. */
  timeoutMilliseconds?: number;
}

const DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmpty = (value: string | undefined, name: string): string => {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TiduError("CONFIGURATION_INVALID", `${name} must be configured.`);
  }
  return normalized;
};

const validateProviderBaseUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "TIDU_PROVIDER_BASE_URL must be a valid URL.", {
      cause: error,
    });
  }
  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Provider URLs must use HTTPS; HTTP is allowed only for loopback providers.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Provider URLs must not contain credentials, query parameters, or fragments.",
    );
  }
  return url;
};

const createEndpoint = (baseUrl: URL, path: string): URL => {
  const normalizedBasePath = baseUrl.pathname.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseAlreadyIncludesApiVersion = /\/v\d+$/u.test(normalizedBasePath);
  const pathname =
    baseAlreadyIncludesApiVersion && normalizedPath.startsWith("/v1/")
      ? `${normalizedBasePath}${normalizedPath.slice(3)}`
      : `${normalizedBasePath}${normalizedPath}`;
  const endpoint = new URL(baseUrl);
  endpoint.pathname = pathname;
  return endpoint;
};

const combineSignals = (
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds);
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
};

const readProviderJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Provider response exceeds the supported size.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Provider response is not valid JSON.", { cause: error });
  }
};

export const createOpenAiCompatibleProvider = (
  options: OpenAiCompatibleProviderOptions,
): ModelProvider => {
  const baseUrl = validateProviderBaseUrl(options.baseUrl);
  const model = requireNonEmpty(options.model, "model");
  const apiKey = options.apiKey?.trim();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS;

  return {
    descriptor: { type: "openai-compatible", model },
    listModels: async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const response = await fetch(createEndpoint(baseUrl, "/v1/models"), {
        headers,
        signal: AbortSignal.timeout(Math.min(timeoutMilliseconds, 10_000)),
      });
      if (!response.ok) return [{ id: model, name: model }];
      const body = await readProviderJson(response);
      if (!isRecord(body) || !Array.isArray(body.data)) return [{ id: model, name: model }];
      const models = body.data.flatMap((candidate) =>
        isRecord(candidate) && typeof candidate.id === "string"
          ? [{ id: candidate.id, name: candidate.id }]
          : [],
      );
      return models.length > 0 ? models : [{ id: model, name: model }];
    },
    execute: async (request) => {
      const streaming = request.body.stream === true;
      const endpoint = createEndpoint(
        baseUrl,
        request.protocol === "chat-completions" ? "/v1/chat/completions" : "/v1/responses",
      );
      const headers: Record<string, string> = {
        accept: streaming ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request.body, model: request.routing?.targetModel ?? model }),
        signal: combineSignals(request.signal, timeoutMilliseconds),
      });
      if (streaming && response.ok) {
        if (
          !response.headers.get("content-type")?.includes("text/event-stream") ||
          !response.body
        ) {
          throw new Error("Streaming provider response is not a Server-Sent Events stream.");
        }
        return {
          kind: "stream",
          statusCode: response.status,
          stream: rewriteOpenAiSseStream(response.body, request.virtualModelId),
        };
      }
      const responseBody = await readProviderJson(response);
      return {
        kind: "json",
        statusCode: response.status,
        body:
          response.ok && isRecord(responseBody)
            ? { ...responseBody, model: request.virtualModelId }
            : responseBody,
      };
    },
  };
};

const normalizeOllamaContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
};

const parseToolArguments = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
};

const toOllamaInputToolCalls = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((toolCall) => {
    if (
      !isRecord(toolCall) ||
      !isRecord(toolCall.function) ||
      typeof toolCall.function.name !== "string"
    ) {
      return [];
    }
    return [
      {
        id: typeof toolCall.id === "string" ? toolCall.id : undefined,
        type: "function",
        function: {
          name: toolCall.function.name,
          arguments: parseToolArguments(toolCall.function.arguments),
        },
      },
    ];
  });
};

const toOllamaMessages = (request: ProviderExecutionRequest): Array<Record<string, unknown>> => {
  const source =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  if (typeof source === "string") {
    return [{ role: "user", content: source }];
  }
  if (!Array.isArray(source)) {
    return [];
  }
  const toolNamesByCallId = new Map<string, string>();
  for (const message of source) {
    if (isRecord(message) && message.type === "function_call") {
      if (typeof message.call_id === "string" && typeof message.name === "string") {
        toolNamesByCallId.set(message.call_id, message.name);
      }
      continue;
    }
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (
        isRecord(toolCall) &&
        typeof toolCall.id === "string" &&
        isRecord(toolCall.function) &&
        typeof toolCall.function.name === "string"
      ) {
        toolNamesByCallId.set(toolCall.id, toolCall.function.name);
      }
    }
  }
  return source
    .filter((message): message is Record<string, unknown> => isRecord(message))
    .map((message) => {
      if (message.type === "function_call") {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: typeof message.call_id === "string" ? message.call_id : undefined,
              type: "function",
              function: {
                name: typeof message.name === "string" ? message.name : "unknown_function",
                arguments: parseToolArguments(message.arguments),
              },
            },
          ],
        };
      }
      if (message.type === "function_call_output") {
        const callId = typeof message.call_id === "string" ? message.call_id : undefined;
        return {
          role: "tool",
          content: normalizeOllamaContent(message.output),
          tool_call_id: callId,
          tool_name: callId === undefined ? undefined : toolNamesByCallId.get(callId),
        };
      }
      const toolCalls = toOllamaInputToolCalls(message.tool_calls);
      return {
        role: typeof message.role === "string" ? message.role : "user",
        content: normalizeOllamaContent(message.content),
        ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        ...(typeof message.tool_call_id === "string"
          ? {
              tool_call_id: message.tool_call_id,
              tool_name: toolNamesByCallId.get(message.tool_call_id),
            }
          : {}),
      };
    });
};

const toOllamaTools = (request: ProviderExecutionRequest): unknown => {
  if (!Array.isArray(request.body.tools) || request.body.tool_choice === "none") {
    return undefined;
  }
  const tools =
    request.protocol === "chat-completions"
      ? request.body.tools
      : request.body.tools.flatMap((tool) => {
          if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") {
            return [];
          }
          return [
            {
              type: "function",
              function: {
                name: tool.name,
                ...(typeof tool.description === "string" ? { description: tool.description } : {}),
                ...(isRecord(tool.parameters) ? { parameters: tool.parameters } : {}),
              },
            },
          ];
        });
  const choice = request.body.tool_choice;
  const selectedName =
    isRecord(choice) && choice.type === "function"
      ? request.protocol === "chat-completions" && isRecord(choice.function)
        ? choice.function.name
        : choice.name
      : undefined;
  return typeof selectedName !== "string"
    ? tools
    : tools.filter(
        (tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === selectedName,
      );
};

const readOllamaUsage = (body: Record<string, unknown>) => {
  const promptTokens = typeof body.prompt_eval_count === "number" ? body.prompt_eval_count : 0;
  const completionTokens = typeof body.eval_count === "number" ? body.eval_count : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
};

const toOllamaError = (statusCode: number, body: unknown): ProviderExecutionResult => ({
  kind: "json",
  statusCode,
  body: createOpenAiError(
    "provider_request_failed",
    isRecord(body) && typeof body.error === "string"
      ? body.error
      : "The Ollama provider rejected the request.",
    "server_error",
  ),
});

export const createOllamaProvider = (options: ProviderAdapterOptions): ModelProvider => {
  const baseUrl = validateProviderBaseUrl(options.baseUrl);
  const model = requireNonEmpty(options.model, "model");
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_PROVIDER_TIMEOUT_MILLISECONDS;

  return {
    descriptor: { type: "ollama", model },
    listModels: async () =>
      (await discoverOllamaModels({ baseUrl: baseUrl.origin })).map((modelId) => ({
        id: modelId,
        name: modelId,
      })),
    execute: async (request) => {
      const streaming = request.body.stream === true;
      const tools = toOllamaTools(request);
      const response = await fetch(createEndpoint(baseUrl, "/api/chat"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          model: request.routing?.targetModel ?? model,
          messages: toOllamaMessages(request),
          stream: streaming,
          ...(tools === undefined ? {} : { tools }),
        }),
        signal: combineSignals(request.signal, timeoutMilliseconds),
      });
      if (streaming && response.ok) {
        if (!response.body) {
          throw new Error("Ollama streaming response does not contain a body.");
        }
        return {
          kind: "stream",
          statusCode: response.status,
          stream: createOllamaSseStream(response.body, {
            protocol: request.protocol,
            virtualModelId: request.virtualModelId,
          }),
        };
      }
      const body = await readProviderJson(response);
      if (!response.ok) {
        return toOllamaError(response.status, body);
      }
      if (!isRecord(body) || !isRecord(body.message) || typeof body.message.content !== "string") {
        throw new Error("Ollama response does not contain message.content.");
      }
      const created = Math.floor(Date.now() / 1_000);
      const responseId = `${request.protocol === "responses" ? "resp" : "chatcmpl"}_${randomUUID()}`;
      const usage = readOllamaUsage(body);
      const toolCalls = normalizeOllamaToolCalls(body.message.tool_calls);
      if (request.protocol === "responses") {
        const output = [
          ...(body.message.content === ""
            ? []
            : [
                {
                  id: `msg_${randomUUID()}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: body.message.content, annotations: [] }],
                },
              ]),
          ...toolCalls.map((toolCall) => ({
            id: `fc_${randomUUID()}`,
            type: "function_call",
            status: "completed",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          })),
        ];
        return {
          kind: "json",
          statusCode: 200,
          body: {
            id: responseId,
            object: "response",
            created_at: created,
            model: request.virtualModelId,
            status: "completed",
            output,
            output_text: body.message.content,
            usage: {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            },
          },
        };
      }
      return {
        kind: "json",
        statusCode: 200,
        body: {
          id: responseId,
          object: "chat.completion",
          created,
          model: request.virtualModelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: body.message.content || null,
                ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
              },
              finish_reason:
                body.done === false ? null : toolCalls.length > 0 ? "tool_calls" : "stop",
            },
          ],
          usage,
        },
      };
    },
  };
};

export const discoverOllamaModels = async (
  options: OllamaDiscoveryOptions = {},
): Promise<readonly string[]> => {
  const baseUrl = validateProviderBaseUrl(options.baseUrl ?? "http://127.0.0.1:11434");
  const request = options.request ?? fetch;
  const response = await request(createEndpoint(baseUrl, "/api/tags"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 3_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama model discovery failed with HTTP ${response.status}.`);
  }
  const body = await readProviderJson(response);
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("Ollama model discovery returned an invalid response.");
  }
  return [
    ...new Set(
      body.models.flatMap((candidate) => {
        if (!isRecord(candidate)) {
          return [];
        }
        const model =
          typeof candidate.model === "string"
            ? candidate.model.trim()
            : typeof candidate.name === "string"
              ? candidate.name.trim()
              : "";
        return model ? [model] : [];
      }),
    ),
  ];
};

export const createProviderFromEnvironment = (
  environment: ProviderEnvironment = process.env,
): ModelProvider | undefined => {
  const providerName = environment.TIDU_PROVIDER?.trim();
  if (!providerName) {
    return undefined;
  }
  if (providerName !== "openai-compatible" && providerName !== "ollama") {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "TIDU_PROVIDER must be openai-compatible or ollama.",
    );
  }
  const model = requireNonEmpty(environment.TIDU_PROVIDER_MODEL, "TIDU_PROVIDER_MODEL");
  const configuredBaseUrl = environment.TIDU_PROVIDER_BASE_URL?.trim();
  const baseUrl =
    configuredBaseUrl ||
    (providerName === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1");
  return providerName === "ollama"
    ? createOllamaProvider({ baseUrl, model })
    : createOpenAiCompatibleProvider({
        baseUrl,
        model,
        apiKey: environment.TIDU_PROVIDER_API_KEY,
      });
};

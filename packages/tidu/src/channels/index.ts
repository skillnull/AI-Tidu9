import { inspectCodexHostLogin } from "../accounts/codex-host.js";
import { inspectCursorHostLogin } from "../accounts/cursor-host.js";
import { TiduError } from "../core/index.js";
import {
  createCodexHostModelProvider,
  createCursorHostModelProvider,
} from "../providers/codex-host.js";
import {
  createOpenAiCompatibleProvider,
  type ModelProvider,
  type OpenAiCompatibleProviderOptions,
} from "../providers/index.js";

export type TiduChannelId =
  | "tidu"
  | "codex"
  | "cursor"
  | "openai"
  | "deepseek"
  | "qwen"
  | "glm"
  | "kimi"
  | "doubao"
  | "hunyuan"
  | "custom";

export type TiduChannelKind = "virtual" | "host" | "provider";

export const TIDU_CHANNEL_IDS: readonly TiduChannelId[] = Object.freeze([
  "tidu",
  "codex",
  "cursor",
  "openai",
  "deepseek",
  "qwen",
  "glm",
  "kimi",
  "doubao",
  "hunyuan",
  "custom",
]);

export interface TiduChannelDescriptor {
  /** Stable channel identifier accepted by CLI, MCP, plugins, and CI. */
  id: TiduChannelId;
  /** Human-readable channel name. */
  name: string;
  /** Execution boundary used by this channel. */
  kind: TiduChannelKind;
  /** Whether the channel can be used without exposing credentials to AI-Tidu9. */
  available: boolean;
  /** Configured or host-discovered upstream model, when known. */
  model: string | null;
  /** Party that owns authentication for this channel. */
  authority: "tidu-runtime" | "host" | "environment";
  /** Safe readiness explanation without endpoints, paths, or credentials. */
  detail: string;
}

export interface TiduChannelRunRequest {
  /** Explicit channel selected for this request. */
  channel: TiduChannelId;
  /** Text sent to the selected channel. */
  input: string;
  /** Optional model override; required when a provider channel has no configured default. */
  model?: string;
}

export interface TiduChannelRunResult {
  /** Channel that completed the request. */
  channel: TiduChannelId;
  /** Upstream or virtual model used for the request. */
  model: string;
  /** Normalized assistant text. */
  text: string;
}

export interface TiduChannelGateway {
  /** Lists channels without returning credentials or private configuration values. */
  list: () => Promise<readonly TiduChannelDescriptor[]>;
  /** Executes one bounded text request through an explicitly selected channel. */
  run: (request: TiduChannelRunRequest) => Promise<TiduChannelRunResult>;
}

export interface TiduChannelGatewayOptions {
  /** AI-Tidu9 runtime origin used by the virtual channel. */
  endpoint?: string;
  /** Environment containing provider model and credential variables. */
  environment?: NodeJS.ProcessEnv;
  /** HTTP implementation used by the virtual channel. */
  request?: typeof fetch;
  /** Codex provider factory override used by isolated tests. */
  createCodexProvider?: (model?: string) => Promise<ModelProvider | undefined>;
  /** Cursor provider factory override used by isolated tests. */
  createCursorProvider?: () => Promise<ModelProvider | undefined>;
  /** OpenAI-compatible provider factory override used by isolated tests. */
  createCompatibleProvider?: (options: OpenAiCompatibleProviderOptions) => ModelProvider;
  /** Sanitized Codex availability probe override. */
  codexAvailable?: () => boolean;
  /** Sanitized Cursor availability probe override. */
  cursorAvailable?: () => boolean;
}

interface ProviderChannelDefinition {
  /** Stable provider channel identifier. */
  id: Exclude<TiduChannelId, "tidu" | "codex" | "cursor">;
  /** Human-readable provider name. */
  name: string;
  /** Default OpenAI-compatible API base URL. */
  baseUrl: string | null;
  /** Environment variable containing the provider API key. */
  apiKeyEnvironmentVariable: string;
  /** Environment variable containing the default provider model. */
  modelEnvironmentVariable: string;
}

const MAXIMUM_INPUT_CHARACTERS = 100_000;

const PROVIDER_CHANNELS: readonly ProviderChannelDefinition[] = Object.freeze([
  {
    id: "openai",
    name: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    modelEnvironmentVariable: "OPENAI_MODEL",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
    modelEnvironmentVariable: "DEEPSEEK_MODEL",
  },
  {
    id: "qwen",
    name: "Alibaba Cloud Model Studio",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvironmentVariable: "DASHSCOPE_API_KEY",
    modelEnvironmentVariable: "DASHSCOPE_MODEL",
  },
  {
    id: "glm",
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnvironmentVariable: "ZHIPU_API_KEY",
    modelEnvironmentVariable: "ZHIPU_MODEL",
  },
  {
    id: "kimi",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnvironmentVariable: "MOONSHOT_API_KEY",
    modelEnvironmentVariable: "MOONSHOT_MODEL",
  },
  {
    id: "doubao",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnvironmentVariable: "ARK_API_KEY",
    modelEnvironmentVariable: "ARK_MODEL",
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    apiKeyEnvironmentVariable: "HUNYUAN_API_KEY",
    modelEnvironmentVariable: "HUNYUAN_MODEL",
  },
  {
    id: "custom",
    name: "Custom OpenAI-compatible provider",
    baseUrl: null,
    apiKeyEnvironmentVariable: "TIDU_CHANNEL_API_KEY",
    modelEnvironmentVariable: "TIDU_CHANNEL_MODEL",
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeEndpoint = (candidate: string): string => {
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "Channel endpoint must be a valid URL.", {
      cause: error,
    });
  }
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname)))
  ) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Channel endpoint must use HTTPS or uncredentialed loopback HTTP.",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
};

const extractText = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new Error("Channel returned an unsupported response envelope.");
  }
  if (typeof body.output_text === "string") {
    return body.output_text;
  }
  if (Array.isArray(body.output)) {
    const text = body.output
      .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
      .map((content) => (isRecord(content) && typeof content.text === "string" ? content.text : ""))
      .join("");
    if (text !== "") return text;
  }
  if (Array.isArray(body.choices)) {
    const firstChoice = body.choices[0];
    if (
      isRecord(firstChoice) &&
      isRecord(firstChoice.message) &&
      typeof firstChoice.message.content === "string"
    ) {
      return firstChoice.message.content;
    }
  }
  throw new Error("Channel response does not contain assistant text.");
};

const readJson = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
        ? body.error.message
        : `Channel request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
};

const readTiduModel = (body: unknown): string | undefined =>
  isRecord(body) &&
  Array.isArray(body.data) &&
  isRecord(body.data[0]) &&
  typeof body.data[0].id === "string"
    ? body.data[0].id
    : undefined;

const findProviderDefinition = (channel: TiduChannelId): ProviderChannelDefinition | undefined =>
  PROVIDER_CHANNELS.find((definition) => definition.id === channel);

const validateRunRequest = (request: TiduChannelRunRequest): void => {
  if (request.input.trim() === "" || request.input.length > MAXIMUM_INPUT_CHARACTERS) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      `Channel input must contain 1-${MAXIMUM_INPUT_CHARACTERS} characters.`,
    );
  }
  if (request.model !== undefined && request.model.trim() === "") {
    throw new TiduError("CONFIGURATION_INVALID", "Channel model override cannot be empty.");
  }
};

export const createTiduChannelGateway = (
  options: TiduChannelGatewayOptions = {},
): TiduChannelGateway => {
  const environment = options.environment ?? process.env;
  const endpoint = normalizeEndpoint(
    options.endpoint ?? environment.TIDU_ENDPOINT ?? "http://127.0.0.1:9639",
  );
  const requestHttp = options.request ?? fetch;
  const createCodexProvider = options.createCodexProvider ?? createCodexHostModelProvider;
  const createCursorProvider = options.createCursorProvider ?? createCursorHostModelProvider;
  const createCompatibleProvider =
    options.createCompatibleProvider ?? createOpenAiCompatibleProvider;
  const codexAvailable = options.codexAvailable ?? (() => inspectCodexHostLogin().reusable);
  const cursorAvailable = options.cursorAvailable ?? (() => inspectCursorHostLogin().reusable);

  const inspectTidu = async (): Promise<TiduChannelDescriptor> => {
    try {
      const response = await requestHttp(`${endpoint}/v1/models`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const model = readTiduModel(await readJson(response));
      return {
        id: "tidu",
        name: "九门赛博提督",
        kind: "virtual",
        available: model !== undefined,
        model: model ?? null,
        authority: "tidu-runtime",
        detail: model === undefined ? "Runtime exposed no virtual model." : "Runtime ready.",
      };
    } catch {
      return {
        id: "tidu",
        name: "九门赛博提督",
        kind: "virtual",
        available: false,
        model: null,
        authority: "tidu-runtime",
        detail: "Runtime unavailable.",
      };
    }
  };

  const listProviderChannels = (): readonly TiduChannelDescriptor[] =>
    PROVIDER_CHANNELS.map((definition) => {
      const model = environment[definition.modelEnvironmentVariable]?.trim() || null;
      const apiKeyAvailable = Boolean(environment[definition.apiKeyEnvironmentVariable]?.trim());
      const customBaseUrlAvailable =
        definition.id !== "custom" || Boolean(environment.TIDU_CHANNEL_BASE_URL?.trim());
      const available = apiKeyAvailable && model !== null && customBaseUrlAvailable;
      return {
        id: definition.id,
        name: definition.name,
        kind: "provider",
        available,
        model,
        authority: "environment",
        detail: available
          ? "Environment configuration ready."
          : `Set ${definition.apiKeyEnvironmentVariable} and ${definition.modelEnvironmentVariable}${definition.id === "custom" ? " with TIDU_CHANNEL_BASE_URL" : ""}.`,
      };
    });

  const runTidu = async (input: string): Promise<TiduChannelRunResult> => {
    const modelsResponse = await requestHttp(`${endpoint}/v1/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const model = readTiduModel(await readJson(modelsResponse));
    if (model === undefined) {
      throw new Error("AI-Tidu9 did not expose an active virtual model.");
    }
    const response = await requestHttp(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ model, input, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    return { channel: "tidu", model, text: extractText(await readJson(response)) };
  };

  const runProvider = async (
    channel: ProviderChannelDefinition,
    input: string,
    modelOverride: string | undefined,
  ): Promise<TiduChannelRunResult> => {
    const model = modelOverride?.trim() || environment[channel.modelEnvironmentVariable]?.trim();
    const apiKey = environment[channel.apiKeyEnvironmentVariable]?.trim();
    const baseUrl =
      channel.id === "custom" ? environment.TIDU_CHANNEL_BASE_URL?.trim() : channel.baseUrl;
    if (!model || !apiKey || !baseUrl) {
      throw new TiduError(
        "CONFIGURATION_INVALID",
        `Channel '${channel.id}' requires ${channel.apiKeyEnvironmentVariable}, ${channel.modelEnvironmentVariable}${channel.id === "custom" ? ", and TIDU_CHANNEL_BASE_URL" : ""}.`,
      );
    }
    const provider = createCompatibleProvider({ baseUrl, model, apiKey });
    const result = await provider.execute({
      protocol: "chat-completions",
      virtualModelId: `${channel.id}:${model}`,
      body: { model, messages: [{ role: "user", content: input }], stream: false },
    });
    if (result.kind !== "json" || result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`Channel '${channel.id}' did not return a successful JSON response.`);
    }
    return { channel: channel.id, model, text: extractText(result.body) };
  };

  return {
    list: async () => {
      const codexReady = codexAvailable();
      const cursorReady = cursorAvailable();
      return [
        await inspectTidu(),
        {
          id: "codex",
          name: "Codex official host",
          kind: "host",
          available: codexReady,
          model: environment.TIDU_CODEX_MODEL?.trim() || null,
          authority: "host",
          detail: codexReady ? "Official host login ready." : "Official host unavailable.",
        },
        {
          id: "cursor",
          name: "Cursor official host",
          kind: "host",
          available: cursorReady,
          model: null,
          authority: "host",
          detail: cursorReady ? "Official ACP login ready." : "Official ACP unavailable.",
        },
        ...listProviderChannels(),
      ];
    },
    run: async (runRequest) => {
      validateRunRequest(runRequest);
      if (runRequest.channel === "tidu") {
        return runTidu(runRequest.input);
      }
      if (runRequest.channel === "codex") {
        const provider = await createCodexProvider(
          runRequest.model ?? environment.TIDU_CODEX_MODEL,
        );
        if (provider === undefined) {
          throw new TiduError("CONFIGURATION_INVALID", "Codex official host is unavailable.");
        }
        const result = await provider.execute({
          protocol: "chat-completions",
          virtualModelId: "codex-host",
          body: {
            model: provider.descriptor.model,
            messages: [{ role: "user", content: runRequest.input }],
            stream: false,
          },
        });
        if (result.kind !== "json" || result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error("Codex official host did not return a successful JSON response.");
        }
        return {
          channel: "codex",
          model: provider.descriptor.model,
          text: extractText(result.body),
        };
      }
      if (runRequest.channel === "cursor") {
        if (runRequest.model !== undefined) {
          throw new TiduError(
            "CONFIGURATION_INVALID",
            "Cursor controls its active model; --model is not supported for the Cursor channel.",
          );
        }
        const provider = await createCursorProvider();
        if (provider === undefined) {
          throw new TiduError("CONFIGURATION_INVALID", "Cursor official host is unavailable.");
        }
        const result = await provider.execute({
          protocol: "chat-completions",
          virtualModelId: "cursor-host",
          body: {
            model: provider.descriptor.model,
            messages: [{ role: "user", content: runRequest.input }],
            stream: false,
          },
        });
        if (result.kind !== "json" || result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error("Cursor official host did not return a successful JSON response.");
        }
        return {
          channel: "cursor",
          model: provider.descriptor.model,
          text: extractText(result.body),
        };
      }
      const providerChannel = findProviderDefinition(runRequest.channel);
      if (providerChannel === undefined) {
        throw new TiduError("CONFIGURATION_INVALID", `Unknown channel: ${runRequest.channel}`);
      }
      return runProvider(providerChannel, runRequest.input, runRequest.model);
    },
  };
};

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  createTiduChannelGateway,
  TIDU_CHANNEL_IDS,
  type TiduChannelGateway,
  type TiduChannelId,
} from "../channels/index.js";
import { PRODUCT } from "../core/index.js";

export interface TiduMcpServerOptions {
  /** Local or remote AI-Tidu9 runtime origin. */
  endpoint?: string;
  /** JSON-RPC input stream; defaults to process stdin. */
  input?: Readable;
  /** JSON-RPC output stream; defaults to process stdout. */
  output?: Writable;
  /** HTTP implementation used for runtime calls. */
  request?: typeof fetch;
  /** Maximum accepted bytes for one newline-framed request. */
  maximumMessageBytes?: number;
  /** Explicit channel gateway override used by embedded hosts and isolated tests. */
  channelGateway?: TiduChannelGateway;
}

export interface TiduMcpServer {
  /** Resolves after the input stream closes. */
  completed: Promise<void>;
  /** Stops reading requests without closing process stdio. */
  close: () => void;
}

interface McpRequest {
  /** JSON-RPC request identifier. */
  id: number | string;
  /** MCP method name. */
  method: string;
  /** Untrusted method parameters. */
  params: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAXIMUM_MESSAGE_BYTES = 1_048_576;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeEndpoint = (candidate: string): string => {
  const endpoint = new URL(candidate);
  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname)))
  ) {
    throw new Error("MCP endpoint must use HTTPS or an uncredentialed loopback HTTP origin.");
  }
  return endpoint.toString().replace(/\/$/u, "");
};

const requestJson = async (
  request: typeof fetch,
  endpoint: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await request(`${endpoint}${path}`, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
        ? body.error.message
        : `AI-Tidu9 runtime returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
};

const toolDefinitions = Object.freeze([
  {
    name: "get_tidu_status",
    description:
      "Inspect the active AI-Tidu9 runtime and virtual model without returning credentials, prompts, or conversation history.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "route_tidu_task",
    description:
      "Route one goal through the AI-Tidu9 Agent kernel, including planning, capability completion, bounded execution, and verification.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        input: { type: "string", minLength: 1, maxLength: 100_000 },
      },
      required: ["input"],
    },
  },
  {
    name: "list_tidu_channels",
    description:
      "List the AI-Tidu9 virtual channel, official host channels, and configured provider channels without returning credentials.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "route_tidu_channel",
    description:
      "Run one text request through an explicit AI-Tidu9, official host, or configured provider channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", enum: TIDU_CHANNEL_IDS },
        input: { type: "string", minLength: 1, maxLength: 100_000 },
        model: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["channel", "input"],
    },
  },
]);

const extractResponseText = (body: unknown): string => {
  if (!isRecord(body)) {
    return JSON.stringify(body);
  }
  if (typeof body.output_text === "string") {
    return body.output_text;
  }
  if (Array.isArray(body.output)) {
    const text = body.output
      .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
      .map((content) => (isRecord(content) && typeof content.text === "string" ? content.text : ""))
      .join("");
    if (text !== "") {
      return text;
    }
  }
  return JSON.stringify(body);
};

const handleToolCall = async (
  params: unknown,
  endpoint: string,
  request: typeof fetch,
  channelGateway: TiduChannelGateway,
): Promise<Record<string, unknown>> => {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("MCP tool call is invalid.");
  }
  if (params.name === "get_tidu_status") {
    const [health, models] = await Promise.all([
      requestJson(request, endpoint, "/health"),
      requestJson(request, endpoint, "/v1/models"),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({ health, models }) }],
      structuredContent: { health, models },
    };
  }
  if (params.name === "route_tidu_task") {
    const argumentsValue = params.arguments;
    const input = isRecord(argumentsValue) ? argumentsValue.input : undefined;
    if (typeof input !== "string" || input.trim() === "" || input.length > 100_000) {
      throw new Error("route_tidu_task requires an input string from 1 to 100000 characters.");
    }
    const models = await requestJson(request, endpoint, "/v1/models");
    const model =
      isRecord(models) &&
      Array.isArray(models.data) &&
      isRecord(models.data[0]) &&
      typeof models.data[0].id === "string"
        ? models.data[0].id
        : undefined;
    if (model === undefined) {
      throw new Error("AI-Tidu9 did not expose an active virtual model.");
    }
    const response = await requestJson(request, endpoint, "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input, stream: false }),
    });
    return { content: [{ type: "text", text: extractResponseText(response) }] };
  }
  if (params.name === "list_tidu_channels") {
    const channels = await channelGateway.list();
    return {
      content: [{ type: "text", text: JSON.stringify(channels) }],
      structuredContent: { channels },
    };
  }
  if (params.name === "route_tidu_channel") {
    const argumentsValue = params.arguments;
    const channel = isRecord(argumentsValue) ? argumentsValue.channel : undefined;
    const input = isRecord(argumentsValue) ? argumentsValue.input : undefined;
    const model = isRecord(argumentsValue) ? argumentsValue.model : undefined;
    if (
      typeof channel !== "string" ||
      !TIDU_CHANNEL_IDS.includes(channel as TiduChannelId) ||
      typeof input !== "string" ||
      input.trim() === "" ||
      input.length > 100_000 ||
      (model !== undefined && (typeof model !== "string" || model.trim() === ""))
    ) {
      throw new Error("route_tidu_channel requires a valid channel, input, and optional model.");
    }
    const result = await channelGateway.run({
      channel: channel as TiduChannelId,
      input,
      ...(typeof model === "string" ? { model } : {}),
    });
    return {
      content: [{ type: "text", text: result.text }],
      structuredContent: result,
    };
  }
  throw new Error(`Unknown AI-Tidu9 MCP tool: ${params.name}`);
};

export const startTiduMcpServer = (options: TiduMcpServerOptions = {}): TiduMcpServer => {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const request = options.request ?? fetch;
  const endpoint = normalizeEndpoint(
    options.endpoint ?? process.env.TIDU_ENDPOINT ?? "http://127.0.0.1:9639",
  );
  const channelGateway = options.channelGateway ?? createTiduChannelGateway({ endpoint, request });
  const maximumMessageBytes = options.maximumMessageBytes ?? DEFAULT_MAXIMUM_MESSAGE_BYTES;
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  const write = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const respond = async (requestMessage: McpRequest): Promise<void> => {
    try {
      let result: unknown;
      if (requestMessage.method === "initialize") {
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-tidu9", title: PRODUCT.explanation, version: PRODUCT.version },
          instructions:
            "AI-Tidu9 is an Agent runtime, not an MCP tool collection. route_tidu_task enters the same planning, capability-completion, execution, and verification kernel used by native clients. route_tidu_channel is only for an explicitly selected provider channel.",
        };
      } else if (requestMessage.method === "ping") {
        result = {};
      } else if (requestMessage.method === "tools/list") {
        result = { tools: toolDefinitions };
      } else if (requestMessage.method === "tools/call") {
        result = await handleToolCall(requestMessage.params, endpoint, request, channelGateway);
      } else {
        throw new Error(`Unsupported MCP method: ${requestMessage.method}`);
      }
      write({ jsonrpc: "2.0", id: requestMessage.id, result });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id: requestMessage.id,
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : "MCP request failed.",
        },
      });
    }
  };

  const completed = new Promise<void>((resolve) => {
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) > maximumMessageBytes) {
        lines.close();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } });
        return;
      }
      if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
        return;
      }
      if (typeof value.id !== "string" && typeof value.id !== "number") {
        return;
      }
      void respond({ id: value.id, method: value.method, params: value.params });
    });
    lines.once("close", resolve);
  });

  return { completed, close: () => lines.close() };
};

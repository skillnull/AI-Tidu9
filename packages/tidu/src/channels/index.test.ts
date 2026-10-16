import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProvider } from "../providers/index.js";
import { createTiduChannelGateway } from "./index.js";

const createProvider = (model: string, text: string): ModelProvider => ({
  descriptor: { type: "openai-compatible", model },
  execute: async () => ({
    kind: "json",
    statusCode: 200,
    body: { choices: [{ message: { content: text } }] },
  }),
});

test("lists virtual, host, and provider channels without exposing credentials", async () => {
  const gateway = createTiduChannelGateway({
    environment: {
      OPENAI_API_KEY: "private-value",
      OPENAI_MODEL: "official-model",
      DASHSCOPE_API_KEY: "private-value",
      DASHSCOPE_MODEL: "qwen-model",
    },
    request: async () => Response.json({ data: [{ id: "ai-tidu9-config" }] }),
    codexAvailable: () => true,
    cursorAvailable: () => false,
  });

  const channels = await gateway.list();
  assert.equal(channels.find((channel) => channel.id === "tidu")?.available, true);
  assert.equal(channels.find((channel) => channel.id === "codex")?.available, true);
  assert.equal(channels.find((channel) => channel.id === "cursor")?.available, false);
  assert.equal(channels.find((channel) => channel.id === "openai")?.model, "official-model");
  assert.equal(channels.find((channel) => channel.id === "qwen")?.available, true);
  assert.doesNotMatch(JSON.stringify(channels), /private-value/u);
});

test("routes virtual and official host channels through separate adapters", async () => {
  const gateway = createTiduChannelGateway({
    environment: {},
    request: async (input) =>
      String(input).endsWith("/v1/models")
        ? Response.json({ data: [{ id: "ai-tidu9-config" }] })
        : Response.json({ output_text: "tidu-result" }),
    createCodexProvider: async () => createProvider("official-model", "official-result"),
    createCursorProvider: async () => undefined,
    codexAvailable: () => true,
    cursorAvailable: () => false,
  });

  assert.deepEqual(await gateway.run({ channel: "tidu", input: "work" }), {
    channel: "tidu",
    model: "ai-tidu9-config",
    text: "tidu-result",
  });
  assert.deepEqual(await gateway.run({ channel: "codex", input: "work" }), {
    channel: "codex",
    model: "official-model",
    text: "official-result",
  });
});

test("routes configured domestic providers through the compatible boundary", async () => {
  let receivedOptions: OpenAiProviderOptions | undefined;
  interface OpenAiProviderOptions {
    /** Provider base URL selected by the preset. */
    baseUrl: string;
    /** Provider model selected by the environment. */
    model: string;
    /** Runtime-only credential passed to the provider adapter. */
    apiKey?: string;
  }
  const gateway = createTiduChannelGateway({
    environment: { DASHSCOPE_API_KEY: "private-value", DASHSCOPE_MODEL: "qwen-plus" },
    request: async () => Response.json({ data: [] }),
    createCompatibleProvider: (options) => {
      receivedOptions = options;
      return createProvider(options.model, "qwen-result");
    },
    codexAvailable: () => false,
    cursorAvailable: () => false,
  });

  const result = await gateway.run({ channel: "qwen", input: "work" });
  assert.equal(result.text, "qwen-result");
  assert.equal(receivedOptions?.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(receivedOptions?.model, "qwen-plus");
});

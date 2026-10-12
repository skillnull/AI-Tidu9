import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { TiduError } from "../core/index.js";
import {
  createOllamaProvider,
  createOpenAiCompatibleProvider,
  createProviderFromEnvironment,
} from "./index.js";

interface TestServer {
  /** Loopback origin allocated for the test server. */
  origin: string;
  /** Closes the server and releases its socket. */
  close: () => Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const startTestServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
};

test("forwards OpenAI-compatible requests without exposing provider identity", async () => {
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedPath = request.url ?? "";
      receivedAuthorization = request.headers.authorization ?? "";
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-upstream",
          object: "chat.completion",
          model: "upstream-model",
          choices: [],
        }),
      );
    });
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${server.origin}/v1`,
      model: "upstream-model",
      apiKey: "test-only-secret",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
      },
      virtualModelId: "managed-default",
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.kind, "json");
    if (result.kind !== "json") {
      throw new Error("Expected a JSON provider result.");
    }
    assert.equal(receivedPath, "/v1/chat/completions");
    assert.equal(receivedAuthorization, "Bearer test-only-secret");
    assert.equal(receivedBody.model, "upstream-model");
    assert.equal((result.body as { model: string }).model, "managed-default");
    assert.deepEqual(provider.descriptor, {
      type: "openai-compatible",
      model: "upstream-model",
    });
    assert.equal("apiKey" in provider.descriptor, false);
    assert.equal("baseUrl" in provider.descriptor, false);
  } finally {
    await server.close();
  }
});

test("translates Ollama chat and Responses payloads into the virtual model contract", async () => {
  const receivedBodies: Record<string, unknown>[] = [];
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "qwen-test",
          done: true,
          message: { role: "assistant", content: "local result" },
          prompt_eval_count: 7,
          eval_count: 3,
        }),
      );
    });
  });

  try {
    const provider = createOllamaProvider({ baseUrl: server.origin, model: "qwen-test" });
    const chat = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
      },
      virtualModelId: "managed-default",
    });
    const responses = await provider.execute({
      protocol: "responses",
      body: { model: "managed-default", input: "hello again" },
      virtualModelId: "managed-default",
    });

    assert.equal(chat.kind, "json");
    assert.equal(responses.kind, "json");
    if (chat.kind !== "json" || responses.kind !== "json") {
      throw new Error("Expected JSON provider results.");
    }
    assert.equal(chat.statusCode, 200);
    assert.equal((chat.body as { model: string }).model, "managed-default");
    assert.deepEqual((chat.body as { usage: unknown }).usage, {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
    assert.equal(responses.statusCode, 200);
    assert.equal((responses.body as { model: string }).model, "managed-default");
    assert.equal((responses.body as { output_text: string }).output_text, "local result");
    assert.equal(receivedBodies.length, 2);
    assert.equal(receivedBodies[0]?.model, "qwen-test");
    assert.equal(receivedBodies[0]?.stream, false);
    assert.deepEqual(receivedBodies[1]?.messages, [{ role: "user", content: "hello again" }]);
  } finally {
    await server.close();
  }
});

test("normalizes Ollama function calls and tool-result continuation messages", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          done: true,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call-next", function: { name: "lookup", arguments: { city: "Beijing" } } },
            ],
          },
        }),
      );
    });
  });

  try {
    const provider = createOllamaProvider({ baseUrl: server.origin, model: "qwen-test" });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "managed-default",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-previous",
                type: "function",
                function: { name: "lookup", arguments: '{"city":"Shanghai"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-previous", content: "sunny" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      },
      virtualModelId: "managed-default",
    });

    assert.equal(result.kind, "json");
    if (result.kind !== "json") {
      throw new Error("Expected a JSON provider result.");
    }
    const resultBody = result.body as {
      choices: Array<{
        finish_reason: string;
        message: { content: null; tool_calls: Array<{ function: { arguments: string } }> };
      }>;
    };
    assert.equal(resultBody.choices[0]?.finish_reason, "tool_calls");
    assert.equal(resultBody.choices[0]?.message.content, null);
    assert.equal(
      resultBody.choices[0]?.message.tool_calls[0]?.function.arguments,
      '{"city":"Beijing"}',
    );
    assert.equal(Array.isArray(receivedBody.tools), true);
    const messages = receivedBody.messages as Array<Record<string, unknown>>;
    assert.equal((messages[1] as { tool_name?: string }).tool_name, "lookup");
  } finally {
    await server.close();
  }
});

test("streams OpenAI-compatible SSE while preserving the virtual model identity", async () => {
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      assert.equal(body.stream, true);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"id":"chatcmpl-upstream","model":"upstream-model","choices":[{"delta":{"content":"hello"}}]}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
  });

  try {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `${server.origin}/v1`,
      model: "upstream-model",
    });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "managed-default",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      virtualModelId: "managed-default",
    });

    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.match(events, /"model":"managed-default"/u);
    assert.doesNotMatch(events, /upstream-model/u);
    assert.match(events, /data: \[DONE\]/u);
  } finally {
    await server.close();
  }
});

test("streams Ollama text and function calls as Chat Completions SSE", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = await startTestServer((request, response) => {
    void readBody(request).then((body) => {
      receivedBody = body;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(
        `${JSON.stringify({ message: { role: "assistant", content: "working" }, done: false })}\n`,
      );
      response.end(
        `${JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "lookup", arguments: { city: "Shanghai" } } }],
          },
          done: true,
          prompt_eval_count: 5,
          eval_count: 2,
        })}\n`,
      );
    });
  });

  try {
    const provider = createOllamaProvider({ baseUrl: server.origin, model: "qwen-test" });
    const result = await provider.execute({
      protocol: "chat-completions",
      body: {
        model: "managed-default",
        messages: [{ role: "user", content: "weather" }],
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      },
      virtualModelId: "managed-default",
    });

    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.equal(receivedBody.stream, true);
    assert.equal(Array.isArray(receivedBody.tools), true);
    assert.match(events, /chat\.completion\.chunk/u);
    assert.match(events, /"model":"managed-default"/u);
    assert.match(events, /"name":"lookup"/u);
    assert.match(events, /"finish_reason":"tool_calls"/u);
    assert.match(events, /data: \[DONE\]/u);
  } finally {
    await server.close();
  }
});

test("streams Ollama text as Responses events", async () => {
  const server = await startTestServer((request, response) => {
    void readBody(request).then(() => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        `${JSON.stringify({
          message: { role: "assistant", content: "local response" },
          done: true,
          prompt_eval_count: 4,
          eval_count: 2,
        })}\n`,
      );
    });
  });

  try {
    const provider = createOllamaProvider({ baseUrl: server.origin, model: "qwen-test" });
    const result = await provider.execute({
      protocol: "responses",
      body: { model: "managed-default", input: "hello", stream: true },
      virtualModelId: "managed-default",
    });
    assert.equal(result.kind, "stream");
    if (result.kind !== "stream") {
      throw new Error("Expected a streaming provider result.");
    }
    const events = await new Response(result.stream).text();
    assert.match(events, /event: response\.created/u);
    assert.match(events, /event: response\.output_text\.delta/u);
    assert.match(events, /event: response\.completed/u);
    assert.match(events, /"model":"managed-default"/u);
  } finally {
    await server.close();
  }
});

test("creates providers from minimal environment configuration", () => {
  const ollama = createProviderFromEnvironment({
    TIDU_PROVIDER: "ollama",
    TIDU_PROVIDER_MODEL: "qwen-test",
  });
  assert.deepEqual(ollama?.descriptor, { type: "ollama", model: "qwen-test" });

  const compatible = createProviderFromEnvironment({
    TIDU_PROVIDER: "openai-compatible",
    TIDU_PROVIDER_MODEL: "gpt-test",
    TIDU_PROVIDER_API_KEY: "runtime-only-secret",
  });
  assert.deepEqual(compatible?.descriptor, {
    type: "openai-compatible",
    model: "gpt-test",
  });
  assert.equal(createProviderFromEnvironment({}), undefined);
});

test("rejects unsafe or incomplete provider environment configuration", () => {
  assert.throws(
    () => createProviderFromEnvironment({ TIDU_PROVIDER: "ollama" }),
    (error) => error instanceof TiduError && error.code === "CONFIGURATION_INVALID",
  );
  assert.throws(
    () =>
      createProviderFromEnvironment({
        TIDU_PROVIDER: "openai-compatible",
        TIDU_PROVIDER_MODEL: "gpt-test",
        TIDU_PROVIDER_BASE_URL: "http://models.example.com/v1",
      }),
    (error) => error instanceof TiduError && error.code === "CONFIGURATION_INVALID",
  );
});

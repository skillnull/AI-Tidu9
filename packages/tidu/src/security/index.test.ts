import assert from "node:assert/strict";
import test from "node:test";

import type { ModelProvider } from "../providers/index.js";
import { createSecretGate, guardModelProvider } from "./index.js";

test("automatically replaces sensitive fields and restores only inside the matching scope", () => {
  const gate = createSecretGate();
  const protectedInput = gate.protect(
    { command: "curl -H 'Authorization: Bearer example-secret-value-1234' /health" },
    { scopeId: "task-one", destination: "model" },
  );
  assert.equal(protectedInput.findings.length, 1);
  assert.doesNotMatch(JSON.stringify(protectedInput.value), /example-secret-value/u);
  assert.match(JSON.stringify(protectedInput.value), /TIDU_SECRET:task-one/u);
  assert.deepEqual(gate.recover(protectedInput.value, "task-one"), {
    command: "curl -H 'Authorization: Bearer example-secret-value-1234' /health",
  });
  assert.notDeepEqual(gate.recover(protectedInput.value, "task-two"), {
    command: "curl -H 'Authorization: Bearer example-secret-value-1234' /health",
  });
});

test("supports explicit blocking rules and isolated concurrent scopes", () => {
  const gate = createSecretGate({
    rules: [{ id: "internal-account", pattern: "account-[0-9]{4}", action: "block" }],
  });
  assert.throws(
    () =>
      gate.protect("account-1234", {
        scopeId: "blocked-task",
        destination: "model",
      }),
    /internal-account/u,
  );
  gate.protect({ password: "first-private-value" }, { scopeId: "first", destination: "model" });
  gate.protect({ password: "second-private-value" }, { scopeId: "second", destination: "model" });
  assert.deepEqual(gate.inspect(), { activeScopes: 2, retainedSecrets: 2 });
});

test("guards every model request without exposing retained secret values", async () => {
  let upstreamBody: unknown;
  const provider: ModelProvider = {
    descriptor: { type: "openai-compatible", model: "guard-test" },
    execute: async (request) => {
      upstreamBody = request.body;
      return { kind: "json", statusCode: 200, body: { ok: true } };
    },
  };
  const guarded = guardModelProvider(provider, createSecretGate());
  await guarded.execute({
    protocol: "chat-completions",
    virtualModelId: "managed-default",
    body: { apiKey: "non-production-secret-value" },
  });
  assert.doesNotMatch(JSON.stringify(upstreamBody), /non-production-secret-value/u);
});

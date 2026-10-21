import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultConfiguration,
  isValidModelIdentifier,
  MODEL_ROUTING_CAPABILITIES,
  validateConfiguration,
} from "./index.js";

test("publishes only capabilities implemented by request routing", () => {
  assert.deepEqual(MODEL_ROUTING_CAPABILITIES, [
    "text",
    "structured-output",
    "reasoning",
    "code",
    "vision",
    "tool-use",
    "long-context",
    "web-research",
  ]);
});

test("creates a safe managed configuration", () => {
  const configuration = createDefaultConfiguration();

  assert.equal(configuration.activeMode, "managed");
  assert.equal(configuration.activeProfileId, "ai-tidu9-config");
  assert.equal(configuration.virtualModelName, "九门赛博提督");
  assert.deepEqual(configuration.modelSelection, { source: "official", model: "current" });
  assert.equal(configuration.capabilityCompletion.enabled, false);
  assert.deepEqual(configuration.capabilityCompletion.mainCapabilities, [
    ...MODEL_ROUTING_CAPABILITIES,
  ]);
});

test("keeps managed and expert defaults isolated", () => {
  const managedConfiguration = createDefaultConfiguration("managed");
  const expertConfiguration = createDefaultConfiguration("expert");

  assert.equal(managedConfiguration.activeProfileId, "ai-tidu9-config");
  assert.equal(expertConfiguration.activeProfileId, "expert-default");
  assert.equal(expertConfiguration.activeMode, "expert");
});

test("accepts an explicit custom upstream source", () => {
  const configuration = {
    ...createDefaultConfiguration(),
    modelSelection: { source: "custom" as const, model: "private-model-v1" },
  };

  assert.equal(validateConfiguration(configuration).valid, true);
});

test("accepts published provider model identifiers with routing metadata", () => {
  const cursorModelId = "auto-smart[optimize_for=balanced]";
  assert.equal(isValidModelIdentifier(cursorModelId), true);
  assert.equal(
    isValidModelIdentifier("grok-4.7[context=256k,reasoning_effort=high,fast=true]"),
    true,
  );
  assert.equal(isValidModelIdentifier("provider/model:latest"), true);
  assert.equal(isValidModelIdentifier("model with spaces"), false);
  assert.equal(isValidModelIdentifier(""), false);

  const configuration = createDefaultConfiguration();
  assert.equal(
    validateConfiguration({
      ...configuration,
      capabilityCompletion: {
        ...configuration.capabilityCompletion,
        hostPolicies: {
          codex: {
            mainModel: { source: "official", model: "gpt-5.6-sol" },
            mainCapabilities: ["text"],
            specialists: [
              {
                host: "cursor",
                source: "official",
                model: cursorModelId,
                capabilities: ["code"],
              },
            ],
            maximumSpecialists: 1,
          },
        },
      },
    }).valid,
    true,
  );
});

test("rejects invalid or cross-mode configuration", () => {
  const configuration = {
    ...createDefaultConfiguration("expert"),
    activeMode: "managed" as const,
    virtualModelName: " ",
  };
  const result = validateConfiguration(configuration, "expert");

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.field),
    ["activeMode", "virtualModelName"],
  );
});

test("requires every specialist to use a different host from its primary", () => {
  const configuration = createDefaultConfiguration();
  const codexPolicy = {
    mainModel: { source: "official" as const, model: "current" },
    mainCapabilities: ["text"],
    specialists: [
      {
        host: "codex" as const,
        source: "official" as const,
        model: "gpt-6-sol",
        capabilities: ["reasoning"],
      },
    ],
    maximumSpecialists: 1,
  };

  const invalid = validateConfiguration({
    ...configuration,
    capabilityCompletion: {
      ...configuration.capabilityCompletion,
      hostPolicies: { codex: codexPolicy },
    },
  });
  const valid = validateConfiguration({
    ...configuration,
    capabilityCompletion: {
      ...configuration.capabilityCompletion,
      hostPolicies: {
        codex: {
          ...codexPolicy,
          specialists: [
            {
              host: "cursor" as const,
              source: "official" as const,
              model: "gpt-6-sol",
              capabilities: ["reasoning"],
            },
          ],
        },
      },
    },
  });

  assert.equal(invalid.valid, false);
  assert.equal(valid.valid, true);
});

test("allows different specialist models from one host and rejects an identical pair", () => {
  const configuration = createDefaultConfiguration();
  const specialist = {
    host: "cursor" as const,
    source: "official" as const,
    model: "auto",
    capabilities: ["code"],
  };
  const valid = validateConfiguration({
    ...configuration,
    capabilityCompletion: {
      ...configuration.capabilityCompletion,
      hostPolicies: {
        codex: {
          mainModel: { source: "official", model: "gpt-6-sol" },
          mainCapabilities: ["text"],
          specialists: [specialist, { ...specialist, model: "cursor-fast" }],
          maximumSpecialists: 2,
        },
      },
    },
  });

  const invalid = validateConfiguration({
    ...configuration,
    capabilityCompletion: {
      ...configuration.capabilityCompletion,
      hostPolicies: {
        codex: {
          mainModel: { source: "official", model: "gpt-6-sol" },
          mainCapabilities: ["text"],
          specialists: [specialist, { ...specialist }],
          maximumSpecialists: 2,
        },
      },
    },
  });

  assert.equal(valid.valid, true);
  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.issues.some((issue) => issue.field === "capabilityCompletion"),
    true,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultConfiguration, validateConfiguration } from "./index.js";

test("creates a safe managed configuration", () => {
  const configuration = createDefaultConfiguration();

  assert.equal(configuration.activeMode, "managed");
  assert.equal(configuration.activeProfileId, "ai-tidu9-config");
  assert.equal(configuration.virtualModelName, "九门赛博提督");
  assert.deepEqual(configuration.modelSelection, { source: "official", model: "current" });
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

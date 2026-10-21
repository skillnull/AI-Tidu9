import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROUTING_CAPABILITIES } from "../../src/config/index.js";

import {
  capabilityIdsForPicker,
  catalogNeedsConfiguredSpecialistRecovery,
  defaultModelCapabilities,
  resolveWizardAdvance,
  resolveWizardEntryState,
  selectableModelCapabilityIds,
  selectedModelCapabilities,
  updateCapabilityCompletionEnabled,
  updatePrimaryModelSelection,
  updateSpecialistModelSelection,
} from "./configuration-sections.js";
import { catalogModelName, modelDisplayName } from "./model-display.js";

test("shows the provider model name instead of its parameterized execution identifier", () => {
  const models = [
    {
      id: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
      name: "claude-opus-5-5",
      isDefault: true,
    },
  ];

  assert.equal(
    catalogModelName(models, "claude-opus-5-5[context=300k,effort=medium,fast=false]"),
    "claude-opus-5-5",
  );
  assert.equal(catalogModelName(models, "current"), "claude-opus-5-5");
  assert.equal(catalogModelName(models, "missing-model"), undefined);
  assert.equal(
    modelDisplayName({
      catalog: {
        companyConfigured: false,
        companyProviderType: null,
        company: [],
        official: [],
        hosts: {
          codex: { available: false, models: [] },
          cursor: { available: true, models },
          ollama: { available: false, models: [] },
          "openai-compatible": { available: false, models: [] },
        },
      },
      currentName: "Default",
      host: "cursor",
      selection: {
        source: "official",
        model: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
      },
    }),
    "claude-opus-5-5",
  );
  assert.equal(
    modelDisplayName({
      catalog: undefined,
      currentName: "Default",
      host: "cursor",
      selection: {
        source: "official",
        model: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
      },
    }),
    "claude-opus-5-5",
  );
  assert.equal(
    modelDisplayName({
      catalog: undefined,
      currentName: "Default",
      host: "cursor",
      selection: { source: "custom", model: "custom-model[variant=test]" },
    }),
    "custom-model[variant=test]",
  );
});

test("offers only capabilities implemented by the model-routing contract", () => {
  const capabilityIds: readonly string[] = selectableModelCapabilityIds;
  assert.deepEqual(selectableModelCapabilityIds, [
    "text",
    "structured-output",
    "reasoning",
    "code",
    "vision",
    "tool-use",
    "long-context",
    "web-research",
  ]);
  assert.deepEqual(selectableModelCapabilityIds, MODEL_ROUTING_CAPABILITIES);
  assert.equal(capabilityIds.includes("document-analysis"), false);
  assert.equal(capabilityIds.includes("domain-context"), false);
  assert.equal(capabilityIds.includes("local-private"), false);
});

test("offers only interface-published capabilities supported by the routing contract", () => {
  assert.deepEqual(capabilityIdsForPicker(["code", "text", "vision"]), ["text", "code", "vision"]);
  assert.deepEqual(capabilityIdsForPicker([]), []);
  assert.deepEqual(capabilityIdsForPicker(["document-analysis", "local-private"]), []);
});

test("defaults a model to all and only its interface-published capabilities", () => {
  assert.deepEqual(defaultModelCapabilities(["code", "text", "vision"]), [
    "text",
    "code",
    "vision",
  ]);
  assert.deepEqual(
    selectedModelCapabilities(
      ["text", "reasoning", "vision", "web-research"],
      ["text", "code", "vision"],
    ),
    ["text", "vision"],
  );
});

test("retries a transiently missing configured secondary-model catalog", () => {
  const specialist = {
    host: "cursor" as const,
    source: "official" as const,
    model: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
    capabilities: ["code"],
  };
  const catalog = {
    companyConfigured: false,
    companyProviderType: null,
    company: [],
    official: [],
    hosts: {
      codex: { available: true, models: [] },
      cursor: { available: false, models: [] },
      ollama: { available: false, models: [] },
      "openai-compatible": { available: false, models: [] },
    },
  };

  assert.equal(catalogNeedsConfiguredSpecialistRecovery(catalog, [specialist]), true);
  assert.equal(
    catalogNeedsConfiguredSpecialistRecovery(
      {
        ...catalog,
        hosts: {
          ...catalog.hosts,
          cursor: {
            available: true,
            models: [
              {
                id: specialist.model,
                name: "claude-opus-5-5",
                capabilities: ["text", "code"],
              },
            ],
          },
        },
      },
      [specialist],
    ),
    false,
  );
});

test("enabling or disabling capability completion preserves every saved model selection", () => {
  const policy = {
    mainModel: { source: "official" as const, model: "gpt-primary" },
    mainCapabilities: ["text"],
    specialists: [
      {
        host: "cursor" as const,
        source: "official" as const,
        model: "cursor-secondary",
        capabilities: ["code"],
      },
    ],
    maximumSpecialists: 2,
  };
  const configuration = {
    enabled: false,
    mainCapabilities: policy.mainCapabilities,
    specialists: policy.specialists,
    maximumSpecialists: policy.maximumSpecialists,
    hostPolicies: { codex: policy },
  };

  const enabled = updateCapabilityCompletionEnabled(configuration, true);
  const disabled = updateCapabilityCompletionEnabled(enabled, false);

  assert.deepEqual(enabled.mainCapabilities, ["text"]);
  assert.deepEqual(enabled.specialists[0]?.capabilities, ["code"]);
  assert.equal(enabled.maximumSpecialists, 2);
  assert.deepEqual(enabled.hostPolicies?.codex, policy);
  assert.deepEqual(disabled.mainCapabilities, ["text"]);
  assert.deepEqual(disabled.specialists[0]?.capabilities, ["code"]);
  assert.equal(disabled.maximumSpecialists, 2);
  assert.deepEqual(disabled.hostPolicies?.codex, policy);
});

test("changing a configured model replaces capabilities with the selected model catalog", () => {
  const policy = {
    mainModel: { source: "official" as const, model: "gpt-primary" },
    mainCapabilities: ["text"],
    specialists: [],
    maximumSpecialists: 2,
  };
  const specialist = {
    host: "cursor" as const,
    source: "official" as const,
    model: "cursor-primary",
    capabilities: ["code"],
    inputCostPerMillionTokens: null,
    outputCostPerMillionTokens: null,
  };

  const nextPolicy = updatePrimaryModelSelection(
    policy,
    {
      source: "custom",
      model: "custom-primary",
    },
    ["text", "vision"],
  );
  const nextSpecialist = updateSpecialistModelSelection(specialist, {
    host: "cursor",
    source: "official",
    model: "cursor-secondary",
    capabilities: ["text", "structured-output"],
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 2,
  });

  assert.deepEqual(nextPolicy.mainCapabilities, ["text", "vision"]);
  assert.deepEqual(nextSpecialist.capabilities, ["text", "structured-output"]);
});

test("opens a target-host editor without synthesizing or changing its policy", () => {
  const form = {
    activeProfileId: "ai-tidu9-config",
    virtualModelName: "九门赛博提督",
    modelSelection: { source: "official" as const, model: "gpt-primary" },
    capabilityCompletion: {
      enabled: true,
      mainCapabilities: ["text"],
      specialists: [],
      maximumSpecialists: 2,
      hostPolicies: {
        codex: {
          mainModel: { source: "official" as const, model: "gpt-primary" },
          mainCapabilities: ["text"],
          specialists: [],
          maximumSpecialists: 2,
        },
      },
    },
  };
  const originalForm = JSON.stringify(form);

  assert.deepEqual(resolveWizardEntryState("cursor", "tidu-router", "managed", form), {
    step: 2,
    providerChoice: "cursor-host",
    modelChoiceMode: "host",
  });
  assert.equal(JSON.stringify(form), originalForm);
  assert.equal("cursor" in form.capabilityCompletion.hostPolicies, false);
});

test("saves a dirty editable step before advancing", async () => {
  let saveCount = 0;
  const nextStep = await resolveWizardAdvance({
    step: 2,
    stepCount: 5,
    canAdvance: true,
    isDirty: true,
    onSave: async () => {
      saveCount += 1;
      return true;
    },
  });

  assert.equal(saveCount, 1);
  assert.equal(nextStep, 3);
});

test("stays on the current step when saving a dirty draft fails", async () => {
  let saveCount = 0;
  const nextStep = await resolveWizardAdvance({
    step: 1,
    stepCount: 5,
    canAdvance: true,
    isDirty: true,
    onSave: async () => {
      saveCount += 1;
      return false;
    },
  });

  assert.equal(saveCount, 1);
  assert.equal(nextStep, 1);
});

test("advances without saving when the draft is unchanged", async () => {
  let saveCount = 0;
  const nextStep = await resolveWizardAdvance({
    step: 2,
    stepCount: 5,
    canAdvance: true,
    isDirty: false,
    onSave: async () => {
      saveCount += 1;
      return true;
    },
  });

  assert.equal(saveCount, 0);
  assert.equal(nextStep, 3);
});

test("does not save or advance when the current step is invalid", async () => {
  let saveCount = 0;
  const nextStep = await resolveWizardAdvance({
    step: 2,
    stepCount: 5,
    canAdvance: false,
    isDirty: true,
    onSave: async () => {
      saveCount += 1;
      return true;
    },
  });

  assert.equal(saveCount, 0);
  assert.equal(nextStep, 2);
});

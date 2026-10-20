import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityIdsForPicker,
  defaultCapabilitiesForModel,
  resolveWizardAdvance,
  resolveWizardEntryState,
  selectableModelCapabilityIds,
} from "./configuration-sections.js";

test("offers only capabilities implemented by the model-routing contract", () => {
  const capabilityIds: readonly string[] = selectableModelCapabilityIds;
  assert.deepEqual(selectableModelCapabilityIds, [
    "text",
    "structured-output",
    "reasoning",
    "code",
    "vision",
    "web-research",
    "tool-use",
    "long-context",
  ]);
  assert.equal(capabilityIds.includes("document-analysis"), false);
  assert.equal(capabilityIds.includes("domain-context"), false);
  assert.equal(capabilityIds.includes("local-private"), false);
});

test("keeps saved manual capabilities visible without offering unsupported capabilities", () => {
  assert.deepEqual(capabilityIdsForPicker(["code"], ["text"]), ["text", "code"]);
  assert.deepEqual(capabilityIdsForPicker([], ["document-analysis"]), []);
  assert.deepEqual(capabilityIdsForPicker(["document-analysis"], ["text", "document-analysis"]), [
    "text",
    "document-analysis",
  ]);
});

test("defaults a newly selected secondary model to every published capability", () => {
  const publishedCapabilities = ["text", "structured-output", "code", "tool-use"];

  assert.deepEqual(
    defaultCapabilitiesForModel({ capabilities: publishedCapabilities }),
    publishedCapabilities,
  );
});

test("does not invent capabilities when a model publishes no capability metadata", () => {
  assert.deepEqual(defaultCapabilitiesForModel(undefined), []);
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

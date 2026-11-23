import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_ROUTING_CAPABILITIES } from "../../src/config/index.js";
import { HostUsagePanel, type HostUsageSnapshot } from "./components/host-usage-panel.js";

import {
  CapabilityCallUsage,
  capabilityCompletionModelOutcomeLabel,
  capabilityCompletionOutcomeLabel,
  capabilityCompletionRecordOutcomeLabel,
  capabilityHistoryModelName,
  capabilityIdsForPicker,
  capabilityModelUsage,
  catalogNeedsConfiguredSpecialistRecovery,
  defaultModelCapabilities,
  normalizeCapabilityCompletionCancellation,
  resolveWizardAdvance,
  resolveWizardEntryState,
  SplitVisionUsageNote,
  selectableModelCapabilityIds,
  selectedModelCapabilities,
  updateCapabilityCompletionEnabled,
  updatePrimaryModelSelection,
  updateSpecialistModelSelection,
} from "./configuration-sections.js";
import { catalogModelName, modelDisplayName } from "./model-display.js";

test("shows real quota, zero reset credits, and unavailable fields in both languages", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const snapshot: HostUsageSnapshot = {
      activeProvider: null,
      codex: {
        account: null,
        usage: {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
          secondary: null,
          availableResetCredits: 0,
          creditBalance: null,
          lifetimeTokens: null,
          dailyTokens: [],
        },
      },
      cursor: {
        agentStatus: "unavailable",
        agentProtocolAvailable: false,
        accountEmail: null,
        accountPlan: null,
        model: null,
      },
    };
    const render = () =>
      renderToStaticMarkup(
        HostUsagePanel({
          state: { status: "ready", snapshot },
          locale,
          modelCatalog: undefined,
          onRefresh: () => undefined,
          onConnectCursor: () => undefined,
          connectingCursor: false,
          cursorConnectionError: null,
        }),
      );
    assert.match(render(), /75\.0%/u);
    assert.match(render(), locale === "zh-CN" ? /可用重置次数：0/u : /Available resets：0/u);
    if (snapshot.codex?.usage) snapshot.codex.usage.availableResetCredits = null;
    assert.match(
      render(),
      locale === "zh-CN"
        ? /可用重置次数：官方接口未提供/u
        : /Available resets：Not reported by the official API/u,
    );
  }
});

test("distinguishes cancellation from failure in both usage-history languages", () => {
  assert.equal(capabilityCompletionOutcomeLabel("cancelled", false), "已取消");
  assert.equal(capabilityCompletionOutcomeLabel("cancelled", true), "Cancelled");
  assert.equal(capabilityCompletionOutcomeLabel("failed", false), "失败");
  assert.equal(capabilityCompletionOutcomeLabel("not-run", true), "Not called");
});

test("renders repeated model calls in order and distinguishes partial, unknown, and zero usage", () => {
  const reader = {
    modelId: "secondary",
    host: "codex" as const,
    role: "secondary" as const,
    executionRole: "verification" as const,
    model: "configured-reader",
    executedModel: null,
    capabilities: ["vision"],
    outcome: "failed" as const,
    usage: null,
  };
  const writer = {
    ...reader,
    modelId: "primary",
    host: "cursor" as const,
    role: "main" as const,
    executionRole: "main" as const,
    model: "configured-writer",
    executedModel: "confirmed-writer",
    capabilities: ["text", "reasoning"],
    outcome: "succeeded" as const,
    usage: {
      inputTokens: 17,
      freshInputTokens: 10,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      outputTokens: 9,
      reasoningTokens: 3,
      totalTokens: 26,
    },
  };
  const retry = { ...writer, outcome: "cancelled" as const, usage: null };
  const zero = {
    ...writer,
    usage: {
      inputTokens: 0,
      freshInputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 0,
      reasoningTokens: null,
      totalTokens: 0,
    },
  };
  const observation = {
    calls: [reader, writer, retry, zero],
    measuredTotalTokens: 26,
    complete: false,
  };
  const record = { observation, tokenUsage: null, modelTokenUsage: [] };
  assert.deepEqual(capabilityModelUsage(record, "primary"), {
    usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 },
    partial: true,
  });
  assert.deepEqual(capabilityModelUsage(record, "secondary"), { usage: undefined, partial: false });
  for (const english of [false, true]) {
    const render = (observed: typeof observation | undefined) =>
      renderToStaticMarkup(
        CapabilityCallUsage({ record: { tokenUsage: null, observation: observed }, english }),
      );
    const markup = render(observation);
    assert.equal(markup.match(/<li>/gu)?.length, 4);
    assert.ok(markup.indexOf("configured-reader") < markup.indexOf("configured-writer"));
    assert.match(
      markup,
      english ? /Reported subtotal \(partial\) 26/u : /已报告小计（部分调用） 26/u,
    );
    assert.match(markup, english ? /Unconfirmed/u : /未确认/u);
    assert.match(markup, english ? /Cancelled/u : /已取消/u);
    assert.match(markup, english ? /verification/u : /验证/u);
    assert.match(markup, english ? /Cache read 5 · Cache write 2/u : /缓存读取 5 · 缓存写入 2/u);
    assert.match(markup, english ? /including reasoning 3/u : /含推理 3/u);
    assert.match(markup, english ? /Cache read Unknown/u : /缓存读取 未知/u);
    const allMissing = { ...observation, calls: [reader], measuredTotalTokens: null };
    const missing = renderToStaticMarkup(
      CapabilityCallUsage({ record: { tokenUsage: null, observation: allMissing }, english }),
    );
    assert.match(missing, english ? /Total tokens Unknown/u : /整次 Token 合计 未知/u);
    assert.doesNotMatch(missing, /(?:Total tokens|合计) 0/u);
    const noCalls = render({ ...observation, calls: [], measuredTotalTokens: 0, complete: true });
    assert.match(noCalls, english ? /Total tokens 0/u : /整次 Token 合计 0/u);
    assert.match(noCalls, english ? /No model calls/u : /未发起模型调用/u);
    const older = render(undefined);
    assert.doesNotMatch(older, /<details/u);
    assert.match(older, english ? /Not retrieved/u : /未获取到/u);
  }
});

test("shows actual historical outcomes during tool handoffs", () => {
  const waitingResult = {
    modelId: "secondary",
    host: "cursor" as const,
    model: "fixture",
    executedModel: null,
    role: "secondary" as const,
    capabilities: [],
    outcome: "not-run" as const,
    skipReason: "awaiting-tool-results" as const,
    statusCode: null,
    durationMilliseconds: null,
    message: "Waiting for the client to execute a tool and return its result.",
  };
  assert.equal(capabilityCompletionModelOutcomeLabel(waitingResult, false), "未调用");
  assert.equal(capabilityCompletionModelOutcomeLabel(waitingResult, true), "Not called");
  assert.equal(
    capabilityCompletionRecordOutcomeLabel(
      { outcome: "succeeded", mainResult: waitingResult, secondaryResults: [] },
      false,
    ),
    "成功",
  );
});

test("corrects older cancellation records while retaining genuine model failures", () => {
  const modelResult = {
    modelId: "main",
    host: "codex" as const,
    model: "fixture",
    executedModel: null,
    role: "main" as const,
    capabilities: [],
    outcome: "failed" as const,
    statusCode: null,
    durationMilliseconds: 150_974,
    message: "Codex turn cancelled.",
  };
  const record = {
    host: "codex" as const,
    occurredAt: "2026-01-01T00:00:00Z",
    role: "worker",
    complemented: true,
    outcome: "failed" as const,
    mainModelId: "main",
    specialistModelIds: ["secondary"],
    requiredCapabilities: ["text"],
    missingCapabilities: [],
    reason: "capability-gap" as const,
    mainResult: modelResult,
    secondaryResults: [
      {
        ...modelResult,
        modelId: "secondary",
        outcome: "not-run" as const,
        skipReason: "blocked-by-failure" as const,
        message: "Selected but not called",
      },
    ],
    tokenUsage: null,
    modelTokenUsage: [],
  };
  const normalized = normalizeCapabilityCompletionCancellation(record);
  assert.equal(normalized.outcome, "cancelled");
  assert.equal(normalized.mainResult.outcome, "cancelled");
  assert.equal(normalized.mainResult.durationMilliseconds, 150_974);
  assert.equal(normalized.secondaryResults[0]?.skipReason, "blocked-by-cancellation");
  assert.equal(record.mainResult.outcome, "failed");
  const failed = normalizeCapabilityCompletionCancellation({
    ...record,
    secondaryResults: [{ ...modelResult, modelId: "secondary", message: "Upstream failed." }],
  });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.secondaryResults[0]?.outcome, "failed");
});

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

test("keeps historical execution models when the current default changes", () => {
  const currentModel = { id: "new-default", name: "New default model", isDefault: true };
  const catalog = {
    companyConfigured: false,
    companyProviderType: null,
    company: [],
    official: [currentModel],
    hosts: {
      codex: { available: true, models: [currentModel] },
      cursor: { available: false, models: [] },
      ollama: { available: false, models: [] },
      "openai-compatible": { available: false, models: [] },
    },
  };
  const result = {
    modelId: "main:codex:official",
    host: "codex" as const,
    model: "current",
    executedModel: "historical-model",
  };
  for (const english of [false, true]) {
    assert.equal(capabilityHistoryModelName(result, catalog, english), "historical-model");
    assert.equal(capabilityHistoryModelName(result, undefined, english), "historical-model");
    assert.equal(
      capabilityHistoryModelName({ ...result, executedModel: null }, catalog, english),
      "New default model",
    );
    assert.equal(
      capabilityHistoryModelName(
        { ...result, model: "configured-model", executedModel: null },
        undefined,
        english,
      ),
      "configured-model",
    );
  }
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

test("shows every host-published capability verbatim and in provider order", () => {
  assert.deepEqual(capabilityIdsForPicker(["code", "text", "vision"]), ["code", "text", "vision"]);
  assert.deepEqual(capabilityIdsForPicker([]), []);
  assert.deepEqual(
    capabilityIdsForPicker(["document-analysis", "local-private", "document-analysis"]),
    ["document-analysis", "local-private", "document-analysis"],
  );
});

test("defaults a model to the host-published capability order without pruning", () => {
  assert.deepEqual(defaultModelCapabilities(["code", "text", "vision"]), [
    "code",
    "text",
    "vision",
  ]);
  assert.deepEqual(
    selectedModelCapabilities(
      ["vision", "reasoning", "text", "web-research"],
      ["text", "code", "vision"],
    ),
    ["vision", "text"],
  );
  assert.deepEqual(selectedModelCapabilities([], ["text", "code", "vision"]), []);
});

test("shows the token cost note in both languages only when selected models must split text and vision", () => {
  const writer = {
    host: "cursor" as const,
    source: "official" as const,
    model: "writer",
    capabilities: ["text"],
  };
  const reader = { ...writer, model: "reader", capabilities: ["vision"] };
  const policy = {
    mainModel: { source: "official" as const, model: "primary" },
    mainCapabilities: ["vision"],
    maximumSpecialists: 1,
    specialists: [writer],
  };
  for (const english of [false, true]) {
    const renderNote = (selection: typeof policy) =>
      renderToStaticMarkup(SplitVisionUsageNote({ policy: selection, english }));
    const splitNote = renderNote(policy);
    assert.match(
      splitNote,
      english ? /Both count toward the token total/u : /两端实际用量都计入总 Token/u,
    );
    assert.match(splitNote, english ? /reuse an earlier draft/u : /改稿可复用前文/u);
    assert.match(
      splitNote,
      english
        ? /new image, an explicit recheck, or a missing visual detail/u
        : /新增图片、明确要求复核或缺少视觉细节/u,
    );
    assert.match(splitNote, english ? /If a model supports both/u : /若同一模型支持这两项能力/u);
    assert.equal(renderNote({ ...policy, mainCapabilities: ["vision", "text"] }), "");
    assert.equal(
      renderNote({ ...policy, specialists: [{ ...reader, capabilities: ["text", "vision"] }] }),
      "",
    );
    assert.equal(renderNote({ ...policy, specialists: [] }), "");
    assert.equal(renderNote({ ...policy, specialists: [{ ...writer, model: "" }] }), "");
    const secondaryOnly = {
      ...policy,
      mainCapabilities: [],
      specialists: [...policy.specialists, reader],
    };
    assert.equal(renderNote(secondaryOnly), "");
    assert.equal(renderNote({ ...secondaryOnly, maximumSpecialists: 2 }), splitNote);
  }
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
  assert.deepEqual(
    updatePrimaryModelSelection(
      policy,
      { source: "custom", model: "custom-primary-with-no-assignment" },
      [],
    ).mainCapabilities,
    [],
  );
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

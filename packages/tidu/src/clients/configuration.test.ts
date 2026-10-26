import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TiduError } from "../core/index.js";
import { startLocalRuntime } from "../runtime/index.js";
import {
  configureCodexClient,
  inspectCodexClientConfiguration,
  listCodexOfficialModels,
  refreshCodexClientModelCatalog,
  removeCodexClientConfiguration,
  rollbackCodexClientConfiguration,
  switchCodexClientConfiguration,
} from "./configuration.js";

const writeOfficialModelCache = (codexHomeDirectory: string): void => {
  writeFileSync(
    join(codexHomeDirectory, "models_cache.json"),
    JSON.stringify({
      models: [
        {
          slug: "user-default",
          display_name: "Official Default",
          description: "Official Codex model",
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "medium" }],
          supports_search_tool: true,
          tool_mode: "code_mode_only",
          context_window: 128000,
          visibility: "list",
          supported_in_api: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
};

test("lists current and retained official Codex models without managed entries", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-model-list-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeOfficialModelCache(codexHomeDirectory);
    writeFileSync(
      join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"),
      JSON.stringify({
        models: [
          {
            slug: "user-default",
            display_name: "Stale duplicate",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "gpt-retained",
            display_name: "Retained official model",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "ai-tidu9-config",
            display_name: "AI-Tidu9",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "company-model",
            display_name: "Company model",
            description: "Company service model: example",
            visibility: "list",
            supported_in_api: true,
          },
        ],
      }),
      { mode: 0o600 },
    );

    assert.deepEqual(listCodexOfficialModels(codexHomeDirectory), [
      {
        id: "user-default",
        name: "Official Default",
        capabilities: [
          "text",
          "structured-output",
          "vision",
          "reasoning",
          "code",
          "tool-use",
          "web-research",
          "long-context",
        ],
        capabilitySource: "host-catalog",
      },
      {
        id: "gpt-retained",
        name: "Retained official model",
        capabilities: [],
        capabilitySource: "host-catalog",
      },
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("writes an isolated Codex profile and switches back to the official configuration", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-config-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
  });

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(defaultConfiguration, 'model = "user-default"\n', {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    writeOfficialModelCache(codexHomeDirectory);
    const result = await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    const profilePath = join(codexHomeDirectory, "ai-tidu9.config.toml");
    const profile = readFileSync(profilePath, "utf8");

    assert.equal(result.status, "configured");
    assert.equal(result.model, "ai-tidu9-config");
    assert.match(profile, /model_provider = "ai_tidu9"/u);
    assert.match(profile, /requires_openai_auth = false/u);
    assert.match(profile, /name = "AI-Tidu9 \(local\)"/u);
    assert.match(profile, /request_max_retries = 0/u);
    assert.match(profile, /stream_max_retries = 0/u);
    assert.match(profile, new RegExp(`base_url = "${runtime.origin}/v1/hosts/codex"`, "u"));
    assert.doesNotMatch(profile, /api[_-]?key|token|secret/iu);
    const activeDefaultConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.equal(activeDefaultConfiguration, 'model = "user-default"\n');
    const configuredStatus = inspectCodexClientConfiguration({
      codexHomeDirectory,
    });
    assert.equal(configuredStatus.activeMode, "official");
    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as {
      models: {
        slug: string;
        apply_patch_tool_type?: string | null;
        default_reasoning_summary?: string;
        input_modalities?: readonly string[];
        supports_image_detail_original?: boolean;
        supports_parallel_tool_calls?: boolean;
        supports_search_tool?: boolean;
        support_verbosity?: boolean;
        web_search_tool_type?: string;
      }[];
    };
    assert.deepEqual(
      catalog.models.map(({ slug }) => slug),
      ["ai-tidu9-config"],
    );
    assert.equal(catalog.models[0]?.default_reasoning_summary, "auto");
    assert.deepEqual(catalog.models[0]?.input_modalities, ["text", "image"]);
    assert.equal(catalog.models[0]?.supports_image_detail_original, true);
    assert.equal(catalog.models[0]?.supports_parallel_tool_calls, true);
    assert.equal(catalog.models[0]?.supports_search_tool, true);
    assert.equal(catalog.models[0]?.support_verbosity, true);
    assert.equal(catalog.models[0]?.apply_patch_tool_type, "freeform");
    assert.equal(catalog.models[0]?.web_search_tool_type, "text_and_image");

    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/hosts/codex/responses") && init?.method === "POST") {
          assert.equal(init.signal, undefined);
          assert.match(readFileSync(defaultConfiguration, "utf8"), /model_provider = "ai_tidu9"/u);
          return Response.json({
            id: "verified",
            object: "response",
            output: [],
          });
        }
        return fetch(input, init);
      },
    });
    const tiduDefaultConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.match(tiduDefaultConfiguration, /model = "ai-tidu9-config"/u);
    assert.match(tiduDefaultConfiguration, /model_provider = "ai_tidu9"/u);
    assert.match(tiduDefaultConfiguration, /\[model_providers\.ai_tidu9\]/u);
    assert.match(tiduDefaultConfiguration, /name = "AI-Tidu9 \(local\)"/u);
    assert.match(tiduDefaultConfiguration, /request_max_retries = 0/u);
    assert.match(tiduDefaultConfiguration, /stream_max_retries = 0/u);
    assert.doesNotMatch(tiduDefaultConfiguration, /requires_openai_auth = true/u);

    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    assert.equal(inspectCodexClientConfiguration({ codexHomeDirectory }).activeMode, "official");
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "user-default"\n');

    const rollback = rollbackCodexClientConfiguration({ codexHomeDirectory });
    assert.equal(rollback.status, "restored");
    assert.equal(existsSync(profilePath), false);
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "user-default"\n');
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("keeps company service models behind the single virtual-model catalog entry", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-company-catalog-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    provider: {
      descriptor: { type: "openai-compatible", model: "corp-model-v2" },
      execute: async () => ({
        kind: "json",
        statusCode: 200,
        body: { output: [] },
      }),
    },
  });
  try {
    await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as {
      models: {
        slug: string;
        display_name: string;
        default_reasoning_level?: string;
        supported_reasoning_levels?: readonly { effort: string }[];
      }[];
    };
    assert.deepEqual(
      catalog.models.map(({ slug }) => slug),
      ["ai-tidu9-config"],
    );
    assert.equal(catalog.models[0]?.display_name, "AI-Tidu9");
    assert.equal(catalog.models[0]?.default_reasoning_level, undefined);
    assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, []);
    const serializedCatalog = JSON.stringify(catalog);
    assert.doesNotMatch(serializedCatalog, /routed through AI-Tidu9/iu);
    assert.doesNotMatch(serializedCatalog, /\[AI-TIDU9\] Loaded/iu);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("publishes reasoning strength only for an executable Codex primary provider", async () => {
  const readCatalogForProvider = async (providerType: string) => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-reasoning-catalog-"));
    const codexHomeDirectory = join(temporaryDirectory, ".codex");
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({ product: "九门赛博提督", status: "ok" });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [
            {
              id: "ai-tidu9-config",
              display_name: "九门赛博提督",
              owned_by: "AI-Tidu9",
            },
          ],
        });
      }
      if (url.endsWith("/api/capability-completion")) {
        return Response.json({
          activeHost: "codex",
          available: true,
          codexReasoningEffortSupported: providerType === "codex-host",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      await configureCodexClient({
        endpoint: "http://127.0.0.1:9639",
        codexHomeDirectory,
        request,
      });
      return JSON.parse(
        readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
      ) as {
        models: {
          default_reasoning_level?: string;
          supported_reasoning_levels?: readonly { effort: string }[];
        }[];
      };
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  };

  const codexCatalog = await readCatalogForProvider("codex-host");
  assert.equal(codexCatalog.models[0]?.default_reasoning_level, "medium");
  assert.deepEqual(
    codexCatalog.models[0]?.supported_reasoning_levels?.map(({ effort }) => effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );

  for (const providerType of ["cursor-host", "ollama", "openai-compatible"]) {
    const catalog = await readCatalogForProvider(providerType);
    assert.equal(catalog.models[0]?.default_reasoning_level, undefined);
    assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, []);
  }
});

test("refreshes reasoning strength metadata when entering AI-Tidu9 mode", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-reasoning-refresh-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  let activeProviderType = "codex-host";
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ product: "九门赛博提督", status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({
        object: "list",
        data: [
          {
            id: "ai-tidu9-config",
            display_name: "九门赛博提督",
            owned_by: "AI-Tidu9",
          },
        ],
      });
    }
    if (url.endsWith("/api/capability-completion")) {
      return Response.json({
        activeHost: "codex",
        available: true,
        codexReasoningEffortSupported: activeProviderType === "codex-host",
      });
    }
    if (url.endsWith("/v1/hosts/codex/responses")) {
      return Response.json({ id: "verified", object: "response", output: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      request,
    });
    activeProviderType = "cursor-host";
    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request,
    });
    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as {
      models: {
        default_reasoning_level?: string;
        supported_reasoning_levels?: readonly { effort: string }[];
      }[];
    };
    assert.equal(catalog.models[0]?.default_reasoning_level, undefined);
    assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("refreshes reasoning strength metadata after the active provider changes", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-reasoning-provider-change-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  let activeHost = "codex";
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ product: "九门赛博提督", status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      return Response.json({
        object: "list",
        data: [
          {
            id: "ai-tidu9-config",
            display_name: "九门赛博提督",
            owned_by: "AI-Tidu9",
          },
        ],
      });
    }
    if (url.endsWith("/api/capability-completion")) {
      return Response.json({
        activeHost: "codex",
        available: true,
        codexReasoningEffortSupported: activeHost === "codex",
      });
    }
    if (url.endsWith("/v1/hosts/codex/responses")) {
      return Response.json({ id: "verified", object: "response", output: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      request,
    });
    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request,
    });
    const defaultConfigurationPath = join(codexHomeDirectory, "config.toml");
    const activeConfiguration = readFileSync(defaultConfigurationPath, "utf8");

    activeHost = "cursor";
    const status = await refreshCodexClientModelCatalog({
      codexHomeDirectory,
      request,
    });
    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as {
      models: {
        default_reasoning_level?: string;
        supported_reasoning_levels?: readonly { effort: string }[];
      }[];
    };

    assert.equal(status.activeMode, "ai-tidu9");
    assert.equal(readFileSync(defaultConfigurationPath, "utf8"), activeConfiguration);
    assert.equal(catalog.models[0]?.default_reasoning_level, undefined);
    assert.deepEqual(catalog.models[0]?.supported_reasoning_levels, []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("does not refresh an inactive optional Codex profile", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-inactive-catalog-refresh-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  let requestCount = 0;

  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const catalogPath = join(codexHomeDirectory, ".ai-tidu9-model-catalog.json");
    const originalCatalog = readFileSync(catalogPath, "utf8");
    const status = await refreshCodexClientModelCatalog({
      codexHomeDirectory,
      request: async () => {
        requestCount += 1;
        throw new Error("Inactive profiles must not contact the runtime.");
      },
    });

    assert.equal(status.activeMode, "official");
    assert.equal(requestCount, 0);
    assert.equal(readFileSync(catalogPath, "utf8"), originalCatalog);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("does not duplicate an unchanged managed Codex profile", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-update-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
  });

  try {
    const first = await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    const profilePath = join(codexHomeDirectory, "ai-tidu9.config.toml");
    const second = await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    assert.equal(second.backupId, first.backupId);
    const rollback = rollbackCodexClientConfiguration({ codexHomeDirectory });

    assert.equal(rollback.status, "restored");
    assert.equal(existsSync(profilePath), false);
    assert.equal(existsSync(join(codexHomeDirectory, "config.toml")), false);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("retains only the original baseline and latest managed Codex snapshot", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-retention-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");

  try {
    const first = await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9640",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const latest = await configureCodexClient({
      endpoint: "http://127.0.0.1:9641",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const snapshotIds = readdirSync(join(codexHomeDirectory, ".ai-tidu9-backups")).sort();

    assert.deepEqual(snapshotIds.sort(), [first.backupId, latest.backupId].sort());
    const state = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json"), "utf8"),
    ) as { backupId: string; originalBackupId: string };
    assert.equal(state.originalBackupId, first.backupId);
    assert.equal(state.backupId, latest.backupId);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("keeps the native AI-Tidu9 catalog isolated from changing official model caches", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-catalog-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
  });
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(
      join(codexHomeDirectory, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "official-current",
            display_name: "Official Current",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "official-newer",
            display_name: "Official Newer",
            visibility: "list",
            supported_in_api: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    writeOfficialModelCache(codexHomeDirectory);
    await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });

    const catalog = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"), "utf8"),
    ) as { models: { slug: string }[] };
    assert.deepEqual(
      catalog.models.map(({ slug }) => slug),
      ["ai-tidu9-config"],
    );
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("removes only AI-Tidu9-owned Codex profile artifacts", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-remove-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const unrelatedFile = join(codexHomeDirectory, "config.toml");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
  });

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(unrelatedFile, "preserve = true\n", { mode: 0o600 });
    await configureCodexClient({
      endpoint: runtime.origin,
      codexHomeDirectory,
    });
    assert.match(readFileSync(unrelatedFile, "utf8"), /preserve = true/u);
    writeFileSync(
      unrelatedFile,
      `${readFileSync(unrelatedFile, "utf8")}\n[notice]\nkeep = true\n`,
      { mode: 0o600 },
    );
    const result = removeCodexClientConfiguration({ codexHomeDirectory });
    assert.equal(result.status, "removed");
    assert.equal(result.removedArtifactCount, 4);
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-backups")), false);
    const restoredConfiguration = readFileSync(unrelatedFile, "utf8");
    assert.match(restoredConfiguration, /preserve = true/u);
    assert.match(restoredConfiguration, /\[notice\]\nkeep = true/u);
    assert.doesNotMatch(restoredConfiguration, /ai_tidu9/u);
    assert.equal(removeCodexClientConfiguration({ codexHomeDirectory }).status, "missing");
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("automatically rolls back when post-write connectivity verification fails", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-failure-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  let requestCount = 0;
  const request: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json({ product: "九门赛博提督", status: "ok" });
    }
    if (requestCount === 2) {
      return Response.json({
        object: "list",
        data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
      });
    }
    throw new Error("simulated disconnect");
  };

  try {
    await assert.rejects(
      configureCodexClient({
        endpoint: "http://127.0.0.1:9639",
        codexHomeDirectory,
        request,
      }),
      /configured AI-Tidu9 service cannot be reached/u,
    );
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json")), false);
    assert.equal(rollbackCodexClientConfiguration({ codexHomeDirectory }).status, "missing");
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("keeps the official configuration active when inference verification fails", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-probe-failure-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(defaultConfiguration, 'model = "official-model"\n', {
      mode: 0o600,
    });
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({ product: "九门赛博提督", status: "ok" });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
        });
      }
      assert.match(readFileSync(defaultConfiguration, "utf8"), /model_provider = "ai_tidu9"/u);
      return Response.json(
        {
          error: {
            message: "official probe rejected.",
          },
        },
        { status: 400 },
      );
    };

    await assert.rejects(
      switchCodexClientConfiguration({
        mode: "ai-tidu9",
        codexHomeDirectory,
        request,
      }),
      (error: unknown) => {
        assert.equal(error instanceof TiduError, true);
        if (!(error instanceof TiduError)) return false;
        assert.equal(error.details.failureSource, "ai-tidu9");
        assert.equal(error.details.reasonCode, "tidu_inference_failed");
        assert.match(String(error.details.reason), /official probe rejected/u);
        assert.equal(Array.isArray(error.details.nextSteps), true);
        return true;
      },
    );
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "official-model"\n');
    assert.equal(inspectCodexClientConfiguration({ codexHomeDirectory }).activeMode, "official");
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("attributes an official Codex inference failure and keeps official mode active", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-official-failure-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(defaultConfiguration, 'model = "official-model"\n', {
      mode: 0o600,
    });
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({ product: "九门赛博提督", status: "ok" });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
        });
      }
      assert.match(readFileSync(defaultConfiguration, "utf8"), /model_provider = "ai_tidu9"/u);
      return Response.json(
        {
          error: {
            code: "provider_request_failed",
            failure_source: "official-codex",
            message: "Failure source: Official Codex. Reason: official session expired.",
            next_steps: ["Run 'codex login status'."],
          },
        },
        { status: 502 },
      );
    };

    await assert.rejects(
      switchCodexClientConfiguration({
        mode: "ai-tidu9",
        codexHomeDirectory,
        request,
      }),
      (error: unknown) => {
        assert.equal(error instanceof TiduError, true);
        if (!(error instanceof TiduError)) return false;
        assert.equal(error.details.failureSource, "official-codex");
        assert.equal(error.details.reasonCode, "provider_request_failed");
        assert.deepEqual(error.details.nextSteps, ["Run 'codex login status'."]);
        return true;
      },
    );
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "official-model"\n');
    assert.equal(inspectCodexClientConfiguration({ codexHomeDirectory }).activeMode, "official");
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("refuses to overwrite an unmanaged dedicated profile", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-conflict-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
  });

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(join(codexHomeDirectory, "ai-tidu9.config.toml"), "user-owned-content\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await assert.rejects(
      configureCodexClient({ endpoint: runtime.origin, codexHomeDirectory }),
      /unmanaged or incomplete/u,
    );
    assert.equal(
      readFileSync(join(codexHomeDirectory, "ai-tidu9.config.toml"), "utf8"),
      "user-owned-content\n",
    );
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-backups")), false);
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

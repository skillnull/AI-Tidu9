import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexActiveSelection } from "../connectors/codex-client-proxy.js";
import { createStdioJsonRpcClient } from "../connectors/json-rpc.js";
import { PRODUCT, TiduError } from "../core/index.js";
import { startLocalRuntime } from "../runtime/index.js";
import { refreshManagedCodexCatalog } from "./codex-model-catalog.js";
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

const successfulConfigurationRequest: typeof fetch = async (input) =>
  Response.json(
    String(input).endsWith("/health")
      ? { product: PRODUCT.name, status: "ok" }
      : String(input).endsWith("/v1/models")
        ? { data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }] }
        : { codexReasoningEffortSupported: false },
  );

test("inherits current harness metadata without changing execution declarations across 80 catalog combinations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-harness-catalog-"));
  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    const catalogPath = join(directory, ".ai-tidu9-model-catalog.json");
    const statePath = join(directory, ".ai-tidu9-profile-state.json");
    const cachePath = join(directory, "models_cache.json");
    const baseline = JSON.parse(readFileSync(catalogPath, "utf8"));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    let verified = 0;
    for (const hostVersion of ["0.167.0-alpha.3.2", "0.163.0"])
      for (const cacheKind of ["valid", "missing", "invalid", "unversioned", "symlink"])
        for (const selected of ["official-a", "official-b"])
          for (const reasoning of [false, true])
            for (const extraCapability of [false, true]) {
              const ownEntry = {
                ...baseline.models[0],
                context_window: 8192,
                max_context_window: 8192,
                input_modalities: ["text"],
                supports_search_tool: false,
                supports_parallel_tool_calls: false,
                supported_reasoning_levels: reasoning ? [{ effort: "medium" }] : [],
                ...(reasoning ? { default_reasoning_level: "medium" } : {}),
              };
              const managed = `${JSON.stringify({ models: [ownEntry] }, null, 2)}\n`;
              writeFileSync(catalogPath, managed);
              writeFileSync(statePath, JSON.stringify({ ...state, officialModel: selected }));
              if (existsSync(cachePath)) rmSync(cachePath);
              const models = ["official-a", "official-b"].map((slug) => ({
                slug,
                display_name: slug,
                visibility: "list",
                supported_in_api: true,
                tool_mode: slug === "official-a" ? "code_mode_only" : null,
                multi_agent_version: slug === "official-a" ? "v2" : null,
                shell_type: "unified_exec",
                apply_patch_tool_type: "freeform",
                include_plugin_usage_instructions: true,
                include_future_runtime_usage_instructions: true,
                node_repl_auto_review_required: slug === "official-a",
                node_repl_disabled: slug === "official-b",
                base_instructions: `Official ${slug}`,
                model_messages: {
                  ...ownEntry.model_messages,
                  instructions_template: `Template ${slug}`,
                  future_protocol_section: { selected: slug, revision: 1 },
                  permissions: { required: true },
                },
                input_modalities: ["text", "image", "audio"],
                context_window: 872000,
                supported_reasoning_levels: [{ effort: "ultra" }],
                supports_future_superpower: extraCapability,
              }));
              const source = {
                ...(cacheKind === "unversioned" ? {} : { client_version: "0.167.0" }),
                models,
              };
              if (cacheKind === "symlink") {
                const linked = join(directory, "linked-catalog.json");
                writeFileSync(linked, JSON.stringify(source));
                symlinkSync(linked, cachePath);
              } else if (cacheKind !== "missing")
                writeFileSync(
                  cachePath,
                  cacheKind === "invalid" ? "invalid JSON" : JSON.stringify(source),
                );
              const result = refreshManagedCodexCatalog({
                codexHomeDirectory: directory,
                hostVersion,
              });
              const label = JSON.stringify({
                hostVersion,
                cacheKind,
                selected,
                reasoning,
                extraCapability,
              });
              if (hostVersion.startsWith("0.167.") && cacheKind === "valid") {
                assert.equal(result.changed, true, label);
                assert.equal(typeof result.fingerprint, "string", label);
                const generated = JSON.parse(readFileSync(catalogPath, "utf8"));
                assert.equal(generated.models.length, 1, label);
                const actual = generated.models[0];
                const selectedSource = models.find((model) => model.slug === selected);
                assert.ok(selectedSource);
                assert.equal(actual.slug, ownEntry.slug, label);
                assert.equal(actual.display_name, ownEntry.display_name, label);
                assert.deepEqual(actual.model_messages, selectedSource.model_messages, label);
                assert.equal(actual.tool_mode, selectedSource.tool_mode, label);
                assert.equal(actual.multi_agent_version, selectedSource.multi_agent_version, label);
                assert.equal(
                  actual.node_repl_auto_review_required,
                  selectedSource.node_repl_auto_review_required,
                  label,
                );
                assert.equal(actual.node_repl_disabled, selectedSource.node_repl_disabled, label);
                assert.equal(actual.include_plugin_usage_instructions, true, label);
                assert.equal(actual.include_future_runtime_usage_instructions, true, label);
                for (const field of [
                  "context_window",
                  "max_context_window",
                  "input_modalities",
                  "supported_reasoning_levels",
                  "supports_search_tool",
                  "supports_parallel_tool_calls",
                ])
                  assert.deepEqual(actual[field], ownEntry[field], `${label} ${field}`);
                assert.equal(actual.supports_future_superpower, undefined, label);
                assert.deepEqual(
                  refreshManagedCodexCatalog({ codexHomeDirectory: directory, hostVersion }),
                  { changed: false, fingerprint: result.fingerprint },
                  label,
                );
                selectedSource.model_messages.future_protocol_section.revision = 2;
                writeFileSync(cachePath, JSON.stringify(source));
                const next = refreshManagedCodexCatalog({
                  codexHomeDirectory: directory,
                  hostVersion,
                });
                assert.equal(next.changed, true, label);
                assert.notEqual(next.fingerprint, result.fingerprint, label);
              } else {
                assert.deepEqual(result, { changed: false, fingerprint: null }, label);
                assert.equal(readFileSync(catalogPath, "utf8"), managed, label);
              }
              verified += 1;
            }
    assert.equal(verified, 80);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps inherited harness updates while configuration changes only verified execution declarations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-harness-preservation-"));
  try {
    writeFileSync(join(directory, "config.toml"), 'model = "official-a"\n');
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    const catalogPath = join(directory, ".ai-tidu9-model-catalog.json");
    const statePath = join(directory, ".ai-tidu9-profile-state.json");
    const profilePath = join(directory, "ai-tidu9.config.toml");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const official = {
      ...catalog.models[0],
      slug: "official-a",
      display_name: "Official A",
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      node_repl_auto_review_required: true,
      model_messages: {
        ...catalog.models[0].model_messages,
        instructions_template: "Native current template.",
        future_protocol: { revision: 1 },
      },
      context_window: 872000,
      supported_reasoning_levels: [{ effort: "ultra" }],
    };
    const cache = { client_version: "0.167.0", models: [official] };
    writeFileSync(join(directory, "models_cache.json"), JSON.stringify(cache));
    const state = readFileSync(statePath, "utf8");
    const profile = readFileSync(profilePath, "utf8");
    const configuration = readFileSync(join(directory, "config.toml"), "utf8");
    const first = refreshManagedCodexCatalog({
      codexHomeDirectory: directory,
      hostVersion: "0.167.0-alpha.3.2",
    });
    assert.equal(first.changed, true);
    assert.equal(readFileSync(statePath, "utf8"), state);
    assert.equal(readFileSync(profilePath, "utf8"), profile);
    assert.equal(readFileSync(join(directory, "config.toml"), "utf8"), configuration);
    official.model_messages.future_protocol.revision = 2;
    writeFileSync(join(directory, "models_cache.json"), JSON.stringify(cache));
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      request: async (input) =>
        String(input).endsWith("/api/capability-completion")
          ? Response.json({ codexReasoningEffortSupported: true })
          : successfulConfigurationRequest(input),
    });
    const updated = JSON.parse(readFileSync(catalogPath, "utf8"));
    assert.equal(updated.models.length, 1);
    assert.equal(updated.models[0].slug, "ai-tidu9-config");
    assert.deepEqual(updated.models[0].model_messages, official.model_messages);
    assert.equal(updated.models[0].context_window, 128000);
    assert.deepEqual(
      updated.models[0].supported_reasoning_levels.map((entry: { effort: string }) => entry.effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"],
    );
    const nextHost = refreshManagedCodexCatalog({
      codexHomeDirectory: directory,
      hostVersion: "0.167.0-alpha.3.3",
    });
    assert.equal(nextHost.changed, false);
    assert.notEqual(nextHost.fingerprint, first.fingerprint);
    const secondModel = {
      ...official,
      slug: "official-b",
      tool_mode: null,
      model_messages: { ...official.model_messages, instructions_template: "Template B." },
    } as Record<string, unknown>;
    delete secondModel.node_repl_auto_review_required;
    writeFileSync(
      join(directory, "models_cache.json"),
      JSON.stringify({ client_version: "0.167.0", models: [official, secondModel] }),
    );
    const selectedState = JSON.parse(readFileSync(statePath, "utf8"));
    for (const selected of ["official-b", "official-a"]) {
      writeFileSync(statePath, JSON.stringify({ ...selectedState, officialModel: selected }));
      assert.equal(
        refreshManagedCodexCatalog({
          codexHomeDirectory: directory,
          hostVersion: "0.167.0-alpha.3.3",
        }).changed,
        true,
      );
      const switched = JSON.parse(readFileSync(catalogPath, "utf8")).models[0];
      assert.equal(switched.tool_mode, selected === "official-a" ? "code_mode_only" : null);
      assert.equal(
        switched.node_repl_auto_review_required,
        selected === "official-a" ? true : undefined,
      );
      assert.deepEqual(
        switched.supported_reasoning_levels,
        updated.models[0].supported_reasoning_levels,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves ambiguous or unowned catalogs unchanged instead of choosing a template", async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-harness-ownership-"));
  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    const catalogPath = join(directory, ".ai-tidu9-model-catalog.json");
    const statePath = join(directory, ".ai-tidu9-profile-state.json");
    const managed = readFileSync(catalogPath, "utf8");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const models = ["official-a", "official-b"].map((slug) => ({
      slug,
      display_name: slug,
      visibility: "list",
      supported_in_api: true,
      tool_mode: "code_mode_only",
    }));
    writeFileSync(
      join(directory, "models_cache.json"),
      JSON.stringify({ client_version: "0.167.0", models }),
    );
    for (const variant of [
      { ...state, officialModel: undefined },
      { ...state, officialModel: "not-in-current-cache" },
      { ...state, owner: "unmanaged", officialModel: "official-a" },
      { ...state, profile: "other", officialModel: "official-a" },
      { ...state, model: "different-virtual", officialModel: "official-a" },
    ]) {
      writeFileSync(statePath, JSON.stringify(variant));
      assert.deepEqual(
        refreshManagedCodexCatalog({ codexHomeDirectory: directory, hostVersion: "0.167.0" }),
        { changed: false, fingerprint: null },
      );
      assert.equal(readFileSync(catalogPath, "utf8"), managed);
    }
    writeFileSync(statePath, JSON.stringify({ ...state, officialModel: "official-a" }));
    assert.deepEqual(refreshManagedCodexCatalog({ codexHomeDirectory: directory }), {
      changed: false,
      fingerprint: null,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the current native host loads an inherited harness catalog in an isolated home", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 15_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-native-harness-schema-"));
  const command = process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND ?? "codex";
  const environment = {
    PATH: process.env.PATH,
    CODEX_HOME: directory,
    OPENAI_API_KEY: undefined,
    CODEX_ACCESS_TOKEN: undefined,
  };
  let client: ReturnType<typeof createStdioJsonRpcClient> | undefined;
  try {
    const version = execFileSync(command, ["--version"], {
      env: environment,
      encoding: "utf8",
    })
      .trim()
      .match(/^codex-cli\s+(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/iu)?.[1];
    assert.ok(version);
    writeFileSync(join(directory, "config.toml"), 'model = "official-schema"\n');
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    const catalogPath = join(directory, ".ai-tidu9-model-catalog.json");
    const baseline = JSON.parse(readFileSync(catalogPath, "utf8")).models[0];
    const { base_instructions: _legacyInstructions, ...native } = baseline;
    const source = {
      ...native,
      slug: "official-schema",
      display_name: "Official Schema Fixture",
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      node_repl_auto_review_required: true,
      node_repl_disabled: false,
      model_messages: {
        ...native.model_messages,
        instructions_template: "Preserve the current native tool and permission contracts.",
      },
    };
    writeFileSync(
      join(directory, "models_cache.json"),
      JSON.stringify({ client_version: version.replace(/-.*/u, ""), models: [source] }),
    );
    assert.equal(
      refreshManagedCodexCatalog({ codexHomeDirectory: directory, hostVersion: version }).changed,
      true,
    );
    const inherited = JSON.parse(readFileSync(catalogPath, "utf8")).models[0];
    assert.equal(inherited.base_instructions, undefined);
    assert.deepEqual(inherited.model_messages, source.model_messages);
    client = createStdioJsonRpcClient({
      command,
      arguments: [
        "-c",
        'model_provider="schema_fixture"',
        "-c",
        'model_providers.schema_fixture={name="Schema Fixture",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=false}',
        "-c",
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        "app-server",
      ],
      environment,
      workingDirectory: directory,
    });
    await client.request("initialize", {
      clientInfo: { name: "schema_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const models = await client.request<{ data: { model: string }[] }>("model/list", {});
    assert.deepEqual(
      models.data.map((model) => model.model),
      ["ai-tidu9-config"],
    );
    const started = await client.request<{ model: string; thread: { id: string } }>(
      "thread/start",
      {
        model: "ai-tidu9-config",
        modelProvider: "schema_fixture",
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      },
    );
    assert.equal(started.model, "ai-tidu9-config");
    assert.equal(typeof started.thread.id, "string");
  } finally {
    await client?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancels stale preparation before it can overtake a newer official choice", {
  timeout: 5000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-preparation-order-"));
  let release: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    writeFileSync(join(directory, "config.toml"), 'model = "official-fixture"\n');
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    const pending = configureCodexClient({
      endpoint: "http://127.0.0.1:9640",
      codexHomeDirectory: directory,
      request: async (input, init) => {
        reached?.();
        await barrier;
        return successfulConfigurationRequest(input, init);
      },
    });
    const settled = pending.then(
      () => "completed",
      () => "cancelled",
    );
    await paused;
    const official = switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory: directory,
    });
    release?.();
    await official;
    assert.equal(await settled, "cancelled");
    assert.equal(
      inspectCodexClientConfiguration({ codexHomeDirectory: directory }).endpoint,
      "http://127.0.0.1:9639",
    );
  } finally {
    release?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mutation of [
  "remove",
  "external-remove",
  "external-official",
  "external-roundtrip",
  "rollback",
  "latest-model",
  "latest-model-failure",
] as const)
  test(`does not let a pending probe undo ${mutation}`, { timeout: 5000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "client-probe-ownership-"));
    const configuration = join(directory, "config.toml");
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      writeFileSync(configuration, 'model = "official-fixture"\n');
      await configureCodexClient({
        endpoint: "http://127.0.0.1:9639",
        codexHomeDirectory: directory,
        verifyRuntime: false,
      });
      const pending = switchCodexClientConfiguration({
        mode: "ai-tidu9",
        codexHomeDirectory: directory,
        request: async (input, init) => {
          if (String(input).endsWith("/responses")) {
            reached?.();
            await barrier;
            if (mutation === "latest-model-failure")
              return Response.json({ error: { message: "fixture failure" } }, { status: 400 });
          }
          return successfulConfigurationRequest(input, init);
        },
      });
      const settled = pending.then(
        () => "completed",
        () => "cancelled",
      );
      await paused;
      if (mutation === "remove") removeCodexClientConfiguration({ codexHomeDirectory: directory });
      if (mutation === "rollback")
        rollbackCodexClientConfiguration({ codexHomeDirectory: directory });
      if (mutation.startsWith("external-"))
        execFileSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            "--input-type=module",
            "-e",
            `import {removeCodexClientConfiguration,switchCodexClientConfiguration,configureCodexClient,rollbackCodexClientConfiguration} from ${JSON.stringify(new URL(`./configuration.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href)};${mutation === "external-remove" ? "removeCodexClientConfiguration({codexHomeDirectory:process.argv[1]});" : mutation === "external-official" ? "await switchCodexClientConfiguration({mode:'official',codexHomeDirectory:process.argv[1]});" : "await configureCodexClient({endpoint:'http://127.0.0.1:9640',verifyRuntime:false,codexHomeDirectory:process.argv[1]});rollbackCodexClientConfiguration({codexHomeDirectory:process.argv[1]});"}`,
            directory,
          ],
          { stdio: "pipe" },
        );
      if (mutation.startsWith("latest-model"))
        writeFileSync(
          configuration,
          readFileSync(configuration, "utf8").replace('"official-fixture"', '"official-latest"'),
        );
      release?.();
      if (mutation.startsWith("latest-model")) {
        assert.equal(await settled, mutation === "latest-model" ? "completed" : "cancelled");
        await switchCodexClientConfiguration({ mode: "official", codexHomeDirectory: directory });
        assert.equal(readCodexActiveSelection(directory).model, "official-latest");
      } else {
        assert.equal(await settled, "cancelled");
        if (mutation === "external-official" || mutation === "external-roundtrip") {
          assert.equal(
            inspectCodexClientConfiguration({ codexHomeDirectory: directory }).activeMode,
            "official",
          );
          return;
        }
        assert.equal(
          inspectCodexClientConfiguration({ codexHomeDirectory: directory }).installed,
          false,
        );
        assert.equal(existsSync(join(directory, "ai-tidu9.config.toml")), false);
      }
    } finally {
      release?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("keeps official mode during stalled validation and drains cancelled or superseded switches", {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "tidu-mode-verification-"));
  let probeStarted: (() => void) | undefined;
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/responses")) {
      probeStarted?.();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/health"
          ? { product: PRODUCT.name, status: "ok" }
          : request.url === "/v1/models"
            ? { data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }] }
            : { codexReasoningEffortSupported: false },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    writeFileSync(join(directory, "config.toml"), 'model = "official-fixture"\n');
    await configureCodexClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    for (const cancellation of ["timeout", "disconnect", "superseded"]) {
      const reached = new Promise<void>((resolve) => {
        probeStarted = resolve;
      });
      const controller = new AbortController();
      const pending = switchCodexClientConfiguration({
        mode: "ai-tidu9",
        codexHomeDirectory: directory,
        signal: controller.signal,
        verificationTimeoutMilliseconds: cancellation === "timeout" ? 100 : 3000,
      });
      const rejected = assert.rejects(pending);
      await reached;
      assert.equal(
        inspectCodexClientConfiguration({ codexHomeDirectory: directory }).activeMode,
        "official",
      );
      if (cancellation === "disconnect") controller.abort();
      if (cancellation === "superseded")
        await switchCodexClientConfiguration({ mode: "official", codexHomeDirectory: directory });
      await rejected;
      assert.equal(
        inspectCodexClientConfiguration({ codexHomeDirectory: directory }).activeMode,
        "official",
      );
      assert.equal(readCodexActiveSelection(directory).model, "official-fixture");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes legacy retry cleanup with a competing process after the inference probe", {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "client-retry-cleanup-ownership-"));
  const profilePath = join(directory, "ai-tidu9.config.toml");
  const configurationModule = new URL(
    `./configuration.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
    import.meta.url,
  ).href;
  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory: directory,
      verifyRuntime: false,
    });
    writeFileSync(
      profilePath,
      readFileSync(profilePath, "utf8").replace(
        "[model_providers.ai_tidu9]",
        "[model_providers.ai_tidu9]\nrequest_max_retries = 0\nstream_max_retries = 0",
      ),
    );
    const contender = `import {configureCodexClient} from ${JSON.stringify(configurationModule)};
try {await configureCodexClient({endpoint:'http://127.0.0.1:9640',codexHomeDirectory:process.argv[1],verifyRuntime:false});console.log(JSON.stringify({status:'completed'}));}
catch(error){console.log(JSON.stringify({status:'failed',code:error.code}));}`;
    const script = `import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {switchCodexClientConfiguration} from ${JSON.stringify(configurationModule)};
const home=process.argv[1],profile=process.argv[2],write=fs.writeFileSync;
let contenderResult,probeRetainedLegacy=false;
fs.writeFileSync=(path,...args)=>{if(contenderResult===undefined&&String(path).startsWith(profile+'.')){contenderResult=JSON.parse(execFileSync(process.execPath,['--import',${JSON.stringify(import.meta.resolve("tsx"))},'--input-type=module','-e',${JSON.stringify(contender)},home],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000}));}return write(path,...args);};
syncBuiltinESMExports();
try {const status=await switchCodexClientConfiguration({mode:'ai-tidu9',codexHomeDirectory:home,request:async input=>{if(String(input).endsWith('/responses'))probeRetainedLegacy=/request_max_retries\\s*=\\s*0/u.test(fs.readFileSync(profile,'utf8'));return Response.json(String(input).endsWith('/health')?{product:${JSON.stringify(PRODUCT.name)},status:'ok'}:String(input).endsWith('/v1/models')?{data:[{id:'ai-tidu9-config',owned_by:'AI-Tidu9'}]}:{});}});console.log(JSON.stringify({mode:status.activeMode,contender:contenderResult,probeRetainedLegacy}));}
catch(error){console.log(JSON.stringify({error:error.code,contender:contenderResult,probeRetainedLegacy}));}
finally {fs.writeFileSync=write;syncBuiltinESMExports();}`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          script,
          directory,
          profilePath,
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 8000 },
      ),
    );
    assert.deepEqual(result, {
      mode: "ai-tidu9",
      contender: { status: "failed", code: "CONFIGURATION_CONFLICT" },
      probeRetainedLegacy: true,
    });
    assert.equal(
      inspectCodexClientConfiguration({ codexHomeDirectory: directory }).endpoint,
      "http://127.0.0.1:9639",
    );
    assert.match(readFileSync(profilePath, "utf8"), /127\.0\.0\.1:9639/u);
    assert.doesNotMatch(readFileSync(profilePath, "utf8"), /(?:request|stream)_max_retries/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    assert.doesNotMatch(profile, /(?:request|stream)_max_retries\s*=/u);
    assert.match(profile, new RegExp(`base_url = "${runtime.origin}/v1/hosts/codex"`, "u"));
    assert.doesNotMatch(profile, /api[_-]?key|token|secret/iu);
    const activeDefaultConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.match(activeDefaultConfiguration, /^model = "user-default"/u);
    assert.match(activeDefaultConfiguration, /\[model_providers\.ai_tidu9\]/u);
    assert.doesNotMatch(activeDefaultConfiguration, /AI-Tidu9 managed default:start/u);
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
          assert.ok(init.signal instanceof AbortSignal);
          assert.doesNotMatch(
            readFileSync(defaultConfiguration, "utf8"),
            /AI-Tidu9 managed default:start/u,
          );
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
    assert.doesNotMatch(tiduDefaultConfiguration, /(?:request|stream)_max_retries\s*=/u);
    assert.doesNotMatch(tiduDefaultConfiguration, /requires_openai_auth = true/u);

    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    assert.equal(inspectCodexClientConfiguration({ codexHomeDirectory }).activeMode, "official");
    const restoredOfficialConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.match(restoredOfficialConfiguration, /^model = "user-default"/u);
    assert.match(restoredOfficialConfiguration, /\[model_providers\.ai_tidu9\]/u);
    assert.doesNotMatch(restoredOfficialConfiguration, /AI-Tidu9 managed default:start/u);

    const rollback = rollbackCodexClientConfiguration({ codexHomeDirectory });
    assert.equal(rollback.status, "restored");
    assert.equal(existsSync(profilePath), false);
    assert.equal(readFileSync(defaultConfiguration, "utf8"), 'model = "user-default"\n');
  } finally {
    await runtime.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("restores the latest official model selection after a managed-mode round trip", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-official-selection-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ product: "九门赛博提督", status: "ok" });
    if (url.endsWith("/v1/models"))
      return Response.json({
        object: "list",
        data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
      });
    return Response.json({ id: "verified", object: "response", output: [] });
  };

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(
      defaultConfiguration,
      [
        'model = "official-initial"',
        'model_provider = "official_initial"',
        'model_catalog_json = "/catalog/initial.json"',
        "[model_providers.official_initial]",
        'name = "Initial"',
        "[model_providers.official_updated]",
        'name = "Updated"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const updatedOfficial = readFileSync(defaultConfiguration, "utf8")
      .replace('model = "official-initial"', 'model = "official-updated"')
      .replace('model_provider = "official_initial"', 'model_provider = "official_updated"')
      .replace(
        'model_catalog_json = "/catalog/initial.json"',
        'model_catalog_json = "/catalog/updated.json"',
      );
    writeFileSync(defaultConfiguration, updatedOfficial, { mode: 0o600 });

    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request,
    });
    assert.deepEqual(readCodexActiveSelection(codexHomeDirectory), {
      modelProvider: "ai_tidu9",
      model: "ai-tidu9-config",
    });
    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });

    const restored = readFileSync(defaultConfiguration, "utf8");
    assert.match(restored, /^model = "official-updated"/u);
    assert.match(restored, /^model_provider = "official_updated"/mu);
    assert.match(restored, /^model_catalog_json = "\/catalog\/updated\.json"/mu);
    assert.doesNotMatch(restored, /AI-Tidu9 managed default:start/u);

    writeFileSync(
      defaultConfiguration,
      restored
        .split("\n")
        .filter((line) => !/^model\s*=/u.test(line))
        .join("\n"),
      { mode: 0o600 },
    );
    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request,
    });
    assert.deepEqual(readCodexActiveSelection(codexHomeDirectory), {
      modelProvider: "ai_tidu9",
      model: "ai-tidu9-config",
    });
    const stateWithoutExplicitOfficialModel = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("officialModel" in stateWithoutExplicitOfficialModel, false);
    await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    assert.doesNotMatch(readFileSync(defaultConfiguration, "utf8"), /^model\s*=/mu);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("keeps official defaults intact when managed mode is selected repeatedly", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-repeat-managed-mode-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ product: "九门赛博提督", status: "ok" });
    if (url.endsWith("/v1/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
      });
    }
    return Response.json({ id: "verified", object: "response", output: [] });
  };

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(
      defaultConfiguration,
      [
        'model = "official-repeat"',
        'model_provider = "official_repeat"',
        'model_catalog_json = "/catalog/repeat.json"',
        "[model_providers.official_repeat]",
        'name = "Official repeat"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });

    await switchCodexClientConfiguration({ mode: "ai-tidu9", codexHomeDirectory, request });
    writeFileSync(
      defaultConfiguration,
      readFileSync(defaultConfiguration, "utf8").replace(
        /# AI-Tidu9 managed provider:start[\s\S]*?# AI-Tidu9 managed provider:end\n?/u,
        "",
      ),
      { mode: 0o600 },
    );
    await switchCodexClientConfiguration({ mode: "ai-tidu9", codexHomeDirectory, request });
    assert.match(readFileSync(defaultConfiguration, "utf8"), /\[model_providers\.ai_tidu9\]/u);
    await switchCodexClientConfiguration({ mode: "official", codexHomeDirectory });

    const restored = readFileSync(defaultConfiguration, "utf8");
    assert.match(restored, /^model = "official-repeat"/u);
    assert.match(restored, /^model_provider = "official_repeat"/mu);
    assert.match(restored, /^model_catalog_json = "\/catalog\/repeat\.json"/mu);
    assert.doesNotMatch(restored, /AI-Tidu9 managed default:start/u);
    const state = JSON.parse(
      readFileSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json"), "utf8"),
    ) as { activeMode: string; officialDefaultLines: string[] };
    assert.equal(state.activeMode, "official");
    assert.deepEqual(state.officialDefaultLines, [
      'model = "official-repeat"',
      'model_provider = "official_repeat"',
      'model_catalog_json = "/catalog/repeat.json"',
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("recovers official mode and historical provider loading without readable managed state", async () => {
  const scenarios = ["missing", "corrupt", "missing-config-and-state"] as const;
  for (const scenario of scenarios) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), `ai-tidu9-${scenario}-state-`));
    const codexHomeDirectory = join(temporaryDirectory, ".codex");
    const defaultConfiguration = join(codexHomeDirectory, "config.toml");
    const statePath = join(codexHomeDirectory, ".ai-tidu9-profile-state.json");
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ product: "九门赛博提督", status: "ok" });
      if (url.endsWith("/v1/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
        });
      }
      return Response.json({ id: "verified", object: "response", output: [] });
    };

    try {
      await configureCodexClient({
        endpoint: "http://127.0.0.1:9639",
        codexHomeDirectory,
        verifyRuntime: false,
      });
      await switchCodexClientConfiguration({ mode: "ai-tidu9", codexHomeDirectory, request });
      const legacyConfiguration = readFileSync(defaultConfiguration, "utf8").replace(
        /# AI-Tidu9 managed provider:start[\s\S]*?# AI-Tidu9 managed provider:end\n?/u,
        "",
      );
      writeFileSync(defaultConfiguration, legacyConfiguration, { mode: 0o600 });
      if (scenario === "corrupt") writeFileSync(statePath, "{invalid", { mode: 0o600 });
      else rmSync(statePath);
      if (scenario === "missing-config-and-state") rmSync(defaultConfiguration);

      const status = await switchCodexClientConfiguration({
        mode: "official",
        codexHomeDirectory,
      });
      const recoveredConfiguration = readFileSync(defaultConfiguration, "utf8");
      assert.equal(status.activeMode, "official");
      assert.deepEqual(readCodexActiveSelection(codexHomeDirectory), { modelProvider: "openai" });
      assert.doesNotMatch(recoveredConfiguration, /AI-Tidu9 managed default:start/u);
      assert.match(recoveredConfiguration, /\[model_providers\.ai_tidu9\]/u);
      assert.match(
        recoveredConfiguration,
        /base_url = "http:\/\/127\.0\.0\.1:9639\/v1\/hosts\/codex"/u,
      );
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
});

test("restores official mode when a managed artifact is missing", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-official-recovery-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ product: "九门赛博提督", status: "ok" });
    if (url.endsWith("/v1/models"))
      return Response.json({
        object: "list",
        data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }],
      });
    return Response.json({ id: "verified", object: "response", output: [] });
  };

  try {
    mkdirSync(codexHomeDirectory, { mode: 0o700, recursive: true });
    writeFileSync(defaultConfiguration, 'model = "official-model"\nmodel_provider = "openai"\n', {
      mode: 0o600,
    });
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    await switchCodexClientConfiguration({
      mode: "ai-tidu9",
      codexHomeDirectory,
      request,
    });
    rmSync(join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"));

    const status = await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });
    const restored = readFileSync(defaultConfiguration, "utf8");

    assert.equal(status.activeMode, "official");
    assert.equal(inspectCodexClientConfiguration({ codexHomeDirectory }).activeMode, "official");
    assert.match(restored, /^model = "official-model"/u);
    assert.match(restored, /^model_provider = "openai"/mu);
    assert.doesNotMatch(restored, /AI-Tidu9 managed default:start/u);
    assert.match(restored, /\[model_providers\.ai_tidu9\]/u);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("repairs historical managed-provider loading when official mode is already active", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-official-provider-repair-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const defaultConfiguration = join(codexHomeDirectory, "config.toml");

  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const legacyOfficialConfiguration = readFileSync(defaultConfiguration, "utf8").replace(
      /# AI-Tidu9 managed provider:start[\s\S]*?# AI-Tidu9 managed provider:end\n?/u,
      "",
    );
    writeFileSync(defaultConfiguration, legacyOfficialConfiguration, { mode: 0o600 });
    assert.doesNotMatch(readFileSync(defaultConfiguration, "utf8"), /model_providers\.ai_tidu9/u);

    const status = await switchCodexClientConfiguration({
      mode: "official",
      codexHomeDirectory,
    });

    assert.equal(status.activeMode, "official");
    assert.match(readFileSync(defaultConfiguration, "utf8"), /\[model_providers\.ai_tidu9\]/u);
    assert.deepEqual(readCodexActiveSelection(codexHomeDirectory), { modelProvider: "openai" });
  } finally {
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
    const activeConfiguration = `${readFileSync(defaultConfigurationPath, "utf8")}\n[model_providers.fixture]\nstream_max_retries = 0\n`;
    const profilePath = join(codexHomeDirectory, "ai-tidu9.config.toml");
    const legacyRetries =
      "[model_providers.ai_tidu9]\nrequest_max_retries = 0\nstream_max_retries = 0";
    writeFileSync(
      defaultConfigurationPath,
      activeConfiguration.replace("[model_providers.ai_tidu9]", legacyRetries),
    );
    writeFileSync(
      profilePath,
      readFileSync(profilePath, "utf8").replace("[model_providers.ai_tidu9]", legacyRetries),
    );

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
    assert.doesNotMatch(readFileSync(profilePath, "utf8"), /(?:request|stream)_max_retries/u);
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
    writeFileSync(
      join(codexHomeDirectory, ".ai-tidu9-turn-providers.jsonl"),
      '{"threadId":"fixture","turnId":"fixture","modelProvider":"ai_tidu9"}\n',
      { mode: 0o600 },
    );
    const result = removeCodexClientConfiguration({ codexHomeDirectory });
    assert.equal(result.status, "removed");
    assert.equal(result.removedArtifactCount, 5);
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-profile-state.json")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-backups")), false);
    assert.equal(existsSync(join(codexHomeDirectory, ".ai-tidu9-turn-providers.jsonl")), false);
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

test("rejects managed snapshot identifiers that escape the backup root", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-backup-boundary-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const outsideDirectory = join(temporaryDirectory, "outside");
  const outsideMarker = join(outsideDirectory, "keep.txt");
  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(outsideMarker, "preserve", { mode: 0o600 });
    const statePath = join(codexHomeDirectory, ".ai-tidu9-profile-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    writeFileSync(statePath, `${JSON.stringify({ ...state, backupId: "../../outside" })}\n`, {
      mode: 0o600,
    });

    assert.throws(
      () => rollbackCodexClientConfiguration({ codexHomeDirectory }),
      /client state is invalid/iu,
    );
    assert.equal(readFileSync(outsideMarker, "utf8"), "preserve");
    assert.equal(existsSync(join(codexHomeDirectory, "ai-tidu9.config.toml")), true);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("preflights every snapshot file before changing the active configuration", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-rollback-preflight-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  try {
    mkdirSync(codexHomeDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHomeDirectory, "config.toml"), 'model = "official"\n', {
      mode: 0o600,
    });
    const configured = await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const managedPaths = [
      join(codexHomeDirectory, "ai-tidu9.config.toml"),
      join(codexHomeDirectory, ".ai-tidu9-profile-state.json"),
      join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"),
      join(codexHomeDirectory, "config.toml"),
    ];
    const beforeRollback = new Map(
      managedPaths.map((managedPath) => [managedPath, readFileSync(managedPath, "utf8")]),
    );
    rmSync(join(codexHomeDirectory, ".ai-tidu9-backups", configured.backupId, "config.toml"));

    assert.throws(
      () => rollbackCodexClientConfiguration({ codexHomeDirectory }),
      /snapshot is incomplete/iu,
    );
    for (const managedPath of managedPaths) {
      assert.equal(readFileSync(managedPath, "utf8"), beforeRollback.get(managedPath));
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("preflights the backup directory before removing managed artifacts", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-tidu9-codex-remove-preflight-"));
  const codexHomeDirectory = join(temporaryDirectory, ".codex");
  const replacementDirectory = join(temporaryDirectory, "replacement");
  try {
    await configureCodexClient({
      endpoint: "http://127.0.0.1:9639",
      codexHomeDirectory,
      verifyRuntime: false,
    });
    const managedPaths = [
      join(codexHomeDirectory, "ai-tidu9.config.toml"),
      join(codexHomeDirectory, ".ai-tidu9-profile-state.json"),
      join(codexHomeDirectory, ".ai-tidu9-model-catalog.json"),
    ];
    const beforeRemoval = new Map(
      managedPaths.map((managedPath) => [managedPath, readFileSync(managedPath, "utf8")]),
    );
    rmSync(join(codexHomeDirectory, ".ai-tidu9-backups"), { recursive: true });
    mkdirSync(replacementDirectory);
    symlinkSync(replacementDirectory, join(codexHomeDirectory, ".ai-tidu9-backups"));

    assert.throws(
      () => removeCodexClientConfiguration({ codexHomeDirectory }),
      /backups must be a real directory/iu,
    );
    for (const managedPath of managedPaths) {
      assert.equal(readFileSync(managedPath, "utf8"), beforeRemoval.get(managedPath));
    }
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
      assert.doesNotMatch(
        readFileSync(defaultConfiguration, "utf8"),
        /AI-Tidu9 managed default:start/u,
      );
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
    const retainedOfficialConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.match(retainedOfficialConfiguration, /^model = "official-model"/u);
    assert.match(retainedOfficialConfiguration, /\[model_providers\.ai_tidu9\]/u);
    assert.doesNotMatch(retainedOfficialConfiguration, /AI-Tidu9 managed default:start/u);
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
      assert.doesNotMatch(
        readFileSync(defaultConfiguration, "utf8"),
        /AI-Tidu9 managed default:start/u,
      );
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
    const retainedOfficialConfiguration = readFileSync(defaultConfiguration, "utf8");
    assert.match(retainedOfficialConfiguration, /^model = "official-model"/u);
    assert.match(retainedOfficialConfiguration, /\[model_providers\.ai_tidu9\]/u);
    assert.doesNotMatch(retainedOfficialConfiguration, /AI-Tidu9 managed default:start/u);
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

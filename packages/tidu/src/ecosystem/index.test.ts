import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  type CapabilityProviderImplementation,
  type CapabilityProviderManifest,
  createAgentCapabilityAdapter,
  createCapabilityCatalog,
  createCapabilityRuntime,
  createClientCapabilityAdapter,
  createHistoryCapabilityAdapter,
  createModelCapabilityAdapter,
  createProviderIntegrity,
  createStorageCapabilityAdapter,
  createThirdPartyAgentDelegate,
  discoverCapabilityExtensions,
  satisfiesProviderVersion,
  testCapabilityProvider,
  validateProviderDependencies,
  verifyProviderIntegrity,
  verifyProviderSignature,
} from "./index.js";

const createManifest = (
  overrides: Partial<CapabilityProviderManifest> = {},
): CapabilityProviderManifest => ({
  id: "@skillnull/example-provider",
  name: "Example provider",
  version: "1.2.0",
  protocolVersion: CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  kind: "model",
  source: "official",
  capabilities: ["text.generate"],
  permissions: ["model.invoke"],
  trust: "trusted",
  ...overrides,
});

const createProvider = (
  overrides: Partial<CapabilityProviderManifest> = {},
): CapabilityProviderImplementation => ({
  manifest: createManifest(overrides),
  invoke: async (invocation) => ({ output: { operation: invocation.operation } }),
});

test("verifies canonical integrity and Ed25519 signatures", () => {
  const unsigned = createManifest();
  const integrity = createProviderIntegrity(unsigned);
  const manifest = { ...unsigned, integrity };
  assert.equal(verifyProviderIntegrity(manifest), true);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const value = sign(
    null,
    Buffer.from(
      JSON.stringify({
        ...unsigned,
        capabilities: ["text.generate"],
        permissions: ["model.invoke"],
        dependencies: [],
      }),
    ),
    privateKey,
  ).toString("base64");
  const signed = {
    ...unsigned,
    signature: { algorithm: "ed25519" as const, keyId: "official", value },
  };
  assert.equal(
    verifyProviderSignature(signed, {
      official: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
    true,
  );
});

test("resolves enterprise, local, and official catalogs with explicit precedence", () => {
  const catalog = createCapabilityCatalog([
    { manifest: createManifest({ source: "official" }), location: "npm:official" },
    { manifest: createManifest({ source: "local" }), location: "file:local" },
    { manifest: createManifest({ source: "enterprise" }), location: "private:enterprise" },
  ]);
  assert.equal(catalog.resolve("@skillnull/example-provider")?.location, "private:enterprise");
  assert.equal(
    catalog.resolve("@skillnull/example-provider", ["official"])?.location,
    "npm:official",
  );
});

test("provides typed model, Agent, client, storage, and history adapter boundaries", async () => {
  const invoke = async (request: string) => request.toUpperCase();
  const adapters = [
    createModelCapabilityAdapter(invoke),
    createAgentCapabilityAdapter(invoke),
    createClientCapabilityAdapter(invoke),
    createStorageCapabilityAdapter(invoke),
    createHistoryCapabilityAdapter(invoke),
  ];
  assert.deepEqual(
    adapters.map((adapter) => adapter.kind),
    ["model", "agent", "client", "storage", "history"],
  );
  assert.equal(await adapters[0]?.invoke("hello"), "HELLO");
});

test("discovers Skill and MCP metadata without following symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-ecosystem-"));
  const skillDirectory = join(root, "reviewer");
  const mcpDirectory = join(root, "search");
  mkdirSync(skillDirectory);
  mkdirSync(mcpDirectory);
  writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: review-skill\n---\n", "utf8");
  writeFileSync(join(mcpDirectory, "mcp.json"), JSON.stringify({ name: "search-mcp" }), "utf8");
  symlinkSync(skillDirectory, join(root, "linked-skill"));

  const discovered = discoverCapabilityExtensions({ roots: [root] });
  assert.deepEqual(
    discovered.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "review-skill", kind: "skill" },
      { id: "search-mcp", kind: "mcp" },
    ],
  );
});

test("denies undeclared grants and requires attested isolation for untrusted providers", async () => {
  const trustedRuntime = createCapabilityRuntime({ grantedPermissions: [] });
  await assert.rejects(
    trustedRuntime.invoke(createProvider(), { operation: "generate", input: {} }),
    /permissions were not granted/u,
  );

  const untrustedProvider = createProvider({ trust: "untrusted" });
  const untrustedRuntime = createCapabilityRuntime({ grantedPermissions: ["model.invoke"] });
  await assert.rejects(
    untrustedRuntime.invoke(untrustedProvider, { operation: "generate", input: {} }),
    /require an attested extension sandbox/u,
  );

  const isolatedRuntime = createCapabilityRuntime({
    grantedPermissions: ["model.invoke"],
    sandbox: {
      execute: async () => ({
        result: { output: "isolated" },
        attestation: {
          isolated: true,
          processDenied: true,
          filesystemRestricted: true,
          networkRestricted: true,
        },
      }),
    },
  });
  assert.equal(
    (await isolatedRuntime.invoke(untrustedProvider, { operation: "generate", input: {} })).output,
    "isolated",
  );

  const inputBoundedRuntime = createCapabilityRuntime({
    grantedPermissions: ["model.invoke"],
    maximumInputBytes: 8,
  });
  await assert.rejects(
    inputBoundedRuntime.invoke(createProvider(), {
      operation: "generate",
      input: "input exceeding the limit",
    }),
    /input exceeded/u,
  );
});

test("bounds third-party Agent delegation", async () => {
  const provider = createProvider({
    kind: "agent",
    permissions: ["agent.delegate"],
    capabilities: ["agent.delegate"],
  });
  const runtime = createCapabilityRuntime({ grantedPermissions: ["agent.delegate"] });
  const delegate = createThirdPartyAgentDelegate(provider, runtime, {
    maximumTurns: 8,
    maximumToolCalls: 16,
    timeoutMs: 5_000,
    maximumOutputBytes: 4_096,
  });
  const result = await delegate.delegate({ goal: "Review the release" });
  assert.deepEqual(result.output, { operation: "agent.delegate" });
  assert.throws(() => delegate.delegate({ goal: "  " }), /must not be empty/u);
});

test("validates compatible dependency ranges", () => {
  const manifest = createManifest({
    dependencies: [{ id: "@skillnull/base-provider", version: "^1.1.0" }],
  });
  assert.equal(satisfiesProviderVersion("1.3.0", "^1.1.0"), true);
  assert.equal(satisfiesProviderVersion("2.0.0", "^1.1.0"), false);
  assert.deepEqual(
    validateProviderDependencies(manifest, [
      createManifest({ id: "@skillnull/base-provider", version: "1.3.0" }),
    ]),
    [],
  );
});

test("provides an extension-author smoke test harness", async () => {
  const provider = createProvider();
  provider.manifest = {
    ...provider.manifest,
    integrity: createProviderIntegrity(provider.manifest),
  };
  const report = await testCapabilityProvider(provider, {
    operation: "generate",
    input: "hello",
  });
  assert.deepEqual(report, { passed: true, problems: [] });
});

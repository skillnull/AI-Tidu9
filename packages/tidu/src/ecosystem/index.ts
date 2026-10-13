import { createHash, verify } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export const CAPABILITY_PROVIDER_PROTOCOL_VERSION = "1.0.0";

export type CapabilityProviderKind = "agent" | "client" | "history" | "model" | "storage";
export type CapabilityCatalogSource = "enterprise" | "local" | "official";
export type CapabilityPermission =
  | "agent.delegate"
  | "filesystem.read"
  | "filesystem.write"
  | "history.read"
  | "history.write"
  | "model.invoke"
  | "network.connect"
  | "process.spawn"
  | "secrets.use";

export interface CapabilityProviderDependency {
  /** Stable provider identifier required before this provider can start. */
  id: string;
  /** Exact version or compatible caret range accepted by this provider. */
  version: string;
}

export interface CapabilityProviderSignature {
  /** Signature algorithm accepted by the current protocol. */
  algorithm: "ed25519";
  /** Administrator-managed identifier for the signing public key. */
  keyId: string;
  /** Base64-encoded signature over the canonical provider manifest. */
  value: string;
}

export interface CapabilityProviderManifest {
  /** Stable reverse-domain or scoped provider identifier. */
  id: string;
  /** Human-readable provider name. */
  name: string;
  /** Semantic provider version. */
  version: string;
  /** Capability-provider protocol version implemented by the extension. */
  protocolVersion: string;
  /** Adapter boundary implemented by the provider. */
  kind: CapabilityProviderKind;
  /** Catalog from which the provider is installed. */
  source: CapabilityCatalogSource;
  /** Capability identifiers exposed to routing and planning. */
  capabilities: readonly string[];
  /** Explicit least-privilege permissions required at runtime. */
  permissions: readonly CapabilityPermission[];
  /** Other providers required by this extension. */
  dependencies?: readonly CapabilityProviderDependency[];
  /** SHA-256 digest of the canonical manifest without integrity or signature. */
  integrity?: string;
  /** Optional publisher signature verified against an administrator trust store. */
  signature?: CapabilityProviderSignature;
  /** Whether execution must cross an attested isolation boundary. */
  trust: "trusted" | "untrusted";
}

export interface CapabilityInvocation {
  /** Operation name understood by the selected adapter. */
  operation: string;
  /** JSON-compatible operation input. */
  input: unknown;
  /** Tenant boundary propagated to policy and audit layers. */
  tenantId?: string;
  /** Maximum end-to-end execution time. */
  timeoutMs?: number;
  /** Maximum serialized response size. */
  maximumOutputBytes?: number;
}

export interface CapabilityInvocationResult {
  /** JSON-compatible provider output. */
  output: unknown;
  /** Provider-reported usage units, when available. */
  usage?: Readonly<Record<string, number>>;
  /** Non-secret evidence identifiers produced by the provider. */
  evidence?: readonly string[];
}

export interface CapabilityProviderImplementation {
  /** Immutable provider metadata used for validation and routing. */
  manifest: CapabilityProviderManifest;
  /** Executes one trusted in-process provider operation. */
  invoke: (invocation: CapabilityInvocation) => Promise<CapabilityInvocationResult>;
}

export interface CapabilityAdapter<TRequest, TResult> {
  /** Adapter boundary implemented by this instance. */
  kind: CapabilityProviderKind;
  /** Executes a typed request through the provider boundary. */
  invoke: (request: TRequest) => Promise<TResult>;
}

export interface ExtensionSandboxRequest {
  /** Validated provider manifest to load inside the sandbox. */
  manifest: CapabilityProviderManifest;
  /** Bounded provider invocation. */
  invocation: CapabilityInvocation;
}

export interface ExtensionSandboxResult {
  /** Provider result returned across the isolation boundary. */
  result: CapabilityInvocationResult;
  /** Runtime assertion proving that isolation controls were active. */
  attestation: {
    /** Whether the extension ran outside the control-plane process. */
    isolated: true;
    /** Whether arbitrary child-process creation was denied. */
    processDenied: boolean;
    /** Whether filesystem access was limited to declared mounts. */
    filesystemRestricted: boolean;
    /** Whether network access was limited to declared destinations. */
    networkRestricted: boolean;
  };
}

export interface ExtensionSandbox {
  /** Executes an untrusted provider in an independently enforced boundary. */
  execute: (request: ExtensionSandboxRequest) => Promise<ExtensionSandboxResult>;
}

export interface CapabilityRuntimeOptions {
  /** Permissions granted by the user or enterprise policy. */
  grantedPermissions: readonly CapabilityPermission[];
  /** Required executor for manifests marked as untrusted. */
  sandbox?: ExtensionSandbox;
  /** Hard upper bound applied even when a provider asks for more time. */
  maximumTimeoutMs?: number;
  /** Hard upper bound applied to serialized provider output. */
  maximumOutputBytes?: number;
  /** Hard upper bound applied to serialized provider input. */
  maximumInputBytes?: number;
}

export interface CapabilityRuntime {
  /** Validates policy and invokes a trusted or isolated provider. */
  invoke: (
    provider: CapabilityProviderImplementation,
    invocation: CapabilityInvocation,
  ) => Promise<CapabilityInvocationResult>;
}

export interface CapabilityCatalogEntry {
  /** Validated provider manifest. */
  manifest: CapabilityProviderManifest;
  /** Installation location or package reference; never executed during discovery. */
  location: string;
}

export interface CapabilityCatalog {
  /** Lists defensive copies of all catalog entries. */
  list: () => readonly CapabilityCatalogEntry[];
  /** Resolves a provider using an explicit source-precedence order. */
  resolve: (
    id: string,
    sourceOrder?: readonly CapabilityCatalogSource[],
  ) => CapabilityCatalogEntry | undefined;
}

export interface DiscoveredExtension {
  /** Detected extension category. */
  kind: "mcp" | "skill";
  /** Stable local identifier derived from declared metadata or directory name. */
  id: string;
  /** Absolute path to the metadata file. */
  path: string;
}

export interface ExtensionDiscoveryOptions {
  /** Explicit roots that may be inspected. */
  roots: readonly string[];
  /** Maximum directory depth below each root. */
  maximumDepth?: number;
  /** Maximum number of filesystem entries inspected across all roots. */
  maximumEntries?: number;
}

export interface ThirdPartyAgentLimits {
  /** Maximum delegated model turns. */
  maximumTurns: number;
  /** Maximum delegated tool calls. */
  maximumToolCalls: number;
  /** Maximum delegated execution time. */
  timeoutMs: number;
  /** Maximum serialized result size. */
  maximumOutputBytes: number;
}

export interface ThirdPartyAgentRequest {
  /** Goal sent to the delegated Agent. */
  goal: string;
  /** Non-secret task context approved for delegation. */
  context?: unknown;
  /** Tenant boundary propagated to the provider. */
  tenantId?: string;
}

export interface ThirdPartyAgentDelegate {
  /** Delegates a task under immutable resource bounds. */
  delegate: (request: ThirdPartyAgentRequest) => Promise<CapabilityInvocationResult>;
}

export interface ProviderTestReport {
  /** Whether every protocol and optional smoke check passed. */
  passed: boolean;
  /** Human-readable failures suitable for extension authors. */
  problems: readonly string[];
}

const ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{1,127}$/u;
const CAPABILITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/u;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INPUT_BYTES = 1_048_576;
const DEFAULT_OUTPUT_BYTES = 1_048_576;

const normalizeStrings = (values: readonly string[]): readonly string[] =>
  [...new Set(values.map((value) => value.trim()))].sort();

const canonicalManifest = (manifest: CapabilityProviderManifest): string => {
  const { integrity: _integrity, signature: _signature, ...unsignedManifest } = manifest;
  return JSON.stringify({
    ...unsignedManifest,
    capabilities: normalizeStrings(unsignedManifest.capabilities),
    permissions: normalizeStrings(unsignedManifest.permissions),
    dependencies: [...(unsignedManifest.dependencies ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  });
};

const assertPositiveBound = (value: number, name: string, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
};

export const validateCapabilityProviderManifest = (
  manifest: CapabilityProviderManifest,
): readonly string[] => {
  const problems: string[] = [];
  if (!ID_PATTERN.test(manifest.id)) problems.push("Provider id is not a safe stable identifier.");
  if (!manifest.name.trim() || manifest.name.length > 128) {
    problems.push("Provider name must contain 1-128 characters.");
  }
  if (!SEMVER_PATTERN.test(manifest.version)) problems.push("Provider version must use SemVer.");
  if (manifest.protocolVersion !== CAPABILITY_PROVIDER_PROTOCOL_VERSION) {
    problems.push(`Unsupported protocol version ${manifest.protocolVersion}.`);
  }
  const capabilities = normalizeStrings(manifest.capabilities);
  if (capabilities.length === 0 || capabilities.some((item) => !CAPABILITY_PATTERN.test(item))) {
    problems.push("Capabilities must contain safe, non-empty identifiers.");
  }
  if (new Set(manifest.permissions).size !== manifest.permissions.length) {
    problems.push("Permission declarations must not contain duplicates.");
  }
  for (const dependency of manifest.dependencies ?? []) {
    if (
      !ID_PATTERN.test(dependency.id) ||
      !/^\^?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u.test(dependency.version)
    ) {
      problems.push(`Dependency ${dependency.id} has an invalid version requirement.`);
    }
  }
  if (
    manifest.integrity !== undefined &&
    !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(manifest.integrity)
  ) {
    problems.push("Provider integrity must be a base64 SHA-256 digest.");
  }
  return problems;
};

export const defineCapabilityProvider = (
  provider: CapabilityProviderImplementation,
): CapabilityProviderImplementation => {
  const problems = validateCapabilityProviderManifest(provider.manifest);
  if (problems.length > 0) throw new Error(problems.join(" "));
  return Object.freeze({ ...provider, manifest: Object.freeze({ ...provider.manifest }) });
};

export const createProviderIntegrity = (manifest: CapabilityProviderManifest): string =>
  `sha256-${createHash("sha256").update(canonicalManifest(manifest)).digest("base64")}`;

export const verifyProviderIntegrity = (manifest: CapabilityProviderManifest): boolean =>
  manifest.integrity !== undefined && manifest.integrity === createProviderIntegrity(manifest);

export const verifyProviderSignature = (
  manifest: CapabilityProviderManifest,
  publicKeys: Readonly<Record<string, string>>,
): boolean => {
  const signature = manifest.signature;
  const publicKey = signature === undefined ? undefined : publicKeys[signature.keyId];
  if (signature === undefined || publicKey === undefined) return false;
  return verify(
    null,
    Buffer.from(canonicalManifest(manifest)),
    publicKey,
    Buffer.from(signature.value, "base64"),
  );
};

const parseCoreVersion = (version: string): readonly number[] | undefined => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/u);
  return match === null ? undefined : match.slice(1, 4).map(Number);
};

export const satisfiesProviderVersion = (version: string, requirement: string): boolean => {
  if (!requirement.startsWith("^")) return version === requirement;
  const actual = parseCoreVersion(version);
  const minimum = parseCoreVersion(requirement.slice(1));
  if (actual === undefined || minimum === undefined) return false;
  const [actualMajor = -1, actualMinor = -1, actualPatch = -1] = actual;
  const [minimumMajor = -1, minimumMinor = -1, minimumPatch = -1] = minimum;
  return (
    actualMajor === minimumMajor &&
    (actualMinor > minimumMinor || (actualMinor === minimumMinor && actualPatch >= minimumPatch))
  );
};

export const validateProviderDependencies = (
  manifest: CapabilityProviderManifest,
  installed: readonly CapabilityProviderManifest[],
): readonly string[] => {
  const installedById = new Map(installed.map((provider) => [provider.id, provider]));
  return (manifest.dependencies ?? []).flatMap((dependency) => {
    const found = installedById.get(dependency.id);
    return found !== undefined && satisfiesProviderVersion(found.version, dependency.version)
      ? []
      : [`Missing compatible dependency ${dependency.id}@${dependency.version}.`];
  });
};

export const createCapabilityAdapter = <TRequest, TResult>(
  kind: CapabilityProviderKind,
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => Object.freeze({ kind, invoke });

export const createModelCapabilityAdapter = <TRequest, TResult>(
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => createCapabilityAdapter("model", invoke);

export const createAgentCapabilityAdapter = <TRequest, TResult>(
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => createCapabilityAdapter("agent", invoke);

export const createClientCapabilityAdapter = <TRequest, TResult>(
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => createCapabilityAdapter("client", invoke);

export const createStorageCapabilityAdapter = <TRequest, TResult>(
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => createCapabilityAdapter("storage", invoke);

export const createHistoryCapabilityAdapter = <TRequest, TResult>(
  invoke: (request: TRequest) => Promise<TResult>,
): CapabilityAdapter<TRequest, TResult> => createCapabilityAdapter("history", invoke);

export const createCapabilityCatalog = (
  inputEntries: readonly CapabilityCatalogEntry[],
): CapabilityCatalog => {
  const entries = inputEntries.map((entry) => {
    const problems = validateCapabilityProviderManifest(entry.manifest);
    if (problems.length > 0) throw new Error(`${entry.manifest.id}: ${problems.join(" ")}`);
    return structuredClone(entry);
  });
  const entryKeys = entries.map((entry) => `${entry.manifest.source}:${entry.manifest.id}`);
  if (new Set(entryKeys).size !== entryKeys.length) {
    throw new Error("A catalog source cannot contain duplicate provider identifiers.");
  }
  return {
    list: () => structuredClone(entries),
    resolve: (id, sourceOrder = ["enterprise", "local", "official"]) => {
      for (const source of sourceOrder) {
        const entry = entries.find(
          (candidate) => candidate.manifest.id === id && candidate.manifest.source === source,
        );
        if (entry !== undefined) return structuredClone(entry);
      }
      return undefined;
    },
  };
};

const readDeclaredId = (path: string, kind: "mcp" | "skill"): string => {
  const fallbackId = basename(resolve(path, ".."))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 128);
  const content = readFileSync(path, "utf8").slice(0, 65_536);
  if (kind === "mcp") {
    try {
      const metadata = JSON.parse(content) as { name?: unknown };
      if (typeof metadata.name === "string" && ID_PATTERN.test(metadata.name)) return metadata.name;
    } catch {
      return ID_PATTERN.test(fallbackId) ? fallbackId : "local-extension";
    }
  }
  const declaredName = content.match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu)?.[1]?.trim();
  return declaredName !== undefined && ID_PATTERN.test(declaredName)
    ? declaredName
    : ID_PATTERN.test(fallbackId)
      ? fallbackId
      : "local-extension";
};

export const discoverCapabilityExtensions = (
  options: ExtensionDiscoveryOptions,
): readonly DiscoveredExtension[] => {
  const maximumDepth = options.maximumDepth ?? 5;
  const maximumEntries = options.maximumEntries ?? 1_024;
  assertPositiveBound(maximumDepth, "maximumDepth", 16);
  assertPositiveBound(maximumEntries, "maximumEntries", 100_000);
  const discovered: DiscoveredExtension[] = [];
  let inspectedEntries = 0;

  for (const requestedRoot of options.roots) {
    if (!existsSync(requestedRoot)) continue;
    const root = realpathSync(requestedRoot);
    const visit = (directory: string, depth: number): void => {
      if (depth > maximumDepth || inspectedEntries >= maximumEntries) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        inspectedEntries += 1;
        if (inspectedEntries > maximumEntries) return;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) continue;
        const relativePath = relative(root, path);
        if (relativePath.startsWith(`..${sep}`) || relativePath === "..") continue;
        if (entry.isDirectory()) {
          visit(path, depth + 1);
          continue;
        }
        const kind =
          entry.name === "SKILL.md"
            ? "skill"
            : /^(?:\.mcp|mcp)\.json$/u.test(entry.name)
              ? "mcp"
              : undefined;
        if (kind !== undefined) discovered.push({ kind, id: readDeclaredId(path, kind), path });
      }
    };
    visit(root, 0);
  }
  return discovered.sort((left, right) => left.path.localeCompare(right.path));
};

const validatePermissions = (
  manifest: CapabilityProviderManifest,
  grantedPermissions: readonly CapabilityPermission[],
): void => {
  const granted = new Set(grantedPermissions);
  const denied = manifest.permissions.filter((permission) => !granted.has(permission));
  if (denied.length > 0)
    throw new Error(`Provider permissions were not granted: ${denied.join(", ")}.`);
};

const validateOutput = (result: CapabilityInvocationResult, maximumOutputBytes: number): void => {
  const outputBytes = Buffer.byteLength(JSON.stringify(result.output) ?? "null");
  if (outputBytes > maximumOutputBytes) {
    throw new Error(`Provider output exceeded the ${maximumOutputBytes}-byte limit.`);
  }
};

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Provider exceeded the ${timeoutMs}ms limit.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const createCapabilityRuntime = (options: CapabilityRuntimeOptions): CapabilityRuntime => {
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 120_000;
  const maximumInputBytes = options.maximumInputBytes ?? DEFAULT_INPUT_BYTES;
  const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  assertPositiveBound(maximumTimeoutMs, "maximumTimeoutMs", 3_600_000);
  assertPositiveBound(maximumInputBytes, "maximumInputBytes", 67_108_864);
  assertPositiveBound(maximumOutputBytes, "maximumOutputBytes", 67_108_864);
  return {
    invoke: async (provider, invocation) => {
      const problems = validateCapabilityProviderManifest(provider.manifest);
      if (problems.length > 0) throw new Error(problems.join(" "));
      validatePermissions(provider.manifest, options.grantedPermissions);
      if (!CAPABILITY_PATTERN.test(invocation.operation)) {
        throw new Error("Capability operations must use a safe non-empty identifier.");
      }
      const inputBytes = Buffer.byteLength(JSON.stringify(invocation.input) ?? "null");
      if (inputBytes > maximumInputBytes) {
        throw new Error(`Provider input exceeded the ${maximumInputBytes}-byte limit.`);
      }
      const timeoutMs = Math.min(invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS, maximumTimeoutMs);
      const outputBytes = Math.min(
        invocation.maximumOutputBytes ?? maximumOutputBytes,
        maximumOutputBytes,
      );
      const boundedInvocation = { ...invocation, timeoutMs, maximumOutputBytes: outputBytes };

      let result: CapabilityInvocationResult;
      if (provider.manifest.trust === "untrusted") {
        if (options.sandbox === undefined) {
          throw new Error("Untrusted providers require an attested extension sandbox.");
        }
        const sandboxResult = await withTimeout(
          options.sandbox.execute({ manifest: provider.manifest, invocation: boundedInvocation }),
          timeoutMs,
        );
        const attestation = sandboxResult.attestation;
        if (
          !attestation.isolated ||
          !attestation.processDenied ||
          !attestation.filesystemRestricted ||
          !attestation.networkRestricted
        ) {
          throw new Error("Extension sandbox attestation did not satisfy isolation policy.");
        }
        result = sandboxResult.result;
      } else {
        result = await withTimeout(provider.invoke(boundedInvocation), timeoutMs);
      }
      validateOutput(result, outputBytes);
      return result;
    },
  };
};

export const createThirdPartyAgentDelegate = (
  provider: CapabilityProviderImplementation,
  runtime: CapabilityRuntime,
  limits: ThirdPartyAgentLimits,
): ThirdPartyAgentDelegate => {
  if (provider.manifest.kind !== "agent") throw new Error("Delegation requires an Agent provider.");
  if (!provider.manifest.permissions.includes("agent.delegate")) {
    throw new Error("Agent providers must declare agent.delegate permission.");
  }
  assertPositiveBound(limits.maximumTurns, "maximumTurns", 1_000);
  assertPositiveBound(limits.maximumToolCalls, "maximumToolCalls", 10_000);
  assertPositiveBound(limits.timeoutMs, "timeoutMs", 3_600_000);
  assertPositiveBound(limits.maximumOutputBytes, "maximumOutputBytes", 67_108_864);
  return {
    delegate: (request) => {
      if (!request.goal.trim()) throw new Error("Delegated Agent goals must not be empty.");
      return runtime.invoke(provider, {
        operation: "agent.delegate",
        input: { goal: request.goal, context: request.context, limits },
        tenantId: request.tenantId,
        timeoutMs: limits.timeoutMs,
        maximumOutputBytes: limits.maximumOutputBytes,
      });
    },
  };
};

export const testCapabilityProvider = async (
  provider: CapabilityProviderImplementation,
  smokeInvocation?: CapabilityInvocation,
): Promise<ProviderTestReport> => {
  const problems = [...validateCapabilityProviderManifest(provider.manifest)];
  if (provider.manifest.integrity !== undefined && !verifyProviderIntegrity(provider.manifest)) {
    problems.push("Provider integrity verification failed.");
  }
  if (
    smokeInvocation !== undefined &&
    provider.manifest.trust === "trusted" &&
    problems.length === 0
  ) {
    try {
      const runtime = createCapabilityRuntime({
        grantedPermissions: provider.manifest.permissions,
        maximumTimeoutMs: Math.min(smokeInvocation.timeoutMs ?? 5_000, 5_000),
      });
      await runtime.invoke(provider, smokeInvocation);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "Provider smoke test failed.");
    }
  }
  return { passed: problems.length === 0, problems };
};

import {
  CONFIG_SCHEMA_VERSION,
  type ConfigurationMode,
  type TiduConfiguration,
} from "../config/index.js";
import type { ConfigCenterBootstrap } from "../config-center/index.js";
import { TiduError } from "../core/index.js";

export const DEFAULT_MANAGEMENT_ENDPOINT = "http://127.0.0.1:9639";

export interface DiagnosticCheck {
  /** Stable diagnostic check name. */
  name: "configuration" | "page" | "runtime";
  /** Whether this component responded as expected. */
  healthy: boolean;
  /** Short non-secret diagnostic detail. */
  detail: string;
}

export interface DiagnosticReport {
  /** Normalized management endpoint checked by the CLI. */
  endpoint: string;
  /** True only when every required component is healthy. */
  healthy: boolean;
  /** Individual runtime, configuration, and page results. */
  checks: readonly DiagnosticCheck[];
}

export interface SafeDiagnosticReport {
  /** Diagnostic schema identifier for issue-template compatibility. */
  schemaVersion: "tidu-diagnostic/1";
  /** Public package version that produced the report. */
  productVersion: string;
  /** Node.js runtime version without executable or installation paths. */
  nodeVersion: string;
  /** Operating-system family reported by Node.js. */
  platform: NodeJS.Platform;
  /** CPU architecture reported by Node.js. */
  architecture: string;
  /** Whether the checked endpoint is local or remote without exposing its hostname. */
  endpointScope: "local" | "remote";
  /** HTTP transport used by the checked endpoint. */
  endpointProtocol: "http:" | "https:";
  /** True only when every required component is healthy. */
  healthy: boolean;
  /** Sanitized component results that contain no credentials, paths, or user content. */
  checks: readonly DiagnosticCheck[];
}

export interface ConfigurationUpdate {
  /** Isolated draft mode to update. */
  mode: ConfigurationMode;
  /** Optional replacement profile identifier. */
  activeProfileId?: string;
  /** Optional replacement virtual-model display name. */
  virtualModelName?: string;
  /** Whether to activate the saved draft immediately after saving. */
  activate: boolean;
}

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") {
      return body.message;
    }
  } catch {
    // The status fallback below is sufficient when a response is not JSON.
  }
  return `Request failed with status ${response.status}.`;
};

const requestBootstrap = async (
  endpoint: string,
  path: string,
  init?: RequestInit,
): Promise<ConfigCenterBootstrap> => {
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new TiduError(
      "INTERNAL_ERROR",
      `Cannot reach ${endpoint}. Start the runtime or check --endpoint.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new TiduError("INTERNAL_ERROR", await parseErrorMessage(response));
  }
  return (await response.json()) as ConfigCenterBootstrap;
};

export const normalizeManagementEndpoint = (candidate?: string): string => {
  const endpointValue = candidate?.trim() || DEFAULT_MANAGEMENT_ENDPOINT;
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpointValue);
  } catch (error) {
    throw new TiduError("CONFIGURATION_INVALID", "Management endpoint must be a valid URL.", {
      cause: error,
    });
  }
  if (!(["http:", "https:"] as const).includes(endpointUrl.protocol as "http:" | "https:")) {
    throw new TiduError("CONFIGURATION_INVALID", "Management endpoint must use HTTP or HTTPS.");
  }
  if (endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Management endpoint cannot contain credentials, query parameters, or fragments.",
    );
  }
  return endpointUrl.toString().replace(/\/$/u, "");
};

export const loadConfiguration = (endpoint: string): Promise<ConfigCenterBootstrap> =>
  requestBootstrap(endpoint, "/api/config-center");

export const saveConfiguration = async (
  endpoint: string,
  update: ConfigurationUpdate,
): Promise<ConfigCenterBootstrap> => {
  const bootstrap = await loadConfiguration(endpoint);
  const draft = bootstrap.configuration.workspace.drafts[update.mode];
  const configuration: TiduConfiguration = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeMode: update.mode,
    activeProfileId: update.activeProfileId ?? draft.configuration.activeProfileId,
    virtualModelName: update.virtualModelName ?? draft.configuration.virtualModelName,
    modelSelection: draft.configuration.modelSelection,
    ...(update.mode === "expert" && draft.configuration.expertServices !== undefined
      ? { expertServices: draft.configuration.expertServices }
      : {}),
  };
  const savedBootstrap = await requestBootstrap(
    endpoint,
    `/api/configuration/drafts/${update.mode}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: draft.revision, configuration }),
    },
  );
  if (!update.activate) {
    return savedBootstrap;
  }
  return requestBootstrap(endpoint, `/api/configuration/drafts/${update.mode}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedDraftRevision: savedBootstrap.configuration.workspace.drafts[update.mode].revision,
    }),
  });
};

export const diagnoseEndpoint = async (endpoint: string): Promise<DiagnosticReport> => {
  const check = async (
    name: DiagnosticCheck["name"],
    path: string,
    validate: (response: Response) => Promise<Pick<DiagnosticCheck, "detail" | "healthy">>,
  ): Promise<DiagnosticCheck> => {
    try {
      const response = await fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        return { name, healthy: false, detail: `HTTP ${response.status}` };
      }
      return { name, ...(await validate(response)) };
    } catch {
      return { name, healthy: false, detail: "unreachable" };
    }
  };
  const checks = await Promise.all([
    check("runtime", "/health", async (response) => {
      const body = (await response.json()) as {
        status?: unknown;
        storage?: { provider?: unknown; schemaVersion?: unknown };
      };
      return {
        healthy: body.status === "ok",
        detail: `${String(body.status ?? "unknown")} · ${String(body.storage?.provider ?? "unknown")} schema ${String(body.storage?.schemaVersion ?? "unknown")}`,
      };
    }),
    check("configuration", "/api/config-center", async (response) => {
      const body = (await response.json()) as ConfigCenterBootstrap;
      return {
        healthy: body.runtime.status === "ok" && body.configuration.editable,
        detail: `ok · ${body.configuration.workspace.active.configuration.activeMode} active`,
      };
    }),
    check("page", "/", async (response) => {
      const contentType = response.headers.get("content-type") ?? "unknown";
      return contentType.startsWith("text/html")
        ? { healthy: true, detail: "ok · HTML available" }
        : { healthy: false, detail: `unexpected ${contentType}` };
    }),
  ]);
  return { endpoint, healthy: checks.every((item) => item.healthy), checks };
};

export const createSafeDiagnosticReport = (
  report: DiagnosticReport,
  productVersion: string,
): SafeDiagnosticReport => {
  const endpointUrl = new URL(report.endpoint);
  const localHostnames = new Set(["127.0.0.1", "::1", "localhost"]);
  return {
    schemaVersion: "tidu-diagnostic/1",
    productVersion,
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    endpointScope: localHostnames.has(endpointUrl.hostname) ? "local" : "remote",
    endpointProtocol: endpointUrl.protocol as "http:" | "https:",
    healthy: report.healthy,
    checks: report.checks,
  };
};

export const formatConfiguration = (bootstrap: ConfigCenterBootstrap): string => {
  const { workspace } = bootstrap.configuration;
  const active = workspace.active.configuration;
  return [
    `Active: ${active.activeMode} · ${active.activeProfileId} · ${active.virtualModelName}`,
    `Managed draft: r${workspace.drafts.managed.revision} · ${workspace.drafts.managed.configuration.activeProfileId} · ${workspace.drafts.managed.configuration.virtualModelName}`,
    `Expert draft: r${workspace.drafts.expert.revision} · ${workspace.drafts.expert.configuration.activeProfileId} · ${workspace.drafts.expert.configuration.virtualModelName}`,
  ].join("\n");
};

import type { LocalClientDiscovery } from "../clients/index.js";
import type { EnterpriseGuidance } from "../enterprise/index.js";
import type { ProviderDescriptor } from "../providers/index.js";
import type { ConfigurationWorkspace } from "../storage/index.js";

export interface ConfigCenterBootstrap {
  /** Runtime installation edition selected at startup. */
  deployment: "personal" | "enterprise";
  /** Public product identity displayed by the local configuration center. */
  product: {
    /** Product name. */
    name: string;
    /** Short product explanation. */
    explanation: string;
    /** Product positioning statement. */
    positioning: string;
    /** Running package version. */
    version: string;
  };
  /** Current local runtime state. */
  runtime: {
    /** Runtime health state. */
    status: "ok";
    /** Path of the active runtime entry point. */
    installationLocation: string;
    /** Bound network interface for the running control service. */
    host: string;
    /** Bound TCP port for the running control service. */
    port: number;
    /** Browser-accessible origin of the running control service. */
    origin: string;
    /** Public runtime services currently exposed by this process. */
    services: readonly {
      /** Stable service identifier. */
      id: "agent-tasks" | "chat-completions" | "configuration-center" | "health" | "responses";
      /** Human-readable service name. */
      name: string;
      /** HTTP route exposed by this service. */
      path: string;
      /** Whether the active configuration exposes this service. */
      enabled: boolean;
    }[];
    /** Active provider state without credentials or endpoint details. */
    provider: {
      /** Whether inference can be routed to a provider. */
      configured: boolean;
      /** Selected provider adapter, or null when routing is not configured. */
      type: ProviderDescriptor["type"] | null;
      /** Selected upstream model, or null when routing is not configured. */
      model: string | null;
    };
  };
  /** Current storage adapter state. */
  storage: {
    /** Active storage provider identifier. */
    provider: string;
    /** Active database or storage location. */
    location: string;
    /** Active storage schema version. */
    schemaVersion: string;
    /** Non-sensitive table inventory for the active database. */
    tables: readonly {
      /** Physical table name. */
      name: string;
      /** Current number of persisted rows. */
      rowCount: number;
    }[];
    /** Storage health state. */
    status: "ok";
    /** SQLite runs in-process and does not expose a database network service. */
    connectionMode: "embedded";
    /** Database host; null for embedded SQLite. */
    host: null;
    /** Database port; null for embedded SQLite. */
    port: null;
    /** Database service process; null because SQLite is linked into the runtime. */
    service: null;
  };
  /** Isolated drafts and the explicitly activated runtime configuration. */
  configuration: {
    /** Whether validated draft editing is available. */
    editable: boolean;
    /** Persisted active configuration and mode-specific drafts. */
    workspace: ConfigurationWorkspace;
  };
  /** Metadata-only discovery of supported clients on the runtime device. */
  clients: LocalClientDiscovery;
  /** Enterprise-pilot state; disabled for a personal-only runtime. */
  enterprise: {
    /** Whether an enterprise control plane is attached. */
    enabled: boolean;
    /** Source of the visible company configuration. */
    source: "local-control-plane" | "remote" | null;
    /** Company runtime URL saved by the employee, or null on enterprise servers. */
    endpoint: string | null;
    /** Company name published by the connected runtime. */
    companyName: string | null;
    /** Read-only company virtual-model identifier. */
    virtualModelId: string | null;
    /** Read-only company virtual-model name. */
    virtualModelName: string | null;
    /** ISO timestamp of the latest successful remote check. */
    checkedAt: string | null;
    /** Whether this installation may administer enterprise state. */
    editable: boolean;
    /** Published enterprise-state revision. */
    revision: number;
    /** Whether the one-time administrator key has been initialized. */
    administratorInitialized: boolean;
    /** Number of published mandatory and advisory policies. */
    policyCount: number;
    /** Number of discoverable internal capabilities. */
    capabilityCount: number;
    /** Number of configured enterprise and user-owned model resources. */
    resourceCount: number;
    /** Generated administrator and employee guidance, or null when disabled. */
    guidance: EnterpriseGuidance | null;
  };
}

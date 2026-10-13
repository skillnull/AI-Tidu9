import type { LocalClientDiscovery } from "../clients/index.js";
import type { EnterpriseGuidance } from "../enterprise/index.js";
import type { ProviderDescriptor } from "../providers/index.js";
import type { ConfigurationWorkspace } from "../storage/index.js";

export interface ConfigCenterBootstrap {
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
    /** Active storage schema version. */
    schemaVersion: string;
    /** Storage health state. */
    status: "ok";
  };
  /** Isolated drafts and the explicitly activated runtime configuration. */
  configuration: {
    /** Whether validated draft editing is available. */
    editable: true;
    /** Persisted active configuration and mode-specific drafts. */
    workspace: ConfigurationWorkspace;
  };
  /** Metadata-only discovery of supported clients on the runtime device. */
  clients: LocalClientDiscovery;
  /** Enterprise-pilot state; disabled for a personal-only runtime. */
  enterprise: {
    /** Whether an enterprise control plane is attached. */
    enabled: boolean;
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

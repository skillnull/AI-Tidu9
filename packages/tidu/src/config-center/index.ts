import { discoverLocalClients, type LocalClientDiscovery } from "../clients/index.js";
import { PRODUCT } from "../core/index.js";
import type { EnterpriseControlPlane } from "../enterprise/index.js";
import type { ProviderDescriptor } from "../providers/index.js";
import type { StorageAdapter } from "../storage/index.js";
import type { ConfigCenterBootstrap } from "./contracts.js";

export type { ConfigCenterBootstrap } from "./contracts.js";

export const createConfigCenterBootstrap = (
  storage: Pick<StorageAdapter, "configurationStore" | "provider" | "schemaVersion">,
  provider?: ProviderDescriptor,
  clients: LocalClientDiscovery = discoverLocalClients(),
  enterprise?: EnterpriseControlPlane,
): Promise<ConfigCenterBootstrap> => {
  return Promise.all([
    storage.configurationStore.loadWorkspace(),
    enterprise?.snapshot(),
    enterprise?.generateGuidance(),
  ]).then(([workspace, enterpriseState, guidance]) => ({
    clients,
    enterprise: {
      enabled: enterpriseState !== undefined,
      revision: enterpriseState?.revision ?? 0,
      administratorInitialized:
        enterpriseState?.administratorKey !== null && enterpriseState !== undefined,
      policyCount: enterpriseState?.policies.length ?? 0,
      capabilityCount: enterpriseState?.capabilities.length ?? 0,
      resourceCount: enterpriseState?.resources.length ?? 0,
      guidance: guidance ?? null,
    },
    configuration: {
      editable: true,
      workspace,
    },
    product: {
      name: PRODUCT.name,
      explanation: PRODUCT.explanation,
      positioning: PRODUCT.positioning,
      version: PRODUCT.version,
    },
    runtime: {
      status: "ok",
      provider: {
        configured: provider !== undefined,
        type: provider?.type ?? null,
        model: provider?.model ?? null,
      },
    },
    storage: {
      provider: storage.provider,
      schemaVersion: storage.schemaVersion,
      status: "ok",
    },
  }));
};

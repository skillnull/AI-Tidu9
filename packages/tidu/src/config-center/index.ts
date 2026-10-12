import { discoverLocalClients, type LocalClientDiscovery } from "../clients/index.js";
import { PRODUCT } from "../core/index.js";
import type { ProviderDescriptor } from "../providers/index.js";
import type { StorageAdapter } from "../storage/index.js";
import type { ConfigCenterBootstrap } from "./contracts.js";

export type { ConfigCenterBootstrap } from "./contracts.js";

export const createConfigCenterBootstrap = (
  storage: Pick<StorageAdapter, "configurationStore" | "provider" | "schemaVersion">,
  provider?: ProviderDescriptor,
  clients: LocalClientDiscovery = discoverLocalClients(),
): Promise<ConfigCenterBootstrap> => {
  return storage.configurationStore.loadWorkspace().then((workspace) => ({
    clients,
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

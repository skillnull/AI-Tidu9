import { PRODUCT } from "../core/index.js";
import type { StorageAdapter } from "../storage/index.js";
import type { ConfigCenterBootstrap } from "./contracts.js";

export type { ConfigCenterBootstrap } from "./contracts.js";

export const createConfigCenterBootstrap = (
  storage: Pick<StorageAdapter, "configurationStore" | "provider" | "schemaVersion">,
): Promise<ConfigCenterBootstrap> => {
  return storage.configurationStore.loadWorkspace().then((workspace) => ({
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
    },
    storage: {
      provider: storage.provider,
      schemaVersion: storage.schemaVersion,
      status: "ok",
    },
  }));
};

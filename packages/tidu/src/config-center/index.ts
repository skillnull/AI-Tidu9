import { createDefaultConfiguration } from "../config/index.js";
import { PRODUCT } from "../core/index.js";
import type { StorageAdapter } from "../storage/index.js";
import type { ConfigCenterBootstrap } from "./contracts.js";

export type { ConfigCenterBootstrap } from "./contracts.js";

export const createConfigCenterBootstrap = (
  storage: Pick<StorageAdapter, "provider" | "schemaVersion">,
): ConfigCenterBootstrap => {
  const configuration = createDefaultConfiguration();

  return {
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
    configuration: {
      activeMode: configuration.activeMode,
      editable: false,
      schemaVersion: configuration.schemaVersion,
      virtualModelName: configuration.virtualModelName,
    },
  };
};

export type CapabilityAssetKind = "agent" | "knowledge" | "mcp" | "skill" | "tool";
export type CapabilityAssetPrivacy = "external" | "local" | "private";

export interface CapabilityAsset {
  /** Stable asset identifier used by plans and diagnostics. */
  id: string;
  /** Asset category used to assemble heterogeneous capabilities. */
  kind: CapabilityAssetKind;
  /** Concise non-sensitive description exposed to the planner. */
  description: string;
  /** Capability identifiers provided by this asset. */
  capabilities: readonly string[];
  /** Whether the asset may be selected for new tasks. */
  enabled: boolean;
  /** Highest data boundary the asset requires. */
  privacy: CapabilityAssetPrivacy;
  /** Relative selection cost; zero represents a free local asset. */
  cost: number;
}

export interface CapabilityAssemblyRequest {
  /** Capabilities required by the current task understanding. */
  requiredCapabilities: readonly string[];
  /** Maximum number of assets that may be assembled. */
  maximumAssets?: number;
  /** Most permissive privacy boundary allowed by the task. */
  privacy?: CapabilityAssetPrivacy;
}

export interface CapabilityAssembly {
  /** Assets selected to cover the requested capabilities. */
  assets: readonly CapabilityAsset[];
  /** Requested capabilities covered by the selected assets. */
  coveredCapabilities: readonly string[];
  /** Requested capabilities that could not be assembled. */
  missingCapabilities: readonly string[];
}

export interface CapabilityRegistry {
  /** Returns immutable metadata for all registered assets. */
  list: () => readonly CapabilityAsset[];
  /** Selects a bounded low-cost set of assets for one task. */
  assemble: (request: CapabilityAssemblyRequest) => CapabilityAssembly;
}

const ASSET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const CAPABILITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const PRIVACY_RANK: Readonly<Record<CapabilityAssetPrivacy, number>> = {
  local: 0,
  private: 1,
  external: 2,
};

const normalizeCapabilities = (capabilities: readonly string[]): readonly string[] => {
  const normalized = [...new Set(capabilities.map((capability) => capability.trim()))];
  if (normalized.some((capability) => !CAPABILITY_PATTERN.test(capability))) {
    throw new Error("Capability identifiers must use safe non-empty names.");
  }
  return normalized;
};

const validateAsset = (asset: CapabilityAsset): CapabilityAsset => {
  if (!ASSET_ID_PATTERN.test(asset.id)) {
    throw new Error("Capability assets require a safe stable identifier.");
  }
  if (!asset.description.trim() || asset.description.length > 512) {
    throw new Error("Capability asset descriptions must contain 1-512 characters.");
  }
  if (!Number.isFinite(asset.cost) || asset.cost < 0) {
    throw new Error("Capability asset cost must be a non-negative number.");
  }
  const capabilities = normalizeCapabilities(asset.capabilities);
  if (capabilities.length === 0) {
    throw new Error("Capability assets must provide at least one capability.");
  }
  return Object.freeze({ ...asset, capabilities, description: asset.description.trim() });
};

export const createCapabilityRegistry = (
  inputAssets: readonly CapabilityAsset[],
): CapabilityRegistry => {
  const assets = inputAssets.map(validateAsset);
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error("Capability asset identifiers must be unique.");
  }

  return {
    list: () => structuredClone(assets),
    assemble: (request) => {
      const requiredCapabilities = normalizeCapabilities(request.requiredCapabilities);
      const maximumAssets = request.maximumAssets ?? 16;
      if (!Number.isSafeInteger(maximumAssets) || maximumAssets < 1 || maximumAssets > 64) {
        throw new Error("maximumAssets must be an integer from 1 to 64.");
      }
      const allowedPrivacyRank = PRIVACY_RANK[request.privacy ?? "external"];
      const candidates = assets.filter(
        (asset) => asset.enabled && PRIVACY_RANK[asset.privacy] <= allowedPrivacyRank,
      );
      const missing = new Set(requiredCapabilities);
      const selected: CapabilityAsset[] = [];

      while (missing.size > 0 && selected.length < maximumAssets) {
        const ranked = candidates
          .filter((asset) => !selected.some((selectedAsset) => selectedAsset.id === asset.id))
          .map((asset) => ({
            asset,
            coverage: asset.capabilities.filter((capability) => missing.has(capability)).length,
          }))
          .filter((candidate) => candidate.coverage > 0)
          .sort(
            (left, right) =>
              right.coverage - left.coverage ||
              left.asset.cost - right.asset.cost ||
              left.asset.id.localeCompare(right.asset.id),
          );
        const nextAsset = ranked[0]?.asset;
        if (nextAsset === undefined) {
          break;
        }
        selected.push(nextAsset);
        for (const capability of nextAsset.capabilities) {
          missing.delete(capability);
        }
      }

      return {
        assets: structuredClone(selected),
        coveredCapabilities: requiredCapabilities.filter((capability) => !missing.has(capability)),
        missingCapabilities: requiredCapabilities.filter((capability) => missing.has(capability)),
      };
    },
  };
};

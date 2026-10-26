import type { AgentHostId, ModelSelection } from "../../src/config/index.js";

export interface CatalogModel {
  /** Provider-owned execution identifier. */
  id: string;
  /** Provider-owned user-facing model name. */
  name: string;
  /** Whether the provider selected this model by default. */
  isDefault?: boolean;
  /** Capabilities published for this model. */
  capabilities?: readonly string[];
  /** Evidence source for the capability declaration. */
  capabilitySource?: "company-published" | "effective-route" | "host-catalog" | "provider-catalog";
  /** Published input price per million tokens. */
  inputCostPerMillionTokens?: number | null;
  /** Published output price per million tokens. */
  outputCostPerMillionTokens?: number | null;
}

export interface UpstreamModelCatalog {
  /** Whether a company provider is active in this runtime. */
  companyConfigured: boolean;
  /** Concrete company adapter hidden behind the runtime router. */
  companyProviderType: "ollama" | "openai-compatible" | null;
  /** Company-provider models available behind the virtual model. */
  company: readonly CatalogModel[];
  /** Official Codex models available to the signed-in account. */
  official: readonly CatalogModel[];
  /** Models grouped by the host that can actually execute them. */
  hosts: Record<AgentHostId, { available: boolean; models: readonly CatalogModel[] }>;
}

export const catalogModelName = (
  models: readonly Pick<CatalogModel, "id" | "name" | "isDefault">[],
  modelId: string,
): string | undefined =>
  (modelId === "current"
    ? (models.find((model) => model.isDefault) ?? models[0])
    : models.find((model) => model.id === modelId)
  )?.name;

export const modelDisplayName = ({
  catalog,
  currentName,
  host,
  selection,
}: {
  catalog: UpstreamModelCatalog | undefined;
  currentName: string;
  host: AgentHostId | undefined;
  selection: ModelSelection;
}): string => {
  if (selection.source === "custom") return selection.model;
  const models =
    selection.source === "company"
      ? [
          ...(host === undefined ? [] : (catalog?.hosts[host].models ?? [])),
          ...(catalog?.company ?? []),
        ]
      : host === undefined
        ? (catalog?.official ?? [])
        : (catalog?.hosts[host].models ?? []);
  const publishedName = catalogModelName(models, selection.model);
  if (publishedName !== undefined) return publishedName;
  if (selection.model === "current") return currentName;
  return selection.model.replace(/\[[^\]]*\]$/u, "");
};

export const agentHostForProviderType = (
  providerType: string | null | undefined,
): AgentHostId | undefined =>
  providerType === "codex-host"
    ? "codex"
    : providerType === "cursor-host"
      ? "cursor"
      : providerType === "ollama"
        ? "ollama"
        : providerType === "openai-compatible"
          ? "openai-compatible"
          : undefined;

export const modelSourceForHost = (host: AgentHostId): ModelSelection["source"] =>
  host === "codex" || host === "cursor" ? "official" : "company";

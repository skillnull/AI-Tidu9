import { discoverLocalClients, type LocalClientDiscovery } from "../clients/index.js";
import { PRODUCT } from "../core/index.js";
import type { EnterpriseControlPlane } from "../enterprise/index.js";
import type { ProviderDescriptor } from "../providers/index.js";
import type { StorageAdapter } from "../storage/index.js";
import type { ConfigCenterBootstrap } from "./contracts.js";

export type { ConfigCenterBootstrap } from "./contracts.js";

export const createConfigCenterBootstrap = (
  storage: Pick<StorageAdapter, "configurationStore" | "provider" | "schemaVersion" | "tables"> &
    Partial<Pick<StorageAdapter, "enterpriseConnectionStore">> & {
      location?: string;
    },
  provider?: ProviderDescriptor,
  clients: LocalClientDiscovery = discoverLocalClients(),
  enterprise?: EnterpriseControlPlane,
  deployment: "personal" | "enterprise" = "personal",
  runtimeNetwork: { host: string; port: number } = { host: "127.0.0.1", port: 9639 },
): Promise<ConfigCenterBootstrap> => {
  return Promise.all([
    storage.configurationStore.loadWorkspace(),
    enterprise?.snapshot(),
    enterprise?.generateGuidance(),
    storage.enterpriseConnectionStore?.load(),
  ]).then(([workspace, enterpriseState, guidance, enterpriseConnection]) => {
    const expertServices = workspace.active.configuration.expertServices;
    const remoteConnection = deployment === "personal" ? enterpriseConnection : null;
    const connected = enterpriseState !== undefined || remoteConnection !== null;
    return {
      deployment,
      clients,
      enterprise: {
        enabled: connected,
        source:
          enterpriseState !== undefined
            ? "local-control-plane"
            : remoteConnection !== null
              ? "remote"
              : null,
        endpoint: remoteConnection?.endpoint ?? null,
        companyName: remoteConnection?.companyName ?? null,
        virtualModelId: remoteConnection?.virtualModelId ?? null,
        virtualModelName: remoteConnection?.virtualModelName ?? null,
        checkedAt: remoteConnection?.checkedAt ?? null,
        editable: deployment === "enterprise" && enterpriseState !== undefined,
        revision: enterpriseState?.revision ?? remoteConnection?.revision ?? 0,
        administratorInitialized:
          enterpriseState?.administratorKey !== null && enterpriseState !== undefined,
        policyCount: enterpriseState?.policies.length ?? remoteConnection?.policyCount ?? 0,
        capabilityCount:
          enterpriseState?.capabilities.length ?? remoteConnection?.capabilityCount ?? 0,
        resourceCount: enterpriseState?.resources.length ?? remoteConnection?.resourceCount ?? 0,
        guidance:
          guidance === undefined && remoteConnection === null
            ? null
            : guidance === undefined
              ? {
                  version: remoteConnection?.revision ?? 0,
                  administrator: [],
                  employee: [...(remoteConnection?.employeeGuidance ?? [])],
                }
              : deployment === "personal"
                ? { ...guidance, administrator: [] }
                : guidance,
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
        installationLocation: process.argv[1] ?? process.execPath,
        host: runtimeNetwork.host,
        port: runtimeNetwork.port,
        origin: `http://${runtimeNetwork.host}:${runtimeNetwork.port}`,
        services: [
          {
            id: "configuration-center",
            name: "Configuration Center",
            path: "/",
            enabled: true,
          },
          { id: "health", name: "Health", path: "/health", enabled: true },
          {
            id: "responses",
            name: "OpenAI Responses API",
            path: "/v1/responses",
            enabled: expertServices?.responsesApiEnabled ?? true,
          },
          {
            id: "chat-completions",
            name: "OpenAI Chat Completions API",
            path: "/v1/chat/completions",
            enabled: expertServices?.chatCompletionsApiEnabled ?? true,
          },
          {
            id: "agent-tasks",
            name: "Agent Task API",
            path: "/api/tasks",
            enabled: expertServices?.taskApiEnabled ?? true,
          },
        ],
        provider: {
          configured: provider !== undefined,
          type: provider?.type ?? null,
          model: provider?.model ?? null,
        },
      },
      storage: {
        provider: storage.provider,
        location: storage.location ?? "unknown",
        schemaVersion: storage.schemaVersion,
        tables: storage.tables ?? [],
        status: "ok",
        connectionMode: "embedded",
        host: null,
        port: null,
        service: null,
      },
    };
  });
};

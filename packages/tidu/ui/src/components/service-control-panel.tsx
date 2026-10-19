import { useCallback, useEffect, useState } from "react";

type ServiceAction = "refresh" | "restart" | "start" | "stop";

interface ServiceEntry {
  /** Actions currently supported by this service. */
  actions: readonly ServiceAction[];
  /** Command used to enter or manage this service. */
  command: string;
  /** Runtime configuration or persistent configuration-storage path. */
  configurationPath: string;
  /** HTTP runtime endpoint used by this service. */
  endpoint: string;
  /** Stable service identifier. */
  id: string;
  /** Service role. */
  kind: "api" | "cli" | "frontend";
  /** Whether the service is persistent or invoked on demand. */
  lifecycle: "managed" | "on-demand";
  /** Current terminal or absolute file receiving this service's logs. */
  logLocation: string;
  /** User-facing service name. */
  name: string;
  /** Active process identifier, or null when stopped. */
  processId: number | null;
  /** Active reverse-proxy configuration path, or null when no proxy is configured. */
  proxyConfigurationPath: string | null;
  /** Current service state. */
  status: "ready" | "running" | "stopped";
  /** Service package version. */
  version: string;
}

interface ServiceDiagnostic {
  /** Stable diagnostic identifier. */
  id: "network" | "process" | "provider" | "storage";
  /** Diagnostic result detail. */
  message: string;
  /** Latest diagnostic outcome. */
  status: "passed" | "warning";
}

interface ServiceInventory {
  /** Time at which the snapshot was generated. */
  checkedAt: string;
  /** Core non-secret runtime information. */
  environment: {
    /** Selected upstream source and model. */
    activeModel: string;
    /** Public runtime endpoint. */
    endpoint: string;
    /** Node.js version. */
    nodeVersion: string;
    /** Operating-system platform. */
    platform: string;
    /** Active provider adapter. */
    providerType: string;
    /** Storage adapter and schema. */
    storage: string;
    /** Runtime uptime in seconds. */
    uptimeSeconds: number;
    /** AI-Tidu9 version. */
    version: string;
  };
  /** Mutually exclusive runtime shape detected for this page. */
  mode: "development" | "installed";
  /** Latest runtime checks. */
  diagnostics: readonly ServiceDiagnostic[];
  /** Services belonging to the active runtime shape. */
  services: readonly ServiceEntry[];
}

interface ServiceActionResponse {
  /** Follow-up command when the operation needs terminal control. */
  command?: string;
  /** Stable error code. */
  error?: string;
  /** Completed operation result. */
  result?: {
    /** Completion time. */
    checkedAt: string;
    /** Human-readable result. */
    message: string;
    /** Final outcome. */
    status: "failed" | "passed";
  };
}

const actionLabels = {
  en: { refresh: "Refresh", restart: "Restart", start: "Start", stop: "Stop" },
  zh: { refresh: "刷新", restart: "重启", start: "启动", stop: "停止" },
} as const;

const actionProgressLabels = {
  en: { restart: "Restarting…", start: "Starting…", stop: "Stopping…" },
  zh: { restart: "重启中…", start: "启动中…", stop: "停止中…" },
} as const;

const formatUptime = (seconds: number, english: boolean): string => {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return english ? `${hours}h ${minutes}m` : `${hours} 小时 ${minutes} 分钟`;
};

export const ServiceControlPanel = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
  const english = locale === "en-US";
  const labels = english ? actionLabels.en : actionLabels.zh;
  const progressLabels = english ? actionProgressLabels.en : actionProgressLabels.zh;
  const [inventory, setInventory] = useState<ServiceInventory>();
  const [pending, setPending] = useState<string>();

  const refresh = useCallback(async () => {
    setPending("inventory:refresh");
    try {
      const response = await fetch("/api/services", { cache: "no-store" });
      if (!response.ok) throw new Error("Service inventory unavailable");
      setInventory((await response.json()) as ServiceInventory);
    } catch {
      // Keep the previous snapshot when the service manager is temporarily unavailable.
    } finally {
      setPending(undefined);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const waitForAction = async (
    service: ServiceEntry,
    action: Exclude<ServiceAction, "refresh">,
  ): Promise<ServiceInventory | undefined> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      try {
        const response = await fetch("/api/services", { cache: "no-store" });
        if (!response.ok) continue;
        const nextInventory = (await response.json()) as ServiceInventory;
        const nextService = nextInventory.services.find((entry) => entry.id === service.id);
        const actionCompleted =
          action === "stop"
            ? nextService?.status === "stopped"
            : nextService?.status === "running" &&
              (action !== "restart" || nextService.processId !== service.processId);
        if (actionCompleted) return nextInventory;
      } catch {
        // A restarted frontend can briefly interrupt its own proxy connection.
      }
    }
    return undefined;
  };

  const runAction = async (service: ServiceEntry, action: ServiceAction) => {
    const operationId = `${service.id}:${action}`;
    setPending(operationId);
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(service.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json().catch(() => ({}))) as ServiceActionResponse &
        Partial<ServiceInventory>;
      if (!response.ok) throw new Error(result.command ?? result.error ?? "Service action failed");
      const completedInventory =
        action === "refresh" ? undefined : await waitForAction(service, action);
      const refreshedInventory =
        completedInventory ??
        (result.services && result.environment
          ? (result as ServiceInventory)
          : await fetch("/api/services", { cache: "no-store" }).then(async (inventoryResponse) =>
              inventoryResponse.ok
                ? ((await inventoryResponse.json()) as ServiceInventory)
                : inventory,
            ));
      if (refreshedInventory) setInventory(refreshedInventory);
    } catch {
      // Keep the current snapshot; the next manual refresh can retry the request.
    } finally {
      setPending(undefined);
    }
  };

  const environmentRows = inventory
    ? [
        [english ? "Version" : "九门版本", inventory.environment.version],
        [
          english ? "Uptime" : "运行时长",
          formatUptime(inventory.environment.uptimeSeconds, english),
        ],
        [
          english ? "Runtime" : "运行环境",
          `${inventory.environment.nodeVersion} · ${inventory.environment.platform}`,
        ],
        [
          english ? "Last refreshed" : "最近刷新",
          new Date(inventory.checkedAt).toLocaleTimeString(locale),
        ],
      ]
    : [];

  return (
    <section className="service-control-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">SERVICE CONTROL</p>
          <h2>{english ? "Runtime services" : "运行服务"}</h2>
          <p>
            {inventory?.mode === "development"
              ? english
                ? "Development processes and service status"
                : "开发进程与服务状态"
              : english
                ? "Installed processes and service status"
                : "安装进程与服务状态"}
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={pending !== undefined}>
          {pending === "inventory:refresh" ? (english ? "Refreshing…" : "刷新中…") : labels.refresh}
        </button>
      </div>

      <div className="service-environment-grid">
        {environmentRows.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong title={value}>{value}</strong>
          </div>
        ))}
      </div>

      <div className="service-control-list">
        {inventory?.services.map((service) => {
          const activeAction = service.actions.find(
            (action) => action !== "refresh" && pending === `${service.id}:${action}`,
          ) as Exclude<ServiceAction, "refresh"> | undefined;
          return (
            <article key={service.id}>
              <div className="service-control-identity">
                <h3>{service.name}</h3>
                <p>
                  {service.id} ·{" "}
                  {service.kind === "frontend"
                    ? english
                      ? "Frontend development service"
                      : "前端服务"
                    : service.kind === "cli"
                      ? english
                        ? "CLI service"
                        : "CLI 服务"
                      : inventory.mode === "development"
                        ? english
                          ? "Local API service"
                          : "本地接口服务"
                        : english
                          ? "Installed or remote API service"
                          : "安装或远程接口服务"}
                </p>
                <dl>
                  <div>
                    <dt>{english ? "Mode" : "运行方式"}</dt>
                    <dd>
                      {service.lifecycle === "managed"
                        ? english
                          ? "Managed process"
                          : "常驻进程"
                        : english
                          ? "On-demand command"
                          : "按需命令"}
                    </dd>
                  </div>
                  <div>
                    <dt>PID</dt>
                    <dd>
                      {service.processId ??
                        (service.lifecycle === "on-demand"
                          ? english
                            ? "On demand"
                            : "按需执行"
                          : english
                            ? "Not running"
                            : "未运行")}
                    </dd>
                  </div>
                  <div>
                    <dt>{english ? "Command" : "命令入口"}</dt>
                    <dd title={service.command}>{service.command}</dd>
                  </div>
                  <div>
                    <dt>{english ? "Endpoint" : "服务地址"}</dt>
                    <dd title={service.endpoint}>{service.endpoint}</dd>
                  </div>
                  <div>
                    <dt>{english ? "Version" : "版本"}</dt>
                    <dd>{service.version}</dd>
                  </div>
                  <div>
                    <dt>{english ? "Logs" : "日志位置"}</dt>
                    <dd title={service.logLocation}>{service.logLocation}</dd>
                  </div>
                  <div>
                    <dt>{english ? "Configuration" : "配置位置"}</dt>
                    <dd title={service.configurationPath}>{service.configurationPath}</dd>
                  </div>
                  <div>
                    <dt>{english ? "Proxy configuration" : "代理配置"}</dt>
                    <dd title={service.proxyConfigurationPath ?? undefined}>
                      {service.proxyConfigurationPath ?? (english ? "Not configured" : "未配置")}
                    </dd>
                  </div>
                </dl>
              </div>
              <span
                className={`service-control-status service-control-status-${activeAction ? "pending" : service.status}`}
              >
                {activeAction
                  ? progressLabels[activeAction]
                  : service.status === "running"
                    ? english
                      ? "Running"
                      : "运行中"
                    : service.status === "ready"
                      ? english
                        ? "Ready"
                        : "可用"
                      : english
                        ? "Stopped"
                        : "已停止"}
              </span>
              {service.actions.some((action) => ["restart", "start", "stop"].includes(action)) ? (
                <div className="service-control-actions">
                  {service.actions
                    .filter((action) => action !== "refresh")
                    .map((action) => (
                      <button
                        key={action}
                        type="button"
                        disabled={
                          pending !== undefined ||
                          (action === "start" && service.status !== "stopped") ||
                          ((action === "stop" || action === "restart") &&
                            service.status !== "running")
                        }
                        onClick={() => void runAction(service, action)}
                      >
                        {pending === `${service.id}:${action}`
                          ? progressLabels[action]
                          : labels[action]}
                      </button>
                    ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
};

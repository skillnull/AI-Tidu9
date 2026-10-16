import { useCallback, useEffect, useState } from "react";

type ServiceAction = "check" | "refresh" | "restart" | "start" | "stop";

interface ServiceEntry {
  /** Actions currently supported by this service. */
  actions: readonly ServiceAction[];
  /** Stable service identifier. */
  id: string;
  /** Whether this row represents the runtime or CLI entry. */
  kind: "cli" | "runtime";
  /** User-facing service name. */
  name: string;
  /** Active process identifier, or null for a command entry. */
  processId: number | null;
  /** Current service state. */
  status: "ready" | "running" | "stopped";
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

interface MonitorState {
  /** Operation currently shown in the monitor. */
  action: ServiceAction;
  /** Final or in-progress diagnostic rows. */
  diagnostics: readonly ServiceDiagnostic[];
  /** User-facing operation result. */
  message: string;
  /** Operation target. */
  serviceName: string;
  /** Operation lifecycle state. */
  status: "failed" | "running" | "success";
  /** Operation start time. */
  startedAt: string;
}

interface ServiceHistoryEntry extends MonitorState {
  /** Operation completion time. */
  completedAt: string;
  /** Operation duration in milliseconds. */
  durationMs: number;
  /** Stable client-generated record identifier. */
  recordId: string;
}

const SERVICE_HISTORY_KEY = "ai-tidu9.service-history.v1";
const SERVICE_HISTORY_LIMIT = 12;

const readServiceHistory = (): readonly ServiceHistoryEntry[] => {
  try {
    const stored = window.localStorage.getItem(SERVICE_HISTORY_KEY);
    if (stored === null) return [];
    const history = JSON.parse(stored) as unknown;
    if (!Array.isArray(history)) return [];
    return history
      .filter(
        (entry): entry is ServiceHistoryEntry =>
          typeof entry === "object" &&
          entry !== null &&
          "recordId" in entry &&
          typeof entry.recordId === "string" &&
          "action" in entry &&
          ["check", "refresh", "restart", "start", "stop"].includes(String(entry.action)) &&
          "diagnostics" in entry &&
          Array.isArray(entry.diagnostics) &&
          "message" in entry &&
          typeof entry.message === "string" &&
          "serviceName" in entry &&
          typeof entry.serviceName === "string" &&
          "status" in entry &&
          ["failed", "success"].includes(String(entry.status)) &&
          "startedAt" in entry &&
          typeof entry.startedAt === "string" &&
          "completedAt" in entry &&
          typeof entry.completedAt === "string" &&
          "durationMs" in entry &&
          typeof entry.durationMs === "number",
      )
      .slice(0, SERVICE_HISTORY_LIMIT);
  } catch {
    return [];
  }
};

const writeServiceHistory = (history: readonly ServiceHistoryEntry[]): void => {
  try {
    window.localStorage.setItem(SERVICE_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // The live monitor remains available when browser storage is unavailable.
  }
};

const actionLabels = {
  en: { check: "Check", refresh: "Refresh", restart: "Restart", start: "Start", stop: "Stop" },
  zh: { check: "检查", refresh: "刷新", restart: "重启", start: "启动", stop: "停止" },
} as const;

const diagnosticLabels = {
  en: { network: "Network", process: "Process", provider: "Model provider", storage: "Storage" },
  zh: { network: "网络监听", process: "运行进程", provider: "模型服务", storage: "数据存储" },
} as const;

const formatUptime = (seconds: number, english: boolean): string => {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return english ? `${hours}h ${minutes}m` : `${hours} 小时 ${minutes} 分钟`;
};

export const ServiceControlPanel = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
  const english = locale === "en-US";
  const labels = english ? actionLabels.en : actionLabels.zh;
  const checkLabels = english ? diagnosticLabels.en : diagnosticLabels.zh;
  const [inventory, setInventory] = useState<ServiceInventory>();
  const [pending, setPending] = useState<string>();
  const [monitor, setMonitor] = useState<MonitorState>();
  const [history, setHistory] = useState<readonly ServiceHistoryEntry[]>(readServiceHistory);

  const appendHistory = useCallback((entry: ServiceHistoryEntry) => {
    setHistory((current) => {
      const nextHistory = [entry, ...current].slice(0, SERVICE_HISTORY_LIMIT);
      writeServiceHistory(nextHistory);
      return nextHistory;
    });
  }, []);

  const refresh = useCallback(async () => {
    const startedAt = new Date().toISOString();
    setPending("inventory:refresh");
    setMonitor({
      action: "refresh",
      diagnostics: [],
      message: english ? "Reading runtime state…" : "正在读取运行时状态…",
      serviceName: english ? "Service manager" : "服务管理器",
      status: "running",
      startedAt,
    });
    try {
      const response = await fetch("/api/services", { cache: "no-store" });
      if (!response.ok) throw new Error("Service inventory unavailable");
      const nextInventory = (await response.json()) as ServiceInventory;
      setInventory(nextInventory);
      setMonitor({
        action: "refresh",
        diagnostics: nextInventory.diagnostics,
        message: english ? "Service status refresh completed." : "服务状态刷新完成。",
        serviceName: english ? "Service manager" : "服务管理器",
        status: nextInventory.diagnostics.some((item) => item.status === "warning")
          ? "failed"
          : "success",
        startedAt,
      });
    } catch {
      setMonitor({
        action: "refresh",
        diagnostics: [],
        message: english
          ? "The service manager is unavailable."
          : "服务管理器不可用，未能读取运行状态。",
        serviceName: english ? "Service manager" : "服务管理器",
        status: "failed",
        startedAt,
      });
    } finally {
      setPending(undefined);
    }
  }, [english]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (service: ServiceEntry, action: ServiceAction) => {
    const operationId = `${service.id}:${action}`;
    const startedAt = new Date().toISOString();
    setPending(operationId);
    setMonitor({
      action,
      diagnostics: [],
      message: english
        ? `Sending ${labels[action].toLowerCase()} request…`
        : `正在执行${labels[action]}操作…`,
      serviceName: service.name,
      status: "running",
      startedAt,
    });
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(service.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json().catch(() => ({}))) as ServiceActionResponse &
        Partial<ServiceInventory>;
      if (!response.ok) throw new Error(result.command ?? result.error ?? "Service action failed");
      if (action === "restart" || action === "start") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 800));
      } else if (action === "stop") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      const refreshedInventory =
        result.services && result.environment
          ? (result as ServiceInventory)
          : await fetch("/api/services", { cache: "no-store" }).then(async (inventoryResponse) =>
              inventoryResponse.ok
                ? ((await inventoryResponse.json()) as ServiceInventory)
                : inventory,
            );
      if (refreshedInventory) setInventory(refreshedInventory);
      const diagnostics = refreshedInventory?.diagnostics ?? [];
      const message =
        result.result?.message ??
        (english ? `${labels[action]} operation completed.` : `${labels[action]}操作已完成。`);
      const status =
        result.result?.status === "failed" ||
        diagnostics.some((diagnostic) => diagnostic.status === "warning")
          ? "failed"
          : "success";
      const completedAt = new Date().toISOString();
      const completedMonitor = {
        action,
        diagnostics,
        message,
        serviceName: service.name,
        status,
        startedAt,
      } satisfies MonitorState;
      setMonitor(completedMonitor);
      appendHistory({
        ...completedMonitor,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        recordId: `${Date.now()}-${service.id}-${action}`,
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "Service action failed";
      const failedMonitor = {
        action,
        diagnostics: [],
        message,
        serviceName: service.name,
        status: "failed",
        startedAt,
      } satisfies MonitorState;
      setMonitor(failedMonitor);
      appendHistory({
        ...failedMonitor,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        recordId: `${Date.now()}-${service.id}-${action}`,
      });
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
          english ? "Last checked" : "最近检测",
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
                ? "Development processes and health checks"
                : "开发进程与运行检测"
              : english
                ? "Installed processes and health checks"
                : "安装进程与运行检测"}
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
        {inventory?.services.map((service) => (
          <article key={service.id}>
            <div className="service-control-identity">
              <h3>{service.name}</h3>
              <p>
                {service.kind === "runtime"
                  ? english
                    ? "Runtime service"
                    : "运行时服务"
                  : english
                    ? "CLI entry"
                    : "CLI 命令入口"}
              </p>
            </div>
            <span className={`service-control-status service-control-status-${service.status}`}>
              {service.status === "running"
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
                      ((action === "stop" || action === "restart") && service.status !== "running")
                    }
                    onClick={() => void runAction(service, action)}
                  >
                    {pending === `${service.id}:${action}`
                      ? english
                        ? "Running…"
                        : "执行中…"
                      : labels[action]}
                  </button>
                ))}
            </div>
          </article>
        ))}
      </div>

      {monitor ? (
        <section className={`service-monitor service-monitor-${monitor.status}`} aria-live="polite">
          <div className="service-monitor-heading">
            <div>
              <span>{english ? "Operation monitor" : "操作监测"}</span>
              <h3>
                {monitor.serviceName} · {labels[monitor.action]}
              </h3>
            </div>
            <strong>
              {monitor.status === "running"
                ? english
                  ? "In progress"
                  : "进行中"
                : monitor.status === "success"
                  ? english
                    ? "Passed"
                    : "已通过"
                  : english
                    ? "Attention"
                    : "需要处理"}
            </strong>
          </div>
          {monitor.status === "running" ? (
            <div className="service-monitor-progress">
              <span />
            </div>
          ) : null}
          <ol>
            {(monitor.diagnostics.length > 0
              ? monitor.diagnostics
              : [
                  {
                    id: "process" as const,
                    message: monitor.message,
                    status:
                      monitor.status === "success" ? ("passed" as const) : ("warning" as const),
                  },
                ]
            ).map((diagnostic) => (
              <li key={diagnostic.id}>
                <span
                  className={`service-diagnostic-dot service-diagnostic-${diagnostic.status}`}
                />
                <div>
                  <strong>{checkLabels[diagnostic.id]}</strong>
                  <p>{diagnostic.message}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="service-monitor-result">
            {english ? "Result" : "结果"} · {monitor.message} ·{" "}
            {new Date(monitor.startedAt).toLocaleTimeString(locale)}
          </p>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="service-history" aria-label={english ? "Cached records" : "缓存记录"}>
          <div className="service-history-heading">
            <div>
              <span>{english ? "LOCAL CACHE" : "本地缓存"}</span>
              <h3>{english ? "Operation records" : "操作记录"}</h3>
            </div>
            <strong>
              {english ? `${history.length} recent records` : `最近 ${history.length} 条`}
            </strong>
          </div>
          <div className="service-history-list">
            {history.map((entry) => {
              const entryDiagnostics =
                entry.diagnostics.length > 0
                  ? entry.diagnostics
                  : [
                      {
                        id: "process" as const,
                        message: entry.message,
                        status: "warning" as const,
                      },
                    ];
              return (
                <article key={entry.recordId}>
                  <div className="service-history-summary">
                    <div>
                      <strong>
                        {entry.serviceName} · {labels[entry.action]}
                      </strong>
                      <span>
                        {new Date(entry.completedAt).toLocaleString(locale)} · {entry.durationMs}ms
                      </span>
                    </div>
                    <em className={`service-history-status service-history-status-${entry.status}`}>
                      {entry.status === "success"
                        ? english
                          ? "Passed"
                          : "已通过"
                        : english
                          ? "Attention"
                          : "需要处理"}
                    </em>
                  </div>
                  <ul>
                    {entryDiagnostics.map((diagnostic) => (
                      <li key={diagnostic.id}>
                        <span
                          className={`service-diagnostic-dot service-diagnostic-${diagnostic.status}`}
                        />
                        <div>
                          <strong>{checkLabels[diagnostic.id]}</strong>
                          <p>{diagnostic.message}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="service-history-result">{entry.message}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
};

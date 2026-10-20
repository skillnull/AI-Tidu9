import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskControlView } from "../../src/agent/index.js";
import type {
  AgentHostId,
  CapabilityCompletionConfiguration,
  CapabilitySpecialistConfiguration,
  ConfigurationMode,
  ExpertServiceConfiguration,
  ModelSelection,
  TiduConfiguration,
} from "../../src/config/index.js";
import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";

export interface EnterpriseMemberUsageReport {
  /** Published enterprise-state revision. */
  revision: number;
  /** Enterprise-funded pool totals for the current cycle. */
  totals: {
    /** Purchased units across enterprise pools. */
    capacity: number;
    /** Units still available across enterprise pools. */
    remaining: number;
    /** Units held by active reservations. */
    reserved: number;
    /** Units already settled. */
    settled: number;
  };
  /** Members registered with the enterprise control plane. */
  members: readonly {
    /** Stable enterprise identity identifier. */
    id: string;
    /** Name published for administrators. */
    displayName: string;
    /** Enterprise roles assigned to this identity. */
    roles: readonly string[];
    /** Enterprise-funded allocations directly assigned to this member's user scope. */
    allocations: readonly {
      /** Stable allocation identifier. */
      allocationId: string;
      /** Name of the funded model resource. */
      resourceName: string;
      /** Maximum units allocated to this user scope. */
      limit: number;
      /** Units settled for this user scope. */
      settled: number;
      /** Units currently reserved for this user scope. */
      reserved: number;
      /** Units left within this user allocation. */
      remaining: number;
    }[];
  }[];
}

export type LoadingState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: ConfigCenterBootstrap }
  | { status: "error"; message: string };

export type OperationState =
  | { status: "idle" }
  | { status: "pending"; action: "activate" | "rollback" | "save" | "simulate" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export type ClientConnectionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export interface ConfigurationForm {
  /** Stable lowercase identifier used to select this profile. */
  activeProfileId: string;
  /** User-facing virtual-model name exposed by compatible clients. */
  virtualModelName: string;
  /** Upstream selected behind the single virtual-model entry. */
  modelSelection: ModelSelection;
  /** Agent-level capability completion shared by every host. */
  capabilityCompletion: CapabilityCompletionConfiguration;
  /** Advanced runtime service controls available only in expert mode. */
  expertServices?: ExpertServiceConfiguration;
}

export interface EntryValidationMessages {
  /** Validation message for the required profile ID. */
  activeProfileId?: string;
  /** Validation message for the required virtual-model name. */
  virtualModelName?: string;
  /** Validation message for the expert runtime host. */
  expertHost?: string;
  /** Validation message for the expert runtime port. */
  expertPort?: string;
}

interface TaskListResponse {
  /** Whether the running service has an Agent kernel attached. */
  available: boolean;
  /** Bounded task summaries ordered by latest update. */
  tasks: readonly TaskControlView[];
}

interface CapabilityCompletionStatusResponse {
  /** Host currently backing the active primary model, when identifiable. */
  activeHost: AgentHostId | null;
  /** Whether capability completion can be executed by this runtime. */
  available: boolean;
  /** Whether the active policy has at least one usable specialist. */
  operational: boolean;
  /** Active capability-completion configuration. */
  configuration: CapabilityCompletionConfiguration;
  /** Active primary-model selection. */
  mainModel: ModelSelection;
  /** Recent bounded routing records. */
  records: readonly {
    /** Host that originated the request. */
    host: AgentHostId;
    /** ISO timestamp for this routing decision. */
    occurredAt: string;
    /** Agent role handled by the request. */
    role: string;
    /** Whether a specialist was invoked. */
    complemented: boolean;
    /** Final routing outcome. */
    outcome: "failed" | "succeeded";
    /** Primary model used for the request. */
    mainModelId: string;
    /** Specialist models used for the request. */
    specialistModelIds: readonly string[];
    /** Capabilities required by the request. */
    requiredCapabilities: readonly string[];
    /** Capabilities the primary model did not provide. */
    missingCapabilities: readonly string[];
  }[];
  /** Connected company capability summary. */
  company: { connected: boolean; publishedCapabilityCount: number };
  /** Host entry points exposed by the runtime. */
  hosts: readonly string[];
}

const MODEL_CAPABILITIES = [
  {
    id: "text",
    zh: "文本理解与生成",
    en: "Text",
    detail: "阅读、归纳与生成文本",
  },
  {
    id: "structured-output",
    zh: "结构化输出",
    en: "Structured output",
    detail: "稳定返回 JSON 等结构",
  },
  {
    id: "reasoning",
    zh: "复杂推理",
    en: "Reasoning",
    detail: "多步骤分析与决策",
  },
  { id: "code", zh: "代码工程", en: "Code", detail: "代码理解、修改与调试" },
  {
    id: "vision",
    zh: "视觉理解",
    en: "Vision",
    detail: "读取图片、截图与图表",
  },
  {
    id: "web-research",
    zh: "联网研究",
    en: "Web research",
    detail: "检索并整合外部资料",
  },
  {
    id: "tool-use",
    zh: "工具调用",
    en: "Tool use",
    detail: "调用工具并处理结果",
  },
  {
    id: "long-context",
    zh: "长上下文",
    en: "Long context",
    detail: "处理大型代码库或长文档",
  },
  {
    id: "document-analysis",
    zh: "文档分析",
    en: "Document analysis",
    detail: "解析复杂文档和表格",
  },
  {
    id: "domain-context",
    zh: "领域知识",
    en: "Domain context",
    detail: "使用公司或行业专有知识",
  },
  {
    id: "local-private",
    zh: "本地隐私",
    en: "Local private",
    detail: "数据不离开本地边界",
  },
] as const;

type CatalogModel = {
  id: string;
  name: string;
  isDefault?: boolean;
  capabilities?: readonly string[];
  capabilitySource?: "company-published" | "host-catalog" | "provider-catalog";
  inputCostPerMillionTokens?: number | null;
  outputCostPerMillionTokens?: number | null;
};

const capabilityLabel = (capability: string, english: boolean): string => {
  const item = MODEL_CAPABILITIES.find((candidate) => candidate.id === capability);
  return item ? (english ? item.en : item.zh) : capability;
};

const CapabilityPicker = ({
  selected,
  available,
  english,
  disabled,
  onChange,
}: {
  selected: readonly string[];
  available?: readonly string[];
  english: boolean;
  disabled: boolean;
  onChange: (capabilities: readonly string[]) => void;
}) => {
  const capabilityIds = available ?? selected;
  const options = [
    ...MODEL_CAPABILITIES,
    ...capabilityIds
      .filter((capability) => !MODEL_CAPABILITIES.some((item) => item.id === capability))
      .map((id) => ({ id, zh: id, en: id, detail: "自定义能力声明" })),
  ].filter((capability) => available === undefined || available.includes(capability.id));
  return (
    <div className="capability-picker">
      {options.map((capability) => {
        const checked = selected.includes(capability.id);
        return (
          <label className={checked ? "selected" : ""} key={capability.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter((item) => item !== capability.id)
                    : [...selected, capability.id],
                )
              }
            />
            <span>
              <strong>{english ? capability.en : capability.zh}</strong>
              <small>{english ? capability.id : capability.detail}</small>
            </span>
          </label>
        );
      })}
    </div>
  );
};

export const CapabilityCompletionPanel = ({
  locale,
  onEdit,
}: {
  locale: "en-US" | "zh-CN";
  onEdit: (host: AgentHostId) => void;
}) => {
  const english = locale === "en-US";
  const [status, setStatus] = useState<CapabilityCompletionStatusResponse>();
  const [catalog, setCatalog] = useState<UpstreamModelCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [message, setMessage] = useState(english ? "Loading…" : "正在读取…");
  const refresh = useCallback(async () => {
    setCatalogLoading(true);
    void fetch("/api/models/upstreams", { cache: "no-store" })
      .then(async (catalogResponse) => {
        if (!catalogResponse.ok) return;
        setCatalog((await catalogResponse.json()) as UpstreamModelCatalog);
      })
      .catch(() => undefined)
      .finally(() => setCatalogLoading(false));
    try {
      const response = await fetch("/api/capability-completion", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as CapabilityCompletionStatusResponse);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : english ? "Unavailable" : "读取失败");
    }
  }, [english]);
  const displayModel = (host: AgentHostId, selection: ModelSelection): string => {
    if (selection.model !== "current") return selection.model;
    return (
      catalog?.hosts[host].models.find((model) => model.isDefault)?.id ??
      (host === "cursor" ? "auto" : english ? "Default" : "默认模型")
    );
  };
  useEffect(() => void refresh(), [refresh]);
  return (
    <section className="capability-completion-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">AGENT CAPABILITY COMPLETION</p>
          <h2>{english ? "Capability completion" : "能力互补"}</h2>
          <p>
            {english
              ? "Codex, Cursor, CLI, and compatible APIs are entry points to one policy. The Agent invokes configured specialists only for capabilities the primary model lacks, then verifies the combined result."
              : "Codex、Cursor、CLI 与兼容 API 只是同一策略的入口。主模型缺少任务能力时，Agent 才调用已配置的专家模型补位，并对合并结果独立验收。"}
          </p>
        </div>
        <div className="configuration-view-actions">
          <button type="button" onClick={() => void refresh()}>
            {english ? "Refresh" : "刷新"}
          </button>
        </div>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {status ? (
        <>
          <div className="capability-host-policies">
            {(["codex", "cursor", "ollama", "openai-compatible"] as const).map((host) => {
              const configuredPolicy = status.configuration.hostPolicies?.[host];
              const policy =
                configuredPolicy ??
                (status.activeHost === host
                  ? {
                      mainModel: status.mainModel,
                      mainCapabilities: status.configuration.mainCapabilities,
                      specialists: status.configuration.specialists,
                      maximumSpecialists: status.configuration.maximumSpecialists,
                    }
                  : undefined);
              const configured = status.configuration.enabled && policy !== undefined;
              const operational =
                configured &&
                !catalogLoading &&
                policy.specialists.length > 0 &&
                policy.specialists.every((specialist) => {
                  const hostCatalog = catalog?.hosts[specialist.host];
                  if (hostCatalog?.available !== true) return false;
                  const catalogModel =
                    specialist.model === "current"
                      ? hostCatalog.models.some((model) => model.isDefault)
                        ? hostCatalog.models.find((model) => model.isDefault)
                        : undefined
                      : hostCatalog.models.find((model) => model.id === specialist.model);
                  return (catalogModel?.capabilities?.length ?? 0) > 0;
                });
              return (
                <article key={host}>
                  <div className="capability-host-policy-heading">
                    <div>
                      <strong>{host}</strong>
                      <span
                        className={
                          catalogLoading && configured
                            ? "disabled"
                            : operational
                              ? "enabled"
                              : configured
                                ? "warning"
                                : "disabled"
                        }
                      >
                        {catalogLoading && configured
                          ? english
                            ? "Verifying configuration"
                            : "正在验证配置"
                          : operational
                            ? english
                              ? "Completion enabled"
                              : "互补已开启"
                            : configured
                              ? english
                                ? "Completion not ready"
                                : "互补未就绪"
                              : english
                                ? "Completion disabled"
                                : "互补已关闭"}
                      </span>
                    </div>
                    <button type="button" onClick={() => onEdit(host)}>
                      {english ? "Quick configure" : "快速配置"}
                    </button>
                  </div>
                  {configured && policy ? (
                    <div className="capability-host-policy-details">
                      <div className="capability-host-model primary">
                        <div className="capability-host-model-heading">
                          <span>
                            {english ? "Primary" : "主模型"} · {host}
                          </span>
                          <strong>{displayModel(host, policy.mainModel)}</strong>
                        </div>
                        <div className="capability-host-model-capabilities">
                          <div>
                            {policy.mainCapabilities.length > 0 ? (
                              policy.mainCapabilities.map((capability) => (
                                <span key={capability}>{capabilityLabel(capability, english)}</span>
                              ))
                            ) : (
                              <small>{english ? "Not configured" : "未配置"}</small>
                            )}
                          </div>
                        </div>
                      </div>
                      {policy.specialists.length > 0 ? (
                        policy.specialists.map((specialist, index) => (
                          <div
                            className="capability-host-model specialist"
                            key={`${specialist.host}:${specialist.model}:${index}`}
                          >
                            <div className="capability-host-model-heading">
                              <span>
                                {english ? "Specialist" : "副模型"} · {specialist.host}
                              </span>
                              <strong>{displayModel(specialist.host, specialist)}</strong>
                            </div>
                            <div className="capability-host-model-capabilities">
                              <div>
                                {specialist.capabilities.length > 0 ? (
                                  specialist.capabilities.map((capability) => (
                                    <span key={capability}>
                                      {capabilityLabel(capability, english)}
                                    </span>
                                  ))
                                ) : (
                                  <small>{english ? "Not configured" : "未配置"}</small>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="capability-host-model specialist empty">
                          <div className="capability-host-model-heading">
                            <span>{english ? "Specialist" : "副模型"}</span>
                            <small>{english ? "Not configured" : "未配置"}</small>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          <div className="capability-records">
            <div className="capability-records-heading">
              <h3>{english ? "Recent use" : "最近使用记录"}</h3>
              <span>{english ? "Latest 50 in this runtime" : "当前运行时最近 50 条"}</span>
            </div>
            {status.records.length === 0 ? (
              <p>{english ? "No routing records yet." : "暂无互补调用记录。"}</p>
            ) : (
              status.records.map((record, index) => (
                <article key={`${record.occurredAt}:${index}`}>
                  <div>
                    <strong>
                      {record.complemented
                        ? english
                          ? "Complemented"
                          : "已补位"
                        : english
                          ? "Primary only"
                          : "仅主模型"}
                    </strong>
                    <span>{new Date(record.occurredAt).toLocaleString()}</span>
                  </div>
                  <p>
                    {english ? "Host" : "宿主"}：{record.host} · {english ? "Role" : "阶段"}：
                    {record.role} · {english ? "Required" : "所需能力"}：
                    {record.requiredCapabilities.join(", ")}
                  </p>
                  <p>
                    {english ? "Specialists" : "专家模型"}：
                    {record.specialistModelIds.join(", ") || "—"} ·{" "}
                    {record.outcome === "succeeded"
                      ? english
                        ? "Succeeded"
                        : "成功"
                      : english
                        ? "Failed"
                        : "失败"}
                  </p>
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </section>
  );
};

export interface ConfigurationImpactPreview {
  /** Whether the configuration passed validation. */
  valid: boolean;
  /** Configuration fields changed by activation. */
  changes: readonly string[];
  /** Activation risk classification. */
  risk: "low" | "medium";
  /** Validation issues blocking activation. */
  issues: readonly { code: string; field: string; message: string }[];
  /** Whether the runtime must restart to apply listener changes. */
  restartRequired: boolean;
}

const impactChangeLabel = (
  change: string,
  form: ConfigurationForm,
  mode: ConfigurationMode,
  locale: "en-US" | "zh-CN",
): string => {
  const english = locale === "en-US";
  const service = form.expertServices;
  const labels: Record<string, string> = {
    activeMode: english
      ? `Runtime mode → ${modeLabel(mode, locale)}`
      : `运行模式 → ${modeLabel(mode, locale)}`,
    activeProfileId: english
      ? `Profile ID → ${form.activeProfileId}`
      : `配置标识 → ${form.activeProfileId}`,
    virtualModelName: english
      ? `Virtual model → ${form.virtualModelName}`
      : `虚拟模型 → ${form.virtualModelName}`,
    modelSelection: english
      ? `Upstream model → ${form.modelSelection.source} · ${form.modelSelection.model}`
      : `上游模型 → ${form.modelSelection.source === "official" ? "宿主" : form.modelSelection.source === "company" ? "公司" : "自定义"} · ${form.modelSelection.model}`,
    capabilityCompletion: english
      ? `Capability completion → ${form.capabilityCompletion.enabled ? "enabled" : "disabled"} · ${form.capabilityCompletion.specialists.length} specialists`
      : `能力互补 → ${form.capabilityCompletion.enabled ? "开启" : "关闭"} · ${form.capabilityCompletion.specialists.length} 个专家模型`,
    "expertServices.host": english
      ? `Listen host → ${service?.host ?? "-"}`
      : `监听地址 → ${service?.host ?? "-"}`,
    "expertServices.port": english
      ? `Listen port → ${service?.port ?? "-"}`
      : `监听端口 → ${service?.port ?? "-"}`,
    "expertServices.responsesApiEnabled": `Responses API → ${
      service?.responsesApiEnabled ? (english ? "enabled" : "启用") : english ? "disabled" : "关闭"
    }`,
    "expertServices.chatCompletionsApiEnabled": `Chat Completions API → ${
      service?.chatCompletionsApiEnabled
        ? english
          ? "enabled"
          : "启用"
        : english
          ? "disabled"
          : "关闭"
    }`,
    "expertServices.taskApiEnabled": `Agent Task API → ${
      service?.taskApiEnabled ? (english ? "enabled" : "启用") : english ? "disabled" : "关闭"
    }`,
  };
  return labels[change] ?? change;
};

const taskStatusLabel = (status: TaskControlView["status"], locale: "en-US" | "zh-CN"): string =>
  (locale === "zh-CN"
    ? {
        created: "已规划",
        running: "执行中",
        waiting_for_approval: "等待审批",
        paused: "已暂停",
        completed: "已完成",
        failed: "执行失败",
        cancelled: "已取消",
      }
    : {
        created: "Planned",
        running: "Running",
        waiting_for_approval: "Approval required",
        paused: "Paused",
        completed: "Completed",
        failed: "Failed",
        cancelled: "Cancelled",
      })[status];

export const TaskControlPanel = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
  const english = locale === "en-US";
  const [snapshot, setSnapshot] = useState<TaskListResponse | undefined>();
  const [message, setMessage] = useState(english ? "Loading task capsules…" : "正在读取任务胶囊…");
  const [pendingTaskId, setPendingTaskId] = useState<string | undefined>();

  const refreshTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(
          english ? `Task API returned ${response.status}` : `任务接口返回 ${response.status}`,
        );
      }
      setSnapshot((await response.json()) as TaskListResponse);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : english
            ? "Unable to load tasks"
            : "无法读取任务状态",
      );
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const mutateTask = async (
    task: TaskControlView,
    action: "approve" | "cancel" | "deny" | "pause" | "resume",
  ): Promise<void> => {
    setPendingTaskId(task.taskId);
    setMessage(english ? "Submitting control action…" : "正在提交控制指令…");
    try {
      const isApproval = action === "approve" || action === "deny";
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/${isApproval ? "approval" : "control"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            isApproval
              ? {
                  stepId: task.pendingApprovalStepId,
                  approved: action === "approve",
                }
              : { action },
          ),
        },
      );
      if (!response.ok) {
        throw new Error(
          english ? `Task control returned ${response.status}` : `任务控制返回 ${response.status}`,
        );
      }
      await refreshTasks();
      setMessage(english ? "Control action applied." : "控制指令已生效。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : english ? "Task control failed" : "任务控制失败",
      );
    } finally {
      setPendingTaskId(undefined);
    }
  };

  return (
    <section className="task-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">BOUNDED AGENT TASKS</p>
          <h2>{english ? "Task control" : "任务控制"}</h2>
          <p>
            {english
              ? "Inspect progress, budgets, and trust. Every control action passes through the Agent state machine."
              : "查看计划进度、预算与信任等级；暂停、恢复、取消和审批都经过内核状态机。"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshTasks()}
          disabled={pendingTaskId !== undefined}
        >
          {english ? "Refresh tasks" : "刷新任务"}
        </button>
      </div>
      {snapshot?.available === false ? (
        <div className="task-empty">
          {english
            ? "The runtime has no real provider or dedicated planner and worker. Persisted tasks remain visible, but execution controls require an active Agent kernel."
            : "当前运行时未配置真实模型供应商或未注入专用规划器与执行器。持久化任务仍可查看，但执行控制只在真实 Agent 内核可用后启用。"}
        </div>
      ) : null}
      {snapshot?.available === true && snapshot.tasks.length === 0 ? (
        <div className="task-empty">
          {english
            ? "No tasks yet. Tasks created through the Agent SDK appear here."
            : "暂无任务。Agent SDK 创建的任务会在此显示。"}
        </div>
      ) : (
        <div className="task-list">
          {snapshot?.tasks.map((task) => {
            const progress = task.totalSteps === 0 ? 0 : task.completedSteps / task.totalSteps;
            const isPending = pendingTaskId === task.taskId;
            return (
              <article className="task-card" key={task.taskId}>
                <div className="task-card-heading">
                  <div>
                    <p className="task-id">{task.taskId}</p>
                    <h3>{task.objective}</h3>
                  </div>
                  <span className={`task-status task-status-${task.status}`}>
                    {taskStatusLabel(task.status, locale)}
                  </span>
                </div>
                <div
                  className="task-progress"
                  role="progressbar"
                  aria-label="任务进度"
                  aria-valuemin={0}
                  aria-valuemax={task.totalSteps}
                  aria-valuenow={task.completedSteps}
                >
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <dl className="task-metrics">
                  <div>
                    <dt>{english ? "Steps" : "步骤"}</dt>
                    <dd>
                      {task.completedSteps}/{task.totalSteps}
                    </dd>
                  </div>
                  <div>
                    <dt>{english ? "Tools" : "工具"}</dt>
                    <dd>
                      {task.budget.usage.toolCalls}/{task.budget.limits.maxToolCalls}
                    </dd>
                  </div>
                  <div>
                    <dt>{english ? "Replans" : "重规划"}</dt>
                    <dd>
                      {task.budget.usage.replans}/{task.budget.limits.maxReplans}
                    </dd>
                  </div>
                  <div>
                    <dt>{english ? "Trust" : "可信度"}</dt>
                    <dd>{task.trustLevel}</dd>
                  </div>
                </dl>
                {snapshot.available ? (
                  <div className="task-actions">
                    {task.status === "running" ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => void mutateTask(task, "pause")}
                      >
                        {english ? "Pause" : "暂停"}
                      </button>
                    ) : null}
                    {["created", "failed", "paused"].includes(task.status) ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => void mutateTask(task, "resume")}
                      >
                        {english ? "Resume" : "恢复执行"}
                      </button>
                    ) : null}
                    {task.status === "waiting_for_approval" && task.pendingApprovalStepId ? (
                      <>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={isPending}
                          onClick={() => void mutateTask(task, "approve")}
                        >
                          {english ? "Approve" : "批准"}
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void mutateTask(task, "deny")}
                        >
                          {english ? "Deny" : "拒绝"}
                        </button>
                      </>
                    ) : null}
                    {!["completed", "cancelled"].includes(task.status) ? (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => void mutateTask(task, "cancel")}
                      >
                        {english ? "Cancel" : "取消"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <p className="operation-message" aria-live="polite">
        {message}
      </p>
    </section>
  );
};

export const requestBootstrap = async (
  path = "/api/config-center",
  init?: RequestInit,
): Promise<ConfigCenterBootstrap> => {
  const response = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  const body = (await response.json()) as ConfigCenterBootstrap | { message?: string };
  if (!response.ok) {
    throw new Error(
      "message" in body && body.message ? body.message : `配置中心返回 ${response.status}`,
    );
  }
  return body as ConfigCenterBootstrap;
};

export const DEFAULT_EXPERT_SERVICES: ExpertServiceConfiguration = {
  host: "127.0.0.1",
  port: 9639,
  responsesApiEnabled: true,
  chatCompletionsApiEnabled: true,
  taskApiEnabled: true,
};

export const toForm = (configuration: TiduConfiguration): ConfigurationForm => ({
  activeProfileId: configuration.activeProfileId,
  virtualModelName: configuration.virtualModelName,
  modelSelection: configuration.modelSelection ?? {
    source: "official",
    model: "current",
  },
  capabilityCompletion: configuration.capabilityCompletion ?? {
    enabled: false,
    mainCapabilities: ["text", "structured-output"],
    specialists: [],
    maximumSpecialists: 2,
  },
  ...(configuration.activeMode === "expert"
    ? {
        expertServices: configuration.expertServices ?? DEFAULT_EXPERT_SERVICES,
      }
    : {}),
});

export const modeLabel = (mode: ConfigurationMode, locale: "en-US" | "zh-CN" = "zh-CN"): string =>
  locale === "zh-CN"
    ? mode === "managed"
      ? "普通模式"
      : "专家模式"
    : mode === "managed"
      ? "Normal"
      : "Expert";

export const clientReadinessLabel = (
  readiness: ConfigCenterBootstrap["clients"]["clients"][number]["readiness"],
  locale: "en-US" | "zh-CN",
): string => {
  if (readiness === "configurable") {
    return locale === "zh-CN" ? "已发现 · 可配置" : "Detected · configurable";
  }
  if (readiness === "limited") {
    return locale === "zh-CN" ? "已发现 · 能力有限" : "Detected · limited";
  }
  return locale === "zh-CN" ? "未发现" : "Not detected";
};

export const clientIntegrationLabel = (
  integrationMode: ConfigCenterBootstrap["clients"]["clients"][number]["integrationMode"],
  locale: "en-US" | "zh-CN",
): string => {
  if (integrationMode === "native-agent") {
    return locale === "zh-CN" ? "原生Agent桥接" : "Native Agent bridge";
  }
  if (integrationMode === "virtual-model") {
    return locale === "zh-CN" ? "虚拟模型兼容" : "Virtual-model compatibility";
  }
  return locale === "zh-CN" ? "等待安装" : "Awaiting installation";
};

export const GuideCenter = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
  const [audience, setAudience] = useState<"company" | "personal">("personal");

  if (locale === "en-US") {
    return (
      <section className="guide-panel">
        <div className="configuration-heading">
          <div>
            <p className="card-label">BUILT-IN GUIDE</p>
            <h2>Install and operate</h2>
            <p>Guidance is versioned with the running package.</p>
          </div>
        </div>
        <div className="guide-content">
          <div className="guide-grid">
            <article className="guide-card">
              <p className="guide-index">01 · START</p>
              <h3>Open the personal control center</h3>
              <code>tidu start</code>
              <ol>
                <li>Keep the runtime terminal open.</li>
                <li>Open the printed loopback address.</li>
                <li>Run `tidu doctor` when the page is unavailable.</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">02 · CONFIGURE</p>
              <h3>Select a model path</h3>
              <ol>
                <li>Use an OpenAI-compatible provider or local Ollama.</li>
                <li>Edit Normal or Expert without changing the active profile.</li>
                <li>Preview impact, save, then explicitly activate.</li>
                <li>Rollback restores the previous known-good version.</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">03 · PRIVACY</p>
              <h3>Choose a history mode</h3>
              <ol>
                <li>Host mode keeps full history in the current client.</li>
                <li>Portable mode uses bounded local retention.</li>
                <li>Incognito mode stores no conversation history.</li>
                <li>Encrypted export excludes credentials and conversation content.</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">04 · REMOVE</p>
              <h3>Recoverable uninstall</h3>
              <code>tidu uninstall</code>
              <ol>
                <li>Stop the personal runtime first.</li>
                <li>The default uninstall keeps a restorable snapshot.</li>
                <li>`--purge` permanently removes owned local data.</li>
              </ol>
            </article>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="guide-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">BUILT-IN GUIDE</p>
          <h2>安装与使用指南</h2>
          <p>页面内说明与实际版本保持同步，不要求用户再查找外部文档。</p>
        </div>
        <fieldset className="mode-switcher" aria-label="指南类型">
          {(["personal", "company"] as const).map((guideAudience) => (
            <button
              className={
                audience === guideAudience ? "mode-button mode-button-active" : "mode-button"
              }
              type="button"
              aria-pressed={audience === guideAudience}
              onClick={() => setAudience(guideAudience)}
              key={guideAudience}
            >
              {guideAudience === "personal" ? "个人版" : "公司版"}
            </button>
          ))}
        </fieldset>
      </div>

      {audience === "personal" ? (
        <div className="guide-content">
          <div className="guide-summary">
            <span className="availability availability-ready">当前可用</span>
            <p>个人版只运行一个本地进程，配置与数据默认保存在当前设备。</p>
          </div>
          <div className="guide-grid">
            <article className="guide-card">
              <p className="guide-index">01 · 启动</p>
              <h3>安装并打开页面</h3>
              <code>tidu start</code>
              <ol>
                <li>保持启动命令所在终端运行。</li>
                <li>打开终端显示的配置中心地址。</li>
                <li>默认地址为 http://127.0.0.1:9639。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">02 · 配置</p>
              <h3>选择供应商与入口</h3>
              <ol>
                <li>OpenAI兼容服务设置 TIDU_PROVIDER=openai-compatible。</li>
                <li>本地Ollama设置 TIDU_PROVIDER=ollama。</li>
                <li>通过 TIDU_PROVIDER_MODEL 指定真实模型。</li>
                <li>再保存并明确启用普通或专家入口草稿。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">03 · 排查</p>
              <h3>页面无法打开</h3>
              <code>tidu doctor</code>
              <ol>
                <li>检查运行时、数据库、配置API和页面资源。</li>
                <li>页面不可用时运行同一npm包的 config 交互向导。</li>
                <li>使用 config show 查看生效配置与草稿。</li>
                <li>当前开发验收只使用本机回环地址，不需要远程部署。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">04 · 卸载</p>
              <h3>保留快照或彻底清除</h3>
              <code>tidu uninstall</code>
              <ol>
                <li>先停止正在运行的个人版进程。</li>
                <li>默认卸载会保留可由 tidu restore 恢复的本地快照。</li>
                <li>--purge 必须输入完整确认词，且不可恢复。</li>
                <li>自定义数据库路径始终保留，防止误删共享数据。</li>
              </ol>
            </article>
          </div>
          <p className="guide-note">
            当前版本支持OpenAI兼容服务或本地Ollama的非流式、SSE流式与基础函数工具协议；配置真实供应商后会自动启用Agent目标理解、规划、审批、恢复和结果验证，也可通过SDK注入专用适配器。
          </p>
        </div>
      ) : (
        <div className="guide-content">
          <div className="guide-summary">
            <span className="availability availability-ready">企业试点可用</span>
            <p>管理员与员工指南由当前已发布的公司配置自动生成，并随配置修订更新。</p>
          </div>
          <div className="guide-grid">
            <article className="guide-card">
              <p className="guide-index">01 · 管理员</p>
              <h3>生成管理员访问密钥</h3>
              <ol>
                <li>配置完成后生成高强度管理员访问密钥。</li>
                <li>原始密钥只展示一次，安装人员必须确认已保存。</li>
                <li>数据库只保存不可逆校验值，不保存可读取明文。</li>
                <li>同时输出唯一的HTTPS管理地址。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">02 · 安全</p>
              <h3>登录与轮换密钥</h3>
              <ol>
                <li>每个新管理会话必须先输入管理员访问密钥。</li>
                <li>验证通过后建立短期安全会话，不把密钥留在浏览器。</li>
                <li>管理员可重新验证后生成新密钥并立即撤销旧密钥。</li>
                <li>密钥丢失时只能在服务器本机执行恢复并留下审计记录。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">03 · 发布</p>
              <h3>发布企业接入地址</h3>
              <ol>
                <li>管理员发布模型、额度、门禁和可用客户端。</li>
                <li>系统提供不含供应商密钥的企业接入地址。</li>
                <li>管理员通过公司内部渠道把地址发给员工。</li>
                <li>配置变更后员工本地可重新检测并读取最新修订。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">04 · 员工</p>
              <h3>按场景完成接入</h3>
              <ol>
                <li>在员工电脑安装并启动个人版九门赛博提督。</li>
                <li>打开本地页面的“个人”页面并找到“企业接入”。</li>
                <li>填写管理员提供的公司链接并完成检测。</li>
                <li>企业模型、策略和能力以只读方式显示在本地页面。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">05 · 运维</p>
              <h3>页面故障与离线操作</h3>
              <ol>
                <li>页面故障不停止模型网关和已启用配置。</li>
                <li>管理员可通过等价CLI、配置文件和管理API操作。</li>
                <li>员工通过本地页面重新检测或断开企业接入。</li>
                <li>所有文档显示适用版本与最近发布时间。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">06 · 迁移</p>
              <h3>从个人版加入公司</h3>
              <ol>
                <li>输入公司接入地址或邀请码，自动完成兼容性预检。</li>
                <li>本地生成加密迁移快照并展示数据与策略影响。</li>
                <li>创建隔离的公司Profile，验证成功后再分阶段启用。</li>
                <li>失败自动回滚；退出公司后恢复原个人Profile。</li>
              </ol>
            </article>
          </div>
        </div>
      )}
    </section>
  );
};

export const PersonalExperiencePanel = ({
  locale,
  providerConfigured,
  providerType,
  enterprise,
  onBootstrap,
}: {
  locale: "en-US" | "zh-CN";
  providerConfigured: boolean;
  providerType: string | null;
  enterprise: ConfigCenterBootstrap["enterprise"];
  onBootstrap: (bootstrap: ConfigCenterBootstrap) => void;
}) => {
  const english = locale === "en-US";
  return (
    <section className="configuration-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">PERSONAL EXPERIENCE</p>
          <h2>{english ? "Personal controls" : "个人中心"}</h2>
          <p>
            {english
              ? "Privacy, budget, local models, extensions, and portable configuration remain independently controlled."
              : "历史、预算、本地模型、扩展与配置迁移均保持独立可控。"}
          </p>
        </div>
      </div>
      <div className="personal-grid">
        <article className="personal-card">
          <p className="card-label">HISTORY</p>
          <h3>{english ? "Host mode" : "宿主历史"}</h3>
          <p>
            {english
              ? "Full history stays in the current client."
              : "完整会话保留在当前客户端，九门仅保存任务胶囊。"}
          </p>
          <code>
            {english ? "Portable: bounded · Incognito: none" : "可移植：有界清理 · 无痕：不保存"}
          </code>
        </article>
        <article className="personal-card">
          <p className="card-label">LOCAL MODEL</p>
          <h3>
            {providerType === "ollama" ? "Ollama" : english ? "Ready to configure" : "可配置"}
          </h3>
          <p>
            {providerConfigured
              ? english
                ? "Provider detected."
                : "已发现模型供应商。"
              : english
                ? "Use the guided Ollama or compatible endpoint setup."
                : "可按引导配置 Ollama 或兼容本地端点。"}
          </p>
          <code>http://127.0.0.1:11434</code>
        </article>
        <article className="personal-card">
          <p className="card-label">EXTENSIONS & PORTABILITY</p>
          <h3>{english ? "Diagnose before enable" : "启用前诊断"}</h3>
          <p>
            {english
              ? "Agent, Skill, MCP, and tool permissions are checked before activation."
              : "Agent、Skill、MCP 与工具在启用前检查版本和权限。"}
          </p>
          <code>{english ? "AES-256-GCM configuration export" : "AES-256-GCM 加密配置导出"}</code>
        </article>
      </div>
      <EnterpriseReadOnlyPanel enterprise={enterprise} locale={locale} onBootstrap={onBootstrap} />
    </section>
  );
};

export const EnterpriseReadOnlyPanel = ({
  enterprise,
  locale,
  onBootstrap,
}: {
  enterprise: ConfigCenterBootstrap["enterprise"];
  locale: "en-US" | "zh-CN";
  onBootstrap: (bootstrap: ConfigCenterBootstrap) => void;
}) => {
  const english = locale === "en-US";
  const [endpoint, setEndpoint] = useState(enterprise.endpoint ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setEndpoint(enterprise.endpoint ?? ""), [enterprise.endpoint]);

  const updateConnection = async (action: "connect" | "disconnect"): Promise<void> => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/enterprise/connection", {
        method: action === "connect" ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: action === "connect" ? JSON.stringify({ endpoint: endpoint.trim() }) : "{}",
      });
      const result = (await response.json()) as ConfigCenterBootstrap & {
        message?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.message ??
            (english ? "Company connection failed." : "企业接入失败，请检查公司链接。"),
        );
      }
      onBootstrap(result);
      setMessage(
        action === "connect"
          ? english
            ? "Company configuration refreshed."
            : "企业配置已读取并更新。"
          : english
            ? "Company connection removed."
            : "已断开企业接入。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Company connection failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="enterprise-readonly">
      <div className="configuration-heading">
        <div>
          <p className="card-label">ENTERPRISE CONFIGURATION</p>
          <h2>{english ? "Company access" : "企业接入"}</h2>
          <p>
            {enterprise.enabled
              ? english
                ? `${enterprise.companyName ?? "Company"} · revision ${enterprise.revision}. Published settings are read only.`
                : `${enterprise.companyName ?? "企业"} · 修订 ${enterprise.revision}；企业发布的配置仅可查看。`
              : english
                ? "Enter the company URL provided by your administrator."
                : "填写管理员提供的公司链接即可接入，无需额外命令。"}
          </p>
        </div>
        <span
          className={`availability ${enterprise.enabled ? "availability-ready" : "availability-planned"}`}
        >
          {enterprise.enabled
            ? english
              ? "CONNECTED"
              : "已接入"
            : english
              ? "NOT CONNECTED"
              : "未接入"}
        </span>
      </div>
      <form
        className="enterprise-connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          void updateConnection("connect");
        }}
      >
        <label htmlFor="enterprise-endpoint">
          {english ? "Company URL" : "公司链接"}
          <input
            id="enterprise-endpoint"
            type="url"
            value={endpoint}
            placeholder="https://tidu.company.example"
            required
            disabled={pending}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <button type="submit" disabled={pending || endpoint.trim() === ""}>
          {pending
            ? english
              ? "Checking…"
              : "检测中…"
            : enterprise.enabled
              ? english
                ? "Check again"
                : "重新检测"
              : english
                ? "Connect"
                : "接入企业"}
        </button>
        {enterprise.enabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void updateConnection("disconnect")}
          >
            {english ? "Disconnect" : "断开接入"}
          </button>
        ) : null}
      </form>
      {message ? (
        <p className="enterprise-connection-message" role="status">
          {message}
        </p>
      ) : null}
      {enterprise.enabled ? (
        <div className="personal-grid">
          <article className="personal-card">
            <p className="card-label">VIRTUAL MODEL</p>
            <h3>{enterprise.virtualModelName ?? "—"}</h3>
            <p>{enterprise.virtualModelId ?? "—"}</p>
          </article>
          <article className="personal-card">
            <p className="card-label">POLICY</p>
            <h3>{enterprise.policyCount}</h3>
            <p>{english ? "Mandatory and advisory policies" : "强制策略与辅助策略"}</p>
          </article>
          <article className="personal-card">
            <p className="card-label">CAPABILITY CATALOG</p>
            <h3>{enterprise.capabilityCount}</h3>
            <p>{english ? "Published private capabilities" : "已发布内部能力"}</p>
          </article>
          <article className="personal-card">
            <p className="card-label">MODEL RESOURCES</p>
            <h3>{enterprise.resourceCount}</h3>
            <p>{english ? "Enterprise and user-owned resources" : "企业采购与用户自带资源"}</p>
          </article>
        </div>
      ) : null}
    </div>
  );
};

export const EnterpriseEditionPanel = ({
  enterprise,
  locale,
}: {
  enterprise: ConfigCenterBootstrap["enterprise"];
  locale: "en-US" | "zh-CN";
}) => {
  const english = locale === "en-US";
  const administratorKeyInput = useRef<HTMLInputElement>(null);
  const [administratorSession, setAdministratorSession] = useState<string | null>(null);
  const [memberUsage, setMemberUsage] = useState<EnterpriseMemberUsageReport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMemberUsage = useCallback(async (sessionId: string) => {
    const response = await fetch("/api/enterprise/members/usage", {
      headers: { "x-tidu-admin-session": sessionId },
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(response.status === 401 ? "session-expired" : "usage-unavailable");
    setMemberUsage((await response.json()) as EnterpriseMemberUsageReport);
  }, []);

  const signIn = async (): Promise<void> => {
    const key = administratorKeyInput.current?.value.trim();
    if (!key) return;
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/enterprise/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!response.ok) throw new Error("authentication-failed");
      const session = (await response.json()) as { id: string };
      setAdministratorSession(session.id);
      await loadMemberUsage(session.id);
    } catch {
      setMessage(
        english
          ? "Administrator sign-in failed or usage is unavailable."
          : "管理员验证失败，或用量暂不可读取。",
      );
    } finally {
      if (administratorKeyInput.current) administratorKeyInput.current.value = "";
      setLoading(false);
    }
  };

  return (
    <section className="configuration-panel enterprise-edition-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">ENTERPRISE EDITION</p>
          <h2>{english ? "Enterprise configuration and usage" : "企业配置与用量"}</h2>
          <p>
            {english
              ? `Published revision ${enterprise.revision}. Member details require an administrator session.`
              : `已发布修订 ${enterprise.revision}。成员明细仅在管理员验证后显示。`}
          </p>
        </div>
      </div>
      <div className="personal-grid">
        <article className="personal-card">
          <p className="card-label">POLICY</p>
          <h3>{enterprise.policyCount}</h3>
          <p>{english ? "Published policies" : "已发布策略"}</p>
        </article>
        <article className="personal-card">
          <p className="card-label">CAPABILITY</p>
          <h3>{enterprise.capabilityCount}</h3>
          <p>{english ? "Published capabilities" : "已发布能力"}</p>
        </article>
        <article className="personal-card">
          <p className="card-label">MODEL RESOURCES</p>
          <h3>{enterprise.resourceCount}</h3>
          <p>{english ? "Configured model resources" : "已配置模型资源"}</p>
        </article>
      </div>
      {administratorSession === null ? (
        <form
          className="enterprise-admin-login"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <label htmlFor="enterprise-admin-key">
            {english ? "Administrator access key" : "管理员访问密钥"}
          </label>
          <input
            id="enterprise-admin-key"
            ref={administratorKeyInput}
            type="password"
            autoComplete="off"
            required
          />
          <button type="submit" disabled={loading}>
            {loading
              ? english
                ? "Verifying…"
                : "验证中…"
              : english
                ? "View member usage"
                : "查看成员用量"}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void loadMemberUsage(administratorSession)
              .catch(() => {
                setAdministratorSession(null);
                setMemberUsage(null);
                setMessage(
                  english ? "Session expired. Sign in again." : "会话已过期，请重新验证。",
                );
              })
              .finally(() => setLoading(false));
          }}
          disabled={loading}
        >
          {english ? "Refresh member usage" : "刷新成员用量"}
        </button>
      )}
      {message ? (
        <p role="alert" className="read-only-notice">
          {message}
        </p>
      ) : null}
      {memberUsage ? (
        <div className="enterprise-usage">
          <h3>{english ? "Enterprise quota" : "企业额度"}</h3>
          <p>
            {english ? "Capacity" : "总额"} {memberUsage.totals.capacity} ·{" "}
            {english ? "Remaining" : "剩余"} {memberUsage.totals.remaining} ·{" "}
            {english ? "Settled" : "已结算"} {memberUsage.totals.settled} ·{" "}
            {english ? "Reserved" : "已预留"} {memberUsage.totals.reserved}
          </p>
          <h3>{english ? "Connected members" : "接入成员"}</h3>
          {memberUsage.members.length === 0 ? (
            <p>{english ? "No members are registered yet." : "暂无已登记成员。"}</p>
          ) : (
            <div className="enterprise-member-grid">
              {memberUsage.members.map((member) => (
                <article className="personal-card" key={member.id}>
                  <h3>{member.displayName}</h3>
                  <p>{member.roles.join(" · ")}</p>
                  {member.allocations.length === 0 ? (
                    <p>
                      {english
                        ? "No user-scoped enterprise quota recorded."
                        : "尚无归属该成员的企业额度记录。"}
                    </p>
                  ) : (
                    member.allocations.map((allocation) => (
                      <p key={allocation.allocationId}>
                        {allocation.resourceName}：{english ? "used" : "已用"} {allocation.settled}{" "}
                        / {allocation.limit} · {english ? "remaining" : "剩余"}{" "}
                        {allocation.remaining}
                      </p>
                    ))
                  )}
                </article>
              ))}
            </div>
          )}
          <p className="read-only-notice">
            {english
              ? "Usage reflects settled user-scoped enterprise allocations. Calls without a member identity are not attributed to a person."
              : "这里统计已结算且绑定成员身份的企业额度；没有成员身份的调用不会归到个人。"}
          </p>
        </div>
      ) : null}
    </section>
  );
};

interface QuickStartWizardProps {
  /** Current language. */
  locale: "en-US" | "zh-CN";
  /** Whether enterprise services are attached. */
  enterpriseEnabled: boolean;
  /** Whether a real model provider is ready. */
  providerConfigured: boolean;
  /** Sanitized active provider name. */
  providerType: string | null;
  /** Sanitized active upstream model name. */
  providerModel: string | null;
  /** Host selected by a capability-card quick configuration action. */
  targetHost?: AgentHostId;
  /** Currently selected isolated draft. */
  selectedMode: ConfigurationMode;
  /** Editable entry identity. */
  form: ConfigurationForm;
  /** Whether the form differs from the saved draft. */
  isDirty: boolean;
  /** Whether an operation is running. */
  isPending: boolean;
  /** Latest activation impact preview. */
  impactPreview?: ConfigurationImpactPreview;
  /** Whether this form is the active runtime configuration. */
  isActive: boolean;
  /** Validation messages for required entry fields. */
  entryValidationMessages: EntryValidationMessages;
  /** Whether this installation may modify configuration. */
  readOnly: boolean;
  /** Update the entry identity form. */
  onFormChange: (form: ConfigurationForm) => void;
  /** Save the current draft. */
  onSave: () => Promise<boolean>;
  /** Simulate activation impact. */
  onSimulate: () => Promise<void>;
  /** Activate the verified draft. */
  onActivate: () => Promise<void>;
  /** Restore the previous known-good runtime configuration. */
  onRollback: () => Promise<void>;
  /** Open client connection guidance. */
  onOpenClients: () => void;
}

interface UpstreamModelCatalog {
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

const createEmptyHostCatalog = (): UpstreamModelCatalog["hosts"] => ({
  codex: { available: false, models: [] },
  cursor: { available: false, models: [] },
  ollama: { available: false, models: [] },
  "openai-compatible": { available: false, models: [] },
});

export const QuickStartWizard = ({
  locale,
  enterpriseEnabled,
  providerConfigured,
  providerType,
  providerModel,
  targetHost,
  selectedMode,
  form,
  isDirty,
  isPending,
  impactPreview,
  isActive,
  entryValidationMessages,
  readOnly,
  onFormChange,
  onSave,
  onSimulate,
  onActivate,
  onRollback,
  onOpenClients,
}: QuickStartWizardProps) => {
  const english = locale === "en-US";
  const [step, setStep] = useState(targetHost === undefined ? 0 : 2);
  const [providerChoice, setProviderChoice] = useState<
    "codex-host" | "cursor-host" | "ollama" | "compatible"
  >(() =>
    targetHost === "codex"
      ? "codex-host"
      : targetHost === "cursor"
        ? "cursor-host"
        : targetHost === "ollama"
          ? "ollama"
          : targetHost === "openai-compatible"
            ? "compatible"
            : providerType === "cursor-host"
              ? "cursor-host"
              : providerType === "ollama"
                ? "ollama"
                : providerType === "openai-compatible"
                  ? "compatible"
                  : "codex-host",
  );
  const [modelChoiceMode, setModelChoiceMode] = useState<"company" | "custom" | "host">(
    form.modelSelection.source === "company"
      ? "company"
      : form.modelSelection.source === "custom"
        ? "custom"
        : "host",
  );
  const modelChoiceTouchedRef = useRef(false);
  const providerChoiceTouchedRef = useRef(false);
  const [providerCheck, setProviderCheck] = useState<{
    status: "idle" | "checking" | "ready" | "unavailable" | "restart-required";
    provider?: string;
    model?: string;
    account?: {
      status: string;
      type: string | null;
      email: string | null;
      plan: string | null;
    } | null;
  }>({ status: "idle" });
  const [upstreamCatalog, setUpstreamCatalog] = useState<UpstreamModelCatalog>({
    companyConfigured: false,
    companyProviderType: null,
    company: [],
    official: [],
    hosts: createEmptyHostCatalog(),
  });
  const [upstreamCatalogStatus, setUpstreamCatalogStatus] = useState<"error" | "loading" | "ready">(
    "loading",
  );
  useEffect(() => {
    setStep(targetHost === undefined ? (selectedMode === "expert" ? 1 : 0) : 2);
    setProviderCheck({ status: "idle" });
  }, [selectedMode, targetHost]);
  const stepLabels = english
    ? ["Deployment", "Entry", "Model", "Activate", "Clients (optional)"]
    : ["部署", "入口", "模型", "启用", "客户端（可选）"];
  const entryIsValid = Object.keys(entryValidationMessages).length === 0;
  const clientSetupIsAvailable = isActive && !isDirty;
  const effectiveProviderType =
    providerType === "tidu-router" ? upstreamCatalog.companyProviderType : providerType;
  const activeProviderChoice =
    effectiveProviderType === "codex-host" ||
    effectiveProviderType === "cursor-host" ||
    effectiveProviderType === "ollama"
      ? effectiveProviderType
      : effectiveProviderType === "openai-compatible"
        ? "compatible"
        : null;
  const choiceMatchesRuntime =
    (providerChoice === "codex-host" && effectiveProviderType === "codex-host") ||
    (providerChoice === "cursor-host" && effectiveProviderType === "cursor-host") ||
    (providerChoice === "ollama" && effectiveProviderType === "ollama") ||
    (providerChoice === "compatible" && effectiveProviderType === "openai-compatible");
  const providerLabel =
    providerChoice === "codex-host"
      ? "Codex"
      : providerChoice === "cursor-host"
        ? "Cursor"
        : providerChoice === "ollama"
          ? "Ollama"
          : english
            ? "Compatible provider"
            : "兼容服务";
  const customModel = modelChoiceMode === "custom" ? form.modelSelection.model : "";
  const hostModelOptions =
    providerChoice === "codex-host"
      ? upstreamCatalog.official
      : providerChoice === "cursor-host"
        ? upstreamCatalog.hosts.cursor.models
        : providerChoice === "ollama"
          ? upstreamCatalog.hosts.ollama.models
          : upstreamCatalog.hosts["openai-compatible"].models;
  const providerModelOptions =
    modelChoiceMode === "company"
      ? upstreamCatalog.company
      : modelChoiceMode === "host"
        ? hostModelOptions
        : [];
  const hostModelSource =
    providerChoice === "codex-host" || providerChoice === "cursor-host" ? "official" : "company";
  const hostIdByProvider = {
    "codex-host": "codex",
    "cursor-host": "cursor",
    ollama: "ollama",
    compatible: "openai-compatible",
  } as const satisfies Record<typeof providerChoice, AgentHostId>;
  const activeHostId = hostIdByProvider[providerChoice];
  const hostLabel = (host: AgentHostId): string =>
    host === "codex"
      ? "Codex"
      : host === "cursor"
        ? "Cursor"
        : host === "ollama"
          ? "Ollama"
          : english
            ? "Compatible service"
            : "兼容服务";
  const modelSourceForHost = (host: AgentHostId): "company" | "official" =>
    host === "codex" || host === "cursor" ? "official" : "company";
  const activeHostPolicy = form.capabilityCompletion.hostPolicies?.[activeHostId] ?? {
    mainModel: form.modelSelection,
    mainCapabilities: form.capabilityCompletion.mainCapabilities,
    specialists: form.capabilityCompletion.specialists,
    maximumSpecialists: form.capabilityCompletion.maximumSpecialists,
  };
  const updateActiveHostPolicy = (
    policy: typeof activeHostPolicy,
    nextModelSelection = policy.mainModel,
  ): void => {
    onFormChange({
      ...form,
      modelSelection: nextModelSelection,
      capabilityCompletion: {
        ...form.capabilityCompletion,
        mainCapabilities: policy.mainCapabilities,
        specialists: policy.specialists,
        maximumSpecialists: policy.maximumSpecialists,
        hostPolicies: {
          ...form.capabilityCompletion.hostPolicies,
          [activeHostId]: { ...policy, mainModel: nextModelSelection },
        },
      },
    });
  };
  const hostCatalogModels = upstreamCatalog.hosts[activeHostId]?.models ?? [];
  const capabilitiesForMainModel = (selection: ModelSelection): readonly string[] => {
    const resolvedModel =
      selection.model === "current"
        ? providerCheck.provider === providerChoice
          ? providerCheck.model
          : providerModel
        : selection.model;
    return (
      hostCatalogModels.find((model) => model.id === resolvedModel)?.capabilities ??
      MODEL_CAPABILITIES.map((capability) => capability.id)
    );
  };
  const selectMainModel = (selection: ModelSelection): void =>
    updateActiveHostPolicy(
      {
        ...activeHostPolicy,
        mainModel: selection,
        ...(form.capabilityCompletion.enabled
          ? { mainCapabilities: capabilitiesForMainModel(selection) }
          : {}),
      },
      selection,
    );
  const specialistHostCandidates = (
    ["codex", "cursor", "ollama", "openai-compatible"] as const
  ).filter((host) => host !== activeHostId);
  const usableSpecialistModels = (host: AgentHostId) =>
    (upstreamCatalog.hosts[host]?.models ?? []).filter(
      (model) => (model.capabilities?.length ?? 0) > 0,
    );
  const availableSpecialistHosts = specialistHostCandidates.filter(
    (host) =>
      upstreamCatalog.hosts[host]?.available === true && usableSpecialistModels(host).length > 0,
  );
  const specialistKey = (host: AgentHostId, model: string): string => `${host}\u0000${model}`;
  const configuredSpecialistKeys = new Set(
    activeHostPolicy.specialists
      .filter((specialist) => specialist.model !== "")
      .map((specialist) => specialistKey(specialist.host, specialist.model)),
  );
  const availableNewSpecialistModels = availableSpecialistHosts.flatMap((host) =>
    usableSpecialistModels(host)
      .filter((model) => !configuredSpecialistKeys.has(specialistKey(host, model.id)))
      .map((model) => ({ host, model })),
  );
  const detectedPrimaryModel =
    form.modelSelection.model === "current"
      ? providerCheck.provider === providerChoice
        ? providerCheck.model
        : choiceMatchesRuntime
          ? providerModel
          : undefined
      : form.modelSelection.model;
  const modelSelectOptions =
    modelChoiceMode === "host" &&
    detectedPrimaryModel &&
    !providerModelOptions.some((model) => model.id === detectedPrimaryModel)
      ? [{ id: detectedPrimaryModel, name: detectedPrimaryModel }, ...providerModelOptions]
      : providerModelOptions;
  const selectedModelId =
    form.modelSelection.model === "current"
      ? (detectedPrimaryModel ?? "")
      : form.modelSelection.model;
  const primaryCatalogModel = hostCatalogModels.find((model) => model.id === detectedPrimaryModel);
  const updateSpecialists = (specialists: readonly CapabilitySpecialistConfiguration[]): void =>
    updateActiveHostPolicy({
      ...activeHostPolicy,
      specialists,
      maximumSpecialists: Math.max(1, specialists.length),
    });
  useEffect(() => {
    if (upstreamCatalogStatus !== "ready") return;
    let changed = false;
    const specialists = activeHostPolicy.specialists.map((specialist) => {
      if (specialist.host !== "cursor" || specialist.model !== "current") return specialist;
      const defaultModel = upstreamCatalog.hosts.cursor.models.find((model) => model.isDefault);
      if (defaultModel === undefined) return specialist;
      changed = true;
      return {
        ...specialist,
        model: defaultModel.id,
        capabilities: defaultModel.capabilities ?? [],
      };
    });
    if (changed) updateSpecialists(specialists);
  }, [activeHostPolicy.specialists, upstreamCatalog.hosts.cursor.models, upstreamCatalogStatus]);
  const selectProvider = (choice: "codex-host" | "cursor-host" | "ollama" | "compatible"): void => {
    modelChoiceTouchedRef.current = true;
    providerChoiceTouchedRef.current = true;
    setProviderChoice(choice);
    setModelChoiceMode("host");
    const nextHostId = hostIdByProvider[choice];
    const savedPolicy = form.capabilityCompletion.hostPolicies?.[nextHostId];
    const nextModelSelection = savedPolicy?.mainModel ?? {
      source: choice === "codex-host" || choice === "cursor-host" ? "official" : "company",
      model: "current",
    };
    const nextPolicy = savedPolicy ?? {
      mainModel: nextModelSelection,
      mainCapabilities: ["text", "structured-output"],
      specialists: [],
      maximumSpecialists: 2,
    };
    onFormChange({
      ...form,
      modelSelection: nextModelSelection,
      capabilityCompletion: {
        ...form.capabilityCompletion,
        mainCapabilities: nextPolicy.mainCapabilities,
        specialists: nextPolicy.specialists,
        maximumSpecialists: nextPolicy.maximumSpecialists,
        hostPolicies: {
          ...form.capabilityCompletion.hostPolicies,
          [nextHostId]: nextPolicy,
        },
      },
    });
  };
  useEffect(() => {
    if (targetHost === undefined) return;
    selectProvider(
      targetHost === "codex"
        ? "codex-host"
        : targetHost === "cursor"
          ? "cursor-host"
          : targetHost === "ollama"
            ? "ollama"
            : "compatible",
    );
  }, [targetHost]);
  const selectModelChoiceMode = (choice: "company" | "custom" | "host"): void => {
    modelChoiceTouchedRef.current = true;
    setModelChoiceMode(choice);
    selectMainModel({
      source: choice === "company" ? "company" : choice === "custom" ? "custom" : hostModelSource,
      model: choice === "host" ? "current" : "",
    });
  };
  useEffect(() => {
    if (
      step !== 2 ||
      upstreamCatalogStatus !== "ready" ||
      modelChoiceMode !== "host" ||
      form.modelSelection.model !== "current" ||
      !detectedPrimaryModel
    ) {
      return;
    }
    selectMainModel({ source: hostModelSource, model: detectedPrimaryModel });
  }, [
    detectedPrimaryModel,
    form.modelSelection.model,
    modelChoiceMode,
    step,
    upstreamCatalogStatus,
  ]);
  useEffect(() => {
    if (upstreamCatalogStatus !== "ready" || modelChoiceTouchedRef.current) return;
    if (form.modelSelection.source === "company") {
      setModelChoiceMode("company");
      return;
    }
    if (form.modelSelection.source === "custom") {
      setModelChoiceMode("custom");
      return;
    }
    setModelChoiceMode(
      form.modelSelection.model === "current" ||
        upstreamCatalog.official.some((model) => model.id === form.modelSelection.model)
        ? "host"
        : "custom",
    );
  }, [form.modelSelection, upstreamCatalog.hosts, upstreamCatalogStatus]);
  useEffect(() => {
    if (
      upstreamCatalogStatus !== "ready" ||
      providerType !== "tidu-router" ||
      providerChoiceTouchedRef.current
    ) {
      return;
    }
    if (upstreamCatalog.companyProviderType === "ollama") {
      setProviderChoice("ollama");
    } else if (upstreamCatalog.companyProviderType === "openai-compatible") {
      setProviderChoice("compatible");
    }
  }, [providerType, upstreamCatalog.companyProviderType, upstreamCatalogStatus]);
  useEffect(() => {
    if (step !== 2) return;
    setUpstreamCatalogStatus("loading");
    void fetch("/api/models/upstreams", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Model catalog unavailable");
        const catalog = (await response.json()) as Omit<UpstreamModelCatalog, "hosts"> & {
          hosts?: UpstreamModelCatalog["hosts"];
        };
        const fallbackHosts = createEmptyHostCatalog();
        fallbackHosts.codex = {
          available: catalog.official.length > 0,
          models: catalog.official,
        };
        if (catalog.companyProviderType !== null) {
          const companyHost = catalog.companyProviderType;
          fallbackHosts[companyHost] = {
            available: catalog.companyConfigured,
            models: catalog.company,
          };
        }
        setUpstreamCatalog({
          ...catalog,
          hosts: catalog.hosts ?? fallbackHosts,
        });
        setUpstreamCatalogStatus("ready");
      })
      .catch(() => {
        setUpstreamCatalog({
          companyConfigured: false,
          companyProviderType: null,
          company: [],
          official: [],
          hosts: createEmptyHostCatalog(),
        });
        setUpstreamCatalogStatus("error");
      });
  }, [step]);
  useEffect(() => {
    if (step !== 2 || activeProviderChoice === null) {
      setProviderCheck({ status: "idle" });
      return;
    }
    let current = true;
    setProviderCheck({ status: "checking", provider: activeProviderChoice });
    void fetch("/api/provider/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider:
          activeProviderChoice === "compatible" ? "openai-compatible" : activeProviderChoice,
      }),
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(
        async (response) =>
          (await response.json()) as {
            detected?: boolean;
            matchesRuntime?: boolean;
            model?: string | null;
            account?: {
              status: string;
              type: string | null;
              email: string | null;
              plan: string | null;
            } | null;
          },
      )
      .then((result) => {
        if (!current) return;
        setProviderCheck({
          provider: activeProviderChoice,
          status: !result.detected
            ? "unavailable"
            : result.matchesRuntime
              ? "ready"
              : "restart-required",
          ...(result.model ? { model: result.model } : {}),
          account: result.account ?? null,
        });
      })
      .catch(() => {
        if (current)
          setProviderCheck({
            status: "unavailable",
            provider: activeProviderChoice,
          });
      });
    return () => {
      current = false;
    };
  }, [step, activeProviderChoice]);
  const canAdvance =
    step === 1
      ? entryIsValid
      : step === 2
        ? entryIsValid && providerConfigured && choiceMatchesRuntime
        : step === 3
          ? clientSetupIsAvailable
          : true;
  const advanceStep = async (): Promise<void> => {
    if (!canAdvance) {
      return;
    }
    if ((step === 1 || step === 2) && isDirty && !(await onSave())) {
      return;
    }
    setStep(Math.min(stepLabels.length - 1, step + 1));
  };

  return (
    <section className="onboarding-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">GUIDED SETUP</p>
          <h2>{english ? "Finish setup step by step" : "按步骤完成首次配置"}</h2>
          <p>
            {english
              ? "Next saves valid entry fields automatically. Continue only when the detected model configuration matches the active runtime; activate the configuration before connecting clients."
              : "入口必填项通过校验后，点击下一步自动保存。模型步骤只读取所选服务的配置；与当前运行配置一致后才能继续，不会调用模型。"}
          </p>
        </div>
        <span className="onboarding-counter">
          {step + 1} / {stepLabels.length}
        </span>
      </div>

      <nav className="onboarding-steps" aria-label={english ? "Setup progress" : "配置进度"}>
        {stepLabels.map((label, stepIndex) => (
          <span
            className={
              stepIndex === step
                ? "onboarding-step onboarding-step-active"
                : stepIndex < step
                  ? "onboarding-step onboarding-step-complete"
                  : "onboarding-step"
            }
            aria-current={stepIndex === step ? "step" : undefined}
            key={label}
          >
            <span>{String(stepIndex + 1).padStart(2, "0")}</span>
            {label}
          </span>
        ))}
      </nav>

      <div className="onboarding-content">
        {step === 0 ? (
          <>
            <p className="onboarding-kicker">
              {english ? "Detected deployment" : "已识别部署方式"}
            </p>
            <h3>
              {enterpriseEnabled
                ? english
                  ? "Enterprise attached"
                  : "已接入企业控制平面"
                : english
                  ? "Personal"
                  : "个人版"}
            </h3>
            <p>
              {enterpriseEnabled
                ? english
                  ? "Organization policy and quota are active. This wizard edits your permitted entry profile."
                  : "组织策略与额度已经生效；向导只编辑你被允许配置的入口。"
                : english
                  ? "SQLite and the local control center are ready. No external database is required."
                  : "个人版已就绪，使用独立配置与数据存储。"}
            </p>
          </>
        ) : step === 1 ? (
          <>
            <p className="onboarding-kicker">
              {english ? "Global mode" : "全局配置模式"} · {modeLabel(selectedMode, locale)}
            </p>
            <p className="required-hint">{english ? "* Required" : "* 必填项"}</p>
            <div className="configuration-form onboarding-form">
              <label>
                {english ? "Profile ID" : "配置标识"}
                <span className="required-mark" aria-hidden="true">
                  *
                </span>
                <input
                  value={form.activeProfileId}
                  required
                  aria-required="true"
                  aria-invalid={entryValidationMessages.activeProfileId !== undefined}
                  onChange={(event) =>
                    onFormChange({
                      ...form,
                      activeProfileId: event.target.value,
                    })
                  }
                  maxLength={64}
                  disabled={isPending || readOnly}
                />
                {entryValidationMessages.activeProfileId ? (
                  <small className="field-error" role="alert">
                    {entryValidationMessages.activeProfileId}
                  </small>
                ) : null}
              </label>
              <label>
                {english ? "Virtual model name" : "虚拟模型名称"}
                <span className="required-mark" aria-hidden="true">
                  *
                </span>
                <input
                  value={form.virtualModelName}
                  required
                  aria-required="true"
                  aria-invalid={entryValidationMessages.virtualModelName !== undefined}
                  onChange={(event) =>
                    onFormChange({
                      ...form,
                      virtualModelName: event.target.value,
                    })
                  }
                  maxLength={64}
                  disabled={isPending || readOnly}
                />
                {entryValidationMessages.virtualModelName ? (
                  <small className="field-error" role="alert">
                    {entryValidationMessages.virtualModelName}
                  </small>
                ) : null}
              </label>
            </div>
            {selectedMode === "expert" && form.expertServices ? (
              <section className="expert-service-settings">
                <div className="expert-service-heading">
                  <div>
                    <p className="card-label">ADVANCED SERVICES</p>
                    <h3>{english ? "Runtime network and APIs" : "运行网络与服务接口"}</h3>
                  </div>
                  <span>
                    {english ? "Restart required for host and port" : "地址和端口重启后生效"}
                  </span>
                </div>
                <div className="configuration-form onboarding-form">
                  <label>
                    {english ? "Listen host" : "监听地址"}
                    <span className="required-mark" aria-hidden="true">
                      *
                    </span>
                    <input
                      value={form.expertServices.host}
                      required
                      aria-invalid={entryValidationMessages.expertHost !== undefined}
                      onChange={(event) =>
                        onFormChange({
                          ...form,
                          expertServices: {
                            ...(form.expertServices ?? DEFAULT_EXPERT_SERVICES),
                            host: event.target.value,
                          },
                        })
                      }
                      disabled={isPending || readOnly}
                    />
                    {entryValidationMessages.expertHost ? (
                      <small className="field-error" role="alert">
                        {entryValidationMessages.expertHost}
                      </small>
                    ) : null}
                  </label>
                  <label>
                    {english ? "Listen port" : "监听端口"}
                    <span className="required-mark" aria-hidden="true">
                      *
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.expertServices.port}
                      required
                      aria-invalid={entryValidationMessages.expertPort !== undefined}
                      onChange={(event) =>
                        onFormChange({
                          ...form,
                          expertServices: {
                            ...(form.expertServices ?? DEFAULT_EXPERT_SERVICES),
                            port: Number(event.target.value),
                          },
                        })
                      }
                      disabled={isPending || readOnly}
                    />
                    {entryValidationMessages.expertPort ? (
                      <small className="field-error" role="alert">
                        {entryValidationMessages.expertPort}
                      </small>
                    ) : null}
                  </label>
                </div>
                <div className="expert-service-switches">
                  {(
                    [
                      ["responsesApiEnabled", "Responses API", "/v1/responses"],
                      ["chatCompletionsApiEnabled", "Chat Completions API", "/v1/chat/completions"],
                      ["taskApiEnabled", "Agent Task API", "/api/tasks"],
                    ] as const
                  ).map(([field, label, path]) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={form.expertServices?.[field] ?? false}
                        onChange={(event) =>
                          onFormChange({
                            ...form,
                            expertServices: {
                              ...(form.expertServices ?? DEFAULT_EXPERT_SERVICES),
                              [field]: event.target.checked,
                            },
                          })
                        }
                        disabled={isPending || readOnly}
                      />
                      <span>
                        <strong>{label}</strong>
                        <code>{path}</code>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ) : (
              <p className="managed-mode-note">
                {english
                  ? "Normal mode inherits the current network, provider, database, and service defaults automatically."
                  : "普通模式自动继承当前运行时的网络、模型、数据库与服务默认值，无需逐项配置。"}
              </p>
            )}
          </>
        ) : step === 2 ? (
          <div className="provider-model-step">
            <section className="provider-monitor provider-draft-configuration">
              {providerCheck.account ? (
                <div className="provider-account-summary">
                  <span>
                    {english ? "Account" : "账号"} ·{" "}
                    {providerCheck.account.status === "authenticated"
                      ? english
                        ? "Signed in"
                        : "已登录"
                      : english
                        ? "Not signed in"
                        : "未登录"}
                  </span>
                  {providerCheck.account.email ? (
                    <strong>{providerCheck.account.email}</strong>
                  ) : null}
                  {providerCheck.account.type ? <span>{providerCheck.account.type}</span> : null}
                  {providerCheck.account.plan ? <span>{providerCheck.account.plan}</span> : null}
                </div>
              ) : null}
              <div className="provider-monitor-heading">
                <div>
                  <span className="configuration-scope-badge">
                    {english ? "Pending configuration" : "待应用配置"}
                  </span>
                  <strong>{english ? "Model host and models" : "模型宿主与模型"}</strong>
                </div>
              </div>
              <p>
                {english
                  ? "Choose a host first. The model list below belongs to that host and changes with it."
                  : "先选择模型宿主；下方模型列表属于该宿主，并随宿主切换。"}
              </p>
              <div className="onboarding-choice-row provider-host-options">
                <button
                  className={
                    providerChoice === "codex-host"
                      ? "mode-button provider-host-tab mode-button-active"
                      : "mode-button provider-host-tab"
                  }
                  type="button"
                  onClick={() => selectProvider("codex-host")}
                  disabled={isPending || readOnly}
                >
                  Codex
                </button>
                <button
                  className={
                    providerChoice === "cursor-host"
                      ? "mode-button provider-host-tab mode-button-active"
                      : "mode-button provider-host-tab"
                  }
                  type="button"
                  onClick={() => selectProvider("cursor-host")}
                  disabled={isPending || readOnly}
                >
                  Cursor
                </button>
                <button
                  className={
                    providerChoice === "ollama"
                      ? "mode-button provider-host-tab mode-button-active"
                      : "mode-button provider-host-tab"
                  }
                  type="button"
                  onClick={() => selectProvider("ollama")}
                  disabled={isPending || readOnly}
                >
                  Ollama
                </button>
                <button
                  className={
                    providerChoice === "compatible"
                      ? "mode-button provider-host-tab mode-button-active"
                      : "mode-button provider-host-tab"
                  }
                  type="button"
                  onClick={() => selectProvider("compatible")}
                  disabled={isPending || readOnly}
                >
                  {english ? "Compatible service" : "其他兼容服务"}
                </button>
              </div>
              <fieldset className="model-source-options">
                <legend>{english ? "Model source" : "模型来源"}</legend>
                <button
                  className={
                    modelChoiceMode === "host"
                      ? "mode-button model-source-button mode-button-active"
                      : "mode-button model-source-button"
                  }
                  type="button"
                  onClick={() => selectModelChoiceMode("host")}
                  disabled={isPending || readOnly}
                >
                  {english ? "Host models" : "宿主模型"}
                </button>
                <button
                  className={
                    modelChoiceMode === "company"
                      ? "mode-button model-source-button mode-button-active"
                      : "mode-button model-source-button"
                  }
                  type="button"
                  onClick={() => selectModelChoiceMode("company")}
                  disabled={isPending || readOnly}
                >
                  {english ? "Company models" : "公司模型"}
                </button>
                <button
                  className={
                    modelChoiceMode === "custom"
                      ? "mode-button model-source-button mode-button-active"
                      : "mode-button model-source-button"
                  }
                  type="button"
                  onClick={() => selectModelChoiceMode("custom")}
                  disabled={isPending || readOnly}
                >
                  {english ? "Custom model" : "自定义模型"}
                </button>
              </fieldset>
              <div className="provider-model-heading">
                <span>
                  {modelChoiceMode === "company"
                    ? english
                      ? "Company models"
                      : "公司模型"
                    : modelChoiceMode === "custom"
                      ? english
                        ? "Custom model ID"
                        : "自定义模型 ID"
                      : english
                        ? `${providerLabel} host models`
                        : `${providerLabel} 宿主模型`}
                </span>
              </div>
              <div className="upstream-model-control" aria-live="polite">
                {modelChoiceMode !== "custom" && upstreamCatalogStatus === "loading" ? (
                  <p>{english ? "Loading available models…" : "正在读取可用模型…"}</p>
                ) : modelChoiceMode !== "custom" && upstreamCatalogStatus === "error" ? (
                  <p className="upstream-model-empty">
                    {modelChoiceMode === "company"
                      ? english
                        ? "The company service did not return a model catalog. Check it and try again."
                        : "公司服务未返回模型目录，请检查服务后重试。"
                      : english
                        ? `${providerLabel} model information could not be loaded.`
                        : `${providerLabel} 模型信息读取失败。`}
                  </p>
                ) : null}
                {modelChoiceMode !== "custom" && upstreamCatalogStatus === "ready" ? (
                  <label className="upstream-model-select">
                    <span>{english ? "Model" : "模型"}</span>
                    <select
                      value={selectedModelId}
                      onChange={(event) =>
                        selectMainModel({
                          source: modelChoiceMode === "company" ? "company" : hostModelSource,
                          model: event.target.value,
                        })
                      }
                      disabled={isPending || readOnly || modelSelectOptions.length === 0}
                    >
                      {modelSelectOptions.length === 0 ? (
                        <option value="">{english ? "No available models" : "暂无可用模型"}</option>
                      ) : null}
                      {modelSelectOptions.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {upstreamCatalogStatus === "ready" &&
                modelChoiceMode === "company" &&
                modelSelectOptions.length === 0 ? (
                  <p className="upstream-model-empty">
                    {english
                      ? "No company models were returned. Configure the company service, then refresh and select a fetched model."
                      : "公司服务尚未返回模型，请完成公司服务配置，刷新后从获取结果中选择。"}
                  </p>
                ) : null}
              </div>
              {modelChoiceMode === "custom" ? (
                <label className="upstream-custom-model">
                  {english ? "Custom model ID" : "自定义模型 ID"}
                  <input
                    value={customModel}
                    onChange={(event) => {
                      const customModel = event.target.value;
                      selectMainModel({ source: "custom", model: customModel });
                    }}
                    placeholder={english ? "Enter a custom model ID" : "输入自定义模型 ID"}
                    disabled={isPending || readOnly}
                  />
                  <small>
                    {english
                      ? "Custom input is exclusive with host and company model selections."
                      : "自定义输入与宿主模型、公司模型选择互斥。"}
                  </small>
                </label>
              ) : null}
              <section className="capability-completion-editor">
                <div className="capability-completion-editor-heading">
                  <div>
                    <p className="card-label">CAPABILITY COMPLETION</p>
                    <h3>{english ? "Model capability completion" : "模型能力互补"}</h3>
                    <p>
                      {english
                        ? "The selected host is the primary. Specialists must come from other hosts and run only for missing capabilities."
                        : "当前选择的宿主就是主模型入口；副模型必须来自其他宿主，仅在主模型缺少任务能力时补位。"}
                    </p>
                  </div>
                  <label className="capability-toggle">
                    <input
                      type="checkbox"
                      checked={form.capabilityCompletion.enabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        const mainCapabilities = enabled
                          ? capabilitiesForMainModel(activeHostPolicy.mainModel)
                          : activeHostPolicy.mainCapabilities;
                        const maximumSpecialists = Math.max(1, activeHostPolicy.specialists.length);
                        onFormChange({
                          ...form,
                          capabilityCompletion: {
                            ...form.capabilityCompletion,
                            enabled,
                            mainCapabilities,
                            maximumSpecialists,
                            hostPolicies: {
                              ...form.capabilityCompletion.hostPolicies,
                              [activeHostId]: {
                                ...activeHostPolicy,
                                mainCapabilities,
                                maximumSpecialists,
                              },
                            },
                          },
                        });
                      }}
                      disabled={
                        isPending ||
                        readOnly ||
                        (modelChoiceMode !== "custom" && upstreamCatalogStatus === "loading")
                      }
                    />
                    <span className="capability-toggle-track" aria-hidden="true" />
                    <span className="capability-toggle-label">
                      {form.capabilityCompletion.enabled
                        ? english
                          ? "Enabled"
                          : "已开启"
                        : english
                          ? "Disabled"
                          : "已关闭"}
                    </span>
                  </label>
                </div>
                {form.capabilityCompletion.enabled ? (
                  <>
                    <section className="capability-primary-card">
                      <div className="capability-section-heading">
                        <div>
                          <h4>
                            {english ? "1. Declare primary capabilities" : "1. 勾选主模型真实能力"}
                          </h4>
                          <p>
                            {english
                              ? "Only select capabilities verified for this model."
                              : "只勾选已确认可用的能力；路由会把未勾选能力视为缺口。"}
                          </p>
                        </div>
                      </div>
                      {modelChoiceMode !== "custom" && upstreamCatalogStatus === "loading" ? (
                        <div className="capability-loading" role="status">
                          <span aria-hidden="true" />
                          {english ? "Loading model capabilities…" : "正在读取模型能力…"}
                        </div>
                      ) : modelChoiceMode !== "custom" && upstreamCatalogStatus === "error" ? (
                        <p className="capability-loading-error">
                          {english
                            ? "Model capabilities could not be loaded. Refresh and try again."
                            : "模型能力读取失败，请刷新后重试。"}
                        </p>
                      ) : (
                        <CapabilityPicker
                          selected={activeHostPolicy.mainCapabilities}
                          available={
                            modelChoiceMode === "custom"
                              ? undefined
                              : (primaryCatalogModel?.capabilities ?? [])
                          }
                          english={english}
                          disabled={isPending || readOnly}
                          onChange={(mainCapabilities) =>
                            updateActiveHostPolicy({
                              ...activeHostPolicy,
                              mainCapabilities,
                            })
                          }
                        />
                      )}
                    </section>
                    <div className="capability-specialists">
                      <div className="capability-section-heading">
                        <div>
                          <h4>{english ? "2. Select specialist models" : "2. 选择副模型"}</h4>
                          <p>
                            {english
                              ? "Specialists come from other hosts. Selecting at most two usually minimizes cost."
                              : "副模型来自其他宿主；建议最多选择 2 个，通常更省成本。"}
                          </p>
                        </div>
                      </div>
                      {upstreamCatalogStatus === "loading" ? (
                        <div className="capability-loading" role="status">
                          <span aria-hidden="true" />
                          {english ? "Loading specialist models…" : "正在读取副模型…"}
                        </div>
                      ) : upstreamCatalogStatus === "error" ? (
                        <p className="capability-loading-error" role="alert">
                          {english
                            ? "Specialist models could not be loaded. Refresh and try again."
                            : "副模型读取失败，请刷新后重试。"}
                        </p>
                      ) : (
                        <>
                          {activeHostPolicy.specialists.map((specialist, index) => {
                            const hostAvailable = availableSpecialistHosts.includes(
                              specialist.host,
                            );
                            const keysUsedByOtherRows = new Set(
                              activeHostPolicy.specialists
                                .filter((_, specialistIndex) => specialistIndex !== index)
                                .map((item) => specialistKey(item.host, item.model)),
                            );
                            const selectableHosts = availableSpecialistHosts.filter((host) =>
                              usableSpecialistModels(host).some(
                                (model) => !keysUsedByOtherRows.has(specialistKey(host, model.id)),
                              ),
                            );
                            const modelOptions = usableSpecialistModels(specialist.host).filter(
                              (model) =>
                                model.id === specialist.model ||
                                !keysUsedByOtherRows.has(specialistKey(specialist.host, model.id)),
                            );
                            const selectedCatalogModel = modelOptions.find(
                              (model) => model.id === specialist.model,
                            );
                            const addedCapabilities = specialist.capabilities.filter(
                              (capability) =>
                                !activeHostPolicy.mainCapabilities.includes(capability),
                            );
                            const knownCost =
                              specialist.inputCostPerMillionTokens != null ||
                              specialist.outputCostPerMillionTokens != null;
                            if (!hostAvailable) {
                              return (
                                <article
                                  className="capability-specialist-card"
                                  key={`${specialist.host}:${specialist.model}:${index}`}
                                >
                                  <div className="capability-specialist-heading">
                                    <div>
                                      <span>
                                        {english ? "Unavailable specialist" : "不可用的副模型配置"}
                                      </span>
                                      <strong>{hostLabel(specialist.host)}</strong>
                                    </div>
                                    <span className="warning">
                                      {english ? "Not selectable" : "不参与选择与路由"}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSpecialists(
                                          activeHostPolicy.specialists.filter(
                                            (_, specialistIndex) => specialistIndex !== index,
                                          ),
                                        )
                                      }
                                      disabled={isPending || readOnly}
                                    >
                                      {english ? "Remove" : "移除"}
                                    </button>
                                  </div>
                                  <p className="capability-evidence">
                                    {english
                                      ? "This saved host is currently unavailable or exposes no models. It has no capability controls."
                                      : "该已保存宿主当前不可用或未提供模型，因此不展示能力项，也不会参与互补路由。"}
                                  </p>
                                </article>
                              );
                            }
                            return (
                              <article
                                className="capability-specialist-card"
                                key={`${specialist.host}:${specialist.model}:${index}`}
                              >
                                <div className="capability-specialist-heading">
                                  <div>
                                    <span>
                                      {english ? `Specialist ${index + 1}` : `副模型 ${index + 1}`}
                                    </span>
                                    <strong>
                                      {selectedCatalogModel?.name ||
                                        specialist.model ||
                                        (english ? "Model not selected" : "尚未选择模型")}
                                    </strong>
                                  </div>
                                  <span
                                    className={addedCapabilities.length > 0 ? "gain" : "warning"}
                                  >
                                    {addedCapabilities.length > 0
                                      ? `${english ? "Adds" : "新增"} ${addedCapabilities.length}`
                                      : english
                                        ? "No added capability"
                                        : "无新增能力"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateSpecialists(
                                        activeHostPolicy.specialists.filter(
                                          (_, specialistIndex) => specialistIndex !== index,
                                        ),
                                      )
                                    }
                                    disabled={isPending || readOnly}
                                  >
                                    {english ? "Remove" : "移除"}
                                  </button>
                                </div>
                                <div className="capability-specialist-fields">
                                  <select
                                    aria-label={english ? "Specialist host" : "副模型宿主"}
                                    value={specialist.host}
                                    onChange={(event) => {
                                      const host = event.target.value as AgentHostId;
                                      const selectedModel = usableSpecialistModels(host).find(
                                        (model) =>
                                          !keysUsedByOtherRows.has(specialistKey(host, model.id)),
                                      );
                                      if (selectedModel === undefined) return;
                                      const specialists = [...activeHostPolicy.specialists];
                                      specialists[index] = {
                                        host,
                                        source: modelSourceForHost(host),
                                        model: selectedModel.id,
                                        capabilities: selectedModel.capabilities ?? [],
                                        inputCostPerMillionTokens:
                                          selectedModel.inputCostPerMillionTokens ?? null,
                                        outputCostPerMillionTokens:
                                          selectedModel.outputCostPerMillionTokens ?? null,
                                      };
                                      updateSpecialists(specialists);
                                    }}
                                    disabled={isPending || readOnly}
                                  >
                                    {selectableHosts.map((host) => (
                                      <option key={host} value={host}>
                                        {hostLabel(host)}
                                        {upstreamCatalog.hosts[host]?.available
                                          ? ""
                                          : english
                                            ? " · unavailable"
                                            : " · 不可用"}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    aria-label={english ? "Specialist model" : "副模型"}
                                    value={specialist.model}
                                    onChange={(event) => {
                                      const selectedModel = modelOptions.find(
                                        (model) => model.id === event.target.value,
                                      );
                                      const specialists = [...activeHostPolicy.specialists];
                                      specialists[index] = {
                                        ...specialist,
                                        model: event.target.value,
                                        capabilities: selectedModel?.capabilities ?? [],
                                        inputCostPerMillionTokens:
                                          selectedModel?.inputCostPerMillionTokens ?? null,
                                        outputCostPerMillionTokens:
                                          selectedModel?.outputCostPerMillionTokens ?? null,
                                      };
                                      updateSpecialists(specialists);
                                    }}
                                    disabled={isPending || readOnly || modelOptions.length === 0}
                                  >
                                    <option value="">
                                      {modelOptions.length === 0
                                        ? english
                                          ? "No models discovered for this host"
                                          : "该宿主未发现可用模型"
                                        : english
                                          ? "Select from this host"
                                          : "从该宿主模型中选择"}
                                    </option>
                                    {modelOptions.map((model) => (
                                      <option key={model.id} value={model.id}>
                                        {model.name}
                                      </option>
                                    ))}
                                  </select>
                                  <div className="capability-cost-status">
                                    <span>{english ? "Cost" : "费用"}</span>
                                    <strong>
                                      {knownCost
                                        ? `${specialist.inputCostPerMillionTokens ?? "?"} / ${specialist.outputCostPerMillionTokens ?? "?"} / 1M tokens`
                                        : specialist.host === "codex" ||
                                            specialist.host === "cursor"
                                          ? english
                                            ? "Account quota · unit price unavailable"
                                            : "宿主账号额度 · 未提供单价"
                                          : english
                                            ? "Unknown · excluded from cheapest ranking"
                                            : "价格未知 · 不参与最省钱排序"}
                                    </strong>
                                  </div>
                                </div>
                                {selectedCatalogModel?.capabilities?.length ? (
                                  <p className="capability-evidence">
                                    {english
                                      ? "Capabilities published by catalog"
                                      : "模型目录已发布能力"}
                                    ：
                                    {selectedCatalogModel.capabilities
                                      .map((item) => capabilityLabel(item, english))
                                      .join("、")}
                                  </p>
                                ) : null}
                                {selectedCatalogModel === undefined ? null : selectedCatalogModel
                                    .capabilities?.length ? (
                                  <CapabilityPicker
                                    selected={specialist.capabilities}
                                    available={selectedCatalogModel.capabilities}
                                    english={english}
                                    disabled={isPending || readOnly}
                                    onChange={(capabilities) => {
                                      const specialists = [...activeHostPolicy.specialists];
                                      specialists[index] = {
                                        ...specialist,
                                        capabilities,
                                      };
                                      updateSpecialists(specialists);
                                    }}
                                  />
                                ) : (
                                  <p className="capability-evidence warning">
                                    {english
                                      ? "This model did not publish capability metadata and cannot be used for capability completion."
                                      : "该模型未发布能力信息，不能用于能力互补。"}
                                  </p>
                                )}
                                {specialist.host === "ollama" ||
                                specialist.host === "openai-compatible" ? (
                                  <div className="capability-cost-inputs">
                                    <label>
                                      {english ? "Input / 1M tokens" : "输入价 / 百万 Token"}
                                      <input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={specialist.inputCostPerMillionTokens ?? ""}
                                        placeholder={english ? "Unknown" : "未知"}
                                        onChange={(event) => {
                                          const specialists = [...activeHostPolicy.specialists];
                                          specialists[index] = {
                                            ...specialist,
                                            inputCostPerMillionTokens:
                                              event.target.value === ""
                                                ? null
                                                : Number(event.target.value),
                                          };
                                          updateSpecialists(specialists);
                                        }}
                                        disabled={isPending || readOnly}
                                      />
                                    </label>
                                    <label>
                                      {english ? "Output / 1M tokens" : "输出价 / 百万 Token"}
                                      <input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        value={specialist.outputCostPerMillionTokens ?? ""}
                                        placeholder={english ? "Unknown" : "未知"}
                                        onChange={(event) => {
                                          const specialists = [...activeHostPolicy.specialists];
                                          specialists[index] = {
                                            ...specialist,
                                            outputCostPerMillionTokens:
                                              event.target.value === ""
                                                ? null
                                                : Number(event.target.value),
                                          };
                                          updateSpecialists(specialists);
                                        }}
                                        disabled={isPending || readOnly}
                                      />
                                    </label>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => {
                              const choice = availableNewSpecialistModels[0];
                              if (choice === undefined) return;
                              updateSpecialists([
                                ...activeHostPolicy.specialists,
                                {
                                  host: choice.host,
                                  source: modelSourceForHost(choice.host),
                                  model: choice.model.id,
                                  capabilities: choice.model.capabilities ?? [],
                                  inputCostPerMillionTokens:
                                    choice.model.inputCostPerMillionTokens ?? null,
                                  outputCostPerMillionTokens:
                                    choice.model.outputCostPerMillionTokens ?? null,
                                },
                              ]);
                            }}
                            disabled={
                              isPending || readOnly || availableNewSpecialistModels.length === 0
                            }
                          >
                            {availableNewSpecialistModels.length === 0
                              ? english
                                ? "Every available specialist model is already configured"
                                : "全部可用副模型均已配置"
                              : english
                                ? "Add specialist model"
                                : "添加副模型"}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                ) : null}
              </section>
              {!providerConfigured || !choiceMatchesRuntime ? (
                <>
                  <textarea
                    className="onboarding-command"
                    aria-label={english ? "Provider startup command" : "模型服务启动命令"}
                    readOnly
                    wrap="soft"
                    rows={providerChoice === "compatible" ? 3 : 2}
                    value={
                      providerChoice === "codex-host"
                        ? "TIDU_PROVIDER=codex-host\ntidu start  # follows the current Codex model"
                        : providerChoice === "cursor-host"
                          ? "TIDU_PROVIDER=cursor-host\ntidu start  # follows the current Cursor model"
                          : providerChoice === "ollama"
                            ? "TIDU_PROVIDER=ollama\nTIDU_PROVIDER_MODEL=<installed-model> tidu start"
                            : "TIDU_PROVIDER=openai-compatible\nTIDU_PROVIDER_BASE_URL=<service-url>\nTIDU_PROVIDER_MODEL=<model> TIDU_PROVIDER_API_KEY=<runtime-key> tidu start"
                    }
                  />
                  <p>
                    {providerChoice === "compatible"
                      ? english
                        ? "Set the compatible service URL and model, then restart. Secrets stay in the process environment."
                        : "填写兼容服务地址和模型名后重启；密钥只从进程环境读取。"
                      : english
                        ? `Restart AI-Tidu9 with ${providerLabel} to load this host and its model catalog.`
                        : `使用 ${providerLabel} 重启九门后，才会加载该宿主及其模型目录。`}
                  </p>
                </>
              ) : null}
            </section>
          </div>
        ) : step === 3 ? (
          <>
            <p className="onboarding-kicker">{english ? "Safe activation" : "安全启用"}</p>
            <h3>{english ? "Save → preview → activate" : "保存 → 模拟 → 启用"}</h3>
            <div className="onboarding-choice-row">
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={readOnly || !isDirty || isPending}
              >
                {english ? "1. Save" : "1. 保存草稿"}
              </button>
              <button
                type="button"
                onClick={() => void onSimulate()}
                disabled={readOnly || isDirty || isPending}
              >
                {english ? "2. Preview" : "2. 模拟影响"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void onActivate()}
                disabled={readOnly || isDirty || isPending || impactPreview?.valid !== true}
              >
                {english ? "3. Activate" : "3. 启用配置"}
              </button>
              <button type="button" onClick={() => void onRollback()} disabled={isPending}>
                {english ? "Rollback" : "回滚"}
              </button>
            </div>
            {impactPreview ? (
              <section
                className={`impact-preview ${impactPreview.valid ? "impact-preview-valid" : "impact-preview-invalid"}`}
                aria-live="polite"
              >
                <div className="impact-preview-heading">
                  <strong>
                    {impactPreview.valid
                      ? english
                        ? "Preview passed"
                        : "模拟通过"
                      : english
                        ? "Activation blocked"
                        : "无法启用"}
                  </strong>
                  <span>
                    {english
                      ? `${impactPreview.risk} risk`
                      : `${impactPreview.risk === "low" ? "低" : "中"}风险`}
                  </span>
                </div>
                {impactPreview.changes.length === 0 ? (
                  <p>{english ? "No runtime changes." : "与当前生效配置一致，无运行影响。"}</p>
                ) : (
                  <ul>
                    {impactPreview.changes.map((change) => (
                      <li key={change}>{impactChangeLabel(change, form, selectedMode, locale)}</li>
                    ))}
                  </ul>
                )}
                {impactPreview.restartRequired ? (
                  <p className="impact-restart">
                    {english
                      ? "The listener address changed. Restart the runtime after activation."
                      : "监听地址发生变化；启用后需要重启运行时。"}
                  </p>
                ) : null}
                {impactPreview.issues.length > 0 ? (
                  <ul className="impact-issues">
                    {impactPreview.issues.map((issue) => (
                      <li key={`${issue.code}-${issue.field}`}>{issue.message}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        ) : (
          <>
            <p className="onboarding-kicker">{english ? "Connect your tools" : "连接日常工具"}</p>
            <h3>{english ? "One core, every supported surface" : "一个核心，接入所有支持入口"}</h3>
            <p>
              {english
                ? "Review detected Codex, Cursor, CLI, and generic-client entries, then install only AI-Tidu9-owned connectors."
                : "检查已发现的Codex、Cursor、CLI与通用客户端，再安装九门自有连接器。"}
            </p>
            <button className="primary-button" type="button" onClick={onOpenClients}>
              {english ? "Open client setup" : "进入客户端接入"}
            </button>
          </>
        )}
      </div>

      <div className="onboarding-navigation">
        <button
          type="button"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0}
        >
          {english ? "Back" : "上一步"}
        </button>
        <button
          type="button"
          onClick={() => void advanceStep()}
          disabled={step === stepLabels.length - 1 || !canAdvance || isPending}
        >
          {english ? "Next" : "下一步"}
        </button>
      </div>
    </section>
  );
};

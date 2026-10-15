import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskControlView } from "../../src/agent/index.js";
import {
  type ConfigurationMode,
  type ExpertServiceConfiguration,
  type TiduConfiguration,
  validateConfiguration,
} from "../../src/config/index.js";
import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";
import "./styles.scss";

type LoadingState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: ConfigCenterBootstrap }
  | { status: "error"; message: string };

type OperationState =
  | { status: "idle" }
  | { status: "pending"; action: "activate" | "rollback" | "save" | "simulate" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type ClientConnectionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

interface ConfigurationForm {
  /** Stable lowercase identifier used to select this profile. */
  activeProfileId: string;
  /** User-facing virtual-model name exposed by compatible clients. */
  virtualModelName: string;
  /** Advanced runtime service controls available only in expert mode. */
  expertServices?: ExpertServiceConfiguration;
}

interface EntryValidationMessages {
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

interface HostUsageSnapshot {
  /** Active model provider in the local runtime. */
  activeProvider: { type: string; model: string } | null;
  /** Codex account and official usage data, when available. */
  codex: {
    account: { type: string; email: string | null; plan: string | null } | null;
    usage: {
      limitId: string | null;
      primary: {
        usedPercent: number;
        windowDurationMins: number | null;
        resetsAt: number | null;
      } | null;
      secondary: {
        usedPercent: number;
        windowDurationMins: number | null;
        resetsAt: number | null;
      } | null;
      creditBalance: string | null;
      availableResetCredits: number | null;
      lifetimeTokens: number | null;
      dailyTokens: readonly { date: string; tokens: number }[];
    } | null;
  } | null;
  /** Cursor account connection and selected Agent model, when reported. */
  cursor: {
    agentStatus: string;
    agentProtocolAvailable: boolean;
    accountEmail: string | null;
    /** Subscription plan reported by the official Cursor status command. */
    accountPlan: string | null;
    model: string | null;
  };
}

interface EnterpriseMemberUsageReport {
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

const formatResetTime = (timestamp: number | null, locale: "en-US" | "zh-CN"): string =>
  timestamp === null
    ? locale === "zh-CN"
      ? "未提供"
      : "Not reported"
    : new Date(timestamp * 1000).toLocaleString(locale);

const resolveCodexPlanPricing = (
  plan: string | null | undefined,
): { price: string; unit: string; tierKnown: boolean } => {
  const normalizedPlan = plan?.trim().toLowerCase();
  if (normalizedPlan === "free") return { price: "$0", unit: "USD / month", tierKnown: true };
  if (normalizedPlan === "plus") return { price: "$20", unit: "USD / month", tierKnown: true };
  if (normalizedPlan === "pro") {
    return { price: "$100 / $200 / $500", unit: "USD / month", tierKnown: false };
  }
  return { price: "—", unit: "—", tierKnown: false };
};

const HostUsagePanel = ({
  snapshot,
  locale,
  onRefresh,
  onConnectCursor,
  connectingCursor,
  cursorConnectionError,
}: {
  snapshot: HostUsageSnapshot | null;
  locale: "en-US" | "zh-CN";
  onRefresh: () => void;
  onConnectCursor: () => void;
  connectingCursor: boolean;
  cursorConnectionError: string | null;
}) => {
  const chinese = locale === "zh-CN";
  const usage = snapshot?.codex?.usage;
  const codexPricing = resolveCodexPlanPricing(snapshot?.codex?.account?.plan);
  return (
    <section className="host-usage-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">MODEL USAGE</p>
          <h2>{chinese ? "模型与额度统计" : "Model usage and limits"}</h2>
          <p>
            {chinese
              ? "按宿主显示官方数据；没有接口的数据明确标为未提供。"
              : "Official host data is shown per source; unavailable fields stay unreported."}
          </p>
        </div>
        <button type="button" onClick={onRefresh}>
          {chinese ? "刷新数据" : "Refresh"}
        </button>
      </div>
      <div className="host-usage-grid">
        <article className="card">
          <p className="card-label">CODEX</p>
          <h2>{chinese ? "Codex 账号" : "Codex account"}</h2>
          <p>
            {chinese ? "账号" : "Account"}：
            {snapshot?.codex?.account?.email ??
              snapshot?.codex?.account?.type ??
              (chinese ? "未读取到" : "Unavailable")}
          </p>
          <p>
            {chinese ? "套餐" : "Plan"}：
            {snapshot?.codex?.account?.plan ?? (chinese ? "官方接口未提供" : "Not reported")}
          </p>
          <p>
            {chinese ? "价格" : "Price"}：{codexPricing.price}
          </p>
          <p>
            {chinese ? "计费单位" : "Billing unit"}：
            {codexPricing.unit === "USD / month" && chinese ? "USD / 月" : codexPricing.unit}
          </p>
          {!codexPricing.tierKnown && snapshot?.codex?.account?.plan?.toLowerCase() === "pro" ? (
            <p className="account-note">
              {chinese
                ? "账号接口仅返回 Pro，未返回 Pro 100、Pro 200 或 Pro 500 的具体档位。"
                : "The account API reports Pro without identifying the Pro 100, Pro 200, or Pro 500 tier."}{" "}
              <a
                href="https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers"
                target="_blank"
                rel="noreferrer"
              >
                {chinese ? "查看官方定价" : "View official pricing"}
              </a>
            </p>
          ) : null}
          <p>
            {chinese ? "当前运行模型" : "Active runtime model"}：
            {snapshot?.activeProvider?.type === "codex-host" ? snapshot.activeProvider.model : "—"}
          </p>
          <p>
            {chinese ? "剩余额度（短周期）" : "Remaining short-window quota"}：
            {usage?.primary ? `${Math.max(0, 100 - usage.primary.usedPercent).toFixed(1)}%` : "—"}
          </p>
          <p>
            {chinese ? "重置时间" : "Resets at"}：
            {formatResetTime(usage?.primary?.resetsAt ?? null, locale)}
          </p>
          <p>
            {chinese ? "剩余额度（长周期）" : "Remaining long-window quota"}：
            {usage?.secondary
              ? `${Math.max(0, 100 - usage.secondary.usedPercent).toFixed(1)}%`
              : "—"}
          </p>
          <p>
            {chinese ? "重置时间" : "Resets at"}：
            {formatResetTime(usage?.secondary?.resetsAt ?? null, locale)}
          </p>
          <p>
            {chinese ? "可用重置次数" : "Available resets"}：{usage?.availableResetCredits ?? "—"}
          </p>
          <p>
            {chinese ? "预付余额" : "Credit balance"}：{usage?.creditBalance ?? "—"}
          </p>
          <p>
            {chinese ? "账户累计 Token" : "Lifetime account tokens"}：
            {usage?.lifetimeTokens?.toLocaleString(locale) ?? "—"}
          </p>
          <div className="account-history">
            <h3>{chinese ? "每日使用量" : "Daily usage"}</h3>
            {usage?.dailyTokens.length ? (
              <div className="usage-history">
                {usage.dailyTokens.map((bucket) => (
                  <p key={bucket.date}>
                    <span>{bucket.date}</span>
                    <strong>{bucket.tokens.toLocaleString(locale)} tokens</strong>
                  </p>
                ))}
              </div>
            ) : (
              <p>{chinese ? "宿主没有返回每日统计。" : "The host did not return daily usage."}</p>
            )}
            <p className="account-note">
              {chinese
                ? "官方数据为账号汇总与每日总量，未提供按模型拆分。"
                : "Official data includes account and daily totals without a per-model breakdown."}
            </p>
          </div>
        </article>
        <article className="card">
          <p className="card-label">CURSOR</p>
          <h2>
            {snapshot?.cursor.agentStatus === "authenticated"
              ? chinese
                ? "账号已连接"
                : "Account connected"
              : chinese
                ? "连接账号后读取模型"
                : "Connect account to read model"}
          </h2>
          <p>
            {chinese ? "账号" : "Account"}：
            {snapshot?.cursor.accountEmail ??
              (snapshot?.cursor.agentStatus === "authenticated"
                ? chinese
                  ? "已连接"
                  : "Connected"
                : chinese
                  ? "尚未连接"
                  : "Not connected")}
          </p>
          <p>
            {chinese ? "套餐" : "Plan"}：
            {snapshot?.cursor.accountPlan ?? (chinese ? "官方接口未提供" : "Not reported")}
          </p>
          <p>
            {chinese ? "价格" : "Price"}：{chinese ? "官方接口未提供" : "Not reported"}
          </p>
          <p>{chinese ? "计费单位" : "Billing unit"}：—</p>
          <p>
            {chinese ? "可用 Agent 模型" : "Agent model"}：{snapshot?.cursor.model ?? "—"}
          </p>
          <p>
            {chinese ? "剩余额度与重置次数" : "Remaining quota and resets"}：
            {chinese ? "请在 Cursor 设置或用量面板查看" : "See Cursor settings or usage dashboard"}
          </p>
          {snapshot?.cursor.agentStatus !== "authenticated" ? (
            <button type="button" onClick={onConnectCursor} disabled={connectingCursor}>
              {connectingCursor
                ? chinese
                  ? "等待浏览器授权…"
                  : "Waiting for browser sign-in…"
                : chinese
                  ? "连接 Cursor 账号"
                  : "Connect Cursor account"}
            </button>
          ) : null}
          {cursorConnectionError ? <p role="alert">{cursorConnectionError}</p> : null}
          <p>
            {chinese
              ? "连接会打开 Cursor 官方浏览器授权；凭据由 Cursor 管理。"
              : "Connection opens Cursor's official browser sign-in; Cursor manages the credentials."}
          </p>
          <a href="https://cursor.com/dashboard" target="_blank" rel="noreferrer">
            {chinese ? "打开 Cursor 用量面板" : "Open Cursor usage dashboard"}
          </a>
        </article>
      </div>
    </section>
  );
};

interface ConfigurationImpactPreview {
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

const TaskControlPanel = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
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

const requestBootstrap = async (
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

const DEFAULT_EXPERT_SERVICES: ExpertServiceConfiguration = {
  host: "127.0.0.1",
  port: 9639,
  responsesApiEnabled: true,
  chatCompletionsApiEnabled: true,
  taskApiEnabled: true,
};

const toForm = (configuration: TiduConfiguration): ConfigurationForm => ({
  activeProfileId: configuration.activeProfileId,
  virtualModelName: configuration.virtualModelName,
  ...(configuration.activeMode === "expert"
    ? {
        expertServices: configuration.expertServices ?? DEFAULT_EXPERT_SERVICES,
      }
    : {}),
});

const modeLabel = (mode: ConfigurationMode, locale: "en-US" | "zh-CN" = "zh-CN"): string =>
  locale === "zh-CN"
    ? mode === "managed"
      ? "普通模式"
      : "专家模式"
    : mode === "managed"
      ? "Normal"
      : "Expert";

const providerReasonLabel = (reason: string | undefined, locale: "en-US" | "zh-CN"): string => {
  const chinese: Record<string, string> = {
    "codex-cli-unavailable": "Codex CLI 未安装或命令不可用",
    "codex-not-authenticated": "Codex CLI 尚未登录",
    "codex-model-undiscovered": "Codex CLI 未返回当前模型配置",
    "cursor-cli-unavailable": "Cursor Agent CLI 未安装或命令不可用",
    "cursor-not-authenticated": "Cursor Agent CLI 尚未登录",
    "cursor-acp-unavailable": "Cursor Agent CLI 未提供 ACP 模型配置",
    "cursor-model-undiscovered": "Cursor ACP 未返回当前模型配置",
    "ollama-unavailable": "无法连接本机 Ollama 服务",
    "ollama-no-models": "Ollama 服务已启动，但尚未安装模型",
    "compatible-provider-not-active": "当前运行未使用兼容服务；切换并重启后可重新检测",
    "detection-failed": "读取配置失败，请稍后重新检测",
  };
  const englishLabels: Record<string, string> = {
    "codex-cli-unavailable": "Codex CLI is unavailable",
    "codex-not-authenticated": "Codex CLI is not signed in",
    "codex-model-undiscovered": "Codex CLI did not report its current model configuration",
    "cursor-cli-unavailable": "Cursor Agent CLI is unavailable",
    "cursor-not-authenticated": "Cursor Agent CLI is not signed in",
    "cursor-acp-unavailable": "Cursor Agent CLI does not expose model configuration over ACP",
    "cursor-model-undiscovered": "Cursor ACP did not report its current model configuration",
    "ollama-unavailable": "The local Ollama service is unreachable",
    "ollama-no-models": "Ollama is running but has no installed models",
    "compatible-provider-not-active":
      "The compatible service is not active; switch and restart to detect it",
    "detection-failed": "Configuration lookup failed; try again",
  };
  const labels = locale === "zh-CN" ? chinese : englishLabels;
  return (
    labels[reason ?? ""] ??
    (locale === "zh-CN" ? "未发现该服务的模型配置" : "No model configuration found")
  );
};

const clientReadinessLabel = (
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

const clientIntegrationLabel = (
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

const GuideCenter = ({ locale }: { locale: "en-US" | "zh-CN" }) => {
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
                <li>远程服务通过 --endpoint 指定管理地址。</li>
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

const PersonalExperiencePanel = ({
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

const EnterpriseReadOnlyPanel = ({
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
      const result = (await response.json()) as ConfigCenterBootstrap & { message?: string };
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

const EnterpriseEditionPanel = ({
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
  /** Start the official Cursor browser sign-in flow. */
  onConnectCursor: () => Promise<void>;
}

const QuickStartWizard = ({
  locale,
  enterpriseEnabled,
  providerConfigured,
  providerType,
  providerModel,
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
  onConnectCursor,
}: QuickStartWizardProps) => {
  const english = locale === "en-US";
  const [step, setStep] = useState(0);
  const [showProviderOverride, setShowProviderOverride] = useState(false);
  const [providerChoice, setProviderChoice] = useState<
    "codex-host" | "cursor-host" | "ollama" | "compatible"
  >(() =>
    providerType === "cursor-host"
      ? "cursor-host"
      : providerType === "ollama"
        ? "ollama"
        : providerType === "openai-compatible"
          ? "compatible"
          : "codex-host",
  );
  const [providerCheck, setProviderCheck] = useState<{
    status: "idle" | "checking" | "ready" | "unavailable" | "restart-required";
    provider?: string;
    model?: string;
    reason?: string;
    account?: {
      status: string;
      type: string | null;
      email: string | null;
      plan: string | null;
    } | null;
  }>({ status: "idle" });
  const [providerCheckRevision, setProviderCheckRevision] = useState(0);
  useEffect(() => {
    setStep(selectedMode === "expert" ? 1 : 0);
    setProviderCheck({ status: "idle" });
  }, [selectedMode]);
  const stepLabels = english
    ? ["Deployment", "Entry", "Model", "Activate", "Clients (optional)"]
    : ["部署", "入口", "模型", "启用", "客户端（可选）"];
  const entryIsValid = Object.keys(entryValidationMessages).length === 0;
  const entryIsComplete = entryIsValid && !isDirty;
  const clientSetupIsAvailable = isActive && !isDirty;
  const isCurrentHostProvider = providerType === "codex-host" || providerType === "cursor-host";
  const choiceMatchesRuntime =
    (providerChoice === "codex-host" && providerType === "codex-host") ||
    (providerChoice === "cursor-host" && providerType === "cursor-host") ||
    (providerChoice === "ollama" && providerType === "ollama") ||
    (providerChoice === "compatible" && providerType === "openai-compatible");
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
  useEffect(() => {
    if (step !== 2) return;
    let current = true;
    setProviderCheck({ status: "checking", provider: providerChoice });
    void fetch("/api/provider/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: providerChoice }),
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(
        async (response) =>
          (await response.json()) as {
            detected?: boolean;
            matchesRuntime?: boolean;
            model?: string | null;
            reason?: string | null;
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
          provider: providerChoice,
          status: !result.detected
            ? "unavailable"
            : result.matchesRuntime
              ? "ready"
              : "restart-required",
          ...(result.model ? { model: result.model } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          account: result.account ?? null,
        });
      })
      .catch(() => {
        if (current)
          setProviderCheck({
            status: "unavailable",
            provider: providerChoice,
            reason: "detection-failed",
          });
      });
    return () => {
      current = false;
    };
  }, [step, providerChoice, providerCheckRevision]);
  const canAdvance =
    step === 1
      ? entryIsValid
      : step === 2
        ? entryIsComplete &&
          providerConfigured &&
          choiceMatchesRuntime &&
          providerCheck.status === "ready" &&
          providerCheck.provider === providerChoice
        : step === 3
          ? clientSetupIsAvailable
          : true;
  const advanceStep = async (): Promise<void> => {
    if (!canAdvance) {
      return;
    }
    if (step === 1 && isDirty && !(await onSave())) {
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
                    onFormChange({ ...form, activeProfileId: event.target.value })
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
                    onFormChange({ ...form, virtualModelName: event.target.value })
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
          <>
            <p className="onboarding-kicker">
              {english ? `Selected provider · ${providerLabel}` : `当前检测 · ${providerLabel}`}
            </p>
            {providerConfigured ? (
              <>
                <h3>
                  {isCurrentHostProvider
                    ? english
                      ? `Current host model · ${providerModel ?? "default"}`
                      : `当前宿主模型 · ${providerModel ?? "默认"}`
                    : `${providerType ?? "Provider"} · ${providerModel ?? ""}`}
                </h3>
                <p>
                  {isCurrentHostProvider
                    ? english
                      ? "The host's current model is detected automatically. You can override it with another provider below."
                      : "模型由宿主自动识别；如需切换，可选择其他供应商。"
                    : english
                      ? "A provider override is active. Select another service below to change it."
                      : "当前使用的是手动指定的模型服务；可在下方切换。"}
                </p>
                <div className="onboarding-choice-row">
                  <button
                    type="button"
                    onClick={() => setShowProviderOverride((current) => !current)}
                  >
                    {showProviderOverride
                      ? english
                        ? "Use current model"
                        : "继续使用当前模型"
                      : english
                        ? "Change model"
                        : "修改模型"}
                  </button>
                </div>
              </>
            ) : null}
            {!providerConfigured || showProviderOverride ? (
              <>
                <div className="onboarding-choice-row">
                  <button
                    className={
                      providerChoice === "codex-host"
                        ? "mode-button mode-button-active"
                        : "mode-button"
                    }
                    type="button"
                    onClick={() => {
                      setProviderChoice("codex-host");
                    }}
                  >
                    Codex
                  </button>
                  <button
                    className={
                      providerChoice === "cursor-host"
                        ? "mode-button mode-button-active"
                        : "mode-button"
                    }
                    type="button"
                    onClick={() => {
                      setProviderChoice("cursor-host");
                    }}
                  >
                    Cursor
                  </button>
                  <button
                    className={
                      providerChoice === "ollama" ? "mode-button mode-button-active" : "mode-button"
                    }
                    type="button"
                    onClick={() => {
                      setProviderChoice("ollama");
                    }}
                  >
                    Ollama
                  </button>
                  <button
                    className={
                      providerChoice === "compatible"
                        ? "mode-button mode-button-active"
                        : "mode-button"
                    }
                    type="button"
                    onClick={() => {
                      setProviderChoice("compatible");
                    }}
                  >
                    {english ? "Other compatible services" : "其他兼容服务"}
                  </button>
                </div>
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
                  {english
                    ? "Compatible services include OpenAI and other providers offering the OpenAI API format. Set the service URL and model. Secrets stay in the process environment."
                    : "可接入 OpenAI 及其他提供 OpenAI 兼容接口的服务；填写服务地址和模型名后重启。密钥只从进程环境读取。"}
                </p>
              </>
            ) : null}
            <div className="provider-monitor" role="status" aria-live="polite">
              <div className="provider-monitor-heading">
                <strong>{providerLabel}</strong>
                <button
                  type="button"
                  onClick={() => setProviderCheckRevision((revision) => revision + 1)}
                  disabled={providerCheck.status === "checking"}
                >
                  {providerCheck.status === "checking"
                    ? english
                      ? "Reading configuration…"
                      : "正在读取配置…"
                    : english
                      ? "Check again"
                      : "重新检测"}
                </button>
              </div>
              <p>
                {providerCheck.status === "checking"
                  ? english
                    ? `Reading ${providerLabel} model configuration…`
                    : `正在读取 ${providerLabel} 的模型配置…`
                  : providerCheck.status === "ready"
                    ? english
                      ? `Detected ${providerCheck.model}; it matches the active runtime configuration.`
                      : `已获取模型配置：${providerCheck.model}，与当前运行配置一致。`
                    : providerCheck.status === "restart-required"
                      ? english
                        ? `Detected ${providerCheck.model}, but this runtime is using another provider. Restart with ${providerLabel} to continue.`
                        : `已获取模型配置：${providerCheck.model}，但当前运行使用其他服务；切换并重启后才能继续。`
                      : providerCheck.status === "unavailable"
                        ? english
                          ? `${providerLabel} model configuration was not found: ${providerReasonLabel(providerCheck.reason, locale)}.`
                          : `${providerLabel} 未获取到模型配置：${providerReasonLabel(providerCheck.reason, locale)}。`
                        : english
                          ? "Select a provider to read its current model configuration."
                          : "选择服务后读取该服务当前模型配置。"}
              </p>
              <p className="provider-monitor-note">
                {english
                  ? "Configuration lookup only. It does not send a model request."
                  : "仅读取配置，不会发送模型请求。"}
              </p>
              {providerChoice === "cursor-host" &&
              providerCheck.reason === "cursor-not-authenticated" ? (
                <button
                  type="button"
                  onClick={() =>
                    void onConnectCursor().then(() =>
                      setProviderCheckRevision((revision) => revision + 1),
                    )
                  }
                >
                  {english ? "Connect Cursor account" : "连接 Cursor 账号"}
                </button>
              ) : null}
              {providerCheck.account ? (
                <div className="provider-account">
                  <p>
                    {english ? "Account status" : "账号状态"}：
                    {providerCheck.account.status === "authenticated"
                      ? english
                        ? "Signed in"
                        : "已登录"
                      : english
                        ? "Not signed in"
                        : "未登录"}
                  </p>
                  {providerCheck.account.type ? (
                    <p>
                      {english ? "Account type" : "账号类型"}：{providerCheck.account.type}
                    </p>
                  ) : null}
                  {providerCheck.account.email ? (
                    <p>
                      {english ? "Account" : "当前账号"}：{providerCheck.account.email}
                    </p>
                  ) : null}
                  {providerCheck.account.plan ? (
                    <p>
                      {english ? "Plan" : "账号套餐"}：{providerCheck.account.plan}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
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

const App = () => {
  const [loadingState, setLoadingState] = useState<LoadingState>({
    status: "loading",
  });
  const [activeSection, setActiveSection] = useState<
    "clients" | "configuration" | "enterprise" | "guide" | "personal" | "tasks" | "usage"
  >("configuration");
  const [locale, setLocale] = useState<"en-US" | "zh-CN">("zh-CN");
  const [selectedMode, setSelectedMode] = useState<ConfigurationMode>("managed");
  const [configurationView, setConfigurationView] = useState<"active" | "edit">("active");
  const selectedModeRef = useRef<ConfigurationMode>("managed");
  const hasLoadedWorkspace = useRef(false);
  const [configurationForm, setConfigurationForm] = useState<ConfigurationForm>({
    activeProfileId: "managed-default",
    virtualModelName: "九门赛博提督",
    expertServices: DEFAULT_EXPERT_SERVICES,
  });
  const [operation, setOperation] = useState<OperationState>({
    status: "idle",
  });
  const [impactPreview, setImpactPreview] = useState<ConfigurationImpactPreview | undefined>();
  const [hostUsage, setHostUsage] = useState<HostUsageSnapshot | null>(null);
  const [connectingCursor, setConnectingCursor] = useState(false);
  const [cursorConnectionError, setCursorConnectionError] = useState<string | null>(null);
  const [codexConnection, setCodexConnection] = useState<ClientConnectionState>({
    status: "idle",
  });
  const refreshHostUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/host-usage", { cache: "no-store" });
      if (!response.ok) throw new Error("Host usage unavailable");
      setHostUsage((await response.json()) as HostUsageSnapshot);
    } catch {
      setHostUsage(null);
    }
  }, []);
  const connectCursor = useCallback(async () => {
    setConnectingCursor(true);
    setCursorConnectionError(null);
    try {
      const response = await fetch("/api/cursor/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok)
        throw new Error(
          locale === "zh-CN"
            ? "Cursor 授权未完成，请重试。"
            : "Cursor sign-in did not complete. Please retry.",
        );
      await refreshHostUsage();
    } catch (error) {
      setCursorConnectionError(error instanceof Error ? error.message : "Cursor connection failed");
    } finally {
      setConnectingCursor(false);
    }
  }, [locale, refreshHostUsage]);
  const connectCodex = useCallback(async () => {
    setCodexConnection({ status: "pending" });
    try {
      const response = await fetch("/api/clients/codex/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as { message?: string };
      if (!response.ok) {
        throw new Error(
          result.message ??
            (locale === "zh-CN" ? "Codex 客户端配置失败。" : "Codex client configuration failed."),
        );
      }
      setCodexConnection({
        status: "success",
        message:
          locale === "zh-CN"
            ? "九门连接器已注册。官方模型列表保持不变，重启 Codex 后可通过 MCP 使用九门能力。"
            : "AI-Tidu9 connector registered. Official models stay unchanged; restart Codex to use AI-Tidu9 through MCP.",
      });
    } catch (error) {
      setCodexConnection({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : locale === "zh-CN"
              ? "Codex 客户端配置失败。"
              : "Codex client configuration failed.",
      });
    }
  }, [locale]);

  const acceptBootstrap = useCallback(
    (bootstrap: ConfigCenterBootstrap, mode?: ConfigurationMode) => {
      const workspace = bootstrap.configuration.workspace;
      const nextMode =
        mode ??
        (hasLoadedWorkspace.current
          ? selectedModeRef.current
          : workspace.active.configuration.activeMode);

      if (!hasLoadedWorkspace.current) {
        hasLoadedWorkspace.current = true;
        setActiveSection(bootstrap.deployment === "enterprise" ? "enterprise" : "personal");
        selectedModeRef.current = nextMode;
        setSelectedMode(nextMode);
        setConfigurationForm(toForm(workspace.drafts.expert.configuration));
      } else {
        setConfigurationForm(toForm(workspace.drafts.expert.configuration));
      }

      setLoadingState({ status: "ready", bootstrap });
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoadingState({ status: "loading" });
    setOperation({ status: "idle" });
    try {
      acceptBootstrap(await requestBootstrap());
    } catch (error) {
      setLoadingState({
        status: "error",
        message: error instanceof Error ? error.message : "无法读取运行状态",
      });
    }
  }, [acceptBootstrap]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      activeSection === "usage" ||
      (activeSection === "configuration" && configurationView === "active")
    ) {
      void refreshHostUsage();
    }
  }, [activeSection, configurationView, refreshHostUsage]);

  if (loadingState.status !== "ready") {
    return (
      <main className="shell">
        <header className="hero">
          <p className="eyebrow">AI-Tidu9 · CONFIGURATION CENTER</p>
          <h1>九门赛博提督</h1>
          <p className="explanation">智能协作中枢 · 配置中心</p>
        </header>
        {loadingState.status === "loading" ? (
          <section className="state-panel" aria-live="polite">
            正在连接运行时…
          </section>
        ) : (
          <section className="state-panel state-panel-error" aria-live="assertive">
            <h2>连接失败</h2>
            <p>{loadingState.message}</p>
            <button type="button" onClick={() => void refresh()}>
              重新连接
            </button>
          </section>
        )}
      </main>
    );
  }

  const { bootstrap } = loadingState;
  const workspace = bootstrap.configuration.workspace;
  const form = configurationForm;
  const setForm = (
    nextForm: ConfigurationForm | ((current: ConfigurationForm) => ConfigurationForm),
  ): void => {
    setConfigurationForm(nextForm);
  };
  const selectedDraft = workspace.drafts[selectedMode];
  const persistedForm: ConfigurationForm =
    selectedMode === "expert"
      ? form
      : {
          activeProfileId: form.activeProfileId,
          virtualModelName: form.virtualModelName,
        };
  const validation = validateConfiguration(
    {
      ...selectedDraft.configuration,
      ...persistedForm,
      activeMode: selectedMode,
    },
    selectedMode,
  );
  const entryValidationMessages: EntryValidationMessages = {};
  for (const issue of validation.issues) {
    if (issue.field === "activeProfileId") {
      entryValidationMessages.activeProfileId =
        locale === "zh-CN"
          ? "必填；仅支持小写字母、数字和连字符，最多 64 位。"
          : "Required; use up to 64 lowercase letters, numbers, or hyphens.";
    } else if (issue.field === "virtualModelName") {
      entryValidationMessages.virtualModelName =
        locale === "zh-CN"
          ? "必填；去除首尾空格后需为 1–64 个字符。"
          : "Required; enter 1–64 characters after trimming spaces.";
    } else if (issue.code === "INVALID_EXPERT_HOST") {
      entryValidationMessages.expertHost =
        locale === "zh-CN"
          ? "请输入有效的主机名或 IPv4 地址。"
          : "Enter a valid hostname or IPv4 address.";
    } else if (issue.code === "INVALID_EXPERT_PORT") {
      entryValidationMessages.expertPort =
        locale === "zh-CN" ? "端口必须是 1–65535 的整数。" : "Enter an integer from 1 to 65535.";
    }
  }
  const savedForm = toForm(selectedDraft.configuration);
  const savedPersistedForm: ConfigurationForm =
    selectedMode === "expert"
      ? savedForm
      : {
          activeProfileId: savedForm.activeProfileId,
          virtualModelName: savedForm.virtualModelName,
        };
  const isDirty = JSON.stringify(persistedForm) !== JSON.stringify(savedPersistedForm);
  const isPending = operation.status === "pending";
  const isSelectedDraftActive =
    workspace.active.configuration.activeMode === selectedMode &&
    workspace.active.configuration.activeProfileId === form.activeProfileId &&
    workspace.active.configuration.virtualModelName === form.virtualModelName &&
    (selectedMode === "managed" ||
      JSON.stringify(workspace.active.configuration.expertServices) ===
        JSON.stringify(form.expertServices));
  const selectMode = (mode: ConfigurationMode): void => {
    selectedModeRef.current = mode;
    setSelectedMode(mode);
    setOperation({ status: "idle" });
    setImpactPreview(undefined);
  };

  const saveDraft = async (): Promise<boolean> => {
    setOperation({ status: "pending", action: "save" });
    try {
      const nextBootstrap = await requestBootstrap(`/api/configuration/drafts/${selectedMode}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: selectedDraft.revision,
          configuration: {
            schemaVersion: selectedDraft.configuration.schemaVersion,
            activeMode: selectedMode,
            ...persistedForm,
          },
        }),
      });
      acceptBootstrap(nextBootstrap, selectedMode);
      setImpactPreview(undefined);
      setOperation({
        status: "success",
        message: `${modeLabel(selectedMode)}草稿已保存，尚未启用。`,
      });
      return true;
    } catch (error) {
      setOperation({
        status: "error",
        message: error instanceof Error ? error.message : "保存失败",
      });
      return false;
    }
  };

  const simulateDraft = async (): Promise<void> => {
    setOperation({ status: "pending", action: "simulate" });
    try {
      const response = await fetch(`/api/configuration/drafts/${selectedMode}/simulate`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          configuration: {
            schemaVersion: selectedDraft.configuration.schemaVersion,
            activeMode: selectedMode,
            ...persistedForm,
          },
        }),
      });
      const preview = (await response.json()) as ConfigurationImpactPreview & { message?: string };
      if (!response.ok) {
        throw new Error(preview.message ?? `Simulation returned ${response.status}`);
      }
      setImpactPreview(preview);
      setOperation({
        status: "success",
        message:
          locale === "zh-CN"
            ? `模拟通过：${preview.changes.length} 项变化，${preview.risk === "low" ? "低" : "中"}风险。`
            : `Simulation passed: ${preview.changes.length} changes, ${preview.risk} risk.`,
      });
    } catch (error) {
      setImpactPreview(undefined);
      setOperation({
        status: "error",
        message: error instanceof Error ? error.message : "Simulation failed",
      });
    }
  };

  const rollbackConfiguration = async (): Promise<void> => {
    setOperation({ status: "pending", action: "rollback" });
    try {
      const nextBootstrap = await requestBootstrap("/api/configuration/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      acceptBootstrap(nextBootstrap, selectedMode);
      setImpactPreview(undefined);
      setOperation({
        status: "success",
        message:
          locale === "zh-CN"
            ? "已恢复上一健康配置。"
            : "Previous known-good configuration restored.",
      });
    } catch (error) {
      setOperation({
        status: "error",
        message: error instanceof Error ? error.message : "Rollback failed",
      });
    }
  };

  const activateDraft = async (): Promise<void> => {
    setOperation({ status: "pending", action: "activate" });
    try {
      const nextBootstrap = await requestBootstrap(
        `/api/configuration/drafts/${selectedMode}/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedDraftRevision: selectedDraft.revision,
          }),
        },
      );
      acceptBootstrap(nextBootstrap, selectedMode);
      setOperation({
        status: "success",
        message: `${modeLabel(selectedMode)}已明确启用。`,
      });
    } catch (error) {
      setOperation({
        status: "error",
        message: error instanceof Error ? error.message : "启用失败",
      });
    }
  };

  return (
    <main className="shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">AI-Tidu9 · CONFIGURATION CENTER</p>
          <h1>九门赛博提督</h1>
          <p className="explanation">
            {locale === "zh-CN"
              ? "智能协作中枢 · 配置中心"
              : "Intelligent Collaboration Hub · Configuration Center"}
          </p>
        </div>
        <div className="hero-global-controls">
          <div className="global-runtime-status">
            <span className="status-dot" aria-hidden="true" />
            <span>{locale === "zh-CN" ? "运行正常" : "Healthy"}</span>
            <button type="button" onClick={() => void refresh()} disabled={isPending}>
              {locale === "zh-CN" ? "刷新" : "Refresh"}
            </button>
          </div>
          <button
            className="locale-button"
            type="button"
            onClick={() => setLocale((current) => (current === "zh-CN" ? "en-US" : "zh-CN"))}
          >
            {locale === "zh-CN" ? "EN" : "中文"}
          </button>
        </div>
      </header>

      <nav
        className="section-navigation"
        aria-label={locale === "zh-CN" ? "配置中心栏目" : "Control center sections"}
      >
        <button
          className={
            activeSection === "tasks" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "tasks" ? "page" : undefined}
          onClick={() => setActiveSection("tasks")}
        >
          {locale === "zh-CN" ? "任务" : "Tasks"}
        </button>
        {bootstrap.deployment === "personal" ? (
          <>
            <button
              className={
                activeSection === "configuration"
                  ? "section-button section-button-active"
                  : "section-button"
              }
              type="button"
              aria-current={activeSection === "configuration" ? "page" : undefined}
              onClick={() => setActiveSection("configuration")}
            >
              {locale === "zh-CN" ? "配置" : "Configuration"}
            </button>
            <button
              className={
                activeSection === "usage"
                  ? "section-button section-button-active"
                  : "section-button"
              }
              type="button"
              aria-current={activeSection === "usage" ? "page" : undefined}
              onClick={() => setActiveSection("usage")}
            >
              {locale === "zh-CN" ? "模型统计" : "Model usage"}
            </button>
          </>
        ) : null}
        <button
          className={
            activeSection === "clients" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "clients" ? "page" : undefined}
          onClick={() => setActiveSection("clients")}
        >
          {locale === "zh-CN" ? "客户端" : "Clients"}
        </button>
        {bootstrap.deployment === "personal" ? (
          <button
            className={
              activeSection === "personal"
                ? "section-button section-button-active"
                : "section-button"
            }
            type="button"
            aria-current={activeSection === "personal" ? "page" : undefined}
            onClick={() => setActiveSection("personal")}
          >
            {locale === "zh-CN" ? "个人" : "Personal"}
          </button>
        ) : null}
        {bootstrap.deployment === "enterprise" ? (
          <button
            className={
              activeSection === "enterprise"
                ? "section-button section-button-active"
                : "section-button"
            }
            type="button"
            aria-current={activeSection === "enterprise" ? "page" : undefined}
            onClick={() => setActiveSection("enterprise")}
          >
            {locale === "zh-CN" ? "企业" : "Enterprise"}
          </button>
        ) : null}
        <button
          className={
            activeSection === "guide" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "guide" ? "page" : undefined}
          onClick={() => setActiveSection("guide")}
        >
          {locale === "zh-CN" ? "使用指南" : "Guide"}
        </button>
      </nav>

      {bootstrap.deployment === "personal" && activeSection === "configuration" ? (
        <>
          <section className="configuration-view-panel">
            <div className="configuration-view-heading">
              <div>
                {configurationView === "edit" ? (
                  <p className="card-label">
                    {locale === "zh-CN" ? "正在编辑" : "EDITING"} ·{" "}
                    {modeLabel(selectedMode, locale)} · {locale === "zh-CN" ? "草稿修订" : "draft"}{" "}
                    {selectedDraft.revision}
                  </p>
                ) : null}
                <h2>
                  {configurationView === "active"
                    ? locale === "zh-CN"
                      ? "当前生效配置"
                      : "Active configuration"
                    : locale === "zh-CN"
                      ? `修改${modeLabel(selectedMode, locale)}配置`
                      : `Edit ${modeLabel(selectedMode, locale)} configuration`}
                </h2>
                <p>
                  {configurationView === "active"
                    ? locale === "zh-CN"
                      ? "这里只显示运行中的配置与环境信息。"
                      : "This view contains only active runtime and environment details."
                    : locale === "zh-CN"
                      ? "这里只编辑未生效草稿；保存、模拟并启用后才会影响运行流程。"
                      : "This view edits an inactive draft. Save, preview, and activate it to change runtime behavior."}
                </p>
              </div>
              <div className="configuration-view-actions">
                {configurationView === "edit" ? (
                  <button
                    className="locale-button"
                    type="button"
                    aria-label={locale === "zh-CN" ? "切换配置模式" : "Switch configuration mode"}
                    onClick={() => selectMode(selectedMode === "managed" ? "expert" : "managed")}
                    disabled={isPending}
                    aria-pressed={selectedMode === "expert"}
                  >
                    {selectedMode === "managed"
                      ? locale === "zh-CN"
                        ? "专家模式"
                        : "Expert"
                      : locale === "zh-CN"
                        ? "普通模式"
                        : "Normal"}
                  </button>
                ) : null}
                <button
                  className="configuration-view-toggle"
                  type="button"
                  onClick={() =>
                    setConfigurationView((view) => (view === "active" ? "edit" : "active"))
                  }
                >
                  {configurationView === "active"
                    ? locale === "zh-CN"
                      ? "修改配置"
                      : "Edit configuration"
                    : locale === "zh-CN"
                      ? "查看当前生效"
                      : "View active configuration"}
                </button>
              </div>
            </div>
          </section>

          <div className="configuration-view-content" hidden={configurationView !== "active"}>
            <section
              className="cards"
              aria-label={locale === "zh-CN" ? "运行环境" : "Runtime environment"}
            >
              <article className="card storage-location-card">
                <p className="card-label">{locale === "zh-CN" ? "数据库" : "DATABASE"}</p>
                <p className="location-value" title={bootstrap.storage.location}>
                  {bootstrap.storage.location}
                </p>
                <p>
                  {bootstrap.storage.provider.toUpperCase()} · Schema{" "}
                  {bootstrap.storage.schemaVersion}
                </p>
                <dl className="configuration-facts">
                  <div>
                    <dt>{locale === "zh-CN" ? "连接方式" : "Connection"}</dt>
                    <dd>{locale === "zh-CN" ? "进程内嵌入式" : "Embedded in process"}</dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "数据库服务" : "Database service"}</dt>
                    <dd>{locale === "zh-CN" ? "无独立服务" : "No separate service"}</dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "主机 / 端口" : "Host / port"}</dt>
                    <dd>{locale === "zh-CN" ? "不适用" : "Not applicable"}</dd>
                  </div>
                </dl>
                <div className="database-tables">
                  {bootstrap.storage.tables.map((table) => (
                    <p key={table.name}>
                      <code>{table.name}</code>
                      <span>
                        {table.rowCount} {locale === "zh-CN" ? "行" : "rows"}
                      </span>
                    </p>
                  ))}
                </div>
              </article>
              <article className="card active-runtime-card">
                <p className="card-label">
                  {locale === "zh-CN" ? "当前生效配置" : "ACTIVE CONFIGURATION"}
                </p>
                <h2>{modeLabel(workspace.active.configuration.activeMode, locale)}</h2>
                <p>
                  {locale === "zh-CN" ? "配置标识" : "Profile ID"}：
                  {workspace.active.configuration.activeProfileId}
                </p>
                <p>
                  {locale === "zh-CN" ? "虚拟模型" : "Virtual model"}：
                  {workspace.active.configuration.virtualModelName}
                </p>
                <p>
                  {locale === "zh-CN" ? "修订" : "Revision"}：{workspace.active.revision} ·{" "}
                  {workspace.active.updatedAt}
                </p>
                <p>
                  {locale === "zh-CN" ? "模型服务" : "Model provider"}：
                  {bootstrap.runtime.provider.configured
                    ? `${bootstrap.runtime.provider.type} · ${bootstrap.runtime.provider.model}`
                    : locale === "zh-CN"
                      ? "尚未配置"
                      : "Not configured"}
                </p>
                <p>
                  {locale === "zh-CN" ? "运行版本" : "Runtime version"}：v
                  {bootstrap.product.version} · {locale === "zh-CN" ? "配置契约" : "Contract"}{" "}
                  {workspace.active.configuration.schemaVersion}
                </p>
                <p className="location-value" title={bootstrap.runtime.installationLocation}>
                  {locale === "zh-CN" ? "安装入口" : "Entry"}：
                  {bootstrap.runtime.installationLocation}
                </p>
                <p>
                  {locale === "zh-CN" ? "监听地址" : "Listen address"}：
                  <code>{bootstrap.runtime.origin}</code>
                </p>
                <div className="runtime-services">
                  {bootstrap.runtime.services.map((service) => (
                    <p key={service.id}>
                      <span>
                        <strong>{service.name}</strong>
                        <code>{service.path}</code>
                      </span>
                      <em className={service.enabled ? "service-enabled" : "service-disabled"}>
                        {service.enabled
                          ? locale === "zh-CN"
                            ? "已启用"
                            : "Enabled"
                          : locale === "zh-CN"
                            ? "已关闭"
                            : "Disabled"}
                      </em>
                    </p>
                  ))}
                </div>
                <p>
                  {locale === "zh-CN" ? "草稿修订" : "Draft revisions"}：
                  {locale === "zh-CN" ? "共享配置" : "Shared"} {workspace.drafts.managed.revision} ·{" "}
                  {locale === "zh-CN" ? "专家扩展" : "Expert extension"}{" "}
                  {workspace.drafts.expert.revision}
                </p>
              </article>
            </section>
          </div>
          <div className="configuration-view-content" hidden={configurationView !== "edit"}>
            <QuickStartWizard
              locale={locale}
              enterpriseEnabled={bootstrap.enterprise.enabled}
              providerConfigured={bootstrap.runtime.provider.configured}
              providerType={bootstrap.runtime.provider.type}
              providerModel={bootstrap.runtime.provider.model}
              selectedMode={selectedMode}
              form={form}
              isDirty={isDirty}
              isPending={isPending}
              impactPreview={impactPreview}
              isActive={isSelectedDraftActive}
              entryValidationMessages={entryValidationMessages}
              readOnly={!bootstrap.configuration.editable}
              onFormChange={setForm}
              onSave={saveDraft}
              onSimulate={simulateDraft}
              onActivate={activateDraft}
              onRollback={rollbackConfiguration}
              onOpenClients={() => setActiveSection("clients")}
              onConnectCursor={connectCursor}
            />
            {!bootstrap.configuration.editable ? (
              <p className="read-only-notice">
                {locale === "zh-CN"
                  ? "当前配置为只读。"
                  : "Configuration is read-only in this edition."}
              </p>
            ) : null}
          </div>
        </>
      ) : bootstrap.deployment === "personal" && activeSection === "usage" ? (
        <HostUsagePanel
          snapshot={hostUsage}
          locale={locale}
          onRefresh={() => void refreshHostUsage()}
          onConnectCursor={() => void connectCursor()}
          connectingCursor={connectingCursor}
          cursorConnectionError={cursorConnectionError}
        />
      ) : bootstrap.deployment === "personal" && activeSection === "personal" ? (
        <PersonalExperiencePanel
          locale={locale}
          providerConfigured={bootstrap.runtime.provider.configured}
          providerType={bootstrap.runtime.provider.type}
          enterprise={bootstrap.enterprise}
          onBootstrap={acceptBootstrap}
        />
      ) : bootstrap.deployment === "enterprise" && activeSection === "enterprise" ? (
        <EnterpriseEditionPanel enterprise={bootstrap.enterprise} locale={locale} />
      ) : activeSection === "clients" ? (
        <section className="client-panel">
          <div className="configuration-heading">
            <div>
              <p className="card-label">LOCAL CLIENT DISCOVERY</p>
              <h2>{locale === "zh-CN" ? "本机客户端" : "Local clients"}</h2>
              <p>
                {locale === "zh-CN"
                  ? "按产品主体展示可接入入口和实际接入方式。"
                  : "Available entry points and integration methods are grouped by provider."}
              </p>
            </div>
          </div>
          <div className="client-grid">
            {[
              {
                id: "openai",
                name: "OpenAI / Codex",
                clients: bootstrap.clients.clients.filter(
                  (client) => client.id === "codex" || client.id === "openai-cli",
                ),
              },
              {
                id: "cursor",
                name: "Cursor",
                clients: bootstrap.clients.clients.filter((client) => client.id === "cursor"),
              },
            ].map((group) => (
              <article className="client-card" key={group.id}>
                <div className="client-card-heading">
                  <div>
                    <p className="client-protocol">{group.id === "openai" ? "OPENAI" : "CURSOR"}</p>
                    <h3>{group.name}</h3>
                  </div>
                  <span
                    className={`client-state client-state-${group.clients.some((client) => client.detected) ? "configurable" : "not-detected"}`}
                  >
                    {group.clients.some((client) => client.detected)
                      ? locale === "zh-CN"
                        ? "已接入"
                        : "Available"
                      : locale === "zh-CN"
                        ? "未发现"
                        : "Not detected"}
                  </span>
                </div>
                <div className="client-products">
                  {group.clients.map((client) => (
                    <div className="client-product" key={client.id}>
                      <div>
                        <strong>{client.name}</strong>
                        <span>
                          {clientIntegrationLabel(client.integrationMode, locale)} ·{" "}
                          {client.protocol}
                        </span>
                      </div>
                      <span className={`client-state client-state-${client.readiness}`}>
                        {clientReadinessLabel(client.readiness, locale)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="client-limitation">
                  {group.id === "openai"
                    ? locale === "zh-CN"
                      ? "Codex 当前不能把第三方供应商增量加入官方模型列表；九门通过 MCP 连接器接入，官方模型仍全部保留。"
                      : "Codex cannot currently add a third-party provider to its official model list; AI-Tidu9 uses MCP so every official model remains available."
                    : locale === "zh-CN"
                      ? "九门作为 MCP 连接器接入 Cursor；Cursor 官方模型列表不会新增九门模型项。"
                      : "AI-Tidu9 connects to Cursor as an MCP connector; Cursor's official model list does not gain an AI-Tidu9 model entry."}
                </p>
                {group.id === "openai" ? (
                  <div className="client-connect-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={codexConnection.status === "pending"}
                      onClick={() => void connectCodex()}
                    >
                      {codexConnection.status === "pending"
                        ? locale === "zh-CN"
                          ? "正在安装…"
                          : "Installing…"
                        : locale === "zh-CN"
                          ? "安装或更新九门连接器"
                          : "Install or update AI-Tidu9 connector"}
                    </button>
                    {codexConnection.status === "success" || codexConnection.status === "error" ? (
                      <p
                        className={`client-connect-message client-connect-message-${codexConnection.status}`}
                      >
                        {codexConnection.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : activeSection === "tasks" ? (
        <TaskControlPanel locale={locale} />
      ) : (
        <GuideCenter locale={locale} />
      )}
    </main>
  );
};

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Configuration center root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

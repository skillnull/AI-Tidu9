import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskControlView } from "../../src/agent/index.js";
import type { ConfigurationMode, TiduConfiguration } from "../../src/config/index.js";
import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";
import "./styles.css";

type LoadingState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: ConfigCenterBootstrap }
  | { status: "error"; message: string };

type OperationState =
  | { status: "idle" }
  | { status: "pending"; action: "activate" | "rollback" | "save" | "simulate" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

interface ConfigurationForm {
  /** Stable lowercase identifier used to select this profile. */
  activeProfileId: string;
  /** User-facing virtual-model name exposed by compatible clients. */
  virtualModelName: string;
}

interface TaskListResponse {
  /** Whether the running service has an Agent kernel attached. */
  available: boolean;
  /** Bounded task summaries ordered by latest update. */
  tasks: readonly TaskControlView[];
}

interface ConfigurationImpactPreview {
  /** Whether the configuration passed validation. */
  valid: boolean;
  /** Configuration fields changed by activation. */
  changes: readonly string[];
  /** Activation risk classification. */
  risk: "low" | "medium";
}

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

const toForm = (configuration: TiduConfiguration): ConfigurationForm => ({
  activeProfileId: configuration.activeProfileId,
  virtualModelName: configuration.virtualModelName,
});

const modeLabel = (mode: ConfigurationMode, locale: "en-US" | "zh-CN" = "zh-CN"): string =>
  locale === "zh-CN"
    ? mode === "managed"
      ? "普通模式"
      : "专家模式"
    : mode === "managed"
      ? "Normal"
      : "Expert";

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

const clientLimitationLabel = (
  limitation: ConfigCenterBootstrap["clients"]["clients"][number]["limitation"],
  locale: "en-US" | "zh-CN",
): string | null => {
  if (limitation === "cursor-standard-chat-only") {
    return locale === "zh-CN"
      ? "仅发现Cursor桌面端时只能使用聊天兼容入口；这不等同于完整Agent能力。"
      : "Cursor Desktop alone exposes only the chat-compatible entry, not the full Agent interface.";
  }
  return null;
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
              <code>npx @skillnull/tidu start</code>
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
              <code>npx @skillnull/tidu start</code>
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
              <code>npx @skillnull/tidu doctor</code>
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
              <h3>生成员工接入手册</h3>
              <ol>
                <li>管理员发布模型、额度、门禁和可用客户端。</li>
                <li>系统生成公司专属员工接入页，不展示供应商密钥。</li>
                <li>接入页包含公司地址、登录方式、模型名称和验证步骤。</li>
                <li>配置变更后文档自动更新并保留版本。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">04 · 员工</p>
              <h3>按场景完成接入</h3>
              <ol>
                <li>打开公司提供的员工接入页并完成身份认证。</li>
                <li>选择Codex、Cursor、CLI、浏览器或其他客户端。</li>
                <li>集中版直接配置虚拟模型；混合版再安装轻量连接器。</li>
                <li>运行连通性验证，确认额度、策略和可用能力。</li>
              </ol>
            </article>
            <article className="guide-card">
              <p className="guide-index">05 · 运维</p>
              <h3>页面故障与离线操作</h3>
              <ol>
                <li>页面故障不停止模型网关和已启用配置。</li>
                <li>管理员可通过等价CLI、配置文件和管理API操作。</li>
                <li>员工接入页提供诊断、升级、回滚和支持入口。</li>
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
}: {
  locale: "en-US" | "zh-CN";
  providerConfigured: boolean;
  providerType: string | null;
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
          <p className="card-label">BUDGET & ACCOUNTS</p>
          <h3>{english ? "Snapshot attribution" : "账号快照记账"}</h3>
          <p>
            {english
              ? "Running tasks keep their account snapshot after a switch."
              : "账号切换后，运行中任务仍按原账号快照记账。"}
          </p>
          <code>{english ? "Provider truth first" : "供应商官方用量优先"}</code>
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
    </section>
  );
};

const EnterprisePilotPanel = ({
  enterprise,
  locale,
}: {
  enterprise: ConfigCenterBootstrap["enterprise"];
  locale: "en-US" | "zh-CN";
}) => {
  const english = locale === "en-US";
  return (
    <section className="configuration-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">ENTERPRISE PILOT</p>
          <h2>{english ? "Enterprise control plane" : "企业控制平面"}</h2>
          <p>
            {enterprise.enabled
              ? english
                ? `Published revision ${enterprise.revision}. Mandatory policy and quota controls are active.`
                : `已发布修订 ${enterprise.revision}，强制策略与额度控制已经接入。`
              : english
                ? "This runtime is personal-only. Attach an enterprise control plane to enable centralized policy and quota."
                : "当前为纯个人运行时。挂载企业控制平面后启用集中策略与额度。"}
          </p>
        </div>
        <span
          className={`availability ${enterprise.enabled ? "availability-ready" : "availability-planned"}`}
        >
          {enterprise.enabled ? (english ? "ACTIVE" : "已启用") : english ? "PERSONAL" : "个人版"}
        </span>
      </div>
      <div className="personal-grid">
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
        <article className="personal-card">
          <p className="card-label">ADMIN ACCESS</p>
          <h3>
            {enterprise.administratorInitialized
              ? english
                ? "Initialized"
                : "已初始化"
              : english
                ? "Not initialized"
                : "未初始化"}
          </h3>
          <p>{english ? "One-time key with irreversible verifier" : "一次性密钥与不可逆校验值"}</p>
        </article>
      </div>
      {enterprise.guidance ? (
        <div className="guide-grid">
          <article className="guide-card">
            <p className="guide-index">ADMIN · v{enterprise.guidance.version}</p>
            <h3>{english ? "Deployment guidance" : "管理员部署指南"}</h3>
            <ol>
              {enterprise.guidance.administrator.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </article>
          <article className="guide-card">
            <p className="guide-index">EMPLOYEE · v{enterprise.guidance.version}</p>
            <h3>{english ? "Employee onboarding" : "员工接入指南"}</h3>
            <ol>
              {enterprise.guidance.employee.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </article>
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
  /** Currently selected isolated draft. */
  selectedMode: ConfigurationMode;
  /** Editable entry identity. */
  form: ConfigurationForm;
  /** Whether the form differs from the saved draft. */
  isDirty: boolean;
  /** Whether an operation is running. */
  isPending: boolean;
  /** Whether the impact preview passed. */
  impactValid: boolean;
  /** Whether this form is the active runtime configuration. */
  isActive: boolean;
  /** Select an isolated draft. */
  onSelectMode: (mode: ConfigurationMode) => void;
  /** Update the entry identity form. */
  onFormChange: (form: ConfigurationForm) => void;
  /** Save the current draft. */
  onSave: () => Promise<void>;
  /** Simulate activation impact. */
  onSimulate: () => Promise<void>;
  /** Activate the verified draft. */
  onActivate: () => Promise<void>;
  /** Open client connection guidance. */
  onOpenClients: () => void;
}

const QuickStartWizard = ({
  locale,
  enterpriseEnabled,
  providerConfigured,
  providerType,
  selectedMode,
  form,
  isDirty,
  isPending,
  impactValid,
  isActive,
  onSelectMode,
  onFormChange,
  onSave,
  onSimulate,
  onActivate,
  onOpenClients,
}: QuickStartWizardProps) => {
  const english = locale === "en-US";
  const [step, setStep] = useState(0);
  const [providerChoice, setProviderChoice] = useState<"compatible" | "ollama">("ollama");
  const stepLabels = english
    ? ["Deployment", "Entry", "Model", "Activate", "Clients"]
    : ["部署", "入口", "模型", "启用", "客户端"];

  return (
    <section className="onboarding-panel">
      <div className="configuration-heading">
        <div>
          <p className="card-label">GUIDED SETUP</p>
          <h2>{english ? "Finish setup step by step" : "按步骤完成首次配置"}</h2>
          <p>
            {english
              ? "Each step reuses the same drafts, safety preview, and activation flow as Expert mode."
              : "向导复用正式草稿、影响模拟和启用流程，不创建第二套配置。"}
          </p>
        </div>
        <span className="onboarding-counter">
          {step + 1} / {stepLabels.length}
        </span>
      </div>

      <nav className="onboarding-steps" aria-label={english ? "Setup progress" : "配置进度"}>
        {stepLabels.map((label, stepIndex) => (
          <button
            className={
              stepIndex === step ? "onboarding-step onboarding-step-active" : "onboarding-step"
            }
            type="button"
            onClick={() => setStep(stepIndex)}
            key={label}
          >
            <span>{String(stepIndex + 1).padStart(2, "0")}</span>
            {label}
          </button>
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
                  ? "Personal local"
                  : "个人本地版"}
            </h3>
            <p>
              {enterpriseEnabled
                ? english
                  ? "Organization policy and quota are active. This wizard edits your permitted entry profile."
                  : "组织策略与额度已经生效；向导只编辑你被允许配置的入口。"
                : english
                  ? "SQLite and the local control center are ready. No external database is required."
                  : "SQLite与本地配置中心已就绪，不需要外部数据库。"}
            </p>
          </>
        ) : step === 1 ? (
          <>
            <div className="onboarding-choice-row">
              {(["managed", "expert"] as const).map((mode) => (
                <button
                  className={
                    selectedMode === mode ? "mode-button mode-button-active" : "mode-button"
                  }
                  type="button"
                  onClick={() => onSelectMode(mode)}
                  disabled={isPending}
                  key={mode}
                >
                  {modeLabel(mode, locale)}
                </button>
              ))}
            </div>
            <div className="configuration-form onboarding-form">
              <label>
                {english ? "Profile ID" : "配置标识"}
                <input
                  value={form.activeProfileId}
                  onChange={(event) =>
                    onFormChange({ ...form, activeProfileId: event.target.value })
                  }
                  maxLength={64}
                  disabled={isPending}
                />
              </label>
              <label>
                {english ? "Virtual model name" : "虚拟模型名称"}
                <input
                  value={form.virtualModelName}
                  onChange={(event) =>
                    onFormChange({ ...form, virtualModelName: event.target.value })
                  }
                  maxLength={64}
                  disabled={isPending}
                />
              </label>
            </div>
          </>
        ) : step === 2 ? (
          <>
            <p className="onboarding-kicker">
              {providerConfigured
                ? english
                  ? "Provider ready"
                  : "模型供应商已就绪"
                : english
                  ? "Choose a provider path"
                  : "选择模型接入方式"}
            </p>
            {providerConfigured ? (
              <h3>{providerType}</h3>
            ) : (
              <>
                <div className="onboarding-choice-row">
                  <button
                    className={
                      providerChoice === "ollama" ? "mode-button mode-button-active" : "mode-button"
                    }
                    type="button"
                    onClick={() => setProviderChoice("ollama")}
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
                    onClick={() => setProviderChoice("compatible")}
                  >
                    OpenAI compatible
                  </button>
                </div>
                <code className="onboarding-command">
                  {providerChoice === "ollama"
                    ? "TIDU_PROVIDER=ollama TIDU_PROVIDER_MODEL=<model> tidu start"
                    : "TIDU_PROVIDER=openai-compatible TIDU_PROVIDER_MODEL=<model> TIDU_PROVIDER_API_KEY=<runtime-key> tidu start"}
                </code>
                <p>
                  {english
                    ? "Restart with these process variables. Secrets are never saved by this page."
                    : "使用上述进程变量重启；本页面不会保存密钥。"}
                </p>
              </>
            )}
          </>
        ) : step === 3 ? (
          <>
            <p className="onboarding-kicker">{english ? "Safe activation" : "安全启用"}</p>
            <h3>{english ? "Save → preview → activate" : "保存 → 模拟 → 启用"}</h3>
            <div className="onboarding-choice-row">
              <button type="button" onClick={() => void onSave()} disabled={!isDirty || isPending}>
                {english ? "1. Save" : "1. 保存草稿"}
              </button>
              <button
                type="button"
                onClick={() => void onSimulate()}
                disabled={isDirty || isPending}
              >
                {english ? "2. Preview" : "2. 模拟影响"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void onActivate()}
                disabled={isDirty || isPending || !impactValid}
              >
                {english ? "3. Activate" : "3. 启用配置"}
              </button>
            </div>
            <p>
              {isActive
                ? english
                  ? "This entry is active."
                  : "当前入口已经生效。"
                : english
                  ? "Activation remains blocked until the preview passes."
                  : "影响模拟通过前不会允许启用。"}
            </p>
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
          onClick={() => setStep((current) => Math.min(stepLabels.length - 1, current + 1))}
          disabled={step === stepLabels.length - 1}
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
    "clients" | "configuration" | "enterprise" | "guide" | "personal" | "tasks"
  >("configuration");
  const [locale, setLocale] = useState<"en-US" | "zh-CN">("zh-CN");
  const [selectedMode, setSelectedMode] = useState<ConfigurationMode>("managed");
  const [form, setForm] = useState<ConfigurationForm>({
    activeProfileId: "managed-default",
    virtualModelName: "九门赛博提督",
  });
  const [operation, setOperation] = useState<OperationState>({
    status: "idle",
  });
  const [impactPreview, setImpactPreview] = useState<ConfigurationImpactPreview | undefined>();

  const acceptBootstrap = useCallback(
    (bootstrap: ConfigCenterBootstrap, mode: ConfigurationMode = selectedMode) => {
      setLoadingState({ status: "ready", bootstrap });
      setForm(toForm(bootstrap.configuration.workspace.drafts[mode].configuration));
    },
    [selectedMode],
  );

  const refresh = useCallback(async () => {
    setLoadingState({ status: "loading" });
    setOperation({ status: "idle" });
    try {
      acceptBootstrap(await requestBootstrap());
    } catch (error) {
      setLoadingState({
        status: "error",
        message: error instanceof Error ? error.message : "无法读取本地运行状态",
      });
    }
  }, [acceptBootstrap]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadingState.status !== "ready") {
    return (
      <main className="shell">
        <header className="hero">
          <p className="eyebrow">AI-Tidu9 · LOCAL CONTROL</p>
          <h1>九门赛博提督</h1>
          <p className="explanation">智能协作中枢 · 本地配置中心</p>
        </header>
        {loadingState.status === "loading" ? (
          <section className="state-panel" aria-live="polite">
            正在连接本地运行时…
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
  const selectedDraft = workspace.drafts[selectedMode];
  const savedForm = toForm(selectedDraft.configuration);
  const isDirty =
    form.activeProfileId !== savedForm.activeProfileId ||
    form.virtualModelName !== savedForm.virtualModelName;
  const isPending = operation.status === "pending";
  const isSelectedDraftActive =
    workspace.active.configuration.activeMode === selectedMode &&
    workspace.active.configuration.activeProfileId === form.activeProfileId &&
    workspace.active.configuration.virtualModelName === form.virtualModelName;

  const selectMode = (mode: ConfigurationMode): void => {
    setSelectedMode(mode);
    setForm(toForm(workspace.drafts[mode].configuration));
    setOperation({ status: "idle" });
    setImpactPreview(undefined);
  };

  const saveDraft = async (): Promise<void> => {
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
            ...form,
          },
        }),
      });
      acceptBootstrap(nextBootstrap, selectedMode);
      setImpactPreview(undefined);
      setOperation({
        status: "success",
        message: `${modeLabel(selectedMode)}草稿已保存，尚未启用。`,
      });
    } catch (error) {
      setOperation({
        status: "error",
        message: error instanceof Error ? error.message : "保存失败",
      });
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
            ...form,
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
        <p className="eyebrow">AI-Tidu9 · LOCAL CONTROL</p>
        <h1>九门赛博提督</h1>
        <p className="explanation">
          {locale === "zh-CN"
            ? "智能协作中枢 · 本地配置中心"
            : "Intelligent Collaboration Hub · Local Control Center"}
        </p>
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
        <button
          className="locale-button"
          type="button"
          onClick={() => setLocale((current) => (current === "zh-CN" ? "en-US" : "zh-CN"))}
        >
          {locale === "zh-CN" ? "EN" : "中文"}
        </button>
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
            activeSection === "clients" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "clients" ? "page" : undefined}
          onClick={() => setActiveSection("clients")}
        >
          {locale === "zh-CN" ? "客户端" : "Clients"}
        </button>
        <button
          className={
            activeSection === "personal" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "personal" ? "page" : undefined}
          onClick={() => setActiveSection("personal")}
        >
          {locale === "zh-CN" ? "个人中心" : "Personal"}
        </button>
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

      <section className="overview">
        <div>
          <span className="status-dot" aria-hidden="true" />
          <span>{locale === "zh-CN" ? "本地运行时正常" : "Local runtime healthy"}</span>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={isPending}>
          {locale === "zh-CN" ? "刷新状态" : "Refresh"}
        </button>
      </section>

      {activeSection === "configuration" ? (
        <>
          <QuickStartWizard
            locale={locale}
            enterpriseEnabled={bootstrap.enterprise.enabled}
            providerConfigured={bootstrap.runtime.provider.configured}
            providerType={bootstrap.runtime.provider.type}
            selectedMode={selectedMode}
            form={form}
            isDirty={isDirty}
            isPending={isPending}
            impactValid={impactPreview?.valid === true}
            isActive={isSelectedDraftActive}
            onSelectMode={selectMode}
            onFormChange={setForm}
            onSave={saveDraft}
            onSimulate={simulateDraft}
            onActivate={activateDraft}
            onOpenClients={() => setActiveSection("clients")}
          />
          <section
            className="cards"
            aria-label={locale === "zh-CN" ? "运行状态" : "Runtime status"}
          >
            <article className="card">
              <p className="card-label">
                {locale === "zh-CN" ? "当前生效配置" : "ACTIVE CONFIGURATION"}
              </p>
              <h2>{workspace.active.configuration.virtualModelName}</h2>
              <p>
                {modeLabel(workspace.active.configuration.activeMode, locale)} ·{" "}
                {workspace.active.configuration.activeProfileId}
              </p>
            </article>
            <article className="card">
              <p className="card-label">{locale === "zh-CN" ? "本地存储" : "LOCAL STORAGE"}</p>
              <h2>{bootstrap.storage.provider.toUpperCase()}</h2>
              <p>
                Schema {bootstrap.storage.schemaVersion} ·{" "}
                {locale === "zh-CN" ? "状态正常" : "healthy"}
              </p>
            </article>
            <article className="card">
              <p className="card-label">{locale === "zh-CN" ? "运行版本" : "RUNTIME VERSION"}</p>
              <h2>v{bootstrap.product.version}</h2>
              <p>
                {locale === "zh-CN" ? "配置契约" : "Configuration contract"}{" "}
                {selectedDraft.configuration.schemaVersion}
              </p>
            </article>
            <article className="card">
              <p className="card-label">
                {locale === "zh-CN" ? "虚拟模型协议" : "VIRTUAL MODEL API"}
              </p>
              <h2>/v1</h2>
              <p>
                {bootstrap.runtime.provider.configured
                  ? `${bootstrap.runtime.provider.type} · ${bootstrap.runtime.provider.model}`
                  : locale === "zh-CN"
                    ? "模型发现可用 · 供应商待配置"
                    : "Model discovery ready · provider not configured"}
              </p>
              <p>JSON + SSE · Function tools</p>
            </article>
          </section>

          <section className="configuration-panel">
            <div className="configuration-heading">
              <div>
                <p className="card-label">CONFIGURATION DRAFTS</p>
                <h2>{locale === "zh-CN" ? "配置模式" : "Configuration modes"}</h2>
                <p>
                  {locale === "zh-CN"
                    ? "两个模式独立保存；切换只查看草稿，不会改变当前运行配置。"
                    : "Normal and Expert drafts are isolated. Switching the editor never changes the active runtime profile."}
                </p>
              </div>
              <fieldset
                className="mode-switcher"
                aria-label={locale === "zh-CN" ? "配置模式" : "Configuration mode"}
              >
                {(["managed", "expert"] as const).map((mode) => (
                  <button
                    className={
                      selectedMode === mode ? "mode-button mode-button-active" : "mode-button"
                    }
                    type="button"
                    aria-pressed={selectedMode === mode}
                    onClick={() => selectMode(mode)}
                    disabled={isPending}
                    key={mode}
                  >
                    {modeLabel(mode, locale)}
                  </button>
                ))}
              </fieldset>
            </div>

            <div className="configuration-form">
              <label>
                {locale === "zh-CN" ? "配置标识" : "Profile ID"}
                <input
                  value={form.activeProfileId}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      activeProfileId: event.target.value,
                    }))
                  }
                  maxLength={64}
                  placeholder={`${selectedMode}-default`}
                  disabled={isPending}
                />
                <small>
                  {locale === "zh-CN"
                    ? "仅支持小写字母、数字和连字符，最长 64 位。"
                    : "Use up to 64 lowercase letters, numbers, or hyphens."}
                </small>
              </label>
              <label>
                {locale === "zh-CN" ? "虚拟模型名称" : "Virtual model name"}
                <input
                  value={form.virtualModelName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      virtualModelName: event.target.value,
                    }))
                  }
                  maxLength={64}
                  placeholder="九门赛博提督"
                  disabled={isPending}
                />
                <small>
                  {locale === "zh-CN"
                    ? "对兼容客户端显示的名称；AI-Tidu9 标识不会因此移除。"
                    : "Displayed by compatible clients; AI-Tidu9 attribution remains."}
                </small>
              </label>
            </div>

            <div className="configuration-actions">
              <p
                className={
                  operation.status === "error"
                    ? "operation-message operation-error"
                    : "operation-message"
                }
                aria-live="polite"
              >
                {operation.status === "idle"
                  ? isDirty
                    ? locale === "zh-CN"
                      ? "存在未保存修改。切换模式会放弃这些输入。"
                      : "Unsaved changes will be discarded when switching modes."
                    : locale === "zh-CN"
                      ? `草稿修订 ${selectedDraft.revision}，尚未产生新的修改。`
                      : `Draft revision ${selectedDraft.revision}; no new changes.`
                  : operation.status === "pending"
                    ? operation.action === "save"
                      ? locale === "zh-CN"
                        ? "正在验证并保存…"
                        : "Validating and saving…"
                      : operation.action === "simulate"
                        ? locale === "zh-CN"
                          ? "正在模拟…"
                          : "Simulating…"
                        : operation.action === "rollback"
                          ? locale === "zh-CN"
                            ? "正在回滚…"
                            : "Rolling back…"
                          : locale === "zh-CN"
                            ? "正在启用…"
                            : "Activating…"
                    : operation.message}
              </p>
              <div className="action-buttons">
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!isDirty || isPending}
                >
                  {locale === "zh-CN" ? "保存草稿" : "Save draft"}
                </button>
                <button
                  type="button"
                  onClick={() => void simulateDraft()}
                  disabled={isDirty || isPending}
                >
                  {locale === "zh-CN" ? "模拟影响" : "Preview impact"}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void activateDraft()}
                  disabled={isDirty || isPending || impactPreview?.valid !== true}
                >
                  {locale === "zh-CN" ? "启用此配置" : "Activate"}
                </button>
                <button
                  type="button"
                  onClick={() => void rollbackConfiguration()}
                  disabled={isPending}
                >
                  {locale === "zh-CN" ? "回滚" : "Rollback"}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : activeSection === "personal" ? (
        <PersonalExperiencePanel
          locale={locale}
          providerConfigured={bootstrap.runtime.provider.configured}
          providerType={bootstrap.runtime.provider.type}
        />
      ) : activeSection === "enterprise" ? (
        <EnterprisePilotPanel enterprise={bootstrap.enterprise} locale={locale} />
      ) : activeSection === "clients" ? (
        <section className="client-panel">
          <div className="configuration-heading">
            <div>
              <p className="card-label">LOCAL CLIENT DISCOVERY</p>
              <h2>{locale === "zh-CN" ? "本机客户端" : "Local clients"}</h2>
              <p>
                {locale === "zh-CN"
                  ? "只检查命令、应用和配置文件是否存在，不读取配置正文与账号数据。"
                  : "Discovery checks metadata only and never reads configuration bodies or account data."}
              </p>
            </div>
            <span className="client-privacy">METADATA ONLY</span>
          </div>
          <div className="client-grid">
            {bootstrap.clients.clients.map((client) => (
              <article className="client-card" key={client.id}>
                <div className="client-card-heading">
                  <div>
                    <p className="client-protocol">
                      {clientIntegrationLabel(client.integrationMode, locale)} · {client.protocol}
                    </p>
                    <h3>{client.name}</h3>
                  </div>
                  <span className={`client-state client-state-${client.readiness}`}>
                    {clientReadinessLabel(client.readiness, locale)}
                  </span>
                </div>
                <dl className="client-signals">
                  <div>
                    <dt>{locale === "zh-CN" ? "命令" : "Command"}</dt>
                    <dd>
                      {client.signals.command
                        ? locale === "zh-CN"
                          ? "已发现"
                          : "Detected"
                        : locale === "zh-CN"
                          ? "未发现"
                          : "Missing"}
                    </dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "应用" : "Application"}</dt>
                    <dd>
                      {client.signals.application
                        ? locale === "zh-CN"
                          ? "已发现"
                          : "Detected"
                        : locale === "zh-CN"
                          ? "未发现"
                          : "Missing"}
                    </dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "配置" : "Configuration"}</dt>
                    <dd>
                      {client.signals.configuration
                        ? locale === "zh-CN"
                          ? "已存在"
                          : "Present"
                        : locale === "zh-CN"
                          ? "未发现"
                          : "Missing"}
                    </dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "原生协议" : "Native protocol"}</dt>
                    <dd>
                      {client.signals.agentProtocol
                        ? locale === "zh-CN"
                          ? "已发现"
                          : "Detected"
                        : locale === "zh-CN"
                          ? "未发现"
                          : "Missing"}
                    </dd>
                  </div>
                </dl>
                <p className="client-limitation">
                  {clientLimitationLabel(client.limitation, locale) ??
                    (client.detected
                      ? client.id === "codex"
                        ? locale === "zh-CN"
                          ? "优先通过app-server复用当前Codex账户；虚拟模型Profile仅作兼容入口。"
                          : "Prefer app-server delegation for the current Codex account; the virtual-model profile is a compatibility entry."
                        : client.id === "cursor" && client.signals.agentProtocol
                          ? locale === "zh-CN"
                            ? "通过官方ACP复用当前Cursor账户，不读取或复制登录凭据。"
                            : "Reuse the current Cursor account through official ACP without reading or copying credentials."
                          : locale === "zh-CN"
                            ? "当前不自动写入此客户端的配置。"
                            : "This client is not modified automatically."
                      : locale === "zh-CN"
                        ? "安装客户端后刷新即可重新检测。"
                        : "Install the client and refresh to detect it.")}
                </p>
                {client.id === "codex" && client.detected ? (
                  <code className="client-command">tidu clients connect codex</code>
                ) : null}
              </article>
            ))}
          </div>
          <p className="guide-note">
            {locale === "zh-CN"
              ? "全能力接入优先使用Codex app-server、Cursor ACP等官方原生Agent协议；OpenAI兼容虚拟模型是通用客户端的兼容入口，不能冒充宿主完整能力。Ollama属于上游模型供应商，不是客户端。"
              : "Full-capability integration prefers official native Agent protocols such as Codex app-server and Cursor ACP. The OpenAI-compatible virtual model is a generic compatibility entry and never impersonates the host's complete capabilities. Ollama is an upstream model provider, not a client."}
          </p>
        </section>
      ) : activeSection === "tasks" ? (
        <TaskControlPanel locale={locale} />
      ) : (
        <GuideCenter locale={locale} />
      )}

      <footer>
        {locale === "zh-CN"
          ? "仅监听本机回环地址 · 数据默认保留在本地 · 保存不等于启用"
          : "Loopback only · data stays local by default · saving is not activation"}
      </footer>
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

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ConfigurationMode, validateConfiguration } from "../../src/config/index.js";
import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";
import "./styles.scss";
import {
  type HostUsageLoadState,
  HostUsagePanel,
  type HostUsageSnapshot,
} from "./components/host-usage-panel.js";
import { ServiceControlPanel } from "./components/service-control-panel.js";
import {
  type ClientConnectionState,
  type ConfigurationForm,
  type ConfigurationImpactPreview,
  clientIntegrationLabel,
  clientReadinessLabel,
  DEFAULT_EXPERT_SERVICES,
  EnterpriseEditionPanel,
  type EntryValidationMessages,
  GuideCenter,
  type LoadingState,
  modeLabel,
  type OperationState,
  PersonalExperiencePanel,
  QuickStartWizard,
  requestBootstrap,
  TaskControlPanel,
  toForm,
} from "./configuration-sections.js";

interface CodexConfigurationStatus {
  /** Whether the managed AI-Tidu9 profile is installed. */
  installed: boolean;
  /** Configuration selected for newly started Codex sessions. */
  activeMode: "official" | "ai-tidu9";
  /** Managed endpoint, or null when not installed. */
  endpoint: string | null;
  /** Managed model, or null when not installed. */
  model: string | null;
}

interface CodexFailureResponse {
  /** Component responsible for the failed configuration or inference check. */
  failureSource?: "ai-tidu9" | "official-codex";
  /** General failure message returned by the runtime. */
  message?: string;
  /** Safe explanation without credentials or request content. */
  reason?: string;
  /** Stable reason identifier returned by the runtime. */
  reasonCode?: string;
}

const formatCodexFailure = (failure: CodexFailureResponse, locale: "en-US" | "zh-CN"): string => {
  const officialFailure = failure.failureSource === "official-codex";
  const reason = failure.reason ?? failure.message ?? "Unknown failure.";
  if (locale === "en-US") {
    const steps = officialFailure
      ? [
          "Run 'codex login status' and sign in again if needed.",
          "Switch to an official model and verify official Codex inference.",
          "Retry AI-Tidu9 after official Codex works.",
        ]
      : [
          "Local: confirm the development runtime is running. Remote: confirm the HTTPS endpoint and /health are reachable.",
          "Check the AI-Tidu9 provider and upstream model compatibility.",
          "Update the AI-Tidu9 configuration and retry, or switch to Official mode.",
        ];
    return `Failure source: ${officialFailure ? "Official Codex" : "AI-Tidu9 service"}\nReason: ${reason}\nRecovery:\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
  }
  const steps = officialFailure
    ? [
        "运行 codex login status；登录失效时重新登录官方 Codex。",
        "切换到官方模型，确认官方模型可以直接调用。",
        "官方调用恢复后，再切回九门重试。",
      ]
    : [
        "本地：确认开发服务正在运行；远程：确认 HTTPS 地址及 /health 可以访问。",
        "检查九门的模型供应商配置和上游模型兼容性。",
        "点击“修复 / 安装 Codex 连接”后重试；仍不可用时先切回“官方直连”。",
      ];
  return `故障归属：${officialFailure ? "官方 Codex" : "九门服务"}\n具体原因：${reason}\n处理流程：\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
};

const App = () => {
  const [loadingState, setLoadingState] = useState<LoadingState>({
    status: "loading",
  });
  const [activeSection, setActiveSection] = useState<
    | "clients"
    | "configuration"
    | "enterprise"
    | "guide"
    | "personal"
    | "services"
    | "tasks"
    | "usage"
  >("configuration");
  const [locale, setLocale] = useState<"en-US" | "zh-CN">("zh-CN");
  const [selectedMode, setSelectedMode] = useState<ConfigurationMode>("managed");
  const [configurationView, setConfigurationView] = useState<"active" | "edit">("active");
  const selectedModeRef = useRef<ConfigurationMode>("managed");
  const hasLoadedWorkspace = useRef(false);
  const [configurationForm, setConfigurationForm] = useState<ConfigurationForm>({
    activeProfileId: "ai-tidu9-config",
    virtualModelName: "九门赛博提督",
    modelSelection: { source: "official", model: "current" },
    expertServices: DEFAULT_EXPERT_SERVICES,
  });
  const [operation, setOperation] = useState<OperationState>({
    status: "idle",
  });
  const [impactPreview, setImpactPreview] = useState<ConfigurationImpactPreview | undefined>();
  const [hostUsageState, setHostUsageState] = useState<HostUsageLoadState>({
    status: "idle",
  });
  const [connectingCursor, setConnectingCursor] = useState(false);
  const [cursorConnectionError, setCursorConnectionError] = useState<string | null>(null);
  const [codexConnection, setCodexConnection] = useState<ClientConnectionState>({
    status: "idle",
  });
  const [codexConfiguration, setCodexConfiguration] = useState<CodexConfigurationStatus>({
    installed: false,
    activeMode: "official",
    endpoint: null,
    model: null,
  });
  const [codexSelectedMode, setCodexSelectedMode] = useState<"official" | "ai-tidu9">("official");
  const [codexConfigurationPending, setCodexConfigurationPending] = useState(false);
  const refreshCodexConfiguration = useCallback(async () => {
    const response = await fetch("/api/clients/codex/configuration", {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "当前运行的是旧版九门后台，请重启九门服务后刷新页面。"
          : "Codex 配置状态读取失败。",
      );
    }
    const configuration = (await response.json()) as CodexConfigurationStatus;
    setCodexConfiguration(configuration);
    setCodexSelectedMode(configuration.activeMode);
  }, []);
  const refreshHostUsage = useCallback(async () => {
    setHostUsageState({ status: "loading" });
    try {
      const response = await fetch("/api/host-usage", { cache: "no-store" });
      if (!response.ok) throw new Error("Host usage unavailable");
      setHostUsageState({
        status: "ready",
        snapshot: (await response.json()) as HostUsageSnapshot,
      });
    } catch {
      setHostUsageState({
        status: "error",
        message:
          locale === "zh-CN"
            ? "宿主数据读取失败，请确认本地服务仍在运行后重试。"
            : "Failed to load host data. Check that the local service is running and try again.",
      });
    }
  }, [locale]);
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
      const result = (await response.json()) as CodexFailureResponse & {
        message?: string;
        profile?: string;
      };
      if (!response.ok) {
        throw new Error(formatCodexFailure(result, locale));
      }
      setCodexConnection({
        status: "success",
        message:
          locale === "zh-CN"
            ? "九门配置已准备，当前保持纯官方直连；九门模型与 MCP 不会在确认切换前启用。"
            : "AI-Tidu9 is prepared while pure Official direct mode remains active. Its model and MCP stay disabled until you confirm the switch.",
      });
      await refreshCodexConfiguration();
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
  }, [locale, refreshCodexConfiguration]);

  const updateCodexConfiguration = useCallback(
    async (mode: "official" | "ai-tidu9") => {
      setCodexConfigurationPending(true);
      setCodexConnection({ status: "pending" });
      try {
        const response = await fetch("/api/clients/codex/configuration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const result = (await response.json()) as CodexConfigurationStatus & CodexFailureResponse;
        if (!response.ok) {
          throw new Error(formatCodexFailure(result, locale));
        }
        setCodexConfiguration(result);
        setCodexSelectedMode(result.activeMode);
        setCodexConnection({
          status: "success",
          message:
            mode === "official"
              ? locale === "zh-CN"
                ? "已恢复纯官方 Codex 直连，并注销九门 MCP。重启 Codex 后现有会话也会完全卸载九门进程。"
                : "Pure Official Codex direct mode is restored and the AI-Tidu9 MCP is unregistered. Restart Codex to unload it from existing sessions."
              : locale === "zh-CN"
                ? "九门本地服务与推理验证通过。重启 Codex 后会显示一个九门虚拟模型；其上游模型由配置页决定，官方账号身份保持不变。"
                : "The local AI-Tidu9 service and inference were verified. Restart Codex to show both AI-Tidu9 and official models while retaining the official account identity.",
        });
      } catch (error) {
        await refreshCodexConfiguration().catch(() => undefined);
        setCodexConnection({
          status: "error",
          message: error instanceof Error ? error.message : "Codex configuration switch failed.",
        });
      } finally {
        setCodexConfigurationPending(false);
      }
    },
    [locale, refreshCodexConfiguration],
  );

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

  useEffect(() => {
    if (activeSection === "clients") {
      void refreshCodexConfiguration();
    }
  }, [activeSection, refreshCodexConfiguration]);

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
          modelSelection: form.modelSelection,
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
          modelSelection: savedForm.modelSelection,
        };
  const isDirty = JSON.stringify(persistedForm) !== JSON.stringify(savedPersistedForm);
  const isPending = operation.status === "pending";
  const isSelectedDraftActive =
    workspace.active.configuration.activeMode === selectedMode &&
    workspace.active.configuration.activeProfileId === form.activeProfileId &&
    workspace.active.configuration.virtualModelName === form.virtualModelName &&
    workspace.active.configuration.modelSelection.source === form.modelSelection.source &&
    workspace.active.configuration.modelSelection.model === form.modelSelection.model &&
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
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          configuration: {
            schemaVersion: selectedDraft.configuration.schemaVersion,
            activeMode: selectedMode,
            ...persistedForm,
          },
        }),
      });
      const preview = (await response.json()) as ConfigurationImpactPreview & {
        message?: string;
      };
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
          <button
            className={
              activeSection === "services"
                ? "section-button section-button-active"
                : "section-button"
            }
            type="button"
            aria-current={activeSection === "services" ? "page" : undefined}
            onClick={() => setActiveSection("services")}
          >
            {locale === "zh-CN" ? "服务" : "Services"}
          </button>
        ) : null}
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
        {bootstrap.deployment === "personal" ? (
          <button
            className={
              activeSection === "clients"
                ? "section-button section-button-active"
                : "section-button"
            }
            type="button"
            aria-current={activeSection === "clients" ? "page" : undefined}
            onClick={() => setActiveSection("clients")}
          >
            {locale === "zh-CN" ? "客户端" : "Clients"}
          </button>
        ) : null}
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
                      ? "这里只显示当前生效的配置；运行状态统一在服务页查看。"
                      : "This view shows active configuration only; runtime status is available under Services."
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
              aria-label={locale === "zh-CN" ? "生效配置" : "Active configuration"}
            >
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
                  {locale === "zh-CN" ? "当前上游" : "Selected upstream"}：
                  {workspace.active.configuration.modelSelection.source === "official"
                    ? locale === "zh-CN"
                      ? "官方模型"
                      : "Official"
                    : locale === "zh-CN"
                      ? "公司模型"
                      : "Company"}
                  {" · "}
                  {workspace.active.configuration.modelSelection.model === "current"
                    ? locale === "zh-CN"
                      ? "跟随当前官方模型"
                      : "Follow current official model"
                    : workspace.active.configuration.modelSelection.model}
                </p>
                <p>
                  {locale === "zh-CN" ? "修订" : "Revision"}：{workspace.active.revision} ·{" "}
                  {workspace.active.updatedAt}
                </p>
                <p>
                  {locale === "zh-CN" ? "配置契约" : "Configuration contract"}：
                  {workspace.active.configuration.schemaVersion}
                </p>
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
          state={hostUsageState}
          locale={locale}
          onRefresh={() => void refreshHostUsage()}
          onConnectCursor={() => void connectCursor()}
          connectingCursor={connectingCursor}
          cursorConnectionError={cursorConnectionError}
        />
      ) : bootstrap.deployment === "personal" && activeSection === "services" ? (
        <ServiceControlPanel locale={locale} />
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
      ) : bootstrap.deployment === "personal" && activeSection === "clients" ? (
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
                      ? "这里只管理 Codex 接入，不配置上游模型。九门模式在 Codex 中只增加一个九门虚拟模型；其官方或公司上游在配置页选择。"
                      : "This area manages Codex connectivity, not upstream selection. AI-Tidu9 mode adds one virtual model to Codex; select its official or company upstream on the configuration page."
                    : locale === "zh-CN"
                      ? "九门作为 MCP 连接器接入 Cursor；Cursor 官方模型列表不会新增九门模型项。"
                      : "AI-Tidu9 connects to Cursor as an MCP connector; Cursor's official model list does not gain an AI-Tidu9 model entry."}
                </p>
                {group.id === "openai" ? (
                  <div className="client-connect-row">
                    <div className="client-configuration-status">
                      <strong>
                        {locale === "zh-CN" ? "Codex 接入模式" : "Codex connection mode"}
                      </strong>
                      <span>
                        {codexConfiguration.activeMode === "official"
                          ? locale === "zh-CN"
                            ? "官方直连"
                            : "Official direct"
                          : locale === "zh-CN"
                            ? "九门模式"
                            : "AI-Tidu9 mode"}
                      </span>
                    </div>
                    <div className="codex-configuration-modes">
                      <button
                        type="button"
                        className={
                          codexSelectedMode === "ai-tidu9"
                            ? "codex-configuration-mode selected"
                            : "codex-configuration-mode"
                        }
                        disabled={codexConfigurationPending || !codexConfiguration.installed}
                        onClick={() => setCodexSelectedMode("ai-tidu9")}
                      >
                        <strong>{locale === "zh-CN" ? "九门模式" : "AI-Tidu9 mode"}</strong>
                        <span>
                          {locale === "zh-CN"
                            ? "一个九门虚拟模型，上游在配置页选择"
                            : "One virtual model; choose its upstream in Configuration"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={
                          codexSelectedMode === "official"
                            ? "codex-configuration-mode selected"
                            : "codex-configuration-mode"
                        }
                        disabled={codexConfigurationPending}
                        onClick={() => setCodexSelectedMode("official")}
                      >
                        <strong>{locale === "zh-CN" ? "官方直连" : "Official direct"}</strong>
                        <span>
                          {locale === "zh-CN"
                            ? "仅使用账号可用的官方模型"
                            : "Only account-available official models"}
                        </span>
                      </button>
                    </div>
                    {codexSelectedMode !== codexConfiguration.activeMode ? (
                      <div className="codex-mode-confirmation">
                        <p>
                          {locale === "zh-CN"
                            ? `待切换：${codexConfiguration.activeMode === "official" ? "官方直连" : "九门模式"} → ${codexSelectedMode === "official" ? "官方直连" : "九门模式"}`
                            : `Pending: ${codexConfiguration.activeMode === "official" ? "Official direct" : "AI-Tidu9 mode"} → ${codexSelectedMode === "official" ? "Official direct" : "AI-Tidu9 mode"}`}
                        </p>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={codexConfigurationPending}
                          onClick={() => void updateCodexConfiguration(codexSelectedMode)}
                        >
                          {codexConfigurationPending
                            ? locale === "zh-CN"
                              ? "切换中…"
                              : "Switching…"
                            : locale === "zh-CN"
                              ? "确认切换"
                              : "Confirm switch"}
                        </button>
                        <button
                          type="button"
                          disabled={codexConfigurationPending}
                          onClick={() => setCodexSelectedMode(codexConfiguration.activeMode)}
                        >
                          {locale === "zh-CN" ? "取消" : "Cancel"}
                        </button>
                      </div>
                    ) : null}
                    <div className="codex-global-setup">
                      <div>
                        <strong>
                          {locale === "zh-CN" ? "全局 Codex 配置" : "Global Codex setup"}
                        </strong>
                        <span>
                          {locale === "zh-CN"
                            ? "准备九门配置档和完整模型目录，供本机新启动的 Codex 会话使用；不会切换当前接入模式。"
                            : "Prepare the AI-Tidu9 profile and complete model catalog for newly started Codex sessions on this device. This does not switch the active mode."}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={codexConnection.status === "pending"}
                        onClick={() => void connectCodex()}
                      >
                        {codexConnection.status === "pending"
                          ? locale === "zh-CN"
                            ? "正在更新…"
                            : "Updating…"
                          : locale === "zh-CN"
                            ? codexConfiguration.installed
                              ? "更新全局配置"
                              : "准备全局配置"
                            : codexConfiguration.installed
                              ? "Update global setup"
                              : "Prepare global setup"}
                      </button>
                    </div>
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

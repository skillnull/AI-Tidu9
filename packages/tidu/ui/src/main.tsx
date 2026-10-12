import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConfigurationMode, TiduConfiguration } from "../../src/config/index.js";
import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";
import "./styles.css";

type LoadingState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: ConfigCenterBootstrap }
  | { status: "error"; message: string };

type OperationState =
  | { status: "idle" }
  | { status: "pending"; action: "activate" | "save" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

interface ConfigurationForm {
  /** Stable lowercase identifier used to select this profile. */
  activeProfileId: string;
  /** User-facing virtual-model name exposed by compatible clients. */
  virtualModelName: string;
}

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

const modeLabel = (mode: ConfigurationMode): string =>
  mode === "managed" ? "普通模式" : "专家模式";

const clientReadinessLabel = (
  readiness: ConfigCenterBootstrap["clients"]["clients"][number]["readiness"],
): string => {
  if (readiness === "configurable") {
    return "已发现 · 可配置";
  }
  if (readiness === "limited") {
    return "已发现 · 能力有限";
  }
  return "未发现";
};

const clientLimitationLabel = (
  limitation: ConfigCenterBootstrap["clients"]["clients"][number]["limitation"],
): string | null => {
  if (limitation === "cursor-standard-chat-only") {
    return "仅发现Cursor桌面端时只能使用聊天兼容入口；这不等同于完整Agent能力。";
  }
  return null;
};

const clientIntegrationLabel = (
  integrationMode: ConfigCenterBootstrap["clients"]["clients"][number]["integrationMode"],
): string => {
  if (integrationMode === "native-agent") {
    return "原生Agent桥接";
  }
  if (integrationMode === "virtual-model") {
    return "虚拟模型兼容";
  }
  return "等待安装";
};

const GuideCenter = () => {
  const [audience, setAudience] = useState<"company" | "personal">("personal");

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
            当前版本支持OpenAI兼容服务或本地Ollama的非流式、SSE流式与基础函数工具协议；已支持客户端无凭据发现，安全写入配置和Agent自主执行尚未开放。
          </p>
        </div>
      ) : (
        <div className="guide-content">
          <div className="guide-summary">
            <span className="availability availability-planned">企业版规划</span>
            <p>以下流程将在企业部署能力完成后，由实际公司配置自动生成。</p>
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

const App = () => {
  const [loadingState, setLoadingState] = useState<LoadingState>({
    status: "loading",
  });
  const [activeSection, setActiveSection] = useState<"clients" | "configuration" | "guide">(
    "configuration",
  );
  const [selectedMode, setSelectedMode] = useState<ConfigurationMode>("managed");
  const [form, setForm] = useState<ConfigurationForm>({
    activeProfileId: "managed-default",
    virtualModelName: "九门赛博提督",
  });
  const [operation, setOperation] = useState<OperationState>({
    status: "idle",
  });

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

  const selectMode = (mode: ConfigurationMode): void => {
    setSelectedMode(mode);
    setForm(toForm(workspace.drafts[mode].configuration));
    setOperation({ status: "idle" });
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
        <p className="explanation">智能协作中枢 · 本地配置中心</p>
      </header>

      <nav className="section-navigation" aria-label="配置中心栏目">
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
          配置
        </button>
        <button
          className={
            activeSection === "clients" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "clients" ? "page" : undefined}
          onClick={() => setActiveSection("clients")}
        >
          客户端
        </button>
        <button
          className={
            activeSection === "guide" ? "section-button section-button-active" : "section-button"
          }
          type="button"
          aria-current={activeSection === "guide" ? "page" : undefined}
          onClick={() => setActiveSection("guide")}
        >
          使用指南
        </button>
      </nav>

      <section className="overview">
        <div>
          <span className="status-dot" aria-hidden="true" />
          <span>本地运行时正常</span>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={isPending}>
          刷新状态
        </button>
      </section>

      {activeSection === "configuration" ? (
        <>
          <section className="cards" aria-label="运行状态">
            <article className="card">
              <p className="card-label">当前生效配置</p>
              <h2>{workspace.active.configuration.virtualModelName}</h2>
              <p>
                {modeLabel(workspace.active.configuration.activeMode)} ·{" "}
                {workspace.active.configuration.activeProfileId}
              </p>
            </article>
            <article className="card">
              <p className="card-label">本地存储</p>
              <h2>{bootstrap.storage.provider.toUpperCase()}</h2>
              <p>Schema {bootstrap.storage.schemaVersion} · 状态正常</p>
            </article>
            <article className="card">
              <p className="card-label">运行版本</p>
              <h2>v{bootstrap.product.version}</h2>
              <p>配置契约 {selectedDraft.configuration.schemaVersion}</p>
            </article>
            <article className="card">
              <p className="card-label">虚拟模型协议</p>
              <h2>/v1</h2>
              <p>
                {bootstrap.runtime.provider.configured
                  ? `${bootstrap.runtime.provider.type} · ${bootstrap.runtime.provider.model}`
                  : "模型发现可用 · 供应商待配置"}
              </p>
              <p>JSON + SSE · Function tools</p>
            </article>
          </section>

          <section className="configuration-panel">
            <div className="configuration-heading">
              <div>
                <p className="card-label">CONFIGURATION DRAFTS</p>
                <h2>配置模式</h2>
                <p>两个模式独立保存；切换只查看草稿，不会改变当前运行配置。</p>
              </div>
              <fieldset className="mode-switcher" aria-label="配置模式">
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
                    {modeLabel(mode)}
                  </button>
                ))}
              </fieldset>
            </div>

            <div className="configuration-form">
              <label>
                配置标识
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
                <small>仅支持小写字母、数字和连字符，最长 64 位。</small>
              </label>
              <label>
                虚拟模型名称
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
                <small>对兼容客户端显示的名称；AI-Tidu9 标识不会因此移除。</small>
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
                    ? "存在未保存修改。切换模式会放弃这些输入。"
                    : `草稿修订 ${selectedDraft.revision}，尚未产生新的修改。`
                  : operation.status === "pending"
                    ? operation.action === "save"
                      ? "正在验证并保存…"
                      : "正在启用…"
                    : operation.message}
              </p>
              <div className="action-buttons">
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!isDirty || isPending}
                >
                  保存草稿
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void activateDraft()}
                  disabled={isDirty || isPending}
                >
                  启用此配置
                </button>
              </div>
            </div>
          </section>
        </>
      ) : activeSection === "clients" ? (
        <section className="client-panel">
          <div className="configuration-heading">
            <div>
              <p className="card-label">LOCAL CLIENT DISCOVERY</p>
              <h2>本机客户端</h2>
              <p>只检查命令、应用和配置文件是否存在，不读取配置正文与账号数据。</p>
            </div>
            <span className="client-privacy">METADATA ONLY</span>
          </div>
          <div className="client-grid">
            {bootstrap.clients.clients.map((client) => (
              <article className="client-card" key={client.id}>
                <div className="client-card-heading">
                  <div>
                    <p className="client-protocol">
                      {clientIntegrationLabel(client.integrationMode)} · {client.protocol}
                    </p>
                    <h3>{client.name}</h3>
                  </div>
                  <span className={`client-state client-state-${client.readiness}`}>
                    {clientReadinessLabel(client.readiness)}
                  </span>
                </div>
                <dl className="client-signals">
                  <div>
                    <dt>命令</dt>
                    <dd>{client.signals.command ? "已发现" : "未发现"}</dd>
                  </div>
                  <div>
                    <dt>应用</dt>
                    <dd>{client.signals.application ? "已发现" : "未发现"}</dd>
                  </div>
                  <div>
                    <dt>配置</dt>
                    <dd>{client.signals.configuration ? "已存在" : "未发现"}</dd>
                  </div>
                  <div>
                    <dt>原生协议</dt>
                    <dd>{client.signals.agentProtocol ? "已发现" : "未发现"}</dd>
                  </div>
                </dl>
                <p className="client-limitation">
                  {clientLimitationLabel(client.limitation) ??
                    (client.detected
                      ? client.id === "codex"
                        ? "优先通过app-server复用当前Codex账户；虚拟模型Profile仅作兼容入口。"
                        : client.id === "cursor" && client.signals.agentProtocol
                          ? "通过官方ACP复用当前Cursor账户，不读取或复制登录凭据。"
                          : "当前不自动写入此客户端的配置。"
                      : "安装客户端后刷新即可重新检测。")}
                </p>
                {client.id === "codex" && client.detected ? (
                  <code className="client-command">tidu clients connect codex</code>
                ) : null}
              </article>
            ))}
          </div>
          <p className="guide-note">
            全能力接入优先使用Codex app-server、Cursor
            ACP等官方原生Agent协议；OpenAI兼容虚拟模型是通用客户端的兼容入口，不能冒充宿主完整能力。Ollama属于上游模型供应商，不是客户端。
          </p>
        </section>
      ) : (
        <GuideCenter />
      )}

      <footer>仅监听本机回环地址 · 数据默认保留在本地 · 保存不等于启用</footer>
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

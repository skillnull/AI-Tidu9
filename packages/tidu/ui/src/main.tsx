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

const App = () => {
  const [loadingState, setLoadingState] = useState<LoadingState>({ status: "loading" });
  const [selectedMode, setSelectedMode] = useState<ConfigurationMode>("managed");
  const [form, setForm] = useState<ConfigurationForm>({
    activeProfileId: "managed-default",
    virtualModelName: "九门赛博提督",
  });
  const [operation, setOperation] = useState<OperationState>({ status: "idle" });

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
          body: JSON.stringify({ expectedDraftRevision: selectedDraft.revision }),
        },
      );
      acceptBootstrap(nextBootstrap, selectedMode);
      setOperation({ status: "success", message: `${modeLabel(selectedMode)}已明确启用。` });
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

      <section className="overview">
        <div>
          <span className="status-dot" aria-hidden="true" />
          <span>本地运行时正常</span>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={isPending}>
          刷新状态
        </button>
      </section>

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
                className={selectedMode === mode ? "mode-button mode-button-active" : "mode-button"}
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
                setForm((current) => ({ ...current, activeProfileId: event.target.value }))
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
                setForm((current) => ({ ...current, virtualModelName: event.target.value }))
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
            <button type="button" onClick={() => void saveDraft()} disabled={!isDirty || isPending}>
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

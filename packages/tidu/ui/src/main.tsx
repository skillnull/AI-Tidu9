import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { ConfigCenterBootstrap } from "../../src/config-center/contracts.js";
import "./styles.css";

type LoadingState =
  | { status: "loading" }
  | { status: "ready"; bootstrap: ConfigCenterBootstrap }
  | { status: "error"; message: string };

const loadBootstrap = async (): Promise<ConfigCenterBootstrap> => {
  const response = await fetch("/api/config-center", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`配置中心返回 ${response.status}`);
  }
  return (await response.json()) as ConfigCenterBootstrap;
};

const App = () => {
  const [loadingState, setLoadingState] = useState<LoadingState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setLoadingState({ status: "loading" });
    try {
      const bootstrap = await loadBootstrap();
      setLoadingState({ status: "ready", bootstrap });
    } catch (error) {
      setLoadingState({
        status: "error",
        message: error instanceof Error ? error.message : "无法读取本地运行状态",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      ) : null}

      {loadingState.status === "error" ? (
        <section className="state-panel state-panel-error" aria-live="assertive">
          <h2>连接失败</h2>
          <p>{loadingState.message}</p>
          <button type="button" onClick={() => void refresh()}>
            重新连接
          </button>
        </section>
      ) : null}

      {loadingState.status === "ready" ? (
        <>
          <section className="overview">
            <div>
              <span className="status-dot" aria-hidden="true" />
              <span>本地运行时正常</span>
            </div>
            <button type="button" onClick={() => void refresh()}>
              刷新状态
            </button>
          </section>

          <section className="cards" aria-label="运行状态">
            <article className="card">
              <p className="card-label">虚拟模型</p>
              <h2>{loadingState.bootstrap.configuration.virtualModelName}</h2>
              <p>当前使用普通模式安全默认值。</p>
            </article>
            <article className="card">
              <p className="card-label">本地存储</p>
              <h2>{loadingState.bootstrap.storage.provider.toUpperCase()}</h2>
              <p>Schema {loadingState.bootstrap.storage.schemaVersion} · 状态正常</p>
            </article>
            <article className="card">
              <p className="card-label">运行版本</p>
              <h2>v{loadingState.bootstrap.product.version}</h2>
              <p>配置契约 {loadingState.bootstrap.configuration.schemaVersion}</p>
            </article>
          </section>

          <section className="next-step">
            <div>
              <p className="card-label">NEXT STEP</p>
              <h2>配置编辑将在下一实施项开放</h2>
              <p>普通模式和专家模式将使用隔离草稿，验证通过后才能启用。</p>
            </div>
            <span className="read-only-badge">当前只读</span>
          </section>
        </>
      ) : null}

      <footer>仅监听本机回环地址 · 数据默认保留在本地</footer>
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

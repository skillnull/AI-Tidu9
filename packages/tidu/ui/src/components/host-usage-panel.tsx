export interface HostUsageSnapshot {
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

export type HostUsageLoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; snapshot: HostUsageSnapshot }
  | { status: "error"; message: string };

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

export const HostUsagePanel = ({
  state,
  locale,
  onRefresh,
  onConnectCursor,
  connectingCursor,
  cursorConnectionError,
}: {
  state: HostUsageLoadState;
  locale: "en-US" | "zh-CN";
  onRefresh: () => void;
  onConnectCursor: () => void;
  connectingCursor: boolean;
  cursorConnectionError: string | null;
}) => {
  const chinese = locale === "zh-CN";
  const snapshot = state.status === "ready" ? state.snapshot : null;
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
        <button type="button" onClick={onRefresh} disabled={state.status === "loading"}>
          {state.status === "loading"
            ? chinese
              ? "读取中…"
              : "Loading…"
            : chinese
              ? "刷新数据"
              : "Refresh"}
        </button>
      </div>
      {state.status === "idle" || state.status === "loading" ? (
        <p role="status">
          {chinese
            ? "正在读取宿主账号、模型与额度数据…"
            : "Loading host account, model, and usage data…"}
        </p>
      ) : null}
      {state.status === "error" ? <p role="alert">{state.message}</p> : null}
      {state.status === "ready" ? (
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
              {snapshot?.activeProvider?.type === "codex-host"
                ? snapshot.activeProvider.model
                : "—"}
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
                  {[...usage.dailyTokens].reverse().map((bucket) => (
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
              {chinese
                ? "请在 Cursor 设置或用量面板查看"
                : "See Cursor settings or usage dashboard"}
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
      ) : null}
    </section>
  );
};

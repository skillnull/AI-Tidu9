import type { ProviderExecutionReceipt } from "../providers/index.js";

type TokenUsage = NonNullable<ProviderExecutionReceipt["usage"]>;

export interface ResponseModelUsage {
  /** Host that reported this model's consumption. */
  host: ProviderExecutionReceipt["host"];
  /** Upstream model confirmed by the host. */
  model: string;
  /** Role used for independent primary and secondary totals. */
  role: "main" | "secondary";
  /** Reported consumption, or null when unavailable. */
  usage: TokenUsage | null;
  /** Whether all correlated calls for this model reported usage. */
  complete: boolean;
}

export interface ResponseUsageSnapshot {
  /** Sum of provider-reported usage for the current user turn. */
  usage: TokenUsage | null;
  /** Whether every correlated inference round reported its usage. */
  complete: boolean;
  /** Independent consumption by role, host, and model when execution receipts are available. */
  models?: readonly ResponseModelUsage[];
}

const sumUsage = (usages: readonly (TokenUsage | null)[]): TokenUsage | null => {
  const reported = usages.filter((usage): usage is TokenUsage => usage !== null);
  return reported.length === 0
    ? null
    : reported.reduce(
        (total, usage) => ({
          inputTokens: total.inputTokens + usage.inputTokens,
          outputTokens: total.outputTokens + usage.outputTokens,
          totalTokens: total.totalTokens + usage.totalTokens,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      );
};

const combineModels = (models: readonly ResponseModelUsage[]): ResponseModelUsage[] => {
  const combined = new Map<string, ResponseModelUsage>();
  for (const model of models) {
    const key = JSON.stringify([model.host, model.model]);
    const previous = combined.get(key);
    combined.set(key, {
      ...model,
      role: previous?.role === "main" ? "main" : model.role,
      usage: sumUsage([previous?.usage ?? null, model.usage]),
      complete: (previous?.complete ?? true) && model.complete,
    });
  }
  return [...combined.values()].sort((first, second) =>
    first.role === second.role ? 0 : first.role === "main" ? -1 : 1,
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createResponseUsageLedger = () => {
  const pendingCalls = new Map<
    string,
    {
      groupId: string;
      usage: TokenUsage | null;
      models: readonly ResponseModelUsage[];
      complete: boolean;
      ancestors: ReadonlySet<string>;
      createdAt: number;
    }
  >();
  return {
    /** Correlates only tool outputs after the latest user message, without retaining prompt text. */
    begin: (input: unknown) => {
      const items = Array.isArray(input) ? input.filter(isRecord) : [];
      let userIndex = -1;
      items.forEach((item, index) => {
        if (item.role === "user") userIndex = index;
      });
      const previousGroups = new Map<
        string,
        {
          usage: TokenUsage | null;
          models: readonly ResponseModelUsage[];
          complete: boolean;
          ancestors: ReadonlySet<string>;
        }
      >();
      const callIds: string[] = [];
      let hadKnownParent = false;
      for (const item of items.slice(userIndex + 1)) {
        if (
          (item.type !== "function_call_output" &&
            item.type !== "custom_tool_call_output" &&
            item.type !== "tool_search_output") ||
          typeof item.call_id !== "string"
        )
          continue;
        const entry = pendingCalls.get(item.call_id);
        if (entry !== undefined) hadKnownParent = true;
        callIds.push(item.call_id);
        previousGroups.set(entry?.groupId ?? item.call_id, {
          usage: entry?.usage ?? null,
          models: entry?.models ?? [],
          complete: entry?.complete ?? false,
          ancestors: entry?.ancestors ?? new Set(),
        });
      }
      const previous = [...previousGroups].filter(
        ([groupId]) => ![...previousGroups.values()].some((group) => group.ancestors.has(groupId)),
      );
      const snapshot = (
        current: TokenUsage | null,
        models: readonly ResponseModelUsage[] = [],
      ): ResponseUsageSnapshot => {
        const groups = [...previous.map(([_groupId, group]) => group), { usage: current, models }];
        const combinedModels = combineModels(groups.flatMap((group) => group.models));
        return {
          complete:
            current !== null &&
            previous.every(([_groupId, group]) => group.complete) &&
            combinedModels.every((model) => model.complete),
          usage: sumUsage(groups.map((group) => group.usage)),
          models: combinedModels,
        };
      };
      return {
        /** Returns footer totals; wire-protocol usage remains per response to avoid double counting. */
        snapshot,
        /** Saves usage once per yielded response and releases correlations at a final result. */
        finish: (
          output: readonly Record<string, unknown>[],
          current: TokenUsage | null,
          models: readonly ResponseModelUsage[] = [],
          completed = true,
        ): void => {
          // A cancelled duplicate must not release a sibling delivery's ancestry.
          if (!completed) return;
          const requested = output.filter(
            (item) =>
              (item.type === "function_call" ||
                item.type === "custom_tool_call" ||
                item.type === "tool_search_call") &&
              typeof item.call_id === "string",
          );
          const ancestors = new Set<string>();
          const activeGroups = new Set([...pendingCalls.values()].map((entry) => entry.groupId));
          for (const [groupId, group] of previousGroups) {
            if (activeGroups.has(groupId)) ancestors.add(groupId);
            group.ancestors.forEach((ancestor) => {
              if (activeGroups.has(ancestor)) ancestors.add(ancestor);
            });
          }
          if (requested.length === 0) {
            for (const [callId, entry] of pendingCalls) {
              if (ancestors.has(entry.groupId) || callIds.includes(callId))
                pendingCalls.delete(callId);
            }
            return;
          }
          if (hadKnownParent && callIds.every((callId) => !pendingCalls.has(callId))) return;
          const cumulative = snapshot(current, models);
          const groupId = JSON.stringify(
            [...new Set(requested.map((item) => String(item.call_id)))].sort(),
          );
          const createdAt = Date.now();
          requested.forEach((item) => {
            pendingCalls.set(item.call_id as string, {
              groupId,
              usage: cumulative.usage,
              models: cumulative.models ?? [],
              complete: cumulative.complete,
              ancestors,
              createdAt,
            });
          });
          for (const [callId, entry] of pendingCalls) {
            if (pendingCalls.size > 2_000 || createdAt - entry.createdAt > 30 * 60_000)
              pendingCalls.delete(callId);
          }
        },
      };
    },
  };
};

export const formatResponseTokenFooter = (
  snapshot: ResponseUsageSnapshot,
  chinese: boolean,
): string => {
  const formatUsage = (usage: TokenUsage | null): string => {
    if (usage === null) return chinese ? "未获取到" : "not retrieved";
    if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0) return "";
    return chinese
      ? `入 ${usage.inputTokens} · 出 ${usage.outputTokens} · 合 ${usage.totalTokens}`
      : `input ${usage.inputTokens} · output ${usage.outputTokens} · total ${usage.totalTokens}`;
  };
  const hosts = new Map<
    ResponseModelUsage["host"],
    { usage: TokenUsage | null; complete: boolean }
  >();
  for (const model of snapshot.models ?? []) {
    const previous = hosts.get(model.host);
    hosts.set(model.host, {
      usage: sumUsage([previous?.usage ?? null, model.usage]),
      complete: (previous?.complete ?? true) && model.complete,
    });
  }
  const hostNames: Record<ResponseModelUsage["host"], string> = {
    codex: "Codex",
    cursor: "Cursor",
    ollama: "Ollama",
    "openai-compatible": "OpenAI-compatible",
  };
  const lines: string[] = [];
  for (const [host, totals] of hosts) {
    const usage = formatUsage(totals.usage);
    if (usage === "") continue;
    const partial =
      totals.usage !== null && !totals.complete ? (chinese ? "（部分统计）" : " (partial)") : "";
    lines.push(`${hostNames[host]}${chinese ? "：" : ": "}${usage}${partial}`);
  }
  const total = formatUsage(snapshot.usage);
  if (total !== "") lines.push(chinese ? `总：${total}` : `Total: ${total}`);
  return lines.join("  \n");
};

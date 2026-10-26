import { randomUUID } from "node:crypto";
import type { ProviderExecutionReceipt } from "../providers/index.js";

type TokenUsage = NonNullable<ProviderExecutionReceipt["usage"]>;

export interface ResponseUsageSnapshot {
  /** Sum of provider-reported usage for the current user turn. */
  usage: TokenUsage | null;
  /** Whether every correlated inference round reported its usage. */
  complete: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createResponseUsageLedger = () => {
  const pendingCalls = new Map<
    string,
    { groupId: string; usage: TokenUsage | null; createdAt: number }
  >();
  return {
    /** Correlates only tool outputs after the latest user message, without retaining prompt text. */
    begin: (input: unknown) => {
      const items = Array.isArray(input) ? input.filter(isRecord) : [];
      let userIndex = -1;
      items.forEach((item, index) => {
        if (item.role === "user") userIndex = index;
      });
      const previousGroups = new Map<string, TokenUsage | null>();
      const callIds: string[] = [];
      for (const item of items.slice(userIndex + 1)) {
        if (
          (item.type !== "function_call_output" &&
            item.type !== "custom_tool_call_output" &&
            item.type !== "tool_search_output") ||
          typeof item.call_id !== "string"
        )
          continue;
        const entry = pendingCalls.get(item.call_id);
        callIds.push(item.call_id);
        previousGroups.set(entry?.groupId ?? item.call_id, entry?.usage ?? null);
      }
      return {
        /** Returns footer totals; wire-protocol usage remains per response to avoid double counting. */
        snapshot: (current: TokenUsage | null): ResponseUsageSnapshot => {
          const usage = [...previousGroups.values(), current];
          const reported = usage.filter((item): item is TokenUsage => item !== null);
          return {
            complete: usage.every((item) => item !== null),
            usage:
              reported.length === 0
                ? null
                : reported.reduce(
                    (total, item) => ({
                      inputTokens: total.inputTokens + item.inputTokens,
                      outputTokens: total.outputTokens + item.outputTokens,
                      totalTokens: total.totalTokens + item.totalTokens,
                    }),
                    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  ),
          };
        },
        /** Saves usage once per yielded response and releases correlations at a final result. */
        finish: (output: readonly Record<string, unknown>[], current: TokenUsage | null): void => {
          const requested = output.filter(
            (item) =>
              (item.type === "function_call" ||
                item.type === "custom_tool_call" ||
                item.type === "tool_search_call") &&
              typeof item.call_id === "string",
          );
          if (requested.length === 0) {
            callIds.forEach((callId) => {
              pendingCalls.delete(callId);
            });
            return;
          }
          const groupId = randomUUID();
          const createdAt = Date.now();
          requested.forEach((item) => {
            pendingCalls.set(item.call_id as string, { groupId, usage: current, createdAt });
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
  const usage = snapshot.usage;
  if (usage === null) return chinese ? "Token：未获取到" : "Tokens: not retrieved";
  if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0) return "";
  return chinese
    ? `Token：输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 合计 ${usage.totalTokens}`
    : `Token: input ${usage.inputTokens} · output ${usage.outputTokens} · total ${usage.totalTokens}`;
};

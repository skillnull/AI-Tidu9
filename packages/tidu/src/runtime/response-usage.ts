import { createHash } from "node:crypto";
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

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const visualMessage = (item: unknown): item is Record<string, unknown> =>
  isRecord(item) &&
  item.role === "assistant" &&
  item.phase !== "commentary" &&
  (item.status === undefined || item.status === "completed");

const messageDigest = (item: Record<string, unknown>): string | undefined => {
  const content = item.content;
  if (typeof content === "string") return digest(content);
  if (
    !Array.isArray(content) ||
    !content.every((part) => isRecord(part) && typeof part.text === "string")
  )
    return undefined;
  return digest(content.map((part) => part.text).join(""));
};

const instructionBlocks = (item: unknown): string[] => {
  if (!isRecord(item)) return [];
  if (item.role === "developer" || item.role === "system")
    return [JSON.stringify([item.role, item.content])];
  if (item.role !== "user") return [];
  const parts = Array.isArray(item.content) ? item.content : [item.content];
  return parts.flatMap((part) => {
    const text = typeof part === "string" ? part : isRecord(part) ? part.text : undefined;
    if (typeof text !== "string") return [];
    return [
      ...text.matchAll(
        /^# AGENTS\.md instructions for [^\n]+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>|<environment_context>[\s\S]*?<\/environment_context>/gu,
      ),
    ].map((match) => JSON.stringify(["user", match[0]]));
  });
};

// Mutable files and remote URLs cannot prove that the bytes are the same on a later turn.
const visualPrefixDigest = (items: readonly unknown[]): string | undefined => {
  let hasImage = false;
  const hash = createHash("sha256");
  for (const item of items) {
    if (!isRecord(item)) return undefined;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (
        !isRecord(part) ||
        !["input_image", "image", "image_url", "localImage"].includes(String(part.type))
      )
        continue;
      if (
        part.type !== "input_image" ||
        typeof part.image_url !== "string" ||
        !/^data:image\/[\w.+-]+;base64,/iu.test(part.image_url)
      )
        return undefined;
      hasImage = true;
    }
    const serialized = JSON.stringify(item, (_field, value: unknown) => {
      if (typeof value === "string" && value.startsWith("data:image/")) return digest(value);
      if (isRecord(value))
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        );
      return value;
    });
    hash.update(serialized).update("\n");
  }
  return hasImage ? hash.digest("hex") : undefined;
};

interface DeliveredVisualEvidence {
  /** Native session identifier when supplied by the caller. */
  session?: string;
  /** Runtime identity, request constraints and active policy revision. */
  scope: string;
  /** Reader and writer assignments still approved on this request. */
  models: string;
  /** SHA-256 of the request prefix containing the original embedded image. */
  prefix: string;
  /** Number of items in that exact input prefix. */
  items: number;
  /** SHA-256 of the final answer actually delivered on this branch. */
  answer: string;
  /** Unmodified observations from the visual step. */
  facts: string;
  /** Absolute expiry retained across subsequent edits. */
  expires: number;
}

export const createResponseUsageLedger = () => {
  const visualAnswers = new Map<string, DeliveredVisualEvidence>();
  let visualExpiry: NodeJS.Timeout | undefined;
  const expireVisualAnswers = (): void => {
    clearTimeout(visualExpiry);
    let next = Infinity;
    const now = Date.now();
    for (const [id, entry] of visualAnswers) {
      if (visualAnswers.size > 128 || entry.expires <= now) visualAnswers.delete(id);
      else next = Math.min(next, entry.expires);
    }
    if (Number.isFinite(next)) visualExpiry = setTimeout(expireVisualAnswers, next - now).unref();
  };
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
    /** Binds a bounded observation to the original image, delivered answer and routing policy. */
    visualTurn: (input: unknown, scope: string, session?: string) => {
      const items: unknown[] = Array.isArray(input) ? input : [];
      let staged: { models: string; facts: string; expires: number } | undefined;
      let inherited: DeliveredVisualEvidence | undefined;
      const read = (models: string): string | undefined => {
        let position = items.length - 1;
        while (position >= 0 && !visualMessage(items[position])) position--;
        const prior = items[position];
        const followup = items.slice(position + 1);
        const firstUser = followup.findIndex((item) => isRecord(item) && item.role === "user");
        if (
          !visualMessage(prior) ||
          firstUser < 0 ||
          followup.some((item, index) => {
            if (!isRecord(item)) return true;
            if (
              index < firstUser &&
              (item.status === undefined || item.status === "completed") &&
              (item.type === "reasoning" ||
                (item.role === "assistant" &&
                  item.phase === "commentary" &&
                  messageDigest(item) !== undefined))
            )
              return false;
            return (
              !["user", "system", "developer"].includes(String(item.role)) ||
              (Array.isArray(item.content) &&
                item.content.some(
                  (part) => !isRecord(part) || !["input_text", "text"].includes(String(part.type)),
                ))
            );
          })
        )
          return undefined;
        const deliveredId = typeof prior.id === "string" ? prior.id : undefined;
        const candidates =
          deliveredId !== undefined
            ? [visualAnswers.get(deliveredId)]
            : session
              ? [...visualAnswers.values()]
              : [];
        const answer = messageDigest(prior);
        const matches = candidates.filter(
          (entry): entry is DeliveredVisualEvidence =>
            entry !== undefined &&
            entry.scope === scope &&
            entry.session === session &&
            entry.models === models &&
            entry.expires > Date.now() &&
            entry.answer === answer &&
            entry.items <= position &&
            items
              .slice(entry.items, position)
              .every(
                (item) =>
                  isRecord(item) &&
                  (item.type === "reasoning" ||
                    item.role === "system" ||
                    item.role === "developer" ||
                    (item.role === "assistant" && item.phase === "commentary")),
              ),
        );
        if (matches.length !== 1) return undefined;
        const entry = matches[0];
        if (!entry) return undefined;
        const prefix = items.slice(0, entry.items);
        if (visualPrefixDigest(prefix) !== entry.prefix) return undefined;
        const knownInstructions = new Set(prefix.flatMap(instructionBlocks));
        if (
          items
            .slice(entry.items)
            .flatMap(instructionBlocks)
            .some((block) => !knownInstructions.has(block))
        )
          return undefined;
        inherited = entry;
        return entry.facts;
      };
      return {
        read,
        stage: (models: string, facts: string): void => {
          if (facts && Buffer.byteLength(facts, "utf8") <= 8192 && !/data:image\//iu.test(facts))
            staged = {
              models,
              facts,
              expires: inherited?.facts === facts ? inherited.expires : Date.now() + 10 * 60_000,
            };
        },
        finish: (output: readonly Record<string, unknown>[]): void => {
          if (
            !staged ||
            staged.expires <= Date.now() ||
            output.some((item) => /call/u.test(String(item.type)))
          )
            return;
          const message = [...output].reverse().find(visualMessage);
          if (
            !message ||
            typeof message.id !== "string" ||
            !/^resp_[\da-f-]{36}_message$/iu.test(message.id)
          )
            return;
          const answer = messageDigest(message);
          const prefix = visualPrefixDigest(items);
          if (!answer || !prefix) return;
          visualAnswers.set(message.id, {
            ...staged,
            scope,
            ...(session ? { session } : {}),
            answer,
            prefix,
            items: items.length,
          });
          expireVisualAnswers();
        },
      };
    },
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

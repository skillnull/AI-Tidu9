import type { AgentHostId } from "../config/index.js";
import type { ProviderExecutionReceipt } from "../providers/index.js";

type ReportedUsage = NonNullable<ProviderExecutionReceipt["usage"]>;
type CallOutcome = "succeeded" | "failed" | "cancelled";

interface CallIdentity {
  /** Configured routing slot that supplied this provider. */
  modelId: string;
  /** Host that owns the adapter. */
  host: AgentHostId;
  /** Model configured for the slot; the host can resolve an alias at execution time. */
  model: string;
  /** Primary or secondary slot in the caller's configuration. */
  role: "main" | "secondary";
  /** Work assigned to the model on this invocation. */
  executionRole: ProviderExecutionReceipt["role"];
  /** Capabilities assigned to this invocation, in their original order. */
  capabilities: readonly string[];
}

const observedUsage = (usage: ReportedUsage) => {
  const { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteInputTokens } =
    usage;
  const uncached =
    cachedInputTokens !== undefined && cacheWriteInputTokens !== undefined
      ? inputTokens - cachedInputTokens - cacheWriteInputTokens
      : undefined;
  const fresh = usage.freshInputTokens ?? uncached;
  return {
    /** Gross input, including cache reads and writes accounted for by this host. */
    inputTokens,
    /** New input excluding cache reads and writes, when reported or derivable. */
    freshInputTokens: fresh !== undefined && fresh >= 0 && fresh <= inputTokens ? fresh : null,
    /** Cache reads included in gross input, or null if unreported. */
    cachedInputTokens: cachedInputTokens ?? null,
    /** Separately counted cache writes, or null if unreported. */
    cacheWriteInputTokens: cacheWriteInputTokens ?? null,
    /** Gross output, including reasoning. */
    outputTokens,
    /** Reasoning portion of output, or null if unreported. */
    reasoningTokens: usage.reasoningTokens ?? null,
    /** Total reported for the call. */
    totalTokens,
  };
};

interface ObservedCall extends CallIdentity {
  /** Upstream model confirmed by this execution, or null if unconfirmed. */
  executedModel: string | null;
  /** Terminal status of the adapter invocation. */
  outcome: CallOutcome;
  /** Latest reported usage for the call, or null when none was received. */
  usage: ReturnType<typeof observedUsage> | null;
}

/** Local history of one routed request, including repeated invocations of the same slot. */
export interface CallUsageObservation {
  /** Calls in dispatch order. Slots that never reached an adapter have no entry. */
  calls: readonly ObservedCall[];
  /** Sum of known totals; zero for no calls, null when all actual calls lack usage. */
  measuredTotalTokens: number | null;
  /** Whether every actual call reported its gross token total. */
  complete: boolean;
}

export const createCallUsageObserver = () => {
  const calls: (Omit<ObservedCall, "outcome"> & { outcome: CallOutcome | null })[] = [];
  return {
    start(identity: CallIdentity) {
      const call: (typeof calls)[number] = {
        ...identity,
        capabilities: [...identity.capabilities],
        executedModel: null,
        outcome: null,
        usage: null,
      };
      calls.push(call);
      return {
        attemptId: Symbol(),
        get executedModel() {
          return call.executedModel;
        },
        confirm(model: string | undefined) {
          if (model !== undefined && call.executedModel === null) call.executedModel = model;
        },
        receive(receipt: ProviderExecutionReceipt) {
          if (receipt.modelConfirmed !== false) call.executedModel = receipt.model;
          if (receipt.usage) call.usage = observedUsage(receipt.usage);
        },
        observeUsage(fallback: ReportedUsage | null) {
          if (
            fallback &&
            (call.usage?.totalTokens !== fallback.totalTokens ||
              call.usage.inputTokens !== fallback.inputTokens ||
              call.usage.outputTokens !== fallback.outputTokens)
          ) {
            call.usage = observedUsage(fallback);
            return true;
          }
          return false;
        },
        finish(outcome: CallOutcome) {
          call.outcome = outcome;
        },
      };
    },
    snapshot(requestOutcome: CallOutcome): CallUsageObservation {
      const reported = calls.flatMap((call) => (call.usage ? [call.usage.totalTokens] : []));
      return {
        calls: calls.map((call) => ({ ...call, outcome: call.outcome ?? requestOutcome })),
        measuredTotalTokens:
          calls.length > 0 && !reported.length
            ? null
            : reported.reduce((total, tokens) => total + tokens, 0),
        complete: calls.length === reported.length,
      };
    },
  };
};

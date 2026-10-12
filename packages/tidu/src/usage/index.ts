export const USAGE_CONTRACT_VERSION = "tidu-usage/1" as const;

export type UsageAuthority = "provider" | "host" | "estimated";

export interface TokenUsage {
  /** Input tokens reported or estimated for one request. */
  inputTokens: number;
  /** Output tokens reported or estimated for one request. */
  outputTokens: number;
  /** Total tokens; must equal inputTokens plus outputTokens. */
  totalTokens: number;
}

export interface UsageObservation {
  /** Contract version used to decode this observation. */
  contractVersion: typeof USAGE_CONTRACT_VERSION;
  /** Request identifier used to reconcile multiple observations. */
  requestId: string;
  /** Source authority; only provider data is official provider usage. */
  authority: UsageAuthority;
  /** Source-specific model identifier. */
  model: string;
  /** Token quantities when the source exposes them. */
  tokens: TokenUsage | null;
  /** Optional monetary amount in the source currency. */
  cost: { amount: number; currency: string } | null;
  /** ISO timestamp when this observation was captured. */
  observedAt: string;
}

const AUTHORITY_PRIORITY: Readonly<Record<UsageAuthority, number>> = {
  provider: 3,
  host: 2,
  estimated: 1,
};

const validateObservation = (observation: UsageObservation): void => {
  if (observation.requestId.trim() === "" || observation.model.trim() === "") {
    throw new Error("Usage observation request and model identifiers are required.");
  }
  if (
    observation.tokens !== null &&
    (!Number.isSafeInteger(observation.tokens.inputTokens) ||
      observation.tokens.inputTokens < 0 ||
      !Number.isSafeInteger(observation.tokens.outputTokens) ||
      observation.tokens.outputTokens < 0 ||
      observation.tokens.totalTokens !==
        observation.tokens.inputTokens + observation.tokens.outputTokens)
  ) {
    throw new Error("Usage token quantities are invalid.");
  }
  if (
    observation.cost !== null &&
    (!Number.isFinite(observation.cost.amount) ||
      observation.cost.amount < 0 ||
      !/^[A-Z]{3}$/u.test(observation.cost.currency))
  ) {
    throw new Error("Usage cost is invalid.");
  }
  if (Number.isNaN(Date.parse(observation.observedAt))) {
    throw new Error("Usage observation timestamp is invalid.");
  }
};

export const selectAuthoritativeUsage = (
  observations: readonly UsageObservation[],
): UsageObservation | undefined => {
  if (observations.length === 0) {
    return undefined;
  }
  for (const observation of observations) {
    validateObservation(observation);
  }
  const requestIds = new Set(observations.map((observation) => observation.requestId));
  if (requestIds.size !== 1) {
    throw new Error("Usage observations from different requests cannot be reconciled.");
  }

  return [...observations].sort((left, right) => {
    const authorityDifference =
      AUTHORITY_PRIORITY[right.authority] - AUTHORITY_PRIORITY[left.authority];
    return authorityDifference === 0
      ? Date.parse(right.observedAt) - Date.parse(left.observedAt)
      : authorityDifference;
  })[0];
};

export const describeUsageAuthority = (authority: UsageAuthority): string => {
  if (authority === "provider") {
    return "provider-authoritative";
  }
  if (authority === "host") {
    return "host-reported";
  }
  return "local-estimate";
};

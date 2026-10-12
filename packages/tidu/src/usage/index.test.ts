import assert from "node:assert/strict";
import test from "node:test";

import {
  describeUsageAuthority,
  selectAuthoritativeUsage,
  USAGE_CONTRACT_VERSION,
  type UsageObservation,
} from "./index.js";

const observation = (
  authority: UsageObservation["authority"],
  observedAt: string,
): UsageObservation => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  requestId: "request-usage-1",
  authority,
  model: "model-a",
  tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  cost: authority === "estimated" ? { amount: 0.001, currency: "USD" } : null,
  observedAt,
});

test("prefers provider-authoritative usage over newer estimates", () => {
  const selected = selectAuthoritativeUsage([
    observation("provider", "2026-10-12T09:00:00.000Z"),
    observation("estimated", "2026-10-12T09:01:00.000Z"),
  ]);

  assert.equal(selected?.authority, "provider");
  assert.equal(
    describeUsageAuthority(selected?.authority ?? "estimated"),
    "provider-authoritative",
  );
});

test("uses the latest observation when authorities match", () => {
  const selected = selectAuthoritativeUsage([
    observation("host", "2026-10-12T09:00:00.000Z"),
    observation("host", "2026-10-12T09:02:00.000Z"),
  ]);

  assert.equal(selected?.observedAt, "2026-10-12T09:02:00.000Z");
});

test("rejects invalid totals and cross-request reconciliation", () => {
  assert.throws(
    () =>
      selectAuthoritativeUsage([
        {
          ...observation("estimated", "2026-10-12T09:00:00.000Z"),
          tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 20 },
        },
      ]),
    /quantities/u,
  );
  assert.throws(
    () =>
      selectAuthoritativeUsage([
        observation("host", "2026-10-12T09:00:00.000Z"),
        { ...observation("provider", "2026-10-12T09:01:00.000Z"), requestId: "other" },
      ]),
    /different requests/u,
  );
});

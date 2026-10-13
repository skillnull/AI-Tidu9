import assert from "node:assert/strict";
import test from "node:test";

import {
  assessReleaseCandidate,
  formatReleaseCandidateAssessment,
  type ReleaseCandidateEvidence,
} from "./index.js";

const automatedGateIds = [
  "client-regression",
  "upgrade-paths",
  "rollback",
  "security-privacy",
  "public-file-privacy",
  "bilingual-documentation",
  "compatibility-matrix",
  "release-candidate-suite",
] as const;

const createEvidence = (): ReleaseCandidateEvidence[] => [
  ...automatedGateIds.map((gateId) => ({
    gateId,
    kind: "automated" as const,
    status: "passed" as const,
    source: "quality-workflow",
    recordedAt: "2026-10-13T08:00:00.000Z",
    summary: `${gateId} passed.`,
  })),
  {
    gateId: "local-dogfooding",
    kind: "manual",
    status: "passed",
    source: "dogfood-review",
    recordedAt: "2026-10-13T08:00:00.000Z",
    summary: "Reviewed local usage evidence passed.",
  },
  {
    gateId: "team-enterprise-pilot",
    kind: "manual",
    status: "passed",
    source: "pilot-review",
    recordedAt: "2026-10-13T08:00:00.000Z",
    summary: "Reviewed pilot evidence passed.",
  },
  {
    gateId: "local-sharing-materials",
    kind: "manual",
    status: "passed",
    source: "local-material-review",
    recordedAt: "2026-10-13T08:00:00.000Z",
    summary: "Local-only materials were reviewed outside the repository.",
  },
];

test("requires every automated and reviewed manual gate before an RC is ready", () => {
  const assessment = assessReleaseCandidate({
    version: "0.9.0-rc.1",
    evidence: createEvidence(),
    defects: { blocker: 0, critical: 0 },
    featureFreeze: true,
  });

  assert.equal(assessment.ready, true);
  assert.equal(assessment.passedGateCount, assessment.totalGateCount);
  assert.match(formatReleaseCandidateAssessment(assessment), /ready for explicit release/u);
});

test("does not let automation impersonate long-term use or pilot review", () => {
  const evidence = createEvidence().map((item) =>
    item.gateId === "team-enterprise-pilot" ? { ...item, kind: "automated" as const } : item,
  );
  const assessment = assessReleaseCandidate({
    version: "0.9.0-rc.1",
    evidence,
    defects: { blocker: 0, critical: 0 },
    featureFreeze: true,
  });

  assert.equal(assessment.ready, false);
  assert.deepEqual(
    assessment.gates.find((gate) => gate.gateId === "team-enterprise-pilot")?.status,
    "failed",
  );
});

test("blocks readiness while severe defects remain or feature development is open", () => {
  const assessment = assessReleaseCandidate({
    version: "0.9.0-rc.1",
    evidence: createEvidence(),
    defects: { blocker: 1, critical: 2 },
    featureFreeze: false,
  });

  assert.equal(assessment.ready, false);
  assert.equal(assessment.gates.find((gate) => gate.gateId === "defect-review")?.status, "failed");
  assert.equal(
    assessment.gates.find((gate) => gate.gateId === "feature-freeze")?.status,
    "pending",
  );
});

test("rejects invalid candidate versions and malformed evidence", () => {
  assert.throws(
    () =>
      assessReleaseCandidate({
        version: "1.0.0",
        evidence: [],
        defects: { blocker: 0, critical: 0 },
        featureFreeze: true,
      }),
    /0\.9\.0-rc\.N/u,
  );
  assert.throws(
    () =>
      assessReleaseCandidate({
        version: "0.9.0-rc.1",
        evidence: [{ ...createEvidence()[0], source: "" } as ReleaseCandidateEvidence],
        defects: { blocker: 0, critical: 0 },
        featureFreeze: true,
      }),
    /source and summary/u,
  );
});

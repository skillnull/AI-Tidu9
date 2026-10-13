export const RELEASE_CANDIDATE_QUALIFICATION_VERSION = "1.0.0";

export type ReleaseCandidateGateId =
  | "local-dogfooding"
  | "client-regression"
  | "team-enterprise-pilot"
  | "defect-review"
  | "upgrade-paths"
  | "rollback"
  | "security-privacy"
  | "public-file-privacy"
  | "bilingual-documentation"
  | "local-sharing-materials"
  | "compatibility-matrix"
  | "feature-freeze"
  | "release-candidate-suite";

export type ReleaseCandidateEvidenceKind = "automated" | "manual";
export type ReleaseCandidateGateStatus = "passed" | "failed" | "pending";

export interface ReleaseCandidateEvidence {
  /** Stable release-candidate gate identifier. */
  gateId: ReleaseCandidateGateId;
  /** Whether the evidence came from automation or reviewed real-world use. */
  kind: ReleaseCandidateEvidenceKind;
  /** Gate outcome represented by this evidence record. */
  status: Exclude<ReleaseCandidateGateStatus, "pending">;
  /** Non-sensitive evidence source, such as a workflow name or review identifier. */
  source: string;
  /** ISO-8601 time when the evidence was produced. */
  recordedAt: string;
  /** Concise non-sensitive result summary. */
  summary: string;
}

export interface ReleaseCandidateDefectCounts {
  /** Unresolved defects that prevent the product from operating. */
  blocker: number;
  /** Unresolved defects with critical security, data, or reliability impact. */
  critical: number;
}

export interface ReleaseCandidateAssessmentInput {
  /** Candidate version being assessed. */
  version: string;
  /** Evidence gathered by repeatable checks and reviewed real-world use. */
  evidence: readonly ReleaseCandidateEvidence[];
  /** Current unresolved severe-defect counts. */
  defects: ReleaseCandidateDefectCounts;
  /** Whether large feature development is frozen for the candidate. */
  featureFreeze: boolean;
}

export interface ReleaseCandidateGateResult {
  /** Stable release-candidate gate identifier. */
  gateId: ReleaseCandidateGateId;
  /** Required evidence origin for this gate. */
  requiredKind: ReleaseCandidateEvidenceKind;
  /** Effective gate state. */
  status: ReleaseCandidateGateStatus;
  /** Non-sensitive evidence source, or null when evidence is missing. */
  source: string | null;
  /** Concise assessment detail. */
  detail: string;
}

export interface ReleaseCandidateAssessment {
  /** Qualification contract version. */
  contractVersion: string;
  /** Candidate version being assessed. */
  version: string;
  /** Whether every automated and manual release gate has passed. */
  ready: boolean;
  /** Ordered result for every required gate. */
  gates: readonly ReleaseCandidateGateResult[];
  /** Number of passed gates. */
  passedGateCount: number;
  /** Total number of required gates. */
  totalGateCount: number;
}

interface ReleaseCandidateGateDefinition {
  gateId: ReleaseCandidateGateId;
  requiredKind: ReleaseCandidateEvidenceKind;
}

const GATE_DEFINITIONS: readonly ReleaseCandidateGateDefinition[] = Object.freeze([
  { gateId: "local-dogfooding", requiredKind: "manual" },
  { gateId: "client-regression", requiredKind: "automated" },
  { gateId: "team-enterprise-pilot", requiredKind: "manual" },
  { gateId: "defect-review", requiredKind: "automated" },
  { gateId: "upgrade-paths", requiredKind: "automated" },
  { gateId: "rollback", requiredKind: "automated" },
  { gateId: "security-privacy", requiredKind: "automated" },
  { gateId: "public-file-privacy", requiredKind: "automated" },
  { gateId: "bilingual-documentation", requiredKind: "automated" },
  { gateId: "local-sharing-materials", requiredKind: "manual" },
  { gateId: "compatibility-matrix", requiredKind: "automated" },
  { gateId: "feature-freeze", requiredKind: "automated" },
  { gateId: "release-candidate-suite", requiredKind: "automated" },
]);

const assertCount = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
};

const validateEvidence = (evidence: ReleaseCandidateEvidence): void => {
  if (evidence.source.trim() === "" || evidence.summary.trim() === "") {
    throw new Error("Release-candidate evidence requires a source and summary.");
  }
  if (Number.isNaN(Date.parse(evidence.recordedAt))) {
    throw new Error("Release-candidate evidence recordedAt must be ISO-8601 compatible.");
  }
};

export const assessReleaseCandidate = (
  input: ReleaseCandidateAssessmentInput,
): ReleaseCandidateAssessment => {
  if (!/^0\.9\.0-rc\.[1-9]\d*$/u.test(input.version)) {
    throw new Error("Integrated release candidates must use 0.9.0-rc.N versions.");
  }
  assertCount(input.defects.blocker, "defects.blocker");
  assertCount(input.defects.critical, "defects.critical");
  input.evidence.forEach(validateEvidence);

  const latestEvidence = new Map<ReleaseCandidateGateId, ReleaseCandidateEvidence>();
  for (const evidence of input.evidence) {
    const existing = latestEvidence.get(evidence.gateId);
    if (
      existing === undefined ||
      Date.parse(existing.recordedAt) < Date.parse(evidence.recordedAt)
    ) {
      latestEvidence.set(evidence.gateId, evidence);
    }
  }

  const gates = GATE_DEFINITIONS.map((definition): ReleaseCandidateGateResult => {
    if (definition.gateId === "feature-freeze") {
      return {
        ...definition,
        status: input.featureFreeze ? "passed" : "pending",
        source: "release-policy",
        detail: input.featureFreeze
          ? "Large feature development is frozen."
          : "Large feature development is not frozen.",
      };
    }
    if (definition.gateId === "defect-review") {
      const passed = input.defects.blocker === 0 && input.defects.critical === 0;
      return {
        ...definition,
        status: passed ? "passed" : "failed",
        source: "defect-review",
        detail: `${input.defects.blocker} blocker and ${input.defects.critical} critical defects remain.`,
      };
    }

    const evidence = latestEvidence.get(definition.gateId);
    if (evidence === undefined) {
      return {
        ...definition,
        status: "pending",
        source: null,
        detail: `Missing ${definition.requiredKind} evidence.`,
      };
    }
    if (evidence.kind !== definition.requiredKind) {
      return {
        ...definition,
        status: "failed",
        source: evidence.source,
        detail: `Expected ${definition.requiredKind} evidence but received ${evidence.kind}.`,
      };
    }
    return {
      ...definition,
      status: evidence.status,
      source: evidence.source,
      detail: evidence.summary,
    };
  });
  const passedGateCount = gates.filter((gate) => gate.status === "passed").length;
  return {
    contractVersion: RELEASE_CANDIDATE_QUALIFICATION_VERSION,
    version: input.version,
    ready: passedGateCount === gates.length,
    gates,
    passedGateCount,
    totalGateCount: gates.length,
  };
};

export const formatReleaseCandidateAssessment = (
  assessment: ReleaseCandidateAssessment,
): string => {
  const lines = assessment.gates.map((gate) => {
    const marker = gate.status === "passed" ? "PASS" : gate.status === "failed" ? "FAIL" : "WAIT";
    return `[${marker}] ${gate.gateId}: ${gate.detail}`;
  });
  return [
    `AI-Tidu9 ${assessment.version} release-candidate qualification`,
    ...lines,
    `${assessment.passedGateCount}/${assessment.totalGateCount} gates passed.`,
    assessment.ready
      ? "Candidate is ready for explicit release confirmation."
      : "Candidate is not ready; missing or failed gates cannot be overridden silently.",
  ].join("\n");
};

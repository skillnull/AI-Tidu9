import {
  CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  type CapabilityProviderManifest,
  createProviderIntegrity,
  defineCapabilityProvider,
  testCapabilityProvider,
} from "./index.js";

const unsignedManifest: CapabilityProviderManifest = {
  id: "company.example-reviewer",
  name: "Example review provider",
  version: "1.0.0",
  protocolVersion: CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  kind: "agent",
  source: "enterprise",
  capabilities: ["code.review"],
  permissions: ["agent.delegate"],
  trust: "trusted",
};

export const exampleReviewProvider = defineCapabilityProvider({
  manifest: { ...unsignedManifest, integrity: createProviderIntegrity(unsignedManifest) },
  invoke: async ({ input }) => ({
    output: { accepted: true, input },
    evidence: ["example-review-complete"],
  }),
});

export const verifyExampleReviewProvider = () =>
  testCapabilityProvider(exampleReviewProvider, {
    operation: "agent.delegate",
    input: { goal: "Review a bounded change" },
    timeoutMs: 2_000,
    maximumOutputBytes: 16_384,
  });

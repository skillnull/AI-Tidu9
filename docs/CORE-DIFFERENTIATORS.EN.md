# Core Routing and Secret Gate

[README](./README.EN.md) · [Examples](./EXAMPLES.EN.md) · [Architecture](./ARCHITECTURE.EN.md) · [CLI](./CLI-REFERENCE.EN.md) · [简体中文](./CORE-DIFFERENTIATORS.md)

AI-Tidu9 is not valuable because it "calls another model." Its job is to answer four engineering questions around every call: **who should do the work, what capability is missing, what must not leave the boundary, and what proves completion.**

## 🔎 Filter before scoring

`createDynamicModelRouter(models, policy)` receives model adapters and non-sensitive metadata. It derives required capabilities from protocol, declared tools, structured output, long textual input, image input, and caller constraints. Disabled, capability-incompatible, protocol-incompatible, privacy-incompatible, and currently unavailable models are removed before comparison. Observed token use is compared only after applying known prices; an unknown price cannot justify a lower-cost replacement. A `429` or explicit provider failure updates process-local availability observations and triggers rerouting. Unintegrated remaining-quota data does not drive a pre-emptive replacement.

Privacy and required capabilities are admission criteria. A low price or low latency can never compensate for violating either boundary.

## 🧩 Secondary models do more than fill capability gaps

Capability completion is opt-in. The configuration declares whether it is enabled, which model IDs may enter the specialist pool, the maximum specialist count, and task-level spend, time, privacy, and output bounds.

When the preferred primary lacks a required capability, a secondary receives only the minimum input for that gap and returns bounded evidence to the primary. When a secondary covers every required capability and comparable evidence shows lower price-backed token cost, tighter verifiable privacy, lower observed latency, or higher availability, it may execute the request directly and avoid an unnecessary serial call. A `429` and explicit failures also trigger fallback among fully capable candidates. Only a model with an explicit zero price participates as zero-cost; local providers such as Ollama can contribute verifiable `local` privacy metadata.

Ordinary `/v1` inference follows a single-model fast path by default. The kernel records request parsing, capability confirmation, dynamic routing, model execution, output receipt, and completeness checking while forwarding real output deltas directly to the client. It does not add fixed goal-decomposition or independent semantic-acceptance calls to every request, and progress text is not presented as hidden model reasoning. The full task flow can still perform planning, checkpoints, and independent business acceptance when explicitly required.

## 🧰 Assemble capability assets on demand

`createCapabilityRegistry` describes Agents, Skills, MCP servers, tools, and knowledge through one contract. After understanding the goal, the kernel selects the smallest set compatible with capability, cost, permission, and privacy constraints. Discovery reads bounded metadata only; it never executes extensions or follows symbolic links. Missing required capabilities fail before execution.

A capability catalog describes what an adapter can actually execute, not every feature in the underlying host product. The current Codex and Cursor host bridges do not advertise image input, web research, or tool use until those bridge paths exist. A request requiring one of those capabilities fails closed before execution.

## 🔐 Restore secrets only at the real execution boundary

The Runtime Secret Gate detects common credential forms and supports explicit block or local-replacement rules. Each task receives an isolated in-memory scope with capacity and lifetime limits. External models and tools see placeholders. Only a trusted tool marked `executionLocation: "local"` can restore a value inside the same task scope, and completion or cancellation destroys the mapping.

Automatic detection is defense in depth, not a promise to identify every unknown secret. High-sensitivity environments still need explicit policy, network egress controls, supplier agreements, and endpoint management. Custom code that bypasses the AI-Tidu9 runtime is outside the gate.

## 📊 Reproducible cost and capability evidence

The repository test `routing/index.test.ts` runs the documented low-cost-main plus vision-specialist chain. The main model handles text and structured output; the specialist supplies only image capability; the main model receives that evidence and produces the final result.

| Route | Configured input + output price per million tokens | Calls | Capabilities |
| --- | ---: | ---: | --- |
| Low-cost main | 0.30 | 1 | Text, structured output |
| Vision specialist | 0.30 | 1 | Text, vision |
| **Combined** | **0.60** | **2** | **Text, structured output, vision** |

The same test verifies explicit specialist selection, evidence injection, privacy filtering, zero-cost local selection, and fallback after `429`. The `0.60` value is a routing estimate derived from configured prices, not a provider invoice. Production settlement uses provider-authoritative usage.

## ⚙️ Minimal viable configuration

```ts
const router = createDynamicModelRouter(
  [cheapMain, visionSpecialist, localFallback],
  {
    enabled: true,
    mainModelId: "cheap-main",
    weights: { capability: 5, cost: 3, privacy: 2, latency: 1, availability: 2 },
    capabilityCompletion: {
      enabled: true,
      poolModelIds: ["vision-specialist", "local-fallback"],
      maximumSpecialists: 2,
    },
  },
);

await startLocalRuntime({ provider: router });
```

Configuration stores model IDs and non-sensitive routing metadata only. Provider credentials remain with adapters at runtime and never enter routing decisions, diagnostics, or task capsules.

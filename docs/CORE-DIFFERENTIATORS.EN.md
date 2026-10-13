# Core Routing and Secret Gate

[README](./README.EN.md) · [Examples](./EXAMPLES.EN.md) · [Architecture](./ARCHITECTURE.EN.md) · [CLI](./CLI-REFERENCE.EN.md) · [简体中文](./CORE-DIFFERENTIATORS.md)

AI-Tidu9 is not valuable because it "calls another model." Its job is to answer four engineering questions around every call: **who should do the work, what capability is missing, what must not leave the boundary, and what proves completion.**

## 🔎 Filter before scoring

`createDynamicModelRouter(models, policy)` receives model adapters and non-sensitive metadata. It derives required capabilities from protocol, tools, structured output, image input, and caller constraints. Disabled, quota-exhausted, protocol-incompatible, and privacy-incompatible models are removed before capability, cost, privacy, latency, and availability are scored. A `429` marks process-local quota exhaustion and triggers rerouting.

Privacy and required capabilities are admission criteria. A low price or low latency can never compensate for violating either boundary.

## 🧩 Complete only the missing capability

Capability completion is opt-in. The configuration declares whether it is enabled, which model IDs may enter the specialist pool, the maximum specialist count, and task-level spend, time, privacy, and output bounds.

A specialist never takes over the full conversation. It receives the minimum input required for the missing capability and returns bounded evidence to the main model. Zero-cost and local models participate through the same metadata contract.

## 🧰 Assemble capability assets on demand

`createCapabilityRegistry` describes Agents, Skills, MCP servers, tools, and knowledge through one contract. After understanding the goal, the kernel selects the smallest set compatible with capability, cost, permission, and privacy constraints. Discovery reads bounded metadata only; it never executes extensions or follows symbolic links. Missing required capabilities fail before execution.

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

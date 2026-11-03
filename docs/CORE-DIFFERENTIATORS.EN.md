# Core Routing and Secret Gate

[README](./README.EN.md) · [Examples](./EXAMPLES.EN.md) · [Architecture](./ARCHITECTURE.EN.md) · [CLI](./CLI-REFERENCE.EN.md) · [简体中文](./CORE-DIFFERENTIATORS.md)

AI-Tidu9 is not valuable because it "calls another model." Its job is to answer four engineering questions around every call: **who should do the work, what capability is missing, what must not leave the boundary, and what proves completion.**

## 🔎 Filter before scoring

`createDynamicModelRouter(models, policy)` receives model adapters and non-sensitive metadata. It derives required capabilities from protocol, declared tools, structured output, long textual input, image input, and caller constraints. Disabled, capability-incompatible, protocol-incompatible, privacy-incompatible, and currently unavailable models are removed before comparison. Observed token use is compared only after applying known prices; an unknown price cannot justify a lower-cost replacement. A `429` or explicit provider failure updates process-local availability observations and triggers rerouting. An ordinary client error from an alternate also causes the configured Official primary to be tried before termination; any uncovered capability is supplied as limitation context rather than claimed as completed. Unintegrated remaining-quota data does not drive a pre-emptive replacement.

Privacy and required capabilities are admission criteria. A low price or low latency can never compensate for violating either boundary.

## 🧩 Secondary models do more than fill capability gaps

Capability completion is opt-in. The configuration declares whether it is enabled, which model IDs may enter the specialist pool, the maximum specialist count, and task-level spend, time, privacy, and output bounds.

When the preferred primary lacks a required capability, a secondary receives only the minimum input for that gap and returns bounded evidence to the model responsible for the final result. A model may be assigned zero capabilities and then does not execute. If the primary owns none of the required capabilities and a secondary covers all of them, only that secondary executes. If the union still leaves a gap, routing fails closed before calling any model. A fully capable secondary may also execute directly when comparable evidence shows lower price-backed token cost, tighter verifiable privacy, lower observed latency, or higher availability. A `429` and explicit failures trigger fallback among fully capable candidates. Only a model with an explicit zero price participates as zero-cost; local providers such as Ollama can contribute verifiable `local` privacy metadata.

Ordinary `/v1` inference follows a single-model fast path by default. The kernel records request parsing, capability confirmation, dynamic routing, model execution, output receipt, and completeness checking. Streaming preserves the caller protocol and native host event boundaries; public progress, `reasoning`, `commentary`, commands, file changes, tool calls, and terminal events come from actual official events without placeholder progress or a routing summary. Successful and cancelled AI-Tidu9 turns show token usage. The main execution is labeled only with its factual host name, and a secondary label appears only for real cross-host work. Official turns receive no AI-Tidu9 token text, and failures retain only the failed protocol terminal and readable upstream reason. The relay reads bounded official-history evidence, scopes recovery by each turn's Provider, and restores cancelled AI-Tidu9 commands, tokens, and elapsed time without rewriting or copying the conversation. Switching modes uses official `thread/resume` to apply the current Provider and model on the same thread ID, so the next turn follows the current mode and completed turns stay unchanged. Cross-Provider history removes private encrypted and compaction items while preserving public messages, summaries, and tool results. Request and stream retries retain Codex's native recovery behavior. Model execution has no AI-Tidu9-local deadline; cancelling a secondary remains terminal, while a failed secondary reroutes and tries the Official primary before termination with any missing capability made explicit. History keeps configured models separate from host receipts. The full task flow can still perform planning, checkpoints, and independent business acceptance when explicitly required.

## 🧰 Assemble capability assets on demand

`createCapabilityRegistry` describes Agents, Skills, MCP servers, tools, and knowledge through one contract. After understanding the goal, the kernel selects the smallest set compatible with capability, cost, permission, and privacy constraints. Discovery reads bounded metadata only; it never executes extensions or follows symbolic links. Missing required capabilities fail before execution.

A capability catalog describes what an adapter can actually execute. The Codex bridge now forwards text, remote images, local images, and official Responses history items natively, while reusing app-server reasoning, command, file, search, and tool capabilities. Its catalog therefore publishes the complete verified Codex bridge set; other hosts remain limited to their own verified protocols.

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

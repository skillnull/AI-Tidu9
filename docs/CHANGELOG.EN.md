# Changelog

[README](./README.EN.md) · [Contribution and release rules](./CONTRIBUTING.EN.md) · [简体中文](./CHANGELOG.md)

This file records user-visible changes in every public AI-Tidu9 release. Compatibility, migration, and rollback information stays with the relevant version, and historical entries remain immutable.

> [!TIP]
> “Unreleased” tracks the next version; the newest version heading describes the current published capability.

## Unreleased

- Remove Git operations from model routing entirely. Explicit Git requests for status, diffs, logs, branches, staging, commits, pulls, pushes, and related commands now execute through the local Git binary without calling any model. A standalone commit checks the worktree first; a clean tree returns `No changes to commit.` immediately, while pending changes run the repository-defined `npm run check`, staging, Git hooks, and the commit itself. Any failed validation or script blocks the commit and returns the failure.
- Restore Codex-native expandable progress and multimodal input by preserving real host reasoning summaries, phase messages, commands, file changes, web searches, tool calls, and context compaction. Even a simple answer with no additional progress text keeps the full duration and completion lifecycle. Text, remote images, local images, and history items use the official app-server types instead of a custom flattened prompt. Remove the automatically injected AI-Tidu9 routing instruction so `[AI-TIDU9] Loaded` is no longer shown unconditionally. Completed and cancelled tasks are deleted after their terminal result is returned, while failed, paused, and approval-gated tasks remain recoverable. Task cards show their creation time and cap long content, which can be opened in a dialog for full inspection. The task tab now includes a compact purpose and controls guide without a redundant success notice.
- Fix streaming flow and terminal presentation by preserving the caller's protocol and the host's native event boundaries. Every real phase and progress paragraph now becomes an independent Responses `commentary` message item instead of downgrading and merging different event types into one reasoning text, so Codex renders progress downward in occurrence order. The completed response retains those items, creation and completion timestamps, and provider-reported token usage, allowing the top processing duration to remain expandable and the answer footer to show real tokens. For text-only Cursor requests, ACP confirms the configured model before the same official Agent CLI executes its equivalent headless model in read-only `ask` mode through `stream-json`, returning progress and tokens; image requests retain the ACP multimodal path. Host adapters dynamically translate public progress, answer, and terminal events from negotiated capabilities and the official events actually received; a newly introduced message phase is not rejected or dropped merely because a closed local enum has not been updated. Generic OpenAI clients still receive Responses or Chat Completions events. The final answer remains the host's exact text and no longer receives a private AI-Tidu9 execution summary. Complete with the standard terminal sequence for the active protocol. Label the managed model `AI-Tidu9` and its local Provider `AI-Tidu9 (local)`, align the capability catalog with official image, original-detail, reasoning-tier, shell, patch, tool, and search support, and disable request and stream retries so an unavailable service does not produce repeated `Reconnecting` cycles. Remove AI-Tidu9-local model-execution timeouts and wait for the official host to report completion, failure, or cancellation. If a secondary responsible for a required capability officially fails or is cancelled, fail the request closed instead of presenting an incapable primary as successful. Send visible error text together with the failed terminal event, and show configured models separately from host execution receipts in history. Also correct local-file capability inference, primary/secondary completion, and missing-capability guidance.
- Allow primary or secondary models to have no assigned capabilities, and execute each model only for capabilities explicitly assigned to it. Multi-capability requests are split by those assignments—for example, a secondary may handle `text` while the primary still handles its assigned non-text capabilities. Mixed-capability execution shares preceding models' visible progress and completed results in order, then lets the model assigned `text` produce the final answer; text-only requests still call only the `text` owner. A fully covering secondary executes alone when the primary owns none of the required capabilities, while an uncovered union fails closed before any call. Add a combination regression across all 65,536 primary/secondary assignments for the eight routing capabilities.
- Forward additional command-line arguments from the root `publish:tidu` workspace command so the documented `npm run publish:tidu -- --dry-run` path actually runs the read-only release validation.

## 1.1.1 - 2026-10-21

- Correct capability provenance and display. Primary and secondary models now show only capabilities returned by the host model catalog and supported by the routing contract, selecting that verified set by default. Cursor models on the same host are differentiated by ACP reasoning and context parameters. Model changes refresh capabilities and stale out-of-catalog selections are removed. Cursor model selectors show the ACP-published name while retaining the original parameterized ID for execution and persistence; secondary-model cards no longer repeat the selected model or reserve an empty column.
- Handle the JSON-RPC race where a child closes standard input before a write. The connection now fails explicitly, rejects pending requests, and reaps the child instead of emitting an unhandled `EPIPE`.
- Harden the release gate. Both the release commit and immutable Tag must pass remote `Quality`; any failure stops the flow before npm publication instead of allowing a locally non-reproduced failure into a published version.

## 1.1.0 - 2026-10-20

- Replace Codex MCP registration with mutually exclusive native Provider modes: Official restores the exact original configuration, while AI-Tidu9 shows only “九门赛博提督.” Codex, Cursor, CLI, and OpenAI-compatible entries share one execution kernel. Ordinary `/v1` inference uses the single-model fast path; explicit planning and business acceptance remain in the full task flow. Ollama discovery reads the local catalog directly.
- Fix capability-completion persistence and display. A new secondary defaults to every capability published by its Provider, and later edits persist the exact selected set. Save and continue saves before advancing and stays on the step after failure; a saved draft still requires explicit activation.
- Extend secondary routing beyond capability gaps. It can use price-backed observed usage, verifiable privacy, observed latency, availability, and explicit failures. Unknown prices and quota data that is not integrated do not drive replacement.
- Stream real execution progress and model-output deltas. A response ends explicitly as completed or failed instead of remaining on one generic “thinking” state; progress events are not presented as hidden model chain of thought.
- Tighten the Codex and Cursor host-bridge catalogs. Unimplemented image input, web research, and tool use are no longer advertised. Requests that require them fail closed instead of silently degrading to text-only execution.
- Show global effort only when Codex forwards it to the host. Hosts such as Cursor no longer expose an ineffective global switch. Raw parameterized Cursor model IDs are preserved and executed exactly as returned by the host.
- Remove the silent direct-provider fallback after Agent failure. Provider, ACP, and streaming errors now return an explicit terminal state instead of presenting success without a result.
- Standardize installation guidance on switching to Node.js 22.14+ before globally installing and using the `tidu` command; no longer describe the temporary `npx` download as installation-free.
- Check the runtime version before loading SQLite and other Node.js 22 capabilities, so older Node versions receive clear bilingual upgrade guidance instead of a missing `node:sqlite` error.
- Add `npm run tidu:dev-p`, `npm run tidu:dev-e`, and matching CLI commands for complete personal and enterprise development runtimes, UI hot updates, automatic backend rebuilds and restarts, and isolated development data.

## 1.0.0 - 2026-10-13

- Rebuild the public documentation system with separate language files, semantic icons and outcome-oriented primary headings, real tertiary headings for procedural steps, a clear installation and first-run path, role-based navigation, synchronized diagrams, explicit trust and failure semantics, task-oriented CLI and SDK guidance, and a reviewable contribution flow.
- Add verified end-to-end examples for local Ollama, OpenAI-compatible providers, generic clients, Codex and Cursor connectors, enterprise Docker pilots, Provider SDKs, Python invocation, and Secret Gate integration.
- Add side-effect-free `--help` coverage for every CLI command group, a complete bilingual CLI reference, a five-step web setup wizard, and `tidu start --cli` guided terminal setup.
- Add privacy-safe `tidu doctor --json` diagnostics, bilingual structured issue forms, and a time-bounded maintenance policy that can reach stable release even when a public observation window receives no feedback.
- Remove the temporary roadmap, one-off verification command, and planning-only API now that the project has entered real-world use and continuous maintenance.

## 0.9.0-rc.1 - 2026-10-13

- Make `tidu uninstall` the single complete-removal flow for AI-Tidu9-owned connectors, managed client artifacts, data, snapshots, and global npm installation while preserving unrelated host state.
- Stop enterprise servers from running setup on employee computers; employees now enter the company URL in their installed personal edition, where company configuration is stored separately and shown read-only.

## 0.8.0-beta.1 - 2026-10-13

- Add Capability Provider Protocol 1.0 with typed model, Agent, client, storage, and history adapters; explicit permission manifests; integrity, Ed25519 signature, dependency, and version verification; and enterprise, local, and official catalogs.
- Add bounded Skill and MCP discovery, fail-closed untrusted-extension isolation contracts, bounded third-party Agent delegation, extension test tooling, examples, and a real runtime Provider API.
- Publish the TypeScript ecosystem SDK through `@skillnull/tidu/ecosystem` and add a zero-runtime-dependency Python SDK with synchronized npm, connector, and Python release metadata.
- Add bilingual ecosystem and migration guidance, including the rule that Node `vm` and ordinary Workers are not security sandboxes and that untrusted execution requires external isolation attestation.

## 0.7.0-rc.1 - 2026-10-13

- Add the production-scaling core with stateless gateways, one logical scheduler, horizontally scalable workers, tenant-safe admission, backpressure, fair scheduling, leases, checkpoints, and PostgreSQL compare-and-swap task persistence.
- Add bounded payload, memory, scratch, and streaming controls; provider circuit breakers and failover; metrics-first content-free diagnostics; health alerts; drain-first rolling upgrades; and rollback.
- Add reproducible load and fault-injection coverage for 1,000 concurrent tasks across 10 tenants and 10 workers, including lease-expiry recovery and PostgreSQL storage behavior.

## 0.6.0-beta.1 - 2026-10-13

- Add the enterprise control plane with PostgreSQL CAS persistence, tenant-to-user scopes, inherited mandatory/advisory policy, identity roles, a private capability catalog, mixed enterprise/user model resources, and generated administrator and employee guidance.
- Add hierarchical quota pools with idempotent atomic reservation, settlement, release, reconciliation, and end-of-cycle allocation sharing; add bounded private artifact storage and staged personal-to-enterprise enrollment preflight.
- Add one-time administrator keys with scrypt verifiers, constant-time authentication, short-lived session revocation, enterprise administration views, and a PostgreSQL-backed Docker single-host deployment.

## 0.5.0-beta.1 - 2026-10-13

- Complete the personal experience with one-click Chinese/English and Normal/Expert UI switching, isolated drafts, impact simulation, explicit activation, known-good history, automatic health rollback, and manual recovery.
- Add host, bounded portable, and incognito history policies; personal budget views; immutable account-snapshot attribution; loopback local-model setup; and validated Agent/Skill/MCP/tool extension installation.
- Add authenticated AES-256-GCM configuration import/export with scrypt key derivation, excluding credentials and conversation content and importing into inactive isolated drafts only.

## 0.4.0-beta.1 - 2026-10-13

- Add configurable dynamic model routing across capability, cost, privacy, latency, availability, quota, and enabled-state signals, including bounded specialist-model capability completion and `429` fallback.
- Add one capability registry that assembles Agent, Skill, MCP, tool, and knowledge assets before planning and fails closed when required capabilities are unavailable.
- Enable the Runtime Secret Gate by default for standard model and Agent tool boundaries, with automatic detection, explicit block/redact rules, isolated in-memory placeholders, and local-only recovery.
- Publish bilingual architecture guidance, security limitations, and a reproducible cheap-main plus specialist cost and capability-completion case.
- Expand the package suite to 104 passing tests and keep the npm artifact below 1 MB unpacked without adding runtime dependencies.

## 0.3.0-alpha.1 - 2026-10-12

- Adopt a lockfile-free library workspace with exact direct dependencies, fresh CI resolution, and release tooling that no longer couples package versions to `package-lock.json`.
- Unify Node.js selection across installation, development commands, release tooling, and Git hooks, with automatic discovery through NVM, Homebrew, fnm, mise, asdf, and Volta.
- Synchronize the npm package and bundled Codex connector manifest versions in one atomic release transaction.
- Keep npm `latest` aligned with the newest public prerelease until the first stable version exists, while preserving independent `alpha`, `beta`, and `rc` channel tags.
- Add the versioned canonical task aggregate and append-only Agent event envelope with normalized goals, acceptance criteria, lifecycle status, task-local ordering, non-sensitive sources, timestamps, and strict boundary validation.
- Add the independent bounded Agent kernel with model-driven understanding, planning and replanning, deterministic execution budgets, tool approval gates, pause/resume/cancel controls, independent acceptance verification, minimal evidence, and derived trust levels.
- Persist restart-safe task capsules through the language-neutral SQLite schema while limiting each capsule to 256 KB and excluding full conversations, raw model responses, and large tool output.
- Add a provider-backed Agent adapter for configured OpenAI-compatible or Ollama models, plus local task APIs and a compact task-control view for progress, budgets, approvals, recovery, and cancellation.

## 0.2.0-alpha.1 - 2026-10-12

- Add `tidu start` for one-command loopback startup with a verifiable health endpoint and graceful shutdown.
- Add built-in SQLite persistence for AI-Tidu9 metadata, with automatic initialization, private file permissions, WAL concurrency, schema-version validation, and no third-party database dependency.
- Define the SQLite schema and ordered migrations as a language-neutral contract, with `node:sqlite` isolated as the current Node adapter and a clear future path for Python `sqlite3` implementations.
- Raise the minimum runtime to Node.js 22.14 and verify the baseline on Node.js 22 in CI.
- Add a lightweight React + Vite local configuration center with a bootstrap API, restrictive browser security headers, and packaged static assets served directly by `tidu start`.
- Add isolated managed and expert drafts with validation, optimistic concurrency, and explicit activation, keeping invalid or unsaved input away from the active runtime configuration.
- Add project-pinned Node selection for Git hooks so machines whose shell still defaults to Node.js 18 automatically use the required Node.js 22 runtime.
- Refine the local configuration center into a compact, fine-weight operations interface and define personal, centralized-enterprise, and hybrid-enterprise deployment boundaries.
- Embed personal setup and troubleshooting guidance, plus a clearly marked enterprise-onboarding blueprint that will be generated from live company configuration when enterprise deployment ships.
- Define the enterprise administrator access-key lifecycle: one-time display, irreversible database verifier, key-gated sessions, authenticated rotation, revocation, and audited host recovery.
- Add `tidu doctor` health diagnostics, a guided `tidu config` fallback, read-only configuration inspection, and advanced API-backed draft updates with optional activation.
- Expose the active virtual model through OpenAI-compatible model discovery, Chat Completions, and Responses endpoints with stable errors, request IDs, and mandatory AI-Tidu9 attribution.
- Add real OpenAI-compatible and local Ollama adapters, runtime-only credential handling, safe provider status, and virtual-model response normalization.
- Add recoverable personal uninstall, latest-snapshot restore, protected permanent purge, running-runtime checks, and custom-path safeguards.
- Add end-to-end SSE streaming, upstream cancellation, virtual-model event rewriting, and baseline function-tool interoperability for OpenAI-compatible services and Ollama.
- Add metadata-only discovery for local Codex, Cursor, and OpenAI CLI installations through the CLI and configuration center, with honest readiness and limitation states.
- Add an explicitly confirmed Codex integration transaction using a dedicated profile, private snapshots, atomic writes, connectivity verification, automatic failure rollback, and manual latest-snapshot restoration.
- Add a credential-free host-account bridge contract, multiple account profiles, immutable per-task account snapshots, and strict mismatch rejection without reading host login files.
- Add default reuse of an existing Codex login through Codex-owned storage metadata, the official status command, and an app-server launch contract; add explicit re-login and confirmed account switching without reading or copying tokens.
- Add current-account reuse discovery, explicit re-login and switching commands, and an official ACP launch contract for Cursor Agent without reading or copying Cursor credentials.
- Distinguish native Agent bridges from OpenAI-compatible virtual-model fallback so chat-only compatibility is never presented as complete host capability.
- Add one `tidu setup` flow for install, verify, repair, update, and uninstall across Codex, Cursor, browser management, and generic OpenAI-compatible entries.
- Add bounded stdio JSON-RPC, a packaged MCP server and Agent Plugin, plus complete Codex app-server and Cursor ACP adapters for capability negotiation, sessions, streaming, cancellation, permissions, and fail-closed interactions.
- Add a usage-observation contract that keeps provider-authoritative, host-reported, and locally estimated usage visibly distinct during reconciliation.
- Verify the dedicated virtual-model profile through a real Codex CLI turn and add Responses custom, namespace, and web-search tool compatibility discovered during that test.
- Make the root TypeScript project own IDE type checking for library, UI, and Vite configuration while keeping emission in one explicit build configuration.
- Add the security-critical core of the official Sign in with ChatGPT path: dynamic registration and returning-account PKCE requests, constant-time callback state checks, code exchange without a client secret, trusted OpenID discovery, RS256 ID-token validation, and explicit plan-scope verification.

## 0.1.0-alpha.2 - 2026-10-11

- Rebuild the project from an early AI rules package into the AI-Tidu9 Super Agent platform.
- Establish the `tidu` CLI, TypeScript workspaces, versioned configuration and protocol contracts, a shared error model, and automated quality gates.
- Consolidate internal workspaces into the single public package `@skillnull/tidu` while preserving module boundaries.
- Add explicit `build:tidu` and version-aware `publish:tidu` package targets, plus a workspace-wide `build` entry point.
- Make `publish:tidu` prepare versions and changelog entries interactively before explicit release confirmation.
- Make `@skillnull/tidu` the single version source and derive the runtime CLI version from its package metadata.
- Synchronize the published package version and release tag to Git only after npm publication succeeds.

### Upgrade notes

- The former `@skillnull/ai-tidu9` rule package and its post-install workflow are removed from this codebase. This alpha is a new platform baseline and does not provide an in-place migration path.
- Do not replace an existing installation until a later release documents a tested migration and rollback path.

# Architecture Baseline

[简体中文](./architecture.md)

AI-Tidu9 follows a modular-monolith-first architecture with stable adapter boundaries and progressive decomposition. An individual can run one lightweight process. Later stages may split the gateway, scheduler, and workers for team or enterprise load without rewriting the core protocol.

## Current modules

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `packages/tidu/src/cli` | `tidu` command entry point | Handles interaction and process exit codes, not domain logic |
| `packages/tidu/src/core` | Product metadata, shared errors, and domain foundations | Independent of clients, model providers, and storage implementations |
| `packages/tidu/src/config` | Versioned configuration contracts and safe defaults | Managed and expert configurations must remain isolated |
| `packages/tidu/src/accounts` | Host-account bridges, multiple profiles, and task account snapshots | Accepts only non-sensitive metadata and delegated execution; never reads or copies host tokens |
| `packages/tidu/src/clients` | Local-client discovery and transactional integration adapters | Never reads accounts or credentials; writes only dedicated AI-Tidu9 files with snapshots, verification, and rollback |
| `packages/tidu/src/protocol` | Canonical Agent task and event protocol | Evolves through explicit versions without binding to one model |
| `packages/tidu/src/runtime` | Lightweight local HTTP runtime, virtual-model, and configuration-center entry | Listens on loopback by default and coordinates adapters without provider implementations or business orchestration |
| `packages/tidu/src/config-center` | Bootstrap-data contract for the local configuration center | Exposes active and isolated-draft state without direct database access |
| `packages/tidu/src/openai` | OpenAI-compatible virtual-model, error, and request-validation contracts | Provider-neutral, does not log request content, and never fabricates inference output |
| `packages/tidu/src/providers` | Real OpenAI-compatible and Ollama provider adapters | Protocol translation and invocation only; never persists credentials, conversations, or business configuration |
| `packages/tidu/src/storage` | Storage adapters and persistence for AI-Tidu9 metadata | Keeps schema and SQL migrations language-neutral while storing managed drafts, expert drafts, and the active snapshot separately |
| `packages/tidu/src/usage` | Unified observations for provider, host, and estimated usage | Provider-authoritative data wins; estimates always remain visibly labeled and never impersonate official quota data |

These modules belong to the single public package `@skillnull/tidu`. Directories preserve internal code boundaries without becoming separate npm packages. A new public package is extracted only after it has independent consumers, versioning, and a release lifecycle.

## Design constraints

- Clients, models, agents, Skills, MCP servers, tools, knowledge bases, and storage connect through adapters added in later stages.
- The npm package publicly exports `storage/contract.json` and ordered SQL migrations, defining the SQLite contract without binding it to Node or Python.
- The Node primary runtime executes that contract. The Python SDK uses platform APIs; a future standalone Python runtime may implement the same contract with the standard-library `sqlite3` module.
- One runtime owns write access to a SQLite database. Cross-language agents and workers must not bypass platform APIs to contend for the file directly.
- The core represents goals, capabilities, policies, tasks, events, and verifiable outcomes; it does not hard-code domain classification.
- Personal deployment remains resource-light by default. PostgreSQL, Redis, queues, and distributed workers are opt-in capabilities.
- Every model and tool egress must cross the same mandatory policy boundary; plugins and expert settings cannot bypass it.
- Configuration and protocols are versioned. Breaking changes require migration and rollback notes.
- Managed drafts, expert drafts, and the active snapshot are independent states. Saving never activates a draft, and revision checks prevent concurrent overwrites.

## Current limitations

The current primary runtime requires Node.js 22.14 or later. `tidu start` launches a lightweight `127.0.0.1` runtime and React + Vite local configuration center, applies language-neutral migrations through the Node SQLite adapter, and verifies runtime and storage through `/health`. The configuration center supports isolated managed and expert drafts, server-side validation, optimistic revision checks, and explicit activation. `tidu doctor` and `tidu config` use the same management API for diagnostics and configuration fallback when the page is unavailable. The OpenAI-compatible entry point supports model discovery, Chat Completions, and Responses, can select an OpenAI-compatible API or local Ollama, and provides non-streaming JSON, streaming SSE, plus function, custom, namespace, and web-search tool interoperability. `tidu setup` now installs, verifies, repairs, updates, and uninstalls Codex, Cursor, browser-management, and generic OpenAI-compatible entries through one flow; Agent Plugin and MCP manifests ship in the package. The Codex app-server and Cursor ACP adapters cover negotiation, sessions, streaming messages, cancellation, permissions, and fail-closed interactions. Provider credentials never enter SQLite, configuration-center responses, or logs. When the independent Cursor Agent CLI account is signed out, ACP delegation fails explicitly instead of reading private Desktop credentials. The Python SDK, autonomous Agent tool loop, and enterprise deployment are not implemented yet.

## Client compatibility matrix

| Client | Current integration | Verification | Known limitation |
| --- | --- | --- | --- |
| Codex app, CLI, and IDE | Shared MCP registration, dedicated virtual-model profile, and app-server delegation | A real host-account turn returned `TIDU_STAGE2_OK` on 2026-10-12; automation covers protocol, configuration, rollback, and account switching | Custom virtual models use fallback model metadata and display a warning |
| Cursor Desktop and Agent CLI | Shared MCP registration; an authorized CLI can use full ACP delegation | Local MCP status is `ready`; automation covers ACP negotiation, sessions, streaming, cancellation, permissions, and account switching | The local Agent CLI is currently signed out, so a real ACP model turn was not attempted; Desktop login cannot be copied into CLI credentials |
| OpenAI CLI | Manual `OPENAI_BASE_URL` integration design | Not installed on the current test host, so no real command regression was claimed | Shell startup files are never modified; CLI-version-specific flags require separate verification |
| Generic OpenAI clients | `/v1/models`, Chat Completions, and Responses | Automated real HTTP, JSON, SSE, cancellation, and tool-protocol tests pass | Client-specific extensions are supported only after explicit verification |
| Ollama | Upstream model-provider adapter, not a host client | Automated non-streaming, streaming, and tool-protocol translation tests pass | Does not provide host accounts, IDE sessions, or client permission capabilities |

## One installation, multiple surface connectors

“One installation” means one AI-Tidu9 core, one configuration center, and one active policy set per device. The installer discovers hosts and deploys thin connectors; it does not reduce every client to a lowest-common-denominator protocol.

| Usage surface | Preferred connector | Account and capability owner | Installation target |
| --- | --- | --- | --- |
| Codex app, CLI, and IDE extension | Codex Plugin/MCP plus app-server | Official Codex session, models, tools, permissions, and shared MCP configuration | `tidu setup` configures once after detection and all Codex surfaces share it |
| Cursor Desktop | User-level MCP plus portable Agent Plugin | Cursor Desktop Agent retains the current account and native capabilities | `tidu setup` writes only the AI-Tidu9-owned MCP entry and never copies credentials |
| Cursor CLI | ACP | Cursor Agent CLI account, modes, tools, permissions, sessions, and MCP | Installer verifies ACP plus the independent CLI authorization state |
| JetBrains, Neovim, Zed, and other editors | Agent Plugin/MCP or the editor's official ACP entry | Selected host account and capabilities | Load the packaged manifest; unverified host capabilities are not shown as available |
| Browser entry | AI-Tidu9 configuration center or organization gateway | AI-Tidu9 runtime and shared policy | Personal mode opens the configuration center directly; cross-device access requires an HTTPS reverse proxy |
| Generic OpenAI clients | OpenAI-compatible virtual model | AI-Tidu9 model pool and Agent kernel | Generate the base URL, virtual-model name, and non-sensitive connection metadata |
| Ollama and other model services | Provider adapter | Upstream model capability | Invoked by AI-Tidu9 and never installed again as a user surface |

The unified installer is a repeatable transaction: detect first, show impact, install only after confirmation, then perform a handshake and real-task verification per surface. A failed connector rolls back only itself and cannot damage other hosts. Personal mode installs at current-user scope. Enterprise mode uses MDM, software distribution, team marketplaces, or gateway policy for zero-touch deployment. Uninstall removes only AI-Tidu9-owned connectors and registrations, never host accounts, history, third-party plugins, or user configuration.

### Native full-capability integration gates

- Credentials remain under host custody. AI-Tidu9 launches only official delegation processes and removes API-key environment variables that could override the current login.
- Protocol handshake and real-task acceptance must verify modes, tools, permissions, sessions, cancellation, and MCP capabilities. Unverified capabilities are never shown as available.
- Permission requests are returned unchanged to the host or user and are never silently approved. Dangerous flags such as `force`, `yolo`, or automatic MCP approval are absent from default launch arguments.
- Controlled adapters construct delegation commands and arguments. Configuration and model output cannot select executables or inject launch arguments.
- Protocol messages require size, timeout, concurrency, cancellation, and abnormal-exit boundaries. Default auditing stores only state and metering metadata, never prompts, tool arguments, conversation bodies, or credentials.
- Native host capability and mandatory organization policy must both hold. A channel that policy cannot cover is rejected rather than bypassed through compatibility mode.

Official Sign in with ChatGPT requires a standalone application to own OIDC + PKCE authorization, user consent, profile isolation, token renewal, and protected storage. It does not grant access to ChatGPT conversations. AI-Tidu9 follows that flow as a standalone app; as a local Codex extension, it delegates through the official Codex process and never parses or copies private credentials. Dynamic and returning-account authorization requests, callback validation, secretless code exchange, trusted OpenID discovery, RS256 ID-token verification, and plan-scope checks are implemented. The host-account bridge provides a token-hiding delegation boundary. AI-Tidu9's standalone login remains incomplete until end-user browser guidance, protected persistence, refresh/revocation, and a real-account acceptance test are complete.

## Deployment and management boundaries

| Profile | Server | Employee device | Use case |
| --- | --- | --- | --- |
| Personal local | None | One `tidu` process | Personal models, Skills, MCP servers, knowledge, and local-file collaboration |
| Central enterprise | One company gateway | No local AI-Tidu9 install for standard OpenAI-compatible clients | Pooled model procurement, quotas, organization policy, and server-side capabilities |
| Hybrid enterprise | One company gateway | Lightweight connector | Local files, IDE context, host accounts, local Skills/MCP servers, or redaction before data leaves the device |

The management page is not the only control channel. A production enterprise deployment must place it behind HTTPS and identity controls while providing an equivalent CLI, versioned configuration files, and management APIs. A page outage must not interrupt active configuration or model-gateway traffic. Mandatory enforcement combines server egress policy, identity permissions, network egress controls, and device policy; it cannot depend only on employees voluntarily installing local software.

The configuration center embeds guidance that matches the running version. Personal guidance documents only real startup, configuration, and troubleshooting steps. Enterprise guidance is generated from the published domain, identity method, virtual model, enabled clients, connector policy, and support details. It produces separate administrator and employee onboarding views without exposing provider secrets. Every configuration publication creates a new documentation version while older guidance remains auditable and clearly marks where it no longer applies.

## Installation lifecycle

Personal uninstall distinguishes the program, runtime data, and user assets. After confirming that the runtime has stopped, `tidu uninstall` atomically moves the AI-Tidu9-owned data directory into a timestamped local snapshot. `tidu restore` restores only the latest snapshot and only when no current data directory exists, so it never overwrites new data. Permanent purge shows the exact path, requires the full confirmation word, and matches only the AI-Tidu9 data and snapshot namespace. Custom database paths are always preserved. An ephemeral `npx` run has no npm package to remove; fixed installations are removed by their original package manager.

Moving from personal to enterprise is profile enrollment, not an overwrite. The guided flow verifies the company endpoint, service version, identity method, policy boundary, and client compatibility before creating an encrypted local migration snapshot and impact preview. Confirmation adds an isolated enterprise profile and activates it in stages. The personal profile remains available, and mandatory enterprise policy applies only inside its declared organization scope. Any failed stage rolls back to the personal profile, which is also restored after leaving the organization. Personal credentials, private Skills, MCP configuration, knowledge, and history are never uploaded merely because the user joins an enterprise.

### Enterprise administrator access key

- Enterprise initialization generates a high-entropy administrator access key and displays it once in the installation terminal and confirmation page. The installer must confirm offline storage. Logs, history pages, and ordinary APIs never return the original value again.
- The database stores a key identifier, unique salt, irreversible verifier, algorithm version, status, and creation/rotation timestamps. It never stores a retrievable raw key.
- Every new administrative session starts with key entry on an HTTPS page. The server uses constant-time verification, failure throttling, and security auditing, then issues only a short-lived HttpOnly, Secure, SameSite session.
- An administrator may rotate the key after reauthentication. The new key is also shown once. After storage is confirmed, the old key is revoked immediately and existing administrative sessions may be revoked by policy.
- A lost key cannot be recovered in plaintext from the database. An authorized operation on the server host must reset it and create an immutable security-audit event. Enterprise SSO and roles identify individual administrators but do not replace this deployment-level key gate.

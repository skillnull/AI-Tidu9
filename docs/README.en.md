# 九门赛博提督 · AI-Tidu9

**AI-Tidu9 · Intelligent Collaboration Hub**

AI-Tidu9 is an intelligent collaboration hub for cross-domain scenarios. It coordinates internal and external agents, models, tools, knowledge, and experts around a goal to deliver verifiable business outcomes.

[简体中文](../README.md)

## Status

The project is now in integrated release-candidate qualification with a personal entry point, independent Agent kernel, dynamic model routing, enterprise governance, and an open capability ecosystem. Scheduler high availability, target-environment load testing, long-running local dogfooding, and real team acceptance are still pending, so production-critical use is not yet recommended.

## Direction

- Connect to Codex, Cursor, CLIs, and other clients as a virtual model.
- Execute Agent tasks independently of host presentation limits.
- Route models across quality, cost, privacy, quota, and availability constraints.
- Complete missing capabilities by combining low-cost and specialist models.
- Protect secrets and sensitive content at runtime.
- Support individuals, teams, and enterprises without restricting continued AI exploration.

## Install and use

Node.js 22.14 or later is required. The official npm package is `@skillnull/tidu`; its installed command remains `tidu`:

```bash
npx @skillnull/tidu start
```

Open the local URL printed by the command to edit managed or expert configuration drafts. The two modes persist independently, and only “Activate this configuration” changes runtime behavior. Invalid or unsaved expert input cannot affect managed mode.

The control center switches between Chinese and English in one click. Every activation requires an impact simulation and preserves the previous known-good version. A failed health probe rolls back automatically, while manual rollback remains available. Personal history supports host, portable, and incognito policies: host mode leaves full conversations with the current client; portable mode applies byte and age bounds; incognito mode retains no conversation history. Usage is attributed through immutable task account snapshots, so switching accounts cannot move charges from running tasks.

The public SDK also provides personal budget aggregation, diagnostics for local Ollama or loopback-compatible models, pre-install checks for Agent/Skill/MCP/tool extensions, and authenticated AES-256-GCM configuration import and export. Exports contain only non-secret configuration, history policy, and extension metadata—never credentials or conversation content.

The enterprise pilot adds PostgreSQL state persistence, hierarchical organization scopes, mandatory/advisory policy, identity roles, an internal capability catalog, mixed enterprise/user resources, hierarchical quota pools, end-of-cycle sharing, atomic reservation and settlement, private artifact storage, and generated administrator/employee guidance. The single-host Docker entry is `config/docker/compose.yml`:

```bash
TIDU_POSTGRES_PASSWORD='your-private-password' docker compose -f config/docker/compose.yml up --build
```

The container port binds to server loopback by default. Cross-device access requires an HTTPS reverse proxy and enterprise identity control; never expose the management port directly.

Use the equivalent CLI when the page is unavailable:

```bash
npx @skillnull/tidu doctor
npx @skillnull/tidu clients
npx @skillnull/tidu config
npx @skillnull/tidu config show
```

For remote management, add `--endpoint https://tidu.example.com` or set `TIDU_ENDPOINT`. The CLI uses the same management API and never writes SQLite directly.

The runtime now exposes OpenAI-compatible virtual-model discovery and request entry points:

```text
GET  /v1/models
GET  /v1/models/{model}
POST /v1/chat/completions
POST /v1/responses
```

The model ID comes from the active profile and retains project attribution through `owned_by: AI-Tidu9`. Two real execution types are available: OpenAI-compatible APIs and local Ollama. Without a configured provider, inference returns the standard `model_provider_not_configured` error instead of a simulated answer.

Connect OpenAI or a compatible relay (non-loopback endpoints must use HTTPS):

```bash
TIDU_PROVIDER=openai-compatible \
TIDU_PROVIDER_MODEL=gpt-4.1-mini \
TIDU_PROVIDER_API_KEY=your-runtime-key \
npx @skillnull/tidu start
```

The default official endpoint is `https://api.openai.com/v1`. Add `TIDU_PROVIDER_BASE_URL=https://provider.example.com/v1` for another compatible service. The key is read only from the process environment; it is not written to SQLite, returned by the configuration center, or logged.

Connect local Ollama (default endpoint `http://127.0.0.1:11434`):

```bash
TIDU_PROVIDER=ollama \
TIDU_PROVIDER_MODEL=qwen3:8b \
npx @skillnull/tidu start
```

The current adapters support both non-streaming JSON and streaming SSE, including baseline function definitions, tool selection, model-issued tool calls, and client-supplied tool results. OpenAI-compatible services retain their native protocol, while Ollama is translated between NDJSON and Chat Completions or Responses events. Host clients may still execute host-owned tools; independent Agent tasks run tools inside the AI-Tidu9 kernel's own budget, approval, and recovery boundaries.

## Independent Agent kernel

After a real model provider is configured, the runtime automatically enables goal understanding, dynamic planning, replanning, non-tool step execution, and independent result verification. Tools are registered explicitly through the public SDK. Write and external tools require human approval by default, and non-idempotent tools are not replayed automatically after interruption. The configuration center's Tasks view and `/api/tasks` management API expose progress, budgets, trust, pause, resume, cancellation, and approvals.

Task state persists as a lightweight capsule capped at 256 KB, containing checkpoints, bounded summaries, minimal evidence, and budget usage. It does not store full conversations, raw model responses, or large tool output. Without a real provider, the task view remains read-only and task creation returns `AGENT_KERNEL_NOT_CONFIGURED` instead of fabricating autonomous results. The public SDK can inject custom planners, workers, verifiers, and tools; see the [architecture baseline](./architecture.en.md) for exact boundaries.

`tidu clients` and the configuration center's Clients view discover local Codex, Cursor, and OpenAI CLI installations. Discovery checks only whether known commands, applications, and configuration files exist; it never reads configuration contents, accounts, credentials, or history. Integration has two levels: official native Agent protocols such as Codex app-server and Cursor ACP preserve host modes, tools, permissions, sessions, and MCP capabilities; the OpenAI-compatible virtual model supports generic clients without a native Agent protocol. The latter is a compatibility entry and must never be presented as the host's complete capability set. Ollama is an upstream model provider, not a host client.

One `tidu setup` installs one AI-Tidu9 core and configures every detected official surface. Codex app, CLI, and IDE share one MCP registration; Cursor Desktop and CLI share one user-level MCP registration; browsers use the configuration center; other clients use the OpenAI-compatible endpoint or the packaged Agent Plugin/MCP manifests. Every surface points to the same runtime, configuration, policy, and model pool instead of duplicating Agent computation.

```bash
tidu setup             # Install detected connectors
tidu setup verify      # Verify without changing configuration
tidu setup repair      # Recreate AI-Tidu9-owned connectors
tidu setup update      # Refresh connector launch metadata
tidu setup uninstall   # Remove connectors while retaining AI-Tidu9 data
```

The report labels every surface as a native Agent bridge, MCP tool entry, browser management entry, or OpenAI-compatible entry. Missing host capabilities are never silently presented as full capability. Connector registrations use absolute paths to the active Node runtime and installed CLI, avoiding PATH differences between shells, IDEs, and desktop applications.

Codex can create a dedicated AI-Tidu9 profile through an explicit confirmation flow:

```bash
tidu clients connect codex
codex --profile ai-tidu9
tidu clients rollback codex
```

This compatibility flow does not modify Codex's default `config.toml`; it manages only the dedicated `ai-tidu9.config.toml`. It creates a private snapshot before writing and revalidates the runtime and virtual model afterward. A failed verification rolls back immediately, while explicit rollback restores only the latest AI-Tidu9 snapshot. Normal installation should use `tidu setup` to register the shared MCP connector. Cursor configuration adds or removes only the AI-Tidu9-owned `ai-tidu9` entry and preserves other MCP servers. OpenAI CLI can use its official `OPENAI_BASE_URL` or `--base-url` mechanism.

After installation, inspect Codex and Cursor host login state; no repeated authorization is needed when an official reusable session exists:

```bash
tidu account
tidu account relogin codex
tidu account switch codex
tidu account relogin cursor
tidu account switch cursor
```

Codex delegates the current account through the official `codex login status` and `codex app-server` commands. When Cursor Agent CLI is authorized, it delegates that CLI account through the official status command and `agent acp`. Both adapters cover capability negotiation, sessions, streaming messages, cancellation, and deny-by-default permission handling; unknown interactions require an explicit host handler. AI-Tidu9 removes process-level API-key variables that could override host login, but never reads credential-file contents or copies, persists, or prints tokens. `relogin` invokes an official login flow only when explicitly requested. `switch` requires confirmation before official logout and login commands are called. Cursor owns the authorization boundary between Desktop and Agent CLI; AI-Tidu9 never reads Desktop private credentials to fabricate zero-login reuse.

## Uninstall and restore

Stop the running personal runtime, then run:

```bash
tidu uninstall
```

The default operation atomically moves AI-Tidu9-owned data into a local snapshot and does not delete personal configuration. Restore the latest snapshot after reinstalling with:

```bash
tidu restore
```

To permanently delete current data and every AI-Tidu9 uninstall snapshot, run `tidu uninstall --purge` and enter the full confirmation word. Automation may use `--purge --confirm DELETE`. This cannot be recovered. A custom `TIDU_DATABASE_PATH` is never moved or deleted automatically.

An ephemeral `npx` run has no npm package to remove. After archiving data, a global installation can be removed with `npm uninstall -g @skillnull/tidu`; project dependencies should be removed through the project's existing package manager.

## Documentation

- [Architecture baseline](./architecture.en.md): module boundaries, data contracts, deployment modes, client compatibility, and current limitations.
- [Core Routing and Secret Gate](./core-differentiators.md#english): dynamic model routing, capability completion, capability assembly, runtime secret protection, and the reproducible cost case.
- [Open capability ecosystem](./ecosystem-sdk.md): Capability Provider Protocol, TypeScript and Python SDKs, permissions, signatures, isolation, and third-party Agent delegation.
- [Integrated release candidate](./release-candidate.md): unified gates, upgrade and rollback, security and privacy checks, compatibility matrix, and known limitations.
- [Release plan](./RELEASE_PLAN.md): current development stages and acceptance status; removed after final `v1.0.0` acceptance.
- [Changelog](./CHANGELOG.md): permanent version history.

## Contributing

The shared Node entry supports the current environment, NVM, Homebrew, fnm, mise, asdf, and Volta. Install, build, test, publish, and Git-hook commands select a compatible runtime automatically and stop before changing dependencies when none is available.

```bash
npm run setup
npm run check
node packages/tidu/dist/cli/index.js --help
```

See the [contribution guide](./CONTRIBUTING.md) for branch, commit, pull-request, version, and release rules. Local policy scripts and GitHub Actions enforce these rules.

## License

This project is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE). See the [trademark policy](./TRADEMARKS.md) and [NOTICE](../NOTICE) for branding and attribution terms.

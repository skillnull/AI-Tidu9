# Local development

[README](./README.EN.md) · [简体中文](./LOCAL-DEVELOPMENT.md) · [Contributing](./CONTRIBUTING.EN.md)

This document covers repository-local development only. Server and remote deployment steps are maintained separately in [Remote deployment](./REMOTE-DEPLOYMENT.EN.md).

## Start the development environment

Node.js 22.14 or newer is required:

```bash
npm run tidu:setup
```

`tidu:setup` installs dependencies, builds the CLI, and automatically starts the personal frontend and API services. `tidu:dev-p` starts the frontend with built-in development control (`9639`), while `tidu:dev-api-p` independently starts the API (`9640`). The CLI is a command entry, not a separately started or displayed service. Enterprise development uses the matching `-e` commands and ports `9739` and `9740`.

Development data is stored in `.tidu-dev/tidu.sqlite`, isolated from globally installed data. Vite hot-reloads frontend source. After backend TypeScript changes, restart the independent API service from the page or CLI.

Use the frontend address for configuration, connection repair, and mode switching. The development proxy verifies the local page's same-origin source before translating Origin and Host to the target service, supporting separate frontend and API ports. External and mismatched origins remain denied, and the backend's same-origin write protection stays active.

## Local Codex configuration acceptance

The configuration page is the single upstream selector for AI-Tidu9. Host, company-provider, and custom models are mutually exclusive, and the model list follows the selected upstream source:

- **AI-Tidu9**: Codex shows only “九门赛博提督”; the configuration page selects the host, company, or custom upstream used by the Agent kernel.
- **Direct Official**: the exact pre-installation configuration is restored, Codex shows official models only, and calls bypass the AI-Tidu9 runtime.

AI-Tidu9 keeps only its original installation baseline and latest rollback point in its own backup directory; unrelated Codex configuration backups are never removed.

Mode switches synchronize the Provider, model, and official `thread/settings/updated` notification. Open idle chats update automatically; running turns synchronize after completion. A stale model selection on the next turn cannot override the active mode.

When newer Codex servers reject cross-Provider resume, an official `thread/fork` continuation and a local identifier-only mapping retain the same chat entry. Lists, history pages, cancellation, and relay restarts use that entry. Official Codex owns the histories; empty chats retain their approval and sandbox parameters. Already running relays refresh continuation mappings and serialize updates for different chats. Writes check the source continuation so a stale fork cannot replace newer context. Metadata reads do not mark a thread loaded; after closure or unsubscribe, the next send reloads it through the native API. A corrupt index leaves initialization and account queries available; affected continuation requests fail explicitly and preserve the original file. Official Codex retains exclusive writer ownership per thread; a conflicting process receives the original conflict reason without taking over running work.

Desktop login, `account/*`, and legacy `getAuthStatus` always use the same official app-server that received the login, pinned to the Official Provider. Process-local desktop identity does not depend on another process finding credentials. AI-Tidu9 chats lazily use a separate native execution process without copying official login tokens; account notifications come only from the identity process. Chat lists and configuration follow the current mode, loaded-thread lists merge the processes, and interruption and approval responses return to the original owning process. Native account, quota, and usage reads run independently of mode synchronization. Slow reads do not block other queries or chats; failures retain native errors without closing the shared official connection.

Retry uses official behavior: the native client reconnects disconnected streams, while genuine capacity errors preserve `server_is_overloaded` to trigger the existing countdown and retry button. Protocol and configuration failures are not relabeled as capacity errors; no separate retry queue or official application patch is added. Cross-mode requests replay public messages, summaries, and tool results and clear the previous Provider's `previous_response_id`, without rewriting official chat records.

Stdio message sizes follow the official Codex `0.166.0-alpha.5.1` [transport implementation](https://github.com/openai/codex/blob/f79b26ccbb3116b052544666a181012fb45dc49b/codex-rs/app-server-transport/src/transport/stdio.rs): read JSON one line at a time and append a newline after serialization, without an additional fixed message-byte cap by default. The shared client checks a byte limit only when `maximumMessageBytes` is explicitly supplied; the Codex adapter does not override this default. This applies to stdio frames; HTTP bodies, the MCP service, and business safety gates retain their own limits.

Quota remains under “Model usage”; the client card adds no shortcut. The managed integration preserves native Codex account, quota, and usage queries, with data returned by an official process. This page also reads quota, reset times, and available reset counts independently. Usage queries do not start model sessions for inactive hosts. When the shared model cache comes from a newer Codex version, automatic discovery prefers an installed CLI from the corresponding release to avoid legacy parsing failures; explicit command overrides keep priority. Account and quota reads run concurrently and retain retrieved data at the query deadline. Empty quota notifications from managed turns trigger an independent official refresh without overwriting known official quotas or delaying turn completion. A failed daily-usage endpoint does not discard retrieved quota; missing fields remain explicitly unreported. Effort options use the native `reasoningEffort` field.

The Services page shows only `tidu:dev-p` and `tidu:dev-api-p`. Each entry comes from its corresponding real process and has an independent PID, port, status, launch command, log location, configuration location, proxy configuration, and start, stop, and restart actions. Development logs stream to each service's launch terminal; services that do not use Nginx explicitly show “Not configured.” Installed and remote runtimes also list only real runtime units. Personal installations do not expose enterprise commands; enterprise installations do not expose personal commands. Use `tidu service status` or `tidu service <start|stop|restart> <service-id|all>` from the CLI.

Before starting, `tidu:dev-p` checks the installed-runtime lock and default port. On conflict it stops and asks for `tidu service stop all && tidu uninstall --confirm DELETE`; it never removes data automatically.

Before switching to AI-Tidu9, the local runtime must be reachable and pass a minimal inference check before global activation. Verification waits at most 30 seconds; a timeout, caller cancellation, or newer mode choice ends the old verification and leaves or restores Official mode. This deadline applies only to the switch probe, not normal inference. Connection preparation, mode switches, and catalog refreshes share a configuration transaction. A newer choice cancels older preparation and probes; rollback and removal invalidate outstanding requests. Commit and failure recovery check owned state, preserving newer changes from other processes and Official model choices made during verification. Interruptions do not wait for mode synchronization. Shutdown disconnects active connections, cancels unfinished requests, and closes upstream processes. On macOS/Linux, stdio transports isolate their owned process group and clean its children on forced exit; native execution processes join their owning relay group. A normal shutdown still restores Official mode when AI-Tidu9 mode is active.

## Verify and stop

```bash
npm run check
```

Set `TIDU_CODEX_PROTOCOL_TEST_COMMAND` for `codex-protocol.test.ts` to exercise a native CLI with isolated homes and synthetic identity: startup in either mode, login, switches in both directions, managed replies, logout, and requests without official tokens. With an unchanged tool catalog, regressions verify that parallel and successive calls return real results to the same native turn without interrupting or restarting. When search discovers new tool definitions, official history APIs restore the conversation without executing completed tools again. Neither path fabricates user messages. The default `agent-adapters.test.ts` also covers continuation when tool RPCs are dispatched sequentially. The history fixture executes both modes through local Providers without real accounts or upstreams. Protocol checks do not replace desktop UI acceptance. After relay implementation updates, restart the desktop app to load the new code into its existing app-server; subsequent mode switches need no restart.

After development or testing, press `Ctrl+C` in the terminal running `tidu:setup` to stop the frontend and API processes it started. Stop an individually launched API service in its own terminal. Confirm that the corresponding PIDs and ports have exited.

When a local feature change also affects server deployment, update only the separate remote deployment document with the corresponding remote steps. Do not add remote operations to the local development workflow.

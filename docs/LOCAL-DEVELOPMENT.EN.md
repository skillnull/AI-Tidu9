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

Retry uses official behavior: the native client reconnects disconnected streams, while genuine capacity errors preserve `server_is_overloaded` to trigger the existing countdown and retry button. Protocol and configuration failures are not relabeled as capacity errors; no separate retry queue or official application patch is added. Cross-mode requests replay public messages, summaries, and tool results and clear the previous Provider's `previous_response_id`, without rewriting official chat records.

Stdio message sizes follow the official Codex `0.166.0-alpha.5.1` [transport implementation](https://github.com/openai/codex/blob/f79b26ccbb3116b052544666a181012fb45dc49b/codex-rs/app-server-transport/src/transport/stdio.rs): read JSON one line at a time and append a newline after serialization, without an additional fixed message-byte cap by default. The shared client checks a byte limit only when `maximumMessageBytes` is explicitly supplied; the Codex adapter does not override this default. This applies to stdio frames; HTTP bodies, the MCP service, and business safety gates retain their own limits.

Quota remains under “Model usage”; the client card adds no shortcut. The managed integration preserves native Codex account, quota, and usage queries, with data returned by an official process. This page also reads quota, reset times, and available reset counts independently. Usage queries do not start model sessions for inactive hosts. When the shared model cache comes from a newer Codex version, automatic discovery prefers an installed CLI from the corresponding release to avoid legacy parsing failures; explicit command overrides keep priority. Account and quota reads run concurrently and retain retrieved data at the query deadline. Empty quota notifications from managed turns trigger an independent official refresh without overwriting known official quotas or delaying turn completion. A failed daily-usage endpoint does not discard retrieved quota; missing fields remain explicitly unreported. Effort options use the native `reasoningEffort` field.

The Services page shows only `tidu:dev-p` and `tidu:dev-api-p`. Each entry comes from its corresponding real process and has an independent PID, port, status, launch command, log location, configuration location, proxy configuration, and start, stop, and restart actions. Development logs stream to each service's launch terminal; services that do not use Nginx explicitly show “Not configured.” Installed and remote runtimes also list only real runtime units. Personal installations do not expose enterprise commands; enterprise installations do not expose personal commands. Use `tidu service status` or `tidu service <start|stop|restart> <service-id|all>` from the CLI.

Before starting, `tidu:dev-p` checks the installed-runtime lock and default port. On conflict it stops and asks for `tidu service stop all && tidu uninstall --confirm DELETE`; it never removes data automatically.

Before switching to AI-Tidu9, the local runtime must be reachable and pass a minimal inference check. A failed check leaves or restores Official mode and reports the concrete error. A normal local development shutdown also restores Official mode when AI-Tidu9 mode is active.

## Verify and stop

```bash
npm run check
```

After development or testing, press `Ctrl+C` in the terminal running `tidu:setup` to stop the frontend and API processes it started. Stop an individually launched API service in its own terminal. Confirm that the corresponding PIDs and ports have exited.

When a local feature change also affects server deployment, update only the separate remote deployment document with the corresponding remote steps. Do not add remote operations to the local development workflow.

# Local development

[README](./README.EN.md) · [简体中文](./LOCAL-DEVELOPMENT.md) · [Contributing](./CONTRIBUTING.EN.md)

This document covers repository-local development only. Server and remote deployment steps are maintained separately in [Remote deployment](./REMOTE-DEPLOYMENT.EN.md).

## Start the development environment

Node.js 22.14 or newer is required:

```bash
npm run tidu:setup
```

`tidu:setup` installs dependencies, builds the CLI, and automatically starts the personal frontend, CLI control service, and API service. The processes are independent: `tidu:dev-p` starts only the frontend (`9639`), `tidu:dev-api-p` starts only the API (`9640`), and `tidu:dev-cli-p` starts only the CLI control service (`9641`). Enterprise development uses the matching `-e` commands and ports `9739`, `9740`, and `9741`.

Development data is stored in `.tidu-dev/tidu.sqlite`, isolated from globally installed data. Vite hot-reloads frontend source. After backend TypeScript changes, restart the independent API service from the page or CLI.

## Local Codex configuration acceptance

The configuration page is the single upstream selector for the AI-Tidu9 virtual model. It lists official and company-provider models and accepts a custom model ID:

- **AI-Tidu9**: Codex gains one AI-Tidu9 virtual-model entry; its official or company upstream is selected on the configuration page.
- **Direct Official**: active AI-Tidu9-managed blocks are removed and Codex shows official models only.

AI-Tidu9 keeps only its original installation baseline and latest rollback point in its own backup directory; unrelated Codex configuration backups are never removed.

The Services page separately shows `tidu:dev-p`, `tidu:dev-cli-p`, and `tidu:dev-api-p`. Each entry comes from its corresponding real process and has an independent PID, port, status, launch command, and start, stop, and restart actions. The frontend proxy is no longer presented as the API or CLI endpoint. Installed and remote runtimes list only real runtime units. Personal installations do not expose enterprise commands; enterprise installations do not expose personal commands. Use `tidu service status` or `tidu service <start|stop|restart> <service-id|all>` from the CLI.

Before starting, `tidu:dev-p` checks the installed-runtime lock and default port. On conflict it stops and asks for `tidu service stop all && tidu uninstall --confirm DELETE`; it never removes data automatically.

Before switching to AI-Tidu9, the local runtime must be reachable and pass a minimal inference check. A failed check leaves or restores Official mode and reports the concrete error. A normal local development shutdown also restores Official mode when AI-Tidu9 mode is active.

## Verify and stop

```bash
npm run check
```

After development or testing, press `Ctrl+C` in the terminal running `tidu:setup` to stop all three processes it started. Stop individually launched services in their own terminals. Confirm that the corresponding PIDs and ports have exited.

When a local feature change also affects server deployment, update only the separate remote deployment document with the corresponding remote steps. Do not add remote operations to the local development workflow.

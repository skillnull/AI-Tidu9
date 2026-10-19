# Local development

[README](./README.EN.md) · [简体中文](./LOCAL-DEVELOPMENT.md) · [Contributing](./CONTRIBUTING.EN.md)

This document covers repository-local development only. Server and remote deployment steps are maintained separately in [Remote deployment](./REMOTE-DEPLOYMENT.EN.md).

## Start the development environment

Node.js 22.14 or newer is required:

```bash
npm run tidu:setup
```

`tidu:setup` installs dependencies, builds the CLI, and automatically starts the personal frontend, CLI, and API services. Use `tidu:dev-p` to start the personal service group again, or `tidu:dev-e` for the enterprise group. The browser always uses port `9639`; frontend and API processes use isolated internal ports so stopping one service does not remove the control endpoint.

Development data is stored in `.tidu-dev/tidu.sqlite`, isolated from globally installed data. Vite hot-reloads frontend source, and backend TypeScript changes restart the local runtime automatically.

## Local Codex configuration acceptance

The configuration page is the single upstream selector for the AI-Tidu9 virtual model. It lists official and company-provider models and accepts a custom model ID:

- **AI-Tidu9**: Codex gains one AI-Tidu9 virtual-model entry; its official or company upstream is selected on the configuration page.
- **Direct Official**: active AI-Tidu9-managed blocks are removed and Codex shows official models only.

AI-Tidu9 keeps only its original installation baseline and latest rollback point in its own backup directory; unrelated Codex configuration backups are never removed.

The Services page separately shows `tidu:dev-frontend-p`, `tidu:dev-cli-p`, and `tidu:dev-api-p`. Every service has its own PID, status, command, and start, stop, and restart actions. Enterprise development uses the matching `-e` commands. Installed and remote runtimes use the same service contract and list only the active edition. Personal installations do not expose enterprise commands; enterprise installations do not expose personal commands. Use `tidu service status` or `tidu service <start|stop|restart> <service-id|all>` from the CLI.

Before starting, `tidu:dev-p` checks the installed-runtime lock and default port. On conflict it stops and asks for `tidu service stop all && tidu uninstall --confirm DELETE`; it never removes data automatically.

Before switching to AI-Tidu9, the local runtime must be reachable and pass a minimal inference check. A failed check leaves or restores Official mode and reports the concrete error. A normal local development shutdown also restores Official mode when AI-Tidu9 mode is active.

## Verify and stop

```bash
npm run check
```

After development or testing, press `Ctrl+C` in the terminal running `tidu:dev-p`. Confirm that the local development process and its port have exited; do not leave test services running in the background.

When a local feature change also affects server deployment, update only the separate remote deployment document with the corresponding remote steps. Do not add remote operations to the local development workflow.

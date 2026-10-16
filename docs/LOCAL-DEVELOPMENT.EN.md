# Local development

[README](./README.EN.md) · [简体中文](./LOCAL-DEVELOPMENT.md) · [Contributing](./CONTRIBUTING.EN.md)

This document covers repository-local development only. Server and remote deployment steps are maintained separately in [Remote deployment](./REMOTE-DEPLOYMENT.EN.md).

## Start the development environment

Node.js 22.14 or newer is required:

```bash
npm run tidu:setup
npm run tidu:dev-p
```

`tidu:setup` installs repository development dependencies. `tidu:dev-p` starts the personal local development environment. The terminal prints one Vite URL shared by the page, API, and hot reload. The default port is `9639`; the next port is selected automatically when it is occupied.

Development data is stored in `.tidu-dev/tidu.sqlite`, isolated from globally installed data. Vite hot-reloads frontend source, and backend TypeScript changes restart the local runtime automatically.

## Local Codex configuration acceptance

The configuration page is the single upstream selector for the AI-Tidu9 virtual model. It lists official and company-provider models and accepts a custom model ID:

- **AI-Tidu9**: Codex gains one AI-Tidu9 virtual-model entry; its official or company upstream is selected on the configuration page.
- **Direct Official**: active AI-Tidu9-managed blocks are removed and Codex shows official models only.

AI-Tidu9 keeps only its original installation baseline and latest rollback point in its own backup directory; unrelated Codex configuration backups are never removed.

In development mode, the Services page shows only `tidu:dev-p` and `tidu:cli-p`, never the locally installed service rows. Before starting, `tidu:dev-p` checks the installed-runtime lock and default port. On conflict it stops and asks for `tidu service stop && tidu uninstall --confirm DELETE`; it never removes data automatically.

Before switching to AI-Tidu9, the local runtime must be reachable and pass a minimal inference check. A failed check leaves or restores Official mode and reports the concrete error. A normal local development shutdown also restores Official mode when AI-Tidu9 mode is active.

## Verify and stop

```bash
npm run check
```

After development or testing, press `Ctrl+C` in the terminal running `tidu:dev-p`. Confirm that the local development process and its port have exited; do not leave test services running in the background.

When a local feature change also affects server deployment, update only the separate remote deployment document with the corresponding remote steps. Do not add remote operations to the local development workflow.

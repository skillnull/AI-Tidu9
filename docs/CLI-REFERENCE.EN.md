# CLI Command Reference

[README](./README.EN.md) · [Examples](./EXAMPLES.EN.md) · [简体中文](./CLI-REFERENCE.md)

## ⚡ Three command forms

```bash
npx @skillnull/tidu start     # Ephemeral run; no global install
tidu --help                   # Top-level help after installation
tidu <command> --help         # Command-specific help
```

`tidu help <command>` is equivalent to `tidu <command> --help`. Help is resolved before execution, so it never starts a service, changes configuration, or triggers login.

## 🧭 Find a command by task

| I want to… | Start here | Then |
| --- | --- | --- |
| Try it for the first time | `npx @skillnull/tidu start` | Complete the browser-based setup |
| Configure entirely in a terminal | `tidu start --cli` | Follow the five-step interactive wizard |
| Connect installed clients | `tidu setup install` | Validate with `tidu setup verify` |
| Diagnose an unreachable page or unexpected behavior | `tidu doctor` | Use `tidu doctor --json` for a shareable report |
| Edit configuration without activating it | `tidu config set ...` | Add `--activate` only after review |
| Restore or remove everything | `tidu restore` / `tidu uninstall --complete` | Destructive deletion always requires explicit confirmation |

> [!TIP]
> You do not need to read the full reference first. Start with the command that matches the outcome; the CLI continues with guided prompts. Full flags exist for automation and expert workflows.

## 📋 Command overview

| Command | Purpose | State change |
| --- | --- | --- |
| `tidu start [--cli]` | Start the runtime; optionally enter the five-step terminal wizard | Starts a process; the wizard can save and activate configuration |
| `tidu setup [action]` | Install, verify, repair, update, or uninstall host connectors | All actions except `verify` can change connectors |
| `tidu mcp` | Run the stdio MCP bridge for Agent hosts | No |
| `tidu doctor` | Check runtime, configuration API, and page; optionally print a privacy-safe report | No |
| `tidu clients` | Discover supported local clients | No |
| `tidu clients connect/rollback codex` | Create or roll back the dedicated Codex profile | Yes, AI-Tidu9-owned files only |
| `tidu account` | Inspect reusable Codex and Cursor login state | No |
| `tidu account relogin/switch` | Invoke the host's official login or switch flow | Yes, only when explicitly run |
| `tidu config` | Guided configuration or isolated-draft management | `set` saves; only `--activate` changes runtime behavior |
| `tidu uninstall` | Recoverable uninstall, data purge, or complete cleanup | Yes, with confirmation |
| `tidu restore` | Restore the newest personal-data snapshot | Yes, with confirmation |
| `tidu enterprise recover-admin` | Generate a new administrator key on the server | Yes, with a security audit event |
| `tidu version` | Print the version | No |

## 🩺 Start and diagnose

```bash
tidu start [--cli]
tidu doctor [--json] [--endpoint <url>]
tidu mcp [--endpoint <url>]
```

`start` prints the configuration-center URL. With `--cli`, it checks the runtime, selects a mode, configures the unified entry, confirms activation, and installs detected connectors step by step. `doctor` makes no changes; `--json` prints a shareable summary without hostnames, credentials, paths, or conversation content. `mcp` is normally started by a configured host connector.

Common startup environment variables:

| Variable | Purpose |
| --- | --- |
| `TIDU_HOST`, `TIDU_PORT` | Listen address and port; personal mode defaults to loopback |
| `TIDU_DATABASE_PATH` | Custom SQLite path; lifecycle commands preserve it |
| `TIDU_PROVIDER`, `TIDU_PROVIDER_MODEL` | Provider type and model |
| `TIDU_PROVIDER_API_KEY`, `TIDU_PROVIDER_BASE_URL` | Runtime key and compatible API endpoint |
| `TIDU_POSTGRES_URL` | Enable the enterprise control plane and PostgreSQL task state |
| `TIDU_ENDPOINT` | Default CLI management URL, equivalent to `--endpoint` |

Inject secrets through the current process environment only. Never put them in shell history, configuration files, or `--reason`.

## 🔌 Connectors and clients

```bash
tidu setup [install|verify|repair|update|uninstall] [--endpoint <url>]
tidu clients
tidu clients connect codex [--yes] [--endpoint <url>]
tidu clients rollback codex [--yes]
```

The default setup action is `install`. Setup manages only AI-Tidu9-owned registrations, and setup uninstall retains AI-Tidu9 data. Discovery checks presence only; it never reads account, credential, or conversation content. Dedicated Codex profile operations create a private snapshot first and roll back after failed verification.

## 👤 Host accounts and login state

```bash
tidu account
tidu account status [codex|cursor]
tidu account relogin [codex|cursor]
tidu account switch [codex|cursor] [--yes]
```

Codex is the default host when none is specified. Status commands show only sanitized output from the official host CLI. AI-Tidu9 never reads or copies host tokens. Only `relogin` and `switch` invoke official host flows; `--yes` skips AI-Tidu9's own switch confirmation.

## ⚙️ Configuration management

```bash
tidu config [--endpoint <url>]
tidu config show [--endpoint <url>]
tidu config set --mode <managed|expert> \
  [--profile <id>] [--name <display-name>] [--activate] [--endpoint <url>]
```

- `config` opens the guided flow.
- `config show` prints the active snapshot and both isolated drafts.
- `config set` requires `--mode` and at least one of `--profile` or `--name`.
- `--activate` activates after saving. Without it, runtime behavior does not change.

## ♻️ Uninstall, restore, and roll back

```bash
tidu uninstall [--yes]
tidu uninstall --purge [--confirm DELETE]
tidu uninstall --complete [--confirm DELETE] [--endpoint <url>]
tidu restore [--yes]
```

| Mode | Result |
| --- | --- |
| Default uninstall | Move personal data to a recoverable snapshot; retain connectors and package |
| `--purge` | Permanently remove the default AI-Tidu9 data directory and snapshots |
| `--complete` | Also remove owned connectors, dedicated Codex profile and backups, default data, snapshots, and a detected global npm installation |
| `restore` | Restore the newest snapshot only when no current data directory exists |

Permanent operations require the full word `DELETE`; automation may pass `--confirm DELETE`. Host accounts, conversations, unrelated plugins or configuration, and custom database paths are preserved.

## 🏢 Enterprise host operation

```bash
TIDU_POSTGRES_URL='<private-url>' \
tidu enterprise recover-admin --reason '<non-secret audit reason>'
```

Run this only on a trusted server host. It generates a new one-time administrator key and records a security audit event. `--reason` is required and must not contain passwords, tokens, or other secrets.

## ℹ️ Version, help, and exit codes

```bash
tidu version
tidu --version
tidu -v
tidu help
tidu help config
tidu config set --help
```

Success returns exit code `0`. Invalid arguments, failed diagnostics, unhealthy connectors, and rejected safety checks return a non-zero code. Automation should inspect the exit code instead of matching output text alone.

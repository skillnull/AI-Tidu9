# CLI Command Reference

[README](./README.EN.md) · [Examples](./EXAMPLES.EN.md) · [简体中文](./CLI-REFERENCE.md)

## ⚡ Installation and command forms

```bash
npm install -g @skillnull/tidu  # Persistent install; provides the tidu command
tidu setup                      # Configure and offer to restart hosts
tidu --help                   # Top-level help after installation
tidu <command> --help         # Command-specific help
```

`tidu help <command>` is equivalent to `tidu <command> --help`. Help is resolved before execution, so it never starts a service, changes configuration, or triggers login.

## 🧭 Find a command by task

| I want to… | Start here | Then |
| --- | --- | --- |
| Try it for the first time | `tidu setup` | Restart when prompted, then use AI-Tidu9 directly |
| Configure entirely in a terminal | `tidu start --cli` | Follow the five-step interactive wizard |
| Connect installed clients | `tidu setup` | Install connectors while preserving official host models |
| Switch between AI-Tidu9, official, or third-party channels | `tidu channel list` | Execute explicitly with `tidu channel run` |
| Diagnose an unreachable page or unexpected behavior | `tidu doctor` | Use `tidu doctor --json` for a shareable report |
| Edit configuration without activating it | `tidu config set ...` | Add `--activate` only after review |
| Restore or remove everything | `tidu restore` / `tidu uninstall` | Destructive deletion always requires explicit confirmation |

> [!TIP]
> You do not need to read the full reference first. Start with the command that matches the outcome; the CLI continues with guided prompts. Full flags exist for automation and expert workflows.

## 📋 Command overview

| Command | Purpose | State change |
| --- | --- | --- |
| `tidu start [--cli]` | Start the service group for the installed edition; optionally enter the terminal wizard | Starts processes; an installed edition cannot switch to the other edition |
| `tidu service [status|start|stop|restart] [service-id|all]` | Inspect or control frontend, CLI, and API services | `status` is read-only; other actions change service state |
| `tidu setup [action]` | Install, verify, repair, update, or uninstall client connectors offline | All actions except `verify` can change client configuration |
| `tidu mcp` | Run the stdio MCP bridge for Agent hosts | No |
| `tidu doctor` | Check runtime, configuration API, and page; optionally print a privacy-safe report | No |
| `tidu clients` | Discover supported local clients | No |
| `tidu clients connect/switch/rollback codex` | Prepare, switch, or roll back mutually exclusive native Codex modes | Yes; the official account is unchanged and all managed settings are recoverable |
| `tidu channel list/run` | Inspect or invoke AI-Tidu9, official host, and provider channels | No; execution consumes the selected channel's quota |
| `tidu account` | Inspect reusable Codex and Cursor login state | No |
| `tidu account relogin/switch` | Invoke the host's official login or switch flow | Yes, only when explicitly run |
| `tidu config` | Guided configuration or isolated-draft management | `set` saves; only `--activate` changes runtime behavior |
| `tidu uninstall` | Remove all AI-Tidu9-owned connectors, profiles, data, and installed content | Yes, requires `DELETE` |
| `tidu restore` | Restore the newest personal-data snapshot | Yes, with confirmation |
| `tidu enterprise recover-admin` | Generate a new administrator key on the server | Yes, with a security audit event |
| `tidu version` | Print the version | No |

## 🩺 Start and diagnose

```bash
tidu start [--cli]
tidu service status [--endpoint <url>]
tidu service <start|stop|restart> <service-id|all> [--endpoint <url>]
tidu doctor [--json] [--endpoint <url>]
tidu mcp [--endpoint <url>]
```

The installed CLI is fixed to its installed edition: personal installations expose personal commands only, while enterprise installations expose enterprise commands only. Only a local repository checkout provides both `-p` and `-e` npm commands. Enterprise edition requires `TIDU_POSTGRES_URL` from the deployment environment. A personal edition connected to enterprise control remains read-only. `doctor` makes no changes; `--json` prints a privacy-safe summary.

Common startup environment variables:

| Variable | Purpose |
| --- | --- |
| `TIDU_HOST`, `TIDU_PORT` | Listen address and port; personal mode defaults to loopback |
| `TIDU_DATABASE_PATH` | Custom SQLite path; lifecycle commands preserve it |
| `TIDU_PROVIDER`, `TIDU_PROVIDER_MODEL` | Optional provider/model override; defaults to the current signed-in Codex or Cursor host model |
| `TIDU_PROVIDER_API_KEY`, `TIDU_PROVIDER_BASE_URL` | Runtime key and endpoint for an OpenAI-compatible provider override |
| `TIDU_POSTGRES_URL` | Enable the enterprise control plane and PostgreSQL task state |
| `TIDU_EDITION` | Installed runtime edition (`personal` or `enterprise`) |
| `TIDU_ENDPOINT` | Default CLI management URL, equivalent to `--endpoint` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Direct OpenAI API channel for CI or hostless environments |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | DeepSeek-compatible channel |
| `DASHSCOPE_API_KEY`, `DASHSCOPE_MODEL` | Alibaba Cloud Model Studio/Qwen channel |
| `ZHIPU_API_KEY`, `ZHIPU_MODEL` | Zhipu GLM channel |
| `MOONSHOT_API_KEY`, `MOONSHOT_MODEL` | Moonshot/Kimi channel |
| `ARK_API_KEY`, `ARK_MODEL` | Volcengine Ark/Doubao channel |
| `HUNYUAN_API_KEY`, `HUNYUAN_MODEL` | Tencent Hunyuan channel |
| `TIDU_CHANNEL_BASE_URL`, `TIDU_CHANNEL_API_KEY`, `TIDU_CHANNEL_MODEL` | Custom OpenAI-compatible channel |

Inject secrets through the current process environment only. Never put them in shell history, configuration files, or `--reason`.

## 🔌 Connectors and clients

```bash
tidu setup [install|verify|repair|update|uninstall] [--endpoint <url>]
tidu clients
tidu clients connect codex [--yes] [--endpoint <url>]
tidu clients switch codex <official|ai-tidu9> [--yes] [--endpoint <url>]
tidu clients rollback codex [--yes]
tidu-codex --install-desktop
tidu-codex --uninstall-desktop
```

The default setup action is `install` and does not require a prestarted runtime. It prepares a mutually exclusive native AI-Tidu9 Agent mode for Codex, installs the required transports for other hosts, and automatically starts every service in the installed edition while leaving direct Official mode active. `clients switch codex ai-tidu9` makes Codex show only “九门赛博提督”; tasks enter the same Agent kernel for planning, capability completion, execution, and independent verification. Official, company, and custom upstreams are mutually exclusive configuration choices and never become separate Codex entries. `clients switch codex official` restores the exact original official configuration and model list. Official Codex remains the authority for account identity, plan, and quota data. AI-Tidu9 keeps only its original installation baseline and latest rollback point.

On macOS, default-home setup prepares the native recovery relay and AI-Tidu9 mode registers it through `CODEX_CLI_PATH`; restart Codex to load it. `tidu-codex --install-desktop` also installs it explicitly. Official mode restores the previous executable override and uninstall removes only the owned launcher. The official CLI still executes commands and handles approvals. Recovery reads official session history without creating a separate conversation store.

Desktop startup organization-settings reads, daemon management, help, and protocol-generation commands run directly through the official CLI, preserving output and exit status. Only persistent stdio app-server sessions enter the recovery relay.

Codex uses a native Provider integration and does not register an AI-Tidu9 MCP server. Restart Codex after a mode switch so it reloads the Provider and model catalog. Cursor may use a stdio connector as its transport, but `route_tidu_task` still enters the same Agent kernel used by Codex, CLI, and OpenAI-compatible endpoints; the transport never bypasses planning, capability completion, or verification.

Enterprise servers do not run setup on employee computers or host a separate employee page. After installing the personal edition, an employee enters the administrator-provided company URL under Company access in the local page. Production company URLs must use HTTPS; HTTP is accepted only for loopback development. Company configuration stays read-only and is stored separately from personal drafts and active configuration.

## 👤 Host accounts and login state

```bash
tidu account
tidu account status [codex|cursor]
tidu account relogin [codex|cursor]
tidu account switch [codex|cursor] [--yes]
```

Codex is the default host when none is specified. Status commands show only sanitized output from the official host CLI. AI-Tidu9 never reads or copies host tokens. Only `relogin` and `switch` invoke official host flows; `--yes` skips AI-Tidu9's own switch confirmation.

## 🔀 Dual channels and CI

```bash
tidu channel list [--json] [--endpoint <url>]
tidu channel run tidu --input-file prompt.txt --json
tidu channel run codex --input-file prompt.txt [--model <id>] --json
tidu channel run cursor --input-file prompt.txt --json
tidu channel run qwen --input-file prompt.txt [--model <id>] --json
```

`tidu`, `codex`, and `cursor` select the virtual runtime, official Codex host, and official Cursor ACP respectively. Provider channels are `openai`, `deepseek`, `qwen`, `glm`, `kimi`, `doubao`, and `hunyuan`, plus `custom`. Selection is explicit and a failed channel never silently falls back to another provider.

For CI, prefer a provider API channel and keep its credential in the CI secret store:

```yaml
- name: Run AI-Tidu9 channel
  run: npx @skillnull/tidu channel run qwen --input-file .ci/prompt.txt --json > channel-result.json
  env:
    DASHSCOPE_API_KEY: ${{ secrets.DASHSCOPE_API_KEY }}
    DASHSCOPE_MODEL: qwen-plus
```

Codex and Cursor host channels are intended for developer machines with an existing official login. Headless CI does not reuse desktop credentials. After `tidu setup` and a Cursor restart, its connector transport enters the same AI-Tidu9 Agent kernel.

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
tidu uninstall [--confirm DELETE] [--endpoint <url>]
tidu restore [--yes]
```

`uninstall` removes AI-Tidu9 connectors, the dedicated Codex profile and backups, default data, snapshots, and a detected global npm installation. `restore` remains available only for recoverable snapshots created by older versions.

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

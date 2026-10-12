# Architecture Baseline

[简体中文](./architecture.md)

AI-Tidu9 follows a modular-monolith-first architecture with stable adapter boundaries and progressive decomposition. An individual can run one lightweight process. Later stages may split the gateway, scheduler, and workers for team or enterprise load without rewriting the core protocol.

## Current modules

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `packages/tidu/src/cli` | `tidu` command entry point | Handles interaction and process exit codes, not domain logic |
| `packages/tidu/src/core` | Product metadata, shared errors, and domain foundations | Independent of clients, model providers, and storage implementations |
| `packages/tidu/src/config` | Versioned configuration contracts and safe defaults | Managed and expert configurations must remain isolated |
| `packages/tidu/src/protocol` | Canonical Agent task and event protocol | Evolves through explicit versions without binding to one model |
| `packages/tidu/src/runtime` | Lightweight local HTTP runtime and static configuration-center entry | Listens on loopback by default and contains no model proxy or business orchestration |
| `packages/tidu/src/config-center` | Bootstrap-data contract for the local configuration center | Currently exposes read-only state without prematurely implementing configuration drafts |
| `packages/tidu/src/storage` | Storage adapters and persistence for AI-Tidu9 metadata | Keeps schema and SQL migrations language-neutral; the Node runtime uses its built-in SQLite adapter by default |

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

## Current limitations

The current primary runtime requires Node.js 22.14 or later. `tidu start` launches a lightweight `127.0.0.1` runtime and React + Vite local configuration center, applies language-neutral migrations through the Node SQLite adapter, and verifies runtime and storage through `/health`. The configuration center is currently read-only. Managed and expert drafts, the Python SDK, a usable model proxy, Agent execution loop, and enterprise deployment are not implemented yet.

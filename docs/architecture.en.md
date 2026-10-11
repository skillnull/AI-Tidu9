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

These modules belong to the single public package `@skillnull/tidu`. Directories preserve internal code boundaries without becoming separate npm packages. A new public package is extracted only after it has independent consumers, versioning, and a release lifecycle.

## Design constraints

- Clients, models, agents, Skills, MCP servers, tools, knowledge bases, and storage connect through adapters added in later stages.
- The core represents goals, capabilities, policies, tasks, events, and verifiable outcomes; it does not hard-code domain classification.
- Personal deployment remains resource-light by default. PostgreSQL, Redis, queues, and distributed workers are opt-in capabilities.
- Every model and tool egress must cross the same mandatory policy boundary; plugins and expert settings cannot bypass it.
- Configuration and protocols are versioned. Breaking changes require migration and rollback notes.

## Current limitations

`v0.1.0-alpha.1` establishes engineering, protocol, and configuration foundations only. It does not yet provide a usable model proxy, Agent execution loop, graphical interface, or enterprise deployment.

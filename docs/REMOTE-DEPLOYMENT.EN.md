# Remote deployment

[README](./README.EN.md) · [简体中文](./REMOTE-DEPLOYMENT.md)

This document covers only server, enterprise control-plane, and cross-device deployment. Use the [local development workflow](./CONTRIBUTING.EN.md#local-development-workflow) for repository development; the two workflows must remain separate.

## Enterprise single-node pilot

Inject the PostgreSQL password through the deployment system, then start the server runtime:

```bash
: "${TIDU_POSTGRES_PASSWORD:?inject with your deployment secret system}"
docker compose -f config/docker/compose.yml up --build
```

Verify the runtime and PostgreSQL on the server itself before enabling access:

```bash
curl -fsS http://127.0.0.1:9639/health
docker compose -f config/docker/compose.yml ps
```

## Cross-device boundary

- Bind container management ports to the server loopback interface only.
- Cross-device access must use an HTTPS reverse proxy, identity authentication, and organization access controls.
- The enterprise server does not run `tidu setup` for employee devices and does not take over personal Codex configuration.
- Employee devices connect through their local AI-Tidu9 client to the administrator-provided HTTPS endpoint; enterprise and personal configuration remain isolated.

## Pre-production checks

- Verify capacity, backup restoration, administrator-key rotation, upgrades, and rollback.
- Verify organization scope, audit logs, database persistence, and least privilege.
- Never expose the server management port directly to the public internet.

When a local development change affects server deployment, update this document and its Chinese counterpart without adding remote steps to the local development workflow.

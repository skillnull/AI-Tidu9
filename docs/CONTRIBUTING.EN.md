# Contributing

[README](./README.EN.md) · [Architecture](./ARCHITECTURE.EN.md) · [CLI Reference](./CLI-REFERENCE.EN.md) · [简体中文](./CONTRIBUTING.md)

Thank you for helping make AI-Tidu9 more reliable. Code, tests, documentation, compatibility validation, and reproducible reports are welcome. Every change should answer three questions: **what does it solve, what proves it, and how can it recover?**

## 🚀 The shortest contribution path

```bash
npm run tidu:setup
npm run check
```

## ♻️ Local development

The single source of truth for development startup, configuration, verification, and shutdown is the [Local development guide](./LOCAL-DEVELOPMENT.EN.md). This contributing guide contains collaboration and quality rules only.

> [!IMPORTANT]
> `main` and `support/*` are protected release lines. Only repository owner `@skillnull` may update or merge them. Everyone else contributes through a Pull Request and cannot merge it themselves.

## 🌿 Choose the right branch

Work branches use `<type>/[<issue>-]<kebab-description>`, for example `feat/123-model-routing`, `fix/quota-settlement`, or `docs/provider-guide`.

Allowed types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `security`.

| Release line | Accepts | Does not accept |
| --- | --- | --- |
| `main` | Future-facing features, architecture, fixes, and maintenance | Mechanical merges of legacy compatibility code |
| `support/<major>.x` | Bug, security, documentation, test, build, CI, and maintenance changes | Features, broad refactors, and architecture work |

- There is no `develop` or `release/*`; `main` is the sole future-facing integration trunk.
- Create `support/<major>.x` from the final old-major Tag only after `main` advances to the next incompatible major and the old major has an explicit maintenance commitment.
- A major has exactly one active owner: `main` or its `support` line, never both. Keep at most two active support lines.
- Protected release lines never merge into each other. Move applicable fixes through focused backport or forward-port PRs.
- Use lowercase branch names no longer than 80 characters. Delete merged work branches. Never force-push or rewrite protected history.

Validate the branch with `npm run policy -- branch`.

## 🎯 Keep the change reviewable

A strong PR is small enough for a reviewer to understand the complete causal chain in one pass.

| Required context | Expected evidence |
| --- | --- |
| Problem and user impact | Issue, reproduction, or explicit objective |
| Design and boundary | Why this layer owns the fix and what intentionally stays unchanged |
| Verification | Automated commands and real scenario results |
| Compatibility | Node, protocol, client, data, and public API impact |
| Risk and recovery | Security, privacy, cost, resource, migration, and rollback behavior |
| Documentation | Synchronized public Chinese and English content |

New dependencies, public APIs, protocols, retention rules, or policy-bypass capabilities require explicit design justification. Generated files must be reproducible. Large binaries and vendored dependencies require maintainer approval.

## ✍️ Commits and PR titles

Commit headers and PR titles follow Conventional Commits:

```text
type(scope)!: imperative description
```

Keep the header within 100 characters and omit a trailing full stop. Use `!` plus a `BREAKING CHANGE:` footer for incompatible changes. Keep commits focused, squash fixups before merge, and prefer squash merge with linear history. Authors cannot approve their own PRs; at least one non-author approval and every required CI check are required.

Validate a title with:

```bash
npm run policy -- commit "feat(scope): description"
```

## ✅ Quality and security gates

Run `npm run check` before submitting. It covers version policy, linting, Node tests, workspace tests, and Python SDK tests. Passing tests are the baseline; changes involving clients, databases, networking, or upgrade paths also require recorded real-environment validation.

Never commit credentials, personal data, private machine paths, account identifiers, internal domains, confidential artifacts, conversation bodies, unredacted diagnostics, irreproducible generated files, or unapproved large binaries.

Do not disclose vulnerabilities in public Issues. Use [GitHub Private Vulnerability Reporting](https://github.com/skillnull/AI-Tidu9/security/advisories/new). No change may weaken mandatory policy, quota, approval, Secret Gate, or independent acceptance verification.

## 📦 Versions and releases

Versions follow SemVer. Prereleases are limited to `alpha.N`, `beta.N`, and `rc.N`; Git Tags use `v<version>`.

- The private root workspace has no release version. Each public package owns its version and synchronizes internal references.
- This library workspace intentionally commits no dependency lockfile. Direct development dependencies remain exact, and CI resolves a fresh graph.
- Releases come only from immutable Tags matching the package version, never directly from mutable branches.
- Build once and promote the same verified artifact between channels.
- Before the first stable release, the newest public prerelease updates its channel and `latest`. Afterwards, only stable releases update `latest`.
- `npm run publish:tidu` prepares the version and Changelog, prints a concise summary, and requires exact-version confirmation.
- The release script pushes the release commit and waits for a successful branch `Quality` run, then pushes the immutable Tag and waits for its `Quality` run. Any remote failure stops the flow before npm publication.
- `npm run publish:tidu -- --dry-run` validates an already prepared release without writing, tagging, or publishing.
- Never commit release changes, push, tag, or publish without explicit maintainer confirmation.

Stable readiness is evidence-based, not popularity-based. Keep a public observation window open for at least 14 days. Resolve every actionable report through a fix, accepted-risk record, or unreproducible closure. Zero reports do not extend the window forever, but missing quality, dogfooding, upgrade, rollback, security, or compatibility evidence blocks approval.

## 🔒 Repository protection model

The active `Protect release lines — owner only` Ruleset protects `main` and `support/*`, grants bypass only to `@skillnull`, and requires stable `Policy` and `Verify` checks. Local Git Hooks provide early feedback; the remote Ruleset and required CI are authoritative.

Standards: [Semantic Versioning](https://semver.org/) · [Conventional Commits](https://www.conventionalcommits.org/)

# 九门赛博提督 · AI-Tidu9

**AI-Tidu9 · Intelligent Collaboration Hub**

AI-Tidu9 is an intelligent collaboration hub for cross-domain scenarios. It coordinates internal and external agents, models, tools, knowledge, and experts around a goal to deliver verifiable business outcomes.

[简体中文](../README.md)

## Status

The project is being rebuilt from an early AI rules package into an independent Super Agent platform. It is currently at the `v0.1.0-alpha.1` engineering-foundation stage and is not ready for production use.

## Direction

- Connect to Codex, Cursor, CLIs, and other clients as a virtual model.
- Execute Agent tasks independently of host presentation limits.
- Route models across quality, cost, privacy, quota, and availability constraints.
- Complete missing capabilities by combining low-cost and specialist models.
- Protect secrets and sensitive content at runtime.
- Support individuals, teams, and enterprises without restricting continued AI exploration.

## Local development

```bash
npm install
npm run check
npm test
node apps/cli/dist/index.js --help
```

The CLI package is named `tidu` and will provide the following command after publication:

```bash
npx tidu
```

See the [contribution guide](./CONTRIBUTING.md) for branch, commit, pull-request, version, and release rules. Local policy scripts and GitHub Actions enforce these rules.

## Release plan

See the [release plan](./RELEASE_PLAN.md) for development stages and acceptance status. This temporary file will be removed after final `v1.0.0` acceptance; actual release history will remain in the [changelog](./CHANGELOG.md) and Git tags.

See the [architecture baseline](./architecture.en.md) for module boundaries and current limitations.

## License

This project is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE). See the [trademark policy](./TRADEMARKS.md) and [NOTICE](../NOTICE) for branding and attribution terms.

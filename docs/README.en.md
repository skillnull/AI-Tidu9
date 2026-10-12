# 九门赛博提督 · AI-Tidu9

**AI-Tidu9 · Intelligent Collaboration Hub**

AI-Tidu9 is an intelligent collaboration hub for cross-domain scenarios. It coordinates internal and external agents, models, tools, knowledge, and experts around a goal to deliver verifiable business outcomes.

[简体中文](../README.md)

## Status

The project is being rebuilt from an early AI rules package into an independent Super Agent platform. It is currently in the engineering-foundation stage and is not ready for production use.

## Direction

- Connect to Codex, Cursor, CLIs, and other clients as a virtual model.
- Execute Agent tasks independently of host presentation limits.
- Route models across quality, cost, privacy, quota, and availability constraints.
- Complete missing capabilities by combining low-cost and specialist models.
- Protect secrets and sensitive content at runtime.
- Support individuals, teams, and enterprises without restricting continued AI exploration.

## Local development

Node.js 22.14 or later is required. The repository includes `.nvmrc`, and Git hooks automatically select the project Node version before running checks. Run `nvm install` once if that version is not installed yet.

```bash
npm install
npm run check
npm test
node packages/tidu/dist/cli/index.js --help
```

The official npm package is `@skillnull/tidu`; its installed command remains `tidu`:

```bash
npx @skillnull/tidu start
```

Open the local URL printed by the command to edit managed or expert configuration drafts. The two modes persist independently, and only “Activate this configuration” changes runtime behavior. Invalid or unsaved expert input cannot affect managed mode.

See the [contribution guide](./CONTRIBUTING.md) for branch, commit, pull-request, version, and release rules. Local policy scripts and GitHub Actions enforce these rules.

## Release plan

See the [release plan](./RELEASE_PLAN.md) for development stages and acceptance status. This temporary file will be removed after final `v1.0.0` acceptance; actual release history will remain in the [changelog](./CHANGELOG.md) and Git tags.

See the [architecture baseline](./architecture.en.md) for module boundaries and current limitations.

## License

This project is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE). See the [trademark policy](./TRADEMARKS.md) and [NOTICE](../NOTICE) for branding and attribution terms.

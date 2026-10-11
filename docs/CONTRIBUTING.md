# Contributing / 贡献指南

## Development / 开发

```bash
npm install
npm run check
```

## Branches / 分支

- `main` is protected. Only repository owner `@skillnull` may merge or otherwise update it. Everyone else must contribute through a pull request and cannot merge it themselves.
- Direct pushes by contributors, force pushes, branch deletion, and history rewrites are forbidden.
- Work branches use `<type>/[<issue>-]<kebab-description>`, for example `feat/123-model-routing` or `fix/quota-settlement`.
- Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `security`.
- There are no `develop` or `release/*` branches. `main` is the sole future-facing integration trunk.
- Create `support/<major>.x` only when `main` moves to the next incompatible major and the previous major has an explicit maintenance commitment.
- One major version has exactly one active owner: either `main` or `support/<major>.x`, never both. Keep at most two active support lines.
- Keep branch names lowercase and within 80 characters. Delete merged branches.

- `main` 是受保护分支，只有仓库所有者 `@skillnull` 可以合并或更新。其他贡献者只能提交PR，不能自行合并。
- 禁止贡献者直接推送、强制推送、删除主分支和改写历史。
- 工作分支采用 `<类型>/<事项编号>-<短横线描述>`，事项编号可省略。
- 不使用 `develop` 或 `release/*`。`main` 是唯一面向未来的集成主干。
- 只有当 `main` 进入下一个不兼容Major，且旧Major具有明确维护承诺时，才能从旧版最终Tag创建 `support/<major>.x`。
- 同一个Major只能由 `main` 或对应 `support` 唯一持有，不能同时存在；最多保留两条活跃维护线。
- 分支名使用小写且不超过80个字符，工作分支合并后删除。

Validate the current branch with `npm run policy -- branch`.

## Trunk and maintenance lines / 主干与维护线

- `main` contains the newest future-facing architecture and every fix still applicable to it. It is not a mechanical union of legacy compatibility code.
- `support/<major>.x` accepts only bug, security, documentation, test, build, CI, and maintenance changes. Features, broad refactors, and architecture work are forbidden.
- Never merge `support` into `main` or one protected line into another. Fix on `main` first when possible, then use a focused backport PR. For an old-version-only fix, use a focused forward-port PR only when the change remains applicable.
- Before creating `support/3.x`, publish the final v3 tag, advance `main` to v4, then create `support/3.x` from that v3 tag. This prevents dual ownership of v3.
- End-of-life the oldest support line and remove its branch before opening a third active line. Immutable release tags preserve its complete released history.

- `main` 保存面向未来的最新架构，以及所有对未来版本仍适用的修复；它不是历史兼容代码的机械合集。
- `support/<major>.x` 只接受缺陷、安全、文档、测试、构建、CI和维护变更，禁止新功能、大范围重构和架构演进。
- 禁止把 `support` 整体合并回 `main`，也禁止受保护版本线相互合并。优先在 `main` 修复，再通过聚焦的Backport PR回迁；仅旧版存在的问题，只在仍适用时通过Forward-port PR同步。
- 创建 `support/3.x` 前，必须先发布v3最终Tag，将 `main` 升至v4，再从v3 Tag创建维护线，避免v3双重所有权。
- 创建第三条维护线前，必须先将最旧维护线终止支持并删除其分支；完整发布历史由不可变Tag保留。

## Commits and pull requests / 提交与合并请求

- Commit headers and PR titles follow Conventional Commits: `type(scope)!: description`.
- Keep the header within 100 characters. Use an imperative, specific description without a trailing full stop.
- Use `!` and a `BREAKING CHANGE:` footer for incompatible changes.
- Keep commits focused. Squash fixups before merge; prefer squash merge and linear history.
- Every PR requires a linked context, tests, migration and rollback impact, security review, and synchronized bilingual documentation when applicable.
- At least one approving review and all required CI checks are required. Authors cannot approve their own PRs.

- Commit标题和PR标题采用 `type(scope)!: description`，长度不超过100个字符。
- 不兼容变更使用 `!`，并在正文中增加 `BREAKING CHANGE:`。
- 提交应保持原子性。合并前清理临时提交，优先使用Squash Merge和线性历史。
- PR必须说明背景、验证、兼容与回滚影响；适用时补齐安全检查和中英文文档。
- 至少获得一名非作者成员批准，并通过全部必需CI检查。

Validate a message with `npm run policy -- commit "feat(scope): description"`.

## Versions and releases / 版本与发布

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Pre-releases are limited to `alpha.N`, `beta.N`, and `rc.N`; tags use `v<version>`.
- The root workspace, every published package, internal dependency ranges, and lock file must use the same release version.
- A release requires a clean quality gate, updated changelog, migration and rollback notes, compatibility limits, and explicit maintainer approval.
- Publishing, tagging, or pushing a release without explicit confirmation is forbidden.
- Releases come from immutable `v<version>` tags, not mutable branches. A support line may publish only its own major. Build once and promote the same verified artifact between channels.
- `npm run publish:tidu` is the interactive release entry point. It prepares the next version and changelog, shows a concise release summary, allows edits, and requires the exact version as confirmation before committing, tagging, pushing, and publishing. `npm run publish:tidu -- --dry-run` only validates an already prepared release and never writes or publishes.

- 版本遵循语义化版本，预发布标识仅允许 `alpha.N`、`beta.N` 和 `rc.N`，Tag采用 `v<版本号>`。
- 根工作区、所有发布包、内部依赖和锁文件必须保持同一版本。
- 发版必须通过质量门禁，并同步变更记录、迁移、回滚和兼容性说明；未经明确确认不得发布、打Tag或推送。
- 正式版本从不可变 `v<版本号>` Tag发布，不直接部署可变分支。维护线只能发布自己的Major；同一Commit只构建一次，并在各渠道晋级同一份已验证制品。
- `npm run publish:tidu` 是唯一交互式发布入口：自动准备下一版本与变更记录、展示精简发布摘要、允许修改，并要求输入完整版本号确认后才提交、打Tag、推送和发布。`npm run publish:tidu -- --dry-run` 只校验已经准备完成的版本，不写入也不发布。

## Security and governance / 安全与治理

- Never report vulnerabilities in a public issue. Use the repository's private security advisory channel.
- Never commit secrets, personal data, private paths, internal domains, generated credentials, or confidential artifacts.
- Dependency updates must preserve the lock file and pass audit, license, test, and compatibility checks.
- New dependencies, public APIs, protocol changes, policy bypasses, and data-retention changes require explicit design justification.
- Generated files must be reproducible. Large binaries and vendored dependencies require maintainer approval.
- Copyright, license, trademark, and required `Powered by AI-Tidu9` attribution must be preserved.

- 安全漏洞不得通过公开Issue披露，应使用仓库私有安全通道。
- 禁止提交密钥、个人数据、私人路径、内部域名、生成凭据和机密产物。
- 依赖升级必须保留锁文件，并通过审计、许可证、测试和兼容性检查。
- 新依赖、公共API、协议变更、门禁绕过和数据保留策略变更必须说明设计依据。
- 生成文件必须可复现；大型二进制和内置第三方依赖需要维护者批准。
- 必须保留版权、许可证、商标和必要的 `Powered by AI-Tidu9` 署名。

## Required repository settings / 仓库必需设置

The active `Protect release lines — owner only` Ruleset restricts `main` and `support/*` updates to the sole bypass actor `@skillnull`. It requires the stable `Policy` and `Verify` checks. Local Git hooks provide early feedback, while the Ruleset and required CI are the authoritative merge gate.

远端已启用 `Protect release lines — owner only` Ruleset，对 `main` 与 `support/*` 应用同级保护，并仅将 `@skillnull` 加入绕过名单。稳定的 `Policy` 与 `Verify` 已设为必需检查。本地Git Hooks用于提前反馈，Ruleset和必需CI才是最终合并门禁。

## General requirements / 通用要求

- Keep changes focused and covered by relevant tests.
- Keep Chinese and English public documentation synchronized.
- Do not commit secrets, personal paths, account identifiers, internal domains, or company-confidential material.
- Document compatibility limits and migration impact.
- Do not weaken mandatory security, quota, approval, or verification gates.

- 改动应保持聚焦，并补充相关测试。
- 重要公开文档必须同步维护中英文版本。
- 禁止提交密钥、本机路径、账号标识、内部域名和公司机密内容。
- 兼容性限制和迁移影响必须明确记录。
- 不得削弱强制安全、额度、审批和验证门禁。

Standards / 参考规范：[Semantic Versioning](https://semver.org/), [Conventional Commits](https://www.conventionalcommits.org/).

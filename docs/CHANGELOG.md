# Changelog / 变更记录

All notable changes to AI-Tidu9 will be documented in this file.

九门赛博提督的重要变更将记录在本文件中。

## Unreleased / 未发布

- Add `tidu start` for one-command loopback startup with a verifiable health endpoint and graceful shutdown.
- 增加 `tidu start` 一条命令启动本地回环运行时，提供可验证健康检查与安全停止能力。
- Add built-in SQLite persistence for AI-Tidu9 metadata, with automatic initialization, private file permissions, WAL concurrency, schema-version validation, and no third-party database dependency.
- 增加九门自身元数据的内置SQLite持久化，支持自动初始化、私有文件权限、WAL并发与Schema版本校验，且不引入第三方数据库依赖。
- Define the SQLite schema and ordered migrations as a language-neutral contract, with `node:sqlite` isolated as the current Node adapter and a clear future path for Python `sqlite3` implementations.
- 将SQLite Schema与顺序迁移定义为语言无关契约，把 `node:sqlite` 隔离为当前Node适配器，并为未来Python `sqlite3` 实现保留明确路径。
- Raise the minimum runtime to Node.js 22.14 and verify the baseline on Node.js 22 in CI.
- 将最低运行时提升至Node.js 22.14，并在CI中验证Node.js 22基线。
- Add a lightweight React + Vite local configuration center with a bootstrap API, restrictive browser security headers, and packaged static assets served directly by `tidu start`.
- 增加轻量React + Vite本地配置中心、引导API、严格浏览器安全响应头和随npm包发布的静态资源，由 `tidu start` 直接提供访问。
- Add isolated managed and expert drafts with validation, optimistic concurrency, and explicit activation, keeping invalid or unsaved input away from the active runtime configuration.
- 增加普通与专家隔离草稿、配置校验、乐观并发控制与显式启用，确保错误或未保存输入不会影响当前运行配置。
- Add project-pinned Node selection for Git hooks so machines whose shell still defaults to Node.js 18 automatically use the required Node.js 22 runtime.
- 为Git Hook增加项目Node版本自动切换，使终端默认仍为Node.js 18的机器自动使用要求的Node.js 22运行时。

## 0.1.0-alpha.2 - 2026-10-11

- Rebuild the project from an early AI rules package into the AI-Tidu9 Super Agent platform.
- 将早期AI规则包重构为九门赛博提督超级Agent平台。
- Establish the `tidu` CLI, TypeScript workspaces, versioned configuration and protocol contracts, a shared error model, and automated quality gates.
- 建立 `tidu` CLI、TypeScript工作区、版本化配置与协议契约、统一错误模型和自动化质量门禁。
- Consolidate internal workspaces into the single public package `@skillnull/tidu` while preserving module boundaries.
- 将内部Workspace收敛为唯一公开包 `@skillnull/tidu`，同时保留模块边界。
- Add explicit `build:tidu` and version-aware `publish:tidu` package targets, plus a workspace-wide `build` entry point.
- 增加明确的 `build:tidu`、版本感知的 `publish:tidu` 包级目标，以及覆盖全部Workspace的 `build` 入口。
- Make `publish:tidu` prepare versions and changelog entries interactively before explicit release confirmation.
- 将 `publish:tidu` 改为交互式入口，在明确确认发布前自动准备版本与变更记录。
- Make `@skillnull/tidu` the single version source and derive the runtime CLI version from its package metadata.
- 以 `@skillnull/tidu` 作为唯一版本源，并从包元数据派生CLI运行时版本。
- Synchronize the published package version and release tag to Git only after npm publication succeeds.
- 仅在npm发布成功后，才将已发布包版本和发布Tag同步到Git远端。

### Upgrade notes / 升级说明

- The former `@skillnull/ai-tidu9` rule package and its post-install workflow are removed from this codebase. This alpha is a new platform baseline and does not provide an in-place migration path.
- 原 `@skillnull/ai-tidu9` 规则包及其安装后写入流程已从代码库移除。本Alpha版本是全新的平台基线，不提供原地升级路径。
- Do not replace an existing installation until a later release documents a tested migration and rollback path.
- 在后续版本提供经过验证的迁移与回滚路径前，请勿直接替换现有安装。

# Changelog / 变更记录

All notable changes to AI-Tidu9 will be documented in this file.

九门赛博提督的重要变更将记录在本文件中。

## Unreleased / 未发布

- Rebuild the project from an early AI rules package into the AI-Tidu9 Super Agent platform.
- 将早期AI规则包重构为九门赛博提督超级Agent平台。
- Establish the `tidu` CLI, TypeScript workspaces, versioned configuration and protocol contracts, a shared error model, and automated quality gates.
- 建立 `tidu` CLI、TypeScript工作区、版本化配置与协议契约、统一错误模型和自动化质量门禁。
- Consolidate internal workspaces into the single public package `@skillnull/tidu` while preserving module boundaries.
- 将内部Workspace收敛为唯一公开包 `@skillnull/tidu`，同时保留模块边界。
- Add a version-aware `publish:tidu` gate and consolidate repository policy commands.
- 增加版本感知的 `publish:tidu` 门禁，并合并仓库策略命令。

### Upgrade notes / 升级说明

- The former `@skillnull/ai-tidu9` rule package and its post-install workflow are removed from this codebase. This alpha is a new platform baseline and does not provide an in-place migration path.
- 原 `@skillnull/ai-tidu9` 规则包及其安装后写入流程已从代码库移除。本Alpha版本是全新的平台基线，不提供原地升级路径。
- Do not replace an existing installation until a later release documents a tested migration and rollback path.
- 在后续版本提供经过验证的迁移与回滚路径前，请勿直接替换现有安装。

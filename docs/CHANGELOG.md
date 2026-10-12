# Changelog / 变更记录

All notable changes to AI-Tidu9 will be documented in this file.

九门赛博提督的重要变更将记录在本文件中。

## Unreleased / 未发布

- Adopt a lockfile-free library workspace with exact direct dependencies, fresh CI resolution, and release tooling that no longer couples package versions to `package-lock.json`.
- 采用无锁文件的库工作区策略，直接依赖保持精确版本，CI每次重新解析依赖，发布工具不再将包版本与 `package-lock.json` 耦合。
- Unify Node.js selection across installation, development commands, release tooling, and Git hooks, with automatic discovery through NVM, Homebrew, fnm, mise, asdf, and Volta.
- 统一安装、开发命令、发布工具与Git Hook的Node.js选择，并自动发现NVM、Homebrew、fnm、mise、asdf与Volta中的兼容版本。
- Synchronize the npm package and bundled Codex connector manifest versions in one atomic release transaction.
- 在同一原子发布事务中同步npm包与随包交付的Codex连接器清单版本。
- Keep npm `latest` aligned with the newest public prerelease until the first stable version exists, while preserving independent `alpha`, `beta`, and `rc` channel tags.
- 在首个稳定版本发布前，让npm `latest` 跟随最新公开预发布版本，同时保留独立的 `alpha`、`beta` 与 `rc` 渠道标签。
- Add the versioned canonical task aggregate and append-only Agent event envelope with normalized goals, acceptance criteria, lifecycle status, task-local ordering, non-sensitive sources, timestamps, and strict boundary validation.
- 增加版本化统一任务聚合与追加式Agent事件包络，支持规范化目标、验收条件、生命周期状态、任务内顺序、非敏感来源、时间信息和严格边界校验。
- Add the independent bounded Agent kernel with model-driven understanding, planning and replanning, deterministic execution budgets, tool approval gates, pause/resume/cancel controls, independent acceptance verification, minimal evidence, and derived trust levels.
- 增加独立有界Agent内核，支持模型驱动的目标理解、规划与重规划、确定性执行预算、工具审批门禁、暂停/恢复/取消、独立结果验收、最小证据包与可信等级。
- Persist restart-safe task capsules through the language-neutral SQLite schema while limiting each capsule to 256 KB and excluding full conversations, raw model responses, and large tool output.
- 通过语言无关SQLite Schema持久化可恢复任务胶囊，单胶囊限制为256 KB，并排除完整对话、原始模型响应与大块工具输出。
- Add a provider-backed Agent adapter for configured OpenAI-compatible or Ollama models, plus local task APIs and a compact task-control view for progress, budgets, approvals, recovery, and cancellation.
- 为已配置的OpenAI兼容或Ollama模型增加Agent适配器，并提供本地任务API与紧凑任务控制视图，用于进度、预算、审批、恢复和取消操作。

## 0.2.0-alpha.1 - 2026-10-12

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
- Refine the local configuration center into a compact, fine-weight operations interface and define personal, centralized-enterprise, and hybrid-enterprise deployment boundaries.
- 将本地配置中心调整为紧凑细字重的专业操作界面，并明确个人本地、公司集中与公司混合三类部署边界。
- Embed personal setup and troubleshooting guidance, plus a clearly marked enterprise-onboarding blueprint that will be generated from live company configuration when enterprise deployment ships.
- 内置个人安装、使用与排障指南，并提供明确标注的企业接入蓝图；企业部署完成后将根据公司实际配置动态生成。
- Define the enterprise administrator access-key lifecycle: one-time display, irreversible database verifier, key-gated sessions, authenticated rotation, revocation, and audited host recovery.
- 定义公司管理员访问密钥生命周期：仅展示一次、数据库保存不可逆校验值、密钥门禁会话、重新认证后轮换、撤销与服务器本机审计恢复。
- Add `tidu doctor` health diagnostics, a guided `tidu config` fallback, read-only configuration inspection, and advanced API-backed draft updates with optional activation.
- 增加 `tidu doctor` 健康诊断、引导式 `tidu config` 兜底、只读配置查看，以及基于管理API并可选启用的高级草稿更新。
- Expose the active virtual model through OpenAI-compatible model discovery, Chat Completions, and Responses endpoints with stable errors, request IDs, and mandatory AI-Tidu9 attribution.
- 通过OpenAI兼容的模型发现、Chat Completions和Responses端点暴露当前虚拟模型，提供稳定错误、请求ID和强制AI-Tidu9署名。
- Add real OpenAI-compatible and local Ollama adapters, runtime-only credential handling, safe provider status, and virtual-model response normalization.
- 增加真实OpenAI兼容与本地Ollama适配器、仅运行时密钥处理、安全供应商状态和虚拟模型响应归一化。
- Add recoverable personal uninstall, latest-snapshot restore, protected permanent purge, running-runtime checks, and custom-path safeguards.
- 增加可恢复的个人版卸载、最近快照恢复、受保护的永久清除、运行中检测和自定义路径保护。
- Add end-to-end SSE streaming, upstream cancellation, virtual-model event rewriting, and baseline function-tool interoperability for OpenAI-compatible services and Ollama.
- 为OpenAI兼容服务与Ollama增加端到端SSE流式、上游取消、虚拟模型事件改写和基础函数工具互操作。
- Add metadata-only discovery for local Codex, Cursor, and OpenAI CLI installations through the CLI and configuration center, with honest readiness and limitation states.
- 在CLI与配置中心增加本机Codex、Cursor和OpenAI CLI的纯元数据发现，并真实展示可配置、受限与未发现状态。
- Add an explicitly confirmed Codex integration transaction using a dedicated profile, private snapshots, atomic writes, connectivity verification, automatic failure rollback, and manual latest-snapshot restoration.
- 增加需明确确认的Codex接入事务，使用独立Profile、私有快照、原子写入、连通验证、失败自动回滚与最近快照手动恢复。
- Add a credential-free host-account bridge contract, multiple account profiles, immutable per-task account snapshots, and strict mismatch rejection without reading host login files.
- 增加无凭据宿主账号桥协议、多账号Profile、任务级不可变账号快照和严格错配拒绝，不读取宿主登录文件。
- Add default reuse of an existing Codex login through Codex-owned storage metadata, the official status command, and an app-server launch contract; add explicit re-login and confirmed account switching without reading or copying tokens.
- 通过Codex自有认证存储元数据、官方状态命令与app-server启动契约默认复用现有登录；增加显式重新登录和确认式账号切换，全程不读取或复制Token。
- Add current-account reuse discovery, explicit re-login and switching commands, and an official ACP launch contract for Cursor Agent without reading or copying Cursor credentials.
- 为Cursor Agent增加当前账号复用发现、显式重新登录与切换命令以及官方ACP启动契约，不读取或复制Cursor凭据。
- Distinguish native Agent bridges from OpenAI-compatible virtual-model fallback so chat-only compatibility is never presented as complete host capability.
- 区分原生Agent桥与OpenAI兼容虚拟模型回退，禁止把仅聊天兼容宣称为宿主完整能力。
- Add one `tidu setup` flow for install, verify, repair, update, and uninstall across Codex, Cursor, browser management, and generic OpenAI-compatible entries.
- 增加统一 `tidu setup` 流程，对Codex、Cursor、浏览器管理和通用OpenAI兼容入口执行安装、验证、修复、更新与卸载。
- Add bounded stdio JSON-RPC, a packaged MCP server and Agent Plugin, plus complete Codex app-server and Cursor ACP adapters for capability negotiation, sessions, streaming, cancellation, permissions, and fail-closed interactions.
- 增加有界stdio JSON-RPC、随包MCP服务与Agent Plugin，并完成Codex app-server和Cursor ACP的能力协商、会话、流式、取消、权限及失败关闭交互适配。
- Add a usage-observation contract that keeps provider-authoritative, host-reported, and locally estimated usage visibly distinct during reconciliation.
- 增加用量观测契约，在对账时明确区分供应商官方数据、宿主报告与本地估算。
- Verify the dedicated virtual-model profile through a real Codex CLI turn and add Responses custom, namespace, and web-search tool compatibility discovered during that test.
- 通过真实Codex CLI对话验证独立虚拟模型Profile，并补齐联调发现的Responses自定义工具、命名空间与网页搜索工具兼容。
- Make the root TypeScript project own IDE type checking for library, UI, and Vite configuration while keeping emission in one explicit build configuration.
- 由根TypeScript工程统一负责库、UI与Vite配置的IDE类型检查，同时使用一个明确构建配置保持现有产物路径。
- Add the security-critical core of the official Sign in with ChatGPT path: dynamic registration and returning-account PKCE requests, constant-time callback state checks, code exchange without a client secret, trusted OpenID discovery, RS256 ID-token validation, and explicit plan-scope verification.
- 增加ChatGPT官方登录路径的安全核心：动态注册与已有账号PKCE请求、恒定时间Callback State校验、无Client Secret换码、受信OpenID发现、RS256身份令牌校验和明确套餐权限校验。

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

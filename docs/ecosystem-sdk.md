# 开放能力生态 / Open Capability Ecosystem

## 中文

Stage 8 将模型、Agent、客户端、存储和历史接入统一为 Capability Provider Protocol 1.0。TypeScript SDK 随 `@skillnull/tidu` 发布，使用 `@skillnull/tidu/ecosystem` 导入；Python SDK 位于 `sdk/python`，保持零运行时依赖并通过九门平台 API 工作，不复制控制平面。

Provider Manifest 必须声明稳定标识、SemVer 版本、协议版本、适配器类型、能力、最小权限、来源和信任等级。可选的 SHA-256 完整性、Ed25519 签名与依赖约束在安装或启用前验证。企业私有、本地和官方目录可以同时存在，默认解析顺序为企业私有、本地、官方，也可以由调用方明确覆盖。

Skill 与 MCP 发现只读取显式根目录内的 `SKILL.md`、`mcp.json` 或 `.mcp.json` 元数据，受深度和条目数限制，不跟随符号链接，也不会在发现阶段执行扩展。权限未授权即拒绝。标记为不可信的扩展必须通过外部隔离执行器，并返回进程、文件系统和网络限制的运行时证明；没有符合要求的隔离器时默认拒绝执行。Node `vm` 或普通 Worker 不被视为安全沙箱。

第三方 Agent 委派要求 `agent.delegate` 权限，并强制限制轮次、工具调用数、时间和输出大小。`testCapabilityProvider` 可供扩展作者执行协议、完整性与冒烟测试；完整示例位于 `packages/tidu/src/ecosystem/example-provider.ts`。

### 兼容与迁移策略

- 协议版本遵循 SemVer。补丁版本只修复兼容问题；次版本只增加可选字段或能力；主版本才允许破坏性变化。
- SDK 在同一协议主版本内保持源代码兼容。废弃项至少跨越一个次版本，并在变更记录中给出替代 API、迁移示例和回滚方法。
- Provider 必须声明协议版本；运行时对未知主版本失败关闭，不进行猜测性兼容。
- Manifest 新字段默认必须可选。安全语义发生变化时不得静默降级，必须通过新协议版本或显式能力协商。
- 正式移除 API 前，官方适配器、TypeScript SDK、Python SDK、测试工具和文档必须在同一发布中完成迁移。

## English

Stage 8 unifies model, Agent, client, storage, and history integrations under Capability Provider Protocol 1.0. The TypeScript SDK ships with `@skillnull/tidu` and is imported from `@skillnull/tidu/ecosystem`. The zero-runtime-dependency Python SDK lives in `sdk/python` and uses AI-Tidu9 platform APIs instead of duplicating the control plane.

Every provider manifest declares a stable identity, SemVer version, protocol version, adapter kind, capabilities, least-privilege permissions, catalog source, and trust level. Optional SHA-256 integrity, Ed25519 signatures, and dependency constraints are verified before installation or activation. Enterprise-private, local, and official catalogs coexist; default resolution prefers enterprise, then local, then official, and callers may provide another explicit order.

Skill and MCP discovery reads only `SKILL.md`, `mcp.json`, and `.mcp.json` metadata under explicit roots. Traversal is depth- and entry-bounded, does not follow symbolic links, and never executes an extension. Missing permission grants fail closed. An untrusted extension must cross an external isolation executor and return runtime attestation for process, filesystem, and network controls; execution is denied when no compliant sandbox exists. Node `vm` and ordinary Workers are not treated as security sandboxes.

Third-party Agent delegation requires `agent.delegate` and immutable turn, tool-call, time, and output bounds. Extension authors can use `testCapabilityProvider` for protocol, integrity, and smoke checks; a complete example is in `packages/tidu/src/ecosystem/example-provider.ts`.

### Compatibility and migration policy

- Protocol versions follow SemVer. Patch releases contain compatible fixes, minor releases add only optional fields or capabilities, and breaking changes require a major version.
- SDKs remain source-compatible within a protocol major. Deprecations span at least one minor release and include a replacement API, migration example, and rollback guidance in the changelog.
- Providers declare their protocol version. Runtimes fail closed on an unknown major instead of guessing compatibility.
- New manifest fields are optional by default. Security-semantic changes never silently downgrade and require a new protocol version or explicit capability negotiation.
- Before an API is removed, official adapters, TypeScript SDK, Python SDK, testing tools, and documentation migrate in the same release.


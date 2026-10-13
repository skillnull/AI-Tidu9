# 集成发布候选 / Integrated release candidate

本页是 `v0.9.0-rc.N` 的公开验收入口。自动化只能证明可重复的工程事实；长期本机使用、小团队试点和分享材料必须提供人工评审证据，不能由测试结果代替。`assessReleaseCandidate` 会把两类证据分开，并在任一门禁缺失时拒绝进入发布确认。

This page is the public acceptance entry for `v0.9.0-rc.N`. Automation proves only repeatable engineering facts. Long-term local use, small-team pilots, and local sharing materials require reviewed evidence and cannot be replaced by test output. `assessReleaseCandidate` keeps both evidence classes separate and denies release readiness while any gate is missing.

## 验证命令 / Verification command

```bash
npm run verify:rc
```

该命令执行版本策略、Lint、完整测试、Python SDK测试、npm文件清单校验、公开文件隐私扫描和中英文文档完整性检查。它不会读取宿主凭据、会话正文或企业私有数据。

The command runs version policy, lint, the complete test suite, Python SDK tests, npm file-list validation, a public-file privacy scan, and bilingual-document checks. It does not read host credentials, conversation content, or enterprise-private data.

## 升级与回滚 / Upgrade and rollback

- 支持从最近公开版本升级到同一主版本的新候选版。发版前必须验证SQLite顺序迁移、PostgreSQL迁移、连接器版本同步和Python SDK版本同步。
- 个人配置启用失败会恢复上一健康版本；卸载快照可通过 `tidu restore` 恢复。连接器写入失败只回滚九门自有配置。
- 生产Worker采用先排空再升级；失败时恢复上一运行版本。数据库回滚不执行破坏性降级，而是恢复兼容应用版本和已验证快照。
- 跨主版本升级不在当前承诺范围内，必须提供独立迁移工具和回滚说明。

- Upgrades from the latest public release to a newer candidate in the same major are supported. Release qualification verifies ordered SQLite migrations, PostgreSQL migrations, connector version synchronization, and Python SDK version synchronization.
- Failed personal-profile activation restores the previous known-good version; uninstall snapshots are restored with `tidu restore`. A failed connector write rolls back only AI-Tidu9-owned configuration.
- Production workers drain before upgrade and restore the previous runtime version on failure. Database rollback uses a compatible application version and a verified snapshot rather than destructive down-migrations.
- Cross-major upgrades are not currently promised and require a dedicated migration tool and rollback guide.

## 安全与隐私 / Security and privacy

- 模型和工具出口必须经过Secret Gate；未授权能力、不可信扩展和未知协议版本默认拒绝。
- 公开扫描拒绝真实本机路径、私钥和常见访问令牌形态；npm包拒绝测试、环境文件、Git元数据和密钥文件。
- 九门不复制Codex、Cursor或浏览器私有Token。企业策略不能只依靠客户端自觉执行，服务端出口和组织网络仍需强制门禁。
- 自动化扫描不能证明第三方供应商、外部沙箱或企业网络绝对安全；这些边界必须在目标环境独立评审。

- Every model and tool egress crosses Secret Gate. Unauthorized capabilities, untrusted extensions, and unknown protocol majors fail closed.
- Public scans reject real local paths, private keys, and common access-token shapes. npm contents reject tests, environment files, Git metadata, and key files.
- AI-Tidu9 does not copy private Codex, Cursor, or browser tokens. Enterprise enforcement cannot rely on voluntary client behavior; server egress and organizational network controls remain mandatory.
- Automated scans cannot prove that third-party providers, external sandboxes, or enterprise networks are absolutely secure. Those boundaries require review in the target environment.

## 迁移说明 / Migration notes

从 `0.8.0-beta.1` 进入 `0.9.0-rc.N` 不改变SQLite或PostgreSQL Schema。升级只替换应用与SDK文件，并增加RC验收API和维护者门禁。升级前保留个人快照或企业数据库备份；升级后依次运行 `tidu doctor`、`tidu setup verify` 和 `npm run verify:rc`。回滚时重新安装 `0.8.0-beta.1` 并恢复升级前快照，不执行数据库降级SQL。

Moving from `0.8.0-beta.1` to `0.9.0-rc.N` does not change the SQLite or PostgreSQL schema. The upgrade replaces application and SDK files and adds the RC qualification API plus maintainer gates. Preserve a personal snapshot or enterprise database backup before upgrading, then run `tidu doctor`, `tidu setup verify`, and `npm run verify:rc`. Rollback reinstalls `0.8.0-beta.1` and restores the pre-upgrade snapshot without executing database down-migrations.

## 最终兼容与限制 / Final compatibility and limitations

| 入口或能力 | RC覆盖 | 限制 |
| --- | --- | --- |
| Codex | MCP、虚拟模型Profile、app-server协议与真实账号历史证据 | 自定义虚拟模型的宿主展示由Codex决定 |
| Cursor | MCP与ACP协议自动化回归 | 桌面端登录不能复制为Agent CLI凭据；真实ACP回合需要CLI已登录 |
| 通用OpenAI客户端 | Models、Chat Completions、Responses、SSE与工具调用 | 客户端私有扩展需逐项验证 |
| Ollama | 本地上游模型、流式和工具协议转换 | 不提供宿主账号、IDE会话或权限系统 |
| 企业控制平面 | PostgreSQL、组织策略、额度、管理员门禁与Docker | Scheduler高可用和目标环境容量仍需部署方验证 |
| 开放能力生态 | Manifest、签名、权限、目录和有界委派 | 不可信执行依赖外部生产沙箱适配器 |

| Entry or capability | RC coverage | Limitation |
| --- | --- | --- |
| Codex | MCP, virtual-model profile, app-server protocol, and historical real-account evidence | Codex controls how custom virtual models are presented |
| Cursor | Automated MCP and ACP protocol regression | Desktop login cannot be copied into Agent CLI; a real ACP turn requires an authenticated CLI |
| Generic OpenAI clients | Models, Chat Completions, Responses, SSE, and tool calls | Client-private extensions require individual verification |
| Ollama | Local upstream model, streaming, and tool-protocol translation | No host account, IDE session, or permission system |
| Enterprise control plane | PostgreSQL, organization policy, quota, administrator gate, and Docker | Scheduler HA and target-environment capacity still require deployment review |
| Open capability ecosystem | Manifest, signature, permission, catalog, and bounded delegation | Untrusted execution requires an external production sandbox adapter |

## 发布边界 / Release boundary

`v0.9.0-rc.N` 冻结大型新功能，只接受缺陷、安全、兼容、测试和文档修正。候选版通过并不等于 `v1.0.0`；正式版仍要求真实团队试点验收、无阻断问题、最新RC升级成功以及最终验收确认。

`v0.9.0-rc.N` freezes large features and accepts only defect, security, compatibility, test, and documentation corrections. A qualified candidate is not `v1.0.0`; stable release still requires an accepted real-team pilot, no blocking issue, a successful latest-RC upgrade, and explicit final acceptance.

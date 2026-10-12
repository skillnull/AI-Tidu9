# AI-Tidu9 Release Plan · 九门赛博提督发版计划

> Temporary public-safe execution checklist. Remove after `v1.0.0` final acceptance; preserve actual history in `docs/CHANGELOG.md` and Git tags.
>
> 临时公开工程清单。`v1.0.0` 最终验收后删除；实际发布历史永久保留在 `docs/CHANGELOG.md` 与 Git Tag 中。

## Product baseline / 产品基线

- **Name / 名称：** 九门赛博提督
- **Explanation / 产品解释：** 九门赛博提督·智能协作中枢
- **Positioning / 产品定位：** 九门赛博提督是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。
- **Release model / 发布方式：** `nightly → alpha → beta → rc → stable`
- **Versioning / 版本规范：** Semantic Versioning / 语义化版本

## Checklist rules / 勾选规则

An item is complete only after implementation, automated tests, real-scenario verification, security review, bilingual documentation, known-limit recording, and rollback verification when applicable.

一个事项只有在实现、自动化测试、真实场景验证、安全检查、中英文文档、已知限制和必要的回滚验证全部完成后才能勾选。

- [ ] Never mark code-only work as complete / 仅完成代码不得勾选
- [ ] Never include private or company-confidential data / 不记录私人或公司机密
- [ ] Do not create or push a release tag without explicit confirmation / 未确认不得创建或推送正式 Tag
- [ ] Keep `docs/CHANGELOG.md` synchronized with every release / 每次发布同步更新 `docs/CHANGELOG.md`
- [ ] Record real compatibility limits / 如实记录兼容性边界
- [x] Implement protected-trunk, single-major ownership, maintenance-line, and immutable-tag checks / 实现主干、Major单一所有权、维护线与不可变Tag校验
- [x] Activate `Policy` and `Verify` as required remote checks after the confirmed first push / 首次确认推送后将`Policy`和`Verify`设为远端必需检查

## Stage 0 — Baseline audit / 阶段0：项目基线审计

Release: no public version. Preserve a local baseline reference only after confirmation.

- [x] Inspect repository status and preserve existing work / 检查工作树并保护已有改动
- [x] Inventory source, configuration, skills, and package contents / 盘点源码、配置、Skill与包内容
- [x] Run JavaScript syntax validation / 运行JavaScript语法检查
- [x] Run npm package dry-run / 运行npm打包预检
- [x] Produce baseline architecture and risk report / 输出基线架构与风险报告
- [x] Confirm keep/refactor/remove scope / 确认保留、重构和删除范围
- [x] Establish reproducible baseline checks / 建立可重复基线检查
- [x] Obtain user acceptance for Stage 0 / 获得阶段0验收确认

## v0.1.0-alpha.1 — Engineering foundation / 工程基础预览版

Audience: maintainers and internal contributors only.

- [x] Replace legacy product wording and remove rejected slogan / 替换旧定位并移除已否决口号
- [x] Publish concise Chinese and English README entry points / 完成精简中英文README入口
- [x] Replace MIT metadata with AGPL-3.0-only / 将MIT元数据替换为AGPL-3.0-only
- [x] Add `NOTICE`, `docs/TRADEMARKS.md`, and `docs/CONTRIBUTING.md` / 增加必要治理文件
- [x] Define reasonable AI-Tidu9 attribution rules / 明确合理署名规则
- [x] Establish modular-monolith boundaries / 建立模块化单体边界
- [x] Establish versioned configuration schema / 建立版本化配置Schema
- [x] Establish shared error model / 建立统一错误模型
- [x] Create `tidu` CLI skeleton / 创建 `tidu` CLI骨架
- [x] Add build, lint, typecheck, and test foundations / 建立构建、Lint、类型检查和测试基础
- [x] Add bilingual changelog and upgrade notes / 增加双语变更记录与升级说明
- [x] Pass release quality gates / 通过发布质量门禁
- [x] Receive release confirmation / 获得发布确认

## v0.2.0-alpha.1 — Zero-config personal entry / 零配置个人入口

Audience: owner and invited developers.

- [x] Support one-command local startup / 支持一条命令本地启动
- [x] Use a language-neutral SQLite contract with a default Node adapter / 使用语言无关SQLite契约与默认Node适配器
- [x] Provide local configuration center / 提供本地配置中心
- [x] Add isolated normal and expert configuration drafts / 增加隔离的普通与专家配置草稿
- [ ] Expose OpenAI-compatible virtual-model endpoint / 提供OpenAI兼容虚拟模型端点
- [ ] Integrate at least two real provider types / 接入至少两类真实供应商
- [ ] Support streaming responses and baseline tool calls / 支持流式响应和基础工具调用
- [ ] Detect supported local clients / 自动发现受支持客户端
- [ ] Back up, write, test, and roll back client configuration / 备份、写入、测试和回滚客户端配置
- [ ] Implement host-account bridge contract / 实现宿主账号桥协议
- [ ] Implement official ChatGPT account connection path / 实现ChatGPT官方账号连接路径
- [ ] Support multiple account profiles and task account snapshots / 支持多账号Profile与任务账号快照
- [ ] Distinguish provider-authoritative usage from local estimates / 区分官方用量与本地估算
- [ ] Verify Codex, Cursor, and generic client behavior honestly / 真实验证Codex、Cursor与通用客户端
- [ ] Publish compatibility matrix and known limits / 发布兼容矩阵与已知限制
- [ ] Pass release quality gates / 通过发布质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.3.0-alpha.1 — Independent Agent kernel / 独立Agent内核

- [ ] Define canonical task and event models / 定义统一任务与事件模型
- [ ] Implement goal understanding and dynamic planning / 实现目标理解与动态规划
- [ ] Implement bounded Agent execution loop / 实现有界Agent执行循环
- [ ] Implement tool execution and human approval / 实现工具执行与人工确认
- [ ] Implement lightweight task capsule / 实现轻量任务胶囊
- [ ] Implement checkpoints, pause, resume, and cancellation / 实现检查点、暂停、恢复和取消
- [ ] Enforce per-task resource budgets / 强制执行任务资源预算
- [ ] Implement result acceptance criteria / 实现结果验收条件
- [ ] Implement minimal evidence package and trust level / 实现最小证据包与可信等级
- [ ] Provide task control view / 提供任务控制视图
- [ ] Verify worker interruption and safe recovery / 验证Worker中断与安全恢复
- [ ] Pass release quality gates / 通过发布质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.4.0-beta.1 — Core differentiators / 核心竞争能力公开测试版

- [ ] Implement configurable dynamic model routing / 实现可配置动态模型路由
- [ ] Implement opt-in capability-completion pool / 实现可选能力补全池
- [ ] Coordinate main and specialist models / 实现主模型与专家模型协作
- [ ] Score cost, capability, privacy, latency, and availability / 联合评估成本、能力、隐私、延迟和可用性
- [ ] Fall back after quota exhaustion / 实现额度耗尽回退
- [ ] Support free and local models / 支持免费模型与本地模型
- [ ] Assemble Agent, Skill, MCP, tool, and knowledge capabilities on demand / 按需组装能力资产
- [ ] Implement runtime Secret Gate auto-detection / 实现运行时Secret Gate自动识别
- [ ] Implement explicit blocking rules / 实现指定拦截规则
- [ ] Implement local placeholder recovery and concurrency isolation / 实现本地替换恢复与并发隔离
- [ ] Ensure every model and tool egress crosses mandatory policy gates / 保证所有模型与工具出口经过门禁
- [ ] Complete verifiable result loop / 完成可验证结果闭环
- [ ] Publish real cost and capability-completion case / 发布真实成本与能力补全案例
- [ ] Pass public-beta quality gates / 通过公开Beta质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.5.0-beta.1 — Complete personal experience / 完整个人体验公开测试版

- [ ] Provide one-click normal/expert UI switching / 提供普通与专家界面一键切换
- [ ] Keep UI mode independent from active runtime profile / 界面模式与运行配置解耦
- [ ] Isolate normal-managed and expert-custom profiles / 隔离普通托管与专家自定义配置
- [ ] Add draft validation, simulation, impact preview, and explicit activation / 增加草稿验证、模拟、影响预览和明确启用
- [ ] Keep last-known-good configuration and automatic rollback / 保留健康版本并支持自动回滚
- [ ] Support host, portable, and incognito history modes / 支持宿主、可移植与无痕历史模式
- [ ] Add bounded local storage and automatic cleanup / 增加有界本地存储与自动清理
- [ ] Add personal budget and account-usage views / 增加个人预算和账号用量视图
- [ ] Support account-profile switching without cross-account charging / 支持不串账的账号切换
- [ ] Support local model setup / 支持本地模型配置
- [ ] Support extension installation and diagnostics / 支持扩展安装与诊断
- [ ] Support secure configuration import/export / 支持安全配置导入导出
- [ ] Complete Chinese and English UI / 完成中英文界面
- [ ] Pass personal-product quality gates / 通过个人产品质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.6.0-beta.1 — Team and enterprise pilot / 团队与企业试点版

- [ ] Add PostgreSQL production persistence / 增加PostgreSQL生产存储
- [ ] Add tenant, organization, team, project, and user scopes / 增加多层组织作用域
- [ ] Implement mandatory and advisory policies / 实现强制与辅助策略
- [ ] Integrate enterprise identity and role controls / 接入企业身份与角色权限
- [ ] Publish centralized internal capability catalog / 提供企业内部能力目录
- [ ] Support enterprise-purchased and user-owned resources together / 支持企业采购与用户自带资源并存
- [ ] Implement hierarchical quota pools / 实现分级额度池
- [ ] Implement end-of-cycle balance sharing / 实现周期末余额共享
- [ ] Implement atomic reservation, settlement, release, and reconciliation / 实现原子预占、结算、释放和对账
- [ ] Add private artifact storage adapter / 增加私有产物存储适配器
- [ ] Add enterprise administration views / 增加企业管理视图
- [ ] Provide Docker single-host deployment / 提供Docker单机部署
- [ ] Complete small-team noncritical pilot / 完成小团队非关键业务试点
- [ ] Pass enterprise-pilot quality gates / 通过企业试点质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.7.0-beta.1 → v0.7.0-rc.1 — Production scaling / 高并发生产候选

- [ ] Separate stateless gateway, scheduler, and workers / 分离无状态网关、调度器和Worker
- [ ] Add horizontal worker scaling / 支持Worker水平扩展
- [ ] Add queueing, backpressure, fairness, and admission control / 增加队列、背压、公平调度和准入控制
- [ ] Add Redis or compatible optional infrastructure / 增加Redis或兼容可选基础设施
- [ ] Enforce bounded per-task memory and scratch storage / 强制单任务内存与临时空间上限
- [ ] Stream large files and tool outputs / 流式处理大文件和工具输出
- [ ] Add multi-tenant resource isolation / 增加多租户资源隔离
- [ ] Add circuit breakers, provider failover, and checkpoint recovery / 增加熔断、供应商切换与恢复
- [ ] Add metrics-first observability and sampled diagnostics / 增加指标优先观测与采样诊断
- [ ] Add health checks and alerting / 增加健康检查与告警
- [ ] Verify rolling upgrades and rollback / 验证滚动升级与回滚
- [ ] Complete documented load tests / 完成有文档的压力测试
- [ ] Complete fault-injection tests / 完成故障注入测试
- [ ] Verify offline and isolated deployment / 验证离线与隔离部署
- [ ] Pass release-candidate gates / 通过RC门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.8.0-beta.1 — Open capability ecosystem / 开放能力生态预览版

- [ ] Publish capability-provider protocol / 发布能力提供者协议
- [ ] Publish TypeScript SDK / 发布TypeScript SDK
- [ ] Publish Python SDK / 发布Python SDK
- [ ] Provide model, Agent, client, storage, and history adapters / 提供多类适配器
- [ ] Implement Skill and MCP discovery / 实现Skill与MCP发现
- [ ] Enforce extension permission manifests / 强制扩展权限清单
- [ ] Add signature, integrity, dependency, and version verification / 增加签名、完整性、依赖与版本校验
- [ ] Support local, official, and enterprise-private catalogs / 支持多来源能力目录
- [ ] Isolate untrusted extension execution / 隔离未受信扩展
- [ ] Support bounded third-party Agent delegation / 支持受约束第三方Agent委派
- [ ] Publish extension testing tools and examples / 发布扩展测试工具与示例
- [ ] Publish SDK migration policy / 发布SDK迁移策略
- [ ] Pass ecosystem quality gates / 通过生态质量门禁
- [ ] Receive release confirmation / 获得发布确认

## v0.9.0-rc.N — Integrated release candidate / 完整发布候选

- [ ] Complete long-term local dogfooding / 完成本机长期真实使用
- [ ] Complete Codex, Cursor, CLI, and generic-client regression / 完成多客户端回归
- [ ] Complete team and enterprise pilot review / 完成团队与企业试点评审
- [ ] Resolve blocker and critical defects / 收敛阻断与严重缺陷
- [ ] Verify all supported upgrade paths / 验证全部支持的升级路径
- [ ] Verify data and configuration rollback / 验证数据与配置回滚
- [ ] Complete security and privacy review / 完成安全与隐私检查
- [ ] Complete public-file privacy scan / 完成公开文件隐私扫描
- [ ] Finish bilingual public documentation / 完成中英文公开文档
- [ ] Finish local-only sharing materials / 完成本机分享材料
- [ ] Publish final compatibility and limitation matrix / 发布最终兼容与限制矩阵
- [ ] Freeze large features / 冻结大型新功能
- [ ] Pass final release-candidate gates / 通过最终RC门禁
- [ ] Receive release confirmation / 获得发布确认

## v1.0.0 — Stable / 正式稳定版

- [ ] Personal one-command installation is verified / 验证个人一键安装
- [ ] Virtual-model entry is stable / 虚拟模型入口稳定
- [ ] Independent Agent kernel is stable / 独立Agent内核稳定
- [ ] Capability completion is stable and bounded / 能力补全稳定且受约束
- [ ] Secret Gate passes security suite / Secret Gate通过安全测试
- [ ] Task capsule and recovery pass reliability suite / 任务胶囊与恢复通过可靠性测试
- [ ] Quota reservation and settlement reconcile correctly / 额度预占与结算对账正确
- [ ] Configuration profiles and rollback are safe / 配置方案与回滚安全
- [ ] At least one real team pilot is accepted / 至少一个真实团队试点验收
- [ ] Performance claims have reproducible evidence / 性能结论具有可复现证据
- [ ] Compatibility matrix is published / 兼容矩阵已发布
- [ ] Chinese and English documentation is complete / 中英文文档完整
- [ ] Upgrade from latest RC succeeds / 最新RC升级成功
- [ ] Rollback path succeeds / 回滚路径成功
- [ ] No blocking known issue remains / 无阻断性已知问题
- [ ] Final acceptance report is approved / 最终验收报告获确认
- [ ] Create confirmed `v1.0.0` tag / 创建经确认的 `v1.0.0` Tag
- [ ] Move all historical facts into `docs/CHANGELOG.md` / 将实际历史沉淀到 `docs/CHANGELOG.md`
- [ ] Remove README references to this temporary plan / 移除README中的临时计划链接
- [ ] Delete this `docs/RELEASE_PLAN.md` after explicit confirmation / 明确确认后删除本文件

## Release artifacts / 发版产物

Every public release must provide the applicable artifacts below.

- [ ] npm package / npm安装包
- [ ] Git tag / Git Tag
- [ ] GitHub release notes / GitHub发布说明
- [ ] Docker images when applicable / 适用阶段的Docker镜像
- [ ] Checksums and signatures when available / 校验和与可用签名
- [ ] Chinese and English changelog / 中英文变更记录
- [ ] Upgrade and rollback guide / 升级与回滚说明
- [ ] Migration notes / 迁移说明
- [ ] Compatibility matrix / 兼容矩阵
- [ ] Known limitations / 已知限制
- [ ] Security notes / 安全说明

## Current status / 当前状态

- Planning / 规划：**complete / 已完成**
- Active stage / 当前阶段：**Stage 2 — In progress / 阶段2：进行中**
- Latest planned release / 最近计划版本：`v0.2.0-alpha.1`
- Latest published release / 最近已发布版本：`v0.1.0-alpha.2`
- Remote publishing / 远程发布：**enabled with explicit confirmation / 经明确确认后执行**

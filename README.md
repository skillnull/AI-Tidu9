<div align="center">
  <h1>九门赛博提督</h1>
  <p><strong>面向全领域场景的智能协作中枢</strong></p>
  <p>用一个目标，调度模型、Agent、Skill、MCP、工具、知识与专家，交付可验证结果。</p>
  <p>
    <a href="https://www.npmjs.com/package/@skillnull/tidu"><img alt="npm version" src="https://img.shields.io/npm/v/%40skillnull%2Ftidu?label=npm&color=0f766e"></a>
    <a href="https://github.com/skillnull/AI-Tidu9/actions/workflows/quality.yml"><img alt="quality" src="https://github.com/skillnull/AI-Tidu9/actions/workflows/quality.yml/badge.svg"></a>
    <img alt="Node.js" src="https://img.shields.io/badge/Node.js-%E2%89%A522.14-3c873a">
    <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0--only-2563eb"></a>
  </p>
  <p>
    <a href="#getting-started">安装与启动</a> ·
    <a href="./docs/EXAMPLES.md">使用实例</a> ·
    <a href="./docs/ARCHITECTURE.md">系统架构</a> ·
    <a href="./docs/CORE-DIFFERENTIATORS.md">核心机制</a> ·
    <a href="./docs/CLI-REFERENCE.md">CLI 参考</a> ·
    <a href="./docs/README.EN.md">English</a>
  </p>
</div>

---

## 🎯 产品定位

九门赛博提督是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。平台位于用户目标与 AI 能力之间，负责能力组织、执行约束、故障恢复与结果验证。

| 业务问题 | 平台能力 |
| --- | --- |
| 模型额度耗尽，换模型却丢失能力 | 动态回退，必要时仅调用专家模型补齐缺口 |
| Agent、Skill、MCP 和知识分散在不同宿主 | 一个核心、多个入口，按目标装配最小能力集 |
| 自动执行快，但费用、风险和结果不可控 | 预算、审批、策略、检查点和验收条件共同限制执行 |
| 企业想统一治理，个人又需要自主选择 | 强制策略与辅助策略分层，企业和个人资源可并存 |
| 完整会话和工具输出导致存储失控 | 完整历史留在宿主，核心只保留最大 256 KB 的恢复胶囊 |

<a id="getting-started"></a>
## 🚀 安装与首次启动

**需要 Node.js 22.14 或更高版本。** 安装前先确认版本：

```bash
node --version
```

如果版本低于 22.14，可使用已安装的 Node 版本管理器切换。以 NVM 为例：

```bash
nvm install 22
nvm use 22
```

Node 版本满足要求后，安装并启动配置中心：

```bash
npm install -g @skillnull/tidu
tidu setup
tidu start
```

打开终端输出的配置中心。页面会引导完成部署识别、入口命名、模型接入、影响模拟、启用和客户端接入。

> [!NOTE]
> npm 安装命令不会替用户安装或切换 Node.js。请先在当前终端切换到兼容版本，再安装 AI-Tidu9。

服务器无法打开页面时，使用同一套终端向导：

```bash
tidu start --cli
```

已启动后，用两个命令确认状态：

```bash
tidu doctor             # 检查运行时、配置 API 和页面
tidu setup verify       # 验证连接器，不修改配置
```

> [!TIP]
> 所有高级命令都支持 `--help`。完整参数见 [CLI 命令参考](./docs/CLI-REFERENCE.md)。

## 🔄 从目标到可验证结果

<p align="left">
  <img src="./docs/assets/goal-to-verifiable-result.svg" alt="从目标到可验证结果" width="1080">
</p>

这条链路有三个不可替换的责任：

- **模型做推理**：理解目标、生成计划、评估结果。
- **内核管边界**：执行预算、风险审批、状态转移、失败恢复。
- **证据决定是否完成**：测试通过不代表业务目标已达成，验收条件必须独立判定。

## 🧩 五个核心机制

| 机制 | 作用 | 最重要的边界 |
| --- | --- | --- |
| **多入口、单核心** | Codex、Cursor、CLI 和 OpenAI 兼容客户端共享策略与能力池 | 不读取或复制宿主私有 Token |
| **动态路由** | 按能力、成本、隐私、延迟、可用性和额度选择模型 | 估算成本不冒充供应商账单 |
| **能力补全** | 低成本主模型仅在缺失能力时调用专家模型 | 专家池、次数、费用和隐私边界均必须显式配置 |
| **Runtime Secret Gate** | 出站前识别、阻断或替换敏感信息 | 真实值只在当前任务的私有内存作用域恢复 |
| **可恢复执行** | 任务胶囊、检查点和已验证配置支持恢复与回滚 | 结果不确定时，非幂等操作不自动重放 |

实现细节与可复现案例见 [核心调度与门禁](./docs/CORE-DIFFERENTIATORS.md)。

## 🧭 选择适合你的使用路径

| 我想要…… | 从这里开始 | 数据层 |
| --- | --- | --- |
| 在本机统一个人模型、Skill 和 MCP | `tidu start` | SQLite，默认只监听回环地址 |
| 在服务器集中管理策略、额度和能力 | Docker 部署 + PostgreSQL | 企业控制平面 |
| 保留 IDE 本地能力，同时经过企业出口 | 企业网关 + 员工设备连接器 | 服务端状态 + 本地私有边界 |
| 开发模型、Agent、存储或历史 Provider | `@skillnull/tidu/ecosystem` 或 Python SDK | 通过平台 API 访问，不复制控制平面 |

<details>
<summary><strong>企业单机试点：最小 Docker 启动命令</strong></summary>

```bash
TIDU_POSTGRES_PASSWORD='<private-password>' \
docker compose -f config/docker/compose.yml up --build
```

容器默认只映射到服务器回环地址。跨设备访问必须在前方配置 HTTPS 反向代理与企业身份认证，不得直接暴露管理端口。

</details>

### 配置模型来源

默认自动使用已登录的 Codex 或 Cursor 宿主当前模型，不需要填写模型名或密钥。通过官方宿主进程调用，AI-Tidu9 不读取或复制宿主凭据。下面的命令用于主动覆盖默认模型。

OpenAI 兼容服务：

```bash
TIDU_PROVIDER=openai-compatible \
TIDU_PROVIDER_BASE_URL='https://<service>/v1' \
TIDU_PROVIDER_MODEL=gpt-4.1-mini \
TIDU_PROVIDER_API_KEY='<runtime-key>' \
tidu start
```

本机 Ollama：

```bash
TIDU_PROVIDER=ollama \
TIDU_PROVIDER_MODEL=qwen3:8b \
tidu start
```

> [!IMPORTANT]
> 覆盖服务的密钥只从当前进程环境读取，不进入 SQLite、页面返回或日志。若没有可复用的宿主模型且未设置覆盖供应商，推理会明确返回 `model_provider_not_configured`。

## 🛠️ 运行、诊断与彻底移除

```bash
tidu setup                 # 安装九门连接器，保留宿主官方模型
tidu clients               # 查看本机客户端兼容情况
tidu account               # 查看可复用的宿主登录状态
tidu doctor --json         # 生成不含私密数据的诊断摘要
tidu uninstall             # 清理全部 AI-Tidu9 自有内容
```

完整卸载会保留宿主账号、会话、无关插件、无关配置和自定义数据库路径。

通用客户端通过同一基址使用 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses`；Codex 与 Cursor 等宿主优先使用各自的原生 Agent 或 MCP 连接器，以保留宿主能力边界。
Codex Desktop 当前不能把第三方供应商增量加入官方模型列表。`tidu setup` 因此安装 MCP 连接器，保留全部官方模型，并让这些模型调用九门能力。仅在明确需要隔离的兼容入口时，才使用 `tidu clients connect codex` 创建 `ai-tidu9` Profile；该 Profile 不是对官方模型列表的追加。

企业服务器只部署运行时与 PostgreSQL，不执行员工电脑上的 `setup`，也不提供独立员工页面。员工先安装个人版九门赛博提督，再在本地页面的“企业接入”中填写管理员提供的 HTTPS 公司链接；本地验证后以只读方式显示企业虚拟模型、策略与能力，个人配置继续独立维护。

## 🛡️ 信任边界与安全承诺

- 普通草稿、专家草稿和生效快照相互隔离；保存不会自动启用。
- 写入和外部工具默认需要确认；必须策略不能被插件或专家模式绕过。
- 不可信扩展没有外部隔离执行器时默认拒绝；Node `vm` 和普通 Worker 不属于安全沙箱。
- 企业跨设备访问必须使用 HTTPS 反向代理和身份控制，不得直接暴露管理端口。

> [!WARNING]
> 项目已进入实际使用与持续维护。生产关键任务仍应先在目标环境完成容量、权限、安全、升级和回滚验证。

## 📚 文档与学习路径

| 文档 | 回答的问题 |
| --- | --- |
| [系统架构](./docs/ARCHITECTURE.md) | 一次任务如何流动，模块、数据和部署边界在哪里？ |
| [核心调度与门禁](./docs/CORE-DIFFERENTIATORS.md) | 动态路由、能力补全和 Secret Gate 如何工作？ |
| [CLI 命令参考](./docs/CLI-REFERENCE.md) | 如何安装、配置、诊断、恢复和卸载？ |
| [使用实例](./docs/EXAMPLES.md) | 如何完成本地模型、客户端、企业部署和 Provider 接入？ |
| [开放能力生态](./docs/ECOSYSTEM-SDK.md) | 如何安全地接入 Provider 和第三方 Agent？ |
| [Python SDK](./sdk/python/README.md) | 如何从 Python 调用 AI-Tidu9 Provider API？ |
| [贡献指南](./docs/CONTRIBUTING.md) | 分支、提交、版本、维护线和发布规则是什么？ |
| [商标与署名](./docs/TRADEMARKS.md) | 修改名称或商业部署时，如何正确说明来源？ |
| [变更记录](./docs/CHANGELOG.md) | 每个已发布版本实际改变了什么？ |

## 🤝 参与开发与反馈

```bash
npm run tidu:setup
npm run tidu:dev-p
# 开发企业版界面与流程
npm run tidu:dev-e
npm run check
```

`npm run tidu:setup` 只安装仓库开发依赖；产品初始化使用 `tidu setup`，两者不属于同一个生命周期。

`tidu:dev-p` 启动个人版完整本地运行时和开发页面，`tidu:dev-e` 启动企业版。开发命令会在启动服务前临时执行产品setup，退出时自动移除这套临时客户端接入。浏览器打开终端显示的地址。UI 改动会热更新，后端 TypeScript 改动会自动重新编译并重启服务。另开终端可像安装后一样执行 CLI 命令，共用开发数据：

```bash
npm run tidu:cli-p -- doctor
npm run tidu:cli-p -- config show
```

开发数据默认与安装版隔离。详细说明见[贡献指南](./docs/CONTRIBUTING.md#本地开发流程)。

问题反馈请附上经审查的 `tidu doctor --json` 输出：

- [提交 Bug 或产品反馈](https://github.com/skillnull/AI-Tidu9/issues/new/choose)
- [私密报告安全漏洞](https://github.com/skillnull/AI-Tidu9/security/advisories/new)

项目使用 [GNU AGPL-3.0-only](./LICENSE)。品牌与署名规则见 [商标政策](./docs/TRADEMARKS.md) 和 [NOTICE](./NOTICE)。

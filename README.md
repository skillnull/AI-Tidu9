# 九门赛博提督

**九门赛博提督·智能协作中枢**

九门赛博提督，是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。

[English](./docs/README.en.md)

## 当前状态

项目正在从早期AI规则包重构为独立的超级Agent平台，目前处于工程基础阶段，尚不建议用于生产环境。

## 核心方向

- 作为虚拟模型接入Codex、Cursor、CLI及其他客户端。
- 独立运行Agent任务，不受宿主呈现能力限制。
- 在质量、成本、隐私、额度和可用性之间动态调度模型。
- 通过能力补全组合低成本模型与专家模型。
- 在运行时保护密钥和敏感内容。
- 同时服务个人、团队和企业，不限制使用者继续探索AI能力。

## 本地开发

需要 Node.js 22.14 或更高版本。项目提供 `.nvmrc`，Git Hook 会在检查前自动切换到项目Node版本；首次使用若尚未安装，请运行 `nvm install`。

```bash
npm install
npm run check
npm test
node packages/tidu/dist/cli/index.js --help
```

正式npm包名为 `@skillnull/tidu`，安装后的命令保持为 `tidu`：

```bash
npx @skillnull/tidu start
```

启动后打开终端输出的本地地址，即可编辑普通或专家配置草稿。两个模式独立保存，只有点击“启用此配置”才会改变运行配置，错误或未保存的专家输入不会影响普通模式。

页面不可用时使用等价CLI诊断和配置：

```bash
npx @skillnull/tidu doctor
npx @skillnull/tidu clients
npx @skillnull/tidu config
npx @skillnull/tidu config show
```

远程管理可增加 `--endpoint https://tidu.example.com`，或设置 `TIDU_ENDPOINT`。CLI通过同一管理API操作，不直接写SQLite。

当前运行时已提供OpenAI兼容的虚拟模型发现与请求入口：

```text
GET  /v1/models
GET  /v1/models/{model}
POST /v1/chat/completions
POST /v1/responses
```

模型标识使用当前生效配置的Profile ID，并通过 `owned_by: AI-Tidu9` 保留项目署名。当前支持两类真实执行端：OpenAI兼容API和本地Ollama。未配置供应商时会返回标准 `model_provider_not_configured` 错误，不会生成模拟回答。

连接OpenAI或兼容中转服务（外部地址必须使用HTTPS）：

```bash
TIDU_PROVIDER=openai-compatible \
TIDU_PROVIDER_MODEL=gpt-4.1-mini \
TIDU_PROVIDER_API_KEY=your-runtime-key \
npx @skillnull/tidu start
```

官方OpenAI地址默认为 `https://api.openai.com/v1`。兼容服务可增加 `TIDU_PROVIDER_BASE_URL=https://provider.example.com/v1`。密钥仅从当前进程环境读取，不写入SQLite、不通过配置中心返回，也不记录到日志。

连接本机Ollama（默认地址 `http://127.0.0.1:11434`）：

```bash
TIDU_PROVIDER=ollama \
TIDU_PROVIDER_MODEL=qwen3:8b \
npx @skillnull/tidu start
```

当前适配器支持非流式JSON与流式SSE，并支持基础函数工具定义、工具选择、模型返回工具调用以及客户端回传工具结果。OpenAI兼容服务直接保持协议；Ollama会在NDJSON与Chat Completions/Responses之间转换。九门当前只负责协议和调用边界，不会代替宿主客户端执行工具；自主工具执行属于后续Agent内核。

`tidu clients` 与配置中心“客户端”页会自动发现本机Codex、Cursor和OpenAI CLI。发现过程只检查命令、应用与配置文件是否存在，不读取配置正文、账号、密钥或历史。接入分为两级：Codex app-server、Cursor ACP等官方原生Agent协议用于保留宿主的模式、工具、权限、会话与MCP能力；OpenAI兼容虚拟模型用于没有原生Agent协议的通用客户端。后者只是兼容入口，不能宣称具备宿主全部能力。Ollama属于可调度的上游模型供应商，不是宿主客户端。

一条 `tidu setup` 会安装一个九门核心并配置已发现的官方入口。Codex应用、CLI与IDE共享同一个MCP注册；Cursor桌面端与CLI共享同一个用户级MCP注册；浏览器使用配置中心；其他客户端使用OpenAI兼容地址或包内的Agent Plugin/MCP清单。所有入口指向同一运行时、配置、策略和模型池，不重复运行Agent核心。

```bash
tidu setup             # 安装已发现的连接器
tidu setup verify      # 只验证，不修改
tidu setup repair      # 重建九门自有连接器
tidu setup update      # 更新连接器启动信息
tidu setup uninstall   # 仅移除连接器，保留九门数据
```

配置结果会明确显示每个入口是原生Agent桥、MCP工具入口、浏览器管理入口还是OpenAI兼容入口；缺少宿主能力时不会静默伪装成全能力。连接器使用当前Node与已安装CLI的绝对路径，避免Shell、IDE和桌面应用之间PATH不一致。

Codex可通过确认式命令创建九门专属Profile：

```bash
tidu clients connect codex
codex --profile ai-tidu9
tidu clients rollback codex
```

该兼容流程不修改Codex默认 `config.toml`，只管理独立的 `ai-tidu9.config.toml`。写入前创建私有快照，写入后重新验证运行时与虚拟模型；验证失败立即自动回滚。日常安装优先使用 `tidu setup` 注册共享MCP。Cursor配置只增删九门拥有的 `ai-tidu9` 项，保留其他MCP；OpenAI CLI可使用其官方 `OPENAI_BASE_URL` 或 `--base-url` 连接。

安装后可直接检查Codex与Cursor宿主登录状态；存在可复用的官方会话时无需重复授权：

```bash
tidu account
tidu account relogin codex
tidu account switch codex
tidu account relogin cursor
tidu account switch cursor
```

Codex通过官方 `codex login status` 与 `codex app-server` 委托当前账户；Cursor在Agent CLI已授权时通过官方状态命令与 `agent acp` 委托该CLI账户。两套适配器已覆盖协议协商、会话、流式消息、取消和默认拒绝权限；未知交互必须由调用方显式处理。九门会移除可能覆盖宿主登录的进程级API Key环境变量，但不读取认证文件正文，不复制、落库或输出Token。`relogin` 只在用户主动执行时调用官方登录流程；`switch` 会先明确确认，再调用官方退出与登录命令。Cursor桌面端与Agent CLI的授权边界由Cursor管理，九门不会读取桌面私有凭据来伪造免登录。

## 卸载与恢复

停止正在运行的个人版后执行：

```bash
tidu uninstall
```

默认操作会把九门自有数据目录原子移动为本地快照，不会删除个人配置。重新安装后可一条命令恢复最近快照：

```bash
tidu restore
```

需要彻底删除当前数据和全部九门卸载快照时，执行 `tidu uninstall --purge` 并按提示输入完整确认词。自动化场景可使用 `--purge --confirm DELETE`。该操作不可恢复。自定义 `TIDU_DATABASE_PATH` 不会被自动移动或删除。

通过 `npx` 临时运行无需移除npm包。全局安装在数据归档后执行 `npm uninstall -g @skillnull/tidu`；项目依赖使用项目原有包管理器卸载。

分支、Commit、PR、版本和发布规则见 [贡献指南](./docs/CONTRIBUTING.md)。规则由本地脚本和GitHub Actions共同校验。

## 发版计划

开发阶段和验收状态见 [发版计划](./docs/RELEASE_PLAN.md)。该临时文件将在 `v1.0.0` 最终验收后删除，实际发布历史将保留在 [变更记录](./docs/CHANGELOG.md) 和Git Tag中。

模块边界和当前限制见 [架构基线](./docs/architecture.md)。

## 开源协议

本项目使用 [GNU Affero General Public License v3.0 only](./LICENSE)。品牌和署名规则见 [商标政策](./docs/TRADEMARKS.md) 与 [NOTICE](./NOTICE)。

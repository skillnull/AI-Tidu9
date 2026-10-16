# CLI 命令参考

[README](../README.md) · [使用实例](./EXAMPLES.md) · [English](./CLI-REFERENCE.EN.md)

## ⚡ 安装与调用方式

```bash
npm install -g @skillnull/tidu  # 持久安装，提供 tidu 命令
tidu setup                      # 自动配置并按提示重启宿主
tidu --help                   # 已安装后的总帮助
tidu <命令> --help             # 任意命令的专属帮助
```

`tidu help <命令>` 与 `tidu <命令> --help` 等价。帮助请求会在命令执行前返回，不会启动服务、修改配置或触发登录。

## 🧭 按任务快速找命令

| 我想要…… | 从这里开始 | 接下来 |
| --- | --- | --- |
| 第一次体验 | `tidu setup` | 确认是否重启宿主；重启后直接使用九门 |
| 纯终端配置 | `tidu start --cli` | 跟随五步交互向导 |
| 接入已安装客户端 | `tidu setup` | 离线安装连接器并保留宿主官方模型 |
| 切换九门、官方或第三方模型通道 | `tidu channel list` | 用 `tidu channel run` 显式执行 |
| 页面打不开或行为异常 | `tidu doctor` | 需要分享时改用 `tidu doctor --json` |
| 修改配置但暂不生效 | `tidu config set ...` | 确认后增加 `--activate` |
| 回滚或彻底移除 | `tidu restore` / `tidu uninstall` | 永久删除前必须明确确认 |

> [!TIP]
> 不需要先读完整命令表。先从目标对应的第一条命令开始，CLI 会继续给出提示；完整参数仅用于自动化和专家场景。

## 📋 命令总览

| 命令 | 用途 | 是否修改状态 |
| --- | --- | --- |
| `tidu start [--cli] [--edition personal|enterprise]` | 启动个人版或企业版运行时；可进入终端五步向导 | 启动进程；个人版对企业控制面只读 |
| `tidu setup [动作]` | 离线安装、验证、修复、更新或卸载客户端连接器 | 除 `verify` 外会修改客户端配置 |
| `tidu mcp` | 运行供Agent宿主调用的stdio MCP桥 | 否 |
| `tidu doctor` | 检查运行时、配置API和页面；可输出隐私安全报告 | 否 |
| `tidu clients` | 发现本机支持的客户端 | 否 |
| `tidu clients connect/switch/rollback codex` | 创建统一模型目录，或恢复、回滚 Codex 配置 | 是；官方账号不变，所有托管项均可恢复 |
| `tidu channel list/run` | 查看或显式调用九门、官方宿主与厂商通道 | 否；调用会消耗所选通道额度 |
| `tidu account` | 查看Codex和Cursor的可复用登录状态 | 否 |
| `tidu account relogin/switch` | 调用宿主官方登录或切换流程 | 是，需要主动执行 |
| `tidu config` | 引导式配置，或查看、修改隔离草稿 | `set`会保存草稿，`--activate`才启用 |
| `tidu uninstall` | 清理全部九门自有连接器、Profile、数据与安装内容 | 是，需要输入 `DELETE` |
| `tidu restore` | 恢复最近一次个人数据快照 | 是，需要确认 |
| `tidu enterprise recover-admin` | 在服务器生成新的管理员密钥 | 是，记录安全审计 |
| `tidu version` | 显示版本 | 否 |

## 🩺 启动与诊断

```bash
tidu start --edition personal [--cli]
tidu start --edition enterprise [--cli]
tidu doctor [--json] [--endpoint <url>]
tidu mcp [--endpoint <url>]
```

`start` 输出配置中心地址。安装/部署时用 `--edition` 选择个人版或企业版；默认版型为个人版。企业版要求通过部署环境注入 `TIDU_POSTGRES_URL`，并使用独立的数据文件。两版同时运行时还要设置不同的 `TIDU_PORT`。个人版连接企业控制面时只读企业信息，企业管理接口由服务端拒绝。增加 `--cli` 后，会依次检查运行环境、选择模式、配置统一入口、确认启用并安装已发现的连接器。`doctor` 不修改配置；`--json` 生成不含主机名、凭据、路径或会话的公开诊断摘要。`mcp` 通常由连接器自动启动，无需日常手动运行。

常用启动环境变量：

| 变量 | 作用 |
| --- | --- |
| `TIDU_HOST`、`TIDU_PORT` | 监听地址和端口；个人版默认仅回环 |
| `TIDU_DATABASE_PATH` | 自定义SQLite路径；生命周期命令不会自动删除该路径 |
| `TIDU_PROVIDER`、`TIDU_PROVIDER_MODEL` | 可选的供应商与模型覆盖；默认使用当前已登录的 Codex 或 Cursor 宿主模型 |
| `TIDU_PROVIDER_API_KEY`、`TIDU_PROVIDER_BASE_URL` | OpenAI 兼容服务覆盖的运行时密钥和服务地址 |
| `TIDU_POSTGRES_URL` | 启用企业控制平面和PostgreSQL任务状态 |
| `TIDU_EDITION` | 运行版型；可用 `personal` 或 `enterprise`，也可通过 `tidu start --edition` 指定 |
| `TIDU_ENDPOINT` | CLI默认管理地址，等价于 `--endpoint` |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | CI或无宿主环境中的OpenAI官方API通道 |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` | DeepSeek兼容通道 |
| `DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL` | 阿里云百炼/千问兼容通道 |
| `ZHIPU_API_KEY`、`ZHIPU_MODEL` | 智谱GLM兼容通道 |
| `MOONSHOT_API_KEY`、`MOONSHOT_MODEL` | Moonshot/Kimi兼容通道 |
| `ARK_API_KEY`、`ARK_MODEL` | 火山方舟/豆包兼容通道 |
| `HUNYUAN_API_KEY`、`HUNYUAN_MODEL` | 腾讯混元兼容通道 |
| `TIDU_CHANNEL_BASE_URL`、`TIDU_CHANNEL_API_KEY`、`TIDU_CHANNEL_MODEL` | 自定义OpenAI兼容通道 |

密钥只应通过当前进程环境注入，不要写入命令历史、配置文件或 `--reason`。

## 🔌 连接器与客户端

```bash
tidu setup [install|verify|repair|update|uninstall] [--endpoint <url>]
tidu clients
tidu clients connect codex [--yes] [--endpoint <url>]
tidu clients switch codex <official|ai-tidu9> [--yes] [--endpoint <url>]
tidu clients rollback codex [--yes]
```

`setup` 默认动作是 `install`，不要求预先启动运行时。它会安装连接器并准备九门配置，但保持官方直连生效。`clients switch codex ai-tidu9` 只在 Codex 中增加一个九门虚拟模型；官方或公司上游模型在九门配置页选择，公司模型不会成为独立 Codex 模型项。`clients switch codex official` 恢复仅显示官方模型。官方账号、套餐和额度仍由官方 Codex 管理。九门自有备份只保留首次安装基线与最新回滚点。

安装后的同一个 MCP 连接器会向 Codex 插件和 Cursor 提供 `list_tidu_channels` 与 `route_tidu_channel`。宿主自己的模型列表不被覆盖；选择 `codex` 或 `cursor` 时由官方宿主进程执行，选择 `tidu` 时走九门运行时，选择厂商ID时读取当前连接器进程的环境变量。

企业服务器不执行员工电脑上的 `setup`，也不提供独立员工页面。员工安装个人版后，在本地页面的“企业接入”中填写管理员提供的公司链接。正式企业入口必须使用 HTTPS；本地开发仅允许回环地址使用 HTTP。企业配置在个人版中只读，并与个人草稿和生效配置分开保存。

## 👤 宿主账号与登录状态

```bash
tidu account
tidu account status [codex|cursor]
tidu account relogin [codex|cursor]
tidu account switch [codex|cursor] [--yes]
```

不指定宿主时默认操作Codex；`account` 和 `account status` 只显示官方CLI提供的脱敏状态。AI-Tidu9 不读取或复制宿主Token。`relogin`、`switch` 才会调用宿主官方流程，`switch --yes` 仅跳过 AI-Tidu9 自己的确认提示。

## 🔀 双通道与CI

```bash
tidu channel list [--json] [--endpoint <url>]
tidu channel run tidu --input-file prompt.txt --json
tidu channel run codex --input-file prompt.txt [--model <id>] --json
tidu channel run cursor --input-file prompt.txt --json
tidu channel run qwen --input-file prompt.txt [--model <id>] --json
```

`tidu`、`codex`、`cursor` 分别代表九门虚拟通道、Codex官方宿主和Cursor官方ACP。厂商通道包括 `openai`、`deepseek`、`qwen`、`glm`、`kimi`、`doubao`、`hunyuan`，另有 `custom`。通道必须显式选择，失败时不会静默切换供应商。

CI建议使用厂商API通道，并把密钥保存在CI Secret中。以下示例不把密钥写入参数或仓库：

```yaml
- name: Run AI-Tidu9 channel
  run: npx @skillnull/tidu channel run qwen --input-file .ci/prompt.txt --json > channel-result.json
  env:
    DASHSCOPE_API_KEY: ${{ secrets.DASHSCOPE_API_KEY }}
    DASHSCOPE_MODEL: qwen-plus
```

Codex和Cursor宿主通道适合已有官方登录的开发机。无交互CI不复用桌面端凭据，应使用独立API通道。Cursor执行 `tidu setup` 并重启后，可直接通过MCP工具发现和调用这些通道。

## ⚙️ 配置管理

```bash
tidu config [--endpoint <url>]
tidu config show [--endpoint <url>]
tidu config set --mode <managed|expert> \
  [--profile <id>] [--name <显示名>] [--activate] [--endpoint <url>]
```

- `config`：进入低门槛引导流程。
- `config show`：查看生效快照和两个隔离草稿。
- `config set`：至少提供 `--profile` 或 `--name`；必须指定 `--mode`。
- `--activate`：保存后立即启用。省略时只保存草稿，不改变运行行为。

## ♻️ 卸载、恢复与回滚

```bash
tidu uninstall [--confirm DELETE] [--endpoint <url>]
tidu restore [--yes]
```

`uninstall` 会清理 AI-Tidu9 连接器、专属Codex Profile及备份、默认数据、快照和检测到的全局npm安装。`restore` 仅用于恢复旧版本留下的可恢复快照。

永久操作必须输入 `DELETE`，自动化环境可显式传入 `--confirm DELETE`。宿主账号、会话、无关插件、无关配置和自定义数据库路径不会被删除。

## 🏢 企业服务器操作

```bash
TIDU_POSTGRES_URL='<private-url>' \
tidu enterprise recover-admin --reason '<non-secret audit reason>'
```

该命令只能在可信服务器主机执行。它生成一次性展示的新管理员密钥并写入安全审计。`--reason` 必填，且不能包含密码、Token或其他秘密。

## ℹ️ 版本、帮助与退出码

```bash
tidu version
tidu --version
tidu -v
tidu help
tidu help config
tidu config set --help
```

成功返回退出码 `0`；参数错误、诊断失败、连接器不健康或安全边界拒绝返回非零退出码。自动化脚本应判断退出码，不要只匹配输出文字。

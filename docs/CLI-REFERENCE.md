# CLI 命令参考

[README](../README.md) · [使用实例](./EXAMPLES.md) · [English](./CLI-REFERENCE.EN.md)

## ⚡ 三种调用方式

```bash
npx @skillnull/tidu start     # 临时运行，无需全局安装
tidu --help                   # 已安装后的总帮助
tidu <命令> --help             # 任意命令的专属帮助
```

`tidu help <命令>` 与 `tidu <命令> --help` 等价。帮助请求会在命令执行前返回，不会启动服务、修改配置或触发登录。

## 🧭 按任务快速找命令

| 我想要…… | 从这里开始 | 接下来 |
| --- | --- | --- |
| 第一次体验 | `npx @skillnull/tidu start` | 按页面向导完成配置 |
| 纯终端配置 | `tidu start --cli` | 跟随五步交互向导 |
| 接入已安装客户端 | `tidu setup install` | 使用 `tidu setup verify` 验证 |
| 页面打不开或行为异常 | `tidu doctor` | 需要分享时改用 `tidu doctor --json` |
| 修改配置但暂不生效 | `tidu config set ...` | 确认后增加 `--activate` |
| 回滚或彻底移除 | `tidu restore` / `tidu uninstall --complete` | 永久删除前必须明确确认 |

> [!TIP]
> 不需要先读完整命令表。先从目标对应的第一条命令开始，CLI 会继续给出提示；完整参数仅用于自动化和专家场景。

## 📋 命令总览

| 命令 | 用途 | 是否修改状态 |
| --- | --- | --- |
| `tidu start [--cli]` | 启动运行时；可进入终端五步向导 | 启动进程；向导可保存并启用配置 |
| `tidu setup [动作]` | 安装、验证、修复、更新或卸载宿主连接器 | 除 `verify` 外会修改连接器 |
| `tidu mcp` | 运行供Agent宿主调用的stdio MCP桥 | 否 |
| `tidu doctor` | 检查运行时、配置API和页面；可输出隐私安全报告 | 否 |
| `tidu clients` | 发现本机支持的客户端 | 否 |
| `tidu clients connect/rollback codex` | 创建或回滚 AI-Tidu9 专属Codex Profile | 是，且只修改 AI-Tidu9 自有文件 |
| `tidu account` | 查看Codex和Cursor的可复用登录状态 | 否 |
| `tidu account relogin/switch` | 调用宿主官方登录或切换流程 | 是，需要主动执行 |
| `tidu config` | 引导式配置，或查看、修改隔离草稿 | `set`会保存草稿，`--activate`才启用 |
| `tidu uninstall` | 可恢复卸载、数据清除或完整卸载 | 是，需要确认 |
| `tidu restore` | 恢复最近一次个人数据快照 | 是，需要确认 |
| `tidu enterprise recover-admin` | 在服务器生成新的管理员密钥 | 是，记录安全审计 |
| `tidu version` | 显示版本 | 否 |

## 🩺 启动与诊断

```bash
tidu start [--cli]
tidu doctor [--json] [--endpoint <url>]
tidu mcp [--endpoint <url>]
```

`start` 输出配置中心地址。增加 `--cli` 后，会依次检查运行环境、选择模式、配置统一入口、确认启用并安装已发现的连接器。`doctor` 不修改配置；`--json` 生成不含主机名、凭据、路径或会话的公开诊断摘要。`mcp` 通常由连接器自动启动，无需日常手动运行。

常用启动环境变量：

| 变量 | 作用 |
| --- | --- |
| `TIDU_HOST`、`TIDU_PORT` | 监听地址和端口；个人版默认仅回环 |
| `TIDU_DATABASE_PATH` | 自定义SQLite路径；生命周期命令不会自动删除该路径 |
| `TIDU_PROVIDER`、`TIDU_PROVIDER_MODEL` | 供应商类型和模型 |
| `TIDU_PROVIDER_API_KEY`、`TIDU_PROVIDER_BASE_URL` | 运行时密钥和兼容API地址 |
| `TIDU_POSTGRES_URL` | 启用企业控制平面和PostgreSQL任务状态 |
| `TIDU_ENDPOINT` | CLI默认管理地址，等价于 `--endpoint` |

密钥只应通过当前进程环境注入，不要写入命令历史、配置文件或 `--reason`。

## 🔌 连接器与客户端

```bash
tidu setup [install|verify|repair|update|uninstall] [--endpoint <url>]
tidu clients
tidu clients connect codex [--yes] [--endpoint <url>]
tidu clients rollback codex [--yes]
```

`setup` 默认动作是 `install`。它只管理 AI-Tidu9 拥有的注册项；`uninstall` 保留 AI-Tidu9 数据。`clients` 只检查命令、应用和配置文件是否存在，不读取账号、密钥或会话正文。Codex专属Profile操作会先创建私有快照，验证失败自动回滚。

## 👤 宿主账号与登录状态

```bash
tidu account
tidu account status [codex|cursor]
tidu account relogin [codex|cursor]
tidu account switch [codex|cursor] [--yes]
```

不指定宿主时默认操作Codex；`account` 和 `account status` 只显示官方CLI提供的脱敏状态。AI-Tidu9 不读取或复制宿主Token。`relogin`、`switch` 才会调用宿主官方流程，`switch --yes` 仅跳过 AI-Tidu9 自己的确认提示。

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
tidu uninstall [--yes]
tidu uninstall --purge [--confirm DELETE]
tidu uninstall --complete [--confirm DELETE] [--endpoint <url>]
tidu restore [--yes]
```

| 模式 | 结果 |
| --- | --- |
| 默认卸载 | 把个人数据移动到可恢复快照；保留连接器和包 |
| `--purge` | 永久删除 AI-Tidu9 默认数据目录及其快照 |
| `--complete` | 额外清理 AI-Tidu9 连接器、专属Codex Profile及备份、默认数据、快照和检测到的全局npm安装 |
| `restore` | 在当前数据目录不存在时恢复最近快照，不覆盖新数据 |

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

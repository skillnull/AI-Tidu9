# 本地开发

[README](../README.md) · [English](./LOCAL-DEVELOPMENT.EN.md) · [贡献指南](./CONTRIBUTING.md)

本文档只描述仓库本地开发，不包含服务器或远程部署步骤。远程使用由[远程部署文档](./REMOTE-DEPLOYMENT.md)独立维护。

## 启动开发环境

需要 Node.js 22.14 或更高版本：

```bash
npm run tidu:setup
```

`tidu:setup` 安装依赖、构建 CLI，并自动启动个人版前端、CLI 与接口服务。后续可用 `tidu:dev-p` 再次启动个人版服务组，或用 `tidu:dev-e` 启动企业版服务组。浏览器统一访问 `9639`；前端和接口使用隔离的内部端口，因此停止单个服务不会关闭服务控制入口。

开发数据保存在 `.tidu-dev/tidu.sqlite`，与全局安装版数据隔离。前端源码由 Vite 热更新，后端 TypeScript 修改会自动重启本地运行时。

## 本地 Codex 配置验收

配置页为唯一的九门上游模型选择入口，可从官方模型、公司 Provider 模型中选择，也可填写自定义模型 ID：

- **九门**：Codex 只增加一个九门虚拟模型；配置页选择它实际调用的官方或公司模型。
- **官方直连**：删除当前生效的九门托管块，Codex 模型列表只显示官方模型。

九门自有备份目录只保留首次安装基线与最新回滚点；不会删除来源不明的 Codex 配置备份。

服务页分别显示 `tidu:dev-frontend-p`、`tidu:dev-cli-p` 与 `tidu:dev-api-p`。三类服务都有独立 PID、状态、命令和启动、停止、重启操作。企业版本地开发使用对应的 `-e` 命令。安装或远程运行时采用相同的服务信息与操作契约，只列出当前版型；个人安装版不暴露企业命令，企业安装版不暴露个人命令。CLI 可执行 `tidu service status` 或 `tidu service <start|stop|restart> <service-id|all>`。

`tidu:dev-p` 启动前会检查安装版运行锁和默认端口。检测到安装版冲突时停止启动，并提示先执行 `tidu service stop all && tidu uninstall --confirm DELETE`，不会自动删除数据。

切到九门前，本地运行时必须可访问并通过最小推理验证；验证失败时保持或恢复官方配置，并显示具体错误。正常停止本地开发服务时，如果九门配置正在生效，也要恢复官方配置。

## 验证与停止

```bash
npm run check
```

开发或测试结束后，在运行 `tidu:dev-p` 的终端按 `Ctrl+C`。确认本地开发进程与其端口已经退出，不把测试服务留在后台。

本地功能变更若同时影响服务器部署，只同步更新独立的远程部署文档；不要把远程操作写入本地开发流程。

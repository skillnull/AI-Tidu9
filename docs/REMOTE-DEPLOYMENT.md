# 远程部署

[README](../README.md) · [English](./REMOTE-DEPLOYMENT.EN.md)

本文档只描述服务器、企业控制平面和跨设备访问。仓库本地开发请使用[贡献指南的本地开发流程](./CONTRIBUTING.md#本地开发流程)，两套流程互不混用。

## 企业单机试点

通过部署系统注入 PostgreSQL 密码后启动服务器运行时：

```bash
: "${TIDU_POSTGRES_PASSWORD:?inject with your deployment secret system}"
docker compose -f config/docker/compose.yml up --build
```

服务器运行时和 PostgreSQL 必须先在服务器本机通过健康检查：

```bash
curl -fsS http://127.0.0.1:9639/health
docker compose -f config/docker/compose.yml ps
```

服务器运行日志写入持久卷内的 `/var/lib/ai-tidu9/logs/runtime.log`。服务页显示日志、运行配置和反向代理配置的位置；当前部署未提供 Nginx 时显示“未配置”。外接 Nginx 时，通过 `TIDU_NGINX_CONFIG_PATH` 提供运行时可见的配置路径。

## 跨设备访问边界

- 容器管理端口只映射到服务器回环地址。
- 跨设备访问必须经过 HTTPS 反向代理、身份认证和组织访问控制。
- 企业服务器不执行员工电脑上的 `tidu setup`，也不接管员工的个人 Codex 配置。
- 员工设备通过本地九门客户端连接管理员提供的 HTTPS 地址；企业配置与本地个人配置保持隔离。

## 上线前验证

- 验证容量、备份恢复、管理员密钥轮换、升级与回滚。
- 验证组织范围、审计日志、数据库持久化和最小权限。
- 禁止把服务器管理端口直接暴露到公网。

本地开发产生的协议、配置或数据库变更如果影响服务器部署，只在本文档和对应英文文档中同步远程步骤，不写入本地开发流程。
